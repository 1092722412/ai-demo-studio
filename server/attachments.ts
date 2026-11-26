import { Buffer } from 'node:buffer';
import { open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import type { ArtifactRecord, StudioRepository } from './store/repository.js';

export type SourceRef = { artifactId: string; locator: string; quote: string };
export type ExtractedAttachment = { text: string; sourceRefs: SourceRef[] };
export const maxAttachmentBytes = 20 * 1024 * 1024;
const maxTextLength = 8_000_000;
const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const supported = new Map([
  ['.txt', ['text/plain']], ['.md', ['text/markdown', 'text/plain']], ['.markdown', ['text/markdown', 'text/plain']],
  ['.json', ['application/json', 'text/plain']], ['.csv', ['text/csv', 'text/plain']],
  ['.pdf', ['application/pdf']], ['.docx', [docxMime]],
]);

export function attachmentType(name: string, contentType: string) {
  const extension = name.match(/\.[^.\\/]+$/)?.[0].toLowerCase() ?? '';
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  if (!supported.get(extension)?.includes(mime)) {
    throw new AttachmentError('VALIDATION_FAILED', '附件格式不支持或文件类型不匹配。', 422);
  }
  return { extension, mime };
}

export function createAttachmentExtractor(repository: StudioRepository) {
  return async (artifact: ArtifactRecord): Promise<ExtractedAttachment> => {
    const file = repository.getArtifactPath(artifact.projectId, artifact.id);
    if (!file || file.artifact.kind !== 'attachment' || file.artifact.state !== 'available') {
      throw new AttachmentError('VALIDATION_FAILED', '找不到可读取的项目附件。', 404);
    }
    return extractAttachment({ ...file.artifact, path: file.path });
  };
}

export async function extractAttachment(artifact: Pick<ArtifactRecord, 'id' | 'relativePath' | 'mime' | 'bytes'> & { path: string }): Promise<ExtractedAttachment> {
  const { extension } = attachmentType(artifact.relativePath, artifact.mime);
  if (artifact.bytes > maxAttachmentBytes) tooLarge();
  const file = await open(artifact.path, 'r');
  let bytes: Uint8Array;
  try {
    const size = (await file.stat()).size;
    if (size > maxAttachmentBytes) tooLarge();
    bytes = new Uint8Array(size);
    for (let position = 0; position < size;) {
      const { bytesRead } = await file.read(bytes, position, size - position, position);
      if (bytesRead === 0) throw new AttachmentError('VALIDATION_FAILED', '附件在读取期间发生变化。', 422);
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  let text: string;
  let refs: Array<{ locator: string; quote: string }>;
  try {
    if (extension === '.pdf') {
      const pages = await readPdf(bytes);
      text = pages.join('\n\n');
      refs = indexed(pages, 'page');
    } else if (extension === '.docx') {
      text = await readDocx(bytes);
      if (text.length > maxTextLength) tooLarge();
      refs = indexed(text.split(/\r?\n[ \t]*\r?\n/), 'paragraph');
    } else {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (text.length > maxTextLength) tooLarge();
      if (text.includes('\0')) throw new Error('binary');
      refs = indexed(text.split(/\r\n|\n|\r/), 'line');
    }
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError('VALIDATION_FAILED', '无法提取附件原文，请检查文件格式或提供可读文本。', 422);
  }
  if (!text.trim()) throw new AttachmentError('VALIDATION_FAILED', '附件未提取到可读文本，请提供可读文本。', 422);
  if (text.length > maxTextLength) tooLarge();
  return { text, sourceRefs: refs.map((ref) => ({ artifactId: artifact.id, ...ref })) };
}

function indexed(parts: string[], unit: string) {
  const entries = [];
  for (const [index, quote] of parts.entries()) {
    if (!quote.trim()) continue;
    if (entries.length >= 100_000) tooLarge();
    entries.push({ locator: unit + ':' + (index + 1), quote });
  }
  return entries;
}

async function readPdf(bytes: Uint8Array) {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const library = import.meta.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const loading = getDocument({
    data: bytes, isEvalSupported: false, stopAtErrors: true, useSystemFonts: false, verbosity: 0,
    cMapUrl: fileURLToPath(new URL('../../cmaps/', library)),
    standardFontDataUrl: fileURLToPath(new URL('../../standard_fonts/', library)),
    cMapPacked: true, useWorkerFetch: false,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 10_000) tooLarge();
    const pages: string[] = [];
    let length = 0;
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo++) {
      const page = await pdf.getPage(pageNo);
      const content = await page.getTextContent();
      const text = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('');
      pages.push(text);
      length += text.length;
      if (length > maxTextLength) tooLarge();
      page.cleanup();
    }
    return pages;
  } finally {
    await loading.destroy();
  }
}

async function readDocx(bytes: Uint8Array) {
  let total = 0;
  unzipSync(bytes, { filter(entry) {
    total += entry.originalSize;
    if (total > 64 * 1024 * 1024) tooLarge();
    return false;
  } });
  const { default: mammoth } = await import('mammoth');
  return (await mammoth.extractRawText({ buffer: Buffer.from(bytes) })).value;
}

function tooLarge(): never {
  throw new AttachmentError('LIMIT_EXCEEDED', '附件或提取内容超过大小限制。', 413);
}

export class AttachmentError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) { super(message); }
}
