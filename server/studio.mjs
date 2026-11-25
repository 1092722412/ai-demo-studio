import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { createDemoServer } from '../template/server.mjs';
import { createGeneratedServer } from '../template/generated-server.mjs';
import { generateWithCodex } from './codex.mjs';
import { parseBrief, parseGenerated, trimText } from './spec.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const template = join(root, 'template');
const legacyFiles = ['README.md', 'spec.json', 'server.mjs', 'index.html', 'demo.mjs', 'style.css', 'seed/records.json'];
const generatedFiles = ['README.md', 'manifest.json', 'server.mjs', 'page.html', 'style.css', 'app.js', 'seed/data.json', 'seed/state.json', '启动演示.cmd'];
const types = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
};
const note = [
  '# 启动生成的演示系统',
  '',
  '解压后在此目录运行 `node server.mjs`（Node.js 22+，无需安装依赖）。打开终端输出的本机地址。',
  '也可以双击启动演示.cmd。默认端口 18080，可通过 DEMO_PORT 调整。',
  '样例源数据在 seed/data.json，运行初态在 seed/state.json。试用写入 .runtime/state.json。录制时应使用独立的初态目录。',
  'manifest.json 包含技能版本、页面标识、业务操作和预期结果。样例为合成数据，业务计算在演示页面本地执行。',
].join('\n') + '\n';

const launcher = [
  '@echo off', 'cd /d "%~dp0"', 'node server.mjs', 'if errorlevel 1 pause',
].join('\r\n') + '\r\n';

function respond(res, status, data, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...extra });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}

async function requestBody(req) {
  const parts = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 100_000) throw new Error('提交内容超过大小限制。');
    parts.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new Error('提交内容格式无效。');
  }
}

async function writeJson(path, value) {
  const staging = path + '.tmp';
  await writeFile(staging, JSON.stringify(value, null, 2), 'utf8');
  await rename(staging, path);
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve('http://127.0.0.1:' + server.address().port);
    });
  });
}

const stop = (server) => new Promise((resolve) => server.close(resolve));

export async function createStudio({ dataRoot = join(root, '.studio'), generate = generateWithCodex } = {}) {
  const jobsRoot = join(dataRoot, 'jobs');
  const jobs = new Map();
  const previews = new Map();
  let activeJob = null;
  await mkdir(jobsRoot, { recursive: true });
  const jobDir = (id) => join(jobsRoot, id);
  const sourceDir = (id) => join(jobDir(id), 'source');
  const persist = (job) => writeJson(join(jobDir(job.id), 'job.json'), job);
  for (const entry of await readdir(jobsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f-]{36}$/.test(entry.name)) continue;
    try {
      const job = JSON.parse(await readFile(join(jobDir(entry.name), 'job.json'), 'utf8'));
      if (job.id !== entry.name) continue;
      if (['generating', 'building'].includes(job.status)) {
        job.status = 'failed';
        job.error = '工作台曾关闭，生成已中断。可重新生成。';
        await persist(job);
      }
      jobs.set(job.id, job);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error('无法恢复一条任务：', entry.name, error.message);
    }
  }

  async function preview(job, format = job.format) {
    if (previews.has(job.id)) return previews.get(job.id);
    const starting = (async () => {
      const open = format === 'generated' ? createGeneratedServer : createDemoServer;
      const server = await open({
        sourceDir: sourceDir(job.id),
        dataDir: join(jobDir(job.id), 'preview', randomUUID()),
      });
      return { server, url: await listen(server, 0) };
    })();
    previews.set(job.id, starting);
    try { return await starting; }
    catch (error) { previews.delete(job.id); throw error; }
  }

  function latestJob(projectId, readyOnly = false) {
    let latest;
    for (const job of jobs.values()) {
      if (job.projectId === projectId && (!readyOnly || job.status === 'ready') &&
          (!latest || job.version > latest.version)) latest = job;
    }
    return latest;
  }

  async function retireBuild(prior) {
    if (!prior) return;
    const started = previews.get(prior.id);
    previews.delete(prior.id);
    if (started) void started.then(({ server }) => stop(server)).catch(() => {});
    if (!prior.currentOnly) return;
    const previousSource = sourceDir(prior.id);
    const files = [...generatedFiles.map((file) => join(previousSource, file)),
      join(jobDir(prior.id), 'source.zip'), join(jobDir(prior.id), 'codex-output.json')];
    await Promise.all(files.map(async (file) => {
      try { await rm(file, { force: true }); }
      catch (error) { console.error('清理已替换的生成文件失败：', error.code); }
    }));
  }

  async function build(job) {
    try {
      const result = await generate(job, jobDir(job.id), (label, status) => {
        job.activity[0].status = 'done';
        const running = job.activity.findLast((event) => event.label === label && event.status === 'running');
        if (running && status !== 'running') running.status = status;
        else job.activity.push({ label, status });
      }, job.baseBuildId ? sourceDir(job.baseBuildId) : undefined);
      job.activity[0].status = 'done';
      const reply = trimText(result.reply, 12_000);
      if (result.threadId) job.threadId = result.threadId;
      if (result.project === null && reply) {
        job.conversation.push({ role: 'assistant', text: reply });
        job.activity.push({ label: '已回复', status: 'done' });
        await persist({ ...job, status: 'discussed' });
        job.status = 'discussed';
        return;
      }
      const generated = parseGenerated(result);
      const { title, fields, acceptance, skill } = generated;
      const spec = { title, fields };
      const manifest = { source: 'generated', title, controls: fields, acceptance, skill };
      job.status = 'building';
      job.activity.push({ label: '正在构建演示系统', status: 'running' });
      await persist(job);
      const dir = sourceDir(job.id);
      await mkdir(join(dir, 'seed'), { recursive: true });
      await Promise.all([
        writeJson(join(dir, 'manifest.json'), manifest),
        writeJson(join(dir, 'seed', 'data.json'), generated.seed),
        writeJson(join(dir, 'seed', 'state.json'), generated.state),
        writeFile(join(dir, 'README.md'), note, 'utf8'),
        writeFile(join(dir, 'page.html'), generated.body, 'utf8'),
        writeFile(join(dir, 'style.css'), generated.css, 'utf8'),
        writeFile(join(dir, 'app.js'), generated.script, 'utf8'),
        writeFile(join(dir, '启动演示.cmd'), launcher, 'ascii'),
        readFile(join(template, 'generated-server.mjs')).then((source) => writeFile(join(dir, 'server.mjs'), source)),
      ]);
      const archive = Object.fromEntries(await Promise.all(generatedFiles.map(async (file) => [file, await readFile(join(dir, file))])));
      await writeFile(join(jobDir(job.id), 'source.zip'), zipSync(archive));
      const opened = await preview(job, 'generated');
      const health = await fetch(opened.url + '/api/health', { signal: AbortSignal.timeout(3000) });
      if (!health.ok || (await health.json()).status !== 'ok') throw new Error('生成的本地系统未能正常启动。');
      const prior = latestJob(job.projectId, true);
      const ready = { spec, skill, acceptance, format: 'generated', status: 'ready', currentOnly: true };
      if (reply) job.conversation.push({ role: 'assistant', text: reply });
      job.activity.at(-1).status = 'done';
      job.activity.push({ label: '系统预览已就绪', status: 'done' });
      await persist({ ...job, ...ready });
      await retireBuild(prior);
      Object.assign(job, ready);
    } catch (error) {
      for (const event of job.activity) if (event.status === 'running') event.status = 'failed';
      job.status = 'failed';
      job.error = String(error.message || '生成失败。').slice(0, 400);
      job.activity.push({ label: '本轮未完成', status: 'failed' });
      await persist(job);
    } finally {
      activeJob = null;
    }
  }

  function toSummary(job) {
    return { id: job.id, projectId: job.projectId, title: job.brief.title, createdAt: job.createdAt, status: job.status, version: job.version };
  }

  async function beginJob(res, brief, previous, message) {
    const id = randomUUID();
    const projectId = previous?.projectId || id;
    const latest = latestJob(projectId);
    if (previous && latest?.id !== previous.id && message) {
      return respond(res, 409, { error: '该项目已有更新的对话，请切换到最新一轮再发送。', latestId: latest.id });
    }
    if (activeJob) return respond(res, 409, { error: '另一个 Codex 任务正在运行，可在项目列表查看进度。' });
    const conversation = previous?.conversation || (previous ? [{ role: 'user', text: previous.brief.requirement }] : []);
    const job = {
      id, projectId, version: (latest?.version || 0) + 1, brief, createdAt: new Date().toISOString(), status: 'generating',
      conversation: [...conversation, { role: 'user', text: message || brief.requirement }],
      activity: [{ label: '已发送给 Codex', status: 'running' }],
      baseBuildId: previous && latestJob(projectId, true)?.id,
      threadId: previous?.threadId,
      threadRootId: previous?.threadRootId || id,
    };
    activeJob = id;
    try {
      await mkdir(jobDir(id), { recursive: true });
      await persist(job);
      jobs.set(id, job);
    } catch (error) {
      activeJob = null;
      throw error;
    }
    void build(job).catch((error) => console.error('任务状态写入失败：', error.message));
    return respond(res, 202, toSummary(job));
  }

  const server = createServer(async (req, res) => {
    const host = '127.0.0.1:' + server.address().port;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; frame-src http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (req.headers.host !== host) return respond(res, 403, { error: '请通过本机工作台地址访问。' });
    const path = req.url?.split('?')[0] || '/';
    try {
      const messagePath = /^\/api\/jobs\/([0-9a-f-]{36})\/messages$/.exec(path);
      if (req.method === 'POST' && (path === '/api/jobs' || messagePath)) {
        if (req.headers.origin !== 'http://' + host || req.headers['content-type'] !== 'application/json') {
          return respond(res, 403, { error: '请求来源无效。' });
        }
        let input;
        try {
          input = await requestBody(req);
        } catch (error) {
          return respond(res, 400, { error: error.message });
        }
        if (messagePath) {
          const previous = jobs.get(messagePath[1]);
          if (!previous) return respond(res, 404, { error: '找不到该项目对话。' });
          const message = trimText(input?.message, 6000);
          if (!message) return respond(res, 400, { error: '请输入要发给 Codex 的消息。' });
          return await beginJob(res, previous.brief, previous, message);
        }
        let brief;
        try { brief = parseBrief(input); }
        catch (error) { return respond(res, 400, { error: error.message }); }
        const previous = jobs.get(input.previousId);
        return await beginJob(res, brief, previous && latestJob(previous.projectId));
      }
      if (req.method === 'GET') {
        if (path === '/api/jobs') {
          const projectIds = new Set([...jobs.values()].map((job) => job.projectId));
          return respond(res, 200, [...projectIds].map((id) => toSummary(latestJob(id))).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
        }
        const matched = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(.+))?$/.exec(path);
        if (matched) {
          const [, requestedId, action] = matched;
          const requested = jobs.get(requestedId);
          if (!requested) return respond(res, 404, { error: '找不到该演示任务。' });
          const build = latestJob(requested.projectId, true);
          if (!action) {
            const job = { ...latestJob(requested.projectId) };
            const previewUrl = build ? (await preview(build)).url : null;
            return respond(res, 200, {
              ...job, previewUrl, previewJobId: build?.id, previewVersion: build?.version,
              spec: build?.spec, skill: build?.skill, acceptance: build?.acceptance,
            });
          }
          if (!build) return respond(res, 409, { error: '系统尚未生成完成。' });
          const job = build;
          const id = build.id;
          if (action === 'download') {
            const bytes = await readFile(join(jobDir(id), 'source.zip'));
            return respond(res, 200, bytes, 'application/zip', {
              'Content-Disposition': "attachment; filename=demo-source.zip; filename*=UTF-8''" + encodeURIComponent(job.brief.title + '-源码.zip'),
            });
          }
          if (action === 'handoff') return respond(res, 200, {
            buildId: id, version: job.version, title: job.spec.title,
            fields: job.spec.fields,
            ...(job.format === 'generated'
              ? { acceptance: job.acceptance, skill: job.skill, freshSeed: 'seed/state.json' }
              : { testIds: { submit: 'record-save', result: 'record-list', empty: 'records-empty', row: 'record-row', status: 'record-status' }, freshSeed: 'seed/records.json' }),
          }, 'application/json; charset=utf-8', { 'Content-Disposition': 'attachment; filename=demo-handoff.json' });
          const file = action.slice('source/'.length);
          if (action.startsWith('source/') && (job.format === 'generated' ? generatedFiles : legacyFiles).includes(file)) {
            return respond(res, 200, await readFile(join(sourceDir(id), file)), 'text/plain; charset=utf-8');
          }
        }
        if (path === '/' || /^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(path)) {
          const file = path === '/' ? 'index.html' : path.slice(1);
          const dist = join(root, 'dist', file);
          if (path === '/') {
            try { await access(dist); } catch { return respond(res, 503, '请先运行 npm run build。', 'text/plain; charset=utf-8'); }
          }
          return respond(res, 200, await readFile(dist), types[file.split('.').at(-1)]);
        }
      }
      return respond(res, 404, { error: '找不到该页面。' });
    } catch (error) {
      console.error('请求失败：', path, error.message);
      return respond(res, 500, { error: '本地工作台暂时无法处理该请求，请重试。' });
    }
  });
  return {
    listen: (port) => listen(server, port),
    async close() {
      await stop(server);
      const started = await Promise.allSettled(previews.values());
      await Promise.all(started.filter((item) => item.status === 'fulfilled').map((item) => stop(item.value.server)));
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const studio = await createStudio({ dataRoot: process.env.DEMO_STUDIO_DATA_DIR });
  try {
    const url = await studio.listen(Number(process.env.DEMO_STUDIO_PORT || 17860));
    console.log('AI Demo Studio 已启动：' + url);
    if (process.platform === 'win32' && process.env.DEMO_STUDIO_OPEN === '1') {
      const browser = spawn('explorer.exe', [url], { windowsHide: true, stdio: 'ignore', detached: true });
      browser.on('error', () => console.warn('浏览器未能自动打开，请访问上方地址。'));
      browser.unref();
    }
  } catch (error) {
    console.error(error.code === 'EADDRINUSE' ? '工作台端口已占用。若工作台已在运行，可直接打开原地址。' : error.message);
    process.exitCode = 1;
  }
}
