import { useEffect, useRef } from 'react';
import type { TaskEvent } from './api';

const terminalTypes = new Set(['task.succeeded', 'task.failed', 'task.cancelled', 'task.interrupted']);

export function useTaskEvents(taskId: string | null, onEvent: (event: TaskEvent) => void) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!taskId) return;
    const activeTaskId = taskId;
    const controller = new AbortController();
    let lastSeq = 0;

    async function connect() {
      while (!controller.signal.aborted) {
        let terminal = false;
        try {
          const response = await fetch(`/api/v1/tasks/${encodeURIComponent(activeTaskId)}/events?afterSeq=${lastSeq}`, {
            headers: { Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`SSE ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.indexOf('\n\n');
            while (boundary >= 0) {
              const frame = buffer.slice(0, boundary).replace(/\r/g, '');
              buffer = buffer.slice(boundary + 2);
              const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
              if (data) {
                try {
                  const event = JSON.parse(data) as TaskEvent;
                  if (Number.isInteger(event.seq) && event.seq > lastSeq) {
                    lastSeq = event.seq;
                    onEventRef.current(event);
                    if (terminalTypes.has(event.type)) terminal = true;
                  }
                } catch {
                  // 丢弃不完整或无法识别的事件，下一序号仍按服务端游标补读。
                }
              }
              boundary = buffer.indexOf('\n\n');
            }
          }
          if (terminal || controller.signal.aborted) break;
        } catch {
          if (controller.signal.aborted) break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
    }

    void connect();
    return () => controller.abort();
  }, [taskId]);
}
