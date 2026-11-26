import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const mode = process.env.FAKE_CODEX_MODE || 'success';
const traceFile = process.env.FAKE_CODEX_TRACE;
const trace = (entry) => {
  if (traceFile) appendFileSync(traceFile, JSON.stringify(entry) + '\n', 'utf8');
};
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const respond = (request, result) => send({ jsonrpc: '2.0', id: request.id, result });
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });

let threadId = '';
let turnId = '';
let turnCounter = 0;
const activeTurns = new Map();

async function finishTurn(status = 'completed', output = process.env.FAKE_CODEX_OUTPUT || '{"reply":"已完成讨论。","project":null}') {
  if (!turnId) return;
  if (status === 'completed') {
    await sendReceipts();
    const chunks = output.match(/[\s\S]{1,11}/g) || [];
    for (const delta of chunks) notify('item/agentMessage/delta', { threadId, turnId, itemId: 'assistant-1', delta });
  }
  const items = status === 'completed'
    ? [{ id: 'assistant-1', type: 'agentMessage', text: output }]
    : [];
  notify('turn/completed', { threadId, turn: { id: turnId, status, items } });
  trace({ event: 'turn-completed', turnId, status });
  activeTurns.delete(turnId);
}

async function sendTool(tool, args, content, callId) {
  const base = { id: callId, type: 'mcpToolCall', server: 'demo_studio', tool, arguments: args };
  notify('item/started', { threadId, turnId, item: { ...base, status: 'inProgress' } });
  notify('item/completed', {
    threadId,
    turnId,
    item: { ...base, status: 'completed', result: { content: [{ type: 'text', text: content }] } },
  });
}

async function sendReceipts() {
  if (mode !== 'missing-receipt') {
    await sendTool('load_bid_demo_system_skill', {}, process.env.FAKE_CODEX_SKILL || '', 'tool-skill');
  }
  if (mode !== 'missing-receipt') {
    await sendTool('get_demo_brief', {}, JSON.stringify({
      taskId: process.env.FAKE_CODEX_TASK_ID,
      projectId: process.env.FAKE_CODEX_PROJECT_ID,
      messageId: process.env.FAKE_CODEX_MESSAGE_ID,
      brief: '合成需求',
    }), 'tool-brief');
  }
  const sourceArtifactId = process.env.FAKE_CODEX_SOURCE_ARTIFACT_ID;
  if (sourceArtifactId) await sendTool('get_current_source', { artifactId: sourceArtifactId }, '<h1>已有源码</h1>', 'tool-source');
  const attachment = process.env.FAKE_CODEX_ATTACHMENT;
  if (attachment) {
    const ref = JSON.parse(attachment);
    await sendTool('read_attachment', { artifactId: ref.artifactId, offset: 0, limit: 1 }, JSON.stringify({ sourceRefs: [ref] }), 'tool-attachment');
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); }
  catch { return; }
  if (typeof message.method !== 'string') {
    trace({ event: 'client-response', id: message.id, result: message.result });
    const active = activeTurns.get(turnId);
    if (active?.permissionId === message.id && message.result) {
      active.permissionResolved = true;
      setTimeout(() => void finishTurn('completed'), 20);
    }
    return;
  }
  trace({ event: 'request', method: message.method, params: message.params });
  if (message.method === 'initialize') {
    respond(message, { protocolVersion: '2025-03-26', serverInfo: { name: 'fake-codex', version: 'test-1' }, capabilities: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    threadId = 'thread-new';
    respond(message, { thread: { id: threadId } });
    notify('thread/started', { thread: { id: threadId } });
    return;
  }
  if (message.method === 'thread/resume') {
    threadId = message.params.threadId;
    respond(message, { thread: { id: threadId } });
    notify('thread/started', { thread: { id: threadId } });
    return;
  }
  if (message.method === 'turn/start') {
    turnCounter += 1;
    turnId = `turn-${turnCounter}`;
    const requestedThread = message.params.threadId;
    threadId = requestedThread;
    if (mode === 'start-error') send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'synthetic start race' } });
    else respond(message, { turn: { id: turnId, status: 'inProgress' } });
    trace({ event: 'turn-start-request', turnId, outputSchema: message.params.outputSchema });
    setImmediate(() => {
      notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
      notify('unknown/future-event', { threadId, turnId });
      notify('item/agentMessage/delta', { threadId, turnId: `${turnId}-other`, itemId: 'wrong', delta: '不可发布' });
      if (mode === 'cancel-race' || mode === 'interrupt-timeout') {
        activeTurns.set(turnId, { threadId });
      } else if (mode === 'worker-exit') {
        process.exit(17);
      } else if (mode === 'permission') {
        activeTurns.set(turnId, { threadId, permissionId: 700 });
        send({ jsonrpc: '2.0', id: 700, method: 'item/tool/requestUserInput', params: {
          threadId, turnId, itemId: 'mcp-input', questions: [{ id: 'reason', question: '请补充原因', options: null }],
        } });
      } else if (mode === 'invalid-output') {
        void finishTurn('completed', '{"reply":"这不是有效交付"}');
      } else {
        void finishTurn('completed');
      }
    });
    return;
  }
  if (message.method === 'turn/interrupt') {
    respond(message, {});
    trace({ event: 'interrupt-response', turnId: message.params.turnId });
    if (mode === 'cancel-race') setTimeout(() => void finishTurn('completed'), 80);
    if (mode === 'interrupt-timeout') return;
    return;
  }
  respond(message, {});
});

process.stdin.on('end', () => process.exit(0));
