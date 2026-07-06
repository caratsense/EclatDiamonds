import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { fetchJson, safeEqual } from './integrations.util';

export interface WhatsAppSendResult {
  /** Accepted by the WhatsApp Cloud API. */
  delivered: boolean;
  /** True when credentials are absent — the call was logged, not sent. */
  dryRun: boolean;
  to: string;
  messageId?: string;
  error?: string;
}

/**
 * WhatsApp Business Cloud API (Graph) client — quotes, DSR, reminders, payment
 * links (CLAUDE.md channels). Fully code-complete: the moment
 * WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID are set it goes live; until
 * then every send is a logged no-op (`dryRun`) so the rest of the app behaves
 * identically with or without credentials.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private readonly config: ConfigService) {}

  private get token(): string {
    return this.config.get<string>('WHATSAPP_ACCESS_TOKEN') ?? '';
  }
  private get phoneNumberId(): string {
    return this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID') ?? '';
  }
  private get appSecret(): string {
    return this.config.get<string>('WHATSAPP_APP_SECRET') ?? '';
  }
  private get apiVersion(): string {
    return this.config.get<string>('WHATSAPP_API_VERSION') ?? 'v21.0';
  }
  private get graphBase(): string {
    return this.config.get<string>('WHATSAPP_GRAPH_BASE') ?? 'https://graph.facebook.com';
  }

  /** True when the sender credentials are configured (otherwise dry-run). */
  get enabled(): boolean {
    return Boolean(this.token && this.phoneNumberId);
  }

  /** Normalise a phone number to WhatsApp's E.164-without-plus form (India default). */
  private normalise(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `91${digits}`; // bare 10-digit Indian mobile
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
  }

  /** Send a plain-text message (only allowed inside an open 24h conversation window). */
  async sendText(to: string, body: string): Promise<WhatsAppSendResult> {
    return this.send(to, { type: 'text', text: { preview_url: false, body } });
  }

  /** Send a pre-approved template message — the only way to *start* a conversation. */
  async sendTemplate(
    to: string,
    templateName: string,
    languageCode = 'en',
    components?: unknown[],
  ): Promise<WhatsAppSendResult> {
    return this.send(to, {
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components ? { components } : {}),
      },
    });
  }

  private async send(to: string, payload: Record<string, unknown>): Promise<WhatsAppSendResult> {
    const recipient = this.normalise(to);
    if (!this.enabled) {
      this.logger.log(`[dry-run] WhatsApp → ${recipient}: ${JSON.stringify(payload)}`);
      return { delivered: false, dryRun: true, to: recipient };
    }
    try {
      const res = await fetchJson(
        `${this.graphBase}/${this.apiVersion}/${this.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, ...payload }),
        },
      );
      const messageId = res?.messages?.[0]?.id as string | undefined;
      return { delivered: true, dryRun: false, to: recipient, messageId };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`WhatsApp send to ${recipient} failed: ${error}`);
      return { delivered: false, dryRun: false, to: recipient, error };
    }
  }

  /**
   * Meta webhook handshake (GET): echo `hub.challenge` iff `hub.verify_token`
   * matches WHATSAPP_WEBHOOK_VERIFY_TOKEN. Returns null when it doesn't match.
   */
  verifyWebhook(mode?: string, token?: string, challenge?: string): string | null {
    const expected = this.config.get<string>('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected && token === expected) return challenge ?? '';
    return null;
  }

  /**
   * Validate the X-Hub-Signature-256 header against the raw request body. When no
   * app secret is configured we log a warning and accept (dev convenience); set
   * WHATSAPP_APP_SECRET in production to enforce it.
   */
  verifySignature(rawBody: Buffer | undefined, signature?: string): boolean {
    if (!this.appSecret) {
      this.logger.warn('WHATSAPP_APP_SECRET not set — skipping inbound signature check.');
      return true;
    }
    if (!rawBody || !signature) return false;
    const expected = 'sha256=' + createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }

  /** Flatten an inbound webhook payload into message/status counts (and log each). */
  handleInbound(payload: any): { messages: number; statuses: number } {
    let messages = 0;
    let statuses = 0;
    for (const entry of payload?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        const value = change?.value ?? {};
        for (const m of value.messages ?? []) {
          messages++;
          this.logger.log(`WhatsApp inbound from ${m.from}: ${m.text?.body ?? `[${m.type}]`}`);
        }
        for (const s of value.statuses ?? []) {
          statuses++;
          this.logger.log(`WhatsApp delivery status ${s.status} for ${s.id}`);
        }
      }
    }
    return { messages, statuses };
  }
}
