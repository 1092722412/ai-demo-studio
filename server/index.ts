import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { initializeStore } from './store/repository.js';

export { initializeStore } from './store/repository.js';
export type { StudioRepository } from './store/repository.js';

export async function initializeStudio(dataRoot = process.env.DEMO_STUDIO_DATA_DIR || resolve('.studio')) {
  return initializeStore(dataRoot);
}

async function main(): Promise<void> {
  const repository = await initializeStudio();
  repository.close();
  process.stdout.write('AI Demo Studio 数据库已初始化。\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`AI Demo Studio 数据库初始化失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
