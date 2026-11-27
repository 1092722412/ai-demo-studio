import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { createHttpApp } from '../dist-server/http.js';
import { initializeStore } from '../dist-server/store/repository.js';
import { resolveProfile } from '../dist-server/settings.js';
import { TaskService } from '../dist-server/tasks.js';
import { injectHttp } from './http-inject.mjs';

export function makePlan(projectId = 'p-synthetic') {
  return {
    schemaVersion: '0.3', projectId,
    source: { kind: 'imported', adapterId: 'synthetic', entryFragment: '#workspace' },
    features: [{ id: 'readback', title: '核对测试值', sourceRef: 'app.js#readback', outcome: '显示测试值' }],
    elements: [{ id: 'result', by: 'id', value: 'result' }],
    data: { mode: 'projectData', resetStrategy: 'keep', preparation: '保留测试数据', initial: '测试页面已打开' },
    profile: resolveProfile({}, { tts: { voice: 'zh-CN-YunxiNeural' } }),
    steps: [{ id: 'read', featureId: 'readback', actions: [{ op: 'observe', target: 'result' }],
      checks: [{ op: 'contains', target: 'result', expected: '测试值' }], holdMs: 500, timeoutMs: 1000 }],
    narration: [{ id: 'line', stepId: 'read', anchor: 'verified', text: '当前显示测试值。' }],
    layers: [{ id: 'desktop', type: 'desktop', z: 0 }, { id: 'voice', type: 'voice', z: 0 },
      { id: 'captions', type: 'captions', z: 1 }],
  };
}

export async function fixture(t, execute = async () => ({ reply: '已给出草稿。', delivery: null }), speechRenderer, recordingOptions) {
  const root = await mkdtemp(join(tmpdir(), 'studio-item5-'));
  const repository = await initializeStore(root);
  const connection = { id: 'codex-local', kind: 'codex', provider: 'codex', model: 'fake' };
  const tasks = new TaskService({
    adapter: { execute, probe: async () => ({ available: true, capabilities: { purposes: ['plan'] } }) },
    createRuntime: () => ({ connection, projectRoot: root, tools: { call: async () => ({ ok: false }) } }),
  });
  const app = createHttpApp({ repository, tasks, speechRenderer, recordingOptions });
  t.after(async () => { await app.close(); repository.close(); await rm(root, { recursive: true, force: true }); });
  const send = (method, url, payload, headers) => injectHttp(app, { method, url, payload, headers });
  const response = await send('POST', '/api/v1/projects', { title: '合成项目', brief: '独立工程测试' });
  const { id } = response.json().data;
  const prefix = '/api/v1/projects/' + id;
  const request = (method, path, payload, headers) => send(method, prefix + path, payload, headers);
  return { app, tasks, repository, id, request, send, root };
}

export function runningTask(repository, projectId, id, kind = 'build') {
  return repository.saveTask({ id, projectId, kind, state: 'running', phase: 'test',
    input: {}, request: {}, requestId: id, createdAt: new Date().toISOString() });
}

export function sourceZip(extra = {}) {
  return zipSync({ 'app.js': strToU8('const readback = true;'), ...extra });
}

export async function waitForTask(send, taskId) {
  for (let i = 0; i < 200; i++) {
    const task = (await send('GET', '/api/v1/tasks/' + taskId)).json().data;
    if (task?.endedAt) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('任务未结束');
}
