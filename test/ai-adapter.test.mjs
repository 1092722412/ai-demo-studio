import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createCodexAppServerAdapter } from '../dist-server/ai/codex-app-server.js';
import { TaskService } from '../dist-server/tasks.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fileURLToPath(new URL('../test-support/fake-codex-app-server.mjs', import.meta.url));
const skillText = await readFile(join(root, '.agents/skills/bid-demo-system/SKILL.md'), 'utf8');
const skillDigest = createHash('sha256').update(skillText).digest('hex');
const project = {
  title: '合成演示',
  body: '<h1>演示</h1>',
  css: 'body { color: #123; }',
  script: 'void 0;',
  seedJson: '{"items":[]}',
  stateJson: '{}',
  controls: [{ id: 'save', label: '保存' }],
  acceptance: [{ operation: '点击保存', result: '展示保存结果' }],
};

function makeInput(overrides = {}) {
  const { context: contextOverrides, ...inputOverrides } = overrides;
  const context = {
    instruction: '遵循需求并使用当前上下文。',
    brief: '合成需求',
    requirements: [],
    messages: [{ role: 'user', text: '请生成合成演示系统。' }],
    fileIndex: [],
    skill: { name: 'bid-demo-system', text: skillText, digest: skillDigest },
    toolNames: [],
    ...contextOverrides,
  };
  return {
    taskId: 'task-test-1',
    projectId: 'project-test-1',
    conversationId: 'conversation-test-1',
    purpose: 'system',
    messageId: 'message-test-1',
    context,
    nativeSessionRef: null,
    limits: { maxSteps: 8, timeoutMs: 3_000, maxOutputBytes: 1_000_000 },
    ...inputOverrides,
  };
}

async function createAdapter(mode, input = makeInput(), extraEnv = {}) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ai-demo-studio-adapter-'));
  const traceFile = join(dataRoot, 'trace.jsonl');
  await writeFile(traceFile, '', 'utf8');
  const adapter = createCodexAppServerAdapter({
    projectRoot: root,
    startupTimeoutMs: 1_000,
    interruptTimeoutMs: 800,
    terminateTimeoutMs: 800,
    buildLaunch: () => ({ command: process.execPath, args: [fixture] }),
    spawnProcess: (command, args, options) => spawn(command, args, {
      ...options,
      env: {
        ...process.env,
        FAKE_CODEX_MODE: mode,
        FAKE_CODEX_TRACE: traceFile,
        FAKE_CODEX_SKILL: skillText,
        FAKE_CODEX_TASK_ID: input.taskId,
        FAKE_CODEX_PROJECT_ID: input.projectId,
        FAKE_CODEX_MESSAGE_ID: input.messageId,
        FAKE_CODEX_OUTPUT: JSON.stringify({ reply: '已根据当前需求完成。', project: input.purpose === 'discuss' ? null : project }),
        ...extraEnv,
      },
    }),
    terminateProcessTree: async (child, timeoutMs) => {
      if (child.exitCode !== null || child.signalCode !== null) return true;
      try { child.kill(); } catch { return false; }
      return new Promise((resolveExit) => {
        const timer = setTimeout(() => resolveExit(false), timeoutMs);
        child.once('close', () => {
          clearTimeout(timer);
          resolveExit(true);
        });
      });
    },
  });
  return { adapter, dataRoot, traceFile };
}

function makeRuntime(input, events, signal = new AbortController().signal) {
  return {
    connection: { id: 'codex-connection-1', kind: 'codex', provider: 'codex', model: 'fake-model' },
    projectRoot: root,
    signal,
    emit: async (event) => { events.push(event); },
    tools: { call: async () => ({ ok: false, error: { code: 'NOT_AVAILABLE', message: '无工具' } }) },
  };
}

async function trace(traceFile) {
  return (await readFile(traceFile, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

async function until(check, timeoutMs = 2_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
  }
  throw new Error('等待合成 app-server 状态超时。');
}

test('初始化 app-server，会话事件、消息增量、工具事件和系统结果按统一契约返回', async (t) => {
  const input = makeInput();
  const { adapter, dataRoot, traceFile } = await createAdapter('success', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const events = [];
  const result = await adapter.execute(input, makeRuntime(input, events));
  const methods = (await trace(traceFile)).filter((entry) => entry.event === 'request').map((entry) => entry.method);
  assert.ok(methods.includes('initialize'));
  assert.ok(methods.includes('thread/start'));
  assert.ok(methods.includes('turn/start'));
  assert.equal(events[0].type, 'session.bound');
  assert.equal(result.nativeSessionRef, 'thread-new');
  assert.equal(result.delivery.kind, 'system');
  assert.equal(result.delivery.project.title, project.title);
  assert.equal(result.delivery.skill.digest, skillDigest);
  assert.equal(events.filter((event) => event.type === 'tool.started').length, 2);
  assert.equal(events.filter((event) => event.type === 'tool.finished' && event.ok).length, 2);
  assert.equal(events.filter((event) => event.type === 'message.delta').map((event) => event.text).join(''), '已根据当前需求完成。');
  const started = (await trace(traceFile)).find((entry) => entry.event === 'turn-start-request');
  assert.ok(started.outputSchema);
});

test('恢复原生线程并忽略其他 turn 与未知通知', async (t) => {
  const input = makeInput({ nativeSessionRef: 'opaque-thread-id' });
  const { adapter, dataRoot, traceFile } = await createAdapter('success', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const events = [];
  const result = await adapter.execute(input, makeRuntime(input, events));
  const methods = (await trace(traceFile)).filter((entry) => entry.event === 'request').map((entry) => entry.method);
  assert.ok(methods.includes('thread/resume'));
  assert.equal(result.nativeSessionRef, 'opaque-thread-id');
  assert.ok(events.every((event) => event.type !== 'message.delta' || !event.text.includes('不可发布')));
});

test('turn/start 返回错误但同一 thread 的 turn/started 到达时，以事件确认并继续等待终态', async (t) => {
  const input = makeInput({ purpose: 'discuss' });
  const { adapter, dataRoot } = await createAdapter('start-error', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const result = await adapter.execute(input, makeRuntime(input, []));
  assert.equal(result.reply, '已根据当前需求完成。');
});

test('最终结构化输出缺字段时拒绝交付', async (t) => {
  const input = makeInput({ purpose: 'discuss' });
  const { adapter, dataRoot } = await createAdapter('invalid-output', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  await assert.rejects(adapter.execute(input, makeRuntime(input, [])), { code: 'OUTPUT_INVALID' });
});

test('缺少当前任务的技能或需求读取 receipt 时拒绝结果', async (t) => {
  const input = makeInput({ purpose: 'discuss' });
  const { adapter, dataRoot } = await createAdapter('missing-receipt', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  await assert.rejects(adapter.execute(input, makeRuntime(input, [])), { code: 'SOURCE_CHECK_FAILED' });
});

test('已有源码被列入读取索引时，必须取得本轮源码读取 receipt', async (t) => {
  const sourcePath = 'test-support/fake-codex-app-server.mjs';
  const sourceBytes = (await readFile(join(root, sourcePath))).byteLength;
  const input = makeInput({ context: { fileIndex: [{ artifactId: 'source-current', path: sourcePath, bytes: sourceBytes }] } });
  const { adapter, dataRoot } = await createAdapter('success', input, { FAKE_CODEX_SOURCE_ARTIFACT_ID: 'source-current' });
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const result = await adapter.execute(input, makeRuntime(input, []));
  assert.equal(result.delivery.kind, 'system');
});

test('取消先返回 cancelling，等待 turn 终态并丢弃迟到结果', async (t) => {
  const input = makeInput({ purpose: 'discuss' });
  const { adapter, dataRoot, traceFile } = await createAdapter('cancel-race', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const events = [];
  const tasks = new TaskService({
    adapter,
    createRuntime: async () => {
      const base = makeRuntime(input, events);
      return { connection: base.connection, projectRoot: base.projectRoot, tools: base.tools };
    },
    onEvent: async (_taskId, event) => events.push(event),
  });
  assert.equal((await tasks.startAi(input)).state, 'queued');
  await until(async () => (await trace(traceFile)).some((entry) => entry.event === 'turn-start-request'));
  assert.equal((await tasks.cancel(input.taskId)).state, 'cancelling');
  await until(() => tasks.get(input.taskId).state === 'cancelled');
  assert.equal(tasks.getResult(input.taskId), null);
  assert.ok((await trace(traceFile)).some((entry) => entry.event === 'interrupt-response'));
  assert.ok((await trace(traceFile)).some((entry) => entry.event === 'turn-completed' && entry.status === 'completed'));
  assert.equal(events.some((event) => event.type === 'message.delta'), false);
});

test('interrupt 超时后只终止本适配器子进程并确认停止', async (t) => {
  const input = makeInput({ purpose: 'discuss' });
  const { adapter, dataRoot, traceFile } = await createAdapter('interrupt-timeout', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const tasks = new TaskService({
    adapter,
    createRuntime: async () => {
      const base = makeRuntime(input, []);
      return { connection: base.connection, projectRoot: base.projectRoot, tools: base.tools };
    },
  });
  await tasks.startAi(input);
  await until(async () => (await trace(traceFile)).some((entry) => entry.event === 'turn-start-request'));
  await tasks.cancel(input.taskId);
  await until(() => tasks.get(input.taskId).state === 'cancelled', 2_000);
  assert.equal(tasks.getResult(input.taskId), null);
  assert.ok((await trace(traceFile)).some((entry) => entry.event === 'interrupt-response'));
  assert.equal((await trace(traceFile)).some((entry) => entry.event === 'turn-completed'), false);
});

test('人工输入请求进入 waiting_input，按原 JSON-RPC id 回复', async (t) => {
  const input = makeInput({ purpose: 'discuss' });
  const { adapter, dataRoot, traceFile } = await createAdapter('permission', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const events = [];
  const tasks = new TaskService({
    adapter,
    createRuntime: async () => {
      const base = makeRuntime(input, events);
      return { connection: base.connection, projectRoot: base.projectRoot, tools: base.tools };
    },
    onEvent: async (_taskId, event) => events.push(event),
  });
  await tasks.startAi(input);
  await until(() => tasks.get(input.taskId).state === 'waiting_input');
  const request = events.find((event) => event.type === 'permission.requested');
  assert.equal(request.requestId, '700');
  assert.equal(request.questions[0].id, 'reason');
  const answer = { answers: { reason: { answers: ['合成答复'] } } };
  await tasks.respondInput(input.taskId, request.requestId, answer);
  await until(() => tasks.get(input.taskId).state === 'succeeded');
  const response = (await trace(traceFile)).find((entry) => entry.event === 'client-response' && entry.id === 700);
  assert.deepEqual(response.result, answer);
});

test('上下文 MCP 工具只读本轮上下文与索引内源码，并拒绝项目外路径', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'ai-demo-studio-mcp-'));
  const contextFile = join(dataRoot, 'context.json');
  const sourcePath = 'test-support/fake-codex-app-server.mjs';
  const sourceBytes = (await readFile(join(root, sourcePath))).byteLength;
  const context = {
    taskId: 'task-mcp', projectId: 'project-mcp', conversationId: 'conversation-mcp', messageId: 'message-mcp',
    purpose: 'system', instruction: '读取合成上下文。', brief: '合成需求', requirements: [],
    messages: [{ role: 'user', text: '查看索引文件' }],
    fileIndex: [{ artifactId: 'source-ok', path: sourcePath, bytes: sourceBytes }],
    skill: { name: 'bid-demo-system', text: skillText, digest: skillDigest }, toolNames: [],
  };
  await writeFile(contextFile, JSON.stringify(context), 'utf8');
  const helper = fileURLToPath(new URL('../server/ai/context-mcp.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, contextFile, root], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => {
    child.kill();
    await rm(dataRoot, { recursive: true, force: true });
  });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (pending.has(message.id)) {
        const resolvePending = pending.get(message.id);
        pending.delete(message.id);
        resolvePending(message);
      }
    }
  });
  const request = (id, method, params) => new Promise((resolveResponse) => {
    pending.set(id, resolveResponse);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  await request(1, 'initialize', {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const tools = await request(2, 'tools/list', {});
  assert.deepEqual(tools.result.tools.map(({ name }) => name), [
    'get_demo_brief', 'load_bid_demo_system_skill', 'get_current_source',
  ]);
  const brief = await request(3, 'tools/call', { name: 'get_demo_brief', arguments: {} });
  assert.match(brief.result.content[0].text, /task-mcp/);
  const skill = await request(4, 'tools/call', { name: 'load_bid_demo_system_skill', arguments: {} });
  assert.equal(skill.result.content[0].text, skillText);
  const source = await request(5, 'tools/call', { name: 'get_current_source', arguments: { artifactId: 'source-ok' } });
  assert.match(source.result.content[0].text, /const mode/);
  context.fileIndex = [{ artifactId: 'source-outside', path: '../README.md', bytes: 10 }];
  await writeFile(contextFile, JSON.stringify(context), 'utf8');
  const denied = await request(6, 'tools/call', { name: 'get_current_source', arguments: { artifactId: 'source-outside' } });
  assert.equal(denied.result.isError, true);
});

test('app-server 中途退出返回 WORKER_LOST，不把未知通知当成成功', async (t) => {
  const input = makeInput({ purpose: 'discuss' });
  const { adapter, dataRoot } = await createAdapter('worker-exit', input);
  t.after(async () => { await adapter.close(); await rm(dataRoot, { recursive: true, force: true }); });
  await assert.rejects(adapter.execute(input, makeRuntime(input, [])), { code: 'WORKER_LOST' });
});
