import { randomUUID } from 'node:crypto';
import type { AiInput, AiPurpose, ResolvedConnection, ToolCallContext } from '../ai/contracts.js';
import { AiTaskError } from '../ai/contracts.js';
import type {
  ArtifactRecord,
  ConnectionRecord,
  ConversationRecord,
  MessageRecord,
  ProjectRecord,
  StudioRepository,
  TaskRecord,
} from '../store/repository.js';
import type { TaskService, TaskState } from '../tasks.js';
import { artifactAvailability, createArtifactService } from '../artifacts.js';
import { invalidatePlan, PlanError, planObject } from '../plans.js';
import { requirementsReady } from '../requirements.js';
import { buildSystemSource } from '../system-source.js';

const activeStates = new Set(['queued', 'running', 'waiting_input', 'cancelling']);
const supportedPurposes = new Set<AiPurpose>(['discuss', 'requirements', 'system', 'plan']);

export type HttpServiceError = Error & {
  code: string;
  statusCode: number;
  field?: string;
  retryable?: boolean;
  taskId?: string;
};

export type ProjectAdapterContext = {
  defaultConnection?: ResolvedConnection;
  getProjectRoot?: (projectId: string) => string;
  skill?: { name: string; text: string; digest: string };
  systemSourceBuilder?: typeof buildSystemSource;
  buildContext?: (project: ProjectRecord, conversation: ConversationRecord, messages: MessageRecord[]) => AiInput['context'] | Promise<AiInput['context']>;
  tools?: { call(name: string, args: unknown, context: ToolCallContext): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }> };
};

export type ProjectsService = ReturnType<typeof createProjectsService>;

export function createProjectsService(
  repository: StudioRepository,
  tasks: TaskService,
  adapters: ProjectAdapterContext = {},
  retirePreview?: (projectId: string) => Promise<void>,
) {
  const defaultConnection: ResolvedConnection = adapters.defaultConnection ?? {
    id: 'codex-local', kind: 'codex', provider: 'codex', model: '',
  };
  ensureDefaultConnection(repository, defaultConnection);
  const artifacts = createArtifactService(repository);

  return {
    createProject(body: unknown) {
      const input = asRecord(body);
      const title = requiredText(input.title, 'title', 80);
      const brief = requiredText(input.brief, 'brief', 12_000);
      const connectionId = optionalId(input.connectionId, 'connectionId');
      if (connectionId && !repository.getConnection(connectionId)) {
        throw httpError('VALIDATION_FAILED', 422, '找不到此连接。', 'connectionId');
      }
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: `p-${randomUUID()}`, title, brief, stage: 'requirements', connectionId,
        currentSourceId: null, currentVideoId: null, createdAt: now, updatedAt: now,
      };
      repository.saveProject(project);
      return projectDto(repository, project, defaultConnection.id);
    },

    listProjects() {
      return repository.listProjects().map((project) => projectDto(repository, project, defaultConnection.id));
    },

    getProject(projectId: string) {
      const project = repository.getProject(projectId);
      if (!project) throw httpError('VALIDATION_FAILED', 404, '找不到此项目。');
      return projectDto(repository, project, defaultConnection.id);
    },

    updateProject(projectId: string, body: unknown) {
      const current = repository.getProject(projectId);
      if (!current) throw httpError('VALIDATION_FAILED', 404, '找不到此项目。');
      if (repository.listTasks(projectId).some((task) => activeStates.has(task.state))) {
        throw httpError('RESOURCE_BUSY', 409, '项目有任务正在执行，暂时不能修改。');
      }
      const input = asRecord(body);
      const title = input.title === undefined ? current.title : requiredText(input.title, 'title', 80);
      const brief = input.brief === undefined ? current.brief : requiredText(input.brief, 'brief', 12_000);
      let connectionId = current.connectionId;
      if (input.connectionId !== undefined) {
        connectionId = optionalId(input.connectionId, 'connectionId');
        if (connectionId && !repository.getConnection(connectionId)) {
          throw httpError('VALIDATION_FAILED', 422, '找不到此连接。', 'connectionId');
        }
      }
      const updated = repository.transaction((tx) => {
        const updatedAt = new Date().toISOString();
        const scopeChanged = brief !== current.brief;
        if (scopeChanged) {
          tx.clearRequirementConfirmations(projectId);
          invalidatePlan(tx, projectId, updatedAt);
        }
        return tx.updateProject({ ...current, title, brief, connectionId,
          stage: scopeChanged ? 'requirements' : current.stage, updatedAt });
      });
      return projectDto(repository, updated, defaultConnection.id);
    },

    listMessages(projectId: string, query: URLSearchParams) {
      const project = repository.getProject(projectId);
      if (!project) throw httpError('VALIDATION_FAILED', 404, '找不到此项目。');
      const conversationId = query.get('conversationId') || currentConversation(repository, project, defaultConnection.id);
      if (!conversationId) return { items: [], nextAfterId: null };
      const conversation = repository.getConversation(conversationId, projectId);
      if (!conversation) throw httpError('VALIDATION_FAILED', 404, '找不到此项目的对话。');
      const afterId = query.get('afterId');
      const limit = parseLimit(query.get('limit'), 50, 200);
      const items = repository.listMessages(conversation.id, afterId, limit);
      return { conversationId, items, nextAfterId: items.at(-1)?.id ?? null };
    },

    async postMessage(projectId: string, body: unknown) {
      const project = repository.getProject(projectId);
      if (!project) throw httpError('VALIDATION_FAILED', 404, '找不到此项目。');
      const input = asRecord(body);
      const requestId = requiredId(input.requestId, 'requestId', 128);
      if (typeof input.purpose !== 'string' || !supportedPurposes.has(input.purpose as AiPurpose)) {
        throw httpError('VALIDATION_FAILED', 422, 'purpose 无效。', 'purpose');
      }
      const purpose = input.purpose as AiPurpose;
      const text = requiredText(input.text, 'text', 12_000);
      const connectionId = optionalId(input.connectionId, 'connectionId') ?? project.connectionId ?? defaultConnection.id;
      const connection = repository.getConnection(connectionId);
      if (!connection?.enabled || connection.kind !== 'codex_app_server') throw httpError('CONNECTION_UNAVAILABLE', 503, '所选连接不可用。');
      const request = {
        operation: 'POST /projects/:id/messages',
        conversationId: input.conversationId ?? null,
        purpose,
        text,
        connectionId: input.connectionId ?? null,
      };
      const existing = repository.getTaskByRequest(projectId, requestId);
      if (existing) {
        if (stableStringify(existing.request) !== stableStringify(request)) {
          throw httpError('REQUEST_CONFLICT', 409, '同一 requestId 已用于不同请求。');
        }
        return acceptedTask(existing);
      }
      if (repository.listTasks(projectId).some((task) => activeStates.has(task.state))) {
        throw httpError('RESOURCE_BUSY', 409, '该项目已有任务正在执行。');
      }
      const requirements = repository.listRequirements(projectId);
      if (purpose === 'system' && !requirementsReady(requirements)) {
        throw httpError('REQUIREMENTS_UNCONFIRMED', 422, '请先在工作台确认全部制作条款。');
      }
      const now = new Date().toISOString();
      let conversation: ConversationRecord;
      if (input.conversationId !== undefined) {
        const conversationId = requiredId(input.conversationId, 'conversationId', 128);
        const found = repository.getConversation(conversationId, projectId);
        if (!found) throw httpError('VALIDATION_FAILED', 404, '找不到此项目的对话。');
        if (found.connectionId !== connectionId) throw httpError('REQUEST_CONFLICT', 409, '更换连接后需新建对话。');
        conversation = { ...found, updatedAt: now };
      } else {
        conversation = {
          id: `c-${randomUUID()}`, projectId, connectionId, nativeSessionRef: null,
          contextSummary: null, createdAt: now, updatedAt: now,
        };
      }
      const message: MessageRecord = {
        id: `m-${randomUUID()}`, conversationId: conversation.id, taskId: null,
        role: 'user', text, toolCallId: null, state: 'pending', createdAt: now,
      };
      const task: TaskRecord = {
        id: `t-${randomUUID()}`, projectId, conversationId: conversation.id, connectionId,
        kind: 'ai', purpose, state: 'queued', phase: 'queued', input: { messageId: message.id },
        runtime: null, result: null, error: null, waitingInput: null,
        requestId, request, createdAt: now, startedAt: null, endedAt: null,
      };
      const messages = [...repository.listMessages(conversation.id), { ...message, taskId: task.id }];
      const plan = purpose === 'plan' ? repository.getPlan(projectId) : null;
      const context = await buildContext(adapters, project, conversation, messages);
      context.requirements = requirements.filter(({ confirmed }) => confirmed)
        .map(({ id, text, outcome, sourceRef }) => ({ id, text, outcome, sourceRef }));
      if (plan) context.currentPlan = plan.body;
      const aiInput: AiInput = {
        taskId: task.id,
        projectId,
        conversationId: conversation.id,
        purpose,
        messageId: message.id,
        context,
        nativeSessionRef: conversation.nativeSessionRef,
        limits: { maxSteps: 30, timeoutMs: 260_000, maxOutputBytes: 1_048_576 },
      };
      if (purpose === 'requirements' && !aiInput.context.attachmentIndex?.length) {
        throw httpError('VALIDATION_FAILED', 422, '请先上传附件并等待提取成功。');
      }
      task.input = { messageId: message.id, purpose, text,
        ...(purpose === 'system' ? { requirements: context.requirements } : {}) };
      const duplicate = repository.transaction((tx) => {
        const previous = tx.getTaskByRequest(projectId, requestId);
        if (previous) {
          if (stableStringify(previous.request) !== stableStringify(request)) {
            throw httpError('REQUEST_CONFLICT', 409, '同一 requestId 已用于不同请求。');
          }
          return previous;
        }
        if (JSON.stringify(tx.getConnection(connectionId)) !== JSON.stringify(connection)) {
          throw httpError('EDIT_CONFLICT', 409, '任务所用连接已变更，请重试。');
        }
        if (tx.listTasks(projectId).some((entry) => activeStates.has(entry.state))) {
          throw httpError('RESOURCE_BUSY', 409, '该项目已有任务正在执行。');
        }
        const latestProject = tx.getProject(projectId)!;
        if (purpose === 'system' && (latestProject.brief !== project.brief
          || latestProject.currentSourceId !== project.currentSourceId
          || JSON.stringify(tx.listRequirements(projectId)) !== JSON.stringify(requirements))) {
          throw httpError('EDIT_CONFLICT', 409, '制作范围或当前源码已变更，请重新发起生成。');
        }
        if (plan && (latestProject.currentSourceId !== project.currentSourceId || tx.getPlan(projectId)?.editToken !== plan.editToken)) {
          throw httpError('PLAN_STALE', 409, '当前方案或源码已改变，请重新读取。');
        }
        const updatedProject = { ...latestProject, updatedAt: now };
        tx.updateProject(updatedProject);
        tx.saveConversation(conversation);
        tx.saveTask(task);
        tx.saveMessage({ ...message, taskId: task.id });
        tx.appendEvent({ taskId: task.id, type: 'task.started', payload: { state: 'queued' }, createdAt: now });
        return null;
      });
      if (duplicate) return acceptedTask(duplicate);
      try {
        await tasks.startAi(aiInput);
        const current = tasks.get(task.id);
        const runningTask: TaskRecord = {
          ...task,
          state: current.state === 'queued' ? 'running' : current.state,
          phase: current.state === 'queued' ? 'running' : current.state,
          startedAt: now,
        };
        repository.saveTask(runningTask);
        void finishTask(repository, tasks, artifacts, adapters.systemSourceBuilder ?? buildSystemSource, runningTask, conversation, message,
          retirePreview);
        return acceptedTask(runningTask);
      } catch (error) {
        const failure = mapTaskError(error);
        const failedAt = new Date().toISOString();
        repository.transaction((tx) => {
          tx.saveTask({ ...task, state: 'failed', phase: 'failed', error: failure, endedAt: failedAt });
          tx.saveMessage({ ...message, taskId: task.id, state: 'complete' });
          tx.appendEvent({ taskId: task.id, type: 'task.failed', payload: failure, createdAt: failedAt });
        });
        throw httpError(failure.code, statusForCode(failure.code), failure.message, undefined, failure.retryable, task.id);
      }
    },

    getTask(taskId: string) {
      const task = repository.getTask(taskId);
      if (!task) throw httpError('VALIDATION_FAILED', 404, '找不到此任务。');
      return taskDto(repository, task);
    },

    async respondInput(taskId: string, body: unknown) {
      const stored = repository.getTask(taskId);
      if (!stored) throw httpError('VALIDATION_FAILED', 404, '找不到此任务。');
      if (stored.state !== 'waiting_input') throw httpError('REQUEST_CONFLICT', 409, '任务当前没有等待人工输入。');
      const input = asRecord(body);
      const requestId = requiredId(input.requestId, 'requestId', 128);
      const response = permissionResponse(stored.waitingInput, input);
      let summary;
      try { summary = await tasks.respondInput(taskId, requestId, response); }
      catch (error) {
        const failure = mapTaskError(error);
        throw httpError(failure.code, statusForCode(failure.code), failure.message, undefined, failure.retryable, taskId);
      }
      const now = new Date().toISOString();
      const updated: TaskRecord = { ...stored, state: summary.state, phase: 'running', waitingInput: null };
      repository.transaction((tx) => {
        tx.saveTask(updated);
        tx.appendEvent({ taskId, type: 'task.phase', payload: { phase: 'running', label: '已提交人工输入' }, createdAt: now });
      });
      return taskDto(repository, updated);
    },

    async cancelTask(taskId: string) {
      const stored = repository.getTask(taskId);
      if (!stored) throw httpError('VALIDATION_FAILED', 404, '找不到此任务。');
      if (isTerminal(stored.state)) return { statusCode: 200, data: taskDto(repository, stored) };
      let summary;
      try { summary = await tasks.cancel(taskId); }
      catch { throw httpError('WORKER_LOST', 409, '当前服务未持有此任务，需先核对任务状态。', undefined, true, taskId); }
      const latest = repository.getTask(taskId) ?? stored;
      // 模型返回后，系统任务仍可能处在源码构建和发布阶段。
      if (isTerminal(latest.state) || (isTerminal(summary.state)
        && !(latest.purpose === 'system' && summary.state === 'succeeded'))) {
        return { statusCode: 200, data: taskDto(repository, latest) };
      }
      if (latest.state === 'cancelling') return { statusCode: 202, data: taskDto(repository, latest) };
      const now = new Date().toISOString();
      const updated: TaskRecord = { ...latest, state: 'cancelling', phase: 'cancelling' };
      repository.transaction((tx) => {
        tx.saveTask(updated);
        tx.appendEvent({ taskId, type: 'task.phase', payload: { phase: 'cancelling', label: '正在停止' }, createdAt: now });
      });
      return { statusCode: 202, data: taskDto(repository, updated) };
    },

    listArtifacts(projectId: string, kind?: string) {
      const project = repository.getProject(projectId);
      if (!project) throw httpError('VALIDATION_FAILED', 404, '找不到此项目。');
      if (kind && !['attachment', 'source', 'plan', 'script', 'capture', 'media', 'video', 'log'].includes(kind)) {
        throw httpError('VALIDATION_FAILED', 422, '成果类型无效。', 'kind');
      }
      const plan = repository.getPlan(projectId);
      return repository.listArtifacts(projectId, kind as ArtifactRecord['kind'] | undefined)
        .filter((artifact) => artifact.kind !== 'source' || artifact.state !== 'available' || artifact.id === project.currentSourceId)
        .map((artifact) => {
          const dto = artifactDto(artifactAvailability(repository, artifact));
          if (artifact.kind === 'source' || artifact.kind === 'video') {
            return { ...dto, current: artifact.id === (artifact.kind === 'source' ? project.currentSourceId : project.currentVideoId) };
          }
          if (artifact.kind === 'script') {
            const metadata = planObject(artifact.metadata);
            const stale = plan?.state !== 'ready' || metadata?.planToken !== plan.editToken
              || !project.currentSourceId || metadata?.sourceArtifactId !== project.currentSourceId;
            return { ...dto, stale };
          }
          if (artifact.kind !== 'attachment' || !artifact.taskId) return dto;
          const task = repository.getTask(artifact.taskId);
          return { ...dto, extractionState: task?.state ?? null, extractionError: task?.error ?? null };
        });
    },

    getArtifact(projectId: string, artifactId: string, download: boolean) {
      let file;
      try { file = repository.getArtifactPath(projectId, artifactId); }
      catch { throw httpError('VALIDATION_FAILED', 404, '找不到此项目中的文件。'); }
      if (!file || (file.artifact.state !== 'available' && !(download && file.artifact.state === 'partial'))) {
        throw httpError('VALIDATION_FAILED', 404, '此文件当前不可读取。');
      }
      return file;
    },
  };
}

async function buildContext(
  adapters: ProjectAdapterContext,
  project: ProjectRecord,
  conversation: ConversationRecord,
  messages: MessageRecord[],
): Promise<AiInput['context']> {
  if (adapters.buildContext) return adapters.buildContext(project, conversation, messages);
  return {
    instruction: '你是 AI Demo Studio 的需求讨论助手。依据项目描述和对话回答，不要声称已完成演示系统。',
    brief: `${project.title}\n\n${project.brief}`,
    requirements: [],
    messages: messages.slice(-50).map(({ role, text }) => ({ role: role === 'assistant' ? 'assistant' : 'user', text })),
    fileIndex: [],
    skill: adapters.skill ?? { name: 'bid-demo-system', text: '', digest: '' },
    toolNames: ['get_demo_brief', 'load_bid_demo_system_skill', 'get_current_source'],
  };
}

async function finishTask(
  repository: StudioRepository,
  tasks: TaskService,
  artifacts: ReturnType<typeof createArtifactService>,
  buildSource: typeof buildSystemSource,
  task: TaskRecord,
  conversation: ConversationRecord,
  userMessage: MessageRecord,
  retirePreview?: (projectId: string) => Promise<void>,
): Promise<void> {
  try {
    const summary = await tasks.wait(task.id);
    const result = tasks.getResult(task.id);
    const now = new Date().toISOString();
    let state = summary.state;
    let failure = summary.error;
    if (state === 'succeeded' && result) {
      const assistant: MessageRecord = {
        id: `m-${randomUUID()}`, conversationId: conversation.id, taskId: task.id, role: 'assistant',
        text: result.delivery?.kind === 'requirements'
          ? [result.reply, '待人工确认的需求条目', ...result.delivery.items.map((item, index) =>
            [`${index + 1}. ${item.text}`, `预期结果：${item.outcome}`, item.sourceRef
              ? `出处：${item.sourceRef.artifactId} ${item.sourceRef.locator}\n${item.sourceRef.quote}` : '来源：项目描述或对话'].join('\n')
          )].join('\n\n') : result.reply,
        toolCallId: null, state: 'complete', createdAt: now,
      };
      const complete = (tx: StudioRepository, sourceArtifactId?: string) => {
        const completedAt = new Date().toISOString();
        const current = tx.getTask(task.id)!;
        tx.saveConversation({ ...conversation, nativeSessionRef: result.nativeSessionRef || conversation.nativeSessionRef, updatedAt: completedAt });
        tx.saveMessage({ ...userMessage, taskId: task.id, state: 'complete' });
        tx.saveMessage(assistant);
        tx.saveTask({ ...current, state: 'succeeded', phase: 'complete', waitingInput: null,
          result: sourceArtifactId ? { reply: result.reply, sourceArtifactId } : result, endedAt: completedAt });
        tx.appendEvent({ taskId: task.id, type: 'task.succeeded',
          payload: { messageId: assistant.id, ...(sourceArtifactId ? { sourceArtifactId } : {}) }, createdAt: completedAt });
      };
      if (task.purpose !== 'system') {
        repository.transaction((tx) => complete(tx));
        return;
      }
      try {
        if (repository.getTask(task.id)?.state === 'running') {
          if (result.delivery?.kind !== 'system') throw new PlanError('OUTPUT_INVALID', '生成任务没有交付可发布的系统。');
          repository.transaction((tx) => {
            tx.saveTask({ ...tx.getTask(task.id)!, phase: 'build_system' });
            tx.appendEvent({ taskId: task.id, type: 'task.phase',
              payload: { phase: 'build_system', label: '正在构建源码包' }, createdAt: now });
          });
          const file = await buildSource(result.delivery);
          if (repository.getTask(task.id)?.state === 'running') {
            const artifact = await artifacts.publishArtifact(task.id, file, (tx, entry) => complete(tx, entry.id));
            if (artifact.state === 'available') {
              await retirePreview?.(task.projectId).catch(() => {
                console.error('已发布源码，旧预览未能完整清理。');
              });
              return;
            }
          }
        }
      } catch (error) {
        failure = error instanceof PlanError ? { code: error.code, message: error.message, retryable: false }
          : { code: 'OUTPUT_INVALID', message: '无法完成系统源码的构建或发布。', retryable: true };
      }
      state = 'failed';
    } else if (state === 'succeeded') {
      state = 'failed';
      failure = { code: 'OUTPUT_INVALID', message: '任务未返回有效结果。', retryable: false };
    }
    repository.transaction((tx) => {
      const current = tx.getTask(task.id)!;
      if (state !== 'interrupted' && current.state === 'cancelling') state = 'cancelled';
      const error = state === 'cancelled' ? { code: 'TASK_CANCELLED', message: '任务已停止。', retryable: false }
        : failure ?? { code: 'WORKER_LOST', message: '任务未能完成。', retryable: true };
      const endedAt = new Date().toISOString();
      tx.saveMessage({ ...userMessage, taskId: task.id, state: 'complete' });
      tx.saveTask({ ...current, state, phase: state, waitingInput: null, error, endedAt });
      tx.appendEvent({ taskId: task.id, type: 'task.' + state, payload: error, createdAt: endedAt });
    });
  } catch {
    // 终态持久化失败时保持原任务记录，后续 GET/SSE 可继续揭示最后一次成功写入。
  }
}

function ensureDefaultConnection(repository: StudioRepository, connection: ResolvedConnection): ConnectionRecord {
  const found = repository.getConnection(connection.id);
  if (found) return found;
  const now = new Date().toISOString();
  return repository.saveConnection({
    id: connection.id, name: '本机 Codex', kind: 'codex_app_server', provider: connection.provider,
    model: connection.model || null, baseUrl: connection.baseUrl ?? null, credentialRef: null,
    options: {}, enabled: true, createdAt: now, updatedAt: now,
  });
}

function currentConversation(repository: StudioRepository, project: ProjectRecord, defaultConnectionId: string) {
  return repository.listConversations(project.id).find((item) => item.connectionId === (project.connectionId ?? defaultConnectionId))?.id ?? null;
}

function projectDto(repository: StudioRepository, project: ProjectRecord, defaultConnectionId: string) {
  const tasks = repository.listTasks(project.id);
  return {
    id: project.id,
    title: project.title,
    brief: project.brief,
    stage: project.stage,
    connectionId: project.connectionId,
    currentSourceId: project.currentSourceId,
    currentVideoId: project.currentVideoId,
    currentConversationId: currentConversation(repository, project, defaultConnectionId),
    activeTasks: tasks.filter((task) => activeStates.has(task.state)).map((task) => task.id),
    latestRecordingTaskId: tasks.find((task) => task.kind === 'record')?.id ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function acceptedTask(task: TaskRecord) {
  return {
    taskId: task.id,
    projectId: task.projectId,
    conversationId: task.conversationId,
    state: task.state,
    requestId: task.requestId,
  };
}

function taskDto(repository: StudioRepository, task: TaskRecord) {
  return {
    taskId: task.id,
    projectId: task.projectId,
    conversationId: task.conversationId ?? null,
    kind: task.kind,
    purpose: task.purpose ?? null,
    state: task.state,
    phase: task.phase,
    result: task.result,
    error: task.error,
    lastSeq: repository.getLastEventSeq(task.id),
    createdAt: task.createdAt,
    startedAt: task.startedAt ?? null,
    endedAt: task.endedAt ?? null,
  };
}

function artifactDto(artifact: ArtifactRecord) {
  return {
    id: artifact.id, projectId: artifact.projectId, taskId: artifact.taskId ?? null,
    kind: artifact.kind, mime: artifact.mime, bytes: artifact.bytes, state: artifact.state,
    metadata: artifact.metadata, createdAt: artifact.createdAt,
  };
}

function mapTaskError(error: unknown) {
  if (error instanceof AiTaskError) return { code: error.code, message: error.message, retryable: error.retryable };
  const candidate = error as { code?: string; message?: string; retryable?: boolean };
  return { code: candidate?.code ?? 'CONNECTION_UNAVAILABLE', message: candidate?.message ?? 'AI 任务执行失败。', retryable: candidate?.retryable ?? true };
}

function permissionResponse(waitingInput: unknown, input: Record<string, unknown>): unknown {
  if (input.response !== undefined) {
    if (!input.response || typeof input.response !== 'object' || Array.isArray(input.response)) {
      throw httpError('VALIDATION_FAILED', 422, 'response 必须是 JSON 对象。', 'response');
    }
    return input.response;
  }
  const choice = typeof input.choice === 'string' ? input.choice : '';
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  const waiting = waitingInput && typeof waitingInput === 'object' ? waitingInput as Record<string, unknown> : {};
  const options = Array.isArray(waiting.options) ? waiting.options.filter((option): option is string => typeof option === 'string') : [];
  const questions = Array.isArray(waiting.questions) ? waiting.questions.filter((question): question is Record<string, unknown> =>
    Boolean(question && typeof question === 'object' && !Array.isArray(question))) : [];
  if (questions.length > 0) {
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const id = typeof question.id === 'string' ? question.id : '';
      const questionOptions = Array.isArray(question.options) ? question.options.filter((item): item is { label: string } =>
        Boolean(item && typeof item === 'object' && typeof (item as Record<string, unknown>).label === 'string')) : [];
      const selected = questionOptions.some((item) => item.label === choice) ? choice
        : question.isOther === true && text ? text
          : questionOptions.length === 0 && text ? text : '';
      if (!id || !selected) throw httpError('VALIDATION_FAILED', 422, '请为所有问题提供有效答案。', 'choice');
      answers[id] = { answers: [selected] };
    }
    return { answers };
  }
  if (!choice || !options.includes(choice)) throw httpError('VALIDATION_FAILED', 422, '请选择一个有效选项。', 'choice');
  return { decision: choice };
}

function httpError(code: string, statusCode: number, message: string, field?: string, retryable = false, taskId?: string): HttpServiceError {
  return Object.assign(new Error(message), { code, statusCode, ...(field ? { field } : {}), retryable, ...(taskId ? { taskId } : {}) });
}

function statusForCode(code: string): number {
  if (code === 'AUTH_REQUIRED') return 401;
  if (code === 'CONNECTION_UNAVAILABLE' || code === 'WORKER_LOST') return 503;
  if (['RESOURCE_BUSY', 'EDIT_CONFLICT', 'REQUEST_CONFLICT', 'PLAN_STALE'].includes(code)) return 409;
  return 422;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw httpError('VALIDATION_FAILED', 422, `${field} 必填且不能超过 ${max} 个字符。`, field);
  }
  return value.trim();
}

function requiredId(value: unknown, field: string, max = 100): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) || value.length > max) {
    throw httpError('VALIDATION_FAILED', 422, `${field} 格式无效。`, field);
  }
  return value;
}

function optionalId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredId(value, field);
}

function parseLimit(value: string | null, fallback: number, maximum: number): number {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) throw httpError('VALIDATION_FAILED', 400, 'limit 必须是非负整数。', 'limit');
  return Math.max(1, Math.min(maximum, Number(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError('VALIDATION_FAILED', 422, '请求内容必须是 JSON 对象。');
  return value as Record<string, unknown>;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortValue(nested)]));
  }
  return value;
}

function isTerminal(state: TaskState): boolean {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
}
