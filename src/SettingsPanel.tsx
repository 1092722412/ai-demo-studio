import { useEffect, useState } from 'react';
import { ApiError, api, type Connection, type Project, type Settings, type SettingsValue, type SettingsValues } from './api';

const fields = [
  { key: 'moveMs', label: '指针移动（毫秒）', min: 100, max: 10000 },
  { key: 'preClickMs', label: '点击前停留（毫秒）', min: 50, max: 10000 },
  { key: 'tts.voice', label: '普通话音色', placeholder: '例如 zh-CN-XiaoxiaoNeural' },
  { key: 'tts.rate', label: '语速' }, { key: 'tts.pitch', label: '音高' }, { key: 'tts.volume', label: '音量' },
  { key: 'subtitle.position', label: '字幕位置', options: { lowerSafe: '下方安全区', upperSafe: '上方安全区' } },
  { key: 'subtitle.font', label: '字幕字体' },
  { key: 'subtitle.sizePx', label: '字幕字号（像素）', min: 12, max: 160 },
  { key: 'subtitle.color', label: '字幕颜色' }, { key: 'subtitle.background', label: '字幕背景色' },
  { key: 'subtitle.opacity', label: '字幕背景透明度', min: 0, max: 1, step: 0.01 },
  { key: 'output.fps', label: '帧率', options: { 15: '15', 24: '24', 25: '25', 30: '30' }, numeric: true },
];
const sourceLabels: Record<string, string> = { project: '项目覆盖', global: '全局设置', default: '系统默认' };
const purposeLabels: Record<string, string> = { discuss: '需求讨论', requirements: '整理材料', system: '生成系统', plan: '生成方案' };

export function SettingsPanel({ project, busy, onProjectChange }: {
  project: Project | null; busy: boolean; onProjectChange: (project: Project) => void;
}) {
  const [projectScope, setProjectScope] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionError, setConnectionError] = useState('');
  const [probing, setProbing] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void api.listConnections().then((items) => { if (alive) setConnections(items); })
      .catch((error: Error) => { if (alive) setConnectionError(error.message); });
    return () => { alive = false; };
  }, []);

  async function probe(id: string) {
    setProbing(id);
    setConnectionError('');
    try {
      const result = await api.probeConnection(id);
      setConnections((items) => items.map((item) => item.id === id ? { ...item, lastProbe: { ...result, at: new Date().toISOString() } } : item));
    } catch (error) { setConnectionError(error instanceof Error ? error.message : '连接探测失败。'); }
    finally { setProbing(null); }
  }

  const id = projectScope ? project?.id : undefined;
  const availableConnections = connections.filter((item) => item.kind === 'codex_app_server' && item.enabled);
  return <>
    <section className="panel">
      <div className="panel-head"><h2>AI 连接</h2></div>
      <div className="handoff-body settings-body">
        {connectionError && <p role="alert">{connectionError}</p>}
        {availableConnections.map((item) => <div key={item.id} className="settings-connection">
          <strong>{item.name}</strong>
          <button className="text-button" type="button" disabled={probing !== null} onClick={() => void probe(item.id)}>
            {probing === item.id ? '正在检查' : '检查连接'}
          </button>
          <p>{item.lastProbe?.detail ?? '尚未检查连接'}</p>
          {item.lastProbe?.capabilities.purposes.length ? <p>适配器能力：{item.lastProbe.capabilities.purposes.map((purpose) => purposeLabels[purpose] ?? purpose).join('、')}</p> : null}
        </div>)}
        {project && <label>项目连接<select value={project.connectionId ?? ''} disabled={busy} onChange={(event) => {
          setConnectionError('');
          void api.patchProject(project.id, { connectionId: event.currentTarget.value || null })
            .then(onProjectChange).catch((error: Error) => setConnectionError(error.message));
        }}>
          <option value="">默认本机 Codex</option>
          {availableConnections.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>}
      </div>
    </section>
    <section className="panel">
      <div className="panel-head"><h2>演示表现</h2>
        <select aria-label="配置范围" value={id ? 'project' : 'global'} onChange={(event) => setProjectScope(event.target.value === 'project')}>
          <option value="global">全局设置</option>
          {project && <option value="project">当前项目</option>}
        </select>
      </div>
      <ProfileForm key={id ?? 'global'} id={id} />
    </section>
  </>;
}

function ProfileForm({ id }: { id?: string }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [edits, setEdits] = useState<Record<string, string | null>>({});
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    void api.readSettings(id).then((data) => { if (alive) setSettings(data); })
      .catch((error: Error) => { if (alive) setMessage(error.message); });
    return () => { alive = false; };
  }, [id]);
  if (!settings) return <div className="handoff-body" role="status">{message || '正在读取设置…'}</div>;
  return <form className="handoff-body settings-body" onSubmit={async (event) => {
    event.preventDefault();
    setSaving(true);
    setMessage('');
    const values: SettingsValues = {};
    for (const field of fields) {
      if (!Object.hasOwn(edits, field.key)) continue;
      const raw = edits[field.key];
      const value = raw === null || raw === '' ? null : field.min !== undefined || field.numeric ? Number(raw) : raw;
      const [group, leaf] = field.key.split('.');
      if (leaf) values[group] = { ...(values[group] as Record<string, SettingsValue>), [leaf]: value };
      else values[group] = value;
    }
    try {
      setSettings(await api.saveSettings(id, values, settings.editToken));
      setEdits({});
      setMessage('已保存。');
    } catch (error) {
      setConflict(error instanceof ApiError && error.status === 409);
      setMessage(error instanceof Error ? error.message : '保存设置失败。');
    } finally { setSaving(false); }
  }}>
    <div className="settings-grid">{fields.map((field) => {
      const effective = leafValue(settings.effective, field.key);
      const saved = leafValue(settings.values, field.key);
      const current = Object.hasOwn(edits, field.key) ? edits[field.key] : saved;
      const label = id ? '继承' : '使用默认';
      return <label key={field.key}>{field.label}
        {field.options ? <select value={current ?? ''} onChange={(event) => setEdits({ ...edits, [field.key]: event.target.value })}>
          <option value="">{label}</option>
          {Object.entries(field.options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}
        </select> : <input type={field.min === undefined ? 'text' : 'number'} min={field.min} max={field.max} step={field.step}
          placeholder={field.placeholder ?? label} value={current ?? ''} onChange={(event) => setEdits({ ...edits, [field.key]: event.target.value })} />}
        <small>生效值：{effective ?? '未设置'} · {sourceLabels[settings.sources[field.key]]}</small>
      </label>;
    })}</div>
    <div className="form-row">
      <button className="button primary" type="submit" disabled={saving || conflict || !Object.keys(edits).length}>保存设置</button>
      {conflict && <button className="text-button" type="button" onClick={() => {
        void api.readSettings(id).then((data) => { setSettings(data); setConflict(false); setMessage('已读取当前设置，可复核后重新保存。'); })
          .catch((error: Error) => setMessage(error.message));
      }}>读取最新设置</button>}
      <span role="status">{message}</span>
    </div>
  </form>;
}

function leafValue(values: SettingsValues, key: string) {
  const [group, field] = key.split('.');
  const value = values[group];
  return typeof value === 'object' && value !== null ? value[field] : value;
}
