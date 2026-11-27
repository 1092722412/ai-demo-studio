import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { open } from 'node:fs/promises';
import { createProjectsService, type HttpServiceError, type ProjectAdapterContext } from './services/projects.js';
import { readTaskEvents } from './events.js';
import type { StudioRepository } from './store/repository.js';
import type { TaskService } from './tasks.js';
import { createSettingsService } from './settings.js';
import { createConnectionsService } from './connections.js';
import { createArtifactJobs } from './services/artifact-jobs.js';
import { maxAttachmentBytes } from './attachments.js';
import { createPlanService } from './plans.js';
import { createScriptService } from './scripts.js';
import { videoRange } from './artifacts.js';
import { createRequirementsService } from './requirements.js';
import { createPreviewService } from './preview.js';
import { createRecordingService, type RecordingOptions } from './recording.js';

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
  connectionProbes,
  credentialStorage,
  speechRenderer,
  recordingOptions,
}: {
  repository: StudioRepository;
  tasks: TaskService;
  adapters?: ProjectAdapterContext;
  connectionProbes?: Parameters<typeof createConnectionsService>[1];
  credentialStorage?: Parameters<typeof createConnectionsService>[2];
  speechRenderer?: Parameters<typeof createArtifactJobs>[1];
  recordingOptions?: RecordingOptions;
}): StudioHttpApp {
  const previews = createPreviewService(repository);
  const projects = createProjectsService(repository, tasks, adapters, previews.retire);
  const settings = createSettingsService(repository);
  const connections = createConnectionsService(repository, connectionProbes, credentialStorage);
  const artifactJobs = createArtifactJobs(repository, speechRenderer);
  const plans = createPlanService(repository);
  const requirements = createRequirementsService(repository);
  const scripts = createScriptService(repository);
  const recordings = createRecordingService(repository, previews.recordingTarget, recordingOptions);
  const shutdown = new AbortController();
  const app = Fastify({
    bodyLimit: jsonLimit,
    exposeHeadRoutes: false,
    logger: false,
  });
  app.register(multipart, { limits: { parts: 2, files: 1, fields: 0, fileSize: maxAttachmentBytes + 1 } });
  app.addHook('onClose', () => artifactJobs.close());
  app.addHook('onClose', () => scripts.close());
  app.addHook('preClose', async () => {
    shutdown.abort();
    await recordings.close();
    await previews.close();
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
      const upload = request.routeOptions.url === '/api/v1/projects/:projectId/attachments';
      const bodyless = request.routeOptions.url === '/api/v1/connections/:id/credential'
        || request.routeOptions.url === '/api/v1/connections/:id/probe'
        || request.routeOptions.url === '/api/v1/projects/:projectId/preview';
      if (upload && !/^multipart\/form-data(?:\s*;|$)/i.test(headers['content-type'] ?? '')) {
        return sendError(reply, 415, 'VALIDATION_FAILED', '附件上传必须使用 multipart/form-data。');
      }
      if (!upload && !isJson(headers['content-type']) && !(bodyless && !headers['content-type'])) {
        return sendError(reply, 415, 'VALIDATION_FAILED', '写入请求必须使用 JSON。');
      }
    }
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', _request.routeOptions.url === '/api/v1/artifacts/:artifactId/content'
      ? "sandbox; default-src 'none'; frame-ancestors 'none'"
      : "default-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    const value = error as Partial<HttpServiceError> & { statusCode?: number };
    const status = value.statusCode ?? 500;
    const upload = _request.routeOptions.url === '/api/v1/projects/:projectId/attachments';
    const code = upload && status === 413 ? 'LIMIT_EXCEEDED'
      : status === 400 || status === 413 ? 'VALIDATION_FAILED'
      : status === 500 ? 'CONNECTION_UNAVAILABLE'
        : value.code ?? 'VALIDATION_FAILED';
    const message = status >= 500 && status !== 503 && status !== 504 ? '工作台暂时无法处理请求。'
      : upload && status === 413 ? '附件超过 20 MiB 限制。'
      : status === 400 ? (upload ? '附件上传请求格式无效。' : 'JSON 格式无效。')
      : status === 413 ? 'JSON 请求超过 1 MiB 限制。'
        : value.message ?? '工作台暂时无法处理请求。';
    return sendError(reply, status, code, message, value.field, value.retryable ?? false, value.taskId);
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'VALIDATION_FAILED', '未找到接口。'));

  app.get('/api/v1/projects', async (_request, reply) => sendData(reply, 200, projects.listProjects()));
  app.get('/api/v1/connections', async (_request, reply) => sendData(reply, 200, connections.list()));
  app.post('/api/v1/connections', async (request, reply) => sendData(reply, 201, await connections.create(request.body)));
  app.patch<{ Params: { id: string } }>('/api/v1/connections/:id', async (request, reply) =>
    sendData(reply, 200, await connections.update(pathId(request.params.id), request.body)));
  app.delete<{ Params: { id: string } }>('/api/v1/connections/:id/credential', async (request, reply) => {
    await connections.clearCredential(pathId(request.params.id));
    return reply.code(204).send();
  });
  app.post<{ Params: { id: string } }>('/api/v1/connections/:id/probe', async (request, reply) =>
    sendData(reply, 200, await connections.probe(pathId(request.params.id))));
  app.get('/api/v1/settings', async (_request, reply) => sendWithToken(reply, settings.read('global')));
  app.put<{ Body: unknown }>('/api/v1/settings', async (request, reply) => sendWithToken(reply,
    settings.save('global', objectBody(request.body).values, request.headers['if-match'] ?? null)));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/settings', async (request, reply) => {
    const projectId = pathId(request.params.projectId);
    if (!repository.getProject(projectId)) throw httpError('VALIDATION_FAILED', 404, '未找到项目。');
    return sendWithToken(reply, settings.read(`project:${projectId}`));
  });
  app.put<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId/settings', async (request, reply) => {
    const projectId = pathId(request.params.projectId);
    if (!repository.getProject(projectId)) throw httpError('VALIDATION_FAILED', 404, '未找到项目。');
    return sendWithToken(reply, settings.save(`project:${projectId}`, objectBody(request.body).values, request.headers['if-match'] ?? null));
  });
  app.post<{ Body: unknown }>('/api/v1/projects', async (request, reply) =>
    sendData(reply, 201, projects.createProject(request.body)));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId', async (request, reply) =>
    sendData(reply, 200, projects.getProject(pathId(request.params.projectId))));
  app.patch<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId', async (request, reply) =>
    sendData(reply, 200, projects.updateProject(pathId(request.params.projectId), request.body)));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/requirements', async (request, reply) =>
    sendWithToken(reply, requirements.read(pathId(request.params.projectId))));
  app.put<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId/requirements', async (request, reply) =>
    sendWithToken(reply, requirements.save(pathId(request.params.projectId), request.body, request.headers['if-match'] ?? null)));
  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/plan', async (request, reply) =>
    sendWithToken(reply, plans.read(pathId(request.params.projectId))));
  app.put<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId/plan', async (request, reply) =>
    sendWithToken(reply, plans.save(pathId(request.params.projectId), objectBody(request.body).draft, request.headers['if-match'] ?? null)));
  app.post<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId/scripts', async (request, reply) =>
    sendData(reply, 202, await scripts.start(pathId(request.params.projectId), request.body)));
  app.post<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId/recordings', async (request, reply) =>
    sendData(reply, 202, await recordings.startRecording(pathId(request.params.projectId), request.body)));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/messages', async (request, reply) =>
    sendData(reply, 200, projects.listMessages(pathId(request.params.projectId), requestSearchParams(request))));
  app.post<{ Params: { projectId: string }; Body: unknown }>('/api/v1/projects/:projectId/messages', async (request, reply) =>
    sendData(reply, 202, await projects.postMessage(pathId(request.params.projectId), request.body)));

  app.get<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/artifacts', async (request, reply) =>
    sendData(reply, 200, projects.listArtifacts(
      pathId(request.params.projectId), requestSearchParams(request).get('kind') ?? undefined,
    )));
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/attachments', async (request, reply) => {
    const parts = request.parts();
    const first = await parts.next();
    if (first.done || first.value.type !== 'file') {
      throw httpError('VALIDATION_FAILED', 422, '请上传一个 file 附件。');
    }
    const { filename, mimetype, fieldname } = first.value;
    const bytes = await first.value.toBuffer();
    if (!(await parts.next()).done) throw httpError('VALIDATION_FAILED', 422, '一次只能上传一个附件。');
    if (fieldname !== 'file') throw httpError('VALIDATION_FAILED', 422, '请上传一个 file 附件。');
    return sendData(reply, 201, await artifactJobs.upload(pathId(request.params.projectId), filename, mimetype, bytes));
  });
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/speech-preview', async (request, reply) =>
    sendData(reply, 202, artifactJobs.preview(pathId(request.params.projectId), objectBody(request.body))));
  app.post<{ Params: { projectId: string } }>('/api/v1/projects/:projectId/preview', async (request, reply) =>
    sendData(reply, 200, await previews.open(pathId(request.params.projectId))));

  app.get<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId', async (request, reply) =>
    sendData(reply, 200, projects.getTask(pathId(request.params.taskId))));
  app.post<{ Params: { taskId: string }; Body: unknown }>('/api/v1/tasks/:taskId/input', async (request, reply) =>
    sendData(reply, 200, await projects.respondInput(pathId(request.params.taskId), request.body)));
  app.post<{ Params: { taskId: string } }>('/api/v1/tasks/:taskId/cancel', async (request, reply) => {
    const taskId = pathId(request.params.taskId);
    const task = repository.getTask(taskId);
    if (task && (artifactJobs.cancel(task) || scripts.cancel(task) || recordings.cancel(task))) return sendData(reply, 202, projects.getTask(taskId));
    const cancelled = await projects.cancelTask(taskId);
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
    await streamEvents(repository, taskId, cursor, request.raw, reply.raw, shutdown.signal);
  });

  app.get<{ Params: { artifactId: string } }>('/api/v1/artifacts/:artifactId/content', async (request, reply) => {
    const search = requestSearchParams(request);
    const projectId = search.get('projectId');
    if (!projectId) throw httpError('VALIDATION_FAILED', 422, '读取文件时必须提供 projectId。', 'projectId');
    const download = search.get('download') === '1';
    const { artifact, path } = projects.getArtifact(pathId(projectId), pathId(request.params.artifactId), download);
    const handle = await open(path, 'r').catch(() => { throw httpError('VALIDATION_FAILED', 404, '此文件当前不可读取。'); });
    let stream;
    try {
      const { size } = await handle.stat();
      const video = artifact.mime.startsWith('video/');
      const range = video && request.headers.range ? videoRange(request.headers.range, size) : undefined;
      if (video) reply.header('Accept-Ranges', 'bytes');
      if (range === null) {
        reply.header('Content-Range', `bytes */${size}`);
        return sendError(reply, 416, 'VALIDATION_FAILED', '请求的视频范围无效。');
      }
      if (range) reply.code(206).header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      reply.type(artifact.mime).header('Content-Length', String(range ? range.end - range.start + 1 : size));
      if (download) {
        const extension = artifact.relativePath.match(/(?:\.[A-Za-z0-9]{1,10})(?:\.partial)?$/)?.[0] ?? '';
        reply.header('Content-Disposition', `attachment; filename="${artifact.id}${extension}"`);
      }
      stream = handle.createReadStream(range);
      return reply.send(stream);
    } finally {
      if (!stream) await handle.close();
    }
  });

  return app as unknown as StudioHttpApp;
}

async function streamEvents(
  repository: StudioRepository,
  taskId: string,
  cursor: number,
  req: FastifyRequest['raw'],
  res: FastifyReply['raw'],
  shutdown: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, shutdown]);
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
    for await (const event of readTaskEvents(repository, taskId, cursor, signal)) {
      if (res.destroyed || signal.aborted) break;
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

function sendWithToken(reply: FastifyReply, data: { editToken: string }) {
  reply.header('ETag', `"${data.editToken}"`);
  return sendData(reply, 200, data);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('VALIDATION_FAILED', 422, '请求体必须是对象。');
  return value as Record<string, unknown>;
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
