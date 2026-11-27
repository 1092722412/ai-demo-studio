import assert from 'node:assert/strict';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import test from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createArtifactService } from '../dist-server/artifacts.js';
import { createPreviewService } from '../dist-server/preview.js';
import { fixture, runningTask } from '../test-support/plan-fixture.mjs';

function generated(title) {
  return {
    'manifest.json': JSON.stringify({ title }),
    'page.html': '<main>合成预览</main>',
    'style.css': 'main { color: black; }',
    'app.js': 'document.title = "合成预览";',
    'seed/data.json': '{}',
    'seed/state.json': '{}',
    'server.mjs': 'throw new Error("不能执行 ZIP 内的服务端代码");',
  };
}

async function publish({ repository, id }, entries, partial = false) {
  const task = repository.listTasks(id)[0] ?? runningTask(repository, id, 't-preview');
  const bytes = zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)])));
  return createArtifactService(repository).publishArtifact(task.id, {
    kind: 'source', extension: '.zip', mime: 'application/zip', bytes, partial,
    metadata: { sourceKind: 'generated', adapterId: 'generated-local-node' },
  });
}

async function openPreview(request) {
  const response = await request('POST', '/preview', {});
  assert.equal(response.statusCode, 200, response.body);
  const { previewUrl } = response.json().data;
  assert.match(previewUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  return previewUrl;
}

test('并发打开同一源码共用健康预览，项目与方案保持原状', async (t) => {
  const setup = await fixture(t);
  const { app, repository, id, request } = setup;
  await publish(setup, generated('合成预览一'));
  repository.updateProject({ ...repository.getProject(id), stage: 'requirements' });
  const project = repository.getProject(id);
  const plan = repository.getPlan(id);
  const endpoint = '/api/v1/projects/' + id + '/preview';
  const inject = (origin) => app.inject({ method: 'POST', url: endpoint, headers: { host: '127.0.0.1:17860', origin } });
  assert.equal((await inject('http://127.0.0.1:17861')).statusCode, 403);
  const [url, repeated] = await Promise.all([openPreview(request), openPreview(request)]);
  assert.equal(url, repeated);
  const bodyless = await inject('http://127.0.0.1:17860');
  assert.equal(bodyless.statusCode, 200, bodyless.body);
  assert.equal(bodyless.json().data.previewUrl, url);
  assert.deepEqual(await (await fetch(url + '/api/health')).json(), { status: 'ok' });
  assert.match(await (await fetch(url)).text(), /<title>合成预览一<\/title>.*sandbox="allow-scripts allow-forms"/);
  assert.equal((await fetch(url + '/demo')).status, 403);
  const document = await fetch(url + '/demo', { headers: { 'sec-fetch-dest': 'iframe' } });
  assert.match(document.headers.get('content-security-policy'), /^sandbox allow-scripts allow-forms;/);
  assert.match(await document.text(), /合成预览/);
  assert.deepEqual(repository.getProject(id), project);
  assert.deepEqual(repository.getPlan(id), plan);
});

test('录制适配器复用当前预览，仅返回固定业务 iframe 与本项目的数据路径', async (t) => {
  const ctx = await fixture(t);
  const source = await publish(ctx, generated('合成录制入口'));
  const previews = createPreviewService(ctx.repository);
  try {
    const { previewUrl } = await previews.open(ctx.id);
    const target = await previews.recordingTarget(ctx.id, source.id);
    assert.equal(target.url, previewUrl + '/');
    assert.equal(target.framePath, '/demo');
    assert.ok(target.data.statePath.startsWith(join(ctx.root, 'projects', ctx.id, 'previews') + sep));
    assert.equal(await readFile(target.data.statePath, 'utf8'), '{}');
    assert.equal(await readFile(target.data.seedPath, 'utf8'), '{}');
    await assert.rejects(previews.recordingTarget(ctx.id, 'a-stale'), { code: 'PLAN_STALE' });
    assert.equal((await previews.open(ctx.id)).previewUrl, previewUrl);
  } finally {
    await previews.close();
  }
});

test('已登记的旧格式源码沿用固定录入页面与初始记录', async (t) => {
  const setup = await fixture(t);
  await publish(setup, {
    'spec.json': JSON.stringify({ title: '旧格式合成项目', fields: [] }),
    'seed/records.json': '[{"id":"record-1","values":{}}]',
    'index.html': '<script>throw new Error("应使用固定旧模板")</script>',
  });
  const url = await openPreview(setup.request);
  const page = await fetch(url);
  assert.match(page.headers.get('content-security-policy'), /^sandbox /);
  assert.match(await page.text(), /id="record-form"/);
  assert.equal((await (await fetch(url + '/api/spec')).json()).title, '旧格式合成项目');
  assert.deepEqual(await (await fetch(url + '/api/records')).json(), [{ id: 'record-1', values: {} }]);
  const saved = await fetch(url + '/api/records', {
    method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(saved.status, 201);
  await saved.json();
});

test('拒绝未发布、不可用、缺失和不受支持的当前源码', async (t) => {
  const setup = await fixture(t);
  const { repository, id, request } = setup;
  const rejected = async () => {
    const response = await request('POST', '/preview', {});
    assert.equal(response.statusCode, 422, response.body);
    assert.equal(response.json().error.code, 'SOURCE_CHECK_FAILED');
  };
  await rejected();
  await publish(setup, { 'app.js': 'void 0;' });
  await rejected();
  const partial = await publish(setup, generated('未完整发布的合成项目'), true);
  repository.updateProject({ ...repository.getProject(id), currentSourceId: partial.id });
  await rejected();
  const source = await publish(setup, generated('合成项目'));
  const other = (await setup.send('POST', '/api/v1/projects', { title: '另一个合成项目', brief: '核对成果归属' })).json().data;
  repository.updateProject({ ...repository.getProject(other.id), currentSourceId: source.id });
  const foreign = await setup.send('POST', '/api/v1/projects/' + other.id + '/preview', {});
  assert.equal(foreign.statusCode, 422, foreign.body);
  assert.equal(foreign.json().error.code, 'SOURCE_CHECK_FAILED');
  const url = await openPreview(request);
  await rm(repository.getArtifactPath(id, source.id).path);
  await rejected();
  await assert.rejects(fetch(url));
  assert.equal(repository.getProject(id).currentSourceId, source.id);
});

test('已打开的源码包被截断后回收旧预览', async (t) => {
  const setup = await fixture(t);
  const { repository, id, request } = setup;
  const source = await publish(setup, generated('将被截断的合成源码'));
  const url = await openPreview(request);
  await writeFile(repository.getArtifactPath(id, source.id).path, '截断');
  const response = await request('POST', '/preview', {});
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json().error.code, 'SOURCE_CHECK_FAILED');
  await assert.rejects(fetch(url));
});

test('固定模板启动失败时清理临时目录，随后可打开替换的源码', async (t) => {
  const setup = await fixture(t);
  const { repository, id, root, request } = setup;
  const source = await publish(setup, { ...generated('损坏的合成项目'), 'manifest.json': '{' });
  const response = await request('POST', '/preview', {});
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().error.code, 'PREVIEW_UNAVAILABLE');
  assert.deepEqual(await readdir(join(root, 'projects', id, 'previews')), []);
  assert.equal(repository.getProject(id).currentSourceId, source.id);
  await publish(setup, generated('替换后可打开'));
  await openPreview(request);
});

test('健康响应不合格时回收已监听的端口，同一源码可重试', async (t) => {
  const setup = await fixture(t);
  const { id, root, request } = setup;
  await publish(setup, generated('合成健康检查'));
  const realFetch = globalThis.fetch;
  let failedUrl;
  const health = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await realFetch(url, options);
    assert.equal(response.status, 200);
    await response.json();
    failedUrl = new URL(url).origin;
    return Response.json({ status: 'starting' });
  });
  const failed = await request('POST', '/preview', {});
  health.mock.restore();
  assert.equal(failed.statusCode, 503, failed.body);
  assert.ok(failedUrl);
  await assert.rejects(fetch(failedUrl));
  assert.deepEqual(await readdir(join(root, 'projects', id, 'previews')), []);
  await openPreview(request);
});

test('当前源码替换与 Fastify 关闭回收服务和临时数据，保留 ZIP', async (t) => {
  const setup = await fixture(t);
  const { app, repository, id, root, request } = setup;
  const previewDirectory = join(root, 'projects', id, 'previews');
  const old = await publish(setup, generated('旧合成预览'));
  const oldUrl = await openPreview(request);
  const oldPath = repository.getArtifactPath(id, old.id).path;
  const current = await publish(setup, generated('新合成预览'));
  const currentPath = repository.getArtifactPath(id, current.id).path;
  const url = await openPreview(request);
  assert.notEqual(url, oldUrl);
  assert.match(await (await fetch(url)).text(), /新合成预览/);
  await assert.rejects(fetch(oldUrl));
  assert.equal((await readdir(previewDirectory)).length, 1);
  await app.close();
  await assert.rejects(fetch(url));
  assert.deepEqual(await readdir(previewDirectory), []);
  assert.equal((await readFile(oldPath)).length, old.bytes);
  assert.equal((await readFile(currentPath)).length, current.bytes);
});

test('健康检查期间替换源码时拒绝返回旧地址并回收端口', async (t) => {
  const setup = await fixture(t);
  const { request } = setup;
  await publish(setup, generated('检测中的旧源码'));
  const realFetch = globalThis.fetch;
  const probing = Promise.withResolvers();
  const resume = Promise.withResolvers();
  const health = t.mock.method(globalThis, 'fetch', async (url, options) => {
    probing.resolve(new URL(url).origin);
    await resume.promise;
    return realFetch(url, options);
  });
  const opening = request('POST', '/preview', {});
  const oldUrl = await Promise.race([probing.promise, opening.then((response) => {
    assert.fail('预览未进入健康检查：' + response.body);
  })]);
  try {
    await publish(setup, generated('可打开的新源码'));
  } finally {
    resume.resolve();
  }
  const stale = await opening;
  health.mock.restore();
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().error.code, 'RESOURCE_BUSY');
  await assert.rejects(fetch(oldUrl));
  const current = await openPreview(request);
  assert.match(await (await fetch(current)).text(), /可打开的新源码/);
});

test('工作台关闭时同时终止活动事件流和预览', async (t) => {
  const setup = await fixture(t);
  const { app, request } = setup;
  const source = await publish(setup, generated('工作台关闭时的合成预览'));
  const previewUrl = await openPreview(request);
  const studioUrl = await app.listen({ host: '127.0.0.1', port: 0 });
  const stream = await fetch(studioUrl + '/api/v1/tasks/' + source.taskId + '/events', {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(stream.status, 200);
  await app.close();
  await stream.text();
  await assert.rejects(fetch(previewUrl));
});
