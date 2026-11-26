import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { readFile } from 'node:fs/promises';
import { createProjectsService, type HttpServiceError, type ProjectAdapterContext } from './services/projects.js';
import { readTaskEvents } from './events.js';
import type { StudioRepository } from './store/repository.js';
import type { TaskService } from './tasks.js';

const jsonLimit = 1_048_576;
const localHostPattern = /^127\.0\.0\.1:\d{1,5}$/;
const terminalTypes = new Set(['task.succeeded', 'task.failed', 'task.cancelled', 'task.interrupted']);

export type StudioHttpApp = FastifyInstance & {
  subscribe(taskId: string, afterSeq: number, signal: AbortSignal, pollMs?: number): ReturnType<typeof readTaskEvents>;
};

export function createHttpApp({
  repository,
  tasks,
  adapters,
}: {
  repository: StudioRepository;
  tasks: TaskService;
  adapters?: ProjectAdapterContext;
}): StudioHttpApp {
  const projects = createProjectsService(repository, tasks, adapters);
  const app = Fastify({
    bodyLimit: jsonLimit,
    exposeHeadRoutes: false,
    logger: false,
  });

  app.decorate('subscribe', (taskId: string, afterSeq: number, signal: AbortSignal, pollMs?: number) =>
    readTaskEvents(repository, taskId, afterSeq, signal, pollMs));

  app.addHook('onRequest', async (request, reply) => {
    const headers = normalizeHeaders(request.headers);
    if (!isLocalHost(headers.host)) {
      return sendError(reply, 403, 'VALIDATION_FAILED', '请通过本地工作台地址访问。');
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      if (!isAllowedWriteOrigin(headers)) return sendError(reply, 403, 'VALIDATION_FAILED', '请求来源无效。');
      if (!isJson(headers['content-type'])) return sendError(reply, 415, 'VALIDATION_FAILED', '写入请求必须使用 JSON。');
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "default-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const value = error as Partial<HttpServiceError> & { statusCode?: number };
    const status = value.statusCode ?? 500;
    const code = status === 400 || status === 413 ? 'VALIDATION_FAILED'
      : status === 500 ? 'CONNECTION_UNAVAILABLE'
        : value.code ?? 'VALIDATION_FAILED';
    const message = status === 400 ? 'JSON 格式无效。'
      : status === 413 ? 'JSON 请求超过 1 MiB 限制。'
        : value.message ?? '工作台暂时无法处理请求。';
    return sendError(reply, status, code, message, value.field, value.retryable ?? false, value.taskId);
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'VALIDATION_FAILED', '未找到接口。'));

  app.get('/api/v1/projects', async (_request, reply) => sendData(reply, 200, projects.listProjects()));
  app.post<{ Body: unknown }>('/api/v1/projects', async (request, reply) =>
    sendData(reply, 201, projects.createProject(request.body)));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', async (request, reply) =>
    sendData(reply, 200, projects.getProject(pathId(request.params.projectId))));
  app.patch<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId', async (request, reply) =>
    sendData(reply, 200, projects.updateProject(pathId(request.params.projectId), request.body)));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/messages', async (request, reply) =>
    sendData(reply, 200, projects.listMessages(pathId(request.params.projectId), requestSearchParams(request))));
  app.post<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId/messages', async (request, reply) =>
    sendData(reply, 202, await projects.postMessage(pathId(request.params.projectId), request.body)));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/artifacts', async (request, reply) =>
    sendData(reply, 200, projects.listArtifacts(
      pathId(request.params.projectId), requestSearchParams(request).get('kind') ?? undefined,
    )));

  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId', async (request, reply) =>
    sendData(reply, 200, projects.getTask(pathId(request.params.taskId))));
  app.post<{ Params: { taskId: string }; Body: unknown }>('/api/v1/tasks/:taskId/input', async (request, reply) =>
    sendData(reply, 200, await projects.respondInput(pathId(request.params.taskId), request.body)));
  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/cancel', async (request, reply) => {
    const cancelled = await projects.cancelTask(pathId(request.params.taskId));
    return sendData(reply, cancelled.statusCode, cancelled.data);
  });

  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/events', async (request, reply) => {
    const taskId = pathId(request.params.taskId);
    if (!repository.getTask(taskId)) throw httpError('VALIDATION_FAILED', 404, '未找到任务。');
    const headers = normalizeHeaders(request.headers);
    const querySeq = parseSeq(requestSearchParams(request).get('afterSeq'));
    const lastEventId = parseSeq(headers['last-event-id'] ?? null);
    if (querySeq === null || lastEventId === null) throw httpError('VALIDATION_FAILED', 400, '事件游标无效。');
    const cursor = Math.max(querySeq, lastEventId);
    if (cursor > repository.getLastEventSeq(taskId)) throw httpError('VALIDATION_FAILED', 400, '事件序号超出当前范围。');

    reply.hijack();
    await streamEvents(repository, taskId, cursor, request.raw, reply.raw);
  });

  app.get<{ Params: { artifactId: string } }>('/api/v1/artifacts/:artifactId/content', async (request, reply) => {
    const search = requestSearchParams(request);
    const projectId = search.get('projectId');
    if (!projectId) throw httpError('VALIDATION_FAILED', 422, '读取文件时必须提供 projectId。', 'projectId');
    const { artifact, path } = projects.getArtifact(pathId(projectId), pathId(request.params.artifactId));
    const bytes = await readFile(path);
    reply.type(artifact.mime).header('Content-Length', String(bytes.byteLength));
    if (search.has('download')) reply.header('Content-Disposition', `attachment; filename="${artifact.id}"`);
    return reply.send(bytes);
  });

  return app as unknown as StudioHttpApp;
}

async function streamEvents(
  repository: StudioRepository,
  taskId: string,
  cursor: number,
  req: FastifyRequest['raw'],
  res: FastifyReply['raw'],
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.on('close', abort);
  req.socket?.on('close', abort);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  const heartbeat = setInterval(() => { if (!res.destroyed) res.write(': keepalive\n\n'); }, 15_000);
  (heartbeat as unknown as { unref?: () => void }).unref?.();
  try {
    for await (const event of readTaskEvents(repository, taskId, cursor, controller.signal)) {
      if (res.destroyed || controller.signal.aborted) break;
      res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (terminalTypes.has(event.type)) break;
    }
    if (!res.destroyed) res.end();
  } finally {
    clearInterval(heartbeat);
    res.removeListener('close', abort);
    req.socket?.removeListener('close', abort);
  }
}

function requestSearchParams(request: FastifyRequest): URLSearchParams {
  return new URL(request.raw.url ?? '/', 'http://127.0.0.1:17860').searchParams;
}

function sendData(reply: FastifyReply, status: number, data: unknown) {
  return reply.code(status).send({ data });
}

function sendError(reply: FastifyReply, status: number, code: string, message: string, field?: string, retryable = false, taskId?: string) {
  return reply.code(status).send({ error: { code, message, retryable, ...(field ? { field } : {}), ...(taskId ? { taskId } : {}) } });
}

function httpError(code: string, statusCode: number, message: string, field?: string): Error & HttpServiceError {
  return Object.assign(new Error(message), { code, statusCode, retryable: false, ...(field ? { field } : {}) });
}

function normalizeHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [
    key.toLowerCase(), Array.isArray(value) ? value.join(', ') : value,
  ]));
}

function isLocalHost(host: string | undefined): boolean {
  return Boolean(host && localHostPattern.test(host));
}

function isAllowedWriteOrigin(headers: Record<string, string | undefined>): boolean {
  return Boolean(headers.host && headers.origin === `http://${headers.host}`);
}

function isJson(contentType: string | undefined): boolean {
  return Boolean(contentType && /^application\/json(?:\s*;|$)/i.test(contentType));
}

function pathId(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw httpError('VALIDATION_FAILED', 400, '路径标识无效。');
  return value;
}

function parseSeq(value: string | null): number | null {
  if (value === null || value === '') return 0;
  if (!/^\d+$/.test(value)) return null;
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}
