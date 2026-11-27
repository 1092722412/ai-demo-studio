import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import ts from 'typescript';
import { createArtifactService } from '../dist-server/artifacts.js';
import { fixture, makePlan, runningTask, sourceZip, waitForTask } from '../test-support/plan-fixture.mjs';

const source = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { api, artifactContentUrl } = await import('data:text/javascript;base64,' + Buffer.from(outputText).toString('base64'));

test('录制准备客户端贯通提案、冲突、试听和脚本包，成果按项目隔离', async (t) => {
  let id;
  const { id: projectId, repository, send } = await fixture(t,
    async () => ({ reply: '合成提案', delivery: { kind: 'plan', draft: makePlan(id) } }),
    async ({ textPath, outputPath }) => {
      const text = await readFile(textPath, 'utf8');
      if (text === '合成失败输入') throw new Error('合成语音失败');
      await writeFile(outputPath, 'synthetic audio');
    });
  id = projectId;
  async function inject(url, { method = 'GET', body, headers } = {}) {
    return send(method, url, body ? JSON.parse(body) : undefined, headers);
  }
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await inject(url, options);
    return new Response(response.rawPayload, { status: response.statusCode, headers: response.headers });
  });
  const publish = async (taskId) => {
    const task = runningTask(repository, id, taskId);
    await createArtifactService(repository).publishArtifact(task.id, { kind: 'source', extension: '.zip',
      mime: 'application/zip', bytes: sourceZip(), metadata: { sourceKind: 'imported', adapterId: 'synthetic' } });
    repository.saveTask({ ...task, state: 'succeeded' });
  };
  await publish('t-handoff-source');
  const original = await api.getPlan(id);
  const accepted = await api.postMessage(id, { requestId: 'handoff-plan', purpose: 'plan', text: '拟定合成提案' });
  await waitForTask(send, accepted.taskId);
  const proposal = (await api.getTask(accepted.taskId)).result.delivery.draft;
  assert.deepEqual(proposal, makePlan(id));
  assert.deepEqual((await api.getPlan(id)).draft, {});

  const saved = await api.savePlan(id, { description: '另一处保存的草稿' }, original.editToken);
  assert.ok(saved.issues.some(({ path }) => path === '/steps'));
  await assert.rejects(api.savePlan(id, proposal, original.editToken), { status: 409, code: 'EDIT_CONFLICT' });
  const latest = await api.getPlan(id);
  assert.deepEqual(latest.draft, saved.draft);
  await api.savePlan(id, proposal, latest.editToken);

  await assert.rejects(api.previewSpeech(id, proposal.narration[0].text), { field: 'tts.voice' });
  const settings = await api.readSettings(id);
  await api.saveSettings(id, { tts: { voice: 'zh-CN-XiaoxiaoNeural' } }, settings.editToken);
  const failure = await api.previewSpeech(id, '合成失败输入');
  assert.equal((await waitForTask(send, failure.taskId)).error.code, 'RENDER_FAILED');
  const speech = await api.previewSpeech(id, proposal.narration[0].text);
  const audio = await waitForTask(send, speech.taskId);
  const audioFile = await inject(artifactContentUrl(id, audio.result.artifactId));
  assert.equal(audioFile.headers['content-type'], 'audio/mpeg');
  assert.equal(audioFile.body, 'synthetic audio');

  const script = await api.generateScripts(id, 'handoff-script');
  const completed = await waitForTask(send, script.taskId);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
  const [artifact] = await api.listScripts(id);
  assert.equal(artifact.id, completed.result.artifactId);
  assert.equal(artifact.stale, false);
  const download = await inject(artifactContentUrl(id, artifact.id, true));
  assert.match(download.headers['content-disposition'], /\.zip"/);
  assert.ok(unzipSync(download.rawPayload)['plan.json']);

  const other = await api.createProject({ title: '第二个合成项目', brief: '验证项目隔离' });
  assert.deepEqual((await api.getPlan(other.id)).draft, {});
  assert.deepEqual(await api.listScripts(other.id), []);
  assert.equal((await inject(artifactContentUrl(other.id, audio.result.artifactId))).statusCode, 404);
  await publish('t-handoff-replacement');
  assert.equal((await api.getPlan(id)).state, 'needs_update');
  assert.equal((await api.listScripts(id))[0].stale, true);
});
