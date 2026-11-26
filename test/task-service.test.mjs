import assert from 'node:assert/strict';
import test from 'node:test';
import { AiTaskError } from '../dist-server/ai/contracts.js';
import { TaskService } from '../dist-server/tasks.js';

const input = (taskId) => ({ taskId, projectId: 'project-1', limits: { timeoutMs: 2_000 } });
const result = { reply: '已完成。', nativeSessionRef: 'thread-1', delivery: null };

async function waitForState(service, taskId, expected) {
  const end = Date.now() + 1_000;
  while (Date.now() < end) {
    const task = service.get(taskId);
    if (task.state === expected) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.get(taskId).state, expected);
}

function runtime() {
  return {
    connection: { id: 'connection-1', kind: 'codex', provider: 'codex', model: 'test' },
    projectRoot: process.cwd(),
    tools: { call: async () => ({ ok: false }) },
  };
}

test('取消任务等待适配器确认并释放项目执行权', async () => {
  let calls = 0;
  const service = new TaskService({
    adapter: {
      probe: async () => ({ available: true, capabilities: { purposes: [] }, detail: '' }),
      execute: async (_input, context) => {
        calls += 1;
        if (calls > 1) return result;
        await new Promise((resolve, reject) => {
          context.signal.addEventListener('abort', () => reject(new AiTaskError('TASK_CANCELLED', '已停止。')), { once: true });
        });
        return result;
      },
    },
    createRuntime: () => runtime(),
  });

  await service.startAi(input('task-cancel'));
  await waitForState(service, 'task-cancel', 'running');
  assert.equal((await service.cancel('task-cancel')).state, 'cancelling');
  await waitForState(service, 'task-cancel', 'cancelled');

  await service.startAi(input('task-next'));
  await waitForState(service, 'task-next', 'succeeded');
  assert.equal(service.getResult('task-next'), result);
});

test('无法确认停止的 Worker 保持 interrupted 状态并占用项目', async () => {
  const service = new TaskService({
    adapter: {
      probe: async () => ({ available: true, capabilities: { purposes: [] }, detail: '' }),
      execute: async (_input, context) => new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(
          new AiTaskError('WORKER_LOST', '无法确认 Worker 已停止。', true, false),
        ), { once: true });
      }),
    },
    createRuntime: () => runtime(),
  });

  await service.startAi(input('task-uncertain'));
  await waitForState(service, 'task-uncertain', 'running');
  await service.cancel('task-uncertain');
  await waitForState(service, 'task-uncertain', 'interrupted');
  await assert.rejects(service.startAi(input('task-blocked')), { code: 'REQUEST_CONFLICT' });
});
