import type { EventRecord, StudioRepository } from './store/repository.js';

export type PublicTaskEvent = {
  taskId: string;
  seq: number;
  type: string;
  at: string;
  payload: unknown;
};

const terminalEvents = new Set(['task.succeeded', 'task.failed', 'task.cancelled', 'task.interrupted']);

export async function* readTaskEvents(
  repository: StudioRepository,
  taskId: string,
  afterSeq: number,
  signal: AbortSignal,
  pollMs = 100,
): AsyncGenerator<PublicTaskEvent> {
  let cursor = afterSeq;
  while (!signal.aborted) {
    const batch = repository.listEvents(taskId, cursor, 200);
    for (const item of batch) {
      if (signal.aborted || item.seq <= cursor) continue;
      cursor = item.seq;
      yield toPublicEvent(item);
      if (terminalEvents.has(item.type)) return;
    }
    const task = repository.getTask(taskId);
    if (!task) return;
    if (isTerminal(task.state) && cursor >= repository.getLastEventSeq(taskId)) return;
    await wait(pollMs, signal);
  }
}

function toPublicEvent(item: EventRecord): PublicTaskEvent {
  return { taskId: item.taskId, seq: item.seq, type: item.type, at: item.createdAt, payload: item.payload };
}

function isTerminal(state: string): boolean {
  return ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
