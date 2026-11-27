"""Windows 交互桌面互斥、进程归属与物理窗口检查。"""
import ctypes
from ctypes import wintypes as win


class DesktopBusy(RuntimeError):
    pass


class DesktopUnavailable(RuntimeError):
    pass


class _BasicLimits(ctypes.Structure):
    _fields_ = [
        ("ProcessUserTime", ctypes.c_longlong), ("JobUserTime", ctypes.c_longlong),
        ("Flags", win.DWORD), ("MinWorkingSet", ctypes.c_size_t), ("MaxWorkingSet", ctypes.c_size_t),
        ("ActiveProcesses", win.DWORD), ("Affinity", ctypes.c_size_t),
        ("PriorityClass", win.DWORD), ("SchedulingClass", win.DWORD),
    ]


class _ExtendedLimits(ctypes.Structure):
    _fields_ = [
        ("Basic", _BasicLimits), ("IoCounters", ctypes.c_ulonglong * 6),
        ("ProcessMemory", ctypes.c_size_t), ("JobMemory", ctypes.c_size_t),
        ("PeakProcessMemory", ctypes.c_size_t), ("PeakJobMemory", ctypes.c_size_t),
    ]


def _function(library, name, result, *args):
    function = getattr(library, name)
    function.restype = result
    function.argtypes = args
    return function


class WindowsDesktop:
    def __init__(self):
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        user = ctypes.WinDLL("user32", use_last_error=True)
        self.close_handle = _function(kernel, "CloseHandle", win.BOOL, win.HANDLE)
        self.release_mutex = _function(kernel, "ReleaseMutex", win.BOOL, win.HANDLE)
        self.create_mutex = _function(kernel, "CreateMutexW", win.HANDLE, win.LPVOID, win.BOOL, win.LPCWSTR)
        self.wait_for_mutex = _function(kernel, "WaitForSingleObject", win.DWORD, win.HANDLE, win.DWORD)
        self.create_job = _function(kernel, "CreateJobObjectW", win.HANDLE, win.LPVOID, win.LPCWSTR)
        self.set_job = _function(kernel, "SetInformationJobObject", win.BOOL, win.HANDLE, ctypes.c_int, win.LPVOID, win.DWORD)
        self.assign_job = _function(kernel, "AssignProcessToJobObject", win.BOOL, win.HANDLE, win.HANDLE)
        self.current_process = _function(kernel, "GetCurrentProcess", win.HANDLE)
        self.open_process = _function(kernel, "OpenProcess", win.HANDLE, win.DWORD, win.BOOL, win.DWORD)
        self.in_job = _function(kernel, "IsProcessInJob", win.BOOL, win.HANDLE, win.HANDLE, ctypes.POINTER(win.BOOL))
        self.metrics = _function(user, "GetSystemMetrics", ctypes.c_int, ctypes.c_int)
        self.get_foreground = _function(user, "GetForegroundWindow", win.HWND)
        self.window_pid = _function(user, "GetWindowThreadProcessId", win.DWORD, win.HWND, ctypes.POINTER(win.DWORD))
        self.window_class = _function(user, "GetClassNameW", ctypes.c_int, win.HWND, win.LPWSTR, ctypes.c_int)
        self.window_at = _function(user, "WindowFromPoint", win.HWND, win.POINT)
        self.ancestor = _function(user, "GetAncestor", win.HWND, win.HWND, win.UINT)
        self.find_window = _function(user, "FindWindowW", win.HWND, win.LPCWSTR, win.LPCWSTR)
        self.get_rect = _function(user, "GetWindowRect", win.BOOL, win.HWND, ctypes.POINTER(win.RECT))
        self.visible = _function(user, "IsWindowVisible", win.BOOL, win.HWND)
        self.key_state = _function(user, "GetAsyncKeyState", ctypes.c_short, ctypes.c_int)
        self.set_dpi = _function(user, "SetProcessDpiAwarenessContext", win.BOOL, win.HANDLE)
        self.get_dpi = _function(user, "GetThreadDpiAwarenessContext", win.HANDLE)
        self.same_dpi = _function(user, "AreDpiAwarenessContextsEqual", win.BOOL, win.HANDLE, win.HANDLE)
        self.enum_callback = ctypes.WINFUNCTYPE(win.BOOL, win.HWND, win.LPARAM)
        self.enum_windows = _function(user, "EnumWindows", win.BOOL, self.enum_callback, win.LPARAM)
        self.set_foreground = _function(user, "SetForegroundWindow", win.BOOL, win.HWND)
        self.job = None
        self.mutex = None

    def __enter__(self):
        mutex = self.create_mutex(None, False, r"Local\AIDemoStudio.DesktopRecording")
        if not mutex:
            raise DesktopUnavailable("无法创建桌面互斥量")
        status = self.wait_for_mutex(mutex, 0)
        if status not in (0, 0x80):
            self.close_handle(mutex)
            if status == 0x102:
                raise DesktopBusy()
            raise DesktopUnavailable("无法获取桌面互斥量")
        self.mutex = mutex
        try:
            per_monitor_v2 = win.HANDLE(-4)
            if not self.set_dpi(per_monitor_v2) and not self.same_dpi(self.get_dpi(), per_monitor_v2):
                raise DesktopUnavailable("无法启用物理像素坐标")
            self._contain_children()
            return self
        except Exception:
            self.__exit__()
            raise

    def _contain_children(self):
        job = self.create_job(None, None)
        limits = _ExtendedLimits()
        limits.Basic.Flags = 0x2000  # KILL_ON_JOB_CLOSE
        if not job or not self.set_job(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)) or not self.assign_job(job, self.current_process()):
            if job:
                self.close_handle(job)
            raise DesktopUnavailable("无法约束录制子进程生命周期")
        # 当前 Worker 也在 Job 内，进程退出时由内核关闭这个句柄并清理遗留子进程。
        self.job = job

    def __exit__(self, *_):
        # 已加入 Job 后与 Job 一同留到进程退出，覆盖子进程异常收尾。
        if self.mutex and not self.job:
            self.release_mutex(self.mutex)
            self.close_handle(self.mutex)
            self.mutex = None

    def screen(self):
        width, height = self.metrics(0), self.metrics(1)
        taskbar = self.find_window("Shell_TrayWnd", None)
        rect = win.RECT()
        if (self.metrics(80) != 1 or width <= 0 or height <= 0
                or not taskbar or not self.visible(taskbar) or not self.get_rect(taskbar, ctypes.byref(rect))
                or min(rect.right, width) - max(rect.left, 0) < 3
                or min(rect.bottom, height) - max(rect.top, 0) < 3):
            raise DesktopUnavailable("需要任务栏可见的单主屏")
        return width, height

    def owns_edge(self, hwnd):
        if not hwnd or not self.visible(hwnd):
            return False
        name = ctypes.create_unicode_buffer(64)
        self.window_class(hwnd, name, len(name))
        if name.value != "Chrome_WidgetWin_1":
            return False
        pid = win.DWORD()
        self.window_pid(hwnd, ctypes.byref(pid))
        process = self.open_process(0x1000, False, pid.value)
        if not process:
            return False
        try:
            member = win.BOOL()
            return bool(self.in_job(process, self.job, ctypes.byref(member)) and member.value)
        finally:
            self.close_handle(process)

    def foreground_edge(self):
        windows = []

        @self.enum_callback
        def visit(hwnd, _):
            if self.owns_edge(hwnd):
                windows.append(hwnd)
            return True

        self.enum_windows(visit, 0)
        if len(windows) != 1:
            return None
        hwnd = windows[0]
        if self.get_foreground() != hwnd:
            self.set_foreground(hwnd)
        return hwnd if self.get_foreground() == hwnd else None

    def unobstructed(self, hwnd, x, y):
        window = self.window_at(win.POINT(x, y))
        return bool(window and self.ancestor(window, 2) == hwnd)

    def stop_pressed(self):
        return all(self.key_state(key) & 0x8000 for key in (0x11, 0x12, 0x10, 0x79))
