import { createServer } from 'node:http';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const assets = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/demo.mjs': ['demo.mjs', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 32_000) throw new Error('输入过长。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readValues(fields, input) {
  const values = {};
  for (const field of fields) {
    const value = input?.[field.id];
    const validType = typeof value === 'string' && value.length <= 500;
    if (!validType || (!value.trim() && field.required) ||
        (value && field.type === 'number' && !Number.isFinite(Number(value))) ||
        (value && field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) ||
        (value && field.type === 'select' && !field.options.includes(value))) {
      throw new Error('请检查' + field.label + '。');
    }
    values[field.id] = value.trim();
  }
  return values;
}

export async function createDemoServer({ sourceDir = root, dataDir = join(root, '.runtime'), preview = false } = {}) {
  const spec = JSON.parse(await readFile(join(sourceDir, 'spec.json'), 'utf8'));
  const initial = await readFile(join(sourceDir, 'seed', 'records.json'), 'utf8');
  await mkdir(dataDir, { recursive: true });
  const recordsFile = join(dataDir, 'records.json');
  await writeFile(recordsFile, initial, { flag: 'wx' }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  let writeQueue = Promise.resolve();

  const server = createServer(async (req, res) => {
    const host = '127.0.0.1:' + server.address().port;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // 旧版固定脚本依赖同源读写，预览只提供内置页面和脚本。
    const sandbox = preview ? 'sandbox allow-scripts allow-forms allow-same-origin; ' : '';
    res.setHeader('Content-Security-Policy', sandbox + "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self' http://127.0.0.1:*");
    if (req.headers.host !== host) return json(res, 403, { error: '只允许本机回环地址。' });
    const path = req.url?.split('?')[0];
    try {
      if (req.method === 'GET') {
        if (path === '/api/health') return json(res, 200, { status: 'ok' });
        if (path === '/api/spec') return json(res, 200, spec);
        if (path === '/api/records') return json(res, 200, JSON.parse(await readFile(recordsFile, 'utf8')));
        if (Object.hasOwn(assets, path)) {
          const [file, type] = assets[path];
          const content = await readFile(join(preview ? root : sourceDir, file));
          res.writeHead(200, { 'Content-Type': type });
          return res.end(content);
        }
      }
      if (req.method === 'POST' && path === '/api/records') {
        if (req.headers.origin !== 'http://' + host || req.headers['content-type'] !== 'application/json') {
          return json(res, 403, { error: '请求来源无效。' });
        }
        let values;
        try {
          values = readValues(spec.fields, await body(req));
        } catch (error) {
          return json(res, 400, { error: error instanceof SyntaxError ? '输入格式无效。' : error.message });
        }
        const item = { id: randomUUID(), values };
        const write = writeQueue.then(async () => {
          const records = JSON.parse(await readFile(recordsFile, 'utf8'));
          const temporary = join(dataDir, item.id + '.tmp');
          await writeFile(temporary, JSON.stringify([item, ...records], null, 2));
          await rename(temporary, recordsFile);
        });
        writeQueue = write.catch(() => {});
        await write;
        return json(res, 201, item);
      }
      return json(res, 404, { error: '找不到页面。' });
    } catch {
      return json(res, 500, { error: '数据读取或保存失败。' });
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.DEMO_PORT || 18080);
  const server = await createDemoServer();
  server.listen(port, '127.0.0.1', () => console.log('演示系统：http://127.0.0.1:' + server.address().port));
}
