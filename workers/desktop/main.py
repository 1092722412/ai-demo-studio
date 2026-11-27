"""产品固定录制入口；只接受 Node 通过 stdin 发送的单任务指令。"""
import json
import os
import queue
import sys
import tempfile
import threading
import traceback
from pathlib import Path
from urllib.parse import urlsplit

from capture import Capture, CaptureError, ffmpeg_command, monotonic_ms
from native import DesktopBusy, DesktopUnavailable, WindowsDesktop
from observer import EdgeObserver, StepError, step_end_ms


class StopRequested(RuntimeError):
    pass


class InvalidPreparation(RuntimeError):
    pass


class Control:
    def __init__(self):
        self.commands = queue.Queue()
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.task_id = None
        self.sequence = 0
        self.reason = None
        self.last_inbound = monotonic_ms()
        self.closed = threading.Event()
        self.hotkey = None
        self.protocol_output = sys.stdout
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._watch, daemon=True).start()

    def _emit(self, event_type, payload):
        self.sequence += 1
        print(json.dumps({"taskId": self.task_id, "seq": self.sequence, "type": event_type, "payload": payload},
                         ensure_ascii=False, allow_nan=False), file=self.protocol_output, flush=True)

    def emit(self, event_type, **payload):
        with self.lock:
            self._emit(event_type, payload)

    def _stop(self, reason):
        if not self.stopped.is_set():
            self.reason = reason
            self.stopped.set()

    def _command(self, raw):
        command = json.loads(raw)
        task, op, command_id, payload = (command[key] for key in ("taskId", "op", "commandId", "payload"))
        if not isinstance(task, str) or not isinstance(command_id, str) or not isinstance(payload, dict):
            raise ValueError("无效命令包络")
        if not self.task_id:
            if op != "prepare":
                raise ValueError("缺少 prepare")
            self.task_id = task
        if task != self.task_id or op not in ("prepare", "start", "ping", "cancel"):
            raise ValueError("无效任务或操作")
        self.last_inbound = monotonic_ms()
        if op == "ping":
            return
        with self.lock:
            if op == "cancel":
                self._stop("cancel")
            self._emit("accepted", {"commandId": command_id})
        if op != "cancel":
            self.commands.put(command)

    def _read(self):
        pending = bytearray()
        try:
            while not self.closed.is_set():
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    self._stop("lost")
                    return
                pending.extend(chunk)
                while (end := pending.find(b"\n")) >= 0:
                    self._command(bytes(pending[:end]))
                    del pending[:end + 1]
                if len(pending) > 5 * 1024 * 1024:
                    raise ValueError("命令超出长度限制")
        except (OSError, KeyError, TypeError, ValueError):
            self._stop("lost")

    def _watch(self):
        last_beat = monotonic_ms()
        while not self.closed.wait(0.05):
            current = monotonic_ms()
            if current - self.last_inbound > 6000:
                self._stop("lost")
            elif self.hotkey and self.hotkey():
                self._stop("desktop_hotkey")
            if self.task_id and current - last_beat >= 2000:
                last_beat = current
                try:
                    self.emit("heartbeat")
                except OSError:
                    self._stop("lost")
                    return

    def guard(self):
        if self.stopped.is_set():
            raise StopRequested()

    def pause(self, duration_ms, guard=None):
        until = monotonic_ms() + duration_ms
        while True:
            (guard or self.guard)()
            remaining = until - monotonic_ms()
            if remaining <= 0:
                return
            self.stopped.wait(min(remaining, 50) / 1000)

    def next(self, op):
        while True:
            self.guard()
            try:
                command = self.commands.get(timeout=0.05)
            except queue.Empty:
                continue
            if command["op"] != op:
                raise ValueError("命令顺序无效")
            return command


def prepare_data(preparation, target, control):
    try:
        strategy = preparation["strategy"]
        source = target.get("data")
        if strategy == "keep" and not source:
            return
        if not source:
            raise ValueError("项目适配器未提供数据位置")
        path = Path(source["statePath"])
        if not path.is_absolute() or not path.is_file():
            raise ValueError("项目数据位置无效")
        if strategy == "keep":
            state = json.loads(path.read_text(encoding="utf-8"))
        elif strategy == "seed":
            state = json.loads(Path(source["seedPath"]).read_text(encoding="utf-8"))
        elif strategy == "custom":
            state = preparation["state"]
        else:
            raise ValueError("未知数据准备策略")
        if not isinstance(state, (dict, list)):
            raise ValueError("演示状态必须是对象或数组")
        if strategy != "keep":
            encoded = json.dumps(state, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
            if len(encoded) > 128_000:
                raise ValueError("状态超过固定模板支持的大小")
            with tempfile.NamedTemporaryFile(dir=path.parent, mode="wb", prefix="recording-", delete=False) as temp:
                temp.write(encoded)
            try:
                control.guard()
                os.replace(temp.name, path)
            finally:
                Path(temp.name).unlink(missing_ok=True)
    except (OSError, TypeError, ValueError, KeyError) as error:
        raise InvalidPreparation() from error


def run_steps(control, observer, plan, audio, current_step, playwright_error):
    duration = {clip["narrationId"]: clip["durationMs"] for clip in audio}
    for step in plan["steps"]:
        current_step[:] = [step["id"]]
        observer.guard()
        start_rects = observer.rects(step["id"], "start")
        started = monotonic_ms()
        control.emit("step.started", stepId=step["id"], monotonicMs=started, rects=start_rects)
        for action in step["actions"]:
            observer.action(action, step["timeoutMs"])
        timeout = monotonic_ms() + step["timeoutMs"]
        checks = None
        while True:
            observer.guard()
            try:
                checks = [observer.check(check) for check in step["checks"]]
                if all(check["passed"] for check in checks):
                    break
            except (StepError, playwright_error):
                # 刷新期间 iframe 可能短暂不存在，保留最近一次实测直到超时。
                pass
            if monotonic_ms() >= timeout:
                raise StepError(checks)
            control.pause(min(80, max(0, timeout - monotonic_ms())), observer.guard)
        rects = observer.rects(step["id"], "verified")
        verified = monotonic_ms()
        control.emit("step.verified", stepId=step["id"], monotonicMs=verified, checks=checks, rects=rects)
        spans = {"start": [], "verified": []}
        for line in plan["narration"]:
            if line["stepId"] == step["id"]:
                spans[line["anchor"]].append(duration[line["id"]])
        end = step_end_ms(started, verified, step["holdMs"], spans["start"], spans["verified"])
        control.pause(end - monotonic_ms(), observer.guard)
        control.emit("step.finished", stepId=step["id"], monotonicMs=monotonic_ms())


def record(control, prepare, current_step):
    data = prepare["payload"]
    target = data["target"]
    url = urlsplit(target["url"])
    if url.scheme != "http" or url.hostname != "127.0.0.1" or not url.port or url.path != "/" or url.query or url.fragment or url.username:
        raise InvalidPreparation()
    plan = data["plan"]
    if data["effectiveProfile"] != plan["profile"] or data["manifest"]["projectId"] != plan["projectId"]:
        raise InvalidPreparation()
    capture_path = Path(data["capturePath"])
    if not capture_path.is_absolute() or os.path.lexists(capture_path) or not capture_path.name.endswith(".mp4.partial"):
        raise InvalidPreparation()
    if sys.platform != "win32":
        raise ImportError("录制 Worker 需要 Windows")
    executable = ffmpeg_command()
    with WindowsDesktop() as native:
        native.screen()
        control.hotkey = native.stop_pressed
        import pyautogui
        import uiautomation
        from playwright.sync_api import Error as PlaywrightError, sync_playwright

        pyautogui.PAUSE = 0
        pyautogui.FAILSAFE = True
        control.guard()
        prepare_data(data["preparation"], target, control)
        with tempfile.TemporaryDirectory(prefix="studio-edge-", ignore_cleanup_errors=True) as profile, sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch_persistent_context(profile, channel="msedge", headless=False,
                    no_viewport=True, locale="en-US", timeout=15000, args=["--start-maximized",
                    "--auto-open-devtools-for-tabs", "--force-renderer-accessibility", "--lang=en-US"])
            except PlaywrightError as error:
                raise ImportError("无法启动已安装的 Edge") from error
            try:
                page = browser.pages[0] if browser.pages else browser.new_page()
                observer = EdgeObserver(page, native, pyautogui, uiautomation, control, target, plan)
                observer.prepare(plan["source"]["entryFragment"])
                first = plan["steps"][0]["actions"][0]
                if first["op"] != "observe":
                    current_step[:] = [plan["steps"][0]["id"]]
                    observer.preflight(first["target"])
                    current_step.clear()
                control.guard()
                control.emit("ready", commandId=prepare["commandId"],
                             checks=["dependencies", "singlePrimary", "data", "edge", "network", "calibration"])
                start = control.next("start")
                if start["payload"].get("prepareCommandId") != prepare["commandId"]:
                    raise ValueError("准备指令已失效")
                observer.guard()
                try:
                    capture = Capture(executable, str(capture_path), observer.screen, plan["profile"]["output"]["fps"])
                except OSError as error:
                    raise CaptureError("无法启动 FFmpeg") from error
                observer.capture = capture
                try:
                    first_frame = capture.first_frame(observer.guard, control.pause)
                    control.emit("capture.started", monotonicMs=first_frame,
                                 widthPx=observer.screen[0], heightPx=observer.screen[1])
                    run_steps(control, observer, plan, data["audio"], current_step, PlaywrightError)
                    control.pause(150, observer.guard)
                except BaseException:
                    capture.close()
                    raise
                return capture.close(require_complete=True)
            finally:
                browser.close()


def main():
    control = Control()
    sys.stdout = sys.stderr
    current_step = []

    def fail(code, **details):
        if control.task_id:
            control.emit("failed", code=code, **({"stepId": current_step[0]} if current_step else {}), **details)

    try:
        samples = record(control, control.next("prepare"), current_step)
        control.guard()
        control.emit("capture.finished", syncSamples=samples)
    except StopRequested:
        if control.reason == "lost":
            fail("WORKER_TIMEOUT")
        elif control.task_id:
            control.emit("cancelled", reason=control.reason)
    except DesktopBusy:
        fail("RESOURCE_BUSY")
    except (ImportError, FileNotFoundError):
        fail("WORKER_UNAVAILABLE")
    except DesktopUnavailable:
        fail("DESKTOP_UNAVAILABLE")
    except InvalidPreparation:
        fail("DATA_PREPARATION_FAILED")
    except CaptureError:
        fail("CAPTURE_FAILED")
    except StepError as error:
        fail("STEP_FAILED", **({"checks": error.checks} if error.checks is not None else {}))
    except Exception:
        traceback.print_exc(file=sys.stderr)
        fail("STEP_FAILED" if current_step else "DESKTOP_UNAVAILABLE")
    finally:
        control.closed.set()


if __name__ == "__main__":
    main()
