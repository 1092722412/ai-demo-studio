import { randomUUID } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import type { ArtifactRecord, StudioRepository, TaskRecord } from './store/repository.js';
import { invalidatePlan, planObject, PlanError } from './plans.js';

const directories = {
  attachment: 'attachments', source: 'source', plan: 'plan', script: 'scripts',
  capture: 'capture', media: 'media', video: 'media', log: 'logs',
} satisfies Record<ArtifactRecord['kind'], string>;

export const sourceArchiveLimit = 20 * 1024 * 1024;
const sourceReadLimit = 8 * 1024 * 1024;

export function isSourcePath(path: string): boolean {
  return !/[\\:\x00-\x1f<>|"*?]/.test(path) && path.split('/').every((part) =>
    part && part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

// 仅读取经筛选的压缩条目，文件名始终只在 ZIP 索引中使用。
export function openSourceArchive(bytes: Uint8Array, entriesToRead: ReadonlyMap<string, number> = new Map()) {
  if (bytes.byteLength > sourceArchiveLimit) throw new PlanError('SOURCE_CHECK_FAILED', '当前源码包超过读取上限。');
  const names = new Set<string>();
  const folded = new Set<string>();
  let selectedBytes = 0;
  try {
    const files = unzipSync(bytes, { filter: ({ name, size, originalSize, compression }) => {
      const directory = name.endsWith('/');
      const path = directory ? name.slice(0, -1) : name;
      const key = path.toLowerCase();
      if (!isSourcePath(path) || folded.has(key) || folded.size >= 10_000) {
        throw new Error('源码包路径无效。');
      }
      folded.add(key);
      if (directory) return false;
      names.add(name);
      const limit = entriesToRead.get(name);
      if (limit === undefined) return false;
      const readSize = compression === 0 ? size : originalSize;
      selectedBytes += readSize;
      if (readSize > limit || selectedBytes > sourceReadLimit || size > bytes.byteLength) {
        throw new Error('源码文件超过读取上限。');
      }
      return true;
    } });
    if (names.size === 0) throw new Error('源码包为空。');
    return { names, files };
  } catch {
    throw new PlanError('SOURCE_CHECK_FAILED', '源码包无法读取，或含有无效的项目内路径。');
  }
}

export type ArtifactFile = {
  kind: ArtifactRecord['kind'];
  extension: string;
  mime: string;
  bytes: Uint8Array;
  partial?: boolean;
  metadata?: unknown;
};

export function createArtifactService(repository: StudioRepository) {
  return {
    async publishArtifact(taskId: string, file: ArtifactFile,
      onPublished?: (tx: StudioRepository, artifact: ArtifactRecord) => void): Promise<ArtifactRecord> {
      const task = repository.getTask(taskId);
      if (!task || task.state !== 'running') {
        throw new PlanError('RESOURCE_BUSY', '只有运行中的任务可以发布成果。', 409);
      }
      if (!Object.hasOwn(directories, file.kind) || !/^\.[a-z0-9]{1,10}$/i.test(file.extension)
          || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mime) || file.bytes.byteLength === 0) {
        throw new PlanError('VALIDATION_FAILED', '成果类型、扩展名或文件内容无效。');
      }
      if (file.kind === 'source' && !file.partial) {
        if (file.extension !== '.zip' || file.mime !== 'application/zip') {
          throw new PlanError('SOURCE_CHECK_FAILED', '当前源码须发布为 ZIP 包。');
        }
        const metadata = planObject(file.metadata);
        if ((metadata?.sourceKind !== 'generated' && metadata?.sourceKind !== 'imported')
            || typeof metadata.adapterId !== 'string' || !/^[a-z][a-z0-9-]*$/.test(metadata.adapterId)) {
          throw new PlanError('SOURCE_CHECK_FAILED', '当前源码须登记来源类型和项目适配器。');
        }
        openSourceArchive(file.bytes);
      }
      const id = 'a-' + randomUUID();
      const projectId = task.projectId;
      const relativePath = directories[file.kind] + '/' + id + file.extension;
      const initialPath = repository.getNewArtifactPath(projectId, relativePath);
      const stagingPath = initialPath + '.tmp';
      const createdAt = new Date().toISOString();
      repository.registerArtifact({ id, taskId, projectId, relativePath, kind: file.kind,
        mime: file.mime, bytes: 0, state: 'pending', metadata: file.metadata, createdAt });
      let renamed: string | undefined;
      try {
        await writeFile(stagingPath, file.bytes, { flag: 'wx' });
        return repository.transaction((tx) => {
          const partial = file.partial || tx.getTask(taskId)?.state !== 'running';
          const finalPath = partial ? initialPath + '.partial' : initialPath;
          renameSync(stagingPath, finalPath);
          renamed = finalPath;
          const artifact = tx.finalizeArtifact(id, partial ? 'partial' : 'available', file.bytes.byteLength,
            partial ? relativePath + '.partial' : relativePath);
          tx.appendEvent({ taskId, type: 'artifact.created', payload: { artifactId: id, kind: file.kind, state: artifact.state }, createdAt });
          if (!partial) {
            const project = tx.getProject(projectId)!;
            const now = new Date().toISOString();
            if (file.kind === 'source') {
              invalidatePlan(tx, projectId, now);
              tx.updateProject({ ...project, currentSourceId: id, stage: 'plan', updatedAt: now });
            }
            if (file.kind === 'video') {
              tx.updateProject({ ...project, currentVideoId: id, stage: 'review', updatedAt: now });
            }
            onPublished?.(tx, artifact);
          }
          return artifact;
        });
      } catch (cause) {
        await Promise.allSettled([rm(stagingPath, { force: true }), ...(renamed ? [rm(renamed, { force: true })] : [])]);
        repository.finalizeArtifact(id, 'missing', 0);
        if (cause instanceof PlanError) throw cause;
        throw new PlanError('OUTPUT_INVALID', '成果发布失败，当前文件未被替换。', 422, undefined, { cause });
      }
    },
  };
}

function recoverPendingZip(repository: StudioRepository, artifact: ArtifactRecord): ArtifactRecord {
  const relativePath = directories[artifact.kind] + '/' + artifact.id + '.zip';
  let partialSize: number | undefined;
  if (artifact.relativePath === relativePath) {
    try {
      const path = repository.getNewArtifactPath(artifact.projectId, relativePath);
      const partialPath = path + '.partial';
      for (const candidate of [partialPath, path, path + '.tmp']) {
        const info = lstatSync(candidate, { throwIfNoEntry: false });
        if (!info?.isFile()) continue;
        if (candidate !== partialPath) renameSync(candidate, partialPath);
        partialSize = info.size;
        break;
      }
    } catch {
      // 无法安全收尾的文件在成果索引中记为缺失。
    }
  }
  return partialSize === undefined ? repository.finalizeArtifact(artifact.id, 'missing', 0)
    : repository.finalizeArtifact(artifact.id, 'partial', partialSize, relativePath + '.partial');
}

export function recoverZipPublications(repository: StudioRepository, kind: 'script' | 'source',
  matches: (task: TaskRecord) => boolean, message: string): void {
  for (const project of repository.listProjects()) {
    const tasks = repository.listTasks(project.id).filter((task) =>
      ['queued', 'running', 'waiting_input', 'cancelling'].includes(task.state) && matches(task));
    if (!tasks.length) continue;
    repository.transaction((tx) => {
      const pending = tx.listArtifacts(project.id, kind).filter(({ state }) => state === 'pending');
      const createdAt = new Date().toISOString();
      for (const task of tasks) {
        for (const entry of pending.filter(({ taskId }) => taskId === task.id)) {
          const artifact = recoverPendingZip(tx, entry);
          tx.appendEvent({ taskId: task.id, type: 'artifact.created', payload: {
            artifactId: artifact.id, kind, state: artifact.state,
          }, createdAt });
        }
        const error = { code: 'WORKER_LOST', message, retryable: true };
        tx.saveTask({ ...task, state: 'interrupted', phase: 'interrupted', waitingInput: null, error, endedAt: createdAt });
        tx.appendEvent({ taskId: task.id, type: 'task.interrupted', payload: error, createdAt });
      }
    });
  }
}

export function artifactAvailability(repository: StudioRepository, artifact: ArtifactRecord): ArtifactRecord {
  if (artifact.state === 'missing' || artifact.state === 'pending') return artifact;
  try {
    if (repository.getArtifactPath(artifact.projectId, artifact.id)) return artifact;
  } catch {
    // 文件被移动或路径不再处于项目边界时，对外只显示为缺失。
  }
  return { ...artifact, state: 'missing', bytes: 0 };
}

export function videoRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || !(match[1] || match[2]) || size < 1) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}
