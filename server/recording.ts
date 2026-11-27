import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { strFromU8 } from 'fflate';
import { openSourceArchive, sourceArchiveLimit } from './artifacts.js';
import { checkCaptureManifest, currentPlan, currentProfile, planObject, PlanError, validatePlan } from './plans.js';
import { checkSpeech, prepareSpeech, probeCapture } from './recording-media.js';
import { recordingResults, type Audio, type RecordingPlan } from './recording-results.js';
import { compileInputs } from './scripts.js';
import { resolveSpeech } from './settings.js';
import type { ArtifactRecord, StudioRepository, TaskRecord } from './store/repository.js';
import { isDeepStrictEqual } from 'node:util';
import { desktopSpawnSpec, desktopWorkerAlive, runDesktopWorker, type WorkerTimings } from './workers.js';

export type RecordingTarget = { url: string; framePath: string | null; data?: { statePath: string; seedPath: string } };
export type ResolveTarget = (projectId: string, sourceId: string) => Promise<RecordingTarget>;
export type RecordingOptions = {
  resolveTarget?: ResolveTarget;
  spawnSpec?: typeof desktopSpawnSpec;
  prepareSpeech?: typeof prepareSpeech;
  probeCapture?: typeof probeCapture;
  timings?: WorkerTimings;
  workerAlive?: (pid: number, taskId: string) => boolean | Promise<boolean>;
};
type RecordRequest = { requestId: string; planToken: string; scriptArtifactId: string };
type RecordInput = ReturnType<typeof compileInputs> & { scriptArtifactId: string; rawArtifactId: string; captureArtifactId: string };
type RecordState = 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
type Output = { artifact: ArtifactRecord; path: string; partialPath: string };
const activeStates = new Set(['queued', 'running', 'waiting_input', 'cancelling']);
const outputInvalid = () => new PlanError('OUTPUT_INVALID', '无法发布录制交接成果，请检查存储与采集结果。');
const busy = () => new PlanError('RESOURCE_BUSY', '当前桌面已被录制占用或正在等待上次录制收尾，请稍后手动重试。', 409);
const stalePlan = () => new PlanError('PLAN_STALE', '当前方案或源码已变更，请保存方案并重新生成脚本。', 409, 'planToken');
const staleScript = () => new PlanError('SCRIPT_STALE', '脚本与当前方案或源码不匹配，请重新生成脚本。', 409, 'scriptArtifactId');
const now = () => new Date().toISOString();

function requestBody(body: unknown): RecordRequest {
  const fields = planObject(body);
  const valid = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (!fields || Object.keys(fields).length !== 3 || !valid(fields.requestId) ||
      !valid(fields.planToken) || !valid(fields.scriptArtifactId)) {
    throw new PlanError('VALIDATION_FAILED', '录制请求需要有效的 requestId、planToken 和 scriptArtifactId。');
  }
  return fields as RecordRequest;
}

async function readArchive(repository: StudioRepository, projectId: string, id: string, kind: 'source' | 'script', error: () => PlanError) {
  try {
    const file = repository.getArtifactPath(projectId, id);
    if (!file || file.artifact.kind !== kind || file.artifact.state !== 'available') throw error();
    const info = await stat(file.path);
    if (!info.isFile() || !info.size || info.size !== file.artifact.bytes || info.size > sourceArchiveLimit) throw error();
    const bytes = await readFile(file.path);
    if (bytes.byteLength !== info.size) throw error();
    return { artifact: file.artifact, bytes };
  } catch { throw error(); }
}

function checkScript(bytes: Uint8Array, input: ReturnType<typeof compileInputs>) {
  try {
    const { files } = openSourceArchive(bytes, new Map([['manifest.json', 128_000], ['plan.json', 2_000_000], ['preparation.json', 512_000]]));
    const read = (name: string) => JSON.parse(strFromU8(files[name]!));
    const plan = read('plan.json');
    if (!isDeepStrictEqual(read('manifest.json'), input.manifest) || !isDeepStrictEqual(read('preparation.json'), input.preparation) ||
        !planObject(plan) || validatePlan(plan).length || !isDeepStrictEqual({ ...plan, profile: input.plan.profile }, input.plan)) {
      throw staleScript();
    }
  } catch { throw staleScript(); }
}

function recordOutput(repository: StudioRepository, task: TaskRecord, id: string, kind: 'capture' | 'media'): Output {
  const relativePath = kind === 'capture' ? 'capture/' + id + '.mp4' : 'media/' + id + '.json';
  const path = repository.getNewArtifactPath(task.projectId, relativePath);
  return { path, partialPath: path + '.partial', artifact: { id, relativePath, kind, taskId: task.id, projectId: task.projectId,
    mime: kind === 'capture' ? 'video/mp4' : 'application/json', bytes: 0, state: 'pending',
    metadata: kind === 'capture' ? {} : { subtype: 'capture_manifest' }, createdAt: task.createdAt } };
}

function fileSize(path: string): number {
  const info = lstatSync(path, { throwIfNoEntry: false });
  return info?.isFile() ? info.size : 0;
}

export function createRecordingService(repository: StudioRepository, resolveTarget: ResolveTarget, options: RecordingOptions = {}) {
  const jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let desktopOwner: string | undefined;
  let closing = false;
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined;

  function terminal(tx: StudioRepository, task: TaskRecord, state: RecordState, output: Record<string, unknown>) {
    const endedAt = now();
    const project = tx.getProject(task.projectId)!;
    tx.updateProject({ ...project, stage: state === 'succeeded' ? 'media' : 'plan', updatedAt: endedAt });
    tx.saveTask({ ...task, state, phase: state === 'succeeded' ? 'complete' : state, endedAt, runtime: null,
      ...(state === 'succeeded' ? { result: output } : { error: output }) });
    tx.appendEvent({ taskId: task.id, type: 'task.' + state, payload: output, createdAt: endedAt });
  }

  function phase(taskId: string, name: string, label: string, stage?: string) {
    repository.transaction((tx) => {
      const task = tx.getTask(taskId)!;
      if (task.state !== 'running' || task.phase === name) return;
      if (stage) tx.updateProject({ ...tx.getProject(task.projectId)!, stage, updatedAt: now() });
      tx.saveTask({ ...task, phase: name });
      tx.appendEvent({ taskId, type: 'task.phase', payload: { phase: name, label }, createdAt: now() });
    });
  }

  function base(task: TaskRecord, input: RecordInput, rawId?: string) {
    return { kind: 'capture', projectId: task.projectId, taskId: task.id, scriptArtifactId: input.scriptArtifactId,
      sourceArtifactId: input.manifest.sourceArtifactId, plan: input.plan, ...(rawId ? { rawArtifactId: rawId } : {}) };
  }

  function finalize(tx: StudioRepository, output: Output, available: boolean) {
    const state = available ? 'available' : 'partial';
    const size = fileSize(output.partialPath);
    if (available && !size) throw outputInvalid();
    if (available) renameSync(output.partialPath, output.path);
    const artifact = tx.finalizeArtifact(output.artifact.id, size ? state : 'missing', size,
      size && !available ? output.artifact.relativePath + '.partial' : undefined);
    tx.appendEvent({ taskId: artifact.taskId!, type: 'artifact.created',
      payload: { artifactId: artifact.id, kind: artifact.kind, state: artifact.state }, createdAt: now() });
  }

  async function endIncomplete(task: TaskRecord, state: Exclude<RecordState, 'succeeded'>, error: PlanError, audio: Audio[] = []) {
    const input = task.input as RecordInput;
    const raw = recordOutput(repository, task, input.rawArtifactId, 'capture');
    const manifest = recordOutput(repository, task, input.captureArtifactId, 'media');
    for (const output of [raw, manifest]) {
      if (!fileSize(output.partialPath) && fileSize(output.path)) renameSync(output.path, output.partialPath);
    }
    const document = { ...base(task, input, fileSize(raw.partialPath) ? raw.artifact.id : undefined), complete: false,
      ...(audio.length ? { audio } : {}) };
    if (!checkCaptureManifest(document)) throw outputInvalid();
    const temporary = manifest.partialPath + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(document), { flag: 'wx' });
      renameSync(temporary, manifest.partialPath);
    } finally {
      await rm(temporary, { force: true });
    }
    repository.transaction((tx) => {
      finalize(tx, raw, false);
      finalize(tx, manifest, false);
      const field = input.plan && (input.plan as unknown as RecordingPlan).steps?.findIndex(({ id }) => id === error.field);
      const latestEvents = tx.listEvents(task.id, Math.max(0, tx.getLastEventSeq(task.id) - 1000), 1000).reverse();
      const lastStep = latestEvents.find(({ type }) => type === 'step.finished');
      const failedStep = latestEvents.find(({ type }) => type === 'step.failed');
      const observed = planObject(error.cause)?.checks ?? planObject(failedStep?.payload)?.checks;
      const primitive = (value: unknown) => value === null || ['number', 'string', 'boolean'].includes(typeof value);
      const checks = Array.isArray(observed) ? observed.flatMap((entry) => {
        const check = planObject(entry);
        return check?.passed === false && typeof check.target === 'string' && primitive(check.expected) && primitive(check.actual)
          ? [{ target: check.target, expected: check.expected, actual: check.actual }] : [];
      }) : [];
      terminal(tx, tx.getTask(task.id)!, state, { code: error.code, message: error.message,
        field: typeof field === 'number' && field >= 0 ? '/steps/' + field : error.field,
        retryable: false, captureArtifactId: manifest.artifact.id,
        ...(checks.length ? { checks } : {}),
        ...(lastStep ? { lastCompletedStepId: planObject(lastStep.payload)?.stepId } : {}),
        ...(fileSize(raw.partialPath) ? { rawArtifactId: raw.artifact.id } : {}) });
    });
  }

  async function prepareAudio(task: TaskRecord, plan: RecordingPlan, speech: ReturnType<typeof resolveSpeech>, signal: AbortSignal, audio: Audio[]) {
    for (const line of plan.narration) {
      signal.throwIfAborted();
      const id = 'a-' + randomUUID();
      const relativePath = 'media/' + id + '.mp3';
      const path = repository.getNewArtifactPath(task.projectId, relativePath);
      const temporary = path + '.partial';
      let published = false;
      try {
        const clip = await (options.prepareSpeech ?? prepareSpeech)({ text: line.text, outputPath: temporary, speech, signal });
        signal.throwIfAborted();
        checkSpeech(clip);
        const bytes = fileSize(temporary);
        if (!bytes) throw outputInvalid();
        renameSync(temporary, path);
        repository.transaction((tx) => {
          tx.registerArtifact({ id, taskId: task.id, projectId: task.projectId, relativePath, kind: 'media', mime: 'audio/mpeg',
            bytes, state: 'available', createdAt: now(), metadata: { subtype: 'recording_speech', narrationId: line.id } });
          tx.appendEvent({ taskId: task.id, type: 'artifact.created', payload: { artifactId: id, kind: 'media' }, createdAt: now() });
        });
        published = true;
        audio.push({ narrationId: line.id, artifactId: id, ...clip });
      } catch {
        throw new PlanError('RENDER_FAILED', '录前语音或字幕准备失败，请检查 edge-tts、ffprobe、网络及所选音色。');
      } finally {
        if (!published) await Promise.allSettled([temporary, path].map((file) => rm(file, { force: true })));
      }
    }
  }

  async function run(task: TaskRecord, input: RecordInput, raw: Output, manifest: Output, speech: ReturnType<typeof resolveSpeech>, signal: AbortSignal) {
    const plan = input.plan as unknown as RecordingPlan;
    const audio: Audio[] = [];
    const results = recordingResults(plan, audio);
    let workerState: 'failed' | 'interrupted' | 'cancelled' | undefined;
    try {
      await prepareAudio(task, plan, speech, signal, audio);
      signal.throwIfAborted();
      if (desktopOwner || hasOrphans()) throw busy();
      desktopOwner = task.id;
      phase(task.id, 'desktop_preparation', '正在检查录制环境');
      const spec = (options.spawnSpec ?? desktopSpawnSpec)();
      const target = await (options.resolveTarget ?? resolveTarget)(task.projectId, input.manifest.sourceArtifactId);
      signal.throwIfAborted();
      let lastCheckpoint = 0;
      const worker = await runDesktopWorker({ taskId: task.id, signal, spec, timings: options.timings,
        payload: { manifest: input.manifest, plan: input.plan, effectiveProfile: input.plan.profile,
          preparation: input.preparation, target, audio, capturePath: raw.partialPath },
        stepBudget(stepId) {
          const step = plan.steps.find(({ id }) => id === stepId);
          if (!step) return 25_000;
          const profile = input.plan.profile as ReturnType<typeof currentProfile>;
          const inputMs = step.actions.reduce((total, action) => total + profile.moveMs + profile.preClickMs +
            3000 + (action.text?.length ?? 0) * 800 + (action.op === 'refresh' ? step.timeoutMs : 0), 0);
          const lines = new Set(plan.narration.filter((line) => line.stepId === stepId).map(({ id }) => id));
          const speechMs = audio.filter((clip) => lines.has(clip.narrationId)).reduce((sum, clip) => sum + clip.durationMs, 0);
          return 25_000 + inputMs + step.timeoutMs + step.holdMs + speechMs;
        },
        onSpawn(pid) {
          const createdAt = now();
          repository.saveTask({ ...repository.getTask(task.id)!, runtime: { pid, role: 'desktop', createdAt } });
        },
        onHeartbeat() {
          if (Date.now() - lastCheckpoint < 2000) return;
          lastCheckpoint = Date.now();
          const latest = repository.getTask(task.id)!;
          repository.saveTask({ ...latest, runtime: { ...planObject(latest.runtime), lastHeartbeat: now() } });
        },
        onEvent(event) {
          results.accept(event);
          if (event.type === 'ready') phase(task.id, 'desktop_ready', '桌面已就绪，正在准备首帧', 'recording');
          if (event.type === 'capture.started') phase(task.id, 'capture', '正在采集桌面');
          if (event.type === 'step.started') phase(task.id, 'step:' + String(event.payload.stepId), '正在执行步骤 ' + String(event.payload.stepId));
          if (event.type === 'step.finished') {
            phase(task.id, 'finished:' + String(event.payload.stepId), '已完成步骤 ' + String(event.payload.stepId));
          }
          repository.appendEvent({ taskId: task.id, type: event.type, payload: event.payload, createdAt: now() });
        },
      });
      if (worker.state !== 'finished') {
        workerState = worker.state;
        throw worker.error ?? new PlanError('TASK_CANCELLED', '录制已停止。');
      }
      signal.throwIfAborted();
      phase(task.id, 'capture_probe', '正在检查原片并登记成果');
      if (!fileSize(raw.partialPath)) throw outputInvalid();
      const video = await (options.probeCapture ?? probeCapture)(raw.partialPath, signal);
      const document = results.complete(base(task, input, raw.artifact.id), audio, video);
      await writeFile(manifest.partialPath, JSON.stringify(document), { flag: 'wx' });
      signal.throwIfAborted();
      repository.transaction((tx) => {
        finalize(tx, raw, true);
        finalize(tx, manifest, true);
        terminal(tx, tx.getTask(task.id)!, 'succeeded', { rawArtifactId: raw.artifact.id, captureArtifactId: manifest.artifact.id });
      });
    } catch (error) {
      const state = workerState === 'interrupted' ? 'interrupted' : signal.aborted || workerState === 'cancelled' ? 'cancelled' : 'failed';
      const failure = state === 'cancelled' ? new PlanError('TASK_CANCELLED', '录制已停止。')
        : error instanceof PlanError ? error : outputInvalid();
      await endIncomplete(task, state, failure, audio).catch(() => markInterrupted(task, outputInvalid()));
    } finally {
      if (desktopOwner === task.id) desktopOwner = undefined;
    }
  }

  function markInterrupted(task: TaskRecord, error: PlanError) {
    repository.transaction((tx) => {
      for (const artifact of tx.listArtifacts(task.projectId).filter((entry) => entry.taskId === task.id && entry.state === 'pending')) {
        let size = 0;
        try {
          const output = recordOutput(tx, task, artifact.id, artifact.kind === 'capture' ? 'capture' : 'media');
          if (!fileSize(output.partialPath) && fileSize(output.path)) renameSync(output.path, output.partialPath);
          size = fileSize(output.partialPath);
        } catch {
          // 文件无法安全读取或改名时仍收尾索引，避免占住项目执行权。
        }
        tx.finalizeArtifact(artifact.id, size ? 'partial' : 'missing', size, size ? artifact.relativePath + '.partial' : undefined);
      }
      terminal(tx, tx.getTask(task.id)!, 'interrupted', { code: error.code, message: error.message, retryable: false });
    });
  }

  function staleTasks() {
    return repository.listProjects().flatMap(({ id }) => repository.listTasks(id))
      .filter((task) => task.kind === 'record' && activeStates.has(task.state) && !jobs.has(task.id));
  }
  const recovering = new Map<string, Promise<void>>();
  function hasOrphans() {
    return Boolean(recovering.size || staleTasks().length);
  }
  function recover() {
    const stale = staleTasks();
    for (const task of stale) {
      if (recovering.has(task.id)) continue;
      const recovery = (async () => {
        const pid = planObject(task.runtime)?.pid;
        if (typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 &&
            await (options.workerAlive ?? desktopWorkerAlive)(pid, task.id)) return;
        const error = new PlanError('TASK_INTERRUPTED', '工作台重启中断了录制，请人工重新开始。');
        await endIncomplete(task, 'interrupted', error).catch(() => markInterrupted(task, error));
      })().finally(() => recovering.delete(task.id));
      recovering.set(task.id, recovery);
      void recovery.catch(() => {});
    }
    if (stale.length && !closing) recoveryTimer = setTimeout(recover, 500);
  }
  recover();

  function prior(projectId: string, request: RecordRequest) {
    const existing = repository.getTaskByRequest(projectId, request.requestId);
    if (!existing) return null;
    if (existing.kind !== 'record' || !isDeepStrictEqual(existing.request, { operation: 'record', ...request })) {
      throw new PlanError('REQUEST_CONFLICT', '同一 requestId 已用于不同录制请求。', 409);
    }
    return { taskId: existing.id, state: existing.state };
  }

  function current(projectId: string, request: RecordRequest) {
    const plan = currentPlan(repository, projectId);
    const project = repository.getProject(projectId)!;
    const sourceId = project.currentSourceId;
    const requirements = repository.listRequirements(projectId);
    if (plan.state !== 'ready' || plan.editToken !== request.planToken || !sourceId || plan.sourceArtifactId !== sourceId ||
        ['requirements', 'system'].includes(project.stage) || requirements.some((item) => !item.confirmed)) throw stalePlan();
    const script = repository.getArtifact(request.scriptArtifactId);
    const metadata = planObject(script?.metadata);
    if (script?.kind !== 'script' || script.projectId !== projectId || script.state !== 'available' ||
        metadata?.sourceArtifactId !== sourceId || metadata.planToken !== request.planToken) throw staleScript();
    return { plan, sourceId, profile: currentProfile(repository, projectId) };
  }

  return {
    async startRecording(projectId: string, body: unknown) {
      const request = requestBody(body);
      const previous = prior(projectId, request);
      if (previous) return previous;
      if (closing || hasOrphans()) throw busy();
      const { plan, sourceId, profile } = current(projectId, request);
      const speech = resolveSpeech(profile, {});
      if (repository.listTasks(projectId).some(({ state }) => activeStates.has(state))) throw busy();
      const [source, script] = await Promise.all([
        readArchive(repository, projectId, sourceId, 'source', () => new PlanError('SOURCE_CHECK_FAILED', '当前源码文件不可用。')),
        readArchive(repository, projectId, request.scriptArtifactId, 'script', staleScript),
      ]);
      const metadata = planObject(source.artifact.metadata);
      if ((metadata?.sourceKind !== 'generated' && metadata?.sourceKind !== 'imported') || typeof metadata.adapterId !== 'string') {
        throw new PlanError('SOURCE_CHECK_FAILED', '当前源码缺少有效的项目适配器。');
      }
      const sourceRef = { projectId, artifactId: sourceId, planToken: request.planToken, kind: metadata.sourceKind,
        adapterId: metadata.adapterId, archive: source.bytes, confirmedRequirementIds: repository.listConfirmedRequirementIds(projectId) } as const;
      const input: RecordInput = { ...compileInputs(plan.body, sourceRef, profile), scriptArtifactId: request.scriptArtifactId,
        rawArtifactId: 'a-' + randomUUID(), captureArtifactId: 'a-' + randomUUID() };
      checkScript(script.bytes, input);
      const task: TaskRecord = { id: 't-' + randomUUID(), projectId, kind: 'record', state: 'running', phase: 'speech_preparation',
        input, requestId: request.requestId, request: { operation: 'record', ...request }, createdAt: now(), startedAt: now() };
      const raw = recordOutput(repository, task, input.rawArtifactId, 'capture');
      const manifest = recordOutput(repository, task, input.captureArtifactId, 'media');
      raw.artifact.metadata = { captureArtifactId: input.captureArtifactId };
      const accepted = repository.transaction((tx) => {
        const previous = prior(projectId, request);
        if (previous) return previous;
        const latest = current(projectId, request);
        if (!isDeepStrictEqual(latest.profile, profile)) throw new PlanError('EDIT_CONFLICT', '录制设置已变更，请核对生效设置后重新开始。', 409);
        if (closing || tx.listTasks(projectId).some(({ state }) => activeStates.has(state))) throw busy();
        tx.saveTask(task);
        tx.registerArtifact(raw.artifact);
        tx.registerArtifact(manifest.artifact);
        tx.appendEvent({ taskId: task.id, type: 'task.started', payload: { state: task.state }, createdAt: now() });
        tx.appendEvent({ taskId: task.id, type: 'task.phase',
          payload: { phase: task.phase, label: '正在合成讲解并测量实际时长' }, createdAt: now() });
        return { taskId: task.id, state: task.state };
      });
      if (accepted.taskId === task.id) {
        const controller = new AbortController();
        const done = Promise.resolve().then(() => run(task, input, raw, manifest, speech, controller.signal)).finally(() => jobs.delete(task.id));
        jobs.set(task.id, { controller, done });
        void done.catch(() => {});
      }
      return accepted;
    },
    cancel(task: TaskRecord) {
      const job = jobs.get(task.id);
      if (!job || !activeStates.has(task.state)) return false;
      if (task.state === 'running') repository.transaction((tx) => {
        tx.saveTask({ ...task, state: 'cancelling', phase: 'cancelling' });
        tx.appendEvent({ taskId: task.id, type: 'task.phase', payload: { phase: 'cancelling', label: '正在停止录制并封闭原片' }, createdAt: now() });
      });
      job.controller.abort();
      return true;
    },
    async close() {
      closing = true;
      clearTimeout(recoveryTimer);
      for (const [id, job] of jobs) {
        const task = repository.getTask(id);
        if (task && activeStates.has(task.state)) {
          repository.saveTask({ ...task, state: 'cancelling', phase: 'cancelling' });
          job.controller.abort();
        }
      }
      await Promise.allSettled([...recovering.values(), ...[...jobs.values()].map(({ done }) => done)]);
    },
  };
}
