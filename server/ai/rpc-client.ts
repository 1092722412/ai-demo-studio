import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AiTaskError } from './contracts.js';

export type RpcId = string | number;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type RpcResponse = { jsonrpc?: string; id: RpcId | null; result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
type RpcNotification = { jsonrpc?: string; method: string; params?: unknown };
type RpcServerRequest = { jsonrpc?: string; id: RpcId; method: string; params?: unknown };
type PendingRequest = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: ReturnType<typeof setTimeout>;
};

export class RpcRemoteError extends Error {
  constructor(readonly rpcCode: number | undefined, message: string, readonly data: unknown) {
    super(message);
    this.name = 'RpcRemoteError';
  }
}

export type RpcClientOptions = {
  requestTimeoutMs?: number;
  maxLineBytes?: number;
};

export class JsonRpcClient {
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private exitValue: { code: number | null; signal: string | null } | null = null;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private notificationHandler: ((method: string, params: unknown) => void | Promise<void>) | null = null;
  private serverRequestHandler: ((request: RpcServerRequest) => Promise<unknown>) | null = null;
  private exitHandlers = new Set<(code: number | null, signal: string | null) => void>();
  private diagnostics = '';
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;

  constructor(private readonly child: ChildProcessWithoutNullStreams, options: RpcClientOptions = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxLineBytes = options.maxLineBytes ?? 1_000_000;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.readChunk(chunk));
    child.stderr.on('data', (chunk: string) => {
      this.diagnostics = redactDiagnostic((this.diagnostics + chunk).slice(-4_000));
    });
    child.once('error', (error: { code?: string }) => {
      this.fail(new AiTaskError(
        error.code === 'ENOENT' ? 'CONNECTION_UNAVAILABLE' : 'WORKER_LOST',
        error.code === 'ENOENT' ? '未找到 Codex CLI，请安装后重试。' : 'Codex app-server 进程启动失败。',
        true,
      ));
    });
    child.once('close', (code: number | null, signal: string | null) => {
      this.closed = true;
      this.exitValue = { code, signal };
      this.fail(new AiTaskError('WORKER_LOST', 'Codex app-server 进程已退出。', true));
      for (const handler of this.exitHandlers) handler(code, signal);
    });
  }

  get diagnosticSummary(): string {
    return this.diagnostics;
  }

  onNotification(handler: (method: string, params: unknown) => void | Promise<void>): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: (request: RpcServerRequest) => Promise<unknown>): void {
    this.serverRequestHandler = handler;
  }

  onExit(handler: (code: number | null, signal: string | null) => void): () => void {
    this.exitHandlers.add(handler);
    if (this.exitValue) handler(this.exitValue.code, this.exitValue.signal);
    return () => this.exitHandlers.delete(handler);
  }

  request(method: string, params: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new AiTaskError('WORKER_LOST', 'Codex app-server 连接已关闭。', true));
        return;
      }
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new AiTaskError('TIMEOUT', '等待 Codex app-server 响应超时。', true));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  endInput(): void {
    if (!this.closed) this.child.stdin.end();
  }

  waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitValue) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = () => {
        clearTimeout(timer);
        remove();
        resolve(true);
      };
      const remove = this.onExit(done);
      timer = setTimeout(() => {
        remove();
        resolve(false);
      }, timeoutMs);
    });
  }

  private write(message: unknown): void {
    if (this.closed || this.child.stdin.destroyed) {
      throw new AiTaskError('WORKER_LOST', 'Codex app-server 连接已关闭。', true);
    }
    this.child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
  }

  private readChunk(chunk: string): void {
    this.buffer += chunk;
    if (new TextEncoder().encode(this.buffer).length > this.maxLineBytes && !this.buffer.includes('\n')) {
      this.fail(new AiTaskError('LIMIT_EXCEEDED', 'Codex app-server 单条消息超过大小限制。'));
      return;
    }
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (new TextEncoder().encode(line).length > this.maxLineBytes) {
        this.fail(new AiTaskError('LIMIT_EXCEEDED', 'Codex app-server 单条消息超过大小限制。'));
        return;
      }
      let message: unknown;
      try { message = JSON.parse(line); }
      catch {
        this.fail(new AiTaskError('CONNECTION_UNAVAILABLE', 'Codex app-server 返回了无效的 JSON-RPC 消息。'));
        return;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: unknown): void {
    if (!message || typeof message !== 'object') return;
    const envelope = message as Record<string, unknown>;
    if (Object.hasOwn(envelope, 'id') && (typeof envelope.id === 'string' || typeof envelope.id === 'number')) {
      if (typeof envelope.method === 'string') {
        void this.handleServerRequest(envelope as unknown as RpcServerRequest);
        return;
      }
      const pending = this.pending.get(envelope.id);
      if (!pending) return;
      this.pending.delete(envelope.id);
      clearTimeout(pending.timeout);
      if (envelope.error && typeof envelope.error === 'object') {
        const error = envelope.error as { code?: number; message?: string; data?: unknown };
        pending.reject(new RpcRemoteError(error.code, redactDiagnostic(error.message || 'Codex app-server 请求失败。'), error.data));
      } else {
        pending.resolve(envelope.result);
      }
      return;
    }
    if (typeof envelope.method === 'string') {
      try {
        const params = envelope.params ?? {};
        void Promise.resolve(this.notificationHandler?.(envelope.method, params)).catch(() => {
          this.fail(new AiTaskError('CONNECTION_UNAVAILABLE', '处理 Codex app-server 通知失败。'));
        });
      } catch {
        this.fail(new AiTaskError('CONNECTION_UNAVAILABLE', '处理 Codex app-server 通知失败。'));
      }
    }
  }

  private async handleServerRequest(request: RpcServerRequest): Promise<void> {
    if (!this.serverRequestHandler) {
      this.respondError(request.id, -32601, '当前工作台不支持此请求。');
      return;
    }
    try {
      const result = await this.serverRequestHandler(request);
      this.respond(request.id, result);
    } catch {
      this.respondError(request.id, -32000, '请求未获批准或处理失败。');
    }
  }

  private fail(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(-2_000);
}
