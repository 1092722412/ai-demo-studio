import { randomUUID } from 'node:crypto';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import { attachmentType, AttachmentError, createAttachmentExtractor, maxAttachmentBytes } from '../attachments.js';
import type { ArtifactRecord, StudioRepository, TaskRecord } from '../store/repository.js';
import { createSettingsService, resolveSpeech } from '../settings.js';
import { renderSpeech, type SpeechRenderer } from '../speech.js';

export function createArtifactJobs(repository: StudioRepository, renderer: SpeechRenderer = renderSpeech) {
  const extract = createAttachmentExtractor(repository);
  const jobs = new Map<string, Promise<void>>();
  function finish(task: TaskRecord, state: 'succeeded' | 'failed' | 'cancelled', payload: Record<string, unknown>, artifact?: ArtifactRecord) {
    const now = new Date().toISOString();
    repository.transaction((tx) => {
      if (artifact) {
        tx.registerArtifact(artifact);
        tx.appendEvent({ taskId: task.id, type: 'artifact.created', payload: { artifactId: artifact.id, kind: artifact.kind }, createdAt: now });
      }
      tx.saveTask({ ...task, state, endedAt: now, ...(state === 'succeeded' ? { result: payload } : { error: payload }) });
      tx.appendEvent({ taskId: task.id, type: 'task.' + state, payload, createdAt: now });
    });
  }
  function assertIdle(tx: StudioRepository, projectId: string) {
    if (tx.listTasks(projectId).some(({ state }) => ['queued', 'running', 'waiting_input', 'cancelling'].includes(state))) {
      throw new AttachmentError('RESOURCE_BUSY', '项目已有任务正在执行。', 409);
    }
  }
  function track(taskId: string, execute: () => Promise<void>) {
    const job = execute().finally(() => jobs.delete(taskId));
    jobs.set(taskId, job);
    void job.catch(() => {});
  }
  return {
    preview(projectId: string, input: Record<string, unknown>) {
      if (!repository.getProject(projectId)) throw new AttachmentError('VALIDATION_FAILED', '未找到项目。', 404);
      const { text, ...overrides } = input;
      if (typeof text !== 'string' || !text.trim() || text.length > 2000) {
        throw new AttachmentError('VALIDATION_FAILED', '请输入不超过 2000 字的当前试听讲解。', 422);
      }
      const profile = createSettingsService(repository).read('project:' + projectId).effective;
      const speech = resolveSpeech(profile, overrides);
      const taskId = 't-' + randomUUID();
      const id = 'a-' + randomUUID();
      const relativePath = 'media/' + id + '.mp3';
      const outputPath = repository.getNewArtifactPath(projectId, relativePath);
      const temporary = outputPath + '.partial';
      const textPath = outputPath + '.txt';
      const now = new Date().toISOString();
      const task: TaskRecord = {
        id: taskId, projectId, kind: 'render', state: 'running', phase: 'speech_preview',
        input: { profile: { ...profile, tts: speech } }, request: { operation: 'speech_preview' },
        requestId: taskId, createdAt: now, startedAt: now,
      };
      repository.transaction((tx) => {
        assertIdle(tx, projectId);
        tx.saveTask(task);
        tx.appendEvent({ taskId, type: 'task.started', payload: { state: 'running' }, createdAt: now });
      });
      track(taskId, async () => {
        let published = false;
        try {
          await writeFile(textPath, text, { flag: 'wx' });
          await renderer({ textPath, outputPath: temporary, speech });
          const bytes = (await stat(temporary)).size;
          if (!bytes) throw new Error('empty audio');
          if (repository.getTask(taskId)?.state !== 'cancelling') {
            await rename(temporary, outputPath);
            if (repository.getTask(taskId)?.state !== 'cancelling') {
              finish(task, 'succeeded', { artifactId: id }, {
                id, projectId, taskId, relativePath, kind: 'media', mime: 'audio/mpeg', bytes, state: 'available',
                createdAt: new Date().toISOString(), metadata: { subtype: 'speech' },
              });
              published = true;
              return;
            }
          }
          finish(task, 'cancelled', { code: 'TASK_CANCELLED', message: '试听任务已停止。', retryable: false });
        } catch {
          if (repository.getTask(taskId)?.state === 'cancelling') {
            finish(task, 'cancelled', { code: 'TASK_CANCELLED', message: '试听任务已停止。', retryable: false });
          } else {
            finish(task, 'failed', { code: 'RENDER_FAILED', message: '语音合成失败，请检查 edge-tts、网络及所选音色。', retryable: true });
          }
        } finally {
          await Promise.allSettled([rm(textPath, { force: true }), rm(temporary, { force: true }),
            ...(published ? [] : [rm(outputPath, { force: true })])]);
        }
      });
      return { taskId };
    },
    async upload(projectId: string, name: string, mime: string, bytes: Uint8Array) {
      const type = attachmentType(name, mime);
      if (bytes.byteLength > maxAttachmentBytes) throw new AttachmentError('LIMIT_EXCEEDED', '附件超过 20 MiB 限制。', 413);
      if (!repository.getProject(projectId)) throw new AttachmentError('VALIDATION_FAILED', '未找到项目。', 404);
      const now = new Date().toISOString();
      const taskId = 't-' + randomUUID();
      const artifactId = 'a-' + randomUUID();
      const task: TaskRecord = {
        id: taskId, projectId, kind: 'build', state: 'queued', phase: 'extract',
        input: { artifactId }, requestId: taskId, request: { operation: 'extract', artifactId }, createdAt: now,
      };
      const artifact: ArtifactRecord = {
        id: artifactId, projectId, taskId, kind: 'attachment', relativePath: 'attachments/' + artifactId + type.extension,
        state: 'available', mime: type.mime, bytes: bytes.byteLength, createdAt: now, metadata: { name },
      };
      const path = repository.getNewArtifactPath(projectId, artifact.relativePath);
      await writeFile(path, bytes, { flag: 'wx' });
      try {
        repository.transaction((tx) => {
          assertIdle(tx, projectId);
          tx.saveTask(task);
          tx.registerArtifact(artifact);
          tx.appendEvent({ taskId, type: 'task.started', payload: { state: 'queued' }, createdAt: now });
          tx.appendEvent({ taskId, type: 'artifact.created', payload: { artifactId, kind: 'attachment' }, createdAt: now });
        });
      } catch (error) {
        await rm(path, { force: true });
        throw error;
      }
      track(taskId, async () => {
        const running = { ...task, state: 'running', startedAt: new Date().toISOString() } as const;
        repository.saveTask(running);
        let result: { state: 'succeeded' | 'failed'; payload: Record<string, unknown> };
        try {
          const extracted = await extract(artifact);
          result = { state: 'succeeded', payload: { artifactId, sourceCount: extracted.sourceRefs.length } };
        } catch (error) {
          const failure = error instanceof AttachmentError ? error : new AttachmentError('VALIDATION_FAILED', '无法读取附件原文。', 422);
          result = { state: 'failed', payload: { code: failure.code, message: failure.message, retryable: false } };
        }
        if (repository.getTask(taskId)?.state === 'cancelling') {
          finish(running, 'cancelled', { code: 'TASK_CANCELLED', message: '附件提取已停止。', retryable: false });
        } else {
          finish(running, result.state, result.payload);
        }
      });
      return { artifactId, taskId, extractionState: 'pending' };
    },
    cancel(task: TaskRecord) {
      if (!jobs.has(task.id)) return false;
      if (task.state !== 'cancelling') {
        repository.transaction((tx) => {
          tx.saveTask({ ...task, state: 'cancelling' });
          tx.appendEvent({ taskId: task.id, type: 'task.phase', payload: { phase: 'cancelling' }, createdAt: new Date().toISOString() });
        });
      }
      return true;
    },
    async close() { await Promise.allSettled(jobs.values()); },
  };
}
