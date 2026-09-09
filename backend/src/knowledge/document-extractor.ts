import { BadRequestException } from '@nestjs/common';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse';
import { extname } from 'node:path';

export type KnowledgeFileKind = 'pdf' | 'docx' | 'doc' | 'txt';

export function detectKnowledgeFile(fileName: string, buffer: Buffer): KnowledgeFileKind {
  const extension = extname(fileName).toLowerCase();
  if (!['.pdf', '.docx', '.doc', '.txt'].includes(extension)) {
    throw new BadRequestException('Upload a PDF, DOCX, DOC or TXT knowledge file.');
  }
  if (extension === '.pdf' && buffer.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  if (extension === '.docx' && buffer[0] === 0x50 && buffer[1] === 0x4b) return 'docx';
  if (
    extension === '.doc' &&
    buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) return 'doc';
  if (extension === '.txt' && !buffer.subarray(0, 1024).includes(0)) return 'txt';
  throw new BadRequestException(
    'The file contents do not match its extension, so it was not stored.',
  );
}

export async function extractText(kind: KnowledgeFileKind, buffer: Buffer) {
  if (kind === 'txt') return { text: buffer.toString('utf8'), method: 'utf8' };
  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, method: 'mammoth-docx' };
  }
  if (kind === 'pdf') {
    const result = await pdfParse(buffer);
    return { text: result.text, method: 'pdf-parse' };
  }
  throw new Error('Legacy DOC extraction requires conversion to DOCX or PDF.');
}

export function normaliseExtractedText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Paragraph-aware windows with overlap to preserve context across boundaries. */
export function chunkText(text: string, size = 1800, overlap = 200) {
  const chunks: { chunkIndex: number; content: string; charStart: number; charEnd: number }[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const breakAt = Math.max(text.lastIndexOf('\n\n', end), text.lastIndexOf('. ', end));
      if (breakAt > start + Math.floor(size * 0.6)) end = breakAt + 1;
    }
    const content = text.slice(start, end).trim();
    if (content) chunks.push({ chunkIndex: chunks.length, content, charStart: start, charEnd: end });
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
