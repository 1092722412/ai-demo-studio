import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStudio } from '../server/studio.mjs';

const brief = { title: '培训报名演示', requirement: '填写学员姓名与培训日期，保存并查看报名。', reference: '' };
const spec = {
  title: '培训报名', description: '提交培训报名并查看报名记录。',
  submitLabel: '保存报名', listLabel: '报名记录', emptyLabel: '暂无报名',
  successMessage: '报名已保存', fields: [
    { label: '学员姓名', type: 'text', required: true, options: [] },
    { label: '培训日期', type: 'date', required: true, options: [] },
  ],
};

test('未调用技能的旧格式结果被阻止发布，任务仍保留需求', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-test-'));
  const studio = await createStudio({ dataRoot: root, generate: async (job) => {
    assert.deepEqual(job.brief, brief);
    return { supported: true, limitation: '', spec };
  } });
  t.after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });
  const origin = await studio.listen(0);
  const api = (path, options = {}) => fetch(origin + path, { ...options, headers: {
    ...options.headers, ...(options.method === 'POST' ? { origin, 'content-type': 'application/json' } : {}),
  } });
  const create = await api('/api/jobs', { method: 'POST', body: JSON.stringify(brief) });
  assert.equal(create.status, 202);
  const { id } = await create.json();
  let job;
  for (let attempt = 0; attempt < 50; attempt++) {
    job = await (await api('/api/jobs/' + id)).json();
    if (job.status === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(job.status, 'failed');
  assert.match(job.error, /技能/);
  assert.equal(job.previewUrl, null);
  assert.equal((await api('/api/jobs/' + id + '/download')).status, 409);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'jobs', id, 'job.json'), 'utf8')).brief, brief);
  assert.equal((await api('/api/jobs', { method: 'POST', body: '{}' })).status, 400);
  assert.equal((await fetch(origin + '/api/jobs', { method: 'POST',
    headers: { origin: 'https://example.test', 'content-type': 'application/json' }, body: '{}' })).status, 403);
});
