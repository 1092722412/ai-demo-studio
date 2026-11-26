import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strToU8, zipSync } from 'fflate';
import { extractAttachment, maxAttachmentBytes } from '../dist-server/attachments.js';
import { mapRequirementsOutput } from '../dist-server/ai/output-schemas.js';
import { createStudio } from '../server/studio.mjs';
import { injectHttp } from '../test-support/http-inject.mjs';

const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-attachment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return async (relativePath, mime, content) => {
    const path = join(root, relativePath);
    await writeFile(path, content);
    return { id: 'a-fixture', relativePath, mime, bytes: Buffer.byteLength(content), path };
  };
}

test('文本格式保留原文行号，拒绝空文本、MIME 不符和二进制数据', async (t) => {
  const create = await fixture(t);
  for (const [name, mime] of [['a.txt', 'text/plain'], ['a.md', 'text/markdown'], ['a.csv', 'text/csv'], ['a.json', 'application/json']]) {
    const text = name.endsWith('.json') ? '{\r\n\r\n  "text": "需求"\r\n}' : '第一行\r\n\r\n第三行';
    const result = await extractAttachment(await create(name, mime, text));
    assert.equal(result.text, text);
    assert.equal(result.sourceRefs[1].locator, 'line:3');
    assert.equal(result.sourceRefs[1].artifactId, 'a-fixture');
  }
  await assert.rejects(extractAttachment(await create('empty.txt', 'text/plain', ' \n ')), /未提取到可读文本/);
  await assert.rejects(extractAttachment(await create('wrong.txt', 'application/pdf', '文本')), { statusCode: 422 });
  await assert.rejects(extractAttachment(await create('binary.txt', 'text/plain', Buffer.from([0xff]))), { statusCode: 422 });
  const file = await create('large.txt', 'text/plain', '');
  const handle = await open(file.path, 'r+');
  try { await handle.truncate(maxAttachmentBytes + 1); } finally { await handle.close(); }
  await assert.rejects(extractAttachment(file), { statusCode: 413 });
});

test('PDF 使用实际页码，DOCX 使用提取段落编号，来源摘录须存在', async (t) => {
  const create = await fixture(t);
  const pdf = await extractAttachment(await create('sample.pdf', 'application/pdf', pdfFixture(['', 'Second page'])));
  assert.deepEqual(pdf.sourceRefs, [{ artifactId: 'a-fixture', locator: 'page:2', quote: 'Second page' }]);
  await assert.rejects(extractAttachment(await create('scan.pdf', 'application/pdf', pdfFixture(['']))), /未提取到可读文本/);
  const docx = await extractAttachment(await create('sample.docx', docxMime, docxFixture()));
  assert.deepEqual(docx.sourceRefs.map(({ locator, quote }) => [locator, quote]), [
    ['paragraph:1', '第一条要求'], ['paragraph:2', '第二条要求'],
  ]);
  const sourceRef = { ...docx.sourceRefs[1], quote: '第二条' };
  const value = { reply: '整理完成。', items: [{ text: '测试条目', outcome: '核对成功', sourceRef }] };
  const output = mapRequirementsOutput(value, docx.sourceRefs);
  assert.equal(output.delivery.items[0].confirmed, false);
  assert.deepEqual(output.delivery.items[0].sourceRef, sourceRef);
  sourceRef.locator = 'page:99';
  assert.throws(() => mapRequirementsOutput(value, docx.sourceRefs), { code: 'OUTPUT_INVALID' });
});

test('multipart 上传登记提取任务，失败保留原件，只向本项目整理任务提供已提取附件', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'studio-attachment-http-'));
  const studio = await createStudio({ dataRoot, adapter: {
    async execute(input) {
      assert.equal(input.purpose, 'requirements');
      assert.equal(input.context.attachmentIndex.length, 1);
      assert.equal(input.context.attachmentIndex[0].name, 'sample.txt');
      return { reply: '已整理。', delivery: { kind: 'requirements', items: [] }, nativeSessionRef: 'fake' };
    },
  } });
  t.after(async () => { await studio.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const { app, repository } = studio;
  const call = (method, url, payload) => injectHttp(app, { method, url, ...(payload === undefined ? {} : { payload }) });
  const project = async () => (await call('POST', '/api/v1/projects', { title: '合成项目', brief: '合成输入' })).json().data;
  const current = await project();
  const other = await project();
  const path = '/api/v1/projects/' + current.id;
  function upload(url, name, mime, body) {
    const boundary = 'studio-test-boundary';
    const payload = Buffer.concat([
      Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + name + '"\r\nContent-Type: ' + mime + '\r\n\r\n'),
      Buffer.from(body),
      Buffer.from('\r\n--' + boundary + '--\r\n'),
    ]);
    return injectHttp(app, { method: 'POST', url: url + '/attachments', headers: { 'content-type': 'multipart/form-data; boundary=' + boundary }, payload });
  }
  const wrong = await upload(path, 'bad.pdf', 'text/plain', '错误格式');
  assert.equal(wrong.statusCode, 422);
  const oversized = await upload(path, 'large.txt', 'text/plain', Buffer.alloc(maxAttachmentBytes + 1, 97));
  assert.equal(oversized.statusCode, 413);
  const empty = await upload(path, 'empty.txt', 'text/plain', ' ');
  assert.equal(empty.statusCode, 201);
  const emptyData = empty.json().data;
  const emptyTask = await waitForTask(repository, emptyData.taskId);
  assert.equal(emptyTask.state, 'failed');
  assert.match(emptyTask.error.message, /未提取到可读文本/);
  assert.ok(repository.getArtifactPath(current.id, emptyData.artifactId));
  const accepted = await upload(path, 'sample.txt', 'text/plain', '第一项要求');
  assert.equal(accepted.statusCode, 201);
  const data = accepted.json().data;
  assert.equal(data.extractionState, 'pending');
  assert.equal((await waitForTask(repository, data.taskId)).state, 'succeeded');
  const wrongProject = await call('GET', '/api/v1/artifacts/' + data.artifactId + '/content?projectId=' + other.id);
  assert.equal(wrongProject.statusCode, 404);
  const request = { requestId: 'organize', purpose: 'requirements', text: '整理附件' };
  assert.equal((await call('POST', '/api/v1/projects/' + other.id + '/messages', request)).statusCode, 422);
  const organized = await call('POST', path + '/messages', request);
  assert.equal(organized.statusCode, 202);
  assert.equal((await waitForTask(repository, organized.json().data.taskId)).state, 'succeeded');
});

test('生产 MCP 只读取本轮索引内的材料，并分页返回原文和位置', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'studio-attachment-mcp-'));
  const context = join(root, 'context.json');
  const attachment = '甲条款\n乙条款';
  await writeFile(join(root, 'sample.txt'), attachment);
  await writeFile(context, JSON.stringify({
    attachmentIndex: [{ artifactId: 'a-mcp', path: 'sample.txt', mime: 'text/plain', bytes: Buffer.byteLength(attachment) }],
  }));
  const client = new Client({ name: 'attachment-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await rm(root, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../server/ai/context-mcp.mjs', import.meta.url)), context, root],
  }));
  const read = (artifactId, offset) => client.callTool({ name: 'read_attachment', arguments: { artifactId, offset, limit: 1 } });
  assert.equal((await read('a-other', 0)).isError, true);
  const first = JSON.parse((await read('a-mcp', 0)).content[0].text);
  assert.equal(first.nextOffset, 1);
  const second = JSON.parse((await read('a-mcp', 1)).content[0].text);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(second.sourceRefs, [{ artifactId: 'a-mcp', locator: 'line:2', quote: '乙条款' }]);
});

async function waitForTask(repository, id) {
  for (let tries = 0; tries < 150; tries++) {
    const task = repository.getTask(id);
    if (['succeeded', 'failed', 'cancelled'].includes(task?.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('提取任务未结束。');
}

function docxFixture() {
  return zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第一条要求</w:t></w:r></w:p><w:p><w:r><w:t>第二条要求</w:t></w:r></w:p></w:body></w:document>'),
  });
}

function pdfFixture(pages) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pages.map((_page, i) => (4 + i * 2) + ' 0 R').join(' ') + '] >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [index, text] of pages.entries()) {
    const stream = text ? 'BT /F1 16 Tf 20 50 Td (' + text + ') Tj ET' : '';
    objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (5 + index * 2) + ' 0 R >>');
    objects.push('<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream');
  }
  let content = '%PDF-1.4\n';
  const offsets = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(content.length);
    content += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const start = content.length;
  content += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n'
    + offsets.map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('')
    + 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
  return Buffer.from(content, 'ascii');
}
