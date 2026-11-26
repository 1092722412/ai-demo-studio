import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp } from '../dist-server/http.js';
import { initializeStore } from '../dist-server/store/repository.js';
import { injectHttp } from '../test-support/http-inject.mjs';

const capabilities = { purposes: ['discuss'], tools: false, structuredOutput: false, streamText: true, resume: false, cancel: false };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-credentials-'));
  const repository = await initializeStore(directory);
  const entries = new Map();
  const deleted = [];
  const fake = {
    async put(ref, value) { entries.set(ref, value); },
    async get(ref) { return entries.get(ref) ?? null; },
    async delete(ref) { entries.delete(ref); deleted.push(ref); },
  };
  let rejectedWrite = false;
  const proxied = new Proxy(repository, { get(target, key) {
    if (key === 'transaction') return (work) => target.transaction(() => work(proxied));
    if (key === 'saveConnection') return (record) => {
      if (rejectedWrite) throw new Error('合成保存失败');
      return target.saveConnection(record);
    };
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  let received = null;
  const app = createHttpApp({ repository: proxied, tasks: {}, credentialStorage: fake, connectionProbes: { api_key: {
    async probe(connection) {
      received = connection.credential;
      return { available: true, capabilities, detail: String(connection.credential) };
    },
  } } });
  t.after(async () => {
    await app.close();
    repository.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = (method, url, payload) => method === 'DELETE' && payload === undefined
    ? app.inject({ method, url, headers: { host: '127.0.0.1:17860', origin: 'http://127.0.0.1:17860' } })
    : injectHttp(app, { method, url, ...(payload === undefined ? {} : { payload }) });
  return { repository, directory, call, entries, deleted, received: () => received, rejectWrite: () => { rejectedWrite = true; } };
}

test('连接 HTTP 只公开凭据状态，probe 读取凭据且不回显', async (t) => {
  const { repository, directory, call, entries, deleted, received } = await fixture(t);
  const marker = randomUUID();
  const created = await call('POST', '/api/v1/connections', { name: '合成连接', kind: 'api_key', apiKey: marker });
  assert.equal(created.statusCode, 201);
  const { id, credentialConfigured } = created.json().data;
  assert.equal(credentialConfigured, true);
  const path = '/api/v1/connections/' + id;
  const ref = repository.getConnection(id).credentialRef;
  const probe = await call('POST', path + '/probe', {});
  assert.equal(probe.json().data.available, true);
  assert.equal(received() === marker, true);
  const listed = await call('GET', '/api/v1/connections');
  assert.equal(listed.json().data.find((item) => item.id === id).lastProbe.available, true);
  const project = await call('POST', '/api/v1/projects', { title: '合成项目', brief: '合成输入', connectionId: id });
  const projectId = project.json().data.id;
  const artifacts = await call('GET', '/api/v1/projects/' + projectId + '/artifacts');
  const config = await call('GET', '/api/v1/projects/' + projectId + '/settings');
  for (const response of [created, probe, listed, project, artifacts, config]) {
    assert.equal(response.body.includes(marker) || response.body.includes(ref), false);
  }
  const task = { id: 't-active', projectId, connectionId: id, kind: 'ai', purpose: 'discuss',
    state: 'running', phase: 'running', input: {}, requestId: 'synthetic', request: {}, createdAt: new Date().toISOString() };
  repository.saveTask(task);
  repository.appendEvent({ taskId: task.id, type: 'task.started', payload: { state: 'running' }, createdAt: task.createdAt });
  assert.equal((await call('PATCH', path, { apiKey: randomUUID() })).statusCode, 409);
  assert.equal((await call('DELETE', path + '/credential')).statusCode, 409);
  repository.transaction((tx) => {
    tx.saveTask({ ...task, state: 'succeeded' });
    tx.appendEvent({ taskId: task.id, type: 'task.succeeded', payload: {}, createdAt: task.createdAt });
  });
  assert.equal((await call('GET', '/api/v1/tasks/' + task.id + '/events')).body.includes(marker), false);
  for (const file of (await readdir(directory)).filter((name) => name.startsWith('studio.sqlite'))) {
    assert.equal((await readFile(join(directory, file))).includes(marker), false);
  }
  assert.equal((await call('PATCH', path, { apiKey: '' })).statusCode, 422);
  const changed = await call('PATCH', path, { apiKey: randomUUID() });
  assert.equal(changed.statusCode, 200);
  assert.equal(entries.has(ref), false);
  assert.equal(deleted.length, 1);
  assert.equal((await call('DELETE', path + '/credential')).statusCode, 204);
  assert.equal(entries.size, 0);
  assert.equal((await call('POST', path + '/probe', {})).statusCode, 401);
});

test('连接保存失败回收新凭据并保留原引用', async (t) => {
  const { repository, call, entries, deleted, rejectWrite } = await fixture(t);
  const first = randomUUID();
  const response = await call('POST', '/api/v1/connections', { name: '合成连接', kind: 'api_key', apiKey: first });
  const id = response.json().data.id;
  const previous = repository.getConnection(id).credentialRef;
  rejectWrite();
  const next = randomUUID();
  const failed = await call('PATCH', '/api/v1/connections/' + id, { apiKey: next });
  assert.equal(failed.statusCode, 503);
  assert.equal(failed.body.includes(next), false);
  assert.equal(entries.size, 1);
  assert.equal(entries.get(previous) === first, true);
  assert.equal(deleted.length, 1);
  assert.equal(repository.getConnection(id).credentialRef, previous);
});
