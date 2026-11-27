import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { planObject, PlanError } from './plans.js';

export type WorkerTimings = { pingMs: number; timeoutMs: number; stopMs: number };
export type WorkerEvent = { type: string; payload: Record<string, unknown> };
export type WorkerExit = { state: 'finished' | 'failed' | 'cancelled' | 'interrupted'; error?: PlanError };
const maxLine = 512 * 1024;
const eventTypes = new Set(['accepted', 'ready', 'step.started', 'step.verified', 'step.finished',
  'capture.started', 'capture.finished', 'failed', 'cancelled', 'heartbeat']);
const workerErrors: Record<string, string> = {
  RESOURCE_BUSY: '当前桌面已被其他录制占用，请结束该任务后手动重试。',
  WORKER_UNAVAILABLE: '请检查 Windows、Edge、Python、PyAutoGUI、Playwright 和 FFmpeg。',
  DESKTOP_UNAVAILABLE: '请使用单主屏，保持录制窗口在前台并检查定位与 Network 面板。',
  DATA_PREPARATION_FAILED: '无法准备当前项目的演示数据，请核对准备策略。',
  CAPTURE_FAILED: '无法开始或封闭桌面采集，请检查 FFmpeg 与当前显示设置。',
  STEP_FAILED: '步骤定位、动作或结果检查失败，请核对方案中的目标与预期。',
  WORKER_TIMEOUT: '与桌面 Worker 通信中断，录制已进入收尾。',
};

export function desktopSpawnSpec() {
  if (process.platform !== 'win32') throw new PlanError('WORKER_UNAVAILABLE', workerErrors.WORKER_UNAVAILABLE!);
  return { command: process.env.DEMO_STUDIO_PYTHON || 'python', args: ['-u', '-B', '-X', 'utf8',
    fileURLToPath(new URL('../workers/desktop/main.py', import.meta.url))] };
}

const taskMarker = (taskId: string) => '--studio-recording=' + taskId;

export async function desktopWorkerAlive(pid: number, taskId: string): Promise<boolean> {
  try { process.kill!(pid, '0'); }
  catch (error) {
    if ((error as { code?: string }).code === 'ESRCH') return false;
  }
  if (process.platform !== 'win32') return true;
  // 只输出归属判断，避免回显可能已复用此 PID 的其他进程命令行。
  const query = `
    $p = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $env:DEMO_STUDIO_RECOVERY_PID) -ErrorAction Stop
    if (!$p) { [Console]::Write('other') }
    elseif ($p.CommandLine -and !$p.CommandLine.EndsWith(' ' + $env:DEMO_STUDIO_RECOVERY_MARKER)) { [Console]::Write('other') }
  `;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
      windowsHide: true, timeout: 4000,
      env: { ...process.env, DEMO_STUDIO_RECOVERY_PID: String(pid), DEMO_STUDIO_RECOVERY_MARKER: taskMarker(taskId) },
    }, (error, stdout) => resolve(Boolean(error) || stdout.trim() !== 'other'));
  });
}

export function runDesktopWorker(options: {
  taskId: string; payload: unknown; signal: AbortSignal; timings?: WorkerTimings;
  spec: { command: string; args: string[] };
  onSpawn: (pid: number) => void; onEvent: (event: WorkerEvent) => void; onHeartbeat?: () => void;
  stepBudget: (stepId: unknown) => number;
}): Promise<WorkerExit> {
  const { taskId, payload, signal, spec, onSpawn, onEvent } = options;
  const timings = options.timings ?? { pingMs: 1000, timeoutMs: 6000, stopMs: 16_000 };
  return new Promise((resolve) => {
    const worker = spawn(spec.command, [...spec.args, taskMarker(taskId)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    const pending = new Map<string, string>();
    let prepareId: string;
    let started = false;
    let captured = false;
    let acknowledgedTerminal = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    let outcome: WorkerExit | undefined;
    let lastMessage = performance.now();
    let progressDeadline = 0;
    let seq = 0;
    let line = '';

    function send(op: string, payload: unknown, tracked = true) {
      const commandId = randomUUID();
      if (tracked) pending.set(commandId, op);
      worker.stdin.write(JSON.stringify({ commandId, taskId, op, payload }) + '\n');
      return commandId;
    }
    function stop(result: WorkerExit, notify = true) {
      outcome ??= result;
      if (stopTimer) return;
      if (notify && prepareId && !acknowledgedTerminal) send('cancel', { reason: outcome.state });
      stopTimer = setTimeout(() => worker.kill(), timings.stopMs);
    }
    function protocolError(error?: unknown) {
      if (outcome?.state === 'finished') outcome = undefined;
      stop({ state: 'failed', error: error instanceof PlanError ? error
        : new PlanError('OUTPUT_INVALID', '桌面 Worker 返回的事件不符合协议。') });
    }
    function consume(json: string) {
      const event = planObject(JSON.parse(json));
      const data = planObject(event?.payload);
      if (event?.taskId !== taskId || event?.seq !== seq + 1 || typeof event?.type !== 'string'
          || !eventTypes.has(event.type) || !data) throw new Error('event');
      seq++;
      lastMessage = performance.now();
      const { type } = event;
      if (type === 'heartbeat') { options.onHeartbeat?.(); return; }
      if (outcome?.state === 'finished') throw new Error('采集已经结束');
      if (type === 'accepted') {
        if (typeof data.commandId !== 'string' || !pending.delete(data.commandId)) throw new Error('accepted');
        return;
      }
      if (type === 'cancelled' || type === 'failed') {
        acknowledgedTerminal = true;
        worker.stdin.end();
        const code = typeof data.code === 'string' && Object.hasOwn(workerErrors, data.code) ? data.code : 'STEP_FAILED';
        const field = typeof data.stepId === 'string' && /^[a-z][a-z0-9-]{0,100}$/.test(data.stepId) ? data.stepId : undefined;
        if (type === 'failed' && field && !outcome) {
          onEvent({ type: 'step.failed', payload: { stepId: field, code,
            ...(Array.isArray(data.checks) ? { checks: data.checks } : {}) } });
        }
        const result: WorkerExit = type === 'cancelled' && (signal.aborted || data.reason === 'desktop_hotkey') ? { state: 'cancelled' }
          : { state: code === 'WORKER_TIMEOUT' ? 'interrupted' : 'failed',
            error: new PlanError(code, workerErrors[code]!, code === 'RESOURCE_BUSY' ? 409 : 422, field) };
        stop(result, false);
        return;
      }
      if (outcome) {
        if (type === 'capture.finished') {
          acknowledgedTerminal = true;
          worker.stdin.end();
        }
        return;
      }
      if (pending.size) throw new Error('未确认命令');
      if (type === 'ready') {
        if (started || data.commandId !== prepareId) throw new Error('ready');
        if (signal.aborted) return cancel();
        onEvent({ type, payload: data });
        started = true;
        progressDeadline = performance.now() + 15_000;
        send('start', { prepareCommandId: prepareId });
      } else {
        if (!started || (type === 'capture.started' ? captured : !captured)) throw new Error('capture');
        onEvent({ type, payload: data });
        if (type === 'step.started') progressDeadline = performance.now() + options.stepBudget(data.stepId);
        if (type === 'step.finished' || type === 'capture.started') progressDeadline = performance.now() + 25_000;
        if (type === 'capture.started') captured = true;
        if (type === 'capture.finished') {
          acknowledgedTerminal = true;
          worker.stdin.end();
          stop({ state: 'finished' }, false);
        }
      }
    }
    function cancel() { stop({ state: 'cancelled' }); }
    const ping = setInterval(() => {
      if (outcome || !prepareId) return;
      if (performance.now() - lastMessage > timings.timeoutMs) {
        stop({ state: 'interrupted', error: new PlanError('WORKER_TIMEOUT', workerErrors.WORKER_TIMEOUT!) });
      } else if (performance.now() > progressDeadline) {
        stop({ state: 'interrupted', error: new PlanError('WORKER_TIMEOUT', '桌面 Worker 长时间未报告阶段进度，录制已进入收尾。') });
      } else {
        send('ping', {}, false);
      }
    }, timings.pingMs);
    signal.addEventListener('abort', cancel, { once: true });
    worker.stdin.on('error', () => {
      if (!outcome) stop({ state: 'interrupted', error: new PlanError('WORKER_TIMEOUT', workerErrors.WORKER_TIMEOUT!) }, false);
    });
    worker.once('spawn', () => {
      try {
        onSpawn(worker.pid as number);
        if (signal.aborted) {
          worker.stdin.end();
          return cancel();
        }
        lastMessage = performance.now();
        progressDeadline = lastMessage + 60_000;
        prepareId = send('prepare', payload);
      } catch { protocolError(); }
    });
    worker.once('error', () => stop({ state: 'failed', error: new PlanError('WORKER_UNAVAILABLE', workerErrors.WORKER_UNAVAILABLE!) }, false));
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      line += chunk;
      let end;
      while ((end = line.indexOf('\n')) >= 0) {
        const json = line.slice(0, end);
        line = line.slice(end + 1);
        try {
          if (json.length > maxLine) throw new Error('line length');
          consume(json);
        } catch (error) { protocolError(error); }
      }
      if (line.length > maxLine) { line = ''; protocolError(); }
    });
    worker.once('close', (code: number | null) => {
      clearInterval(ping);
      clearTimeout(stopTimer);
      signal.removeEventListener('abort', cancel);
      if (outcome?.state === 'cancelled' && prepareId && (!acknowledgedTerminal || code !== 0)) {
        return resolve({ state: 'interrupted', error: new PlanError('WORKER_TIMEOUT', '未收到 Worker 停止确认，请检查部分原片。') });
      }
      if (outcome && (outcome.state !== 'finished' || (code === 0 && !line))) return resolve(outcome);
      resolve({ state: 'interrupted', error: new PlanError('WORKER_TIMEOUT', '桌面 Worker 提前退出，录制已中断。') });
    });
  });
}
