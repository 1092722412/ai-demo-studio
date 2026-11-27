import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import type { ArtifactFile } from './artifacts.js';
import type { SystemDelivery } from './ai/contracts.js';
import { PlanError } from './plans.js';

const adapterId = 'generated-local-node';
export const generatedStateLimit = 128_000;

export async function buildSystemSource(delivery: SystemDelivery): Promise<ArtifactFile> {
  const validator = new URL('../server/spec.mjs', import.meta.url);
  const { parseGenerated } = await import(validator.href);
  let project;
  try {
    project = parseGenerated({ project: delivery.project, skill: { name: delivery.skill.name, sha256: delivery.skill.digest } });
  } catch {
    throw new PlanError('OUTPUT_INVALID', '系统内容未通过生成校验。');
  }
  const initial = strToU8(project.stateJson);
  if (initial.byteLength > generatedStateLimit) {
    throw new PlanError('OUTPUT_INVALID', '生成的初始状态超过固定模板和脚本支持的大小。');
  }
  const manifest = { title: project.title, adapterId, entry: 'server.mjs', controls: project.fields,
    acceptance: project.acceptance, skill: project.skill };
  const template = fileURLToPath(new URL('../template/generated-server.mjs', import.meta.url));
  const bytes = zipSync({
    'server.mjs': await readFile(template),
    'page.html': strToU8(project.body),
    'style.css': strToU8(project.css),
    'app.js': strToU8(project.script),
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'seed/data.json': strToU8(project.seedJson),
    'seed/state.json': initial,
    '启动演示.cmd': strToU8(['@echo off', 'setlocal', 'node "%~dp0server.mjs"', 'exit /b %errorlevel%', ''].join('\r\n')),
    'README.md': strToU8([
      '# 系统启动', '',
      '解压后使用 Node.js 22.12 或更高版本运行 `node server.mjs`。Windows 下也可双击 `启动演示.cmd`。',
      '启动后访问 http://127.0.0.1:18080。可用环境变量 `DEMO_PORT` 更改端口。',
      '样例和初态在 `seed/`，运行数据保存在 `.runtime/state.json`。首次启动使用预置初态。', '',
    ].join('\n')),
  });
  return { kind: 'source', extension: '.zip', mime: 'application/zip', bytes,
    metadata: { sourceKind: 'generated', adapterId, title: project.title } };
}
