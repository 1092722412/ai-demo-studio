import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Check, ChevronDown, CircleAlert, CircleCheck, Film, Layers3, LoaderCircle,
  MessageSquare, Monitor, Plus, ScanLine, Send, Settings, Sparkles, Square, X,
} from 'lucide-react';
import { api, isTaskActive } from './api';
import type { Attachment, Message, Project, Task, TaskEvent } from './api';
import { SettingsPanel } from './SettingsPanel';
import { RequirementsPanel } from './RequirementsPanel';
import { HandoffPanel, handoffTaskName } from './HandoffPanel';
import type { LocalPlanDraft } from './HandoffPanel';
import { useTaskEvents } from './useTaskEvents';
import './style.css';

type Brief = { title: string; requirement: string };
type Activity = { callId: string | null; label: string; status: 'running' | 'done' | 'failed' };
type View = 'build' | 'handoff' | 'settings';
type WaitingInput = {
  requestId: string;
  description: string;
  options: string[];
  questions: Array<{
    id: string;
    header: string;
    question: string;
    isOther: boolean;
    isSecret: boolean;
    options: Array<{ label: string; description: string }> | null;
  }>;
};

const emptyBrief: Brief = { title: '', requirement: '' };
const exampleBrief: Brief = {
  title: '访客预约演示',
  requirement: '填写访客姓名与来访事由。保存预约后立即显示在列表中，刷新页面确认仍可查询。首次打开时预约列表为空。',
};

function updateAddress(projectId: string | null) {
  const url = new URL(location.href);
  if (projectId) url.searchParams.set('project', projectId);
  else url.searchParams.delete('project');
  history.replaceState(null, '', url);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : '本地工作台请求失败。';
}

function Conversation({
  messages, task, activity, waitingInput, submitting, activityOpen, onActivityOpenChange, draft, onDraftChange, onSend, onCancel, onRespondInput,
}: {
  messages: Message[];
  task: Task | null;
  activity: Activity[];
  waitingInput: WaitingInput | null;
  submitting: boolean;
  activityOpen: boolean;
  onActivityOpenChange: (open: boolean) => void;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (event: FormEvent) => void;
  onCancel: () => void;
  onRespondInput: (value: { requestId: string; choice?: string; text?: string; response?: Record<string, unknown> }) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const [permissionChoice, setPermissionChoice] = useState('');
  const [permissionAnswers, setPermissionAnswers] = useState<Record<string, string>>({});
  const active = isTaskActive(task?.state);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages.length]);
  return <div className="conversation">
    <div className="panel-head"><h2><MessageSquare size={17} /> 需求讨论</h2></div>
    <div ref={log} className="chat-log" role="log" aria-label="项目对话">
      {messages.map((item) => <article key={item.id} className={'chat-message ' + item.role}>
        <strong>{item.role === 'user' ? '你' : item.role === 'assistant' ? 'Codex' : '工具'}</strong>
        <p>{item.text}</p>
      </article>)}
      {active && task?.state !== 'waiting_input' && <article className="chat-message assistant streaming">
        <strong>Codex</strong><p aria-live="polite">{activity.some((event) => event.label === '正在生成回复') ? '正在生成回复…' : '正在处理…'}</p>
      </article>}
    </div>
    <details className="activity" open={activityOpen} onToggle={(event) => onActivityOpenChange(event.currentTarget.open)}>
      <summary><ChevronDown size={14} aria-hidden="true" /><span>调用过程</span><small>{activity.length} 条</small></summary>
      <ul>{activity.length ? activity.map((event, index) => <li key={event.callId || `${event.label}-${index}`}>
        {event.status === 'running' ? <span className="activity-dot" aria-hidden="true" /> :
          event.status === 'done' ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
        <span>{event.label}</span><small>{event.status === 'running' ? '进行中' : event.status === 'done' ? '完成' : '失败'}</small>
      </li>) : <li className="activity-empty">暂无调用记录</li>}</ul>
    </details>
    <form className="chat-compose" onSubmit={onSend}>
      <textarea aria-label="给 Codex 的消息" placeholder="继续讨论需求、操作流程或预期结果…" value={draft}
        onChange={(event) => onDraftChange(event.target.value)} maxLength={6000} rows={2} disabled={active}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <button type="submit" className="button primary chat-send" disabled={active || !draft.trim()}>
        {active ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        {active ? task?.state === 'cancelling' ? '正在停止' : '处理中' : '发送'}
      </button>
    </form>
    <div role="status" className={active ? 'chat-send-status active' : 'chat-send-status'}>
      {task?.state === 'cancelling' ? '正在停止当前任务，确认收尾后会更新状态。' :
        task?.state === 'waiting_input' ? '任务正在等待人工输入。你可以停止本轮任务。' :
          active ? '消息已送达，Codex 正在处理。回复后可继续发送。' : ''}
    </div>
    {waitingInput && <form className="permission-input" onSubmit={(event) => {
      event.preventDefault();
      if (waitingInput.questions.length) {
        const answers = Object.fromEntries(waitingInput.questions.map((question) => [question.id, { answers: [permissionAnswers[question.id] || ''] }]));
        if (Object.values(answers).some((answer) => !answer.answers[0])) return;
        onRespondInput({ requestId: waitingInput.requestId, response: { answers } });
      } else if (permissionChoice) {
        onRespondInput({ requestId: waitingInput.requestId, choice: permissionChoice });
      }
    }}>
      <p>{waitingInput.description}</p>
      {waitingInput.questions.map((question) => <label key={question.id}>
        <span>{question.header || question.question}</span>
        {question.options?.length ? <select required value={permissionAnswers[question.id] ?? ''}
          onChange={(event) => setPermissionAnswers((current) => ({ ...current, [question.id]: event.target.value }))}>
          <option value="">请选择</option>
          {question.options.map((option) => <option key={option.label} value={option.label}>{option.label}</option>)}
        </select> : <input required type={question.isSecret ? 'password' : 'text'} value={permissionAnswers[question.id] ?? ''}
          onChange={(event) => setPermissionAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
      </label>)}
      {!waitingInput.questions.length && <label><span>选择操作</span><select required value={permissionChoice} onChange={(event) => setPermissionChoice(event.target.value)}>
        <option value="">请选择</option>{waitingInput.options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select></label>}
      <button type="submit" className="button secondary" disabled={submitting}>提交人工输入</button>
    </form>}
    {active && <button className="text-button cancel-task" type="button" onClick={onCancel} disabled={task?.state === 'cancelling'}>
      {task?.state === 'cancelling' ? <LoaderCircle className="spin" size={16} /> : <Square size={14} />}
      {task?.state === 'cancelling' ? '正在停止' : '停止本轮'}
    </button>}
  </div>;
}

function SourcePreview({ projectId, sourceId }: { projectId: string; sourceId: string }) {
  const [url, setUrl] = useState('');
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState('');

  async function open() {
    setOpening(true);
    setError('');
    try {
      const preview = await api.openPreview(projectId);
      setUrl(preview.previewUrl);
    } catch (reason) {
      setUrl('');
      setError(errorMessage(reason));
    } finally {
      setOpening(false);
    }
  }

  return <>
    <div className="panel-head preview-head">
      <h2 id="preview">系统源码</h2>
      <span className={url ? 'status ready' : 'status'}><i />{url ? '预览已启动' : '源码已登记'}</span>
      <div className="preview-actions">
        <button className="button secondary" type="button" disabled={opening} onClick={() => void open()}>
          {opening ? '正在打开…' : '打开预览'}
        </button>
        <a className="button" href={
          `/api/v1/artifacts/${encodeURIComponent(sourceId)}/content?projectId=${encodeURIComponent(projectId)}&download=1`
        }>下载当前源码</a>
      </div>
    </div>
    {error && <p className="notice preview-error" role="alert">{error}</p>}
    {url ? <div className="browser">
      <iframe title="当前系统预览" src={url} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" />
    </div> : <div className="empty-stage">
      <div className="stage-icon">{opening ? <LoaderCircle className="spin" size={36} /> : <Monitor size={38} />}</div>
    </div>}
  </>;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [brief, setBrief] = useState<Brief>(emptyBrief);
  const [messages, setMessages] = useState<Message[]>([]);
  const [task, setTask] = useState<Task | null>(null);
  const [waitingInput, setWaitingInput] = useState<WaitingInput | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<View>('build');
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [planDrafts, setPlanDrafts] = useState<Record<string, LocalPlanDraft>>({});
  const [proposalIds, setProposalIds] = useState<Record<string, string>>({});
  const selectedToken = useRef(0);
  const taskRef = useRef<Task | null>(null);
  useEffect(() => { taskRef.current = task; }, [task]);

  const refreshMessages = useCallback(async (projectId: string, conversationId?: string | null) => {
    const selection = selectedToken.current;
    const result = await api.listMessages(projectId, conversationId);
    if (selection !== selectedToken.current) return;
    setMessages(result.items);
    if (result.conversationId) {
      setProject((current) => current?.id === projectId ? { ...current, currentConversationId: result.conversationId! } : current);
    }
  }, []);

  const refreshProject = useCallback(async (projectId: string) => {
    const selection = selectedToken.current;
    const updated = await api.getProject(projectId);
    if (selection !== selectedToken.current) return;
    setProject((current) => current?.id === projectId ? updated : current);
    setProjects((items) => items.map((item) => item.id === projectId ? updated : item));
  }, []);

  const onTaskEvent = useCallback((event: TaskEvent) => {
    const currentTask = taskRef.current;
    if (currentTask?.taskId !== event.taskId) return;
    if (event.type === 'message.delta') {
      setActivity((current) => current.some((item) => item.label === '正在生成回复')
        ? current : [...current, { callId: null, label: '正在生成回复', status: 'running' }]);
    } else if (event.type === 'tool.started') {
      const callId = String(event.payload.callId ?? '');
      const label = String(event.payload.label ?? event.payload.name ?? '工具调用');
      setActivity((current) => {
        const found = current.findIndex((item) => item.callId === callId);
        const next = [...current];
        if (found >= 0) next[found] = { callId, label, status: 'running' };
        else next.push({ callId, label, status: 'running' });
        return next;
      });
    } else if (event.type === 'tool.finished') {
      const callId = String(event.payload.callId ?? '');
      setActivity((current) => {
        const found = current.findIndex((item) => item.callId === callId);
        if (found < 0) return [...current, { callId, label: String(event.payload.summary ?? '工具调用'), status: event.payload.ok === false ? 'failed' : 'done' }];
        const next = [...current];
        next[found] = { ...next[found], status: event.payload.ok === false ? 'failed' : 'done' };
        return next;
      });
    } else if (event.type === 'input.required') {
      setActivity((current) => [...current, { callId: null, label: '等待人工输入', status: 'running' }]);
      setWaitingInput({
        requestId: String(event.payload.requestId ?? ''),
        description: String(event.payload.description ?? 'Codex 需要人工输入。'),
        options: Array.isArray(event.payload.options) ? event.payload.options.filter((item): item is string => typeof item === 'string') : [],
        questions: Array.isArray(event.payload.questions) ? event.payload.questions as WaitingInput['questions'] : [],
      });
      if (currentTask) setTask({ ...currentTask, state: 'waiting_input' });
    } else if (event.type === 'task.phase') {
      const label = String(event.payload.label ?? event.payload.phase ?? '任务进度');
      setActivity((current) => [...current, { callId: null, label, status: 'running' }]);
      if (event.payload.phase === 'cancelling' && currentTask) setTask({ ...currentTask, state: 'cancelling' });
    } else if (['task.succeeded', 'task.failed', 'task.cancelled', 'task.interrupted'].includes(event.type)) {
      const state: Task['state'] = event.type === 'task.succeeded' ? 'succeeded'
        : event.type === 'task.cancelled' ? 'cancelled'
          : event.type === 'task.interrupted' ? 'interrupted' : 'failed';
      const selection = selectedToken.current;
      const finished = { ...currentTask, state, endedAt: event.at,
        result: state === 'succeeded' && currentTask.purpose !== 'plan' ? event.payload : currentTask.result,
        error: state === 'succeeded' ? null : {
          code: String(event.payload.code ?? state), message: String(event.payload.message ?? '任务未完成。'),
          retryable: event.payload.retryable === true,
          field: typeof event.payload.field === 'string' ? event.payload.field : undefined,
          lastCompletedStepId: typeof event.payload.lastCompletedStepId === 'string' ? event.payload.lastCompletedStepId : undefined,
          checks: Array.isArray(event.payload.checks) ? event.payload.checks : undefined,
        },
      };
      taskRef.current = finished;
      setTask(finished);
      const showError = (reason: unknown) => {
        if (selection === selectedToken.current && taskRef.current?.taskId === event.taskId) setError(errorMessage(reason));
      };
      if ((state === 'succeeded' && currentTask.kind === 'script') || currentTask.kind === 'record') {
        void refreshProject(currentTask.projectId).catch(showError);
      }
      setActivity((current) => current.map((item) => item.status === 'running' ? { ...item, status: state === 'failed' || state === 'interrupted' ? 'failed' : 'done' } : item));
      if (state === 'succeeded' && currentTask?.conversationId) {
        void refreshMessages(currentTask.projectId, currentTask.conversationId).catch(showError);
        if (currentTask.purpose === 'system') {
          void refreshProject(currentTask.projectId).catch(showError);
        }
      } else if (state === 'failed' || state === 'interrupted') {
        const payload = event.payload as { message?: unknown };
        if (typeof payload.message === 'string') setError(payload.message);
      }
      setWaitingInput(null);
      if (state === 'cancelled' && currentTask.kind !== 'record') setError('本轮任务已停止。');
    }
  }, [refreshMessages, refreshProject]);

  useTaskEvents(task && (!handoffTaskName(task) || isTaskActive(task.state)) ? task.taskId : null, onTaskEvent);

  useEffect(() => {
    let alive = true;
    void api.listProjects().then(async (items) => {
      if (!alive) return;
      setProjects(items);
      const initialId = new URLSearchParams(location.search).get('project');
      if (initialId && items.some((item) => item.id === initialId)) await selectProject(initialId);
    }).catch((reason) => { if (alive) setError(errorMessage(reason)); });
    return () => { alive = false; };
  }, []);

  async function selectProject(projectId: string) {
    if (project?.id === projectId) {
      setMenuOpen(false);
      return;
    }
    const token = ++selectedToken.current;
    setProject(null);
    setView('build');
    setMenuOpen(false);
    setSubmitting(true);
    taskRef.current = null;
    setError('');
    setTask(null);
    setWaitingInput(null);
    setActivity([]);
    setMessages([]);
    setDraft('');
    try {
      const selected = await api.getProject(projectId);
      if (token !== selectedToken.current) return;
      setProject(selected);
      setBrief({ title: selected.title, requirement: selected.brief });
      updateAddress(selected.id);
      await refreshMessages(selected.id, selected.currentConversationId);
      if (selected.activeTasks[0]) {
        const activeTask = await api.getTask(selected.activeTasks[0]);
        if (token === selectedToken.current && activeTask.projectId === projectId) {
          if (activeTask.purpose === 'plan') {
            setProposalIds((current) => ({ ...current, [projectId]: activeTask.taskId }));
          }
          taskRef.current = activeTask;
          setTask(activeTask);
          if (activeTask.kind === 'record') setView('handoff');
        }
      }
    } catch (reason) {
      if (token === selectedToken.current) setError(errorMessage(reason));
    } finally {
      if (token === selectedToken.current) setSubmitting(false);
    }
  }

  function newProject() {
    selectedToken.current++;
    taskRef.current = null;
    setSubmitting(false);
    setProject(null);
    setMessages([]);
    setTask(null);
    setWaitingInput(null);
    setActivity([]);
    setDraft('');
    setBrief(emptyBrief);
    setError('');
    setMenuOpen(false);
    setView('build');
    updateAddress(null);
  }

  async function submitMessage(text: string, currentProject: Project, conversationId?: string | null,
    purpose: 'discuss' | 'requirements' | 'system' = 'discuss') {
    const selection = selectedToken.current;
    const requestId = crypto.randomUUID();
    setSubmitting(true);
    setError('');
    setActivity([{ callId: null, label: '消息已提交', status: 'running' }]);
    try {
      const accepted = await api.postMessage(currentProject.id, {
        requestId,
        ...(conversationId ? { conversationId } : {}),
        purpose,
        text,
      });
      const updatedProject = { ...currentProject, currentConversationId: accepted.conversationId };
      if (selection !== selectedToken.current) return;
      setProject(updatedProject);
      setProjects((items) => [updatedProject, ...items.filter((item) => item.id !== updatedProject.id)]);
      await refreshMessages(currentProject.id, accepted.conversationId);
      const nextTask = await api.getTask(accepted.taskId);
      if (selection !== selectedToken.current) return;
      taskRef.current = nextTask;
      setTask(nextTask);
      setActivity([{ callId: null, label: '已发送给 Codex', status: 'running' }]);
    } catch (reason) {
      if (selection !== selectedToken.current) return;
      setError(errorMessage(reason));
      setActivity((items) => items.map((item) => item.status === 'running' ? { ...item, status: 'failed' } : item));
    } finally {
      if (selection === selectedToken.current) setSubmitting(false);
    }
  }

  async function startHandoff(start: () => Promise<{ taskId: string }>) {
    const selection = selectedToken.current;
    const projectId = project?.id;
    setSubmitting(true);
    setError('');
    setWaitingInput(null);
    setActivity([]);
    try {
      const { taskId } = await start();
      if (selection !== selectedToken.current) return;
      const next = await api.getTask(taskId);
      if (selection !== selectedToken.current || next.projectId !== projectId) return;
      taskRef.current = next;
      setTask(next);
      if (next.conversationId) {
        void refreshMessages(next.projectId, next.conversationId).catch((reason) => {
          if (selection === selectedToken.current && taskRef.current?.taskId === taskId) setError(errorMessage(reason));
        });
      }
      return taskId;
    } finally {
      if (selection === selectedToken.current) setSubmitting(false);
    }
  }

  function updatePlanDraft(projectId: string, update: (previous: LocalPlanDraft | null) => LocalPlanDraft | null) {
    setPlanDrafts((current) => {
      const next = { ...current };
      const draft = update(current[projectId] ?? null);
      if (draft) next[projectId] = draft;
      else delete next[projectId];
      return next;
    });
  }

  async function uploadAttachment(file: File, currentProject: Project) {
    const selection = selectedToken.current;
    setSubmitting(true);
    setError('');
    try {
      const accepted = await api.uploadAttachment(currentProject.id, file);
      const next = await api.getTask(accepted.taskId);
      if (selection !== selectedToken.current) return;
      setTask(next);
      taskRef.current = next;
    } catch (reason) {
      if (selection === selectedToken.current) setError(errorMessage(reason));
    } finally {
      if (selection === selectedToken.current) setSubmitting(false);
    }
  }

  async function startDiscussion(event: FormEvent) {
    event.preventDefault();
    if (submitting || isTaskActive(task?.state) || !brief.title.trim() || !brief.requirement.trim()) return;
    const selection = selectedToken.current;
    setSubmitting(true);
    setError('');
    try {
      const created = await api.createProject({ title: brief.title.trim(), brief: brief.requirement.trim() });
      if (selection !== selectedToken.current) return;
      setProject(created);
      setProjects((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      updateAddress(created.id);
      await submitMessage(brief.requirement.trim(), created);
    } catch (reason) {
      if (selection === selectedToken.current) setError(errorMessage(reason));
    } finally {
      if (selection === selectedToken.current) setSubmitting(false);
    }
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!project || submitting || isTaskActive(task?.state) || !text) return;
    setDraft('');
    await submitMessage(text, project, project.currentConversationId);
  }

  async function cancelTask() {
    if (!task || task.state === 'cancelling') return;
    const selection = selectedToken.current;
    try {
      const updated = await api.cancelTask(task.taskId);
      if (selection !== selectedToken.current || taskRef.current?.taskId !== updated.taskId
        || !isTaskActive(taskRef.current.state)) return;
      setTask(updated);
      taskRef.current = updated;
      if (updated.state === 'cancelling') setError('正在停止当前任务…');
    } catch (reason) {
      if (selection === selectedToken.current) setError(errorMessage(reason));
    }
  }

  async function respondInput(value: { requestId: string; choice?: string; text?: string; response?: Record<string, unknown> }) {
    if (!task) return;
    const selection = selectedToken.current;
    setSubmitting(true);
    try {
      const updated = await api.respondInput(task.taskId, value);
      if (selection !== selectedToken.current || taskRef.current?.taskId !== updated.taskId
        || !isTaskActive(taskRef.current.state)) return;
      setTask(updated);
      taskRef.current = updated;
      setWaitingInput(null);
      setError('');
    } catch (reason) {
      if (selection === selectedToken.current) setError(errorMessage(reason));
    } finally {
      if (selection === selectedToken.current) setSubmitting(false);
    }
  }

  async function saveBrief(event: FormEvent) {
    event.preventDefault();
    if (!project || isTaskActive(task?.state)) return;
    const selection = selectedToken.current;
    setSubmitting(true);
    try {
      const updated = await api.patchProject(project.id, { title: brief.title, brief: brief.requirement });
      if (selection !== selectedToken.current) return;
      setProject(updated);
      setProjects((items) => [updated, ...items.filter((item) => item.id !== updated.id)]);
      setError('需求已保存。');
    } catch (reason) {
      if (selection === selectedToken.current) setError(errorMessage(reason));
    } finally {
      if (selection === selectedToken.current) setSubmitting(false);
    }
  }

  const active = isTaskActive(task?.state);
  const changed = Boolean(project && (brief.title !== project.title || brief.requirement !== project.brief));
  const activeSteps = !project ? 0 : project.stage !== 'requirements' || task?.purpose === 'system' && active ? 2 : 1;

  return <div className="studio">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><ScanLine size={24} /><Sparkles size={10} /></span>AI Demo Studio</div>
      <div className="project-switch">
        <button className="project-button" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}
          onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false); }}>
          <span>{project?.title || '新建需求讨论'}</span><ChevronDown size={16} />
        </button>
        {menuOpen && <div className="projects">
          <button onClick={newProject}><Plus size={15} /> 新建讨论</button>
          {projects.map((item) => <button key={item.id} onClick={() => void selectProject(item.id)}>
            <span>{item.title}</span><small>{item.stage === 'requirements' ? '需求阶段' : item.stage}</small>
          </button>)}
        </div>}
      </div>
      <nav aria-label="工作台">
        <button className={view === 'build' ? 'nav-item active' : 'nav-item'} onClick={() => setView('build')}
          aria-current={view === 'build' ? 'page' : undefined}><Layers3 size={20} /> 需求与预览</button>
        <button className={view === 'handoff' ? 'nav-item active' : 'nav-item'} onClick={() => setView('handoff')}
          aria-current={view === 'handoff' ? 'page' : undefined}><Film size={20} /> 录制与审片</button>
        <button className={view === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setView('settings')}
          aria-current={view === 'settings' ? 'page' : undefined}><Settings size={20} /> 设置</button>
      </nav>
      <div className="local"><i />本地工作台</div>
    </aside>

    <main className="workspace">
      <header className="page-header">
        <h1>{view === 'build' ? '需求讨论与预览' : view === 'settings' ? '设置' : '录制与审片'}</h1>
        <span className="agent"><span />本机 Codex</span>
      </header>
      {view === 'build' ? <>
        <ol className="steps" aria-label="演示系统准备流程">
          {['描述需求', '讨论确认', '生成系统'].map((label, index) =>
            <li key={label} className={index === activeSteps ? 'current' : index < activeSteps ? 'done' : ''}
              aria-current={index === activeSteps ? 'step' : undefined}>
              <span className="step-dot">{index < activeSteps ? <Check size={15} /> : index + 1}</span>{label}
            </li>)}
        </ol>
        {(error || task?.error?.message) && <div className="notice" role="alert"><CircleAlert size={18} />{error || task?.error?.message}</div>}
        <div className="build-grid">
          <section className="panel requirements" aria-label={project ? '项目需求讨论' : '演示需求'}>
            {project ? <>
              <Conversation messages={messages} task={task} activity={activity} waitingInput={waitingInput} submitting={submitting} activityOpen={activityOpen}
                onActivityOpenChange={setActivityOpen} draft={draft} onDraftChange={setDraft}
                onSend={sendMessage} onCancel={() => void cancelTask()} onRespondInput={(value) => void respondInput(value)} />
              <Attachments key={project.id} projectId={project.id} task={task} busy={submitting || active}
                onUpload={(file) => void uploadAttachment(file, project)}
                onOrganize={() => void submitMessage('请读取本项目已提取的材料，整理需要演示的条目、预期结果及原文出处，供人工确认。', project, project.currentConversationId, 'requirements')} />
              <RequirementsPanel key={JSON.stringify([project.id, project.brief])} project={project}
                proposalTask={task?.purpose === 'requirements' && task.state === 'succeeded' ? task.taskId : undefined}
                busy={submitting || active || changed}
                onSaved={() => void refreshProject(project.id).catch((reason) => setError(errorMessage(reason)))}
                onGenerate={() => void submitMessage('请按已确认的制作范围生成系统。', project, project.currentConversationId, 'system')} />
              <details className="brief-details">
                <summary>演示需求</summary>
                <form id="brief" onSubmit={saveBrief}>
                  <label htmlFor="title">演示标题</label>
                  <input id="title" value={brief.title} maxLength={80} required disabled={active}
                    onChange={(event) => setBrief({ ...brief, title: event.target.value })} />
                  <label htmlFor="requirement">演示需求</label>
                  <textarea id="requirement" value={brief.requirement} maxLength={12000} required disabled={active}
                    onChange={(event) => setBrief({ ...brief, requirement: event.target.value })} />
                  <div className="form-row"><button type="submit" className="text-button" disabled={!changed || submitting || active}>保存需求</button></div>
                </form>
              </details>
            </> : <>
              <div className="panel-head"><h2>演示需求</h2>
                <button className="text-button" type="button" onClick={() => setBrief(exampleBrief)}>使用示例</button>
              </div>
              <form id="brief" onSubmit={startDiscussion}>
                <label htmlFor="title">演示标题</label>
                <input id="title" value={brief.title} maxLength={80} required placeholder="例如：访客预约演示"
                  onChange={(event) => setBrief({ ...brief, title: event.target.value })} />
                <label htmlFor="requirement">演示需求</label>
                <textarea id="requirement" value={brief.requirement} maxLength={6000} required
                  placeholder="描述要展示的功能、怎么操作，以及操作后应看到的结果。"
                  onChange={(event) => setBrief({ ...brief, requirement: event.target.value })} />
              </form>
            </>}
          </section>
          <section className="panel stage" aria-labelledby="preview">
            {project?.currentSourceId ? <SourcePreview key={project.id + '/' + project.currentSourceId}
              projectId={project.id} sourceId={project.currentSourceId} /> : <>
              <div className="panel-head preview-head">
                <h2 id="preview">系统源码</h2>
                {project && <span className="status"><i />尚未生成</span>}
              </div>
              <div className="empty-stage">
                <div className="stage-icon">{active ? <LoaderCircle className="spin" size={36} /> : <Monitor size={38} />}</div>
                {active ? <strong>{task?.state === 'cancelling' ? '正在停止任务' : task?.purpose === 'system' ? '正在生成系统'
                  : task?.kind === 'build' ? '正在提取附件' : '正在处理需求'}</strong>
                  : <span>确认制作范围后可生成并预览系统。</span>}
              </div>
            </>}
          </section>
        </div>
        <footer className="dock">
          {changed && <span className="draft-note">有未保存的需求修改</span>}
          {!project && <button type="submit" form="brief" className="button primary" disabled={submitting || !brief.title.trim() || !brief.requirement.trim()}>
            {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />} {submitting ? '提交中' : '开始讨论'}
          </button>}
        </footer>
      </> : view === 'settings' ? <SettingsPanel project={project} busy={active || submitting} onProjectChange={(updated) => {
        if (updated.id !== project?.id) return;
        setProject(updated);
        setProjects((items) => items.map((item) => item.id === updated.id ? updated : item));
        void refreshMessages(updated.id, updated.currentConversationId).catch((reason) => setError(errorMessage(reason)));
      }} /> : !project && <section className="panel">
        <p className="handoff-body">请先在需求与预览中创建或选择项目。</p>
      </section>}
      {project && <HandoffPanel key={project.id} project={project} hidden={view !== 'handoff'}
        busy={submitting || active} task={handoffTaskName(task) ? task : null}
        local={planDrafts[project.id] ?? null} updateLocal={updatePlanDraft}
        proposalId={proposalIds[project.id]} rememberProposal={(projectId, taskId) =>
          setProposalIds((current) => ({ ...current, [projectId]: taskId }))}
        taskProgress={activity.at(-1)?.label} taskError={error}
        startTask={startHandoff} openSettings={() => setView('settings')}
        taskControls={<>
          {waitingInput && task?.purpose === 'plan' && <button type="button" className="text-button"
            onClick={() => setView('build')}>前往需求讨论处理人工输入</button>}
          {active && <button type="button" className="text-button" onClick={() => void cancelTask()}
            disabled={task?.state === 'cancelling'}>停止任务</button>}
        </>} />}
    </main>
  </div>;
}

function Attachments({ projectId, task, busy, onUpload, onOrganize }: {
  projectId: string; task: Task | null; busy: boolean; onUpload: (file: File) => void; onOrganize: () => void;
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void api.listAttachments(projectId).then((attachments) => { if (alive) setItems(attachments); })
      .catch((reason) => { if (alive) setError(errorMessage(reason)); });
    return () => { alive = false; };
  }, [projectId, task?.taskId, task?.state]);
  return <details className="brief-details">
    <summary>参考材料{items.length ? `（${items.length}）` : ''}</summary>
    <div className="handoff-body settings-body">
      {error && <p role="alert">{error}</p>}
      <label>上传参考文件<input type="file" accept=".txt,.md,.markdown,.json,.csv,.pdf,.docx" disabled={busy} onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) onUpload(file);
      }} /></label>
      {items.length > 0 && <ul>{items.map((item) => <li key={item.id}>
        <a href={`/api/v1/artifacts/${encodeURIComponent(item.id)}/content?projectId=${encodeURIComponent(projectId)}&download=1`}>
          {item.metadata?.name ?? item.id}
        </a> · {item.extractionState === 'succeeded' ? '已提取' : item.extractionError?.message ?? '等待提取'}
      </li>)}</ul>}
      <button type="button" className="text-button" disabled={busy || !items.some((item) => item.extractionState === 'succeeded')}
        onClick={onOrganize}>整理附件需求</button>
    </div>
  </details>;
}

createRoot(document.getElementById('root')!).render(<App />);
