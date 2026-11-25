import { Script } from 'node:vm';

const string = { type: 'string' };

function object(properties) {
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

export const generatedSchema = object({
  title: string,
  body: string,
  css: string,
  script: string,
  seedJson: string,
  stateJson: string,
  controls: { type: 'array', items: object({ id: string, label: string }) },
  acceptance: { type: 'array', items: object({ operation: string, result: string }) },
});

export const conversationSchema = object({
  reply: string,
  project: { anyOf: [generatedSchema, { type: 'null' }] },
});

export function parseGenerated(result) {
  if (result.skill?.name !== 'bid-demo-system' || !/^[a-f0-9]{64}$/.test(result.skill.sha256)) {
    throw new Error('没有当前工程技能的调用记录，无法发布生成结果。');
  }
  const project = result.project;
  if (!project || !Array.isArray(project.controls) || !Array.isArray(project.acceptance)) {
    throw new Error('生成工程缺少页面控制或验收信息。');
  }
  const parts = Object.fromEntries(Object.entries({
    title: 80, body: 80_000, css: 80_000, script: 160_000, seedJson: 160_000, stateJson: 128_000,
  }).map(([key, max]) => [key, trimText(project[key], max)]));
  if (Object.values(parts).some((part) => !part) || /<(?:html|head|script|base|iframe)\b/i.test(parts.body)) {
    throw new Error('生成的源码不完整或页面使用了不支持的内嵌标签。');
  }
  try { new Script(parts.script, { filename: 'app.js' }); }
  catch { throw new Error('生成的浏览器脚本有语法错误，请重新生成。'); }
  let seed;
  let state;
  try {
    seed = JSON.parse(parts.seedJson);
    state = JSON.parse(parts.stateJson);
    if (seed === null || state === null || typeof seed !== 'object' || typeof state !== 'object') throw new Error();
  } catch { throw new Error('生成的样例或运行初态不是有效的 JSON 数据。'); }
  if (!project.controls.length) throw new Error('生成工程没有提供可用于操作的页面标识。');
  const seen = new Set();
  const fields = project.controls.map((control, index) => {
    const id = trimText(control?.id, 60);
    const label = trimText(control?.label, 60);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || !label) {
      throw new Error('生成工程的第 ' + (index + 1) + ' 个页面标识或标签格式无效。');
    }
    if (seen.has(id)) throw new Error('生成工程包含重复的页面标识：' + id + '。');
    seen.add(id);
    return { id, label };
  });
  const acceptance = project.acceptance.map((entry) => ({
    operation: trimText(entry.operation, 200), result: trimText(entry.result, 200),
  }));
  if (!acceptance.length || acceptance.length > 30 || acceptance.some((entry) => !entry.operation || !entry.result)) {
    throw new Error('生成工程缺少操作与预期结果。');
  }
  return { ...parts, seed, state, fields, acceptance, skill: result.skill };
}

export function trimText(value, max) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

export function parseBrief(input) {
  const title = trimText(input?.title, 60);
  const requirement = trimText(input?.requirement, 6000);
  const reference = trimText(input?.reference, 12000);
  if (!title || !requirement || (input?.reference && !reference)) {
    throw new Error('请填写标题和演示需求，并检查输入长度。');
  }
  return { title, requirement, reference };
}

