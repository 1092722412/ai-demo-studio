import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpApp } from '../dist-server/http.js';
import { resolveProfile } from '../dist-server/settings.js';
import { initializeStore } from '../dist-server/store/repository.js';
import { injectHttp } from '../test-support/http-inject.mjs';

async function fixture(t, speechRenderer) {
  const root = await mkdtemp(join(tmpdir(), 'studio-settings-'));
  const repository = await initializeStore(root);
  const app = createHttpApp({ repository, tasks: {}, speechRenderer });
  t.after(async () => {
    await app.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  });
  const project = (await injectHttp(app, { method: 'POST', url: '/api/v1/projects', payload: { title: '设置工程', brief: '合成输入' } })).json().data;
  const projectPath = '/api/v1/projects/' + project.id;
  const read = (url) => injectHttp(app, { method: 'GET', url });
  const save = (url, values, token) => injectHttp(app, { method: 'PUT', url, payload: { values }, headers: token ? { 'if-match': token } : {} });
  return { root, repository, app, projectPath, read, save };
}

test('设置按叶子继承并记录来源，null 清除覆盖，重开后保留', async (t) => {
  const { root, projectPath, read, save } = await fixture(t);
  const global = '/api/v1/settings';
  const project = projectPath + '/settings';
  let response = await save(global, { subtitle: { color: '#123456', sizePx: 50 }, output: { fps: 25 } }, (await read(global)).headers.etag);
  assert.equal(response.statusCode, 200);
  response = await save(project, { moveMs: 800, subtitle: { sizePx: 60 } }, (await read(project)).headers.etag);
  assert.equal(response.statusCode, 200);
  let data = response.json().data;
  assert.equal(data.effective.subtitle.color, '#123456');
  assert.equal(data.effective.subtitle.sizePx, 60);
  assert.equal(data.sources['subtitle.color'], 'global');
  assert.equal(data.sources['subtitle.sizePx'], 'project');
  assert.equal(data.sources['subtitle.position'], 'default');
  assert.equal(data.effective.input, 'pyautogui');
  response = await save(project, { moveMs: null, subtitle: { sizePx: null } }, response.headers.etag);
  data = response.json().data;
  assert.deepEqual(data.values, {});
  assert.equal(data.effective.subtitle.sizePx, 50);
  assert.equal(data.effective.moveMs, 650);
  const reopened = await initializeStore(root);
  try {
    assert.deepEqual(reopened.getSettings('global').values.output, { fps: 25 });
    assert.equal(reopened.getSettings(data.scope).editToken, data.editToken);
  } finally { reopened.close(); }
  assert.equal(resolveProfile({ tts: { voice: 'zh-CN-XiaoxiaoNeural' } }, { tts: { voice: null } }).tts.voice, 'zh-CN-XiaoxiaoNeural');
});

test('HTTP 设置保存要求 If-Match，过期令牌和无效字段均不覆盖已保存值', async (t) => {
  const { read, save } = await fixture(t);
  const path = '/api/v1/settings';
  const first = await read(path);
  assert.equal((await save(path, { moveMs: 800 })).statusCode, 428);
  const saved = await save(path, { moveMs: 800 }, first.headers.etag);
  const conflict = await save(path, { moveMs: 900 }, first.headers.etag);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'EDIT_CONFLICT');
  for (const values of [{ capture: 'window' }, { output: { fps: 29 } }, { tts: { rate: '0' } }, { subtitle: { sizePx: 161 } }]) {
    assert.equal((await save(path, values, saved.headers.etag)).statusCode, 422);
  }
  assert.equal((await read(path)).json().data.effective.moveMs, 800);
});

test('缺音色只阻止试听，失败任务使用开始时的配置且不阻塞其他项目', async (t) => {
  let enter;
  let resume;
  const entered = new Promise((resolve) => { enter = resolve; });
  const release = new Promise((resolve) => { resume = resolve; });
  const { app, repository, projectPath, read, save } = await fixture(t, async ({ textPath, speech }) => {
    enter({ speech, text: await readFile(textPath, 'utf8') });
    await release;
    throw new Error('合成试听失败');
  });
  t.after(() => resume());
  const audio = () => injectHttp(app, { method: 'POST', url: projectPath + '/speech-preview', payload: { text: '合成讲解' } });
  assert.equal((await audio()).json().error.field, 'tts.voice');
  assert.equal((await read(projectPath)).statusCode, 200);
  const path = projectPath + '/settings';
  const first = await save(path, { tts: { voice: 'zh-CN-XiaoxiaoNeural' } }, (await read(path)).headers.etag);
  const accepted = await audio();
  if (accepted.statusCode !== 202) resume();
  assert.equal(accepted.statusCode, 202);
  try {
    const started = await entered;
    assert.equal(started.text, '合成讲解');
    assert.equal(started.speech.voice, 'zh-CN-XiaoxiaoNeural');
    assert.equal((await save(path, { tts: { voice: 'zh-CN-YunxiNeural' } }, first.headers.etag)).statusCode, 200);
    const other = await injectHttp(app, { method: 'POST', url: '/api/v1/projects', payload: { title: '独立项目', brief: '合成输入' } });
    assert.equal(other.statusCode, 201);
    const task = repository.getTask(accepted.json().data.taskId);
    assert.equal(task.kind, 'render');
    assert.equal(task.phase, 'speech_preview');
    assert.equal(task.input.profile.tts.voice, 'zh-CN-XiaoxiaoNeural');
  } finally { resume(); }
  let state;
  for (let tries = 0; tries < 100; tries++) {
    state = (await read('/api/v1/tasks/' + accepted.json().data.taskId)).json().data;
    if (state.state === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(state.error?.code, 'RENDER_FAILED');
  assert.deepEqual(repository.listArtifacts(state.projectId, 'media'), []);
});
