import { Injectable, Logger } from '@nestjs/common';
import { WhatsAppService } from '../integrations/whatsapp.service';
import { WhatsAppIdentityService } from './whatsapp-identity.service';

/** A code-shaped token: 6–10 chars of the link-code alphabet. */
const CODE_RE = /^[A-Z0-9]{6,10}$/i;

/**
 * Inbound router for the internal reporting bot.
 *
 * Phase 1 handles ONE thing: completing a number-link when an unrecognised sender
 * messages a code. Everything else is logged and ignored for now — the DSR and
 * store->HO message flows (and the persist-then-200 event store) land in later
 * phases, which extend `route()` without changing this seam.
 */
@Injectable()
export class WhatsAppBotService {
  private readonly logger = new Logger(WhatsAppBotService.name);

  constructor(
    private readonly wa: WhatsAppService,
    private readonly identity: WhatsAppIdentityService,
  ) {}

  /** Flatten a Meta webhook payload and route each inbound message. */
  async handleInboundPayload(payload: any): Promise<{ messages: number; statuses: number }> {
    let messages = 0;
    let statuses = 0;
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        for (const m of value.messages ?? []) {
          messages++;
          await this.route(m).catch((err) =>
            this.logger.error(`inbound route failed: ${(err as Error)?.message ?? err}`),
          );
        }
        statuses += (value.statuses ?? []).length;
      }
    }
    return { messages, statuses };
  }

  private async route(message: any): Promise<void> {
    const from: string = message?.from;
    const text: string | undefined = message?.text?.body;
    if (!from) return;

    const user = await this.identity.resolveActiveUser(from);

    if (user) {
      // Known sender. Conversation/DSR handling arrives in Phase 3; for now, ack
      // so the number is not left wondering.
      this.logger.log(`inbound from ${user.name} (${from}): ${text ?? `[${message.type}]`}`);
      return;
    }

    // Unknown number. Only a code-shaped message is treated as a link attempt —
    // random text is ignored so we never spam a wrong-number sender.
    if (text && CODE_RE.test(text.trim())) {
      const res = await this.identity.completeLinking(from, text);
      if (res.ok) {
        await this.wa.sendText(
          from,
          res.alreadyLinked
            ? `You're already linked as ${res.userName}. ✅`
            : `✅ Linked as ${res.userName}. You can now send your daily updates here.`,
        );
      } else if (res.reason === 'phone_taken') {
        await this.wa.sendText(from, 'This number is already linked to another account. Contact your manager.');
      } else {
        await this.wa.sendText(from, "That code didn't work or has expired. Start again from CaratSense → Settings.");
      }
      return;
    }

    this.logger.log(`inbound from unrecognised ${from}: ignored`);
  }
}
