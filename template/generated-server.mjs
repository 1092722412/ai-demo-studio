import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const hostPage = '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title></title><link rel="stylesheet" href="/host.css"><iframe title="演示系统" sandbox="allow-scripts allow-forms" src="/demo"></iframe></html>';
const hostCss = 'html,body,iframe{display:block;width:100%;height:100%;margin:0;border:0;background:#f2f5fa}';

function escape(text) {
  return text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function send(res, status, type, data) {
  res.writeHead(status, { 'Content-Type': type + '; charset=utf-8' });
  res.end(data);
}

const json = (res, status, data) => send(res, status, 'application/json', JSON.stringify(data));

async function readBody(req) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128_000) throw new Error('试用数据超过大小限制。');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

export async function createGeneratedServer({ sourceDir = root, dataDir = join(root, '.runtime') } = {}) {
  const [manifest, body, css, script, seed, initial] = await Promise.all(
    ['manifest.json', 'page.html', 'style.css', 'app.js', 'seed/data.json', 'seed/state.json']
      .map((file) => readFile(join(sourceDir, file), 'utf8')),
  );
  const title = escape(JSON.parse(manifest).title);
  const token = randomUUID();
  await mkdir(dataDir, { recursive: true });
  const stateFile = join(dataDir, 'state.json');
  await writeFile(stateFile, initial, { flag: 'wx' }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  let queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    const host = '127.0.0.1:' + server.address().port;
    const origin = 'http://' + host;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self' http://127.0.0.1:*");
    if (req.headers.host !== host) return json(res, 403, { error: '请使用本机预览地址。' });
    const path = req.url?.split('?')[0];
    try {
      if (req.method === 'GET' && path === '/') {
        return send(res, 200, 'text/html', hostPage.replace('<title></title>', () => '<title>' + title + '</title>'));
      }
      if (req.method === 'GET' && path === '/host.css') return send(res, 200, 'text/css', hostCss);
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && path === '/demo') {
        if (req.headers['sec-fetch-dest'] !== 'iframe') return json(res, 403, { error: '请通过系统首页打开演示。' });
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms; default-src 'none'; script-src " + origin +
          "; style-src " + origin + "; img-src data:; connect-src " + origin +
          "; frame-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self' http://127.0.0.1:*");
        const document = '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="demo-token" content="' +
          token + '"><title>' + title + '</title><link rel="stylesheet" href="/style.css"><script defer src="/app.js"></script></head><body>' + body + '</body></html>';
        return send(res, 200, 'text/html', document);
      }
      if (req.method === 'GET' && path === '/style.css') return send(res, 200, 'text/css', css);
      if (req.method === 'GET' && path === '/app.js') return send(res, 200, 'text/javascript', script);
      if (path === '/api/seed' || path === '/api/state') {
        if (req.headers.origin !== 'null') return json(res, 403, { error: '请通过系统页面访问数据。' });
        res.setHeader('Access-Control-Allow-Origin', 'null');
        res.setHeader('Vary', 'Origin');
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, PUT', 'Access-Control-Allow-Headers': 'X-Demo-Token, Content-Type' });
          return res.end();
        }
        if (req.headers['x-demo-token'] !== token) return json(res, 403, { error: '当前演示会话已失效。' });
        if (req.method === 'GET') return send(res, 200, 'application/json', path === '/api/seed' ? seed : await readFile(stateFile, 'utf8'));
        if (req.method === 'PUT' && path === '/api/state' && req.headers['content-type'] === 'application/json') {
          let value;
          try { value = await readBody(req); }
          catch { return json(res, 400, { error: '试用数据格式或大小无效。' }); }
          const write = queue.then(async () => {
            await writeFile(stateFile + '.tmp', JSON.stringify(value, null, 2));
            await rename(stateFile + '.tmp', stateFile);
          });
          queue = write.catch(() => {});
          await write;
          return json(res, 200, { status: 'saved' });
        }
      }
      return json(res, 404, { error: '找不到该页面。' });
    } catch (error) {
      console.error('本机演示请求失败：', error.message);
      return json(res, 500, { error: '本地演示请求失败。' });
    }
  });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createGeneratedServer();
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? '端口已占用，请使用其他 DEMO_PORT。' : error.message);
    process.exitCode = 1;
  });
  server.listen(Number(process.env.DEMO_PORT || 18080), '127.0.0.1', () => {
    console.log('演示系统：http://127.0.0.1:' + server.address().port);
  });
}
