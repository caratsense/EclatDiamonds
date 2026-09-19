import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppCredentialsService } from '../integrations/whatsapp-credentials.service';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { WhatsAppConversationService } from './whatsapp-conversation.service';
import { ConversationsService } from '../crm/conversations.service';
import { IdentityService } from '../crm/identity.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';
import { CustomerBotService } from './customer-bot.service';
import { extractMetaReferral } from '../integrations/meta-referral';
import { ConversationAiGate } from '../crm/ai-responder';
import { OmnichannelService } from '../omnichannel/omnichannel.service';
import { isUnambiguousOptOut } from '../omnichannel/omnichannel-policy';

/** A code-shaped token: 6–10 chars of the link-code alphabet. */
const CODE_RE = /^[A-Z0-9]{6,10}$/i;

/** Give up on an event after this many failed processing attempts. */
const MAX_ATTEMPTS = 3;

/** Don't re-sweep events older than this — they are stale, not pending. */
const SWEEP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Inbound pipeline for the internal reporting bot.
 *
 * ## Why messages are stored before they are handled
 *
 * Meta wants a 200 within seconds and retries for up to ~7 days when it does not
 * get one. Handling a message inline means a slow reply turns into a redelivery,
 * and a redelivery of a daily report would be a second DailyReport row — silently
 * doubling every roll-up that reads it. So the webhook writes each message to
 * `WhatsAppEvent` (unique on Meta's `wamid`) and acknowledges; a retry of the same
 * message collides on that index and is dropped.
 *
 * Processing then starts immediately in the background rather than waiting for the
 * next sweep: this is a conversation, and a bot that answers "how many walk-ins?"
 * half a minute later is not usable. The sweep exists for what the immediate pass
 * misses — a crash mid-process, or a transient failure worth retrying.
 */
@Injectable()
export class WhatsAppBotService {
  private readonly logger = new Logger(WhatsAppBotService.name);

  constructor(
    private readonly aiGate: ConversationAiGate,
    private readonly prisma: PrismaService,
    private readonly wa: WhatsAppService,
    private readonly identity: WhatsAppIdentityService,
    private readonly customerBot: CustomerBotService,
    private readonly conversation: WhatsAppConversationService,
    private readonly crmConversations: ConversationsService,
    private readonly credentials: WhatsAppCredentialsService,
    private readonly omnichannel: OmnichannelService,
    private readonly crmIdentity: IdentityService,
  ) {}

  /**
   * Webhook entry point. Persists every inbound message, then returns — the caller
   * responds to Meta straight away while processing continues in the background.
   */
  async ingest(payload: any): Promise<{ received: number; duplicates: number; statuses: number }> {
    let received = 0;
    let duplicates = 0;
    let statuses = 0;

    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        statuses += (value.statuses ?? []).length;

        // The business phone number the message was sent TO. This is the tenant
        // routing key: with one WhatsApp number per organisation, it is the only
        // trustworthy way to say which tenant an inbound message belongs to.
        // Taken from the provider's own metadata, never from the sender.
        const businessPhoneNumberId: string | null =
          value?.metadata?.phone_number_id != null
            ? String(value.metadata.phone_number_id)
            : null;

        for (const m of value.messages ?? []) {
          const stored = await this.persist(m, businessPhoneNumberId);
          if (stored) received++;
          else duplicates++;
        }
      }
    }

    if (received > 0) {
      // Deliberately not awaited: the HTTP response must not wait on replies.
      void this.processPending().catch((err) =>
        this.logger.error(`processPending failed: ${(err as Error)?.message ?? err}`),
      );
    }
    return { received, duplicates, statuses };
  }

  /** Store one message. Returns false when Meta has already delivered it. */
  private async persist(message: any, businessPhoneNumberId: string | null): Promise<boolean> {
    try {
      await this.prisma.whatsAppEvent.create({
        data: {
          wamid: message?.id ?? null,
          direction: 'inbound',
          phoneE164: String(message?.from ?? ''),
          messageType: String(message?.type ?? 'text'),
          body: message?.text?.body ?? null,
          // The raw provider message, plus the routing key under a namespaced
          // key so it survives to processing time (which happens later, from the
          // database, after this request has already returned 200 to Meta).
          // Kept in the JSON rather than a new column: it is provider-shaped
          // routing metadata, not a field the app queries.
          payload: { ...(message ?? {}), caratosMeta: { businessPhoneNumberId } } as Prisma.InputJsonValue,
        },
      });
      return true;
    } catch (err) {
      // P2002 on wamid = Meta redelivered a message we already have. Expected.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return false;
      }
      throw err;
    }
  }

  /**
   * Handle everything still waiting. Each event is claimed with a conditional
   * update, so an overlapping sweep or a second replica cannot process one twice.
   */
  async processPending(): Promise<{ processed: number; failed: number }> {
    const pending = await this.prisma.whatsAppEvent.findMany({
      where: {
        status: 'received',
        attempts: { lt: MAX_ATTEMPTS },
        createdAt: { gt: new Date(Date.now() - SWEEP_WINDOW_MS) },
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });

    let processed = 0;
    let failed = 0;

    for (const event of pending) {
      // Claim: only the caller whose update matches `status: 'received'` proceeds.
      const claimed = await this.prisma.whatsAppEvent.updateMany({
        where: { id: event.id, status: 'received' },
        data: { status: 'processing', attempts: { increment: 1 } },
      });
      if (claimed.count === 0) continue;

      try {
        const outcome = await this.route(event);
        await this.prisma.whatsAppEvent.update({
          where: { id: event.id },
          data: {
            status: outcome.status,
            userId: outcome.userId ?? null,
            // Attribute the event to the sender's tenant once known. Stays null
            // for messages from unknown/unlinked numbers — never guessed.
            organisationId: outcome.organisationId ?? null,
            processedAt: new Date(),
            error: null,
          },
        });
        processed++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = event.attempts + 1;
        await this.prisma.whatsAppEvent.update({
          where: { id: event.id },
          data: {
            // Back to `received` so the sweep retries, until the cap is reached.
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'received',
            error: message.slice(0, 500),
          },
        });
        this.logger.error(`event ${event.id} failed (attempt ${attempts}): ${message}`);
        failed++;
      }
    }

    return { processed, failed };
  }

  /**
   * Decide what one message means.
   *
   * Phase 2 knows two outcomes: complete a pending number-link, or ignore. The DSR
   * conversation and store->HO messages extend this in Phase 3.
   */
  private async route(event: {
    id?: string;
    wamid?: string | null;
    phoneE164: string;
    body: string | null;
    messageType: string;
    payload?: unknown;
    createdAt?: Date;
  }): Promise<{ status: 'processed' | 'ignored'; userId?: string; organisationId?: string | null }> {
    const from = event.phoneE164;
    const text = event.body;
    if (!from) return { status: 'ignored' };

    // Which business was messaged? Resolved from the WhatsApp number the message
    // ARRIVED ON, before anything is sent — a reply has to leave on the same
    // number the customer wrote to, and with per-tenant credentials there is no
    // longer a single process-wide sender to fall back on.
    const inbound = await this.resolveTenantForInbound(event.payload);
    const inboundOrgId = inbound?.organisationId ?? null;
    /*
     * Every reply below carries this. A staff member who wrote to the Surat line
     * is answered from the Surat line: without it, `senderFor` sees eight numbers
     * and no route and refuses to send at all — which is the correct refusal, but
     * the inbound number is right here and is the best answer there is.
     */
    const replyRoute = inbound
      ? { assetId: inbound.assetId, storeId: inbound.storeId }
      : undefined;

    const user = await this.identity.resolveActiveUser(from);

    if (user) {
      if (!text) {
        // Media, location, stickers — nothing to read yet.
        await this.wa.sendText(
          user.organisationId,
          from,
          'I can only read text messages right now. Say *hi* for the menu.',
          replyRoute,
        );
        return { status: 'processed', userId: user.id, organisationId: user.organisationId };
      }
      const reply = await this.conversation.handle(from, user, text);
      await this.wa.sendText(user.organisationId, from, reply, replyRoute);
      return { status: 'processed', userId: user.id, organisationId: user.organisationId };
    }

    // Unknown number: only a code-shaped message is treated as a link attempt, so
    // a wrong number never gets an unsolicited reply.
    if (text && CODE_RE.test(text.trim())) {
      const res = await this.identity.completeLinking(from, text);
      if (res.ok) {
        await this.wa.sendText(
          // The newly linked staff member's own tenant; falls back to the number
          // that was messaged when linking failed to identify one.
          res.organisationId ?? inboundOrgId ?? '',
          // '' resolves to no usable sender, so the send becomes a logged
          // no-op rather than going out as the wrong business. Reaching here
          // with neither id means linking succeeded without an organisation,
          // which should not happen — and if it does, silence is the safe
          // outcome.
          from,
          res.alreadyLinked
            ? `You're already linked as ${res.userName}. ✅`
            : `✅ Linked as ${res.userName}. You can now send your daily updates here.`,
          replyRoute,
        );
        return { status: 'processed', userId: res.userId, organisationId: res.organisationId };
      }
      // No reply when we cannot tell which business was messaged: there is no
      // number to send it from, and guessing one would message a stranger as
      // some other tenant's business.
      if (inboundOrgId) {
        await this.wa.sendText(
          inboundOrgId,
          from,
          res.reason === 'phone_taken'
            ? 'This number is already linked to another account. Contact your manager.'
            : "That code didn't work or has expired. Start again from CaratSense → Settings.",
          replyRoute,
        );
      }
      return { status: 'processed' };
    }

    // Not a staff member and not a link code — so this is very probably a
    // CUSTOMER writing to the business. Until now that message was logged and
    // dropped on the floor.
    //
    // It becomes a CRM conversation, but ONLY when the tenant can be established
    // from the business number it was addressed to. There is deliberately no
    // "if there is only one organisation, use it" fallback: guessing a tenant for
    // inbound customer data is exactly the mistake that makes a second tenant
    // unsafe, and a message parked unattributed can still be recovered later
    // whereas one filed against the wrong business cannot.
    const organisationId = inboundOrgId;
    if (organisationId) {
      // Decided from the text alone, before anything is filed, so the same
      // verdict governs both the CRM write and the assistant below.
      const optOut = isUnambiguousOptOut(text);
      try {
        const result = await this.crmConversations.ingestInbound({
          optOut,
          organisationId,
          channel: 'whatsapp',
          externalThreadId: from,
          externalId: event.wamid ?? undefined,
          senderKind: 'whatsapp',
          senderValue: from,
          body: text ?? undefined,
          sentAt: event.createdAt,
          payload: event.payload as never,
          // The number this arrived on, so every reply leaves from it.
          senderAssetId: inbound?.assetId ?? null,
          // The branch that number answers for. Only when unambiguous: a line
          // shared by three shops cannot say which one an enquiry belongs to.
          storeId: inbound?.storeId ?? null,
          // The Click-to-WhatsApp referral, read from the raw provider message
          // that `persist()` has been storing all along. Only the first message
          // of an ad-originated thread carries one; null everywhere else, and a
          // null is NOT evidence of organic traffic.
          adReferral: extractMetaReferral(event.payload),
        });
        // NO automatic reply. The existing rule that a wrong number never gets an
        // unsolicited message holds for customers too — a person answers from the
        // inbox, which is also what keeps this inside WhatsApp's messaging policy.
        this.logger.log(
          `inbound from ${from}: filed as customer conversation ${result.conversationId}` +
            (result.unidentifiedSender ? ' (sender not yet linked to a customer)' : '') +
            (result.routing ? ` [rule "${result.routing.ruleName}" -> ${result.routing.handling}]` : '') +
            (result.leadId ? ` [lead ${result.leadId}]` : ''),
        );

        /*
         * A withdrawal of consent is persisted BEFORE anything acts on the
         * message, and it ends the processing of that message.
         *
         * Ordering is the whole point. `ingestInbound` above only files the
         * message and resolves the party — it sends nothing, and it skipped
         * re-qualification because `optOut` was passed in. So this is the first
         * moment a partyId exists, and the last moment before the assistant is
         * asked to speak. Recording the revocation here means any later send,
         * from any path, meets a `consent.revoked` event at the delivery policy.
         *
         * `recordProviderOptOut` is idempotent on the provider event id, so a
         * webhook replay writes one revocation, not several.
         */
        if (optOut && !result.duplicate) {
          /*
           * An opt-out from a number we have never seen still has to stick.
           *
           * Consent is recorded against a Party, and an inbound message from an
           * unknown sender does not necessarily create one — so without this the
           * very first thing a stranger says, "STOP", would be the one message we
           * failed to honour. `resolveInbound` is the same resolve-or-create
           * contract the CRM uses for any inbound identity; it creates no more
           * than their next message would have.
           */
          const partyId =
            result.partyId ??
            (
              await this.crmIdentity.resolveInbound(organisationId, {
                kind: 'phone',
                value: from,
                source: 'whatsapp_opt_out',
              })
            ).partyId;
          if (!partyId) {
            // An unusable sender identity. Nothing to attach consent to, and
            // inventing one would be worse than a loud log line.
            this.logger.warn('  opt-out could not be recorded: sender identity unusable');
            return { status: 'processed', organisationId };
          }
          await this.omnichannel.recordProviderOptOut({
            organisationId,
            partyId,
            channel: 'whatsapp',
            providerEventId: event.wamid ?? `${from}:${event.createdAt?.toISOString() ?? ''}`,
            occurredAt: event.createdAt,
          });
          // No phone number and no message body in the log line.
          this.logger.log(`  opt-out recorded for party ${partyId}; assistant skipped`);
          return { status: 'processed', organisationId };
        }

        /*
         * THE QUALIFICATION BOT.
         *
         * The rule above — a wrong number never gets an unsolicited reply — is
         * kept, not weakened. The bot answers only someone who demonstrably
         * started this: a click-to-WhatsApp ad (the referral is provider-proven
         * consent to be answered) or a conversation it is already mid-way
         * through. Everything else still reaches a person via the inbox and
         * hears nothing from us.
         *
         * A thread a human has taken over is silent from the bot's side
         * forever after. `handling === 'human'` is the whole check: once a
         * person owns a conversation, a bot talking over them is worse than a
         * bot that never spoke.
         */
        if (!result.duplicate) {
          const eligible = await this.claimBotTurn(organisationId, result.conversationId, from, event.payload);
          if (eligible) {
            const reply = await this.customerBot.handle(
              from,
              organisationId,
              text ?? '',
              {},
              undefined,
            );
            if (reply.text) {
              await this.wa.sendText(organisationId, from, reply.text, replyRoute);
            }
            if (reply.outcome?.kind === 'handoff') {
              /*
               * Handed to a person, and the thread STAYS on this number. The
               * branch manager answers from the CRM inbox; the customer sees
               * the same chat they have been in all along. Assignment itself is
               * left to the queue rather than picked here — this service knows
               * the conversation, not who is on shift.
               */
              await this.prisma.conversation.update({
                where: { id: result.conversationId },
                data: {
                  handling: 'human',
                  handoffReason:
                    reply.outcome.reason === 'gave_up'
                      ? 'The customer could not be understood twice; handed to a person.'
                      : 'The customer asked to speak to someone.',
                },
              });
              if (reply.handoffNote) {
                this.logger.log('  bot handoff logged for conversation ' + result.conversationId);
              }
            }
            this.logger.log(
              `  bot replied${reply.outcome ? ` (${reply.outcome.kind}: ${reply.outcome.reason})` : ''}`,
            );
            return { status: 'processed', organisationId };
          }
        }

        // Whether the assistant may speak is decided in ONE place, and it is not
        // here. The gate enforces human-only and unassigned threads, the tenant
        // switch (off by default) and provider availability; this call site only
        // asks. Nothing it produces is delivered — a draft is stored for review.
        if (!result.duplicate) {
          const decision = await this.aiGate.consider({
            organisationId,
            conversationId: result.conversationId,
            inboundText: text ?? null,
            channel: 'whatsapp',
          });
          this.logger.log(`  ai gate: ${decision.outcome} — ${decision.reason}`);
        }
        return { status: 'processed', organisationId };
      } catch (err) {
        // A CRM failure must not consume the message: throwing here returns it to
        // the sweep, which retries it up to the attempt cap.
        this.logger.error(
          `inbound from ${from}: could not file as a conversation — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw err;
      }
    }

    this.logger.log(
      `inbound from unrecognised ${from}: ignored (no organisation owns the business number it was sent to)`,
    );
    return { status: 'ignored' };
  }

  /**
   * May the qualification bot answer this message?
   *
   * Three gates, and all of them have to pass. The default is silence, because
   * the cost of a bot messaging a wrong number is a complaint against the
   * client's number, and the cost of staying quiet is a message a person reads
   * in the inbox a few minutes later.
   *
   *   1. A human has not taken the thread over. Once `handling` is 'human',
   *      the bot is finished with that conversation permanently.
   *   2. EITHER the thread began with a click-to-WhatsApp ad — the referral is
   *      the provider's own evidence that this person chose to start it —
   *   3. OR the bot is already mid-conversation with them, in which case they
   *      have answered at least one question and are plainly expecting a reply.
   *
   * A stranger who texts the shop out of the blue matches none of these and
   * hears nothing, which is the behaviour this service already guaranteed.
   */
  private async claimBotTurn(
    organisationId: string,
    conversationId: string,
    phoneE164: string,
    payload: unknown,
  ): Promise<boolean> {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organisationId },
      select: { handling: true, sourceAdId: true, assignedUserId: true },
    });
    if (!convo) return false;

    const freshReferral = Boolean(extractMetaReferral(payload));

    if (convo.handling === 'human') {
      /*
       * A thread reaches 'human' two very different ways, and they deserve
       * opposite answers.
       *
       * A PERSON OWNS IT (`assignedUserId` set): the bot never speaks again,
       * whatever arrives. Someone is mid-conversation with this customer and a
       * bot talking over them is precisely what the wrong-number rule exists to
       * prevent.
       *
       * THE BOT GAVE UP AND NOBODY PICKED IT UP (no assignee): a NEW ad click is
       * fresh intent, weeks or months later, and refusing it forever means one
       * bad exchange disqualifies a customer for the life of the account. The
       * referral is the provider's evidence that they chose to start again, so
       * the thread reopens and the flow restarts from the first question.
       */
      if (!freshReferral || convo.assignedUserId) return false;

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { handling: 'unassigned', handoffReason: null },
      });
      // The old half-finished answers belong to the previous enquiry. Keeping
      // them would skip questions this customer never answered about this ad.
      await this.prisma.whatsAppSession
        .delete({ where: { phoneE164 } })
        .catch(() => undefined);
      this.logger.log(`  bot turn reclaimed on ${conversationId}: new ad click on a thread nobody had taken`);
      return true;
    }

    // Ad-originated: either this very message carried a referral, or the thread
    // was stamped with one when it started.
    if (convo.sourceAdId) return true;
    if (freshReferral) return true;

    // Mid-conversation: a session exists only because the bot asked something
    // and is waiting for the answer.
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { phoneE164 },
      select: { flow: true, expiresAt: true },
    });
    return Boolean(session && session.flow === 'customer' && session.expiresAt > new Date());
  }

  /**
   * Which tenant owns the WhatsApp number this message was sent to?
   *
   * DELEGATED, not re-implemented. `WhatsAppCredentialsService` already answers
   * this for the outbound side, and two copies of a tenant-routing rule is two
   * chances for inbound and outbound to disagree about who a number belongs to.
   *
   * Still returns null rather than guessing: an inbound message that cannot be
   * attributed stays unattributed. Filing a stranger's message into whichever
   * organisation happens to be first would put one business's customer
   * conversation in another business's inbox.
   */
  private async resolveTenantForInbound(payload: unknown): Promise<{
    organisationId: string;
    /** The number it arrived on, so the reply leaves from the same one. */
    assetId: string | null;
    /** The branch that number answers for, when exactly one does. */
    storeId: string | null;
  } | null> {
    const meta = (payload as { caratosMeta?: { businessPhoneNumberId?: string | null } } | null)
      ?.caratosMeta;
    const phoneNumberId = meta?.businessPhoneNumberId;
    if (!phoneNumberId) return null;
    const owner = await this.credentials.organisationForPhoneNumberId(phoneNumberId);
    if (!owner) return null;
    return {
      organisationId: owner.organisationId,
      assetId: owner.assetId,
      storeId: owner.storeId,
    };
  }
}
