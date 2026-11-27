import { isDeepStrictEqual } from 'node:util';
import { checkCaptureManifest, planObject, PlanError } from './plans.js';
import type { CaptureProbe, PreparedSpeech } from './recording-media.js';
import type { WorkerEvent } from './workers.js';

type Check = { target: string; op: string; expected: string | number | boolean };
export type RecordingStep = { id: string; checks: Check[]; holdMs: number; timeoutMs: number;
  actions: Array<{ op: string; text?: string }> };
export type RecordingPlan = {
  steps: RecordingStep[];
  narration: Array<{ id: string; stepId: string; anchor: 'start' | 'verified'; text: string }>;
  elements: Array<{ id: string }>;
  layers: Array<{ type: string; target?: string; stepId?: string; anchor?: string }>;
};
export type Audio = PreparedSpeech & { narrationId: string; artifactId: string };
const anchors = { 'step.started': 'start', 'step.verified': 'verified', 'step.finished': 'end' } as const;

export function recordingResults(plan: RecordingPlan, audio: Audio[]) {
  const events: Array<{ stepId: string; anchor: string; monotonicMs: number; rects?: unknown[] }> = [];
  const checks: Array<Record<string, unknown>> = [];
  let samples: Array<{ monotonicMs: number; videoMs: number }> = [];
  let firstFrame: number | undefined;
  let screen: { widthPx: number; heightPx: number } | undefined;
  let stepIndex = 0;
  let anchorIndex = 0;
  const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid();

  function invalid(message = '步骤结果或采集时间不符合交接契约。'): never {
    throw new PlanError('OUTPUT_INVALID', message);
  }

  return {
    accept({ type, payload }: WorkerEvent) {
      if (type === 'capture.started') {
        firstFrame = time(payload.monotonicMs);
        const widthPx = time(payload.widthPx);
        const heightPx = time(payload.heightPx);
        if (!Number.isInteger(widthPx) || !Number.isInteger(heightPx) || !widthPx || !heightPx) invalid();
        screen = { widthPx, heightPx };
        return;
      }
      if (type === 'capture.finished') {
        if (stepIndex !== plan.steps.length || !Array.isArray(payload.syncSamples) || payload.syncSamples.length < 2) invalid();
        samples = (payload.syncSamples as unknown[]).map((sample) => ({
          monotonicMs: time(planObject(sample)?.monotonicMs), videoMs: time(planObject(sample)?.videoMs),
        }));
        if (samples[0]!.monotonicMs !== firstFrame || samples[0]!.videoMs !== 0 || samples.some((sample, i) => {
          if (i === 0) return false;
          const monoDelta = sample.monotonicMs - samples[i - 1]!.monotonicMs;
          const videoDelta = sample.videoMs - samples[i - 1]!.videoMs;
          return monoDelta <= 0 || videoDelta <= 0 || Math.abs(monoDelta - videoDelta) > 100;
        })) invalid('原片时钟与步骤时钟无法可靠对齐。');
        return;
      }
      if (!Object.hasOwn(anchors, type)) return;
      const anchor = anchors[type as keyof typeof anchors];
      const step = plan.steps[stepIndex];
      const monotonicMs = time(payload.monotonicMs);
      if (!step || payload.stepId !== step.id || anchor !== Object.values(anchors)[anchorIndex] ||
          firstFrame === undefined || monotonicMs < (events.at(-1)?.monotonicMs ?? firstFrame)) invalid();
      const { rects } = payload;
      if (rects !== undefined && (!Array.isArray(rects) || rects.some((rect) =>
        !plan.elements.some(({ id }) => id === planObject(rect)?.target)))) invalid();
      const overlays = plan.layers.filter((layer) => layer.type === 'box' && layer.stepId === step.id && layer.anchor === anchor);
      if (overlays.some(({ target }) => !(rects as unknown[] | undefined)?.some((rect) => planObject(rect)?.target === target))) {
        invalid('步骤缺少标注目标的物理像素矩形。');
      }
      if (anchor === 'verified') {
        const observed = payload.checks;
        if (!Array.isArray(observed) || observed.length !== step.checks.length) invalid();
        checks.push(...step.checks.map((check, i) => {
          const actual = planObject(observed[i]);
          if (!actual || check.target !== actual.target || check.op !== actual.op ||
              !isDeepStrictEqual(check.expected, actual.expected)) invalid();
          const matched = check.op === 'contains' ? typeof actual.actual === 'string' && actual.actual.includes(String(check.expected))
            : isDeepStrictEqual(check.expected, actual.actual);
          if (!matched || actual.passed !== true) {
            throw new PlanError('STEP_FAILED', '步骤实际结果与方案预期不符。', 422, '/steps/' + stepIndex,
              { cause: { checks: [{ ...check, actual: actual.actual, passed: false }] } });
          }
          return { ...check, stepId: step.id, actual: actual.actual, passed: true };
        }));
      }
      if (anchor === 'end') {
        const span = (trigger: 'start' | 'verified') => plan.narration.filter((line) => line.stepId === step.id && line.anchor === trigger)
          .reduce((total, line) => total + (audio.find((clip) => clip.narrationId === line.id)?.durationMs ?? 0), 0);
        const started = events.at(-2)!.monotonicMs;
        const verified = events.at(-1)!.monotonicMs;
        if (monotonicMs < Math.max(started + span('start'), verified + span('verified'), verified + step.holdMs)) {
          invalid('原片步骤的保留时间短于讲解或方案要求。');
        }
        stepIndex++;
        anchorIndex = 0;
      } else {
        anchorIndex++;
      }
      events.push({ stepId: step.id, anchor, monotonicMs, ...(rects ? { rects } : {}) });
    },
    complete(base: Record<string, unknown>, audio: Audio[], video: CaptureProbe) {
      const last = samples.at(-1);
      if (!last || last.videoMs > video.durationMs || video.durationMs - last.videoMs > 250 ||
          screen?.widthPx !== video.widthPx || screen.heightPx !== video.heightPx ||
          events.some(({ monotonicMs }) => monotonicMs > last.monotonicMs)) invalid();
      const mapped = events.map(({ monotonicMs, ...event }) => {
        const index = samples.findIndex((sample) => sample.monotonicMs >= monotonicMs);
        const right = samples[index]!;
        const left = samples[index - 1];
        const atMs = left ? left.videoMs + (right.videoMs - left.videoMs) *
          (monotonicMs - left.monotonicMs) / (right.monotonicMs - left.monotonicMs) : right.videoMs;
        for (const entry of event.rects ?? []) {
          const rect = planObject(planObject(entry)?.rectPx);
          if (time(rect?.x) + time(rect?.width) > video.widthPx || time(rect?.y) + time(rect?.height) > video.heightPx) {
            invalid('标注矩形超出原片画面。');
          }
        }
        return { ...event, atMs };
      });
      const manifest = { ...base, ...video, complete: true, events: mapped, checks, audio,
        timebase: { unit: 'ms', origin: 'firstVideoFrame', syncSamples: samples } };
      if (!checkCaptureManifest(manifest)) invalid();
      return manifest;
    },
  };
}
