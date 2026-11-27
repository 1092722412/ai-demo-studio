import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, zipSync } from 'fflate';
import { createArtifactService, isSourcePath, openSourceArchive, recoverZipPublications, sourceArchiveLimit } from './artifacts.js';
import { checkPreparation, checkScriptManifest, currentPlan, currentProfile, planObject, PlanError, supportedActions, validatePlan } from './plans.js';
import type { StudioRepository, TaskRecord } from './store/repository.js';
import { generatedStateLimit } from './system-source.js';

type SourceRef = {
  projectId: string;
  artifactId: string;
  planToken: string;
  kind: 'generated' | 'imported';
  adapterId: string;
  archive: Uint8Array;
  confirmedRequirementIds?: readonly string[];
};

export type Preparation = { mode: 'projectData'; strategy: 'keep' | 'seed' | 'custom'; state?: unknown };
export type Manifest = {
  kind: 'script'; projectId: string; sourceArtifactId: string; planToken: string;
  entry: 'execute.py'; planFile: 'plan.json'; preparationFile: 'preparation.json'; supportedActions: readonly string[];
};
export type ScriptPackage = { manifest: Manifest; archive: Uint8Array };

const activeStates = new Set(['queued', 'running', 'waiting_input', 'cancelling']);
const maxReferenceBytes = 500_000;
const templateFiles = ['execute.py', 'README.md', 'requirements.txt'] as const;

function rejectSource(message: string, field?: string): never {
  throw new PlanError('SOURCE_CHECK_FAILED', message, 422, field);
}

function containsFragment(bytes: Uint8Array, fragment: string): boolean {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const escaped = fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?<![\\p{L}\\p{N}_$-])' + escaped + '(?![\\p{L}\\p{N}_$-])', 'u').test(text);
  } catch {
    return false;
  }
}

export function compileInputs(draft: unknown, source: SourceRef, profile: unknown) {
  const planFields = planObject(draft);
  const plan = { ...planFields, profile };
  const [issue] = validatePlan(plan);
  if (issue) throw new PlanError('VALIDATION_FAILED', issue.message, 422, issue.path);
  if (planFields!.projectId !== source.projectId) rejectSource('方案与源码不属于同一项目。', '/projectId');
  const planSource = planFields!.source as { kind: string; adapterId: string };
  if (planSource.kind !== source.kind || planSource.adapterId !== source.adapterId) {
    rejectSource('方案的来源类型或适配器与当前源码不一致。', '/source');
  }
  const data = planFields!.data as { resetStrategy: Preparation['strategy']; state?: unknown };
  const preparation: Preparation = { mode: 'projectData', strategy: data.resetStrategy };
  if (preparation.strategy !== 'keep' && (source.kind !== 'generated' || source.adapterId !== 'generated-local-node')) {
    rejectSource('当前项目适配器仅支持保留演示数据。', '/data/resetStrategy');
  }
  if (preparation.strategy === 'custom') {
    preparation.state = data.state;
    if (strToU8(JSON.stringify(preparation.state)).byteLength > generatedStateLimit) {
      rejectSource('自定义演示状态超过生成系统支持的大小。', '/data/state');
    }
  }
  if (!checkPreparation(preparation)) rejectSource('数据准备策略不符合执行交接契约。', '/data');
  const seedPath = 'seed/state.json';
  const confirmed = new Set(source.confirmedRequirementIds);
  const filesToRead = new Map<string, number>();
  const features = planFields!.features as Array<{ sourceRef: string; requirementId?: string }>;
  const references = features.map((feature, i) => {
    const [path, ...fragment] = feature.sourceRef.split('#');
    const field = '/features/' + i + '/sourceRef';
    if (!path || !isSourcePath(path) || fragment.length > 1 || (fragment.length && !fragment[0]?.trim())) {
      rejectSource('功能引用必须指向当前源码包中的文件。', field);
    }
    filesToRead.set(path, maxReferenceBytes);
    return { path, fragment: fragment[0], field };
  });
  if (preparation.strategy === 'seed') filesToRead.set(seedPath, generatedStateLimit);
  const { files } = openSourceArchive(source.archive, filesToRead);
  if (preparation.strategy === 'seed') {
    try {
      if (!Object.hasOwn(files, seedPath)) throw new Error();
      const seed = JSON.parse(strFromU8(files[seedPath]!));
      if (!planObject(seed) && !Array.isArray(seed)) throw new Error();
    } catch {
      rejectSource('当前源码缺少有效的 seed/state.json。', '/data/resetStrategy');
    }
  }
  for (const { path, fragment, field } of references) {
    if (!Object.hasOwn(files, path) || (fragment && !containsFragment(files[path]!, fragment))) {
      rejectSource('当前源码包缺少所引用的文件或文本片段。', field);
    }
  }
  for (const [i, feature] of features.entries()) {
    if (feature.requirementId && !confirmed.has(feature.requirementId)) {
      rejectSource('功能关联的条款尚未由人工确认。', '/features/' + i + '/requirementId');
    }
  }
  const manifest: Manifest = { kind: 'script', projectId: source.projectId, sourceArtifactId: source.artifactId,
    planToken: source.planToken, entry: 'execute.py', planFile: 'plan.json', preparationFile: 'preparation.json', supportedActions };
  if (!checkScriptManifest(manifest)) throw new PlanError('OUTPUT_INVALID', '脚本清单不符合执行交接契约。');
  return { plan, preparation, manifest };
}

async function packageScript({ plan, preparation, manifest }: ReturnType<typeof compileInputs>): Promise<ScriptPackage> {
  const templates = await Promise.all(templateFiles.map(async (name) =>
    [name, await readFile(fileURLToPath(new URL('../template/automation/' + name, import.meta.url)))] as const));
  const json = (value: unknown) => strToU8(JSON.stringify(value, null, 2) + '\n');
  const archive = zipSync({
    ...Object.fromEntries(templates),
    'plan.json': json(plan), 'preparation.json': json(preparation), 'manifest.json': json(manifest),
  });
  return { manifest, archive };
}

export async function compileScript(plan: unknown, sourceRef: SourceRef, profile: unknown): Promise<ScriptPackage> {
  return packageScript(compileInputs(plan, sourceRef, profile));
}

// 脚本只包含当前进程内的文件操作，重启时无须等待外部 Worker。
export function recoverScriptPublications(repository: StudioRepository): void {
  recoverZipPublications(repository, 'script', (task) => task.kind === 'script', '脚本生成因工作台重启中断，请重新生成。');
}

export function createScriptService(repository: StudioRepository) {
  const artifacts = createArtifactService(repository);
  const jobs = new Map<string, Promise<void>>();

  function priorRequest(projectId: string, requestId: string) {
    const existing = repository.getTaskByRequest(projectId, requestId);
    if (!existing) return null;
    if (existing.kind !== 'script' || planObject(existing.request)?.operation !== 'compile_script') {
      throw new PlanError('REQUEST_CONFLICT', '同一 requestId 已用于不同请求。', 409);
    }
    return { taskId: existing.id, state: existing.state };
  }

  function finish(tx: StudioRepository, task: TaskRecord, state: 'succeeded' | 'failed' | 'cancelled',
    payload: Record<string, unknown>) {
    const now = new Date().toISOString();
    tx.saveTask({ ...task, state, phase: state === 'succeeded' ? 'complete' : state, endedAt: now,
      ...(state === 'succeeded' ? { result: payload } : { error: payload }) });
    tx.appendEvent({ taskId: task.id, type: 'task.' + state, payload, createdAt: now });
  }

  async function run(task: TaskRecord, input: ReturnType<typeof compileInputs>) {
    try {
      const { manifest, archive } = await packageScript(input);
      if (repository.getTask(task.id)?.state === 'running') {
        const artifact = await artifacts.publishArtifact(task.id, { kind: 'script', mime: 'application/zip',
          extension: '.zip', bytes: archive, metadata: manifest }, (tx, file) => {
          if (tx.getProject(task.projectId)?.currentSourceId !== manifest.sourceArtifactId
              || !tx.markPlanReady(task.projectId, manifest.planToken, manifest.sourceArtifactId)) {
            throw new PlanError('PLAN_STALE', '当前方案或源码已改变。', 409);
          }
          const project = tx.getProject(task.projectId)!;
          tx.updateProject({ ...project, stage: 'plan', updatedAt: new Date().toISOString() });
          finish(tx, task, 'succeeded', { artifactId: file.id, manifest });
        });
        if (artifact.state === 'available') return;
      }
      repository.transaction((tx) => finish(tx, task, 'cancelled',
        { code: 'TASK_CANCELLED', message: '脚本生成已停止。', retryable: false }));
    } catch (error) {
      repository.transaction((tx) => {
        if (tx.getTask(task.id)?.state === 'cancelling') {
          finish(tx, task, 'cancelled', { code: 'TASK_CANCELLED', message: '脚本生成已停止。', retryable: false });
          return;
        }
        const payload = error instanceof PlanError ? { code: error.code, message: error.message, field: error.field }
          : { code: 'OUTPUT_INVALID', message: '无法完成脚本打包。' };
        finish(tx, task, 'failed', { ...payload, retryable: false });
      });
    }
  }

  return {
    async start(projectId: string, body: unknown) {
      const request = planObject(body);
      const requestId = request?.requestId;
      if (!request || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
          || Object.keys(request).length !== 1) {
        throw new PlanError('VALIDATION_FAILED', '脚本生成请求必须包含有效的 requestId。', 422, 'requestId');
      }
      const reused = priorRequest(projectId, requestId);
      if (reused) return reused;
      const plan = currentPlan(repository, projectId);
      const [issue] = validatePlan({ ...planObject(plan.body), profile: currentProfile(repository, projectId) });
      if (issue) throw new PlanError('VALIDATION_FAILED', issue.message, 422, issue.path);
      if (repository.listTasks(projectId).some(({ state }) => activeStates.has(state))) {
        throw new PlanError('RESOURCE_BUSY', '该项目已有任务正在执行。', 409);
      }
      const project = repository.getProject(projectId)!;
      const sourceId = project.currentSourceId;
      if (!sourceId) rejectSource('请先发布当前项目的源码。');
      if (project.stage === 'requirements' || project.stage === 'system') {
        throw new PlanError('PLAN_STALE', '请先确认范围并为当前范围发布源码。', 409);
      }
      if (plan.state === 'needs_update' || plan.sourceArtifactId !== sourceId) {
        throw new PlanError('PLAN_STALE', '请依据当前源码重新核对并保存方案。', 409);
      }
      let source;
      try { source = repository.getArtifactPath(projectId, sourceId); }
      catch { rejectSource('当前源码路径超出项目边界。'); }
      if (!source || source.artifact.kind !== 'source' || source.artifact.state !== 'available') {
        rejectSource('当前源码文件不可用。');
      }
      const metadata = planObject(source.artifact.metadata);
      const kind = metadata?.sourceKind;
      const adapterId = metadata?.adapterId;
      if ((kind !== 'generated' && kind !== 'imported') || typeof adapterId !== 'string') {
        rejectSource('当前源码缺少来源类型或适配器。');
      }
      let archive;
      try {
        const info = await stat(source.path);
        if (info.size > sourceArchiveLimit || info.size !== source.artifact.bytes) rejectSource('当前源码大小超限或已改变。');
        archive = await readFile(source.path);
      } catch (error) {
        if (error instanceof PlanError) throw error;
        rejectSource('当前源码文件不可用。');
      }
      const profile = currentProfile(repository, projectId);
      const input = compileInputs(plan.body, { projectId, artifactId: sourceId, planToken: plan.editToken,
        kind, adapterId, archive, confirmedRequirementIds: repository.listConfirmedRequirementIds(projectId) }, profile);
      const now = new Date().toISOString();
      const task: TaskRecord = { id: 't-' + randomUUID(), projectId, kind: 'script', state: 'running', phase: 'compile_script',
        input: { manifest: input.manifest, profile }, requestId, request: { operation: 'compile_script' }, createdAt: now, startedAt: now };
      const accepted = repository.transaction((tx) => {
        const existing = priorRequest(projectId, requestId);
        if (existing) return existing;
        if (tx.getProject(projectId)?.currentSourceId !== sourceId || currentPlan(tx, projectId).editToken !== plan.editToken) {
          throw new PlanError('PLAN_STALE', '方案或源码已改变，请重新读取。', 409);
        }
        if (tx.listTasks(projectId).some(({ state }) => activeStates.has(state))) {
          throw new PlanError('RESOURCE_BUSY', '该项目已有任务正在执行。', 409);
        }
        tx.saveTask(task);
        tx.appendEvent({ taskId: task.id, type: 'task.started', payload: { state: task.state }, createdAt: now });
        return { taskId: task.id, state: task.state };
      });
      if (accepted.taskId === task.id) {
        const job = run(task, input).finally(() => jobs.delete(task.id));
        jobs.set(task.id, job);
        void job.catch(() => {});
      }
      return accepted;
    },
    cancel(task: TaskRecord) {
      if (!jobs.has(task.id) || (task.state !== 'running' && task.state !== 'cancelling')) return false;
      if (task.state === 'running') repository.transaction((tx) => {
        tx.saveTask({ ...task, state: 'cancelling', phase: 'cancelling' });
        tx.appendEvent({ taskId: task.id, type: 'task.phase', payload: { phase: 'cancelling' }, createdAt: new Date().toISOString() });
      });
      return true;
    },
    async close() { await Promise.allSettled(jobs.values()); },
  };
}
