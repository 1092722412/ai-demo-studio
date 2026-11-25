import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createStudio } from '../server/studio.mjs';

test('同一项目可追问和修改，成功后只交付当前系统', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-chat-'));
  const threadId = 'b8c00dd9-4578-4113-b0ed-8dfa6618e0e8';
  const skill = { name: 'bid-demo-system', sha256: 'a'.repeat(64) };
  let release;
  const stop = new Promise((resolve) => { release = resolve; });
  const studio = await createStudio({ dataRoot: root, generate: async (job, folder, activity, base) => {
    activity('读取演示需求', 'done');
    const latest = job.conversation.at(-1).text;
    if (job.conversation.length === 1) {
      await stop;
      return { reply: '请确认要生成哪种预约。', project: null, skill, threadId };
    }
    assert.equal(job.threadId, threadId);
    if (latest === '模拟修改失败') throw new Error('本机 Codex 用量限制');
    if (latest === '只说下这个页面的作用') {
      assert.equal(base, join(root, 'jobs', job.baseBuildId, 'source'));
      return { reply: '这是预约工作台。', project: null, skill, threadId };
    }
    if (latest === '把标题改为预约工作台') {
      const old = JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8'));
      assert.equal(old.title, '访客预约');
    }
    const title = latest === '把标题改为预约工作台' ? '预约工作台' : '访客预约';
    return { reply: '已应用所要求的修改。', skill, threadId, project: {
      title, body: '<button data-testid="save">' + title + '</button>', css: 'body {}',
      script: 'void 0', seedJson: '{}', stateJson: '{}', controls: [{ id: 'save', label: '保存' }],
      acceptance: [{ operation: '打开页面', result: '看到标题' }],
    } };
  } });
  t.after(async () => { release(); await studio.close(); await rm(root, { recursive: true, force: true }); });
  const origin = await studio.listen(0);
  const post = (path, data) => fetch(origin + path, {
    method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const get = async (id) => (await fetch(origin + '/api/jobs/' + id)).json();
  async function expect(id, status) {
    for (let count = 0; count < 50; count++) {
      const job = await get(id);
      if (job.status === status) return job;
      if (job.status === 'failed') throw new Error(job.error);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal((await get(id)).status, status);
  }
  const start = await post('/api/jobs', { title: '预约', requirement: '先和我讨论预约', reference: '' });
  const { id } = await start.json();
  await expect(id, 'generating');
  assert.ok((await get(id)).activity.some((event) => event.label === '读取演示需求'));
  release();
  const question = await expect(id, 'discussed');
  assert.equal(question.conversation.at(-1).text, '请确认要生成哪种预约。');
  assert.equal(question.previewUrl, null);
  const message = async (parent, text) => {
    const response = await post('/api/jobs/' + parent + '/messages', { message: text });
    assert.equal(response.status, 202);
    return (await response.json()).id;
  };
  const first = await expect(await message(id, '访客预约，请生成'), 'ready');
  const discuss = await expect(await message(first.id, '只说下这个页面的作用'), 'discussed');
  assert.equal(discuss.previewUrl, first.previewUrl);
  assert.equal(discuss.previewVersion, first.version);
  const next = await expect(await message(discuss.id, '把标题改为预约工作台'), 'ready');
  assert.equal(next.projectId, first.projectId);
  assert.equal(next.spec.title, '预约工作台');
  assert.notEqual(next.previewUrl, first.previewUrl);
  assert.equal(next.conversation.filter(({ role }) => role === 'user').length, 4);
  assert.equal((await get(first.id)).spec.title, '预约工作台');
  assert.equal((await get(first.id)).id, next.id);
  const projects = await (await fetch(origin + '/api/jobs')).json();
  assert.deepEqual(projects.map(({ id }) => id), [next.id]);
  await assert.rejects(readFile(join(root, 'jobs', first.id, 'source.zip')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'jobs', first.id, 'source', 'page.html')), { code: 'ENOENT' });
  const outdated = await post('/api/jobs/' + first.id + '/messages', { message: '旧版本发送' });
  assert.equal(outdated.status, 409);
  const failureId = await message(next.id, '模拟修改失败');
  for (let count = 0; count < 30 && (await get(failureId)).status !== 'failed'; count++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const failed = await get(failureId);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.previewJobId, next.id);
  assert.equal(failed.spec.title, '预约工作台');
  assert.ok((await fetch(origin + '/api/jobs/' + failureId + '/download')).ok);
});
