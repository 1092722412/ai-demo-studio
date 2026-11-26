import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const jobDir = process.argv[2];
const skillFile = process.argv[3];
const baseDirectory = process.argv[4];
const sources = ['manifest.json', 'page.html', 'style.css', 'app.js', 'seed/data.json', 'seed/state.json',
  'spec.json', 'index.html', 'demo.mjs', 'seed/records.json'];
const server = new Server({ name: 'ai-demo-studio', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{
    name: 'get_demo_brief',
    description: '读取当前工作台任务的演示需求及参考材料。只读。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, {
    name: 'load_bid_demo_system_skill',
    description: '调用当前工程的 bid-demo-system 技能，完整读取执行规则。生成系统前必须调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ...(baseDirectory ? [{
    name: 'get_current_source',
    description: '读取当前生成版本的一个源文件或样例数据。仅限这个项目上一可用版本。',
    inputSchema: { type: 'object', properties: { file: { type: 'string', enum: sources } }, required: ['file'], additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }] : [])],
}));

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  if (params.name === 'get_current_source' && baseDirectory && sources.includes(params.arguments?.file)) {
    try {
      const content = await readFile(join(baseDirectory, params.arguments.file), 'utf8');
      await writeFile(join(jobDir, 'source-read'), params.arguments.file);
      return { content: [{ type: 'text', text: content }] };
    } catch {
      return { isError: true, content: [{ type: 'text', text: '当前版本没有此文件。旧版项目从 spec.json 读取页面配置。' }] };
    }
  }
  if (params.name === 'load_bid_demo_system_skill') {
    const body = await readFile(skillFile);
    const sha256 = createHash('sha256').update(body).digest('hex');
    await writeFile(join(jobDir, 'skill-read.json'), JSON.stringify({ name: 'bid-demo-system', sha256 }));
    return { content: [{ type: 'text', text: body.toString('utf8') }] };
  }
  if (params.name !== 'get_demo_brief') return { isError: true, content: [{ type: 'text', text: '未知工具。' }] };
  const brief = JSON.parse(await readFile(join(jobDir, 'brief.json'), 'utf8'));
  const conversation = JSON.parse(await readFile(join(jobDir, 'conversation.json'), 'utf8'));
  const availableSourceFiles = baseDirectory ? (await Promise.all(sources.map(async (file) => {
    try { await access(join(baseDirectory, file)); return file; } catch { return null; }
  }))).filter(Boolean) : [];
  await writeFile(join(jobDir, 'mcp-read'), new Date().toISOString());
  return { content: [{ type: 'text', text: JSON.stringify({ brief, ...conversation, availableSourceFiles }) }] };
});

await server.connect(new StdioServerTransport());
