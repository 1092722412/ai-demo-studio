import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createArtifactService } from '../dist-server/artifacts.js';
import { createHttpApp } from '../dist-server/http.js';
import { createStudio } from '../server/studio.mjs';
import { injectHttp } from '../test-support/http-inject.mjs';
import { fixture, makePlan, runningTask, sourceZip, waitForTask } from '../test-support/plan-fixture.mjs';

const worker = fileURLToPath(new URL('../test-support/fake-desktop-worker.mjs', import.meta.url));

async function prepareProject(ctx, id = ctx.id) {
  const request = (method, path, body, headers) => ctx.send(method, '/api/v1/projects/' + id + path, body, headers);
  const task = runningTask(ctx.repository, id, 'source-' + id);
  await createArtifactService(ctx.repository).publishArtifact(task.id, {
    kind: 'source', extension: '.zip', mime: 'application/zip', bytes: sourceZip(),
    metadata: { sourceKind: 'imported', adapterId: 'synthetic' },
  });
  ctx.repository.saveTask({ ...task, state: 'succeeded' });
  await setVoice(request, 'zh-CN-YunxiNeural');
  const plan = await request('GET', '/plan');
  const saved = await request('PUT', '/plan', { draft: makePlan(id) }, { 'if-match': plan.headers.etag });
  assert.equal(saved.statusCode, 200, saved.body);
  const accepted = await request('POST', '/scripts', { requestId: 'script' });
  assert.equal(accepted.statusCode, 202, accepted.body);
  const script = await waitForTask(ctx.send, accepted.json().data.taskId);
  assert.equal(script.state, 'succeeded');
  return { request, body: { requestId: 'record', planToken: saved.json().data.editToken, scriptArtifactId: script.result.artifactId } };
}

async function setVoice(request, voice) {
  const settings = await request('GET', '/settings');
  assert.equal((await request('PUT', '/settings', { values: { tts: { voice } } },
    { 'if-match': settings.headers.etag })).statusCode, 200);
}

async function setup(t, { mode = 'success', audio, probe, timings } = {}) {
  const trace = [];
  let ctx;
  const options = {
    spawnSpec: () => {
      trace.push('worker');
      return { command: process.execPath, args: [worker, mode, join(ctx.root, 'worker.log')] };
    },
    resolveTarget: async () => ({ url: 'http://127.0.0.1:12345/', framePath: null }),
    prepareSpeech: async ({ outputPath, text, signal }) => {
      trace.push('speech');
      await audio?.(signal);
      await writeFile(outputPath, 'synthetic audio');
      return { durationMs: 500, cues: [{ startMs: 0, endMs: 500, text }] };
    },
    probeCapture: probe ?? (async () => ({ durationMs: 950, widthPx: 1920, heightPx: 1080 })),
    timings,
  };
  ctx = await fixture(t, undefined, undefined, options);
  return { ...ctx, ...await prepareProject(ctx), trace };
}

async function start(ctx) {
  const accepted = await ctx.request('POST', '/recordings', ctx.body);
  assert.equal(accepted.statusCode, 202, accepted.body);
  return accepted.json().data.taskId;
}

async function until(assertion) {
  for (let i = 0; i < 200; i++) {
    if (await assertion()) return;
    await delay(10);
  }
  assert.fail('等待合成录制状态超时');
}

test('录制拒绝缺音色、过期方案、不匹配脚本和非工作台来源', async (t) => {
  const ctx = await setup(t);
  const begin = (body, headers) => ctx.request('POST', '/recordings', body, headers);
  assert.equal((await begin(ctx.body, { origin: 'http://127.0.0.1:1' })).statusCode, 403);
  assert.equal((await begin({ ...ctx.body, planToken: 'stale' })).json().error.code, 'PLAN_STALE');
  assert.equal((await begin({ ...ctx.body, scriptArtifactId: 'a-missing' })).json().error.code, 'SCRIPT_STALE');
  await setVoice(ctx.request, null);
  const missing = await begin(ctx.body);
  assert.equal(missing.statusCode, 422, missing.body);
  assert.equal(missing.json().error.field, 'tts.voice');
  assert.deepEqual(ctx.trace, []);
});

test('语音先于 Worker，发布真实步骤、可读取的原片和完整采集清单，重试复用任务', async (t) => {
  const ctx = await setup(t);
  assert.deepEqual(ctx.trace, []);
  const taskId = await start(ctx);
  assert.equal(await start(ctx), taskId);
  const conflict = await ctx.request('POST', '/recordings', { ...ctx.body, planToken: 'other' });
  assert.equal(conflict.json().error.code, 'REQUEST_CONFLICT');
  const done = await waitForTask(ctx.send, taskId);
  assert.equal(done.state, 'succeeded', JSON.stringify(done));
  assert.deepEqual(ctx.trace, ['speech', 'worker']);
  const { rawArtifactId, captureArtifactId } = done.result;
  assert.equal(ctx.repository.getProject(ctx.id).stage, 'media');
  assert.equal(ctx.repository.listTasks(ctx.id).filter(({ kind }) => kind === 'render').length, 0);
  const manifestFile = await ctx.send('GET', '/api/v1/artifacts/' + captureArtifactId + '/content?projectId=' + ctx.id);
  const manifest = manifestFile.json();
  assert.equal(manifest.complete, true);
  assert.equal(manifest.rawArtifactId, rawArtifactId);
  assert.equal(manifest.plan.profile.tts.voice, 'zh-CN-YunxiNeural');
  assert.deepEqual(manifest.events.map(({ anchor, atMs }) => [anchor, atMs]), [['start', 10], ['verified', 100], ['end', 800]]);
  assert.equal(manifest.checks[0].actual, '测试值');
  assert.equal(manifest.audio[0].durationMs, 500);
  assert.equal(manifest.events[0].rects[0].target, 'result');
  assert.equal((await ctx.send('GET', '/api/v1/artifacts/' + rawArtifactId + '/content?projectId=' + ctx.id)).statusCode, 200);
  assert.ok(ctx.repository.listEvents(taskId).some(({ type }) => type === 'step.verified'));
});

test('桌面互斥跨项目，已占用时仍先合成语音；取消确认后仅可下载部分原片', async (t) => {
  const ctx = await setup(t, { mode: 'wait' });
  const first = await start(ctx);
  await until(() => ctx.repository.listEvents(first).some(({ type }) => type === 'step.started'));
  const other = await ctx.send('POST', '/api/v1/projects', { title: '另一合成项目', brief: '桌面互斥测试' });
  const second = await prepareProject(ctx, other.json().data.id);
  const busy = await waitForTask(ctx.send, await start(second));
  assert.equal(busy.error.code, 'RESOURCE_BUSY');
  assert.deepEqual(ctx.trace, ['speech', 'worker', 'speech']);
  const cancel = () => ctx.send('POST', '/api/v1/tasks/' + first + '/cancel', { reason: 'test' });
  assert.equal((await cancel()).statusCode, 202);
  const done = await waitForTask(ctx.send, first);
  assert.equal(done.state, 'cancelled');
  assert.equal((await cancel()).statusCode, 200);
  assert.equal(await readFile(join(ctx.root, 'worker.log'), 'utf8'), 'prepare\nstart\ncancel\n');
  assert.ok(!ctx.repository.listEvents(first).some(({ type }) => type === 'step.finished'));
  await assertPartial(ctx, first);
});

test('准备期间取消，Worker 收尾且从未收到 start', async (t) => {
  const ctx = await setup(t, { mode: 'prepare-wait' });
  const taskId = await start(ctx);
  await until(async () => (await readFile(join(ctx.root, 'worker.log'), 'utf8').catch(() => '')).includes('prepare'));
  await ctx.send('POST', '/api/v1/tasks/' + taskId + '/cancel', { reason: 'test' });
  assert.equal((await waitForTask(ctx.send, taskId)).state, 'cancelled');
  assert.equal(await readFile(join(ctx.root, 'worker.log'), 'utf8'), 'prepare\ncancel\n');
});

test('语音失败时未启动 Worker 或占用桌面', async (t) => {
  const ctx = await setup(t, { audio: () => { throw new Error('offline'); } });
  const task = await waitForTask(ctx.send, await start(ctx));
  assert.equal(task.error.code, 'RENDER_FAILED');
  assert.deepEqual(ctx.trace, ['speech']);
});

test('语音准备期间停止会取消合成且不启动 Worker', async (t) => {
  const ctx = await setup(t, { audio: (signal) => delay(5000, undefined, { signal }) });
  const taskId = await start(ctx);
  await until(() => ctx.trace.includes('speech'));
  const response = await ctx.send('POST', '/api/v1/tasks/' + taskId + '/cancel', { reason: 'test' });
  assert.equal(response.statusCode, 202);
  assert.equal((await waitForTask(ctx.send, taskId)).state, 'cancelled');
  assert.deepEqual(ctx.trace, ['speech']);
});

test('Worker 心跳丢失后要求收尾，任务中断且部分原片不可播放', async (t) => {
  const ctx = await setup(t, { mode: 'lost', timings: { pingMs: 20, timeoutMs: 400, stopMs: 500 } });
  const taskId = await start(ctx);
  const done = await waitForTask(ctx.send, taskId);
  assert.equal(done.state, 'interrupted', JSON.stringify(done));
  assert.equal(done.error.code, 'WORKER_TIMEOUT');
  assert.equal(await readFile(join(ctx.root, 'worker.log'), 'utf8'), 'prepare\nstart\ncancel\n');
  await assertPartial(ctx, taskId);
});

test('启动恢复等待旧 Worker 退出，只收尾部分文件且重复请求不续点', async (t) => {
  const ctx = await setup(t);
  const taskId = 't-recovery';
  const rawArtifactId = 'a-recovery-raw';
  const captureArtifactId = 'a-recovery-manifest';
  const project = ctx.repository.getProject(ctx.id);
  const createdAt = new Date().toISOString();
  const runtime = { pid: 1234, role: 'desktop', createdAt };
  ctx.repository.updateProject({ ...project, stage: 'recording' });
  ctx.repository.saveTask({ id: taskId, projectId: ctx.id, kind: 'record', state: 'running', phase: 'capture', createdAt,
    requestId: taskId, runtime, request: { operation: 'record', ...ctx.body, requestId: taskId },
    input: { plan: makePlan(ctx.id), scriptArtifactId: ctx.body.scriptArtifactId, rawArtifactId, captureArtifactId,
      manifest: { sourceArtifactId: project.currentSourceId } } });
  const output = 'capture/' + rawArtifactId + '.mp4';
  for (const [id, kind, relativePath, mime, metadata] of [
    [rawArtifactId, 'capture', output, 'video/mp4', {}],
    [captureArtifactId, 'media', 'media/' + captureArtifactId + '.json', 'application/json', { subtype: 'capture_manifest' }],
  ]) ctx.repository.registerArtifact({ id, kind, projectId: ctx.id, taskId, relativePath, mime, metadata,
    state: 'pending', bytes: 0, createdAt });
  await writeFile(ctx.repository.getNewArtifactPath(ctx.id, output) + '.partial', 'old partial');
  await ctx.app.close();
  let alive = true;
  const app = createHttpApp({ repository: ctx.repository, tasks: ctx.tasks, recordingOptions: {
    workerAlive(pid, owner) {
      assert.equal(pid, runtime.pid);
      assert.equal(owner, taskId);
      return alive;
    },
    spawnSpec() { assert.fail('恢复不应启动 Worker'); },
  } });
  try {
    const send = (method, url, payload) => injectHttp(app, { method, url, payload });
    const post = (body) => send('POST', '/api/v1/projects/' + ctx.id + '/recordings', body);
    assert.equal((await post(ctx.body)).statusCode, 409);
    assert.equal(ctx.repository.getTask(taskId).state, 'running');
    assert.equal(ctx.repository.getArtifact(rawArtifactId).state, 'pending');
    alive = false;
    assert.equal((await waitForTask(send, taskId)).state, 'interrupted');
    assert.equal(ctx.repository.getProject(ctx.id).stage, 'plan');
    assert.equal((await post({ ...ctx.body, requestId: taskId })).json().data.taskId, taskId);
    assert.equal(ctx.repository.listTasks(ctx.id).filter(({ kind }) => kind === 'record' || kind === 'render').length, 1);
    await assertPartial({ ...ctx, send }, taskId);
  } finally {
    await app.close();
  }
});

test('同一数据根只能有一个工作台实例，关闭后可重启', async (t) => {
  const ctx = await fixture(t);
  const adapter = { execute() { assert.fail('数据根检查不应启动 AI'); } };
  const start = () => createStudio({ dataRoot: ctx.root, adapter });
  const first = await start();
  try {
    await assert.rejects(start, { code: 'STUDIO_BUSY' });
  } finally {
    await first.close();
  }
  await (await start()).close();
});

for (const type of ['probe', 'wrong-result']) {
  test('无效采集不能发布完整成果 · ' + type, async (t) => {
    const ctx = await setup(t, type === 'probe' ? { probe: async () => { throw new Error('invalid video'); } } : { mode: type });
    const taskId = await start(ctx);
    const done = await waitForTask(ctx.send, taskId);
    assert.equal(done.state, 'failed');
    if (type === 'wrong-result') {
      assert.equal(done.error.code, 'STEP_FAILED');
      assert.equal(done.error.field, '/steps/0');
      assert.equal(done.error.checks[0].actual, '坏值');
    }
    await assertPartial(ctx, taskId);
  });
}

async function assertPartial(ctx, taskId) {
  const raw = ctx.repository.listArtifacts(ctx.id, 'capture').find((artifact) => artifact.taskId === taskId);
  assert.equal(raw.state, 'partial');
  assert.match(raw.relativePath, /\.partial$/);
  const path = '/api/v1/artifacts/' + raw.id + '/content?projectId=' + ctx.id;
  assert.equal((await ctx.send('GET', path)).statusCode, 404);
  assert.equal((await ctx.send('GET', path + '&download=1')).statusCode, 200);
  const capture = ctx.repository.listArtifacts(ctx.id, 'media').find((artifact) =>
    artifact.taskId === taskId && artifact.metadata.subtype === 'capture_manifest');
  assert.equal(capture.state, 'partial');
  assert.equal(JSON.parse(await readFile(ctx.repository.getArtifactPath(ctx.id, capture.id).path, 'utf8')).complete, false);
  assert.equal(ctx.repository.listTasks(ctx.id).filter(({ kind }) => kind === 'render').length, 0);
}
