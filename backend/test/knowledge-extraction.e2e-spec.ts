import { BadRequestException } from '@nestjs/common';

import {
  chunkText,
  detectKnowledgeFile,
  normaliseExtractedText,
} from '../src/knowledge/document-extractor';
import { KnowledgeService, knowledgeSearchTerms, rankKnowledgeChunks } from '../src/knowledge/knowledge.service';

describe('AI CRM knowledge document boundary', () => {
  it('checks file signatures instead of trusting the extension', () => {
    expect(detectKnowledgeFile('policy.pdf', Buffer.from('%PDF-1.7\n'))).toBe('pdf');
    expect(detectKnowledgeFile('notes.txt', Buffer.from('approved policy'))).toBe('txt');
    expect(() => detectKnowledgeFile('fake.pdf', Buffer.from('not a pdf'))).toThrow(BadRequestException);
  });

  it('recognises legacy DOC but does not pretend it can extract it', () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(detectKnowledgeFile('old.doc', ole)).toBe('doc');
  });

  it('normalises and chunks text with bounded searchable windows', () => {
    const text = normaliseExtractedText(`Heading\r\n\r\n${'Sentence. '.repeat(500)}`);
    const chunks = chunkText(text, 500, 50);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.content.length <= 500)).toBe(true);
    expect(chunks.map((chunk) => chunk.chunkIndex)).toEqual(chunks.map((_, index) => index));
  });

  it('turns natural customer questions into bounded content terms', () => {
    expect(knowledgeSearchTerms('What are your opening hours and return policy?')).toEqual([
      'opening',
      'return',
      'policy',
      'hours',
    ]);
  });

  it('ranks coverage and exact phrases ahead of a one-word match', () => {
    const document = (id: string, title: string) => ({ id, title, originalFileName: `${id}.txt` });
    const ranked = rankKnowledgeChunks(
      [
        { documentId: 'one', chunkIndex: 0, content: 'Our opening hours are 10 to 6.', document: document('one', 'Store hours') },
        { documentId: 'two', chunkIndex: 0, content: 'Read the general return terms.', document: document('two', 'Policy') },
        { documentId: 'three', chunkIndex: 0, content: 'Opening hours and return policy are listed here.', document: document('three', 'Opening and returns') },
      ],
      'What are your opening hours and return policy?',
    );
    expect(ranked[0].document.id).toBe('three');
    expect(ranked[0].matchedTerms).toEqual(expect.arrayContaining(['opening', 'hours', 'return', 'policy']));
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('exposes an explicit tenant-scoped retrieval query', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new KnowledgeService(
      { knowledgeChunk: { findMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await service.searchForOrganisation('org-a', 'What are your opening hours?', { limit: 3 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organisationId: 'org-a', document: { status: 'ready' } }),
        take: 200,
      }),
    );
  });
});
