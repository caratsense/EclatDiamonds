import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  WhatsAppCredentialsService,
  type SenderRoute,
} from '../integrations/whatsapp-credentials.service';
import { WhatsAppService, type WhatsAppSendResult } from '../integrations/whatsapp.service';
import { WhatsAppConversationService } from './whatsapp-conversation.service';
import { ConversationsService } from '../crm/conversations.service';
import { IdentityService } from '../crm/identity.service';
import { QualificationService } from '../crm/qualification.service';
import { StorageService } from '../storage/storage.service';
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
    private readonly qualification: QualificationService,
    private readonly storage: StorageService,
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

      /*
       * A photo, voice note or document arrives with NO text, and everything
       * downstream reads `body`. Filed as-is it becomes an empty row: the CRM
       * shows a blank bubble and the manager cannot tell that anything was
       * sent, let alone what.
       *
       * The caption is used when there is one, and a plain label otherwise, so
       * the thread reads honestly. The media ITSELF is still not downloaded —
       * that needs a second authenticated call to Meta per attachment, and
       * saying so in the body is better than a bubble that silently implies
       * the picture is somewhere in the CRM when it is not.
       */
      const mediaLabel = describeMedia(event.messageType, event.payload);
      const filedBody = text ?? mediaLabel;

      /*
       * Fetch the attachment itself, before the message is filed, so the row
       * lands complete rather than being written twice.
       *
       * Stored through `savePrivate`: a customer's photograph is their content,
       * usually a ring they own or a screenshot of a design, and it belongs
       * behind the same authenticated read as attendance faces and counter
       * photos rather than on a public URL that anyone holding the link can
       * open. A failure here is deliberately not fatal — the message is still
       * filed, labelled, and answered.
       */
      const stored = mediaLabel
        ? await this.storeInboundMedia(organisationId, event.messageType, event.payload, replyRoute)
        : null;
      try {
        const result = await this.crmConversations.ingestInbound({
          optOut,
          organisationId,
          channel: 'whatsapp',
          externalThreadId: from,
          externalId: event.wamid ?? undefined,
          senderKind: 'whatsapp',
          senderValue: from,
          body: filedBody ?? undefined,
          mediaUrl: stored?.key,
          mediaType: stored?.mimeType,
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
         * The bot answers anyone who wrote to the business and whose thread no
         * person has taken: an ad click, a conversation already mid-way through,
         * or an organic first contact from the website, Google, a QR code or a
         * saved contact.
         *
         * The rule above — a wrong number never gets an unsolicited reply — is
         * not weakened by that. An unsolicited message is one WE start. Replying
         * to someone who messaged first is the 24-hour customer-care window
         * working as designed: free-form, no template, no review.
         *
         * A thread a human has taken over is silent from the bot's side
         * forever after. `handling === 'human'` is the whole check: once a
         * person owns a conversation, a bot talking over them is worse than a
         * bot that never spoke.
         */
        if (!result.duplicate) {
          const eligible = await this.claimBotTurn(organisationId, result.conversationId, from, event.payload);
          if (eligible) {
            /*
             * A PHOTO IS NOT AN UNREADABLE ANSWER.
             *
             * The bot's own closing line invites one — "Send me a photo of any
             * design you like and I can get you a price" — and a customer who
             * did exactly that got silence, because a media message carries no
             * text, so it was read as a failed answer to whatever question was
             * pending. The business asked for something and then ignored it.
             *
             * Nothing here can price a photograph, so it goes straight to a
             * person with the thread attached. That is the promise kept: the
             * price comes from someone who can actually give one.
             */
            if (!text && mediaLabel) {
              await this.handMediaToAPerson(
                organisationId,
                result.conversationId,
                from,
                mediaLabel,
                replyRoute,
              );
              return { status: 'processed', organisationId };
            }

            const reply = await this.customerBot.handle(
              from,
              organisationId,
              text ?? '',
              {},
              undefined,
            );
            if (reply.text) {
              const sent = await this.wa.sendText(organisationId, from, reply.text, replyRoute);
              await this.recordBotReply(organisationId, result.conversationId, reply.text, sent);
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

            /*
             * INTENT SCORE.
             *
             * Runs after the reply has gone, never before: scoring must not
             * delay the customer's answer, and a scoring failure must not cost
             * them one. Skipped once the flow has already ended in a handoff,
             * because the thread is on its way to a person either way and a
             * second reason would only overwrite the first.
             *
             * The bot does NOT announce the score or change what it says. A
             * high score moves the thread to a person while the customer is
             * still typing, which is the whole point — until now
             * `handoffAtScore` was configurable, documented, and read by
             * nothing.
             */
            if (!reply.outcome) {
              const scored = await this.qualification.assessFromBot(
                organisationId,
                result.conversationId,
              );
              if (scored?.handoff) {
                await this.prisma.conversation.update({
                  where: { id: result.conversationId },
                  data: {
                    handling: 'human',
                    handoffReason:
                      scored.reason ??
                      `Qualified at ${scored.score}/100${scored.band ? ` (${scored.band})` : ''} — handed to a person.`,
                  },
                });
                this.logger.log(
                  `  intent handoff on ${result.conversationId}: score ${scored.score}${scored.band ? ` (${scored.band})` : ''}`,
                );
              } else if (scored?.score != null) {
                this.logger.log(`  intent score ${scored.score}${scored.band ? ` (${scored.band})` : ''}`);
              }
            }

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
  /**
   * Put the bot's reply in the thread it belongs to.
   *
   * Without this the CRM shows a conversation in which the customer answers
   * questions nobody can see being asked — the screen renders one half of a
   * dialogue, and a manager taking over a handoff cannot tell what was already
   * promised or which options the customer was offered.
   *
   * The status comes from the send RESULT rather than being assumed. A message
   * filed as sent when the provider refused it is a lie the screen then tells a
   * salesperson, who reads the thread, believes the customer has the message and
   * waits for a reply that was never going to come. `dryRun` counts as not sent:
   * that is exactly the state staging was in, where the bot was working
   * perfectly and nothing reached the handset.
   */
  /**
   * A customer sent something the bot cannot read. Fetch a person.
   *
   * Deliberately NOT a reprompt. The reprompt exists for an unreadable ANSWER
   * to a question the bot asked; a photograph is a different act, usually a
   * ring the customer wants priced, and asking them to "reply with a number"
   * reads as a machine that did not look at what they sent.
   */
  /**
   * Download an inbound attachment and keep it where only this tenant can read it.
   *
   * Returns the private storage KEY, not a URL. The key is meaningless to a
   * browser on purpose: the CRM reads it back through an authenticated route
   * that re-checks who is asking, so a photograph cannot leak by someone
   * pasting a link into a group chat.
   */
  private async storeInboundMedia(
    organisationId: string,
    messageType: string,
    payload: unknown,
    route: SenderRoute | undefined,
  ): Promise<{ key: string; mimeType: string } | null> {
    const msg = (payload ?? {}) as Record<string, unknown>;
    const media = (msg[messageType] ?? {}) as Record<string, unknown>;
    const mediaId = typeof media.id === 'string' ? media.id : null;
    if (!mediaId) return null;

    const fetched = await this.wa.fetchInboundMedia(organisationId, mediaId, route);
    if (!fetched) return null;

    try {
      const key = await this.storage.savePrivate(
        organisationId,
        'messages',
        // The provider's media id is already unique and carries no customer
        // data; the extension is derived from the mime type rather than from
        // anything the sender controls.
        `${mediaId}${extensionFor(fetched.mimeType)}`,
        fetched.buffer,
      );
      this.logger.log(`  stored inbound ${messageType} (${fetched.buffer.byteLength} bytes)`);
      return { key, mimeType: fetched.mimeType };
    } catch (err) {
      this.logger.warn(
        `  inbound ${messageType} could not be stored: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  private async handMediaToAPerson(
    organisationId: string,
    conversationId: string,
    to: string,
    mediaLabel: string,
    replyRoute: SenderRoute | undefined,
  ): Promise<void> {
    const body = [
      'Thank you — I have that.',
      '',
      'One of our team will take a look and come back to you shortly with details and pricing. 💎',
    ].join('\n');

    const sent = await this.wa.sendText(organisationId, to, body, replyRoute);
    await this.recordBotReply(organisationId, conversationId, body, sent);

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        handling: 'human',
        handoffReason: `The customer sent ${mediaLabel.toLowerCase()} — it needs a person to look at it.`,
      },
    });
    this.logger.log(`  media handed to a person on ${conversationId}: ${mediaLabel}`);
  }

  private async recordBotReply(
    organisationId: string,
    conversationId: string,
    body: string,
    sent: WhatsAppSendResult,
  ): Promise<void> {
    try {
      await this.prisma.message.create({
        data: {
          organisationId,
          conversationId,
          direction: 'outbound',
          // Not 'ai': this flow is scripted copy the client approved, and
          // labelling it AI in front of every manager would be a small untruth
          // repeated on every thread. Not 'agent' either — no person wrote it.
          authorType: 'bot',
          body,
          // The provider's id, so a later status webhook can mark it delivered
          // or read against the row it belongs to.
          externalId: sent.messageId ?? null,
          status: sent.delivered ? 'sent' : 'failed',
          error: sent.delivered ? null : (sent.reason ?? sent.error ?? 'Not sent.'),
        },
      });
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      });
    } catch (err) {
      /*
       * The customer already HAS the message by this point. Throwing would fail
       * the webhook, Meta would redeliver it, and the bot would answer the same
       * question twice. A missing row in the CRM is the smaller harm, and it is
       * logged loudly enough to be noticed.
       */
      this.logger.warn(
        `  could not record bot reply on ${conversationId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * A new ad click is an OPENING, never an answer.
   *
   * The message that arrives with a referral is the customer's first words —
   * Meta's pre-fill when the ad carries one, and whatever they felt like typing
   * when it does not. Either way it is not a reply to a question, and parsing
   * it as one produces the worst possible first impression: somebody taps an
   * advert and the business answers "Sorry, I didn't quite catch that."
   *
   * That is exactly what happened on the first live click. An earlier session
   * had left a question pending, the opening line was read as an answer to it,
   * found unreadable, and reprompted.
   *
   * So the bookkeeping is cleared and the ANSWERS are kept. Clearing the step
   * makes the bot greet and ask again; keeping the answers means a customer who
   * already said their budget last week is not asked a second time, which is the
   * same courtesy the lead-form skip exists for.
   */
  private async reopenForFreshClick(phoneE164: string): Promise<void> {
    const session = await this.prisma.whatsAppSession.findUnique({
      where: { phoneE164 },
      select: { draft: true },
    });
    if (!session) return;
    const draft = (session.draft ?? {}) as Record<string, unknown>;
    const answersOnly: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (!k.startsWith('_')) answersOnly[k] = v;
    }
    await this.prisma.whatsAppSession
      .update({
        where: { phoneE164 },
        data: { draft: answersOnly as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
  }

  private async claimBotTurn(
    organisationId: string,
    conversationId: string,
    phoneE164: string,
    payload: unknown,
  ): Promise<boolean> {
    const convo = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organisationId },
      select: { handling: true, assignedUserId: true },
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

    /*
     * A NEW ad click is fresh intent even on a thread that finished the script
     * weeks ago, so the completion marker is dropped and the questions start
     * again rather than the customer getting an acknowledgement.
     *
     * A HALF-ANSWERED flow is deliberately left alone. The click arrives
     * carrying the customer's own first message, and throwing away four answers
     * in order to ask for them a second time is exactly what this gate exists
     * to prevent.
     */
    if (freshReferral) {
      await this.reopenForFreshClick(phoneE164);
      return true;
    }

    /*
     * Everyone else whose thread no person owns: ad-originated threads, replies
     * mid-flow, and — since 2026-09-20 — ORGANIC first contacts.
     *
     * Organic traffic previously returned false here and the customer got
     * silence until somebody happened to open the inbox. That is most of the
     * traffic rather than an edge case: the website, Google Business Profile,
     * QR codes and printed material all arrive with no referral, and the lead
     * forms on roughly two thirds of the live campaigns carry no WhatsApp
     * option at all.
     *
     * WHAT to say is `CustomerBotService`'s decision, not this gate's: the
     * script for a new enquiry, a short acknowledgement for someone who has
     * already been through it.
     */
    return true;
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

/** A file extension from the provider's mime type, never from a sender-supplied name. */
function extensionFor(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return (
    {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/webp': '.webp',
      'audio/ogg': '.ogg',
      'audio/mpeg': '.mp3',
      'audio/mp4': '.m4a',
      'video/mp4': '.mp4',
      'application/pdf': '.pdf',
    }[base] ?? '.bin'
  );
}

function describeMedia(messageType: string, payload: unknown): string | null {
  const msg = (payload ?? {}) as Record<string, unknown>;
  const media = (msg[messageType] ?? {}) as Record<string, unknown>;
  const caption = typeof media.caption === 'string' ? media.caption.trim() : '';
  const label = ({ image: 'a photo', video: 'a video', audio: 'a voice note', document: 'a document', sticker: 'a sticker', location: 'a location', contacts: 'a contact' } as Record<string,string>)[messageType] ?? null;
  if (!label) return null;
  return caption ? `[${label}] ${caption}` : `[${label}]`;
}
