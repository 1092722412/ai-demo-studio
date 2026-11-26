import {
  AiTaskError,
  type AiAdapter,
  type AiEvent,
  type AiInput,
  type AiResult,
  type AiRuntime,
} from './ai/contracts.js';

export type TaskState = 'queued' | 'running' | 'waiting_input' | 'cancelling' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

export type TaskSummary = {
  taskId: string;
  projectId: string;
  state: TaskState;
  error?: { code: string; message: string; retryable: boolean };
};

export type TaskRuntimeDependencies = Omit<AiRuntime, 'signal' | 'emit' | 'awaitPermission'>;

export type TaskServiceOptions = {
  adapter: AiAdapter;
  createRuntime(input: AiInput): TaskRuntimeDependencies | Promise<TaskRuntimeDependencies>;
  onEvent?(taskId: string, event: AiEvent): void | Promise<void>;
  maxEventBytes?: number;
};

type PendingPermission = {
  event: Extract<AiEvent, { type: 'permission.requested' }>;
  resolve(value: unknown): void;
  reject(error: Error): void;
  removeAbort(): void;
};

type TaskRun = {
  input: AiInput;
  controller: AbortController;
  state: TaskState;
  result: AiResult | null;
  error: AiTaskError | null;
  execution: Promise<void>;
  cancelRequested: boolean;
  timedOut: boolean;
  permissions: Map<string, PendingPermission>;
};

export class TaskService {
  private readonly runs = new Map<string, TaskRun>();
  private readonly activeProjectTasks = new Map<string, string>();
  private readonly maxEventBytes: number;

  constructor(private readonly options: TaskServiceOptions) {
    this.maxEventBytes = options.maxEventBytes ?? 256_000;
  }

  async startAi(input: AiInput): Promise<TaskSummary> {
    if (this.runs.has(input.taskId)) throw new AiTaskError('REQUEST_CONFLICT', '任务编号已存在。');
    if (this.activeProjectTasks.has(input.projectId)) {
      throw new AiTaskError('REQUEST_CONFLICT', '该项目已有 AI 任务正在执行。', true);
    }
    const run: TaskRun = {
      input,
      controller: new AbortController(),
      state: 'queued',
      result: null,
      error: null,
      execution: Promise.resolve(),
      cancelRequested: false,
      timedOut: false,
      permissions: new Map(),
    };
    this.runs.set(input.taskId, run);
    this.activeProjectTasks.set(input.projectId, input.taskId);
    run.execution = Promise.resolve().then(() => this.execute(run));
    void run.execution.catch(() => {});
    return this.summary(run);
  }

  async cancel(taskId: string): Promise<TaskSummary> {
    const run = this.requireRun(taskId);
    if (isTerminal(run.state)) return this.summary(run);
    if (run.state === 'cancelling') return this.summary(run);
    run.cancelRequested = true;
    run.state = 'cancelling';
    run.controller.abort('user-cancelled');
    return this.summary(run);
  }

  async respondInput(taskId: string, requestId: string, response: unknown): Promise<TaskSummary> {
    const run = this.requireRun(taskId);
    const pending = run.permissions.get(requestId);
    if (!pending || run.state !== 'waiting_input') {
      throw new AiTaskError('REQUEST_CONFLICT', '任务当前没有等待此项人工输入。');
    }
    run.permissions.delete(requestId);
    pending.removeAbort();
    run.state = 'running';
    pending.resolve(response);
    return this.summary(run);
  }

  get(taskId: string): TaskSummary {
    return this.summary(this.requireRun(taskId));
  }

  async wait(taskId: string): Promise<TaskSummary> {
    const run = this.requireRun(taskId);
    await run.execution;
    return this.summary(run);
  }

  getResult(taskId: string): AiResult | null {
    return this.requireRun(taskId).result;
  }

  private async execute(run: TaskRun): Promise<void> {
    const { input } = run;
    if (run.controller.signal.aborted) {
      this.finishError(run, new AiTaskError('TASK_CANCELLED', 'AI 任务已取消。'));
      return;
    }
    run.state = 'running';
    const timer = setTimeout(() => {
      run.timedOut = true;
      run.controller.abort('task-timeout');
    }, input.limits.timeoutMs);
    try {
      const dependencies = await this.options.createRuntime(input);
      const runtime: AiRuntime = {
        ...dependencies,
        signal: run.controller.signal,
        emit: async (event) => {
          if (run.controller.signal.aborted) return;
          const bytes = new TextEncoder().encode(JSON.stringify(event)).length;
          if (bytes > this.maxEventBytes) throw new AiTaskError('LIMIT_EXCEEDED', 'AI 事件超过大小限制。');
          await this.options.onEvent?.(input.taskId, event);
        },
        awaitPermission: (event) => this.awaitPermission(run, event),
      };
      const result = await this.options.adapter.execute(input, runtime);
      if (run.controller.signal.aborted) {
        this.finishError(run, run.timedOut
          ? new AiTaskError('TIMEOUT', 'AI 任务已达到时限。', true)
          : new AiTaskError('TASK_CANCELLED', 'AI 任务已取消。'));
        return;
      }
      run.result = result;
      run.state = 'succeeded';
      this.releaseProject(run);
    } catch (error) {
      const taskError = error instanceof AiTaskError
        ? error
        : new AiTaskError('CONNECTION_UNAVAILABLE', 'AI 任务执行失败，请检查连接后重试。', true);
      if (run.timedOut) {
        this.finishError(run, taskError.code === 'WORKER_LOST' && !taskError.confirmedStopped
          ? taskError
          : new AiTaskError('TIMEOUT', 'AI 任务已达到时限。', true, taskError.confirmedStopped));
      } else if (run.cancelRequested) {
        this.finishError(run, taskError.code === 'WORKER_LOST' && !taskError.confirmedStopped
          ? taskError
          : new AiTaskError('TASK_CANCELLED', 'AI 任务已停止。', false, taskError.confirmedStopped));
      } else {
        this.finishError(run, taskError);
      }
    } finally {
      clearTimeout(timer);
      for (const pending of run.permissions.values()) {
        pending.removeAbort();
        pending.reject(new AiTaskError('TASK_CANCELLED', 'AI 任务已停止。'));
      }
      run.permissions.clear();
    }
  }

  private awaitPermission(
    run: TaskRun,
    event: Extract<AiEvent, { type: 'permission.requested' }>,
  ): Promise<unknown> {
    if (run.controller.signal.aborted) return Promise.reject(new AiTaskError('TASK_CANCELLED', 'AI 任务已停止。'));
    if (run.permissions.has(event.requestId)) return Promise.reject(new AiTaskError('REQUEST_CONFLICT', '人工输入请求编号重复。'));
    run.state = 'waiting_input';
    return new Promise((resolvePermission, rejectPermission) => {
      const abort = () => {
        run.permissions.delete(event.requestId);
        rejectPermission(new AiTaskError('TASK_CANCELLED', 'AI 任务已停止。'));
      };
      run.controller.signal.addEventListener('abort', abort, { once: true });
      run.permissions.set(event.requestId, {
        event,
        resolve: resolvePermission,
        reject: rejectPermission,
        removeAbort: () => run.controller.signal.removeEventListener('abort', abort),
      });
    });
  }

  private finishError(run: TaskRun, error: AiTaskError): void {
    run.error = error;
    if (error.code === 'TASK_CANCELLED') run.state = 'cancelled';
    else if (!error.confirmedStopped && (error.code === 'WORKER_LOST' || error.code === 'TIMEOUT')) run.state = 'interrupted';
    else run.state = 'failed';
    if (error.confirmedStopped) this.releaseProject(run);
  }

  private releaseProject(run: TaskRun): void {
    if (this.activeProjectTasks.get(run.input.projectId) === run.input.taskId) {
      this.activeProjectTasks.delete(run.input.projectId);
    }
  }

  private summary(run: TaskRun): TaskSummary {
    const value: TaskSummary = { taskId: run.input.taskId, projectId: run.input.projectId, state: run.state };
    if (run.error) value.error = { code: run.error.code, message: run.error.message, retryable: run.error.retryable };
    return value;
  }

  private requireRun(taskId: string): TaskRun {
    const run = this.runs.get(taskId);
    if (!run) throw new AiTaskError('VALIDATION_FAILED', '找不到此 AI 任务。');
    return run;
  }
}

function isTerminal(state: TaskState): boolean {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
}
