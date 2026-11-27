import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError } from './api';
import type { Project, Requirement, RequirementScope } from './api';

type Row = Requirement & { key: string };
const fields = ['text', 'outcome'] as const;
const labels = { text: '需求条款', outcome: '预期结果' };

export function RequirementsPanel({ project, proposalTask, busy, onGenerate, onSaved }: {
  project: Project;
  proposalTask?: string;
  busy: boolean;
  onGenerate: () => void;
  onSaved: () => void;
}) {
  const [scope, setScope] = useState<RequirementScope | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [proposal, setProposal] = useState<Requirement[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [conflict, setConflict] = useState(false);

  function showScope(value: RequirementScope) {
    setScope(value);
    setRows(value.items.map(({ sortOrder: _order, ...item }) => ({ ...item, key: item.id })));
    setDirty(false);
  }

  useEffect(() => {
    let alive = true;
    void api.getRequirements(project.id).then((value) => {
      if (!alive) return;
      showScope(value);
      setProposal(value.proposal);
      setConflict(false);
      setError('');
    }).catch((reason: unknown) => {
      if (alive) setError(reason instanceof Error ? reason.message : '无法读取制作范围。');
    });
    return () => { alive = false; };
  }, [project.id, reload]);

  useEffect(() => {
    if (!proposalTask) return;
    let alive = true;
    void api.getRequirements(project.id).then((value) => { if (alive) setProposal(value.proposal); })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '无法读取条款提案。');
      });
    return () => { alive = false; };
  }, [project.id, proposalTask]);

  function update(next: Row[]) {
    setRows(next);
    setDirty(true);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!scope || busy || saving || !dirty || conflict) return;
    setSaving(true);
    setError('');
    try {
      const value = await api.saveRequirements(project.id, rows.map(({ key: _key, ...item }) => item), scope.editToken);
      showScope(value);
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存制作范围。');
      setConflict(reason instanceof ApiError && reason.code === 'EDIT_CONFLICT');
    } finally {
      setSaving(false);
    }
  }

  const disabled = busy || saving || !scope || conflict;
  const confirmedCount = scope?.items.filter(({ confirmed }) => confirmed).length ?? 0;
  const additions = proposal.filter((item) => !rows.some((row) => fields.every((field) => item[field] === row[field])
    && JSON.stringify(item.sourceRef) === JSON.stringify(row.sourceRef)));
  return <details className="brief-details">
    <summary>确认制作范围{scope?.items.length ? `（${confirmedCount}/${scope.items.length} 已确认）` : ''}</summary>
    <form onSubmit={(event) => void save(event)}>
      {error && <p role="alert">{error}</p>}
      {(conflict || (!scope && error)) && <button type="button" className="text-button"
        onClick={() => setReload((value) => value + 1)}>重新读取条款</button>}
      {rows.map((row, index) => {
        const saved = scope?.items.find(({ id }) => row.id === id);
        const edited = saved && fields.some((field) => row[field].trim() !== saved[field]);
        const patch = (value: Partial<Row>) => update(rows.map((entry) => entry.key === row.key ? { ...entry, ...value } : entry));
        return <fieldset className="requirement-item" key={row.key} disabled={disabled}>
          <legend>条款 {index + 1}</legend>
          {fields.map((field) => <label key={field}>{labels[field]}
            <textarea required maxLength={12000} value={row[field]}
              onChange={(event) => patch({ [field]: event.target.value, confirmed: false })} />
          </label>)}
          {row.sourceRef && <small><a href={
            `/api/v1/artifacts/${encodeURIComponent(row.sourceRef.artifactId)}/content?projectId=${encodeURIComponent(project.id)}&download=1`
          }>原文 {row.sourceRef.locator}</a> · {row.sourceRef.quote}</small>}
          <div className="form-row">
            <label className="requirement-confirm"><input type="checkbox" checked={row.confirmed}
              disabled={edited} onChange={(event) => patch({ confirmed: event.target.checked })} /> 确认该条款</label>
            <button type="button" className="text-button" onClick={() => update(rows.filter(({ key }) => key !== row.key))}>移除</button>
          </div>
          {edited && <small>保存修改后可重新确认。</small>}
        </fieldset>;
      })}
      <div className="form-row">
        <button type="button" className="text-button" disabled={disabled || rows.length >= 200}
          onClick={() => update([...rows, { key: crypto.randomUUID(), text: '', outcome: '', sourceRef: null, confirmed: false }])}>添加条款</button>
        {proposal.length > 0 && <button type="button" className="text-button" disabled={disabled || !additions.length || rows.length >= 200}
          onClick={() => update([...rows, ...additions.slice(0, 200 - rows.length).map(({ text, outcome, sourceRef }) =>
            ({ key: crypto.randomUUID(), text, outcome, sourceRef, confirmed: false }))])}>载入 Codex 提案</button>}
        <button type="submit" className="button" disabled={disabled || !dirty}>{saving ? '保存中' : '保存条款'}</button>
        <button type="button" className="button primary" disabled={disabled || dirty || !confirmedCount || confirmedCount !== scope?.items.length}
          onClick={onGenerate}>{project.currentSourceId ? '重新生成系统' : '生成系统'}</button>
      </div>
    </form>
  </details>;
}
