import { readFile, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { extractAttachment } from '../../dist-server/attachments.js';
import { isSourcePath, openSourceArchive, sourceArchiveLimit } from '../../dist-server/artifacts.js';

const contextFile = process.argv[2];
const projectRoot = process.argv[3];
const systemRoot = process.argv[4] ?? projectRoot;
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
    name: 'read_attachment',
    description: '按当前项目附件 ID 读取原文片段和出处。offset 和 limit 以片段数计。',
    inputSchema: {
      type: 'object', required: ['artifactId', 'offset', 'limit'], additionalProperties: false,
      properties: { artifactId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 20 } },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, {
    name: 'load_bid_demo_system_skill',
    description: '完整读取当前工作台随项目提供的 bid-demo-system 技能。生成系统前必须调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, {
    name: 'get_current_source',
    description: '按 artifactId 读取当前源码。ZIP 可先省略 file 列出文件，再传 file 读取包内文本。只读。',
    inputSchema: {
      type: 'object',
      properties: { artifactId: { type: 'string' }, file: { type: 'string' } },
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
      const planSchema = context.purpose === 'plan'
        ? JSON.parse(await readFile(new URL('../../docs/examples/demo-contract.schema.json', import.meta.url), 'utf8')) : undefined;
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
        currentPlan: context.currentPlan,
        planSchema,
        availableSourceFiles: context.fileIndex.map(({ artifactId, path, bytes }) => ({ artifactId, path, bytes })),
        attachments: (context.attachmentIndex ?? []).map(({ artifactId, name, bytes }) => ({ artifactId, name, bytes })),
      }) }] };
    }
    if (params.name === 'load_bid_demo_system_skill') {
      if (context.skill?.name !== 'bid-demo-system' || typeof context.skill.digest !== 'string') {
        return { isError: true, content: [{ type: 'text', text: '当前任务没有提供有效技能文本。' }] };
      }
      const body = await readFile(resolve(systemRoot, '.agents/skills/bid-demo-system/SKILL.md'));
      const digest = createHash('sha256').update(body).digest('hex');
      if (digest !== context.skill.digest) {
        return { isError: true, content: [{ type: 'text', text: '当前工程技能在任务开始后发生变化。' }] };
      }
      return { content: [{ type: 'text', text: body.toString('utf8') }] };
    }
    if (params.name === 'read_attachment') {
      const { artifactId, offset, limit } = params.arguments ?? {};
      const entry = context.attachmentIndex?.find((file) => file.artifactId === artifactId);
      if (!entry || !Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) {
        return { isError: true, content: [{ type: 'text', text: '附件不在当前任务索引中或片段范围无效。' }] };
      }
      const root = await realpath(projectRoot);
      const actual = await realpath(resolve(root, entry.path));
      const within = relative(root, actual);
      if (!within || isAbsolute(within) || within === '..' || within.startsWith('..' + sep)) {
        return { isError: true, content: [{ type: 'text', text: '附件路径超出当前项目范围。' }] };
      }
      const info = await stat(actual);
      if (!info.isFile() || info.size !== entry.bytes) {
        return { isError: true, content: [{ type: 'text', text: '附件与当前索引不一致。' }] };
      }
      const { sourceRefs } = await extractAttachment({ id: artifactId, relativePath: entry.path, mime: entry.mime, bytes: entry.bytes, path: actual });
      const fragments = sourceRefs.flatMap((source) => [...source.quote.matchAll(/[\s\S]{1,2000}/gu)]
        .map(([quote]) => ({ ...source, quote })));
      return { content: [{ type: 'text', text: JSON.stringify({
        artifactId, sourceRefs: fragments.slice(offset, offset + limit),
        nextOffset: offset + limit < fragments.length ? offset + limit : null,
      }) }] };
    }
    if (params.name === 'get_current_source') {
      const { artifactId, file } = params.arguments ?? {};
      const entry = context.fileIndex.find((file) => file.artifactId === artifactId);
      if (!entry) return { isError: true, content: [{ type: 'text', text: '该文件不在当前项目的读取索引中。' }] };
      const requested = String(entry.path || '');
      if (!requested || isAbsolute(requested)) {
        return { isError: true, content: [{ type: 'text', text: '源码路径无效。' }] };
      }
      const root = await realpath(projectRoot);
      const candidate = resolve(root, requested);
      const relativePath = relative(root, candidate);
      if (!relativePath || isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith('..' + sep)) {
        return { isError: true, content: [{ type: 'text', text: '源码路径超出当前项目范围。' }] };
      }
      const actual = await realpath(candidate);
      const actualRelative = relative(root, actual);
      if (!actualRelative || isAbsolute(actualRelative) || actualRelative === '..' || actualRelative.startsWith('..' + sep)) {
        return { isError: true, content: [{ type: 'text', text: '源码文件指向项目外路径。' }] };
      }
      const info = await stat(actual);
      const archived = requested.toLowerCase().endsWith('.zip');
      if (!info.isFile() || info.size > (archived ? sourceArchiveLimit : sourceLimit) ||
          (Number.isFinite(entry.bytes) && entry.bytes >= 0 && info.size !== entry.bytes)) {
        return { isError: true, content: [{ type: 'text', text: '源码文件大小或状态与当前索引不一致。' }] };
      }
      if (archived) {
        if (file !== undefined && (typeof file !== 'string' || !isSourcePath(file)
            || !/\.(?:js|mjs|cjs|jsx|ts|tsx|html|css|json|md|txt|py|csv|sql|vue|svelte)$/i.test(file))) {
          return { isError: true, content: [{ type: 'text', text: '请选择源码包内的文本文件。' }] };
        }
        const { names, files } = openSourceArchive(await readFile(actual), file ? new Map([[file, 500_000]]) : undefined);
        if (!file) return { content: [{ type: 'text', text: JSON.stringify({ artifactId, files: [...names].slice(0, 200) }) }] };
        if (!Object.hasOwn(files, file)) return { isError: true, content: [{ type: 'text', text: '该文本不在源码包中。' }] };
        const text = new TextDecoder('utf-8', { fatal: true }).decode(files[file]);
        return { content: [{ type: 'text', text }] };
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
