import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHttpApp } from '../dist-server/http.js';
import { injectHttp } from '../test-support/http-inject.mjs';
import { initializeStore } from '../dist-server/store/repository.js';
import { TaskService } from '../dist-server/tasks.js';

const defaultConnection = { id: 'codex-local', kind: 'codex', provider: 'codex', model: 'test' };
const result = { reply: '已完成。', nativeSessionRef: 'thread-fake', delivery: null };

async function withStore(run, execute = async () => result) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ai-demo-events-'));
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
      onEvent: (taskId, event) => {
        const stored = repository.getTask(taskId);
        const payload = event.type === 'permission.requested' ? {
          requestId: event.requestId, description: event.description, options: event.options, questions: event.questions ?? [],
        } : event;
        repository.transaction((tx) => {
          if (event.type === 'permission.requested' && stored) {
            tx.saveTask({ ...stored, state: 'waiting_input', phase: 'waiting_input', waitingInput: payload });
          }
          tx.appendEvent({
            taskId,
            type: event.type === 'permission.requested' ? 'input.required' : event.type,
            payload,
            createdAt: new Date().toISOString(),
          });
        });
      },
    });
    const app = createHttpApp({ repository, tasks, adapters: { defaultConnection } });
    await run({ app, repository, tasks, dataRoot });
  } finally {
    repository?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function project() {
  const now = new Date().toISOString();
  return {
    id: 'p-events', title: '事件测试', brief: '合成内容', stage: 'requirements', connectionId: null,
    currentSourceId: null, currentVideoId: null, createdAt: now, updatedAt: now,
  };
}

function task(id = 't-events', state = 'running') {
  const now = new Date().toISOString();
  return {
    id, projectId: 'p-events', conversationId: null, connectionId: null, kind: 'ai', purpose: 'discuss',
    state, phase: state, input: {}, runtime: null, result: null, error: null, waitingInput: null,
    requestId: id, request: { id }, createdAt: now, startedAt: now, endedAt: null,
  };
}

function append(repository, taskId, type, payload = {}) {
  return repository.appendEvent({ taskId, type, payload, createdAt: new Date().toISOString() });
}

function post(url, payload) {
  return { method: 'POST', url, payload };
}

async function waitFor(predicate) {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, '状态在限定时间内没有完成');
}

test('SSE 游标在回放期间补到新事件，断线重连只收到后续 seq', async () => withStore(async ({ app, repository }) => {
  repository.saveProject(project());
  repository.saveTask(task());
  append(repository, 't-events', 'task.started', { state: 'running' });

  const firstConnection = new AbortController();
  const stream = app.subscribe('t-events', 0, firstConnection.signal, 5);
  const first = await stream.next();
  assert.equal(first.value.seq, 1);
  append(repository, 't-events', 'message.delta', { text: '新到的内容' });
  const duringReplay = await stream.next();
  assert.equal(duringReplay.value.seq, 2);
  assert.equal(duringReplay.value.payload.text, '新到的内容');
  firstConnection.abort();
  await stream.next();

  append(repository, 't-events', 'tool.started', { callId: 'call-1' });
  append(repository, 't-events', 'task.succeeded', { messageId: 'm-final' });
  repository.saveTask({ ...task('t-events', 'succeeded'), endedAt: new Date().toISOString() });
  const reconnected = app.subscribe('t-events', 2, new AbortController().signal, 5);
  const third = await reconnected.next();
  const terminal = await reconnected.next();
  const end = await reconnected.next();
  assert.deepEqual([third.value.seq, terminal.value.seq], [3, 4]);
  assert.equal(terminal.value.type, 'task.succeeded');
  assert.equal(end.done, true);
}));

test('终态取消返回 200 且重复取消不改变终态', async () => withStore(async ({ app, repository, tasks }) => {
  repository.saveProject(project());
  const accepted = await injectHttp(app, post('/api/v1/projects/p-events/messages', {
    requestId: 'cancel-request', purpose: 'discuss', text: '等待取消',
  }));
  assert.equal(accepted.statusCode, 202);
  const taskId = accepted.json().data.taskId;
  const startedBy = Date.now() + 1_000;
  while (tasks.get(taskId).state !== 'running' && Date.now() < startedBy) await new Promise((resolve) => setTimeout(resolve, 5));

  const first = await injectHttp(app, post(`/api/v1/tasks/${taskId}/cancel`, {}));
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().data.state, 'cancelling');
  await tasks.wait(taskId);
  await waitFor(() => repository.getTask(taskId)?.state === 'cancelled');

  const repeated = await injectHttp(app, post(`/api/v1/tasks/${taskId}/cancel`, {}));
  assert.equal(repeated.statusCode, 200);
  assert.equal(repeated.json().data.state, 'cancelled');
}, async (_input, runtime) => new Promise((_resolve, reject) => {
  runtime.signal.addEventListener('abort', () => reject(Object.assign(new Error('已停止。'), { code: 'TASK_CANCELLED' })), { once: true });
})));

test('waiting_input 通过任务接口提交选择，重复回答冲突', async () => withStore(async ({ app, repository, tasks }) => {
  repository.saveProject(project());
  const accepted = await injectHttp(app, post('/api/v1/projects/p-events/messages', {
    requestId: 'input-request', purpose: 'discuss', text: '等待人工选择',
  }));
  assert.equal(accepted.statusCode, 202);
  const { taskId } = accepted.json().data;
  await waitFor(() => repository.getTask(taskId)?.state === 'waiting_input' && tasks.get(taskId).state === 'waiting_input');

  const response = await injectHttp(app, post(`/api/v1/tasks/${taskId}/input`, { requestId: 'rpc-approval-1', choice: 'accept' }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().data.state, 'running');
  await tasks.wait(taskId);
  await waitFor(() => repository.getTask(taskId)?.state === 'succeeded');

  const repeated = await injectHttp(app, post(`/api/v1/tasks/${taskId}/input`, { requestId: 'rpc-approval-1', choice: 'accept' }));
  assert.equal(repeated.statusCode, 409);
}, async (_input, runtime) => {
  const request = { type: 'permission.requested', requestId: 'rpc-approval-1', description: '确认本轮操作。', options: ['accept', 'decline'] };
  await runtime.emit(request);
  const answer = await runtime.awaitPermission(request);
  assert.deepEqual(answer, { decision: 'accept' });
  return result;
}));

test('Fastify SSE route replays events after Last-Event-ID', async () => withStore(async ({ app, repository }) => {
  repository.saveProject(project());
  repository.saveTask({ ...task('t-events', 'succeeded'), endedAt: new Date().toISOString() });
  append(repository, 't-events', 'task.started', { state: 'running' });
  append(repository, 't-events', 'task.succeeded', { messageId: 'm-final' });

  const response = await injectHttp(app, {
    method: 'GET',
    url: '/api/v1/tasks/t-events/events?afterSeq=0',
    headers: { 'last-event-id': '1' },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream/);
  assert.match(response.body, /id: 2\nevent: task\.succeeded/);
  assert.doesNotMatch(response.body, /id: 1\nevent:/);
}));