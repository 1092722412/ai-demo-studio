import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { createArtifactService } from '../dist-server/artifacts.js';
import { recoverScriptPublications } from '../dist-server/scripts.js';
import { fixture, runningTask, sourceZip } from '../test-support/plan-fixture.mjs';

test('成果投影区分 missing 和 partial，视频支持范围与下载', async (t) => {
  const { repository, id, request, send } = await fixture(t);
  const service = createArtifactService(repository);
  const task = runningTask(repository, id, 't-video', 'render');
  const file = { kind: 'video', extension: '.mp4', mime: 'video/mp4', bytes: Buffer.from('0123456789') };
  const partial = await service.publishArtifact(task.id, { ...file, partial: true });
  assert.equal(repository.getProject(id).currentVideoId, null);
  const complete = await service.publishArtifact(task.id, file);
  const url = (artifact) => '/api/v1/artifacts/' + artifact.id + '/content?projectId=' + id;
  assert.equal((await send('GET', url(partial))).statusCode, 404);
  assert.equal((await send('GET', url(partial) + '&download=1')).body, '0123456789');
  for (const [range, expected, contentRange] of [
    ['bytes=2-5', '2345', 'bytes 2-5/10'], ['bytes=-3', '789', 'bytes 7-9/10'], ['bytes=8-', '89', 'bytes 8-9/10'],
  ]) {
    const result = await send('GET', url(complete), undefined, { range });
    assert.equal(result.statusCode, 206);
    assert.equal(result.body, expected);
    assert.equal(result.headers['content-range'], contentRange);
  }
  const bad = await send('GET', url(complete), undefined, { range: 'bytes=20-' });
  assert.equal(bad.statusCode, 416);
  assert.equal(bad.headers['content-range'], 'bytes */10');
  await rm(repository.getArtifactPath(id, complete.id).path);
  assert.equal((await send('GET', url(complete))).statusCode, 404);
  const listed = (await request('GET', '/artifacts?kind=video')).json().data;
  assert.equal(listed.find((item) => item.id === complete.id).state, 'missing');
  assert.equal(listed.find((item) => item.id === partial.id).state, 'partial');
});

test('发布失败或取消保留原当前源码，列表只展示当前源码', async (t) => {
  const { repository, id, request } = await fixture(t);
  const service = createArtifactService(repository);
  const task = runningTask(repository, id, 't-source');
  const file = { kind: 'source', extension: '.zip', mime: 'application/zip', bytes: sourceZip(),
    metadata: { sourceKind: 'imported', adapterId: 'synthetic' } };
  const initial = await service.publishArtifact(task.id, file);
  await assert.rejects(service.publishArtifact(task.id, { ...file, extension: '/../outside.zip' }));
  await assert.rejects(service.publishArtifact(task.id, { ...file, bytes: Buffer.from('invalid zip') }));
  await assert.rejects(service.publishArtifact(task.id, file, (tx, registered) => {
    assert.equal(tx.getProject(id).currentSourceId, registered.id);
    throw new Error('合成事务失败');
  }), { code: 'OUTPUT_INVALID' });
  assert.equal(repository.getProject(id).currentSourceId, initial.id);
  const missing = repository.listArtifacts(id, 'source').find(({ state }) => state === 'missing');
  assert.ok(missing);
  assert.equal(repository.getArtifactPath(id, missing.id), null);
  const inflight = service.publishArtifact(task.id, file);
  repository.saveTask({ ...task, state: 'cancelling' });
  assert.equal((await inflight).state, 'partial');
  assert.equal(repository.getProject(id).currentSourceId, initial.id);
  const listed = (await request('GET', '/artifacts?kind=source')).json().data;
  assert.deepEqual(listed.filter(({ current }) => current).map(({ id }) => id), [initial.id]);
  assert.ok(listed.some(({ state }) => state === 'partial'));
  assert.ok(listed.some(({ state }) => state === 'missing'));
});

test('启动时将中断脚本遗留的成果标为 partial 或 missing，并解除项目占用', async (t) => {
  const { repository, id, request } = await fixture(t);
  const task = runningTask(repository, id, 't-interrupted', 'script');
  for (const artifactId of ['a-unclosed', 'a-no-file']) {
    const artifact = repository.registerArtifact({ id: artifactId, projectId: id, taskId: task.id, kind: 'script',
      relativePath: 'scripts/' + artifactId + '.zip', mime: 'application/zip', bytes: 0, state: 'pending', createdAt: task.createdAt });
    if (artifactId === 'a-unclosed') {
      await writeFile(repository.getNewArtifactPath(id, artifact.relativePath) + '.tmp', '未封闭脚本包');
    }
  }
  recoverScriptPublications(repository);
  assert.equal(repository.getTask(task.id).state, 'interrupted');
  assert.equal(repository.getArtifact('a-unclosed').state, 'partial');
  assert.match(repository.getArtifactPath(id, 'a-unclosed').path, /\.zip\.partial$/);
  assert.equal(repository.getArtifact('a-no-file').state, 'missing');
  assert.equal(repository.getPlan(id).state, 'draft');
  const current = await request('GET', '/plan');
  assert.equal((await request('PUT', '/plan', { draft: {} }, { 'if-match': current.headers.etag })).statusCode, 200);
});
