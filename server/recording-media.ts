import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { PlanError } from './plans.js';
import { renderSpeech } from './speech.js';
import type { resolveSpeech } from './settings.js';

export type Cue = { startMs: number; endMs: number; text: string };
export type PreparedSpeech = { durationMs: number; cues: Cue[] };
export type CaptureProbe = { durationMs: number; widthPx: number; heightPx: number };

function probe(path: string, stream: 'a' | 'v', signal?: AbortSignal): Promise<{
  format: { duration: string }; streams: Array<{ width: number; height: number; start_time: string; codec_name: string }>;
}> {
  return new Promise((resolve, reject) => {
    execFile(process.env.DEMO_STUDIO_FFPROBE || 'ffprobe', ['-v', 'error', '-select_streams', stream + ':0',
      '-show_entries', 'format=duration:stream=width,height,start_time,codec_name', '-of', 'json', path],
    { windowsHide: true, timeout: 15_000, signal }, (error, stdout, stderr) => {
      if (error || stderr.trim()) return reject(new Error('ffprobe 未能读取本机媒体。'));
      try { resolve(JSON.parse(stdout)); } catch (cause) { reject(cause); }
    });
  });
}

export async function probeCapture(path: string, signal?: AbortSignal): Promise<CaptureProbe> {
  const { format, streams } = await probe(path, 'v', signal);
  const { width, height, start_time, codec_name } = streams[0] ?? {};
  if (codec_name !== 'h264' || Math.abs(Number(start_time)) > 0.001 || !Number.isFinite(Number(start_time))) {
    throw new PlanError('OUTPUT_INVALID', '原片的视频编码或首帧时间无效。');
  }
  return { durationMs: Number(format.duration) * 1000, widthPx: width!, heightPx: height! };
}

export function readCues(srt: string, durationMs: number): Cue[] {
  const time = (value: string) => value.split(/[:,]/).map(Number).reduce((ms, part, i) => ms + part * [3_600_000, 60_000, 1000, 1][i]!, 0);
  const cues = srt.replace(/\r/g, '').trim().split(/\n[ \t]*\n/).map((block) => {
    const [, timestamp, ...lines] = block.split('\n');
    const match = /^(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})$/.exec(timestamp ?? '');
    if (!match) throw new Error('字幕时间格式无效。');
    return { startMs: time(match[1]!), endMs: Math.min(time(match[2]!), durationMs), text: lines.join('\n').trim() };
  });
  checkSpeech({ durationMs, cues });
  return cues;
}

export function checkSpeech({ durationMs, cues }: PreparedSpeech): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !cues.length || cues.some((cue, index) =>
    !Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < (cues[index - 1]?.endMs ?? 0) ||
    cue.endMs <= cue.startMs || cue.endMs > durationMs || !cue.text.trim())) throw new Error('旁白时长或字幕边界无效。');
}

export async function prepareSpeech({ text, outputPath, speech, signal }: {
  text: string; outputPath: string; speech: ReturnType<typeof resolveSpeech>; signal: AbortSignal;
}): Promise<PreparedSpeech> {
  const textPath = outputPath + '.txt';
  const subtitlesPath = outputPath + '.srt';
  try {
    await writeFile(textPath, text, { flag: 'wx' });
    await renderSpeech({ textPath, outputPath, speech, subtitlesPath, signal });
    const { format, streams } = await probe(outputPath, 'a', signal);
    if (streams[0]?.codec_name !== 'mp3') throw new Error('讲解音频格式无效。');
    const durationMs = Number(format.duration) * 1000;
    return { durationMs, cues: readCues(await readFile(subtitlesPath, 'utf8'), durationMs) };
  } finally {
    await Promise.allSettled([textPath, subtitlesPath].map((file) => rm(file, { force: true })));
  }
}
