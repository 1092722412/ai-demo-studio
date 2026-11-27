import { readFileSync } from 'node:fs';
import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import { resolveProfile } from './settings.js';
import type { PlanRecord, StudioRepository } from './store/repository.js';

export type Issue = { path: string; code: string; message: string };
export const supportedActions = ['observe', 'click', 'replaceAscii', 'press', 'scroll', 'refresh'] as const;
const actionNames = new Set<string>(supportedActions);
const schema = JSON.parse(readFileSync(new URL('../docs/examples/demo-contract.schema.json', import.meta.url), 'utf8'));
const handoff = JSON.parse(readFileSync(new URL('../docs/examples/execution-handoff.schema.json', import.meta.url), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const planSchemaId = new URL('demo-contract.schema.json', handoff.$id).href;
ajv.addSchema(schema, planSchemaId);
ajv.addSchema(handoff);
const checkPlan = ajv.getSchema(planSchemaId)!;
export const checkScriptManifest = ajv.getSchema(handoff.$id + '#/$defs/script')!;
export const checkPreparation = ajv.getSchema(handoff.$id + '#/$defs/preparation')!;
export const checkCaptureManifest = ajv.getSchema(handoff.$id + '#/$defs/capture')!;

export class PlanError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422, readonly field?: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export function planObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function entries(value: unknown): Array<[number, Record<string, unknown>]> {
  return Array.isArray(value) ? value.flatMap((item, index) => {
    const record = planObject(item);
    return record ? [[index, record]] : [];
  }) : [];
}

function pointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

function schemaIssue(error: ErrorObject): Issue {
  const suffix = error.keyword === 'required' ? error.params.missingProperty
    : error.keyword === 'additionalProperties' ? error.params.additionalProperty : null;
  const path = suffix === null ? error.instancePath : error.instancePath + '/' + pointer(suffix);
  const message = error.keyword === 'required' ? '缺少必填字段。' : error.keyword === 'additionalProperties'
    ? '不支持此字段。' : '字段值不符合方案契约。';
  return { path, code: 'SCHEMA_INVALID', message };
}

// 自然语言仅识别明确的结果句式，业务语义和实际页面定位仍由验收确认。
const resultStatement = /(?:成功(?:[，。！、\s]|$)|已(?:经|成功|保存|写入|更新|创建|删除|提交|完成|恢复|生效)|仍然可查|\b(?:successfully|has been (?:saved|created|deleted|updated))\b)/iu;
const activeStates = new Set(['queued', 'running', 'waiting_input', 'cancelling']);

export function validatePlan(draft: unknown): Issue[] {
  checkPlan(draft);
  const issues = (checkPlan.errors ?? []).map(schemaIssue);
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });
  const plan = planObject(draft);
  if (!plan) return issues;

  const index = (field: string) => {
    const byId = new Map<string, Record<string, unknown>>();
    for (const [i, item] of entries(plan[field])) {
      if (typeof item.id !== 'string') continue;
      if (byId.has(item.id)) add('/' + field + '/' + i + '/id', 'ID_DUPLICATE', '同类标识必须唯一。');
      else byId.set(item.id, item);
    }
    return byId;
  };
  const featureIds = index('features');
  const elements = index('elements');
  const steps = index('steps');
  index('narration');
  index('layers');
  const reference = (value: unknown, byId: Map<string, unknown>, path: string) => {
    if (typeof value === 'string' && !byId.has(value)) add(path, 'REFERENCE_MISSING', '引用的标识不存在。');
  };

  const locators = new Set<string>();
  for (const [i, element] of entries(plan.elements)) {
    if (typeof element.value !== 'string' || typeof element.by !== 'string') continue;
    const key = JSON.stringify([element.by, element.role, element.value.trim()]);
    if (locators.has(key)) add('/elements/' + i, 'TARGET_AMBIGUOUS', '同一页面定位对应多个目标标识。');
    locators.add(key);
  }

  const visible = new Set<string>();
  const stepVisibility = new Map<unknown, { start: Set<string>; verified: Set<string> }>();
  const needsVisibility = (target: unknown, known: Set<string>, path: string) => {
    if (typeof target === 'string' && elements.get(target)?.availableWhen && !known.has(target)) {
      add(path, 'TARGET_CONDITION_UNVERIFIED', '动态目标需要用前置检查确认出现。');
    }
  };
  for (const [i, step] of entries(plan.steps)) {
    const base = '/steps/' + i;
    reference(step.featureId, featureIds, base + '/featureId');
    const start = new Set(visible);
    // 动作可能改变页面，出现条件必须由当前步骤之前的检查确认。
    for (const [j, action] of entries(step.actions)) {
      const path = base + '/actions/' + j;
      if (typeof action.op === 'string' && !actionNames.has(action.op)) {
        add(path + '/op', 'ACTION_UNSUPPORTED', '当前脚本不支持该动作。');
      }
      reference(action.target, elements, path + '/target');
      if (action.op !== 'observe') needsVisibility(action.target, visible, path + '/target');
      if (action.op === 'refresh') visible.clear();
    }
    for (const [j, check] of entries(step.checks)) {
      reference(check.target, elements, base + '/checks/' + j + '/target');
      if (typeof check.target !== 'string') continue;
      if (check.op === 'visible' && check.expected === true) visible.add(check.target);
      if ((check.op === 'visible' && check.expected === false) || (check.op === 'count' && check.expected === 0)) visible.delete(check.target);
    }
    stepVisibility.set(step.id, { start, verified: new Set(visible) });
  }
  const coveredFeatures = new Set(entries(plan.steps).map(([, step]) => step.featureId));
  for (const [i, feature] of entries(plan.features)) {
    if (typeof feature.id === 'string' && !coveredFeatures.has(feature.id)) {
      add('/features/' + i + '/id', 'FEATURE_UNCOVERED', '此功能缺少演示步骤。');
    }
  }
  const narrations = entries(plan.narration);
  for (const [i, narration] of narrations) {
    reference(narration.stepId, steps, '/narration/' + i + '/stepId');
    if (narration.anchor === 'start' && typeof narration.text === 'string' && resultStatement.test(narration.text)) {
      add('/narration/' + i + '/anchor', 'RESULT_TOO_EARLY', '结果性讲解必须在结果验证后出现。');
    }
  }

  const layers = entries(plan.layers);
  if (Array.isArray(plan.layers)) {
    for (const type of ['desktop', 'voice', 'captions']) {
      if (layers.filter(([, layer]) => layer.type === type).length !== 1) {
        add('/layers', 'LAYER_REQUIRED', type + ' 图层必须恰好有一项。');
      }
    }
  }
  const desktop = layers.find(([, layer]) => layer.type === 'desktop');
  if (desktop && typeof desktop[1].z === 'number' && layers.some(([, layer]) =>
    layer !== desktop[1] && layer.type !== 'voice' && typeof layer.z === 'number' && layer.z <= Number(desktop[1].z))) {
    add('/layers/' + desktop[0] + '/z', 'LAYER_ORDER_INVALID', '桌面必须位于视觉图层最底。');
  }
  const captions = layers.find(([, layer]) => layer.type === 'captions')?.[1];
  for (const [i, layer] of layers) {
    if (layer.type !== 'box' && layer.type !== 'card') continue;
    const base = '/layers/' + i;
    reference(layer.stepId, steps, base + '/stepId');
    if (layer.id === captions?.id) add(base + '/id', 'ID_DUPLICATE', '标注和说明卡不得与字幕图层重名。');
    if (layer.type === 'box') {
      reference(layer.target, elements, base + '/target');
      const availability = stepVisibility.get(layer.stepId);
      if (availability) needsVisibility(layer.target, layer.anchor === 'start' ? availability.start : availability.verified, base + '/target');
    }
    if (layer.type === 'card' && layer.anchor === 'start' && typeof layer.text === 'string' && resultStatement.test(layer.text)) {
      add(base + '/anchor', 'RESULT_TOO_EARLY', '结果说明必须在结果验证后出现。');
    }
  }
  return [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()];
}

export function currentPlan(repository: StudioRepository, projectId: string): PlanRecord {
  const plan = repository.getPlan(projectId);
  if (!plan) throw new PlanError('VALIDATION_FAILED', '找不到此项目。', 404);
  return plan;
}

export function currentProfile(repository: StudioRepository, projectId: string) {
  return resolveProfile(repository.getSettings('global')?.values, repository.getSettings('project:' + projectId)?.values);
}

// 调用方在更新需求范围或当前源码的同一事务内调用。
export function invalidatePlan(repository: StudioRepository, projectId: string, updatedAt: string): void {
  const plan = currentPlan(repository, projectId);
  const body = planObject(plan.body);
  const result = repository.compareAndSavePlan({ projectId, expectedEditToken: plan.editToken,
    sourceArtifactId: plan.sourceArtifactId, body: plan.body,
    state: body && Object.keys(body).length > 0 ? 'needs_update' : 'draft', updatedAt });
  if (!result.saved) throw new PlanError('EDIT_CONFLICT', '方案已被其他操作修改，请重新读取。', 409);
}

export function createPlanService(repository: StudioRepository) {
  function read(projectId: string) {
    const plan = currentPlan(repository, projectId);
    const profile = currentProfile(repository, projectId);
    const draft = planObject(plan.body);
    const issues = validatePlan(draft ? { ...draft, profile } : plan.body);
    if (typeof draft?.projectId === 'string' && draft.projectId !== projectId) {
      issues.push({ path: '/projectId', code: 'REFERENCE_MISSING', message: '方案不属于此项目。' });
    }
    if (plan.state === 'needs_update') {
      issues.push({ path: '/source', code: 'PLAN_STALE', message: '项目范围或当前源码已变更，请核对并保存方案。' });
    }
    return { projectId, draft: plan.body, state: plan.state, issues, editToken: plan.editToken,
      sourceArtifactId: plan.sourceArtifactId, updatedAt: plan.updatedAt };
  }
  return {
    read,
    save(projectId: string, draft: unknown, ifMatch: string | null) {
      if (!ifMatch) throw new PlanError('EDIT_PRECONDITION_REQUIRED', '保存方案必须提供 If-Match。', 428);
      if (!planObject(draft)) throw new PlanError('VALIDATION_FAILED', '方案草稿必须是对象。', 422, '/draft');
      repository.transaction((tx) => {
        currentPlan(tx, projectId);
        if (tx.listTasks(projectId).some(({ state }) => activeStates.has(state))) {
          throw new PlanError('RESOURCE_BUSY', '该项目已有任务正在执行。', 409);
        }
        const result = tx.compareAndSavePlan({
          projectId, expectedEditToken: ifMatch.replace(/^"([^"\s]+)"$/, '$1'), body: draft, state: 'draft',
          sourceArtifactId: tx.getProject(projectId)!.currentSourceId, updatedAt: new Date().toISOString(),
        });
        if (!result.saved) throw new PlanError('EDIT_CONFLICT', '方案已被其他操作修改，请重新读取。', 409);
      });
      return read(projectId);
    },
  };
}
