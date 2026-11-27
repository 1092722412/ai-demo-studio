import assert from 'node:assert/strict';
import test from 'node:test';
import { unzipSync, strFromU8, strToU8 } from 'fflate';
import { compileScript } from '../dist-server/scripts.js';
import { createArtifactService } from '../dist-server/artifacts.js';
import { fixture, makePlan, runningTask, sourceZip, waitForTask } from '../test-support/plan-fixture.mjs';

test('编译只接受受控数据策略与源码包内引用', async () => {
  const draft = makePlan();
  const source = { projectId: draft.projectId, artifactId: 'a-source', planToken: 'token',
    kind: 'imported', adapterId: 'synthetic', archive: sourceZip() };
  const build = () => compileScript(draft, source, draft.profile);
  const compiled = await build();
  assert.equal(compiled.manifest.entry, 'execute.py');
  draft.features[0].sourceRef = '../outside.js';
  await assert.rejects(build, { code: 'SOURCE_CHECK_FAILED' });
  draft.features[0].sourceRef = 'app.js#notPresent';
  await assert.rejects(build, { code: 'SOURCE_CHECK_FAILED' });
  draft.features[0].sourceRef = 'app.js#readback';
  draft.data.resetStrategy = 'seed';
  await assert.rejects(build, { code: 'SOURCE_CHECK_FAILED' });
  draft.source = { ...draft.source, kind: 'generated', adapterId: 'generated-local-node' };
  source.kind = 'generated';
  source.adapterId = 'generated-local-node';
  draft.features[0].requirementId = 'r-confirmed';
  await assert.rejects(build, { code: 'SOURCE_CHECK_FAILED' });
  source.archive = sourceZip({ 'seed/state.json': strToU8('{"rows":[]}') });
  await assert.rejects(build, (error) => error.code === 'SOURCE_CHECK_FAILED' && error.field === '/features/0/requirementId');
  source.confirmedRequirementIds = ['r-confirmed'];
  const seeded = await build();
  assert.deepEqual(JSON.parse(strFromU8(unzipSync(seeded.archive)['preparation.json'])), { mode: 'projectData', strategy: 'seed' });
  draft.data.resetStrategy = 'custom';
  draft.data.state = { rows: [{ name: '合成' }] };
  assert.deepEqual(JSON.parse(strFromU8(unzipSync((await build()).archive)['preparation.json'])).state, draft.data.state);
  delete draft.data.state;
  await assert.rejects(build, { code: 'VALIDATION_FAILED' });
});

test('脚本可下载，保存方案后旧包失效且同一 requestId 可重试', async (t) => {
  const { repository, id, request, send } = await fixture(t);
  const artifacts = createArtifactService(repository);
  const task = runningTask(repository, id, 't-source');
  await artifacts.publishArtifact(task.id, { kind: 'source', extension: '.zip', mime: 'application/zip', bytes: sourceZip(),
    metadata: { sourceKind: 'imported', adapterId: 'synthetic' } });
  repository.saveTask({ ...task, state: 'succeeded' });
  let plan = await request('GET', '/plan');
  const draft = makePlan(id);
  plan = await request('PUT', '/plan', { draft }, { 'if-match': plan.headers.etag });
  const body = { requestId: 'make-script' };
  const missingVoice = await request('POST', '/scripts', body);
  assert.equal(missingVoice.statusCode, 422);
  const settings = await request('GET', '/settings');
  assert.equal((await request('PUT', '/settings', { values: { tts: { voice: 'zh-CN-XiaoxiaoNeural' } } },
    { 'if-match': settings.headers.etag })).statusCode, 200);
  const started = await request('POST', '/scripts', body);
  assert.equal(started.statusCode, 202, started.body);
  const { taskId } = started.json().data;
  const done = await waitForTask(send, taskId);
  assert.equal(done.state, 'succeeded', JSON.stringify(done));
  assert.deepEqual(repository.listEvents(taskId).map(({ type }) => type), ['task.started', 'artifact.created', 'task.succeeded']);
  const artifactId = done.result.artifactId;
  const file = await send('GET', '/api/v1/artifacts/' + artifactId + '/content?projectId=' + id + '&download=1');
  assert.match(file.headers['content-disposition'], /\.zip"/);
  const zip = unzipSync(file.rawPayload);
  for (const entry of ['manifest.json', 'plan.json', 'preparation.json', 'execute.py', 'README.md', 'requirements.txt']) assert.ok(zip[entry]);
  assert.equal(JSON.parse(strFromU8(zip['plan.json'])).profile.tts.voice, 'zh-CN-XiaoxiaoNeural');
  const ready = await request('GET', '/plan');
  assert.equal(ready.json().data.state, 'ready');
  await request('PUT', '/plan', { draft: { ...draft, description: '新说明' } }, { 'if-match': ready.headers.etag });
  const listed = (await request('GET', '/artifacts?kind=script')).json().data;
  assert.equal(listed[0].stale, true);
  assert.equal((await request('POST', '/scripts', body)).json().data.taskId, taskId);

  const replacementTask = runningTask(repository, id, 't-replacement');
  const replacement = await artifacts.publishArtifact(replacementTask.id, { kind: 'source', extension: '.zip',
    mime: 'application/zip', bytes: sourceZip(), metadata: { sourceKind: 'imported', adapterId: 'synthetic' } });
  repository.saveTask({ ...replacementTask, state: 'succeeded' });
  assert.equal(repository.getProject(id).currentSourceId, replacement.id);
  assert.equal((await request('GET', '/plan')).json().data.state, 'needs_update');
  assert.equal((await request('POST', '/scripts', { requestId: 'replacement' })).json().error.code, 'PLAN_STALE');
  const sources = (await request('GET', '/artifacts?kind=source')).json().data;
  assert.deepEqual(sources.filter(({ state }) => state === 'available').map(({ id }) => id), [replacement.id]);
});
