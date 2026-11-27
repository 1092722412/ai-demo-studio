import { execFile } from 'node:child_process';
import type { resolveSpeech } from './settings.js';

export type SpeechRenderer = (input: {
  textPath: string; outputPath: string; speech: ReturnType<typeof resolveSpeech>;
  subtitlesPath?: string; signal?: AbortSignal;
}) => Promise<void>;

export const renderSpeech: SpeechRenderer = ({ textPath, outputPath, speech, subtitlesPath, signal }) => new Promise((resolve, reject) => {
  const command = process.env.DEMO_STUDIO_EDGE_TTS || 'edge-tts';
  execFile(command, [
    '--file', textPath, '--write-media', outputPath, '--voice', speech.voice,
    '--rate=' + speech.rate, '--pitch=' + speech.pitch, '--volume=' + speech.volume,
    ...(subtitlesPath ? ['--write-subtitles', subtitlesPath] : []),
  ], { windowsHide: true, timeout: 60_000, signal }, (error) => {
    if (error) reject(new Error('语音合成失败，请检查 edge-tts、网络及所选音色。'));
    else resolve();
  });
});
