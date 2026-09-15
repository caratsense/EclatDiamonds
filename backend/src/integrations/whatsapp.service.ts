import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { fetchJson, safeEqual } from './integrations.util';
import { SenderRoute, WhatsAppCredentialsService } from './whatsapp-credentials.service';

export interface WhatsAppSendResult {
  /** Accepted by the WhatsApp Cloud API. */
  delivered: boolean;
  /** True when credentials are absent — the call was logged, not sent. */
  dryRun: boolean;
  /** Why nothing was sent. Present whenever `dryRun` is true. */
  reason?: string;
  /** Whose number sent it: the tenant's own, or the platform's shared one. */
  credentialScope?: 'tenant' | 'platform_env' | 'none';
  to: string;
  messageId?: string;
  error?: string;
  /**
   * Which of the tenant's numbers carried it, when one did. Stored on the
   * conversation so every later reply leaves from the same number.
   */
  senderAssetId?: string | null;
  /** How that number was chosen: the thread's, the branch's, or the only one. */
  resolvedBy?: string | null;
}

/**
 * WhatsApp Business Cloud API (Graph) client — quotes, DSR, reminders, payment
 * links (CLAUDE.md channels).
 *
 * PER-TENANT AS OF PHASE A14. Every send now takes an `organisationId` and asks
 * WhatsAppCredentialsService whose number to send from. That parameter is not
 * decoration: without it this class read one process-wide token, so a second
 * tenant would have messaged their customers from another business's number.
 *
 * Credentials are never read from the environment here any more. The resolver
 * owns that decision, including the explicit platform-number binding, so there
 * is exactly one place that can answer "who is this being sent as".
 *
 * With no usable credential every send is a logged no-op carrying the REASON,
 * so the rest of the app behaves identically and the UI can say why.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly credentials: WhatsAppCredentialsService,
  ) {}

  private get appSecret(): string {
    return this.config.get<string>('WHATSAPP_APP_SECRET') ?? '';
  }
  private get apiVersion(): string {
    return this.config.get<string>('WHATSAPP_API_VERSION') ?? 'v21.0';
  }
  private get graphBase(): string {
    return this.config.get<string>('WHATSAPP_GRAPH_BASE') ?? 'https://graph.facebook.com';
  }

  /**
   * Can this organisation actually send?
   *
   * Takes an organisation because the answer differs per tenant — one may have
   * connected their number while another has not. The old parameterless
   * `enabled` could only ever describe the platform, which is exactly the
   * assumption being removed.
   */
  async enabledFor(organisationId: string): Promise<boolean> {
    return (await this.credentials.senderFor(organisationId)).usable;
  }

  /**
   * The numbers this environment is allowed to message, or null for "no limit".
   *
   * Read per call rather than cached at construction so the door can be closed
   * on a running staging service without a redeploy.
   */
  private recipientAllowlist(): Set<string> | null {
    const raw = (this.config.get<string>('MESSAGING_RECIPIENT_ALLOWLIST') ?? '').trim();
    if (!raw) return null;
    const numbers = raw
      .split(',')
      .map((entry) => this.normalise(entry))
      .filter((entry) => entry.length >= 6);
    // An allowlist that parsed to nothing is a configuration mistake, and the
    // safe reading of it is "nobody", never "everybody".
    return new Set(numbers);
  }

  /** Normalise a phone number to WhatsApp's E.164-without-plus form (India default). */
  private normalise(phone: string): string {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 10) return `91${digits}`; // bare 10-digit Indian mobile
    if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
    return digits;
  }

  /**
   * Send a plain-text message (only allowed inside an open 24h conversation window).
   *
   * `route` says WHICH of the tenant's numbers this leaves from. Optional so
   * every existing caller still compiles, and safe to omit only while a tenant
   * has one number — with several, an omitted route is refused rather than
   * guessed at. Callers that know the conversation pass its `senderAssetId`;
   * callers that know only the branch pass `storeId`.
   */
  async sendText(
    organisationId: string,
    to: string,
    body: string,
    route?: SenderRoute,
  ): Promise<WhatsAppSendResult> {
    return this.send(
      organisationId,
      to,
      { type: 'text', text: { preview_url: false, body } },
      route,
    );
  }

  /** Send a pre-approved template message — the only way to *start* a conversation. */
  async sendTemplate(
    organisationId: string,
    to: string,
    templateName: string,
    languageCode = 'en',
    components?: unknown[],
    route?: SenderRoute,
  ): Promise<WhatsAppSendResult> {
    return this.send(
      organisationId,
      to,
      {
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
          ...(components ? { components } : {}),
        },
      },
      route,
    );
  }

  /**
   * Send a document (a quote PDF) as a WhatsApp document message.
   *
   * The bytes are uploaded to the provider's own media store first and the
   * message refers to the returned media id. Nothing is handed to Meta as a
   * link, so no public or long-lived URL to the file ever has to exist.
   *
   * With a template, the document rides in the template's DOCUMENT header —
   * the only way a document can open a conversation outside the 24-hour
   * window. The template must actually have such a header; if it does not,
   * the provider refuses and that refusal is what gets reported.
   */
  async sendDocument(
    organisationId: string,
    to: string,
    document: { buffer: Buffer; filename: string; mimeType: string; caption?: string },
    route?: SenderRoute,
    template?: { name: string; languageCode: string; components?: unknown[] },
  ): Promise<WhatsAppSendResult> {
    return this.send(
      organisationId,
      to,
      async (sender) => {
        const form = new FormData();
        form.append('messaging_product', 'whatsapp');
        form.append('type', document.mimeType);
        form.append(
          'file',
          new Blob([new Uint8Array(document.buffer)], { type: document.mimeType }),
          document.filename,
        );
        const res = await fetch(
          `${this.graphBase}/${this.apiVersion}/${sender.phoneNumberId}/media`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${sender.accessToken}` },
            body: form,
            signal: AbortSignal.timeout(30_000),
          },
        );
        const uploaded = (await res.json().catch(() => null)) as
          | { id?: string; error?: { message?: string } }
          | null;
        if (!res.ok || !uploaded?.id) {
          throw new Error(
            `HTTP ${res.status}: media upload refused${uploaded?.error?.message ? ` — ${uploaded.error.message}` : ''}`,
          );
        }
        const media = { id: uploaded.id, filename: document.filename };
        if (template) {
          return {
            type: 'template',
            template: {
              name: template.name,
              language: { code: template.languageCode },
              components: [
                { type: 'header', parameters: [{ type: 'document', document: media }] },
                ...((template.components ?? []) as { type?: string }[]).filter(
                  (component) => component?.type !== 'header',
                ),
              ],
            },
          };
        }
        return {
          type: 'document',
          document: { ...media, ...(document.caption ? { caption: document.caption } : {}) },
        };
      },
      route,
    );
  }

  private async send(
    organisationId: string,
    to: string,
    payload:
      | Record<string, unknown>
      | ((sender: { phoneNumberId: string; accessToken: string }) => Promise<Record<string, unknown>>),
    route?: SenderRoute,
  ): Promise<WhatsAppSendResult> {
    const recipient = this.normalise(to);

    /*
     * The staging blast door.
     *
     * A test environment restored from, or pointed at, real customer records is
     * one misconfigured job away from messaging those customers for real. When
     * MESSAGING_RECIPIENT_ALLOWLIST is set, this process may only reach the
     * numbers named in it, and everything else is refused HERE — the single
     * point every outbound message passes through, below every policy, every
     * queue and every retry, so no caller can route around it.
     *
     * Production leaves the variable unset and is unaffected. Presence of the
     * variable is the switch, deliberately not NODE_ENV: staging also runs as
     * production, and that is exactly the environment that needs the door.
     */
    const allowlist = this.recipientAllowlist();
    if (allowlist && !allowlist.has(recipient)) {
      this.logger.warn(
        `[allowlist] WhatsApp send to ${maskNumber(recipient)} refused: not a configured test recipient.`,
      );
      return {
        delivered: false,
        dryRun: true,
        to: recipient,
        reason:
          'This environment may only message its configured test recipients. Add the number to MESSAGING_RECIPIENT_ALLOWLIST to test with it.',
        credentialScope: 'none',
      };
    }

    const sender = await this.credentials.senderFor(organisationId, route ?? {});
    if (!sender.usable || !sender.accessToken || !sender.phoneNumberId) {
      this.logger.log(`[dry-run] WhatsApp → ${maskNumber(recipient)}: ${sender.reason}`);
      return {
        delivered: false,
        dryRun: true,
        to: recipient,
        reason: sender.reason ?? 'No WhatsApp sender is configured.',
        credentialScope: sender.scope,
      };
    }
    try {
      // A builder runs only past the allowlist and credential checks above, so
      // a media upload is never attempted for a send that would not happen.
      const body =
        typeof payload === 'function'
          ? await payload({ phoneNumberId: sender.phoneNumberId, accessToken: sender.accessToken })
          : payload;
      const res = await fetchJson(
        `${this.graphBase}/${this.apiVersion}/${sender.phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${sender.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ messaging_product: 'whatsapp', to: recipient, ...body }),
        },
      );
      const messageId = res?.messages?.[0]?.id as string | undefined;
      return {
        delivered: true,
        dryRun: false,
        to: recipient,
        messageId,
        credentialScope: sender.scope,
        // WHICH number carried it, and why that one. Once a tenant has eight,
        // "it was sent" stops being the useful fact.
        senderAssetId: sender.assetId,
        resolvedBy: sender.resolvedBy,
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.error(`WhatsApp send to ${maskNumber(recipient)} failed: ${error}`);
      return { delivered: false, dryRun: false, to: recipient, error, credentialScope: sender.scope };
    }
  }

  /**
   * Meta webhook handshake (GET): echo `hub.challenge` iff `hub.verify_token`
   * matches WHATSAPP_WEBHOOK_VERIFY_TOKEN. Returns null when it doesn't match.
   */
  verifyWebhook(mode?: string, token?: string, challenge?: string): string | null {
    const expected = this.config.get<string>('WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    if (mode !== 'subscribe' || !expected || !token) return null;
    // Constant-time, like the Lead Ads handshake beside it. `===` returns as
    // soon as two bytes differ, so the time it takes leaks how much of the
    // token a caller has right — and this endpoint is public and unrated
    // enough to guess against. `safeEqual` was already imported for the
    // signature check in this same file and simply was not used here.
    if (!safeEqual(token, expected)) return null;
    return challenge ?? '';
  }

  /**
   * Validate the X-Hub-Signature-256 header against the raw request body.
   *
   * The webhook is @Public and now writes business data, so an unsigned request
   * must never be trusted in production: with no secret configured we REFUSE
   * there, and only fall through to accepting in development (where curl-driven
   * testing has no way to sign). Same shape as the JWT_SECRET guard in main.ts.
   */
  verifySignature(rawBody: Buffer | undefined, signature?: string): boolean {
    if (!this.appSecret) {
      if (process.env.NODE_ENV === 'production') {
        this.logger.error(
          'WHATSAPP_APP_SECRET is not set — refusing inbound webhook. Set it to accept WhatsApp traffic.',
        );
        return false;
      }
      this.logger.warn('WHATSAPP_APP_SECRET not set — skipping signature check (development only).');
      return true;
    }
    if (!rawBody || !signature) return false;
    const expected = 'sha256=' + createHmac('sha256', this.appSecret).update(rawBody).digest('hex');
    return safeEqual(expected, signature);
  }
}

/**
 * A phone number safe to write down.
 *
 * Logs are read by more people than customer records are, are shipped to third
 * parties, and outlive the data they describe. The last four digits are enough
 * to match a number an operator already has in front of them and not enough to
 * be one.
 */
function maskNumber(recipient: string): string {
  return recipient.length <= 4 ? '****' : `****${recipient.slice(-4)}`;
}
