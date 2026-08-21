import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { WhatsAppConversationService } from './whatsapp-conversation.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

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
    private readonly prisma: PrismaService,
    private readonly wa: WhatsAppService,
    private readonly identity: WhatsAppIdentityService,
    private readonly conversation: WhatsAppConversationService,
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

        for (const m of value.messages ?? []) {
          const stored = await this.persist(m);
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
  private async persist(message: any): Promise<boolean> {
    try {
      await this.prisma.whatsAppEvent.create({
        data: {
          wamid: message?.id ?? null,
          direction: 'inbound',
          phoneE164: String(message?.from ?? ''),
          messageType: String(message?.type ?? 'text'),
          body: message?.text?.body ?? null,
          payload: message as Prisma.InputJsonValue,
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
    phoneE164: string;
    body: string | null;
    messageType: string;
  }): Promise<{ status: 'processed' | 'ignored'; userId?: string }> {
    const from = event.phoneE164;
    const text = event.body;
    if (!from) return { status: 'ignored' };

    const user = await this.identity.resolveActiveUser(from);

    if (user) {
      if (!text) {
        // Media, location, stickers — nothing to read yet.
        await this.wa.sendText(from, 'I can only read text messages right now. Say *hi* for the menu.');
        return { status: 'processed', userId: user.id };
      }
      const reply = await this.conversation.handle(from, user, text);
      await this.wa.sendText(from, reply);
      return { status: 'processed', userId: user.id };
    }

    // Unknown number: only a code-shaped message is treated as a link attempt, so
    // a wrong number never gets an unsolicited reply.
    if (text && CODE_RE.test(text.trim())) {
      const res = await this.identity.completeLinking(from, text);
      if (res.ok) {
        await this.wa.sendText(
          from,
          res.alreadyLinked
            ? `You're already linked as ${res.userName}. ✅`
            : `✅ Linked as ${res.userName}. You can now send your daily updates here.`,
        );
        return { status: 'processed', userId: res.userId };
      }
      await this.wa.sendText(
        from,
        res.reason === 'phone_taken'
          ? 'This number is already linked to another account. Contact your manager.'
          : "That code didn't work or has expired. Start again from CaratSense → Settings.",
      );
      return { status: 'processed' };
    }

    this.logger.log(`inbound from unrecognised ${from}: ignored`);
    return { status: 'ignored' };
  }
}
