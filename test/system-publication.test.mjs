import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import { createCodexAppServerAdapter } from '../dist-server/ai/codex-app-server.js';
import { createArtifactService } from '../dist-server/artifacts.js';
import { buildSystemSource } from '../dist-server/system-source.js';
import { createStudio } from '../server/studio.mjs';
import { injectHttp } from '../test-support/http-inject.mjs';
import { makePlan, runningTask, sourceZip, waitForTask } from '../test-support/plan-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fakeServer = fileURLToPath(new URL('../test-support/fake-codex-app-server.mjs', import.meta.url));
const skill = await readFile(join(root, '.agents/skills/bid-demo-system/SKILL.md'), 'utf8');
const generated = {
  title: '合成系统', body: '<main id="workspace"><p id="result">测试值</p></main>',
  css: 'main { display: block }', script: 'const readback = true;',
  seedJson: '{"items":[]}', stateJson: '{"items":[]}',
  controls: [{ id: 'result', label: '结果' }], acceptance: [{ operation: '查看结果', result: '显示测试值' }],
};
const item = { text: '核对测试值', outcome: '显示测试值', sourceRef: null, sortOrder: 0 };

test('源码构建拒绝超过固定模板和脚本读取上限的 UTF-8 初态', async () => {
  const digest = createHash('sha256').update(skill).digest('hex');
  await assert.rejects(buildSystemSource({ kind: 'system', skill: { name: 'bid-demo-system', digest },
    project: { ...generated, stateJson: JSON.stringify({ text: '值'.repeat(43_000) }) },
  }), { code: 'OUTPUT_INVALID' });
});

async function setup(t, { mode = 'success', output = generated, denyPublication = false, systemSourceBuilder } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-system-'));
  const trace = join(directory, 'codex.jsonl');
  await writeFile(trace, '');
  const readTrace = async () => (await readFile(trace, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  let plan;
  const adapter = createCodexAppServerAdapter({
    projectRoot: root, systemRoot: root, startupTimeoutMs: 3000, interruptTimeoutMs: 1000,
    buildLaunch: (context) => ({ command: process.execPath, args: [fakeServer, context] }),
    spawnProcess: (command, args, options) => spawn(command, args, { ...options, env: {
      ...process.env, FAKE_CODEX_MODE: mode, FAKE_CODEX_SKILL: skill, FAKE_CODEX_TRACE: trace,
      FAKE_CODEX_OUTPUTS: JSON.stringify({
        system: { reply: '已整理系统交付。', project: output },
        requirements: { reply: '已提议制作范围。', items: [{ text: item.text, outcome: item.outcome, sourceRef: null }] },
        plan: { reply: '已整理方案草稿。', draftJson: JSON.stringify(plan) },
      }),
    } }),
  });
  const studio = await createStudio({ dataRoot: directory, adapter, systemSourceBuilder });
  let closing;
  const close = () => closing ??= studio.close();
  t.after(async () => { await close(); await rm(directory, { recursive: true, force: true }); });
  const send = (method, url, payload, headers) => injectHttp(studio.app, { method, url, payload, headers });
  const { id } = (await send('POST', '/api/v1/projects', { title: '合成项目', brief: '验证生成与替换' })).json().data;
  const prefix = '/api/v1/projects/' + id;
  const request = (method, path, payload, headers) => send(method, prefix + path, payload, headers);
  const start = (purpose = 'system', requestId = purpose) => request('POST', '/messages', { purpose, requestId, text: '处理合成请求' });
  const save = async (items) => {
    const before = await request('GET', '/requirements');
    const response = await request('PUT', '/requirements', { items }, { 'if-match': before.headers.etag });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data.items;
  };
  const { repository } = studio;
  const seedSource = async () => {
    const task = runningTask(repository, id, 't-old-source');
    if (denyPublication) {
      // 旧成果仍可读取，以目录同名文件阻止本次发布写入。
      const artifactId = 'a-old-source';
      const relativePath = 'source-old/' + artifactId + '.zip';
      const bytes = sourceZip();
      const path = repository.getNewArtifactPath(id, relativePath);
      await writeFile(path, bytes);
      repository.registerArtifact({ id: artifactId, projectId: id, taskId: task.id, relativePath,
        kind: 'source', mime: 'application/zip', bytes: bytes.length, state: 'available', createdAt: task.createdAt });
      repository.updateProject({ ...repository.getProject(id), currentSourceId: artifactId, stage: 'plan' });
      repository.saveTask({ ...task, state: 'succeeded' });
      await writeFile(join(directory, 'projects', id, 'source'), '');
      return artifactId;
    }
    const artifact = await createArtifactService(repository).publishArtifact(task.id, {
      kind: 'source', extension: '.zip', mime: 'application/zip',
      bytes: sourceZip(), metadata: { sourceKind: 'imported', adapterId: 'synthetic' },
    });
    repository.saveTask({ ...task, state: 'succeeded' });
    return artifact.id;
  };
  const done = (response) => {
    assert.equal(response.statusCode, 202, response.body);
    return waitForTask(send, response.json().data.taskId);
  };
  return { id, request, send, start, save, done, seedSource, repository, directory, close, readTrace,
    setPlan: (draft) => { plan = draft; } };
}

test('模型提案和部分确认均拦截生成，编辑范围撤销受影响确认', async (t) => {
  const { request, send, start, save, done, seedSource, id } = await setup(t);
  assert.equal((await start()).json().error.code, 'REQUIREMENTS_UNCONFIRMED');
  const boundary = 'studio-system-test';
  const upload = await request('POST', '/attachments', Buffer.from(
    '--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="scope.txt"\r\n' +
    'Content-Type: text/plain\r\n\r\n核对测试值\r\n--' + boundary + '--\r\n'),
  { 'content-type': 'multipart/form-data; boundary=' + boundary });
  assert.equal(upload.statusCode, 201, upload.body);
  await waitForTask(send, upload.json().data.taskId);
  const proposal = await done(await start('requirements'));
  assert.equal(proposal.result.delivery.items[0].confirmed, false);
  const proposedScope = (await request('GET', '/requirements')).json().data;
  assert.deepEqual(proposedScope.items, []);
  assert.equal(proposedScope.proposal[0].confirmed, false);
  assert.equal((await start()).json().error.code, 'REQUIREMENTS_UNCONFIRMED');
  const [first, second] = await save([{ ...item, confirmed: true }, { ...item, text: '对照测试记录', sortOrder: 1, confirmed: false }]);
  assert.equal((await start()).json().error.code, 'REQUIREMENTS_UNCONFIRMED');
  await save([first, { ...second, confirmed: true }]);
  const old = await seedSource();
  const plan = await request('GET', '/plan');
  await request('PUT', '/plan', { draft: makePlan(id) }, { 'if-match': plan.headers.etag });
  const [changed, unchanged] = await save([{ ...first, outcome: '显示更新后的测试值' }, { ...second, confirmed: true }]);
  assert.equal(changed.confirmed, false);
  assert.equal(unchanged.confirmed, true);
  assert.equal((await request('GET', '/plan')).json().data.state, 'needs_update');
  const stalePlan = await request('GET', '/plan');
  await request('PUT', '/plan', { draft: makePlan(id) }, { 'if-match': stalePlan.headers.etag });
  const settings = await request('GET', '/settings');
  assert.equal((await request('PUT', '/settings', { values: { tts: { voice: 'zh-CN-XiaoxiaoNeural' } } },
    { 'if-match': settings.headers.etag })).statusCode, 200);
  assert.equal((await request('POST', '/scripts', { requestId: 'scope-changed' })).json().error.code, 'PLAN_STALE');
  assert.equal((await request('GET', '')).json().data.currentSourceId, old);
  assert.equal((await start()).json().error.code, 'REQUIREMENTS_UNCONFIRMED');
  const scope = await request('GET', '/requirements');
  await request('PATCH', '', { brief: '已修改的测试范围' });
  assert.equal((await request('PUT', '/requirements', { items: [changed, unchanged] },
    { 'if-match': scope.headers.etag })).statusCode, 409);
  assert.ok((await request('GET', '/requirements')).json().data.items.every((entry) => !entry.confirmed));
});

test('成功发布替换当前源码，旧脚本失效，新源码可生成方案和脚本', async (t) => {
  const { id, request, send, start, save, done, seedSource, repository, setPlan, readTrace } = await setup(t);
  const [confirmed] = await save([{ ...item, confirmed: true }]);
  const old = await seedSource();
  const settings = await request('GET', '/settings');
  assert.equal((await request('PUT', '/settings', { values: { tts: { voice: 'zh-CN-XiaoxiaoNeural' } } },
    { 'if-match': settings.headers.etag })).statusCode, 200);
  const savePlan = async (draft) => {
    const before = await request('GET', '/plan');
    assert.equal((await request('PUT', '/plan', { draft }, { 'if-match': before.headers.etag })).statusCode, 200);
  };
  await savePlan(makePlan(id));
  const previous = await done(await request('POST', '/scripts', { requestId: 'previous-script' }));
  assert.equal(previous.state, 'succeeded');
  const draft = makePlan(id);
  draft.source = { ...draft.source, kind: 'generated', adapterId: 'generated-local-node' };
  draft.features[0].requirementId = confirmed.id;
  draft.data.resetStrategy = 'seed';
  setPlan(draft);
  const task = await done(await start());
  assert.equal(task.state, 'succeeded', JSON.stringify(task.error));
  assert.deepEqual((await readTrace()).find((event) => event.event === 'context' && event.purpose === 'system').requirements,
    [{ id: confirmed.id, text: item.text, outcome: item.outcome, sourceRef: null }]);
  const sourceId = task.result.sourceArtifactId;
  assert.ok(sourceId);
  assert.notEqual(sourceId, old);
  assert.equal((await request('GET', '')).json().data.currentSourceId, sourceId);
  assert.equal(repository.listEvents(task.taskId).at(-1).payload.sourceArtifactId, sourceId);
  assert.equal((await request('GET', '/plan')).json().data.state, 'needs_update');
  assert.equal((await request('GET', '/artifacts?kind=script')).json().data[0].stale, true);
  const archive = unzipSync((await send('GET', '/api/v1/artifacts/' + sourceId + '/content?projectId=' + id + '&download=1')).rawPayload);
  assert.equal(strFromU8(archive['server.mjs']), await readFile(join(root, 'template/generated-server.mjs'), 'utf8'));
  assert.equal(strFromU8(archive['app.js']), generated.script);
  assert.deepEqual(JSON.parse(strFromU8(archive['seed/state.json'])), { items: [] });
  assert.ok(archive['启动演示.cmd']);
  const proposal = await done(await start('plan'));
  assert.equal(proposal.state, 'succeeded', JSON.stringify(proposal.error));
  await savePlan(proposal.result.delivery.draft);
  const script = await done(await request('POST', '/scripts', { requestId: 'new-script' }));
  assert.equal(script.state, 'succeeded', JSON.stringify(script.error));
  assert.equal(repository.getArtifact(script.result.artifactId).metadata.sourceArtifactId, sourceId);
});

test('发布新源码后主动回收旧预览，无需再次点击打开', async (t) => {
  const { start, save, done, request, close } = await setup(t);
  await save([{ ...item, confirmed: true }]);
  assert.equal((await done(await start('system', 'first-preview-source'))).state, 'succeeded');
  const first = await request('POST', '/preview', {});
  assert.equal(first.statusCode, 200, first.body);
  const oldUrl = first.json().data.previewUrl;
  assert.equal((await fetch(oldUrl + '/api/health')).status, 200);
  assert.equal((await done(await start('system', 'second-preview-source'))).state, 'succeeded');
  await assert.rejects(fetch(oldUrl));
  const second = await request('POST', '/preview', {});
  assert.equal(second.statusCode, 200, second.body);
  const currentUrl = second.json().data.previewUrl;
  await close();
  await assert.rejects(fetch(currentUrl));
});

test('当前 ZIP 缺失时仍可按已确认条款重新生成', async (t) => {
  const { id, start, save, done, seedSource, repository, readTrace } = await setup(t);
  await save([{ ...item, confirmed: true }]);
  const old = await seedSource();
  await rm(repository.getArtifactPath(id, old).path);
  const task = await done(await start());
  assert.equal(task.state, 'succeeded', JSON.stringify(task.error));
  assert.deepEqual((await readTrace()).find(({ event }) => event === 'context').fileIndex, []);
  assert.notEqual(repository.getProject(id).currentSourceId, old);
});

for (const [name, options, code] of [
  ['校验失败', { output: { ...generated, script: 'const =' } }, 'OUTPUT_INVALID'],
  ['缺少系统交付', { output: null }, 'OUTPUT_INVALID'],
  ['构建失败', { systemSourceBuilder: async () => { throw new Error('合成构建失败'); } }, 'OUTPUT_INVALID'],
  ['发布失败', { denyPublication: true }, 'OUTPUT_INVALID'],
  ['取消', { mode: 'cancel-race' }, 'TASK_CANCELLED'],
]) {
  test(name + '保留当前源码指针', async (t) => {
    const { request, send, start, save, done, seedSource, repository, readTrace } = await setup(t, options);
    await save([{ ...item, confirmed: true }]);
    const old = await seedSource();
    const accepted = await start();
    assert.equal(accepted.statusCode, 202, accepted.body);
    const taskId = accepted.json().data.taskId;
    if (code === 'TASK_CANCELLED') {
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((await readTrace()).some((event) => event.event === 'turn-start-request')) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok((await readTrace()).some((event) => event.event === 'turn-start-request'));
      assert.equal((await send('POST', '/api/v1/tasks/' + taskId + '/cancel', {})).statusCode, 202);
    }
    const task = await done(accepted);
    assert.equal(task.state, code === 'TASK_CANCELLED' ? 'cancelled' : 'failed');
    assert.equal(task.error.code, code);
    if (code === 'TASK_CANCELLED') {
      assert.ok((await readTrace()).some((event) => event.event === 'turn-completed' && event.status === 'completed'));
    }
    assert.equal((await request('GET', '')).json().data.currentSourceId, old);
    assert.ok(repository.getArtifactPath(task.projectId, old));
    assert.ok(repository.listEvents(taskId).every((entry) => entry.type !== 'task.succeeded'));
  });
}

test('重启后保留旧源码和人工确认，收尾中断构建的待发布文件', async (t) => {
  const { id, save, seedSource, repository, directory, close } = await setup(t);
  const confirmed = await save([{ ...item, confirmed: true }]);
  const old = await seedSource();
  const taskId = 't-interrupted-system';
  const task = runningTask(repository, id, taskId, 'ai');
  repository.saveTask({ ...task, purpose: 'system', phase: 'build_system' });
  const relativePath = 'source/a-interrupted-system.zip';
  repository.registerArtifact({ id: 'a-interrupted-system', projectId: id, taskId, relativePath,
    kind: 'source', mime: 'application/zip', state: 'pending', bytes: 0, createdAt: task.createdAt });
  await writeFile(repository.getNewArtifactPath(id, relativePath) + '.tmp', sourceZip());
  await close();
  const reopened = await createStudio({ dataRoot: directory });
  try {
    const call = (url) => injectHttp(reopened.app, { method: 'GET', url });
    const project = (await call('/api/v1/projects/' + id)).json().data;
    assert.equal(project.currentSourceId, old);
    assert.deepEqual(project.activeTasks, []);
    assert.deepEqual((await call('/api/v1/projects/' + id + '/requirements')).json().data.items, confirmed);
    assert.equal((await call('/api/v1/tasks/' + taskId)).json().data.state, 'interrupted');
    assert.equal(reopened.repository.getArtifact('a-interrupted-system').state, 'partial');
  } finally {
    await reopened.close();
  }
});

test('模型已返回后在源码构建阶段取消，任务停止且旧源码仍是当前源码', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { request, send, start, save, done, seedSource } = await setup(t, {
    async systemSourceBuilder(delivery) {
      started.resolve();
      await release.promise;
      return buildSystemSource(delivery);
    },
  });
  await save([{ ...item, confirmed: true }]);
  const old = await seedSource();
  const accepted = await start();
  assert.equal(accepted.statusCode, 202, accepted.body);
  const taskPath = '/api/v1/tasks/' + accepted.json().data.taskId;
  let timer;
  try {
    await Promise.race([started.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('任务未进入构建阶段')), 2500);
    })]);
    assert.equal((await send('GET', taskPath)).json().data.phase, 'build_system');
    const scope = await request('GET', '/requirements');
    assert.equal((await request('PUT', '/requirements', { items: [] }, { 'if-match': scope.headers.etag })).json().error.code,
      'RESOURCE_BUSY');
    assert.equal((await send('POST', taskPath + '/cancel', {})).statusCode, 202);
  } finally {
    clearTimeout(timer);
    release.resolve();
  }
  assert.equal((await done(accepted)).state, 'cancelled');
  assert.equal((await request('GET', '')).json().data.currentSourceId, old);
  assert.deepEqual((await request('GET', '/artifacts?kind=source')).json().data.map(({ id }) => id), [old]);
});
