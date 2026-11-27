"""使用 FFmpeg 采集单主屏，并按采集帧的 PTS 对齐单调时钟。"""
import os
import re
import shutil
import subprocess
import threading
import time


class CaptureError(RuntimeError):
    pass


def monotonic_ms():
    return time.monotonic_ns() / 1_000_000


def clock_pair():
    before = monotonic_ms()
    wall = time.time_ns() / 1_000_000
    return wall, (before + monotonic_ms()) / 2


def sync_samples(first_pts, last_pts, start_clock, end_clock):
    start_wall, start_mono = start_clock
    end_wall, end_mono = end_clock
    first, last = first_pts / 1000, last_pts / 1000
    if (abs((end_wall - start_wall) - (end_mono - start_mono)) > 50
            or not start_wall - 20 <= first < last <= end_wall + 20):
        raise ValueError("原片 PTS 与本机时钟未能可靠配对")
    return [
        {"monotonicMs": start_mono + (first - start_wall), "videoMs": 0},
        {"monotonicMs": end_mono + (last - end_wall), "videoMs": last - first},
    ]


def ffmpeg_command():
    command = shutil.which(os.environ.get("DEMO_STUDIO_FFMPEG") or "ffmpeg")
    if not command:
        raise FileNotFoundError("ffmpeg")
    return command


class Capture:
    def __init__(self, executable, path, screen, fps):
        self.path = path
        self.frames = 0
        self.encoded = 0
        self.first_pts = None
        self.last_pts = None
        self.start_clock = clock_pair()
        width, height = screen
        pixel_format = "yuv444p" if width % 2 or height % 2 else "yuv420p"
        self.process = subprocess.Popen([
            executable, "-n", "-hide_banner", "-loglevel", "info", "-nostats", "-xerror",
            "-stats_period", "0.1", "-progress", "pipe:1",
            "-copyts", "-f", "gdigrab", "-draw_mouse", "1", "-framerate", str(fps),
            "-video_size", f"{width}x{height}", "-i", "desktop",
            "-vf", "settb=AVTB,showinfo,setpts=PTS-STARTPTS",
            "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-video_track_timescale", "1000000",
            "-an", "-c:v", "libx264", "-preset", "ultrafast",
            "-tune", "zerolatency", "-pix_fmt", pixel_format, "-g", str(fps),
            "-movflags", "+frag_keyframe+empty_moov", "-f", "mp4", path,
        ], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=subprocess.CREATE_NO_WINDOW)
        self.readers = [
            threading.Thread(target=self._progress, daemon=True),
            threading.Thread(target=self._timestamps, daemon=True),
        ]
        for reader in self.readers:
            reader.start()

    def _progress(self):
        for line in self.process.stdout:
            if line.startswith(b"frame="):
                try:
                    self.encoded = int(line.split(b"=", 1)[1])
                except ValueError:
                    continue

    def _timestamps(self):
        for line in self.process.stderr:
            match = re.search(rb"Parsed_showinfo_.*?\bn:\s*\d+\s+pts:\s*(\d+)", line)
            if not match:
                continue
            pts = int(match[1])
            if self.first_pts is None:
                self.first_pts = pts
            self.last_pts = pts
            self.frames += 1

    def guard(self):
        if self.process.poll() is not None:
            raise CaptureError("FFmpeg 提前退出")

    def first_frame(self, guard, pause):
        deadline = monotonic_ms() + 6000
        while self.first_pts is None or not self.encoded:
            guard()
            if monotonic_ms() >= deadline:
                raise CaptureError("等待实际编码的首帧超时")
            pause(30)
        self.guard()
        wall, mono = self.start_clock
        first = self.first_pts / 1000
        if not wall - 20 <= first <= time.time_ns() / 1_000_000 + 20:
            raise CaptureError("首帧时间戳无法与本机时钟配对")
        return mono + (first - wall)

    def close(self, require_complete=False):
        try:
            if self.process.poll() is None:
                try:
                    self.process.stdin.write(b"q\n")
                    self.process.stdin.flush()
                except OSError:
                    pass
            try:
                status = self.process.wait(timeout=6)
            except subprocess.TimeoutExpired:
                self.process.kill()
                status = self.process.wait(timeout=2)
            for reader in self.readers:
                reader.join(timeout=1)
            if not require_complete:
                return None
            if status != 0 or self.frames < 2 or self.encoded != self.frames or self.last_pts is None:
                raise CaptureError("末帧未成功写入原片")
            try:
                return sync_samples(self.first_pts, self.last_pts, self.start_clock, clock_pair())
            except ValueError as error:
                raise CaptureError(str(error)) from error
        finally:
            for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
                pipe.close()
