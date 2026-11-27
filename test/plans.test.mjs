import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePlan } from '../dist-server/plans.js';
import { mapPlanOutput, planOutputSchema } from '../dist-server/ai/output-schemas.js';
import { createArtifactService } from '../dist-server/artifacts.js';
import { fixture, makePlan, runningTask, sourceZip, waitForTask } from '../test-support/plan-fixture.mjs';

test('方案 Schema 和执行语义检查引用、歧义、动作和结果旁白', () => {
  const plan = makePlan();
  assert.deepEqual(validatePlan(plan), []);
  plan.elements.push({ ...plan.elements[0], id: 'duplicate-locator' });
  plan.steps[0].actions.push({ op: 'shell', target: 'missing' });
  plan.narration[0].anchor = 'start';
  plan.narration[0].text = '保存成功，列表已经更新。';
  const issues = validatePlan(plan);
  for (const [path, code] of [
    ['/elements/1', 'TARGET_AMBIGUOUS'], ['/steps/0/actions/1/op', 'ACTION_UNSUPPORTED'],
    ['/steps/0/actions/1/target', 'REFERENCE_MISSING'], ['/narration/0/anchor', 'RESULT_TOO_EARLY'],
  ]) assert.ok(issues.some((issue) => issue.path === path && issue.code === code), JSON.stringify(issues));
});

test('动态目标的前置检查和基础图层必须齐全', () => {
  const plan = makePlan();
  plan.elements[0].availableWhen = '点击后出现';
  plan.steps[0].actions[0].op = 'click';
  plan.layers[0].z = 2;
  plan.features.push({ ...plan.features[0], id: 'uncovered-feature' });
  assert.ok(validatePlan(plan).some(({ code }) => code === 'TARGET_CONDITION_UNVERIFIED'));
  assert.ok(validatePlan(plan).some(({ path }) => path === '/layers/0/z'));
  assert.ok(validatePlan(plan).some(({ code }) => code === 'FEATURE_UNCOVERED'));
});

test('更换源码或修改需求描述会更新当前方案令牌', async (t) => {
  const { id, repository, request } = await fixture(t);
  const initial = await request('GET', '/plan');
  const task = runningTask(repository, id, 't-current-source');
  await createArtifactService(repository).publishArtifact(task.id, { kind: 'source', extension: '.zip', mime: 'application/zip',
    bytes: sourceZip(), metadata: { sourceKind: 'imported', adapterId: 'synthetic' } });
  repository.saveTask({ ...task, state: 'succeeded' });
  assert.equal((await request('PUT', '/plan', { draft: makePlan(id) }, { 'if-match': initial.headers.etag })).statusCode, 409);
  const current = await request('GET', '/plan');
  assert.equal(current.json().data.state, 'draft');
  const saved = await request('PUT', '/plan', { draft: makePlan(id) }, { 'if-match': current.headers.etag });
  assert.equal(saved.statusCode, 200);
  const changed = await request('PATCH', '', { brief: '合成需求范围有变化' });
  assert.equal(changed.json().data.stage, 'requirements');
  const invalidated = await request('GET', '/plan');
  assert.equal(invalidated.json().data.state, 'needs_update');
  assert.notEqual(invalidated.headers.etag, saved.headers.etag);
});

test('当前草稿以 If-Match 保存，结构不完整时无法生成脚本', async (t) => {
  const { request } = await fixture(t);
  const initial = await request('GET', '/plan');
  assert.equal(initial.statusCode, 200);
  const draft = { description: '未写完的方案' };
  assert.equal((await request('PUT', '/plan', { draft })).statusCode, 428);
  const headers = { 'if-match': initial.headers.etag };
  const saved = await request('PUT', '/plan', { draft }, headers);
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(saved.json().data.draft, draft);
  assert.equal(saved.json().data.state, 'draft');
  assert.ok(saved.json().data.issues.some(({ path }) => path === '/steps'));
  assert.equal((await request('PUT', '/plan', { draft }, headers)).statusCode, 409);
  assert.equal((await request('POST', '/scripts', { requestId: 'invalid' })).statusCode, 422);
});

test('Codex plan 单独映射提案，保留显式保存与 system 人工确认门槛', async (t) => {
  assert.deepEqual(planOutputSchema.required, ['reply', 'draftJson']);
  assert.throws(() => mapPlanOutput({ reply: '提案', draftJson: '[]' }), { code: 'OUTPUT_INVALID' });
  const plan = { description: '模型提案' };
  const output = mapPlanOutput({ reply: '已整理提案。', draftJson: JSON.stringify(plan) });
  const { request, send } = await fixture(t, async () => output);
  const started = await request('POST', '/messages', { requestId: 'plan-draft', purpose: 'plan', text: '拟定草稿' });
  assert.equal(started.statusCode, 202);
  const task = await waitForTask(send, started.json().data.taskId);
  assert.deepEqual(task.result.delivery.draft, plan);
  assert.deepEqual((await request('GET', '/plan')).json().data.draft, {});
  const system = await request('POST', '/messages', { requestId: 'system', purpose: 'system', text: '生成系统' });
  assert.equal(system.json().error.code, 'REQUIREMENTS_UNCONFIRMED');
});
