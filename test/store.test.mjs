import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initializeStore } from '../dist-server/store/repository.js';

async function withStore(run) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ai-demo-store-'));
  let repository;
  try {
    repository = await initializeStore(dataRoot);
    await run({ dataRoot, repository });
  } finally {
    repository?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
}

function project(id = 'p-test') {
  const now = new Date().toISOString();
  return {
    id,
    title: '存储测试项目',
    brief: '合成测试内容',
    stage: 'requirements',
    connectionId: null,
    currentSourceId: null,
    currentVideoId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function task({
  id,
  projectId = 'p-test',
  kind = 'ai',
  purpose = 'discuss',
  state = 'succeeded',
  requestId = id,
  request = { text: '测试' },
} = {}) {
  return {
    id,
    projectId,
    conversationId: null,
    connectionId: null,
    kind,
    purpose,
    state,
    phase: 'complete',
    input: { text: '测试' },
    runtime: null,
    result: null,
    error: null,
    waitingInput: null,
    requestId,
    request,
    createdAt: new Date().toISOString(),
    startedAt: null,
    endedAt: null,
  };
}

test('空数据库可重复初始化；保存项目后关闭重开仍可读取，且不读取历史 job.json', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ai-demo-store-reopen-'));
  const legacyJob = join(dataRoot, 'jobs', 'legacy', 'job.json');
  let repository;
  try {
    await mkdir(join(dataRoot, 'jobs', 'legacy'), { recursive: true });
    await writeFile(legacyJob, '{ this is intentionally not valid JSON }', 'utf8');

    repository = await initializeStore(dataRoot);
    const saved = repository.saveProject(project());
    assert.equal(repository.getProject('p-test')?.title, '存储测试项目');
    repository.close();

    repository = await initializeStore(dataRoot);
    assert.deepEqual(repository.getProject('p-test'), saved);
    assert.equal(await readFile(legacyJob, 'utf8'), '{ this is intentionally not valid JSON }');
    assert.ok(repository.getPlan('p-test')?.editToken);
    assert.ok(repository.getSettings('project:p-test')?.editToken);
  } finally {
    repository?.close();
    await rm(dataRoot, { recursive: true, force: true });
  }
});

test('活动写任务取得唯一项目执行权，讨论任务不占写任务锁', () => withStore(({ repository }) => {
  repository.saveProject(project());
  repository.saveTask(task({ id: 't-system', kind: 'ai', purpose: 'system', state: 'running' }));
  repository.saveTask(task({ id: 't-discuss', kind: 'ai', purpose: 'discuss', state: 'running' }));
  assert.throws(
    () => repository.saveTask(task({ id: 't-record', kind: 'record', purpose: null, state: 'queued' })),
    /UNIQUE constraint failed/,
  );
  repository.saveTask(task({ id: 't-system', kind: 'ai', purpose: 'system', state: 'succeeded' }));
  assert.equal(repository.saveTask(task({ id: 't-record', kind: 'record', purpose: null, state: 'queued' })).id, 't-record');
}));

test('事件序号在事务中分配；回滚后序号可继续使用', () => withStore(({ repository }) => {
  repository.saveProject(project());
  repository.saveTask(task({ id: 't-events' }));
  const first = repository.appendEvent({ taskId: 't-events', type: 'task.started', payload: {}, createdAt: '2026-11-26T00:00:00.000Z' });
  assert.equal(first.seq, 1);
  assert.throws(() => repository.transaction((tx) => {
    tx.appendEvent({ taskId: 't-events', type: 'message.delta', payload: { text: 'rolled back' }, createdAt: '2026-11-26T00:00:01.000Z' });
    throw new Error('rollback');
  }), /rollback/);
  const next = repository.appendEvent({ taskId: 't-events', type: 'task.succeeded', payload: {}, createdAt: '2026-11-26T00:00:02.000Z' });
  assert.equal(next.seq, 2);
}));

test('任务和成果的外键拒绝不存在的项目引用', () => withStore(({ repository }) => {
  assert.throws(() => repository.saveTask(task({ id: 't-orphan', projectId: 'p-missing' })), /FOREIGN KEY constraint failed/);
  assert.throws(() => repository.registerArtifact({
    id: 'a-orphan',
    projectId: 'p-missing',
    taskId: null,
    kind: 'source',
    relativePath: 'source/app.ts',
    mime: 'text/plain',
    bytes: 0,
    state: 'available',
    metadata: {},
    createdAt: new Date().toISOString(),
  }), /FOREIGN KEY constraint failed/);
}));

test('相同 requestId 和规范化载荷返回原任务，不同载荷冲突', () => withStore(({ repository }) => {
  repository.saveProject(project());
  const saved = repository.saveTask(task({ id: 't-request', requestId: 'click-1', request: { a: 1, b: { x: 2, y: 3 } } }));
  const repeated = repository.saveTask(task({ id: 't-retry', requestId: 'click-1', request: { b: { y: 3, x: 2 }, a: 1 } }));
  assert.equal(repeated.id, saved.id);
  assert.throws(
    () => repository.saveTask(task({ id: 't-conflict', requestId: 'click-1', request: { a: 2 } })),
    (error) => error.code === 'REQUEST_CONFLICT',
  );
}));

test('成果文件缺失时登记状态改为 missing；方案与设置使用 edit token 比较保存', () => withStore(({ repository }) => {
  repository.saveProject(project());
  const artifact = repository.registerArtifact({
    id: 'a-missing',
    projectId: 'p-test',
    taskId: null,
    kind: 'source',
    relativePath: 'source/not-created.ts',
    mime: 'text/plain',
    bytes: 12,
    state: 'available',
    metadata: {},
    createdAt: new Date().toISOString(),
  });
  assert.equal(artifact.state, 'missing');
  assert.equal(artifact.bytes, 12);

  const plan = repository.getPlan('p-test');
  const planSave = repository.compareAndSavePlan({
    projectId: 'p-test',
    expectedEditToken: plan.editToken,
    body: { title: '方案草稿' },
    state: 'draft',
    updatedAt: new Date().toISOString(),
  });
  assert.equal(planSave.saved, true);
  assert.equal(repository.compareAndSavePlan({
    projectId: 'p-test',
    expectedEditToken: plan.editToken,
    body: { title: '过期草稿' },
    state: 'draft',
    updatedAt: new Date().toISOString(),
  }).saved, false);

  const settings = repository.getSettings('project:p-test');
  assert.equal(repository.compareAndSaveSettings({
    scope: settings.scope,
    expectedEditToken: settings.editToken,
    values: { moveMs: 700 },
    updatedAt: new Date().toISOString(),
  }).saved, true);
}));
