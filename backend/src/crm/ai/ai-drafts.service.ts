import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../../common/auth-user';
import { AuditService } from '../../common/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ActivityService } from '../activity.service';
import { ConversationsService } from '../conversations.service';

/**
 * Human review of AI drafts (Phase 2C).
 *
 * ## Approval is a human act, and it is recorded as one
 *
 * There is no code path here that a job, a webhook or a scheduler can reach.
 * Every method takes an `AuthUser`, and every outcome writes that user's id onto
 * the record. "The assistant sent it" is never a thing this system can say,
 * because the assistant cannot get past this file.
 *
 * ## Approving does NOT claim delivery
 *
 * An approved draft becomes `queued`, exactly like a reply a person typed. It is
 * not `sent`, and it is certainly not `delivered` — nothing in this repository
 * can hand a message to WhatsApp yet. The delivery vocabulary
 * (queued / sent / delivered / read / failed) belongs to the transport, and this
 * layer only ever moves a message to the FRONT of it.
 *
 * A rejected draft becomes `rejected`, which is deliberately NOT `failed`:
 * "a person decided against this" and "the network refused it" are different
 * facts, and collapsing them would corrupt every delivery-failure metric.
 */
export type DraftDecision = 'approved' | 'edited' | 'rejected';

@Injectable()
export class AiDraftsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly activity: ActivityService,
    private readonly audit: AuditService,
  ) {}

  /** Drafts awaiting a person, newest first. Scoped by conversation visibility. */
  async list(user: AuthUser, opts: { conversationId?: string; state?: string } = {}) {
    const state = opts.state === 'reviewed' ? 'reviewed' : opts.state === 'all' ? 'all' : 'pending';

    if (opts.conversationId) {
      // Throws 404 when the caller may not open the thread, so a draft can never
      // become a side channel onto a conversation they cannot read.
      await this.conversations.assertCanAccess(user, opts.conversationId);
    }

    /*
     * Scope by conversation in TWO steps, not with a relation filter.
     *
     * `AiDraftRecord` deliberately carries `conversationId` as a plain column
     * with no Prisma relation — adding one would have meant a fourth
     * back-relation in a schema another agent is editing. The cost is that the
     * visibility rule cannot be expressed as a nested `where`, so the ids are
     * resolved first. Bounded by the same take, and still one round trip more
     * than it would otherwise be.
     */
    const visibleIds = opts.conversationId
      ? [opts.conversationId]
      : (
          await this.prisma.conversation.findMany({
            where: { organisationId: user.organisationId, ...this.visibleConversations(user) },
            select: { id: true },
            take: 2000,
          })
        ).map((c) => c.id);

    if (!visibleIds.length) return [];

    const rows = await this.prisma.aiDraftRecord.findMany({
      where: {
        organisationId: user.organisationId,
        conversationId: { in: visibleIds },
        ...(state === 'pending' ? { review: 'pending' } : {}),
        ...(state === 'reviewed' ? { NOT: { review: 'pending' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: {
        message: { select: { id: true, body: true, status: true, sentAt: true } },
        reviewedBy: { select: { id: true, name: true } },
      },
    });

    return this.withSources(user.organisationId, rows);
  }

  /**
   * Approve a draft, optionally with edits.
   *
   * An edit is recorded as `edited`, not `approved`. The distinction is the
   * whole value of the record: "a person accepted what the model wrote" and
   * "a person had to rewrite it" are the two numbers that tell you whether the
   * assistant is actually working.
   */
  async approve(
    user: AuthUser,
    draftId: string,
    input: { body?: string; note?: string } = {},
  ) {
    const draft = await this.loadPending(user, draftId);

    const edited = typeof input.body === 'string' && input.body.trim().length > 0;
    const finalText = edited ? input.body!.trim() : (draft.message.body ?? '');
    if (!finalText) {
      throw new BadRequestException('An approved reply cannot be empty.');
    }
    const decision: DraftDecision = edited && finalText !== draft.message.body ? 'edited' : 'approved';

    // Compare-and-set: two reviewers pressing approve at the same moment must
    // produce one decision, and the database is the only thing that can decide
    // which. The loser is told, rather than silently overwriting the winner.
    const claimed = await this.prisma.aiDraftRecord.updateMany({
      where: { id: draftId, organisationId: user.organisationId, review: 'pending' },
      data: {
        review: decision,
        reviewedById: user.id,
        reviewedAt: new Date(),
        reviewNote: input.note?.trim() || null,
      },
    });
    if (claimed.count === 0) throw new BadRequestException('This draft has already been reviewed.');

    // QUEUED — not sent. See the class comment.
    await this.prisma.message.update({
      where: { id: draft.messageId },
      data: {
        body: finalText,
        status: 'queued',
        // The message stays authorType 'ai' even after a human edit: a customer
        // reply that began as a machine draft should never be indistinguishable
        // from one a person wrote from scratch. The record says who approved it.
        authorUserId: user.id,
      },
    });

    await this.record(user, draft, decision, finalText);

    return {
      draftId,
      decision,
      delivery: {
        state: 'queued' as const,
        note:
          'Approved and queued. It will not reach the customer until a messaging ' +
          'integration is connected for this channel.',
      },
    };
  }

  /** Reject a draft. The text is kept — the record of what was proposed matters. */
  async reject(user: AuthUser, draftId: string, input: { note?: string } = {}) {
    const draft = await this.loadPending(user, draftId);

    const claimed = await this.prisma.aiDraftRecord.updateMany({
      where: { id: draftId, organisationId: user.organisationId, review: 'pending' },
      data: {
        review: 'rejected',
        reviewedById: user.id,
        reviewedAt: new Date(),
        reviewNote: input.note?.trim() || null,
      },
    });
    if (claimed.count === 0) throw new BadRequestException('This draft has already been reviewed.');

    // 'rejected', NOT 'failed'. A person declining a draft is not a delivery
    // failure, and counting it as one would poison every failure metric.
    await this.prisma.message.update({
      where: { id: draft.messageId },
      data: { status: 'rejected' },
    });

    await this.record(user, draft, 'rejected', draft.message.body ?? '');
    return { draftId, decision: 'rejected' as const };
  }

  /* ------------------------------------------------------------ internals */

  /** Only conversations this caller may open. Mirrors the inbox rule exactly. */
  private visibleConversations(user: AuthUser): Prisma.ConversationWhereInput {
    return user.role === 'head_office'
      ? { OR: [{ storeId: { in: user.storeIds } }, { storeId: null }] }
      : { storeId: { in: user.storeIds } };
  }

  private async loadPending(user: AuthUser, draftId: string) {
    const draft = await this.prisma.aiDraftRecord.findFirst({
      where: { id: draftId, organisationId: user.organisationId },
      include: { message: { select: { id: true, body: true, status: true } } },
    });
    if (!draft) throw new NotFoundException('Draft not found');
    // The reviewer must be able to open the conversation. Checked before the
    // review state, so a caller outside the scope learns nothing about whether
    // the draft exists or has been handled.
    await this.conversations.assertCanAccess(user, draft.conversationId);
    if (draft.review !== 'pending') {
      throw new BadRequestException('This draft has already been reviewed.');
    }
    return draft;
  }

  private async record(
    user: AuthUser,
    draft: { id: string; conversationId: string; provider: string; model: string },
    decision: DraftDecision,
    text: string,
  ) {
    const convo = await this.prisma.conversation.findUnique({
      where: { id: draft.conversationId },
      select: { partyId: true, storeId: true, channel: true },
    });

    await this.audit.record(user, {
      action: `conversation.ai_draft_${decision}`,
      entityType: 'Conversation',
      entityId: draft.conversationId,
      // Stamped with the branch, so the manager it concerns can actually read it.
      storeId: convo?.storeId ?? undefined,
      summary: `AI draft ${decision} by ${user.name} (${draft.provider}/${draft.model}).`,
      metadata: { draftId: draft.id, decision, provider: draft.provider, model: draft.model },
    });

    await this.activity.recordFor(user, {
      type: `conversation.ai_draft_${decision}`,
      summary:
        decision === 'rejected'
          ? `${user.name} rejected the assistant's draft.`
          : `${user.name} ${decision === 'edited' ? 'edited and queued' : 'queued'} the assistant's draft.`,
      partyId: convo?.partyId ?? undefined,
      storeId: convo?.storeId ?? undefined,
      channel: convo?.channel ?? undefined,
      entityType: 'Conversation',
      entityId: draft.conversationId,
    });

    void text;
  }

  /**
   * Resolve knowledge document ids to titles for the reviewer.
   *
   * A reviewer asked to trust a draft needs to see what it was based on, and
   * "3 sources" is not that. Ids that no longer resolve are reported as deleted
   * rather than dropped — the draft really was written from something.
   */
  private async withSources<
    T extends { knowledgeDocumentIds: string[] },
  >(organisationId: string, rows: T[]) {
    const ids = [...new Set(rows.flatMap((r) => r.knowledgeDocumentIds))];
    const titles = new Map<string, string>();
    if (ids.length) {
      const docs = await this.prisma.knowledgeDocument.findMany({
        where: { id: { in: ids }, organisationId },
        select: { id: true, title: true },
      });
      for (const d of docs) titles.set(d.id, d.title);
    }
    return rows.map((r) => ({
      ...r,
      sources: r.knowledgeDocumentIds.map((id) => ({
        id,
        title: titles.get(id) ?? null,
        deleted: !titles.has(id),
      })),
    }));
  }
}
