import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, ApiError, artifactContentUrl, isTaskActive } from './api';
import type { CaptureArtifact, Plan, PlanDraft, Project, ScriptArtifact, Settings, Task } from './api';

const taskNames = { plan: '方案提案', speech: '讲解试听', script: '脚本包生成', record: '录制' };
const planStates = { draft: '草稿', ready: '脚本已就绪', needs_update: '方案待更新' };
const actionNames: Record<string, string> = {
  observe: '观察', click: '点击', replaceAscii: '输入', press: '按键', scroll: '滚动', refresh: '刷新',
};
const checkNames: Record<string, string> = {
  visible: '可见状态', contains: '包含', equals: '等于', count: '数量', urlContains: '网址包含',
};

export function handoffTaskName(task: Task | null) {
  if (task?.purpose === 'plan') return 'plan';
  if (task?.kind === 'script') return 'script';
  if (task?.kind === 'record') return 'record';
  if (task?.kind === 'render' && task.phase === 'speech_preview') return 'speech';
  return null;
}

function object(value: unknown): PlanDraft | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as PlanDraft : null;
}

function records(value: unknown) {
  return Array.isArray(value) ? value.flatMap((item: unknown, index) => {
    const record = object(item);
    return record ? [{ index, record }] : [];
  }) : [];
}

function text(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function format(draft: PlanDraft) {
  return JSON.stringify(draft, null, 2);
}

function parse(value: string) {
  try { return object(JSON.parse(value)); } catch { return null; }
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : '录制准备请求失败。';
}

type Props = {
  project: Project;
  hidden: boolean;
  busy: boolean;
  task: Task | null;
  taskProgress?: string;
  taskError: string;
  taskControls: ReactNode;
  local: LocalPlanDraft | null;
  updateLocal: (projectId: string, update: (previous: LocalPlanDraft | null) => LocalPlanDraft | null) => void;
  proposalId?: string;
  rememberProposal: (projectId: string, taskId: string) => void;
  startTask: (start: () => Promise<{ taskId: string }>) => Promise<string | undefined>;
  openSettings: () => void;
};

export type LocalPlanDraft = { value: string; base: string };

export function HandoffPanel({
  project, hidden, busy, task, taskProgress, taskError, taskControls, startTask, openSettings,
  local, updateLocal, proposalId, rememberProposal,
}: Props) {
  const { id, currentSourceId, updatedAt } = project;
  const [plan, setPlan] = useState<Plan | null>(null);
  const [scripts, setScripts] = useState<ScriptArtifact[]>([]);
  const [captures, setCaptures] = useState<CaptureArtifact[]>([]);
  const [effective, setEffective] = useState<Settings['effective'] | null>(null);
  const [latestRecording, setLatestRecording] = useState<Task | null>(null);
  const [conflict, setConflict] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState<{ message: string; field?: string } | null>(null);
  const [proposalTask, setProposalTask] = useState<Task | null>(null);
  const [proposalError, setProposalError] = useState('');
  const [results, setResults] = useState<Partial<Record<'speech' | 'script' | 'record', Task>>>({});
  const [lineIndex, setLineIndex] = useState(-1);
  const [speech, setSpeech] = useState<{ taskId: string; index: number; lineId: string; value: string } | null>(null);
  const readVersion = useRef(0);
  const recordingRequest = useRef<{ requestId: string; planToken: string; scriptArtifactId: string } | null>(null);
  const taskKind = handoffTaskName(task);
  const scriptCompleted = taskKind === 'script' && task?.state === 'succeeded' ? task.taskId : undefined;
  const recordingCompleted = taskKind === 'record' && task?.endedAt ? task.taskId : undefined;
  const latestProposalId = proposalId ?? (taskKind === 'plan' ? task?.taskId : undefined);
  const proposalActive = task?.taskId === latestProposalId && isTaskActive(task?.state);

  // 页面按项目挂载，切换标签保留本地草稿，返回时重新核对服务端版本。
  useEffect(() => {
    if (hidden) return;
    const version = ++readVersion.current;
    setLoading(true);
    setReadError('');
    void Promise.all([api.getPlan(id), api.listScripts(id), api.readSettings(id), api.listCaptures(id)]).then(([current, artifacts, settings, raw]) => {
      if (version !== readVersion.current) return;
      setPlan(current);
      setScripts(artifacts);
      setEffective(settings.effective);
      setCaptures(raw);
    }).catch((reason) => {
      if (version === readVersion.current) setReadError(errorMessage(reason));
    }).finally(() => {
      if (version === readVersion.current) setLoading(false);
    });
    return () => { readVersion.current++; };
  }, [id, hidden, updatedAt, currentSourceId, scriptCompleted, recordingCompleted, refresh]);

  useEffect(() => {
    if (hidden || !project.latestRecordingTaskId || taskKind === 'record') return;
    let alive = true;
    void api.getTask(project.latestRecordingTaskId).then((latest) => {
      if (alive && latest.projectId === id && latest.kind === 'record') setLatestRecording(latest);
    }).catch(() => {});
    return () => { alive = false; };
  }, [hidden, id, project.latestRecordingTaskId, taskKind]);

  useEffect(() => {
    if (task && taskKind && taskKind !== 'plan' && task.projectId === id && task.endedAt) {
      setResults((current) => ({ ...current, [taskKind]: task }));
    }
  }, [task, taskKind, id]);

  useEffect(() => {
    if (hidden || !latestProposalId || proposalActive) return;
    let alive = true;
    setProposalError('');
    void api.getTask(latestProposalId).then((latest) => {
      if (alive && latest.projectId === id && latest.purpose === 'plan') setProposalTask(latest);
    }).catch((reason) => { if (alive) setProposalError(errorMessage(reason)); });
    return () => { alive = false; };
  }, [id, hidden, latestProposalId, proposalActive, refresh]);

  const value = local?.value ?? format(plan?.draft ?? {});
  const draft = parse(value);
  const mustCompare = Boolean(conflict || (local && plan && plan.editToken !== local.base));
  const pending = busy || saving;
  const stale = plan?.state === 'needs_update';
  const lines = records(draft?.narration);
  const selectedLine = lines.find(({ index }) => index === lineIndex)?.record;
  const selectedText = text(selectedLine?.text);
  const proposalResult = object(proposalTask?.taskId === latestProposalId ? proposalTask?.result : null);
  const proposal = object(object(proposalResult?.delivery)?.draft);
  const audioId = speech && speech.taskId === results.speech?.taskId && speech.index === lineIndex
    && speech.lineId === text(selectedLine?.id) && speech.value === selectedText
    ? text(object(results.speech.result)?.artifactId) : '';
  const latestScript = results.script;
  const scriptsReady = !loading && !readError && plan?.state === 'ready';
  const isStale = (artifact: ScriptArtifact) => artifact.stale || plan?.state !== 'ready'
    || artifact.metadata?.planToken !== plan.editToken || artifact.metadata?.sourceArtifactId !== plan.sourceArtifactId;
  const currentScript = scriptsReady ? scripts.find((artifact) => artifact.state === 'available' && !isStale(artifact)) : undefined;
  const voice = text(object(effective?.tts)?.voice);
  const retainedRecording = results.record ?? latestRecording;
  const strategy = text(object(draft?.data)?.resetStrategy);

  function reload() {
    readVersion.current++;
    setLoading(true);
    setRefresh((current) => current + 1);
  }

  function edit(next: string) {
    if (!plan) return;
    updateLocal(id, (current) => ({ value: next, base: current?.base ?? plan.editToken }));
    setNotice('');
  }

  function editLine(next: string) {
    if (!draft || !selectedLine || !Array.isArray(draft.narration)) return;
    edit(format({ ...draft, narration: draft.narration.map((item, index) =>
      index === lineIndex ? { ...selectedLine, text: next } : item) }));
    setSpeech(null);
  }

  async function save() {
    if (!draft || !plan || mustCompare) return;
    setSaving(true);
    setActionError(null);
    try {
      const saved = await api.savePlan(id, draft, local?.base ?? plan.editToken);
      setPlan(saved);
      updateLocal(id, (current) => current === local ? null : current);
      reload();
      setNotice('当前方案已保存。');
    } catch (reason) {
      showFailure(reason);
      if (reason instanceof ApiError && reason.status === 409) {
        updateLocal(id, (current) => current ?? { value, base: plan.editToken });
        setConflict(true);
        reload();
      }
    } finally {
      setSaving(false);
    }
  }

  function showFailure(reason: unknown) {
    setActionError({ message: errorMessage(reason), field: reason instanceof ApiError ? reason.field : undefined });
  }

  async function start(startRequest: () => Promise<{ taskId: string }>) {
    setActionError(null);
    setNotice('');
    try { return await startTask(startRequest); } catch (reason) { showFailure(reason); }
  }

  async function record() {
    if (pending || local || !plan || !currentScript || !voice || plan.issues.length) return;
    const previous = recordingRequest.current;
    const request = previous?.planToken === plan.editToken && previous.scriptArtifactId === currentScript.id ? previous
      : { requestId: crypto.randomUUID(), planToken: plan.editToken, scriptArtifactId: currentScript.id };
    recordingRequest.current = request;
    const taskId = await start(() => api.startRecording(id, request));
    if (taskId) recordingRequest.current = null;
  }

  function propose() {
    void start(async () => {
      const accepted = await api.postMessage(id, {
        requestId: crypto.randomUUID(), purpose: 'plan',
        ...(project.currentConversationId ? { conversationId: project.currentConversationId } : {}),
        text: '请依据已确认的范围和当前源码拟定演示方案，核对操作、输入、结果、讲解和标注，并说明待核实的功能缺口。',
      });
      rememberProposal(id, accepted.taskId);
      return accepted;
    });
  }

  async function preview() {
    setSpeech(null);
    const taskId = await start(() => api.previewSpeech(id, selectedText));
    if (taskId) setSpeech({ taskId, index: lineIndex, lineId: text(selectedLine?.id), value: selectedText });
  }

  return <section className="panel handoff" aria-labelledby="recording-preparation" hidden={hidden}>
    <div className="panel-head preview-head">
      <h2 id="recording-preparation">录制准备</h2>
      {plan && <span className={stale ? 'status failed' : 'status'}><i />{planStates[plan.state]}</span>}
      <button type="button" className="text-button" disabled={loading || saving} onClick={reload}>刷新状态</button>
    </div>
    <div className="handoff-body handoff-sections">
      {readError && <p className="notice" role="alert">{readError}</p>}
      {actionError && <div className="notice" role="alert">
        {actionError.message}{actionError.field?.startsWith('/') && <FieldPath path={actionError.field} />}
        {actionError.field === 'tts.voice' && <button type="button" className="text-button" onClick={openSettings}>前往设置选择音色</button>}
      </div>}
      {taskKind && task && <div className="handoff-actions">
        <span role="status">{taskNames[taskKind]} · {isTaskActive(task.state)
          ? task.state === 'waiting_input' ? '等待人工输入' : task.state === 'cancelling' ? '正在停止' : taskProgress || '进行中'
          : task.state === 'succeeded' ? '已完成' : task.state === 'cancelled' ? '已停止' : task.state === 'interrupted' ? '已中断' : '未完成'}</span>
        {taskControls}
      </div>}
      {(task?.error || taskError) && <div className="notice" role="alert">
        {task?.error?.message ?? taskError}{task?.error?.field && <FieldPath path={task.error.field} />}
      </div>}
      {taskKind === 'record' && <RecordingFailureDetails error={task?.error} />}
      {notice && <p role="status">{notice}</p>}
      <section className="handoff-section">
        <h3>演示方案</h3>
        <div className="handoff-actions">
          <button type="button" className="button secondary" onClick={propose} disabled={pending || !currentSourceId}>请 Codex 拟定方案</button>
          {!currentSourceId && <small>发布系统源码后可拟定方案。</small>}
        </div>
        {proposalError && <p role="alert">无法读取提案。{proposalError} 请刷新状态重试。</p>}
        {proposalTask?.taskId === latestProposalId && proposalTask?.error && taskKind !== 'plan' &&
          <p role="alert">{proposalTask.error.message}</p>}
        {proposal && <div className="handoff-compare">
          <p>{text(proposalResult?.reply) || 'Codex 已生成方案提案。'}</p>
          <button type="button" className="text-button" disabled={!plan || saving} onClick={() => {
            edit(format(proposal));
            setLineIndex(-1);
            setSpeech(null);
          }}>{local ? '用提案替换本地草稿' : '载入提案到草稿'}</button>
        </div>}
        {stale && <p className="draft-note">请根据当前制作范围和源码核对方案，再保存草稿。</p>}
        {mustCompare && plan && <div className="handoff-compare">
          <p role="status">当前保存基线需要核对。本地编辑已保留。</p>
          {loading ? <p role="status">正在读取服务端版本…</p> : !readError && <label>服务端已保存版本
            <textarea className="plan-json" readOnly rows={8} value={format(plan.draft)} />
          </label>}
          <div className="handoff-actions">
            <button type="button" className="text-button" disabled={loading || Boolean(readError)} onClick={() => {
              updateLocal(id, () => null); setConflict(false); setActionError(null); setSpeech(null); setLineIndex(-1);
            }}>采用服务端版本</button>
            <button type="button" className="text-button" disabled={loading || Boolean(readError)} onClick={() => {
              updateLocal(id, () => ({ value, base: plan.editToken })); setConflict(false); setActionError(null);
            }}>保留本地草稿并更新保存基线</button>
          </div>
        </div>}
        {plan ? <>
          <PlanSteps draft={draft} />
          <details className="handoff-editor" open={Object.keys(plan.draft).length === 0 || mustCompare || undefined}>
            <summary>编辑方案字段与技术定位（JSON）</summary>
            <label>本地方案草稿
              <textarea id="plan-draft" className="plan-json" rows={14} spellCheck={false} value={value}
                disabled={saving} aria-invalid={!draft} onChange={(event) => edit(event.target.value)} />
            </label>
            {!draft && <p role="alert">请输入有效的 JSON 对象。字段可以暂时留空。</p>}
          </details>
          <div className="handoff-actions">
            <button type="button" className="button primary" onClick={() => void save()}
              disabled={pending || loading || mustCompare || !draft || (!local && !stale)}>{saving ? '正在保存…' : '保存草稿'}</button>
            {local && <small className="draft-note">有未保存的方案编辑</small>}
          </div>
          {plan.issues.length > 0 && <details className="handoff-editor" open>
            <summary>已保存方案的字段校验（{plan.issues.length}）</summary>
            <ul>{plan.issues.map(({ path, code, message }) => <li key={JSON.stringify([path, code, message])}>
              <FieldPath path={path} /> {message}
              {path === '/profile/tts/voice' && <button type="button" className="text-button" onClick={openSettings}>前往设置选择音色</button>}
            </li>)}</ul>
          </details>}
        </> : loading && <p role="status">正在读取当前方案…</p>}
      </section>
      <section className="handoff-section">
        <h3>讲解试听</h3>
        {lines.length ? <>
          <label>选择一条讲解
            <select value={selectedLine ? lineIndex : -1} onChange={(event) => setLineIndex(Number(event.target.value))}>
              <option value={-1}>请选择</option>
              {lines.map(({ index, record }) => <option key={index} value={index}>
                {index + 1}. {text(record.stepId) && `[${text(record.stepId)}] `}{text(record.text).slice(0, 50) || '待填写讲解'}
              </option>)}
            </select>
          </label>
          {selectedLine && <label>讲解文本
            <textarea rows={3} value={selectedText} disabled={saving} onChange={(event) => editLine(event.target.value)} />
          </label>}
          <div className="handoff-actions">
            <button type="button" className="button secondary" onClick={() => void preview()}
              disabled={pending || !selectedText.trim() || selectedText.length > 2000}>试听选中讲解</button>
            {selectedText.length > 2000 && <small>试听讲解最多 2000 字。</small>}
          </div>
          {audioId && <audio key={audioId} controls preload="none" aria-label="讲解试听音频"
            src={artifactContentUrl(id, audioId)} />}
        </> : <p>在方案的 narration 字段添加讲解后即可选择试听。</p>}
      </section>
      <section className="handoff-section">
        <h3>执行脚本包</h3>
        <div className="handoff-actions">
          <button type="button" className="button secondary" onClick={() => void start(() => api.generateScripts(id, crypto.randomUUID()))}
            disabled={pending || loading || Boolean(readError) || !plan || Boolean(plan.issues.length) || !currentSourceId || stale || Boolean(local)}>
            生成脚本包
          </button>
          {currentScript && <a className="button secondary" href={artifactContentUrl(id, currentScript.id, true)}>下载当前脚本包</a>}
        </div>
        {(local || stale || !currentSourceId || !plan || Boolean(plan.issues.length)) && <small>请先发布源码、保存方案并处理字段校验问题。</small>}
        {latestScript?.state === 'succeeded' && <p role="status">脚本包已生成。</p>}
        {latestScript?.error && taskKind !== 'script' && <p role="alert">
          {latestScript.error.message} {latestScript.error.field && <FieldPath path={latestScript.error.field} />}
        </p>}
        {scripts.length > 0 && !loading && <ul className="script-list">{scripts.map((artifact) => <li key={artifact.id}>
          <time dateTime={artifact.createdAt}>{new Date(artifact.createdAt).toLocaleString('zh-CN')}</time>
          <span>{isStale(artifact) ? '已失效' : artifact.state === 'available'
            ? artifact.id === currentScript?.id ? '当前脚本包' : '可用' : artifact.state === 'partial' ? '未完成' : '文件缺失'}</span>
        </li>)}</ul>}
      </section>
      <section className="handoff-section">
        <h3>桌面录制</h3>
        {effective && <p>生效设置：{voice || '未选音色'}，移动 {effective.moveMs as number} ms，点击前停留 {effective.preClickMs as number} ms，
          {Number(object(effective.output)?.fps)} 帧/秒。</p>}
        {currentScript && !local && <p>数据准备：{strategy === 'seed' ? '恢复当前源码的种子状态'
          : strategy === 'custom' ? '写入已保存的自定义状态' : '保留当前演示数据'}。</p>}
        <div className="handoff-actions">
          <button type="button" className="button primary" onClick={() => void record()}
            disabled={pending || Boolean(local) || !currentScript || !voice || Boolean(plan?.issues.length)}>开始录制</button>
          {effective && !voice && <button type="button" className="text-button" onClick={openSettings}>前往设置选择音色</button>}
        </div>
        <small>准备完成后切换到 Edge。录制时可按 Ctrl + Alt + Shift + F10 停止。</small>
        {taskKind !== 'record' && retainedRecording?.error && <div role="status">
          <p>上次录制 {retainedRecording.error.message}
            {retainedRecording.error.field && <FieldPath path={retainedRecording.error.field} />}</p>
          <RecordingFailureDetails error={retainedRecording.error} />
        </div>}
        {captures.some((artifact) => artifact.state === 'available' || artifact.state === 'partial') && <ul className="script-list capture-list">
          {captures.filter((artifact) => artifact.state === 'available' || artifact.state === 'partial').map((artifact) => <li key={artifact.id}>
            <div className="handoff-actions">
              <time dateTime={artifact.createdAt}>{new Date(artifact.createdAt).toLocaleString('zh-CN')}</time>
              <a href={artifactContentUrl(id, artifact.id, true)}>{artifact.state === 'available' ? '下载原片' : '下载部分原片'}</a>
              {artifact.metadata?.captureArtifactId && <a href={artifactContentUrl(id, artifact.metadata.captureArtifactId, true)}>下载采集清单</a>}
            </div>
            {artifact.state === 'available' && <details>
              <summary>播放原片</summary>
              <video controls preload="none" aria-label="录制原片" src={artifactContentUrl(id, artifact.id)} />
            </details>}
          </li>)}
        </ul>}
      </section>
    </div>
  </section>;
}

function RecordingFailureDetails({ error }: { error: Task['error'] | undefined }) {
  if (!error) return null;
  const display = (value: string | number | boolean | null) => value === null ? '未读到值' : JSON.stringify(value);
  return <>
    {error.lastCompletedStepId && <p>最后完成的步骤为 {error.lastCompletedStepId}。</p>}
    {Boolean(error.checks?.length) && <ul>{error.checks?.map((check, index) => <li key={index}>
      {check.target} 预期 {display(check.expected)}，实测 {display(check.actual)}。
    </li>)}</ul>}
  </>;
}

function FieldPath({ path }: { path: string }) {
  const step = /^\/steps\/(\d+)(?:\/|$)/.exec(path);
  return <code>{step ? <a href={`#plan-step-${step[1]}`}>{path}</a> : path || '/'}</code>;
}

function PlanSteps({ draft }: { draft: PlanDraft | null }) {
  const steps = records(draft?.steps);
  const features = records(draft?.features);
  const elements = records(draft?.elements);
  function target(value: unknown) {
    const element = elements.find(({ record }) => record.id === value)?.record;
    return text(element?.value) || text(value);
  }
  return <>
    {text(draft?.description) && <p>{text(draft?.description)}</p>}
    {steps.length > 0 && <ol className="plan-steps">{steps.map(({ index, record }) => {
      const feature = features.find((item) => item.record.id === record.featureId)?.record;
      return <li key={index} id={`plan-step-${index}`}>
        <strong>{text(feature?.title) || text(record.id) || `步骤 ${index + 1}`}</strong>
        {text(feature?.outcome) && <div>预期画面 · {text(feature?.outcome)}</div>}
        {records(record.actions).map(({ index: actionIndex, record: action }) => <div key={actionIndex}>
          {actionNames[text(action.op)] ?? text(action.op)} {target(action.target)}
          {action.value !== undefined && <> · {JSON.stringify(action.value)}</>}
          {action.key !== undefined && <> · {text(action.key)}</>}
        </div>)}
        {records(record.checks).map(({ index: checkIndex, record: check }) => <div key={checkIndex}>
          检查 · {target(check.target)} {checkNames[text(check.op)] ?? text(check.op)} {JSON.stringify(check.expected)}
        </div>)}
      </li>;
    })}</ol>}
  </>;
}
