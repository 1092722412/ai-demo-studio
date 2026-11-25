import { createRoot } from 'react-dom/client';
import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  ArrowDownToLine, ArrowRight, Check, ChevronDown, CircleAlert, CircleCheck, CodeXml,
  ExternalLink, Film, Layers3, LoaderCircle, MessageSquare, Monitor, Paperclip, Play, Plus, ScanLine, Send, Sparkles, X,
} from 'lucide-react';
import './style.css';

type Brief = { title: string; requirement: string; reference: string };
type State = 'generating' | 'building' | 'ready' | 'discussed' | 'failed';
type Message = { role: 'user' | 'assistant'; text: string };
type Activity = { label: string; status: 'running' | 'done' | 'failed' };
type SendPhase = 'sending' | 'working' | 'applying' | 'reconnecting';
type Summary = { id: string; projectId: string; title: string; version: number; status: State };
type Job = Omit<Summary, 'title'> & {
  brief: Brief; error?: string; previewUrl: string | null;
  spec?: { title: string; fields: { id: string; label: string }[] };
  skill?: { name: string; sha256: string };
  acceptance?: { operation: string; result: string }[];
  conversation?: Message[];
  activity?: Activity[];
  previewJobId?: string;
  previewVersion?: number;
};
type View = 'build' | 'handoff';
const empty: Brief = { title: '', requirement: '', reference: '' };
const example: Brief = {
  title: '访客预约演示',
  requirement: '填写访客姓名与来访事由。保存预约后立即显示在列表中，刷新页面确认仍可查询。首次打开时预约列表为空。',
  reference: '',
};
const statusText: Record<State, string> = { generating: 'Codex 正在处理', building: '正在启动演示系统', ready: '已就绪', discussed: '已回复', failed: '本轮失败' };
const sendStatus: Record<SendPhase, { label: string; detail: string }> = {
  sending: { label: '发送中', detail: '正在提交消息。' },
  working: { label: '处理中', detail: '消息已送达，Codex 正在处理。回复后可继续发送。' },
  applying: { label: '更新预览中', detail: 'Codex 已返回结果，工作台正在更新系统预览。' },
  reconnecting: { label: '重连中', detail: '暂时无法读取任务状态，正在重连。' },
};
const submittedActivity: Activity[] = [{ label: '已发送给 Codex', status: 'running' }];

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || '本地工作台请求失败。'), { latestId: data.latestId, status: response.status });
  return data as T;
}

function updateAddress(jobId: string | null) {
  const url = new URL(location.href);
  if (jobId) url.searchParams.set('job', jobId);
  else url.searchParams.delete('job');
  history.replaceState(null, '', url);
}

function Conversation({ job, phase, draft, setDraft, send }: {
  job: Job; phase: SendPhase | null; draft: string; setDraft: (text: string) => void; send: (event: FormEvent) => void;
}) {
  const log = useRef<HTMLDivElement>(null);
  const messages = job.conversation || [{ role: 'user', text: job.brief.requirement }];
  const progress = phase ? sendStatus[phase] : null;
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [messages.length]);
  return <div className="conversation">
    <div className="panel-head"><h2><MessageSquare size={17} /> Codex 对话</h2></div>
    <div ref={log} className="chat-log" role="log" aria-label="项目对话">
      {messages.map((item, index) => <article key={index} className={'chat-message ' + item.role}>
        <strong>{item.role === 'user' ? '你' : 'Codex'}</strong><p>{item.text}</p>
      </article>)}
    </div>
    <details className="activity">
      <summary><ChevronDown size={14} aria-hidden="true" /><span>调用过程</span>
        <small>{job.activity?.length || 0} 条</small>
      </summary>
      <ul>{job.activity?.length ? job.activity.map((event, index) => <li key={index}>
        {event.status === 'running' ? <span className="activity-dot" aria-hidden="true" /> :
          event.status === 'done' ? <CircleCheck size={15} aria-hidden="true" /> : <CircleAlert size={15} aria-hidden="true" />}
        <span>{event.label}</span><small>{event.status === 'running' ? '进行中' : event.status === 'done' ? '完成' : '失败'}</small>
      </li>) : <li className="activity-empty">暂无调用记录</li>}</ul>
    </details>
    <form className="chat-compose" onSubmit={send}>
      <textarea aria-label="给 Codex 的消息" placeholder="继续讨论，或告诉 Codex 要修改什么…" value={draft}
        onChange={(event) => setDraft(event.target.value)} maxLength={6000} rows={2}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }} />
      <button type="submit" className={'button primary chat-send' + (progress ? ' sending' : '')}
        disabled={Boolean(phase) || !draft.trim()} aria-busy={Boolean(phase)}>
        {progress ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
        {progress?.label || '发送'}
      </button>
    </form>
    <div role="status" className={progress ? 'chat-send-status active' : 'chat-send-status'}>{progress?.detail}</div>
  </div>;
}

function App() {
  const [jobs, setJobs] = useState<Summary[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const [id, setId] = useState<string | null>(() => new URLSearchParams(location.search).get('job'));
  const [brief, setBrief] = useState<Brief>(empty);
  const [fileName, setFileName] = useState('');
  const [view, setView] = useState<View>('build');
  const [menuOpen, setMenuOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [latestId, setLatestId] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const attachment = useRef<HTMLInputElement>(null);
  const referenceRead = useRef(0);
  const pending = job?.status === 'generating' || job?.status === 'building';
  const phase: SendPhase | null = reconnecting ? 'reconnecting' : submitting ? 'sending'
    : job?.status === 'building' ? 'applying' : pending ? 'working' : null;
  const busy = Boolean(phase);
  const ready = Boolean(job?.previewUrl);
  const changed = Boolean(job && (Object.keys(brief) as (keyof Brief)[]).some((key) => brief[key] !== job.brief[key]));
  const base = job ? '/api/jobs/' + (job.previewJobId || job.id) : '';
  const activeSteps = pending ? 1 : ready ? 2 : 0;

  useEffect(() => {
    let alive = true;
    request<Summary[]>('/api/jobs').then((data) => { if (alive) setJobs(data); })
      .catch((reason) => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!id) return;
    const selected = id;
    let alive = true;
    let timer: number | undefined;
    let initial = true;
    async function refresh() {
      try {
        const data = await request<Job>('/api/jobs/' + selected, { signal: AbortSignal.timeout(8000) });
        if (!alive) return;
        setJob(data);
        setReconnecting(false);
        setError('');
        setJobs((history) => [{ id: data.id, projectId: data.projectId, title: data.brief.title, version: data.version, status: data.status },
          ...history.filter((item) => item.projectId !== data.projectId)]);
        if (selected !== data.id) updateAddress(data.id);
        if (initial) {
          setBrief(data.brief);
          setFileName(data.brief.reference ? '已保存的参考材料' : '');
          initial = false;
        }
        if (data.status === 'generating' || data.status === 'building') timer = window.setTimeout(refresh, 1300);
      } catch (reason) {
        if (!alive) return;
        const failure = reason as Error & { status?: number };
        if (failure.status === 404) {
          setReconnecting(false);
          setJob(null);
          setError(failure.message);
          return;
        }
        setReconnecting(true);
        timer = window.setTimeout(refresh, 3000);
      }
    }
    void refresh();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [id]);

  function select(next: string | null) {
    setMenuOpen(false);
    setView('build');
    if (next === id && next) return;
    referenceRead.current++;
    setJob(null);
    setError('');
    setReconnecting(false);
    setDraft('');
    setLatestId(null);
    if (!next) { setBrief(empty); setFileName(''); }
    setId(next);
    updateAddress(next);
  }

  async function generate(event: FormEvent) {
    event.preventDefault();
    if (busy || !brief.title.trim() || !brief.requirement.trim()) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await request<Summary>('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...brief, previousId: job?.id }),
      });
      select(result.id);
      setJob({ ...job, id: result.id, projectId: result.projectId, version: result.version, status: result.status, brief, error: undefined,
        previewUrl: job?.previewUrl || null, activity: submittedActivity, conversation: [
          ...(job?.conversation || []), { role: 'user', text: brief.requirement },
        ] });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提交失败。');
    } finally {
      setSubmitting(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!job || busy || !draft.trim()) return;
    setSubmitting(true);
    setError('');
    setLatestId(null);
    const text = draft.trim();
    try {
      const result = await request<Summary>('/api/jobs/' + job.id + '/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }),
      });
      select(result.id);
      setJob({ ...job, id: result.id, version: result.version, status: result.status, error: undefined, activity: submittedActivity,
        conversation: [...(job.conversation || [{ role: 'user', text: job.brief.requirement }]), { role: 'user', text }],
      });
    } catch (reason) {
      const failure = reason as Error & { latestId?: string };
      setError(failure.message || '发送失败。');
      setLatestId(failure.latestId || null);
    } finally {
      setSubmitting(false);
    }
  }

  async function attach(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > 48_000 || !/\.(txt|md|json|csv)$/i.test(file.name)) {
      setError('请选择不超过 48 KB 的 TXT、Markdown、JSON 或 CSV 文本。');
      return;
    }
    const reading = ++referenceRead.current;
    try {
      const text = (await file.text()).trim();
      if (reading !== referenceRead.current) return;
      if (!text || text.length > 12_000) throw new Error('参考材料需包含 1 到 12,000 个文字。');
      setError('');
      setFileName(file.name);
      setBrief((current) => ({ ...current, reference: text }));
    } catch (reason) {
      if (reading === referenceRead.current) setError(reason instanceof Error ? reason.message : '无法读取参考材料。');
    }
  }

  return <div className="studio">
    <aside className="sidebar">
      <div className="brand"><span className="brand-icon"><ScanLine size={24} /><Play size={10} fill="currentColor" /></span>AI Demo Studio</div>
      <div className="project-switch">
        <button className="project-button" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}
          onKeyDown={(event) => { if (event.key === 'Escape') setMenuOpen(false); }}>
          <span>{job?.brief.title || '新建演示'}</span><ChevronDown size={16} />
        </button>
        {menuOpen && <div className="projects">
          <button onClick={() => select(null)}><Plus size={15} /> 新建演示</button>
          {jobs.map((item) => <button key={item.id} onClick={() => select(item.id)}>
            <span>{item.title}</span><small>{statusText[item.status]}</small>
          </button>)}
        </div>}
      </div>
      <nav aria-label="工作台">
        <button className={view === 'build' ? 'nav-item active' : 'nav-item'} onClick={() => setView('build')}
          aria-current={view === 'build' ? 'page' : undefined}><Layers3 size={20} /> 新建与预览</button>
        <button className={view === 'handoff' ? 'nav-item active' : 'nav-item'} onClick={() => setView('handoff')}
          aria-current={view === 'handoff' ? 'page' : undefined}><Film size={20} /> 录制与审片</button>
      </nav>
      <div className="local"><i />本地工作台</div>
    </aside>

    <main className="workspace">
      <header className="page-header">
        <h1>{view === 'build' ? '新建与预览' : '录制与审片'}</h1>
        <span className="agent"><span />本机 Codex</span>
      </header>
      {view === 'build' ? <>
        <ol className="steps" aria-label="演示系统生成流程">
          {['演示需求', '生成系统', '预览系统'].map((label, index) =>
            <li key={label} className={index === activeSteps ? 'current' : index < activeSteps ? 'done' : ''}
              aria-current={index === activeSteps ? 'step' : undefined}>
              <span className="step-dot">{index < activeSteps ? <Check size={15} /> : index + 1}</span>{label}
            </li>)}
        </ol>
        {(error || job?.error) && <div className="notice" role="alert"><CircleAlert size={18} />{error || job?.error}
          {latestId && <button className="text-button" onClick={() => {
            const message = draft;
            select(latestId);
            setDraft(message);
          }}>打开最新对话</button>}
        </div>}
        {!job && reconnecting && <div className="notice" role="status"><LoaderCircle className="spin" size={18} />
          {sendStatus.reconnecting.detail}</div>}
        <div className="build-grid">
          <section className="panel requirements" aria-label={job ? 'Codex 对话和演示需求' : '演示需求'}>
            {job ? <Conversation job={job} phase={phase} draft={draft} setDraft={setDraft} send={send} /> :
              <div className="panel-head"><h2>演示需求</h2>
                <button className="text-button" type="button" onClick={() => setBrief({ ...example, reference: brief.reference })}>使用示例</button>
              </div>}
            <details className={job ? 'brief-details' : 'brief-details initial'} open={!job || undefined}>
              <summary>演示需求与参考</summary>
            <form id="brief" onSubmit={generate}>
              <label htmlFor="title">演示标题</label>
              <input id="title" value={brief.title} maxLength={60} required disabled={busy} placeholder="例如：访客预约演示"
                onChange={(event) => setBrief({ ...brief, title: event.target.value })} />
              <label htmlFor="requirement">演示需求</label>
              <textarea id="requirement" value={brief.requirement} maxLength={6000} required disabled={busy}
                placeholder="描述要展示的功能、怎么操作，以及操作后应看到的结果。"
                onChange={(event) => setBrief({ ...brief, requirement: event.target.value })} />
              <div className="form-row">
                <input ref={attachment} type="file" hidden accept=".txt,.md,.json,.csv" onChange={attach} />
                <button type="button" className="button secondary" disabled={busy}
                  onClick={() => attachment.current?.click()}><Paperclip size={16} /> 添加参考</button>
                {job && <button type="submit" className="text-button" disabled={busy}>按需求重新提交</button>}
              </div>
              {fileName && <div className="file"><span>{fileName}</span><button type="button" aria-label="移除参考材料"
                disabled={busy} onClick={() => { referenceRead.current++; setFileName(''); setBrief({ ...brief, reference: '' }); }}><X size={15} /></button></div>}
            </form>
            </details>
          </section>
          <section className="panel stage" aria-labelledby="preview">
            <div className="panel-head preview-head">
              <h2 id="preview">系统预览</h2>
              {job && <span className={'status ' + job.status}><i />{ready
                ? '当前系统' + (job.status === 'ready' ? ' · 已就绪' : '')
                : statusText[job.status]}</span>}
              {ready && <a className="button secondary open" href={job?.previewUrl || ''} target="_blank" rel="noreferrer">
                <ExternalLink size={16} /> 打开系统</a>}
            </div>
            {ready ? <div className="browser">
              <div className="browser-bar"><div className="browser-dots"><i /><i /><i /></div><span>{job?.spec?.title || '演示系统'}</span></div>
              <iframe title="生成系统预览" src={job?.previewUrl || ''} />
            </div> : <div className="empty-stage">
              <div className="stage-icon">{busy ? <LoaderCircle className="spin" size={36} /> : <Monitor size={38} />}</div>
              <strong>{busy ? statusText[job?.status || 'generating'] : job?.status === 'discussed' ? '等待确认生成' : '生成后在这里预览'}</strong>
              <span>{busy ? '调用过程会在左侧更新。' : '与 Codex 确认需求后，即可生成系统。'}</span>
            </div>}
          </section>
        </div>
        <footer className="dock">
          {changed && <span className="draft-note">有未生成的需求修改</span>}
          {ready && <a href={base + (job?.skill ? '/source/app.js' : '/source/server.mjs')} target="_blank" rel="noreferrer" className="text-button"><CodeXml size={17} /> 查看源码</a>}
          {ready && <a href={base + '/download'} className="button secondary"><ArrowDownToLine size={17} /> 下载源码</a>}
          {ready ? <button className="button primary" disabled={changed || busy} onClick={() => setView('handoff')}><Play size={16} /> 准备录制方案</button>
            : !job && <button type="submit" form="brief" className="button primary" disabled={busy || !brief.title.trim() || !brief.requirement.trim()}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />} {phase ? sendStatus[phase].label : '发送给 Codex'}
            </button>}
        </footer>
      </> : <section className="panel handoff">
        <div className="panel-head"><h2>录制准备</h2></div>
        <div className="handoff-body">
          {ready && !changed ? <>
            <p>当前系统 <strong>{job?.spec?.title}</strong></p>
            <p>已整理稳定页面标识，可用于起草录制方案。录制功能将在下一批接入。</p>
            {job?.acceptance?.length ? <ol>{job.acceptance.map((entry, index) =>
              <li key={index}>{entry.operation} → {entry.result}</li>)}</ol> : null}
            <dl>{job?.spec?.fields.map((field) => <div key={field.id}><dt>{field.label}</dt><dd><code>{field.id}</code></dd></div>)}</dl>
            <a className="button secondary" href={base + '/handoff'}><ArrowDownToLine size={17} /> 下载录制交接信息</a>
          </> : <p>请先生成演示系统。需求有修改时，请重新生成对应版本。</p>}
          <button className="text-button" onClick={() => setView('build')}>返回新建与预览 <ArrowRight size={16} /></button>
        </div>
      </section>}
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
