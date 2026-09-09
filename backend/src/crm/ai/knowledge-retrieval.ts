import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuthUser } from '../../common/auth-user';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { MAX_CONTEXT_CHARS } from './policy';

/**
 * Retrieval for the assistant, bounded to one tenant.
 *
 * ## Why this wrapper exists
 *
 * `KnowledgeService.search` is shaped for a signed-in person: it takes an
 * `AuthUser`. The assistant runs on the WEBHOOK path, where there is no user —
 * the caller is a provider. This is the one place that bridges the two, so when
 * an organisation-scoped entry point lands (see REQ-002 in
 * docs/work-requests/CLAUDE-SHARED-FILE-REQUEST.txt) exactly one line changes.
 *
 * The principal below carries the tenant and nothing else: no store scope, no
 * `allStores`, and an id that is not a real user. `search` filters on
 * `organisationId` alone, so this is precisely as wide as it needs to be and no
 * wider — and if a later change starts reading store scope off the user, this
 * principal has none, so the assistant would retrieve nothing rather than
 * quietly retrieving everything.
 */
export interface RetrievedContext {
  /** Ids of the documents quoted. Stored on the draft as its evidence. */
  documentIds: string[];
  /** Human-readable titles, for the reviewer's benefit. */
  titles: string[];
  /** The text handed to the model, already capped. */
  text: string;
  /** False when nothing matched — a handoff trigger, never a reason to invent. */
  found: boolean;
}

@Injectable()
export class KnowledgeRetrievalService {
  private readonly logger = new Logger(KnowledgeRetrievalService.name);

  constructor(private readonly knowledge: KnowledgeService) {}

  /** A principal that is a tenant and nothing more. */
  private principal(organisationId: string): AuthUser {
    return {
      id: 'system-ai-retrieval',
      name: 'CaratSense assistant',
      email: 'system@caratsense.local',
      role: Role.salesperson,
      organisationId,
      storeIds: [],
      allStores: false,
    };
  }

  /**
   * Fetch supporting material for a customer message.
   *
   * Never throws: a retrieval failure must produce "no knowledge", which the
   * caller turns into a handoff, rather than a 500 on the webhook thread.
   */
  async forQuery(organisationId: string, query: string): Promise<RetrievedContext> {
    const empty: RetrievedContext = { documentIds: [], titles: [], text: '', found: false };
    const term = (query ?? '').trim();
    // `search` rejects anything shorter, and a one-character question is not a
    // question worth retrieving on.
    if (term.length < 2) return empty;

    /*
     * SEARCH BY KEYWORD, NOT BY THE WHOLE SENTENCE.
     *
     * `KnowledgeService.search` is a literal substring match on the term it is
     * given. Handing it "what are your opening hours" asks whether that exact
     * phrase appears in a document — it essentially never does, so a natural
     * question would retrieve nothing and every customer message would fall
     * through to a person. That is not a safe default, it is a broken feature
     * that happens to fail safe.
     *
     * So the question is reduced to its content words and each is looked up,
     * longest first (the longest word is usually the most specific). Every call
     * is still organisation-scoped, so this widens what is FOUND without
     * widening whose documents can be found.
     *
     * This is keyword retrieval, not semantic search: it will miss a document
     * that answers the question in different words. Recorded as a limitation in
     * REQ-002 rather than dressed up — the honest fix is ranked/vector retrieval
     * inside KnowledgeService, which is Codex's area.
     */
    const terms = keywords(term);
    if (!terms.length) return empty;

    const principal = this.principal(organisationId);
    const hits: Awaited<ReturnType<KnowledgeService['search']>> = [];
    const seen = new Set<string>();
    for (const word of terms) {
      try {
        for (const hit of await this.knowledge.search(principal, word)) {
          // One chunk once, however many keywords led to it.
          const key = `${hit.document?.id}:${hit.chunkIndex}`;
          if (seen.has(key)) continue;
          seen.add(key);
          hits.push(hit);
        }
      } catch (err) {
        this.logger.warn(
          `Knowledge retrieval failed for organisation ${organisationId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // One bad term must not lose the results the others already found.
      }
    }
    if (!hits.length) return empty;

    const documentIds: string[] = [];
    const titles: string[] = [];
    const parts: string[] = [];
    let budget = MAX_CONTEXT_CHARS;

    for (const hit of hits) {
      const id = hit.document?.id;
      const title = hit.document?.title ?? hit.document?.originalFileName ?? 'Untitled';
      const body = (hit.content ?? '').trim();
      if (!id || !body) continue;
      // Stop at the budget rather than truncating mid-sentence in the middle of
      // a fact — a half-quoted price is worse than one fewer source.
      if (body.length > budget) break;
      budget -= body.length;

      if (!documentIds.includes(id)) {
        documentIds.push(id);
        titles.push(title);
      }
      parts.push(`[source: ${title}]\n${body}`);
    }

    if (!parts.length) return empty;
    return { documentIds, titles, text: parts.join('\n\n'), found: true };
  }
}

/**
 * Content words from a customer question, most specific first.
 *
 * Stop-words are dropped because searching for "what" or "your" matches every
 * document and tells you nothing. Words shorter than three characters go too:
 * `search` itself rejects anything under two, and two-letter fragments match
 * far too much to be worth a round trip.
 *
 * Deliberately language-agnostic beyond this English list — an unknown-language
 * message simply keeps all of its words, which is the safe direction: it may
 * retrieve a little noise, and the model is told to ignore what does not help.
 */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'you', 'your', 'yours', 'was', 'were', 'what', 'when',
  'where', 'which', 'who', 'why', 'how', 'can', 'could', 'would', 'should', 'will',
  'shall', 'may', 'might', 'must', 'have', 'has', 'had', 'this', 'that', 'these',
  'those', 'with', 'from', 'into', 'about', 'there', 'their', 'they', 'them', 'but',
  'not', 'any', 'all', 'get', 'got', 'please', 'hello', 'thanks', 'thank',
  'want', 'need', 'like', 'know', 'tell', 'give', 'does', 'did', 'doing', 'been',
  'some', 'more', 'much', 'many', 'now', 'just', 'also', 'because', 'per',
]);

/** At most this many lookups per message — retrieval must not become a fan-out. */
const MAX_TERMS = 6;

export function keywords(query: string): string[] {
  const words = (query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (w) => !STOP_WORDS.has(w),
  );
  // Longest first: the most specific word is the one most worth a lookup, and
  // the cap should spend itself on those rather than on whatever came first.
  const unique = [...new Set(words)].sort((a, b) => b.length - a.length);
  return unique.slice(0, MAX_TERMS);
}
