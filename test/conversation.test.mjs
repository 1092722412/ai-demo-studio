import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHttpApp } from '../dist-server/http.js';
import { injectHttp } from '../test-support/http-inject.mjs';
import { initializeStore } from '../dist-server/store/repository.js';
import { TaskService } from '../dist-server/tasks.js';

test('项目多轮对话复用产品 conversationId，不向客户端暴露 Agent 线程或版本字段', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'demo-studio-chat-'));
  let repository;
  try {
    repository = await initializeStore(dataRoot);
    const inputs = [];
    const adapter = {
      probe: async () => ({ available: true, capabilities: { purposes: ['discuss'] }, detail: 'fake' }),
      execute: async (input) => {
        inputs.push(input);
        return { reply: `已收到第 ${inputs.length} 轮。`, nativeSessionRef: `native-${inputs.length}`, delivery: null };
      },
    };
    const tasks = new TaskService({
      adapter,
      createRuntime: () => ({
        connection: { id: 'codex-local', kind: 'codex', provider: 'codex', model: 'test' },
        projectRoot: dataRoot,
        tools: { call: async () => ({ ok: false }) },
      }),
    });
    const app = createHttpApp({ repository, tasks });
    const projectResponse = await injectHttp(app, { method: 'POST', url: '/api/v1/projects', payload: { title: '对话项目', brief: '先讨论预约流程。' } });
    const project = projectResponse.json().data;
    const firstResponse = await injectHttp(app, { method: 'POST', url: `/api/v1/projects/${project.id}/messages`, payload: {
      requestId: 'round-1', purpose: 'discuss', text: '整理初始流程。',
    } });
    const first = firstResponse.json().data;
    await tasks.wait(first.taskId);
    await waitFor(() => repository.getTask(first.taskId)?.state === 'succeeded');

    const secondResponse = await injectHttp(app, { method: 'POST', url: `/api/v1/projects/${project.id}/messages`, payload: {
      requestId: 'round-2', conversationId: first.conversationId, purpose: 'discuss', text: '补充异常处理。',
    } });
    const second = secondResponse.json().data;
    assert.equal(second.conversationId, first.conversationId);
    await tasks.wait(second.taskId);
    await waitFor(() => repository.getTask(second.taskId)?.state === 'succeeded');

    const messages = repository.listMessages(first.conversationId);
    assert.deepEqual(messages.filter((item) => item.role === 'assistant').map((item) => item.text), ['已收到第 1 轮。', '已收到第 2 轮。']);
    assert.equal(inputs[1].nativeSessionRef, 'native-1');
    assert.equal('threadId' in project, false);
    assert.equal('version' in project, false);
    assert.equal('threadId' in second, false);
  } finally {
    repository?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

async function waitFor(predicate) {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true);
}
