import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStudio } from '../server/studio.mjs';
import { parseGenerated } from '../server/spec.mjs';

test('按工程技能生成非表单演示、预览并输出版本交接', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'demo-studio-generated-'));
  const studio = await createStudio({ dataRoot, generate: async (job) => ({
    skill: { name: 'bid-demo-system', sha256: 'a'.repeat(64) },
    project: {
      title: '配置比对', body: '<h1>配置比对</h1><input data-testid="routePrefix"><button data-testid="compare">比对</button>',
      css: 'body { color: #17293d; }', script: 'document.querySelector("button").onclick = () => {};',
      seedJson: '{"devices":[]}', stateJson: '{}',
      controls: [{ id: 'compare', label: '比对' }, { id: 'routePrefix', label: '路由前缀' }],
      acceptance: [{ operation: '点击比对', result: '展示实际差异' }],
    },
  }) });
  t.after(async () => { await studio.close(); await rm(dataRoot, { recursive: true, force: true }); });
  const origin = await studio.listen(0);
  const response = await fetch(origin + '/api/jobs', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: '配置比对', requirement: '比对两份配置，展示差异。', reference: '' }),
  });
  assert.equal(response.status, 202);
  const { id } = await response.json();
  let job;
  for (let count = 0; count < 60; count++) {
    job = await (await fetch(origin + '/api/jobs/' + id)).json();
    if (['ready', 'failed'].includes(job.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(job.status, 'ready', job.error);
  assert.equal(job.skill.name, 'bid-demo-system');
  const outer = await fetch(job.previewUrl);
  assert.match(await outer.text(), /sandbox="allow-scripts allow-forms"/);
  const page = await fetch(job.previewUrl + '/demo', { headers: { 'Sec-Fetch-Dest': 'iframe' } });
  const html = await page.text();
  assert.match(html, /data-testid="compare"/);
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts allow-forms/);
  assert.match(page.headers.get('content-security-policy'), /form-action 'none'/);
  assert.equal((await fetch(job.previewUrl + '/demo')).status, 403);
  assert.equal((await fetch(job.previewUrl + '/api/state')).status, 403);
  const [, token] = /name="demo-token" content="([^"]+)"/.exec(html);
  const seedResponse = await fetch(job.previewUrl + '/api/seed', { headers: { origin: 'null', 'X-Demo-Token': token } });
  assert.deepEqual(await seedResponse.json(), { devices: [] });
  const source = await fetch(origin + '/api/jobs/' + id + '/source/app.js');
  assert.match(await source.text(), /querySelector/);
  const bundle = await fetch(origin + '/api/jobs/' + id + '/download');
  assert.equal(Buffer.from(await bundle.arrayBuffer()).subarray(0, 4).toString('hex'), '504b0304');
  const handoff = await (await fetch(origin + '/api/jobs/' + id + '/handoff')).json();
  assert.equal(handoff.fields[0].id, 'compare');
  assert.equal(handoff.fields[1].id, 'routePrefix');
  assert.match(html, /data-testid="routePrefix"/);
  assert.equal(handoff.skill.sha256, 'a'.repeat(64));
  assert.deepEqual(JSON.parse(await readFile(join(dataRoot, 'jobs', id, 'source', 'seed', 'data.json'), 'utf8')), { devices: [] });
});

test('页面标识保留大小写，重复与非法标识有明确提示', () => {
  const result = {
    skill: { name: 'bid-demo-system', sha256: 'a'.repeat(64) },
    project: {
      title: '查询', body: '<h1>查询</h1>', css: 'body{}', script: 'void 0',
      seedJson: '{}', stateJson: '{}', acceptance: [{ operation: '查看', result: '显示' }],
      controls: [{ id: 'srcIp', label: '源 IP' }, { id: 'src_ip', label: '源 IP 文本' }],
    },
  };
  assert.deepEqual(parseGenerated(result).fields.map(({ id }) => id), ['srcIp', 'src_ip']);
  result.project.controls[1].id = 'srcIp';
  assert.throws(() => parseGenerated(result), /重复.*srcIp/);
  result.project.controls[1].id = '源Ip';
  assert.throws(() => parseGenerated(result), /第 2 个页面标识.*格式无效/);
});
