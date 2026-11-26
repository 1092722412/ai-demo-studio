import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHttpApp } from '../dist-server/http.js';
import { injectHttp } from '../test-support/http-inject.mjs';
import { initializeStore } from '../dist-server/store/repository.js';
import { TaskService } from '../dist-server/tasks.js';

const defaultConnection = { id: 'codex-local', kind: 'codex', provider: 'codex', model: 'test' };
const result = { reply: '已收到需求。', nativeSessionRef: 'thread-fake', delivery: null };

async function withApp(run, execute = async () => result) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ai-demo-http-'));
  let repository;
  try {
    repository = await initializeStore(dataRoot);
    const tasks = new TaskService({
      adapter: {
        probe: async () => ({ available: true, capabilities: { purposes: ['discuss'] }, detail: 'fake' }),
        execute,
      },
      createRuntime: () => ({
        connection: defaultConnection,
        projectRoot: dataRoot,
        tools: { call: async () => ({ ok: false }) },
      }),
      onEvent: (taskId, event) => repository.appendEvent({
        taskId, type: event.type, payload: event, createdAt: new Date().toISOString(),
      }),
    });
    const app = createHttpApp({ repository, tasks, adapters: { defaultConnection } });
    await run({ app, repository, tasks, dataRoot });
  } finally {
    repository?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function post(url, payload) {
  return { method: 'POST', url, payload };
}

async function createProject(app, title = 'HTTP 测试项目') {
  const response = await injectHttp(app, post('/api/v1/projects', { title, brief: '合成需求内容' }));
  assert.equal(response.statusCode, 201);
  return response.json().data;
}

test('Host and Origin checks reject non-local requests', async () => withApp(async ({ app }) => {
  const badHost = await injectHttp(app, {
    method: 'GET', url: '/api/v1/projects', headers: { host: 'attacker.example' },
  });
  assert.equal(badHost.statusCode, 403);

  const badOrigin = await injectHttp(app, {
    method: 'POST', url: '/api/v1/projects', headers: { origin: 'https://attacker.example' },
    payload: { title: '外部来源', brief: '拒绝跨来源写入请求' },
  });
  assert.equal(badOrigin.statusCode, 403);
}));

test('Fastify enforces the 1 MiB JSON body limit', async () => withApp(async ({ app }) => {
  const response = await injectHttp(app, post('/api/v1/projects', {
    title: 'oversized', brief: 'x'.repeat(1_048_600),
  }));
  assert.equal(response.statusCode, 413);
  assert.equal(response.json().error.code, 'VALIDATION_FAILED');
}));

async function waitFor(predicate) {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, '状态在限定时间内没有完成');
}

test('消息重复提交复用同一任务；相同 requestId 的不同载荷返回冲突', async () => withApp(async ({ app, repository, tasks }) => {
  const project = await createProject(app);
  const message = { requestId: 'click-1', purpose: 'discuss', text: '请先梳理业务流程。' };
  const first = await injectHttp(app, post(`/api/v1/projects/${project.id}/messages`, message));
  assert.equal(first.statusCode, 202);
  const accepted = first.json().data;

  const repeated = await injectHttp(app, post(`/api/v1/projects/${project.id}/messages`, { ...message }));
  assert.equal(repeated.statusCode, 202);
  assert.equal(repeated.json().data.taskId, accepted.taskId);

  const conflict = await injectHttp(app, post(`/api/v1/projects/${project.id}/messages`, { ...message, text: '改成另一段内容。' }));
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'REQUEST_CONFLICT');

  await tasks.wait(accepted.taskId);
  await waitFor(() => repository.getTask(accepted.taskId)?.state === 'succeeded');
  const messages = repository.listMessages(accepted.conversationId);
  assert.equal(messages.filter((item) => item.role === 'user').length, 1);
  assert.equal(messages.filter((item) => item.role === 'assistant').length, 1);
}));

test('项目文件读取按项目 ID 限定；另一项目的成果返回 404', async () => withApp(async ({ app, repository, dataRoot }) => {
  const first = await createProject(app, '项目甲');
  const second = await createProject(app, '项目乙');
  const relativePath = 'source/readme.txt';
  const filePath = join(dataRoot, 'projects', second.id, ...relativePath.split('/'));
  await mkdir(join(dataRoot, 'projects', second.id, 'source'), { recursive: true });
  await writeFile(filePath, '乙项目私有内容', 'utf8');
  repository.registerArtifact({
    id: 'a-private', projectId: second.id, taskId: null, kind: 'source', relativePath,
    mime: 'text/plain; charset=utf-8', bytes: 0, state: 'available', metadata: {}, createdAt: new Date().toISOString(),
  });

  const missingScope = await injectHttp(app, { method: 'GET', url: '/api/v1/artifacts/a-private/content' });
  assert.equal(missingScope.statusCode, 422);
  assert.equal(missingScope.json().error.field, 'projectId');

  const denied = await injectHttp(app, { method: 'GET', url: `/api/v1/artifacts/a-private/content?projectId=${first.id}` });
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.json().error.code, 'VALIDATION_FAILED');

  const allowed = await injectHttp(app, { method: 'GET', url: `/api/v1/artifacts/a-private/content?projectId=${second.id}` });
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body, '乙项目私有内容');
  assert.equal(await readFile(filePath, 'utf8'), '乙项目私有内容');
}));
