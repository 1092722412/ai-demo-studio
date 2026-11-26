import { createRoot } from 'react-dom/client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  ArrowRight, Check, ChevronDown, CircleAlert, CircleCheck, Film, Layers3, LoaderCircle,
  MessageSquare, Monitor, Plus, ScanLine, Send, Sparkles, Square, X,
} from 'lucide-react';
import { api, isTaskActive } from './api';
import type { Message, Project, Task, TaskEvent } from './api';
import { useTaskEvents } from './useTaskEvents';
import './style.css';

type Brief = { title: string; requirement: string };
type Activity = { callId: string | null; label: string; status: 'running' | 'done' | 'failed' };
type View = 'build' | 'handoff';
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
  const selectedToken = useRef(0);
  const taskRef = useRef<Task | null>(null);
  useEffect(() => { taskRef.current = task; }, [task]);

  const refreshMessages = useCallback(async (projectId: string, conversationId?: string | null) => {
    const result = await api.listMessages(projectId, conversationId);
    setMessages(result.items);
    if (result.conversationId) {
      setProject((current) => current?.id === projectId ? { ...current, currentConversationId: result.conversationId! } : current);
    }
  }, []);

  const onTaskEvent = useCallback((event: TaskEvent) => {
    const currentTask = taskRef.current;
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
    } else if (event.type.startsWith('task.')) {
      const state: Task['state'] = event.type === 'task.succeeded' ? 'succeeded'
        : event.type === 'task.cancelled' ? 'cancelled'
          : event.type === 'task.interrupted' ? 'interrupted' : 'failed';
      if (currentTask) setTask({ ...currentTask, state, phase: state, endedAt: event.at });
      setActivity((current) => current.map((item) => item.status === 'running' ? { ...item, status: state === 'failed' || state === 'interrupted' ? 'failed' : 'done' } : item));
      if (state === 'succeeded' && currentTask?.conversationId) {
        void refreshMessages(currentTask.projectId, currentTask.conversationId).catch((reason) => setError(errorMessage(reason)));
      } else if (state === 'failed' || state === 'interrupted') {
        const payload = event.payload as { message?: unknown };
        if (typeof payload.message === 'string') setError(payload.message);
      }
      setWaitingInput(null);
      if (state === 'cancelled') setError('本轮任务已停止。');
    }
  }, [refreshMessages]);

  useTaskEvents(task?.taskId ?? null, onTaskEvent);

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
    const token = ++selectedToken.current;
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
        if (token === selectedToken.current) setTask(activeTask);
      }
    } catch (reason) {
      if (token === selectedToken.current) setError(errorMessage(reason));
    } finally {
      setMenuOpen(false);
      setView('build');
    }
  }

  function newProject() {
    selectedToken.current++;
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

  async function submitMessage(text: string, currentProject: Project, conversationId?: string | null) {
    const requestId = crypto.randomUUID();
    setSubmitting(true);
    setError('');
    setActivity([{ callId: null, label: '消息已提交', status: 'running' }]);
    try {
      const accepted = await api.postMessage(currentProject.id, {
        requestId,
        ...(conversationId ? { conversationId } : {}),
        purpose: 'discuss',
        text,
      });
      const updatedProject = { ...currentProject, currentConversationId: accepted.conversationId };
      setProject(updatedProject);
      setProjects((items) => [updatedProject, ...items.filter((item) => item.id !== updatedProject.id)]);
      await refreshMessages(currentProject.id, accepted.conversationId);
      const nextTask = await api.getTask(accepted.taskId);
      taskRef.current = nextTask;
      setTask(nextTask);
      setActivity([{ callId: null, label: '已发送给 Codex', status: 'running' }]);
    } catch (reason) {
      setError(errorMessage(reason));
      setActivity((items) => items.map((item) => item.status === 'running' ? { ...item, status: 'failed' } : item));
    } finally {
      setSubmitting(false);
    }
  }

  async function startDiscussion(event: FormEvent) {
    event.preventDefault();
    if (submitting || isTaskActive(task?.state) || !brief.title.trim() || !brief.requirement.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const created = await api.createProject({ title: brief.title.trim(), brief: brief.requirement.trim() });
      setProject(created);
      setProjects((items) => [created, ...items.filter((item) => item.id !== created.id)]);
      updateAddress(created.id);
      await submitMessage(brief.requirement.trim(), created);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
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
    try {
      const updated = await api.cancelTask(task.taskId);
      setTask(updated);
      taskRef.current = updated;
      if (updated.state === 'cancelling') setError('正在停止当前任务…');
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  async function respondInput(value: { requestId: string; choice?: string; text?: string; response?: Record<string, unknown> }) {
    if (!task) return;
    setSubmitting(true);
    try {
      const updated = await api.respondInput(task.taskId, value);
      setTask(updated);
      taskRef.current = updated;
      setWaitingInput(null);
      setError('');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  async function saveBrief(event: FormEvent) {
    event.preventDefault();
    if (!project || isTaskActive(task?.state)) return;
    setSubmitting(true);
    try {
      const updated = await api.patchProject(project.id, { title: brief.title, brief: brief.requirement });
      setProject(updated);
      setProjects((items) => [updated, ...items.filter((item) => item.id !== updated.id)]);
      setError('需求已保存。');
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  }

  const active = isTaskActive(task?.state);
  const changed = Boolean(project && (brief.title !== project.title || brief.requirement !== project.brief));
  const activeSteps = project ? active ? 1 : 1 : 0;

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
      </nav>
      <div className="local"><i />本地工作台</div>
    </aside>

    <main className="workspace">
      <header className="page-header">
        <h1>{view === 'build' ? '需求讨论与预览' : '录制与审片'}</h1>
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
            <div className="panel-head preview-head">
              <h2 id="preview">系统预览</h2>
              {project && <span className="status"><i />{project.currentSourceId ? '源码已登记' : '尚未生成'}</span>}
            </div>
            <div className="empty-stage">
              <div className="stage-icon">{active ? <LoaderCircle className="spin" size={36} /> : <Monitor size={38} />}</div>
              <strong>{active ? task?.state === 'cancelling' ? '正在停止任务' : '正在讨论需求' : '系统生成待接入'}</strong>
              <span>{active ? '调用过程会在左侧更新。' : '当前可以通过 Codex 讨论和整理需求；确认范围与系统生成将在后续步骤接入。'}</span>
            </div>
          </section>
        </div>
        <footer className="dock">
          {changed && <span className="draft-note">有未保存的需求修改</span>}
          {!project && <button type="submit" form="brief" className="button primary" disabled={submitting || !brief.title.trim() || !brief.requirement.trim()}>
            {submitting ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />} {submitting ? '提交中' : '开始讨论'}
          </button>}
        </footer>
      </> : <section className="panel handoff">
        <div className="panel-head"><h2>录制准备</h2></div>
        <div className="handoff-body">
          <p>项目 <strong>{project?.title || '尚未选择'}</strong></p>
          <p>录制、脚本和审片接口将在后续实施项接入。当前不会启动演示或录屏。</p>
          <button className="text-button" onClick={() => setView('build')}>返回需求讨论 <ArrowRight size={16} /></button>
        </div>
      </section>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
