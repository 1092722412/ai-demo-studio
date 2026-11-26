import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const contextFile = process.argv[2];
const projectRoot = process.argv[3];
const sourceLimit = 2_000_000;
const server = new Server({ name: 'ai-demo-studio', version: '0.1.0' }, { capabilities: { tools: {} } });

async function getContext() {
  if (!contextFile || !projectRoot) throw new Error('缺少当前任务上下文。');
  return JSON.parse(await readFile(contextFile, 'utf8'));
}

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{
    name: 'get_demo_brief',
    description: '读取当前项目和活动 AI 任务的需求、确认条款与对话上下文。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, {
    name: 'load_bid_demo_system_skill',
    description: '完整读取当前工作台随项目提供的 bid-demo-system 技能。生成系统前必须调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, {
    name: 'get_current_source',
    description: '按 artifactId 读取当前项目明确列入索引的源码或样例文件。只读。',
    inputSchema: {
      type: 'object',
      properties: { artifactId: { type: 'string' } },
      required: ['artifactId'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const context = await getContext();
    if (params.name === 'get_demo_brief') {
      return { content: [{ type: 'text', text: JSON.stringify({
        taskId: context.taskId,
        projectId: context.projectId,
        conversationId: context.conversationId,
        messageId: context.messageId,
        purpose: context.purpose,
        instruction: context.instruction,
        brief: context.brief,
        requirements: context.requirements,
        messages: context.messages,
        availableSourceFiles: context.fileIndex.map(({ artifactId, path, bytes }) => ({ artifactId, path, bytes })),
      }) }] };
    }
    if (params.name === 'load_bid_demo_system_skill') {
      if (context.skill?.name !== 'bid-demo-system' || typeof context.skill.digest !== 'string') {
        return { isError: true, content: [{ type: 'text', text: '当前任务没有提供有效技能文本。' }] };
      }
      const body = await readFile(resolve(projectRoot, '.agents/skills/bid-demo-system/SKILL.md'));
      const digest = createHash('sha256').update(body).digest('hex');
      if (digest !== context.skill.digest) {
        return { isError: true, content: [{ type: 'text', text: '当前工程技能在任务开始后发生变化。' }] };
      }
      return { content: [{ type: 'text', text: body.toString('utf8') }] };
    }
    if (params.name === 'get_current_source') {
      const artifactId = params.arguments?.artifactId;
      const entry = context.fileIndex.find((file) => file.artifactId === artifactId);
      if (!entry) return { isError: true, content: [{ type: 'text', text: '该文件不在当前项目的读取索引中。' }] };
      const requested = String(entry.path || '');
      if (!requested || isAbsolute(requested)) {
        return { isError: true, content: [{ type: 'text', text: '源码路径无效。' }] };
      }
      const root = await realpath(projectRoot);
      const candidate = resolve(root, requested);
      const relativePath = relative(root, candidate);
      if (!relativePath || relativePath === '..' || relativePath.startsWith('..' + sep)) {
        return { isError: true, content: [{ type: 'text', text: '源码路径超出当前项目范围。' }] };
      }
      const actual = await realpath(candidate);
      const actualRelative = relative(root, actual);
      if (actualRelative === '..' || actualRelative.startsWith('..' + sep)) {
        return { isError: true, content: [{ type: 'text', text: '源码文件指向项目外路径。' }] };
      }
      const info = await stat(actual);
      if (!info.isFile() || info.size > sourceLimit ||
          (Number.isFinite(entry.bytes) && entry.bytes >= 0 && info.size !== entry.bytes)) {
        return { isError: true, content: [{ type: 'text', text: '源码文件大小或状态与当前索引不一致。' }] };
      }
      const text = await readFile(actual, 'utf8');
      return { content: [{ type: 'text', text }] };
    }
    return { isError: true, content: [{ type: 'text', text: '未知只读工具。' }] };
  } catch {
    return { isError: true, content: [{ type: 'text', text: '读取当前项目上下文失败。' }] };
  }
});

await server.connect(new StdioServerTransport());
