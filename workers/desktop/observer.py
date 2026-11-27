"""观察 Edge 页面，校准窗口，并通过 PyAutoGUI 执行声明式输入。"""
from collections import deque
from math import isfinite
import re
from urllib.parse import urljoin, urlsplit

from capture import monotonic_ms
from native import DesktopUnavailable


def map_rect(rect, viewport, css_viewport, screen):
    left, top, width, height = viewport
    css_width, css_height = css_viewport
    x, y, w, h = (rect[key] for key in ("x", "y", "width", "height"))
    if (not all(isfinite(value) for value in (left, top, width, height, css_width, css_height, x, y, w, h))
            or min(width, height, css_width, css_height, w, h) <= 0
            or min(left, top, x, y) < 0 or x + w > css_width or y + h > css_height
            or left + width > screen[0] or top + height > screen[1]):
        raise ValueError("目标或浏览器视口超出主屏")
    sx, sy = width / css_width, height / css_height
    if abs(sx / sy - 1) > 0.02:
        raise ValueError("浏览器视口无法校准到物理坐标")
    return {"x": left + x * sx, "y": top + y * sy, "width": w * sx, "height": h * sy}


def step_end_ms(start, verified, hold, start_audio, verified_audio):
    return max(start + sum(start_audio), verified + sum(verified_audio), verified + hold) + 500


class StepError(RuntimeError):
    def __init__(self, checks=None):
        super().__init__("步骤定位、输入或检查失败")
        self.checks = checks


def _css_literal(value):
    return '"' + "".join(f"\\{ord(char):x} " for char in value) + '"'


def _rectangle(control):
    rect = control.BoundingRectangle
    return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top


def _center(rect):
    return round(rect["x"] + rect["width"] / 2), round(rect["y"] + rect["height"] / 2)


def _controls(root):
    pending = deque([(root, 0)])
    for _ in range(600):
        if not pending:
            break
        control, depth = pending.popleft()
        yield control
        if depth < 15 and control.ControlTypeName != "DocumentControl":
            pending.extend((child, depth + 1) for child in control.GetChildren())


_ELEMENT_STATE = """(el) => {
  const r = el.getBoundingClientRect();
  const root = el.getRootNode();
  const hit = root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return {
    hit: hit === el || (hit && el.contains(hit)),
    focused: el.ownerDocument.hasFocus() && root.activeElement === el,
    editable: (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !el.readOnly && !el.disabled,
    disabled: el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true',
    checked: typeof el.checked === 'boolean' ? el.checked :
      el.getAttribute('aria-checked') === 'true' ? true :
      el.getAttribute('aria-checked') === 'false' ? false : null,
    value: typeof el.value === 'string' ? el.value : null,
    text: el.innerText ?? el.textContent ?? '',
  };
}"""


class EdgeObserver:
    def __init__(self, page, native, automation, uia, control, target, plan):
        self.page = page
        self.native = native
        self.input = automation
        self.uia = uia
        self.control = control
        self.target = target
        self.profile = plan["profile"]
        self.elements = {element["id"]: element for element in plan["elements"]}
        self.layers = plan["layers"]
        self.hwnd = None
        self.screen = native.screen()
        self.capture = None

    def prepare(self, fragment):
        self.control.guard()
        self.page.goto(self.target["url"] + fragment, wait_until="load", timeout=8000)
        self.control.guard()
        self.page.bring_to_front()
        deadline = monotonic_ms() + 3000
        while not self.hwnd and monotonic_ms() < deadline:
            self.hwnd = self.native.foreground_edge()
            if not self.hwnd:
                self.control.pause(50)
        if not self.hwnd:
            raise DesktopUnavailable("Edge 录制窗口无法取得焦点")
        network = self._network(1500)
        if network is None:
            self.guard()
            self.input.press("f12")
            network = self._network(5000)
        if network is None:
            raise DesktopUnavailable("未找到唯一可用的 Network 标签")
        if not network.GetSelectionItemPattern().IsSelected:
            left, top, width, height = _rectangle(network)
            x, y = round(left + width / 2), round(top + height / 2)
            self.guard()
            if not self.native.unobstructed(self.hwnd, x, y):
                raise DesktopUnavailable("Network 标签被遮挡")
            self.input.click(x, y)
        deadline = monotonic_ms() + 3000
        while monotonic_ms() < deadline:
            self.guard()
            network = self._network(500)
            if network and network.GetSelectionItemPattern().IsSelected:
                self.page.bring_to_front()
                try:
                    self._frame()
                except StepError as error:
                    raise DesktopUnavailable("业务 iframe 未通过录前检查") from error
                self._viewport()
                return
            self.control.pause(50)
        raise DesktopUnavailable("无法确认 DevTools 的 Network 已选中")

    def _network(self, timeout):
        deadline = monotonic_ms() + timeout
        while monotonic_ms() < deadline:
            self.guard()
            root = self.uia.ControlFromHandle(self.hwnd)
            candidates = [item for item in _controls(root) if item.ControlTypeName == "TabItemControl"
                          and item.Name == "Network" and not item.IsOffscreen]
            if len(candidates) == 1:
                return candidates[0]
            self.control.pause(100)
        return None

    def guard(self):
        self.control.guard()
        if self.native.get_foreground() != self.hwnd or self.native.screen() != self.screen:
            raise DesktopUnavailable("录制窗口失焦或显示范围发生变化")
        if self.capture is not None:
            self.capture.guard()

    def _frame(self):
        self.guard()
        if urlsplit(self.page.url)._replace(fragment="") != urlsplit(self.target["url"]):
            raise DesktopUnavailable("目标页面已离开项目入口")
        frame_path = self.target["framePath"]
        if frame_path is None:
            return self.page.main_frame
        expected = urlsplit(urljoin(self.target["url"], frame_path))
        frames = [frame for frame in self.page.frames if frame.parent_frame == self.page.main_frame
                  and urlsplit(frame.url)._replace(fragment="") == expected]
        if len(frames) != 1:
            raise StepError()
        return frames[0]

    def _viewport(self):
        self.guard()
        size = tuple(self.page.evaluate("() => [innerWidth, innerHeight]"))
        title = self.page.title()
        root = self.uia.ControlFromHandle(self.hwnd)
        candidates = []
        for item in _controls(root):
            if item.ControlTypeName != "DocumentControl" or item.Name != title or item.IsOffscreen:
                continue
            viewport = _rectangle(item)
            try:
                map_rect({"x": 0, "y": 0, "width": size[0], "height": size[1]}, viewport, size, self.screen)
            except ValueError:
                continue
            candidates.append(viewport)
        if len(candidates) != 1:
            raise DesktopUnavailable("无法用 Edge 文档视口校准物理坐标")
        return candidates[0], size

    def _locator(self, frame, target):
        element = self.elements[target]
        kind, value = element["by"], element["value"]
        if kind == "id":
            return frame.locator("[id=" + _css_literal(value) + "]")
        if kind == "testId":
            return frame.get_by_test_id(value)
        if kind == "label":
            return frame.get_by_label(value, exact=True)
        if kind == "text":
            return frame.get_by_text(value, exact=True)
        if kind == "roleText":
            exact = r"^\s*" + r"\s+".join(re.escape(word) for word in value.split()) + r"\s*$"
            return frame.get_by_role(element["role"]).filter(has_text=re.compile(exact))
        return frame.get_by_role(element["role"], name=value, exact=True)

    def _position(self, target):
        frame = self._frame()
        locator = self._locator(frame, target)
        if locator.count() != 1 or not locator.is_visible():
            raise StepError()
        state = locator.evaluate(_ELEMENT_STATE, timeout=800)
        box = locator.bounding_box(timeout=800)
        if not box or not state["hit"]:
            raise StepError()
        if frame != self.page.main_frame:
            host = frame.frame_element()
            try:
                hit = host.evaluate("(el, p) => document.elementFromPoint(p[0], p[1]) === el",
                                    [box["x"] + box["width"] / 2, box["y"] + box["height"] / 2])
            finally:
                host.dispose()
            if not hit:
                raise StepError()
        viewport, size = self._viewport()
        try:
            rect = map_rect(box, viewport, size, self.screen)
        except ValueError as error:
            raise StepError() from error
        if not self.native.unobstructed(self.hwnd, *_center(rect)):
            raise StepError()
        return rect, state

    def _move(self, point, duration):
        origin = self.input.position()
        start = monotonic_ms()
        while True:
            self.guard()
            ratio = min(1, (monotonic_ms() - start) / duration)
            smooth = ratio * ratio * (3 - 2 * ratio)
            self.input.moveTo(*(round(a + (b - a) * smooth) for a, b in zip(origin, point)))
            if ratio >= 1:
                return
            self.control.pause(16)

    def rects(self, step_id, anchor):
        targets = dict.fromkeys(layer["target"] for layer in self.layers if layer["type"] == "box"
                                and layer["stepId"] == step_id and layer["anchor"] == anchor)
        return [{"target": target, "rectPx": self._position(target)[0]} for target in targets]

    def preflight(self, target):
        self._position(target)

    def action(self, action, timeout_ms=8000):
        op, target = action["op"], action["target"]
        if op == "observe":
            self._locator(self._frame(), target).count()
            return
        rect, state = self._position(target)
        if op == "refresh":
            started = monotonic_ms()
            before = self.page.evaluate("() => performance.timeOrigin")
            self.guard()
            self.input.press("f5")
            self.page.wait_for_function("(before) => performance.timeOrigin !== before",
                                        arg=before, timeout=max(1, timeout_ms - (monotonic_ms() - started))).dispose()
            self.page.wait_for_load_state("load", timeout=max(1, timeout_ms - (monotonic_ms() - started)))
            self._frame()
            return
        if op == "press":
            if not state["focused"]:
                raise StepError()
            self.guard()
            self.input.press(action["key"])
            return
        if state["disabled"] or (op == "replaceAscii" and not state["editable"]):
            raise StepError()
        point = _center(rect)
        self._move(point, self.profile["moveMs"])
        self.control.pause(self.profile["preClickMs"], self.guard)
        current, state = self._position(target)
        if current != rect or tuple(self.input.position()) != point or state["disabled"]:
            raise StepError()
        self.guard()
        if op == "scroll":
            self.input.scroll(action["notches"])
            return
        if op != "replaceAscii" or not state["focused"]:
            self.input.click()
        if op != "replaceAscii":
            return
        self._assert_edit_focus(target)
        self.input.hotkey("ctrl", "a")
        for char in action["text"]:
            self._assert_edit_focus(target)
            self.input.write(char)

    def _assert_edit_focus(self, target):
        locator = self._locator(self._frame(), target)
        if locator.count() != 1:
            raise StepError()
        state = locator.evaluate(_ELEMENT_STATE, timeout=800)
        if not state["focused"] or not state["editable"] or state["disabled"] or not state["hit"]:
            raise StepError()
        self.guard()

    def check(self, check):
        op, expected = check["op"], check["expected"]
        locator = self._locator(self._frame(), check["target"])
        count = locator.count()
        actual = None
        if op == "count":
            actual = count
        elif op == "visible" and count <= 1:
            actual = bool(count and locator.is_visible())
        elif count == 1:
            state = locator.evaluate(_ELEMENT_STATE, timeout=800)
            actual = state[{"checked": "checked", "value": "value", "contains": "text"}[op]]
        passed = (isinstance(actual, str) and expected in actual if op == "contains"
                  else type(actual) is type(expected) and actual == expected)
        return {**check, "actual": actual, "passed": passed}
