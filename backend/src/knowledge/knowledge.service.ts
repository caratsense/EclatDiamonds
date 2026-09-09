import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { chunkText, detectKnowledgeFile, extractText, normaliseExtractedText } from './document-extractor';
import { KnowledgeStorageService } from './knowledge-storage.service';

export const KNOWLEDGE_EXTRACT_JOB = 'knowledge.extract';

@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: KnowledgeStorageService,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  list(user: AuthUser) {
    return this.prisma.knowledgeDocument.findMany({
      where: { organisationId: user.organisationId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { chunks: true } } },
    }).then((documents) => documents.map(toView));
  }

  async upload(user: AuthUser, file: { buffer?: Buffer; originalname?: string }, title?: string) {
    if (!file?.buffer?.length) throw new BadRequestException('No knowledge file uploaded.');
    const originalFileName = (file.originalname ?? 'document').slice(0, 240);
    const kind = detectKnowledgeFile(originalFileName, file.buffer);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const duplicate = await this.prisma.knowledgeDocument.findUnique({
      where: { organisationId_sha256: { organisationId: user.organisationId, sha256 } },
      include: { _count: { select: { chunks: true } } },
    });
    if (duplicate) return { document: toView(duplicate), deduplicated: true };

    const id = randomUUID();
    const storageKey = await this.storage.save(user.organisationId, id, originalFileName, file.buffer);
    const status = kind === 'doc' ? 'needs_conversion' : 'extracting';
    let document;
    try {
      document = await this.prisma.knowledgeDocument.create({
        data: {
          id,
          organisationId: user.organisationId,
          title: (
            (typeof title === 'string' ? title.trim() : '') ||
            originalFileName.replace(/\.[^.]+$/, '')
          ).slice(0, 180),
          originalFileName,
          mimeType: mimeFor(kind),
          sizeBytes: file.buffer.length,
          sha256,
          storageKey,
          status,
          uploadedById: user.id,
          error:
            kind === 'doc'
              ? 'Legacy .doc is stored privately but must be converted to DOCX or PDF before text extraction.'
              : null,
        },
      });
    } catch (error) {
      await this.storage.remove(user.organisationId, storageKey);
      throw error;
    }

    if (kind !== 'doc') {
      await this.jobs.enqueue({
        kind: KNOWLEDGE_EXTRACT_JOB,
        organisationId: user.organisationId,
        createdById: user.id,
        payload: { documentId: id } as Prisma.InputJsonValue,
        idempotencyKey: `${user.organisationId}:knowledge:${id}:extract`,
        maxAttempts: 3,
      });
    }
    await this.audit.record(user, {
      action: 'knowledge.uploaded',
      entityType: 'KnowledgeDocument',
      entityId: id,
      summary: `Uploaded private AI CRM knowledge document "${document.title}"`,
      metadata: { kind, sizeBytes: file.buffer.length, status },
    });
    return { document: toView(document), deduplicated: false };
  }

  async extract(organisationId: string, documentId: string) {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id: documentId, organisationId },
    });
    if (!document) return { documentId, status: 'deleted', deduplicated: true };
    if (document.status === 'ready') return { documentId, status: 'ready', deduplicated: true };
    try {
      const buffer = await this.storage.read(organisationId, document.storageKey);
      const kind = detectKnowledgeFile(document.originalFileName, buffer);
      if (kind === 'doc') return { documentId, status: 'needs_conversion' };
      const extracted = await extractText(kind, buffer);
      const text = normaliseExtractedText(extracted.text);
      if (text.length < 20) {
        await this.prisma.knowledgeDocument.update({
          where: { id: document.id },
          data: {
            status: kind === 'pdf' ? 'needs_ocr' : 'failed',
            extractionMethod: extracted.method,
            extractedChars: text.length,
            error: kind === 'pdf' ? 'No usable text layer was found. OCR is required.' : 'No usable text was extracted.',
          },
        });
        return { documentId, status: kind === 'pdf' ? 'needs_ocr' : 'failed', chunks: 0 };
      }
      const chunks = chunkText(text);
      await this.prisma.$transaction(async (tx) => {
        await tx.knowledgeChunk.deleteMany({ where: { documentId: document.id } });
        await tx.knowledgeChunk.createMany({
          data: chunks.map((chunk) => ({ ...chunk, organisationId, documentId: document.id })),
        });
        await tx.knowledgeDocument.update({
          where: { id: document.id },
          data: { status: 'ready', extractionMethod: extracted.method, extractedChars: text.length, error: null },
        });
      });
      return { documentId, status: 'ready', chunks: chunks.length, extractedChars: text.length };
    } catch (error) {
      await this.prisma.knowledgeDocument.update({
        where: { id: document.id },
        data: { status: 'failed', error: (error instanceof Error ? error.message : String(error)).slice(0, 2000) },
      });
      throw error;
    }
  }

  search(user: AuthUser, query: string, opts?: KnowledgeSearchOptions) {
    return this.searchForOrganisation(user.organisationId, query, opts);
  }

  /**
   * Internal retrieval boundary for webhook/background work that has a tenant
   * identity but no human AuthUser. The organisation is always part of the DB
   * predicate; callers cannot widen this into a platform-wide search.
   */
  async searchForOrganisation(
    organisationId: string,
    query: string,
    opts: KnowledgeSearchOptions = {},
  ) {
    if (!organisationId?.trim()) throw new BadRequestException('Organisation is required.');
    const term = query.trim().slice(0, MAX_QUERY_CHARS);
    if (term.length < 2) throw new BadRequestException('Search needs at least 2 characters.');
    const terms = knowledgeSearchTerms(term);
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_RESULT_LIMIT), 1), MAX_RESULT_LIMIT);
    const chunks = await this.prisma.knowledgeChunk.findMany({
      where: {
        organisationId,
        document: { status: 'ready' },
        OR: terms.map((word) => ({ content: { contains: word, mode: 'insensitive' as const } })),
      },
      // Rank in application code for now. The candidate cap keeps one broad
      // word from turning retrieval into an unbounded tenant-wide scan.
      take: MAX_CANDIDATE_CHUNKS,
      include: { document: { select: { id: true, title: true, originalFileName: true } } },
    });
    return rankKnowledgeChunks(chunks, term).slice(0, limit);
  }

  async remove(user: AuthUser, id: string) {
    const document = await this.prisma.knowledgeDocument.findFirst({
      where: { id, organisationId: user.organisationId },
    });
    if (!document) throw new NotFoundException('Knowledge document not found.');
    await this.storage.remove(user.organisationId, document.storageKey);
    await this.prisma.knowledgeDocument.delete({ where: { id } });
    await this.audit.record(user, {
      action: 'knowledge.deleted',
      entityType: 'KnowledgeDocument',
      entityId: id,
      summary: `Deleted AI CRM knowledge document "${document.title}"`,
    });
    return { deleted: true };
  }
}

export interface KnowledgeSearchOptions {
  limit?: number;
}

const DEFAULT_RESULT_LIMIT = 12;
const MAX_RESULT_LIMIT = 20;
const MAX_CANDIDATE_CHUNKS = 200;
const MAX_QUERY_CHARS = 500;
const MAX_SEARCH_TERMS = 8;

const KNOWLEDGE_STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'you', 'your', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'how', 'can', 'could', 'would', 'should',
  'will', 'have', 'has', 'had', 'this', 'that', 'these', 'those', 'with',
  'from', 'into', 'about', 'there', 'their', 'they', 'them', 'but', 'not',
  'any', 'all', 'please', 'hello', 'thanks', 'thank', 'tell', 'does', 'did',
  'hai', 'hain', 'kya', 'kaise', 'kab', 'aur', 'aap', 'apka', 'apki', 'mujhe',
]);

/** Bounded content terms used both for the database candidate query and ranking. */
export function knowledgeSearchTerms(query: string): string[] {
  const words = normaliseSearchText(query).match(/[\p{L}\p{N}]{3,}/gu) ?? [];
  const useful = [...new Set(words.filter((word) => !KNOWLEDGE_STOP_WORDS.has(word)))]
    .sort((a, b) => b.length - a.length)
    .slice(0, MAX_SEARCH_TERMS);
  if (useful.length) return useful;

  // Preserve the old useful behaviour for a short code or phrase made entirely
  // of stop words, while keeping the database operand bounded.
  return [normaliseSearchText(query).slice(0, 64)];
}

type RankableKnowledgeChunk = {
  documentId: string;
  chunkIndex: number;
  content: string;
  document: { id: string; title: string; originalFileName: string };
};

/**
 * Deterministic lexical ranking until a tenant-safe embedding index is added.
 * Coverage matters most, followed by exact phrase, title matches and capped
 * term frequency. Scores compare hits within this query; they are not model
 * confidence and must never be presented as such.
 */
export function rankKnowledgeChunks(chunks: RankableKnowledgeChunk[], query: string) {
  const terms = knowledgeSearchTerms(query);
  const phrase = normaliseSearchText(query);
  return chunks
    .map((chunk) => {
      const content = normaliseSearchText(chunk.content);
      const title = normaliseSearchText(`${chunk.document.title} ${chunk.document.originalFileName}`);
      const matchedTerms = terms.filter((word) => content.includes(word));
      const coverage = matchedTerms.length / terms.length;
      const exactPhrase = phrase.length >= 4 && content.includes(phrase);
      const titleMatches = matchedTerms.filter((word) => title.includes(word)).length;
      const frequency = matchedTerms.reduce(
        (sum, word) => sum + Math.min(countOccurrences(content, word), 4),
        0,
      );
      const score = coverage * 10 + (exactPhrase ? 8 : 0) + titleMatches * 2 + frequency * 0.25;
      return {
        document: chunk.document,
        chunkIndex: chunk.chunkIndex,
        content: chunk.content,
        score: Number(score.toFixed(3)),
        matchedTerms,
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.document.id.localeCompare(b.document.id) ||
        a.chunkIndex - b.chunkIndex,
    );
}

function normaliseSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function countOccurrences(content: string, term: string): number {
  let count = 0;
  let position = 0;
  while ((position = content.indexOf(term, position)) !== -1) {
    count += 1;
    position += term.length;
  }
  return count;
}

function toView<T extends { storageKey: string; sha256: string; uploadedById: string | null }>(
  document: T,
) {
  const { storageKey: _storageKey, sha256: _sha256, uploadedById: _uploadedById, ...view } = document;
  return view;
}

function mimeFor(kind: string): string {
  return {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    txt: 'text/plain',
  }[kind] ?? 'application/octet-stream';
}
