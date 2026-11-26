import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStudio } from '../server/studio.mjs';
import { injectHttp } from '../test-support/http-inject.mjs';

test('工作台入口使用 SQLite 与新 API，不注册旧 /api/jobs 路由', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'demo-studio-entry-'));
  const adapter = {
    probe: async () => ({ available: true, capabilities: { purposes: ['discuss'] }, detail: 'fake' }),
    execute: async () => ({ reply: '需求已收到。', nativeSessionRef: 'native-entry', delivery: null }),
  };
  const studio = await createStudio({ dataRoot, adapter });
  try {
    const projectResponse = await injectHttp(studio.app, { method: 'POST', url: '/api/v1/projects', payload: {
      title: '入口项目', brief: '需要讨论的合成需求。',
    } });
    assert.equal(projectResponse.statusCode, 201);
    const project = projectResponse.json().data;
    const oldRoute = await injectHttp(studio.app, { method: 'GET', url: '/api/jobs' });
    assert.equal(oldRoute.statusCode, 404);

    const messageResponse = await injectHttp(studio.app, { method: 'POST', url: `/api/v1/projects/${project.id}/messages`, payload: {
      requestId: 'entry-request', purpose: 'discuss', text: '请整理要确认的问题。',
    } });
    assert.equal(messageResponse.statusCode, 202);
    const { taskId } = messageResponse.json().data;
    await studio.tasks.wait(taskId);
    await waitFor(() => studio.repository.getTask(taskId)?.state === 'succeeded');
    const messages = studio.repository.listMessages(messageResponse.json().data.conversationId);
    assert.equal(messages.at(-1).text, '需求已收到。');
    assert.equal(studio.repository.getProject(project.id).stage, 'requirements');
  } finally {
    await studio.close();
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
