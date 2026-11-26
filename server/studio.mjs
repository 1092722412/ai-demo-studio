import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttpApp } from '../dist-server/http.js';
import { CodexAppServerManager } from '../dist-server/ai/codex-app-server.js';
import { initializeStore } from '../dist-server/store/repository.js';
import { TaskService } from '../dist-server/tasks.js';

const applicationRoot = fileURLToPath(new URL('..', import.meta.url));
const skillRelativePath = '.agents/skills/bid-demo-system/SKILL.md';

export async function createStudio({
  dataRoot = process.env.DEMO_STUDIO_DATA_DIR || join(applicationRoot, '.studio'),
  adapter: injectedAdapter,
} = {}) {
  const dataDirectory = resolve(dataRoot);
  const projectDirectory = join(dataDirectory, 'projects');
  await mkdir(projectDirectory, { recursive: true });
  const repository = await initializeStore(dataDirectory);
  const defaultConnection = {
    id: 'codex-local',
    kind: 'codex',
    provider: 'codex',
    model: process.env.DEMO_STUDIO_CODEX_MODEL || '',
  };
  const skillText = await readFile(join(applicationRoot, skillRelativePath), 'utf8');
  const skill = {
    name: 'bid-demo-system',
    text: skillText,
    digest: createHash('sha256').update(skillText).digest('hex'),
  };
  const adapter = injectedAdapter ?? new CodexAppServerManager({ projectRoot: applicationRoot, systemRoot: applicationRoot });
  const tools = { call: async () => ({ ok: false, error: { code: 'CAPABILITY_UNSUPPORTED', message: '当前工作台未开放此工具。' } }) };

  const tasks = new TaskService({
    adapter,
    createRuntime: async (input) => {
      const projectRoot = join(projectDirectory, input.projectId);
      await mkdir(projectRoot, { recursive: true });
      return { connection: defaultConnection, projectRoot, tools };
    },
    onEvent: (taskId, event) => {
      const task = repository.getTask(taskId);
      if (!task) return;
      const now = new Date().toISOString();
      if (event.type === 'session.bound') {
        if (!task.conversationId) return;
        const conversation = repository.getConversation(task.conversationId, task.projectId);
        if (conversation) repository.saveConversation({ ...conversation, nativeSessionRef: event.nativeSessionRef, updatedAt: now });
        return;
      }
      const type = event.type === 'permission.requested' ? 'input.required' : event.type;
      const payload = event.type === 'message.delta' ? { text: event.text }
        : event.type === 'permission.requested' ? {
            requestId: event.requestId,
            description: event.description,
            options: event.options,
            questions: event.questions ?? [],
          }
          : event;
      repository.transaction((tx) => {
        if (event.type === 'permission.requested') {
          tx.saveTask({ ...task, state: 'waiting_input', phase: 'waiting_input', waitingInput: payload });
        }
        tx.appendEvent({ taskId, type, payload, createdAt: now });
      });
    },
  });

  const adapters = {
    defaultConnection,
    skill,
    getProjectRoot(projectId) { return join(projectDirectory, projectId); },
    buildContext(project, _conversation, messages) {
      return {
        instruction: '你是 AI Demo Studio 的需求讨论助手。依据项目描述和对话回答，不要声称已完成演示系统。',
        brief: `${project.title}\n\n${project.brief}`,
        requirements: [],
        messages: messages.slice(-50).map(({ role, text }) => ({ role: role === 'assistant' ? 'assistant' : 'user', text })),
        fileIndex: repository.listArtifacts(project.id)
          .filter((artifact) => artifact.state === 'available')
          .map((artifact) => ({ artifactId: artifact.id, path: artifact.relativePath, bytes: artifact.bytes })),
        skill,
        toolNames: ['get_demo_brief', 'load_bid_demo_system_skill', 'get_current_source'],
      };
    },
  };

  const app = createHttpApp({ repository, tasks, adapters });
  app.get('/', async (_request, reply) => {
    try {
      const html = await readFile(join(applicationRoot, 'dist', 'index.html'));
      return reply.type('text/html; charset=utf-8').send(html);
    } catch {
      return reply.code(503).type('text/plain; charset=utf-8').send('前端资源不可用，请先运行 npm run build。');
    }
  });
  app.get('/assets/:asset', async (request, reply) => {
    const { asset } = request.params;
    if (!/^[A-Za-z0-9_-]+\.(js|css)$/.test(asset)) {
      return reply.code(404).send({ error: { code: 'VALIDATION_FAILED', message: '未找到资源。', retryable: false } });
    }
    try {
      const bytes = await readFile(join(applicationRoot, 'dist', 'assets', asset));
      const contentType = asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8';
      return reply.type(contentType).send(bytes);
    } catch {
      return reply.code(404).send({ error: { code: 'VALIDATION_FAILED', message: '未找到资源。', retryable: false } });
    }
  });
  return {
    app,
    repository,
    tasks,
    listen(port) { return app.listen({ port, host: '127.0.0.1' }); },
    async close() {
      await app.close();
      await adapter.close?.();
      repository.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = await createStudio();
  try {
    const url = await studio.listen(Number(process.env.DEMO_STUDIO_PORT || 17860));
    console.log('AI Demo Studio 已启动：' + url);
    if (process.platform === 'win32' && process.env.DEMO_STUDIO_OPEN === '1') {
      const browser = spawn('explorer.exe', [url], { windowsHide: true, stdio: 'ignore', detached: true });
      browser.on('error', () => console.warn('浏览器未能自动打开，请访问上方地址。'));
      browser.unref();
    }
  } catch (error) {
    await studio.close();
    console.error(error.code === 'EADDRINUSE' ? '工作台端口已占用。若工作台已在运行，可直接打开原地址。' : error.message);
    process.exitCode = 1;
  }
}
