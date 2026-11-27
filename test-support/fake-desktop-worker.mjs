import { createInterface } from 'node:readline';
import { writeFileSync, appendFileSync } from 'node:fs';

const [mode, trace] = process.argv.slice(2);
let seq = 0;
let owner;
let capture;
const input = createInterface({ input: process.stdin });
const emit = (type, payload = {}) => process.stdout.write(JSON.stringify({ taskId: owner, seq: ++seq, type, payload }) + '\n');
const finish = () => input.close();

input.on('line', (line) => {
  const { commandId, taskId, op, payload } = JSON.parse(line);
  owner = taskId;
  if (op !== 'ping') appendFileSync(trace, op + '\n');
  if (op === 'ping') {
    if (mode !== 'lost' || !capture) emit('heartbeat');
    return;
  }
  emit('accepted', { commandId });
  if (op === 'prepare') {
    capture = payload.capturePath;
    if (mode === 'prepare-wait') return;
    emit('ready', { commandId });
  } else if (op === 'start') {
    writeFileSync(capture, 'synthetic video');
    emit('capture.started', { monotonicMs: 1000, widthPx: 1920, heightPx: 1080 });
    emit('step.started', { stepId: 'read', monotonicMs: 1010,
      rects: [{ target: 'result', rectPx: { x: 10, y: 20, width: 30, height: 40 } }] });
    if (['wait', 'lost'].includes(mode)) return;
    emit('step.verified', { stepId: 'read', monotonicMs: 1100,
      checks: [{ target: 'result', op: 'contains', expected: '测试值', actual: mode === 'wrong-result' ? '坏值' : '测试值', passed: true }] });
    emit('step.finished', { stepId: 'read', monotonicMs: 1800 });
    emit('capture.finished', { syncSamples: [{ monotonicMs: 1000, videoMs: 0 }, { monotonicMs: 1900, videoMs: 900 }] });
    finish();
  } else if (op === 'cancel') {
    emit('cancelled');
    finish();
  }
});
