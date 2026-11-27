import { createHash, randomUUID } from 'node:crypto';
import { invalidatePlan, PlanError, planObject } from './plans.js';
import type { RequirementRecord, StudioRepository } from './store/repository.js';

export function requirementsReady(items: readonly RequirementRecord[]): boolean {
  return items.length > 0 && items.every((item) => item.confirmed);
}

function scopeText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw new PlanError('VALIDATION_FAILED', '条款内容为空或超出长度限制。', 422, field);
  }
  return value.trim();
}

export function createRequirementsService(repository: StudioRepository) {
  function read(projectId: string) {
    const project = repository.getProject(projectId);
    if (!project) throw new PlanError('VALIDATION_FAILED', '找不到此项目。', 404);
    const items = repository.listRequirements(projectId);
    const editToken = createHash('sha256').update(JSON.stringify([project.brief, items])).digest('hex');
    return { items, editToken };
  }

  return {
    read(projectId: string) {
      const current = read(projectId);
      const latest = repository.listTasks(projectId).find(({ purpose, state }) => purpose === 'requirements' && state === 'succeeded');
      const delivery = planObject(planObject(latest?.result)?.delivery);
      const proposal = delivery?.kind === 'requirements' && Array.isArray(delivery.items) ? delivery.items : [];
      return { ...current, proposal };
    },
    save(projectId: string, value: unknown, ifMatch: string | null) {
      if (!ifMatch) throw new PlanError('EDIT_PRECONDITION_REQUIRED', '保存条款必须提供 If-Match。', 428);
      const input = planObject(value)?.items;
      if (!Array.isArray(input) || input.length > 200) {
        throw new PlanError('VALIDATION_FAILED', '请提供最多 200 项需求条款。', 422, 'items');
      }
      return repository.transaction((tx) => {
        const current = read(projectId);
        if (ifMatch.replace(/^"([^"\s]+)"$/, '$1') !== current.editToken) {
          throw new PlanError('EDIT_CONFLICT', '需求范围已变更，请重新读取。', 409);
        }
        if (tx.listTasks(projectId).some(({ state }) => ['queued', 'running', 'waiting_input', 'cancelling'].includes(state))) {
          throw new PlanError('RESOURCE_BUSY', '项目有任务正在执行，暂时不能修改需求范围。', 409);
        }
        const previous = new Map(current.items.map((item) => [item.id, item]));
        const used = new Set<string>();
        const items = input.map((value, index): RequirementRecord => {
          const field = '/items/' + index;
          const entry = planObject(value);
          if (!entry || typeof entry.confirmed !== 'boolean' || typeof entry.sortOrder !== 'number'
              || !Number.isSafeInteger(entry.sortOrder) || entry.sortOrder < 0) {
            throw new PlanError('VALIDATION_FAILED', '条款必须包含确认状态和有效排序。', 422, field);
          }
          const old = typeof entry.id === 'string' ? previous.get(entry.id) : undefined;
          if (entry.id !== undefined && (!old || used.has(old.id))) {
            throw new PlanError('VALIDATION_FAILED', '条款编号不属于当前项目或重复出现。', 422, field + '/id');
          }
          const id = old?.id ?? 'r-' + randomUUID();
          used.add(id);
          const text = scopeText(entry.text, field + '/text', 12_000);
          const outcome = scopeText(entry.outcome, field + '/outcome', 12_000);
          let sourceRef: RequirementRecord['sourceRef'] = null;
          if (entry.sourceRef != null) {
            const ref = planObject(entry.sourceRef);
            const artifactId = scopeText(ref?.artifactId, field + '/sourceRef/artifactId', 128);
            const artifact = tx.getArtifact(artifactId, projectId);
            if (artifact?.kind !== 'attachment' || artifact.state !== 'available') {
              throw new PlanError('VALIDATION_FAILED', '出处必须引用本项目的可用附件。', 422, field + '/sourceRef');
            }
            sourceRef = { artifactId, locator: scopeText(ref?.locator, field + '/sourceRef/locator', 200),
              quote: scopeText(ref?.quote, field + '/sourceRef/quote', 2_000) };
          }
          const changed = old && (old.text !== text || old.outcome !== outcome
            || JSON.stringify(old.sourceRef) !== JSON.stringify(sourceRef));
          return { id, text, outcome, sourceRef, confirmed: entry.confirmed && !changed, sortOrder: entry.sortOrder };
        }).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
        if (JSON.stringify(items) === JSON.stringify(current.items)) return current;
        const project = tx.getProject(projectId)!;
        const updatedAt = new Date().toISOString();
        tx.replaceRequirements(projectId, items);
        invalidatePlan(tx, projectId, updatedAt);
        tx.updateProject({ ...project, stage: requirementsReady(items) ? 'system' : 'requirements', updatedAt });
        return read(projectId);
      });
    },
  };
}
