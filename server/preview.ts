import { statSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openSourceArchive, sourceArchiveLimit } from './artifacts.js';
import { PlanError } from './plans.js';
import type { StudioRepository } from './store/repository.js';

const generatedFiles = ['manifest.json', 'page.html', 'style.css', 'app.js', 'seed/data.json', 'seed/state.json'];
const legacyFiles = ['spec.json', 'seed/records.json'];
const entries = new Map([...generatedFiles, ...legacyFiles].map((name) => [name, 512 * 1024]));

type PreviewServer = {
  listening: boolean;
  address(): { port: number } | string | null;
  once(event: 'error', listener: (error: Error) => void): void;
  removeListener(event: 'error', listener: (error: Error) => void): void;
  listen(port: number, host: string, listener: () => void): void;
  close(listener: () => void): void;
  closeAllConnections(): void;
};

type Preview = { sourceId: string; directory: string; server: PreviewServer; previewUrl: string; generated: boolean };
type Source = NonNullable<ReturnType<StudioRepository['getArtifactPath']>>;

function listen(server: PreviewServer): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('预览监听地址不可用。'));
      resolve('http://127.0.0.1:' + address.port);
    });
  });
}

async function dispose(directory: string, server?: PreviewServer) {
  if (server?.listening) {
    await new Promise<void>((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3 });
}

function sourceUnavailable(): never {
  throw new PlanError('SOURCE_CHECK_FAILED', '当前源码文件不可用。');
}

function previewUnavailable(): PlanError {
  return new PlanError('PREVIEW_UNAVAILABLE', '当前源码的本机预览未能启动，请重新打开预览。', 503);
}

function getSource(repository: StudioRepository, projectId: string, sourceId: string | null): Source | null {
  if (!sourceId) return null;
  try {
    const source = repository.getArtifactPath(projectId, sourceId);
    if (!source || source.artifact.kind !== 'source' || source.artifact.state !== 'available') return null;
    const { size } = statSync(source.path);
    return size > 0 && size <= sourceArchiveLimit && size === source.artifact.bytes ? source : null;
  } catch {
    return null;
  }
}

async function startPreview(repository: StudioRepository, source: Source): Promise<Preview> {
  let archive;
  try {
    archive = await readFile(source.path);
  } catch {
    sourceUnavailable();
  }
  if (archive.byteLength !== source.artifact.bytes) sourceUnavailable();
  const { names, files } = openSourceArchive(archive, entries);
  const generated = generatedFiles.every((name) => names.has(name));
  const required = generated ? generatedFiles : legacyFiles;
  if (!required.every((name) => names.has(name))) {
    throw new PlanError('SOURCE_CHECK_FAILED', '当前源码包缺少固定预览模板所需的文件。');
  }
  let directory;
  let server: PreviewServer | undefined;
  try {
    directory = await mkdtemp(repository.getNewArtifactPath(source.artifact.projectId, 'previews/session-'));
    // ZIP 中只物化模板读取的固定文件，包内的服务端入口不参与预览。
    await mkdir(join(directory, 'seed'));
    for (const name of required) await writeFile(join(directory, name), files[name]);
    const options = { sourceDir: directory, dataDir: join(directory, '.runtime') };
    if (generated) {
      const template = await import(new URL('../template/generated-server.mjs', import.meta.url).href);
      server = await template.createGeneratedServer(options) as PreviewServer;
    } else {
      const template = await import(new URL('../template/server.mjs', import.meta.url).href);
      server = await template.createDemoServer({ ...options, preview: true }) as PreviewServer;
    }
    const previewUrl = await listen(server);
    const health = await fetch(previewUrl + '/api/health', { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!health.ok) {
      await health.body?.cancel();
      throw previewUnavailable();
    }
    if ((await health.json()).status !== 'ok') throw previewUnavailable();
    return { sourceId: source.artifact.id, directory, server, previewUrl, generated };
  } catch {
    if (directory) await dispose(directory, server);
    throw previewUnavailable();
  }
}

export function createPreviewService(repository: StudioRepository) {
  const active = new Map<string, Preview>();
  const pending = new Map<string, Promise<unknown>>();
  let closing = false;

  function serialize<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const next = (pending.get(projectId) ?? Promise.resolve()).catch(() => {}).then(action);
    pending.set(projectId, next);
    const forget = () => { if (pending.get(projectId) === next) pending.delete(projectId); };
    void next.then(forget, forget);
    return next;
  }

  async function stop(projectId: string) {
    const preview = active.get(projectId);
    if (!preview) return;
    await dispose(preview.directory, preview.server);
    active.delete(projectId);
  }

  function openSession(projectId: string, expectedSourceId?: string) {
    return serialize(projectId, async () => {
      if (closing) throw previewUnavailable();
      const project = repository.getProject(projectId);
      if (!project) throw new PlanError('VALIDATION_FAILED', '未找到项目。', 404);
      if (expectedSourceId && project.currentSourceId !== expectedSourceId) {
        throw new PlanError('PLAN_STALE', '录制所用源码已变更。', 409);
      }
      const source = getSource(repository, projectId, project.currentSourceId);
      if (!source) {
        await stop(projectId);
        sourceUnavailable();
      }
      const current = active.get(projectId);
      if (current?.sourceId === source.artifact.id && current.server.listening) {
        return current;
      }
      await stop(projectId);
      const preview = await startPreview(repository, source);
      active.set(projectId, preview);
      if (closing || repository.getProject(projectId)?.currentSourceId !== preview.sourceId) {
        await stop(projectId);
        throw new PlanError('RESOURCE_BUSY', '预览启动期间当前源码或工作台状态已改变，请重试。', 409);
      }
      return preview;
    });
  }

  return {
    async open(projectId: string) {
      return { previewUrl: (await openSession(projectId)).previewUrl };
    },
    async recordingTarget(projectId: string, sourceId: string) {
      const { previewUrl, directory, generated } = await openSession(projectId, sourceId);
      return { url: previewUrl + '/', framePath: generated ? '/demo' : null, ...(generated ? {
        data: { statePath: join(directory, '.runtime', 'state.json'), seedPath: join(directory, 'seed', 'state.json') },
      } : {}) };
    },
    async retire(projectId: string) {
      if (closing) return;
      await serialize(projectId, async () => {
        if (active.get(projectId)?.sourceId !== repository.getProject(projectId)?.currentSourceId) await stop(projectId);
      });
    },
    async close() {
      closing = true;
      await Promise.allSettled(pending.values());
      await Promise.all([...active.keys()].map(stop));
    },
  };
}
