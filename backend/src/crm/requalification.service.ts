import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { QualificationService } from './qualification.service';
import { ConversationAiGate } from './ai-responder';

export const REQUALIFY_JOB = 'crm.requalify';

/**
 * Re-score a conversation after the customer says something new (Phase 2A).
 *
 * ## Why a job and not an inline call
 *
 * Qualification can call an AI provider. Doing that on the webhook thread would
 * put a customer's message at the mercy of a model's latency, and a provider
 * outage would start returning 500s to Meta — which retries, which duplicates.
 * The message is persisted first and the scoring is queued, so scoring can fail
 * without ever costing us the message.
 *
 * ## The debounce, and why it is free
 *
 * Someone typing four short messages in a row should produce ONE assessment, not
 * four. `JobsService.enqueue` already returns the existing job when an
 * `idempotencyKey` matches a pending or running row — so keying on the
 * conversation and scheduling a little in the future gives a debounce with no
 * new machinery: the first message schedules the run, the next three collapse
 * onto it, and the run sees all four when it fires.
 *
 * ## Provenance
 *
 * Every assessment is a NEW `LeadQualification` row (the service never updates
 * one), so an automatic score can never overwrite what a person recorded — the
 * history keeps both, and `createdById` says which was which.
 */
@Injectable()
export class RequalificationService implements OnModuleInit {
  private readonly logger = new Logger(RequalificationService.name);

  /** How long to wait for the customer to stop typing. Tenant-tunable. */
  private static readonly DEFAULT_DEBOUNCE_SECONDS = 60;

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly qualification: QualificationService,
    private readonly aiGate: ConversationAiGate,
  ) {}

  onModuleInit(): void {
    this.jobs.register(REQUALIFY_JOB, async (payload, ctx) => {
      const { conversationId } = (payload ?? {}) as { conversationId?: string };
      if (!conversationId || !ctx.organisationId) {
        return { skipped: 'missing conversation or organisation' };
      }
      return this.run(ctx.organisationId, conversationId);
    });
  }

  /**
   * Queue an assessment for a conversation.
   *
   * Never throws: this is called straight after an inbound message is stored,
   * and a scoring problem must not surface as a failed webhook.
   */
  async schedule(organisationId: string, conversationId: string): Promise<{ queued: boolean; reason?: string }> {
    try {
      const settings = await this.aiGate.settings(organisationId);
      if (!settings.qualificationEnabled) {
        return { queued: false, reason: 'Qualification is switched off for this organisation.' };
      }

      const debounceSeconds = await this.debounceFor(organisationId);
      await this.jobs.enqueue({
        kind: REQUALIFY_JOB,
        organisationId,
        payload: { conversationId },
        // The debounce: while one run is pending or in flight for this
        // conversation, every further message collapses onto it.
        idempotencyKey: `${REQUALIFY_JOB}:${organisationId}:${conversationId}`,
        runAt: new Date(Date.now() + debounceSeconds * 1000),
        maxAttempts: 3,
      });
      return { queued: true };
    } catch (err) {
      this.logger.warn(
        `Could not queue requalification for ${conversationId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { queued: false, reason: 'enqueue failed' };
    }
  }

  /** Execute one assessment. Runs inside the job runner's tenant binding. */
  private async run(organisationId: string, conversationId: string) {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organisationId },
      select: { id: true, storeId: true },
    });
    if (!convo) return { skipped: 'conversation no longer exists' };

    // A principal scoped to exactly this conversation's organisation, and to its
    // store when it has one. Never `allStores` — background work does not get
    // global authority, and an unrouted thread gets no store scope at all.
    const actor: AuthUser = {
      id: 'system-requalify',
      name: 'CaratSense (automatic)',
      email: 'system@caratsense.local',
      role: Role.head_office,
      organisationId,
      storeIds: convo.storeId ? [convo.storeId] : [],
      allStores: false,
    };

    const result = await this.qualification.assessConversation(actor, conversationId);
    return { conversationId, assessed: true, score: (result as { score?: number } | null)?.score ?? null };
  }

  /** `crmRequalifyDebounceSeconds`, clamped to something sane. */
  private async debounceFor(organisationId: string): Promise<number> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { settings: true },
    });
    const raw = Number((org?.settings as Record<string, unknown> | null)?.crmRequalifyDebounceSeconds);
    if (!Number.isFinite(raw)) return RequalificationService.DEFAULT_DEBOUNCE_SECONDS;
    return Math.min(Math.max(Math.round(raw), 0), 3600);
  }
}
