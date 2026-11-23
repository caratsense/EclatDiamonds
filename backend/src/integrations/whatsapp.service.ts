import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { fetchJson, safeEqual } from './integrations.util';
import {
  SenderProblem,
  SenderRoute,
  WhatsAppCredentialsService,
} from './whatsapp-credentials.service';

/**
 * The largest inbound attachment we will store. WhatsApp caps most media
 * well below this; the point is that nothing a stranger sends can fill the
 * disk, since this path runs before any human has looked at the message.
 */
const MAX_INBOUND_MEDIA_BYTES = 16 * 1024 * 1024;

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
   * Can this organisation actually send TO A CUSTOMER?
   *
   * Takes an organisation because the answer differs per tenant — one may have
   * connected their number while another has not. The old parameterless
   * `enabled` could only ever describe the platform, which is exactly the
   * assumption being removed.
   *
   * The audience is not optional here, and asking without it was a real bug.
   * A route-less question cannot be answered by a tenant with more than one
   * number — the resolver correctly refuses rather than pick one — and the
   * single caller of this method is `GET /integrations/status`, which the UI
   * turns into "WhatsApp is not connected yet" next to the send controls.
   * So a shop that had added a staff line beside its shopfront number was told
   * its WhatsApp was not connected while its quotes were going out normally:
   * the warning came from the question, not from the connection.
   *
   * `customer` is the right audience to ask about because that banner guards
   * customer-facing sends. A staff line alone is deliberately NOT "connected"
   * for this purpose — a business that can only message its own staff cannot
   * message a customer, and saying otherwise would be the same lie inverted.
   */
  async enabledFor(organisationId: string): Promise<boolean> {
    return (await this.credentials.senderFor(organisationId, { audience: 'customer' })).usable;
  }

  /**
   * Whether ONE PARTICULAR message could leave, and the sentence to show when
   * it could not — without handing the caller the credential it would use.
   *
   * `enabledFor` asks only "could a customer be reached at all", which is the
   * right question for a banner and the wrong one for a send. A caller that
   * knows the branch as well (a quote, from the branch that raised it) needs
   * the answer for THAT send, before it queues something a person will be told
   * about: the branch decides WHICH customer-facing number carries it.
   *
   * `scope` is part of the answer on purpose. "This tenant has no WhatsApp"
   * (`none`) and "this tenant has WhatsApp but not for this message" (`tenant`)
   * deserve different handling: the first is a deployment nobody connected, the
   * second is a mapping somebody has to fix.
   */
  async senderStatus(
    organisationId: string,
    route?: SenderRoute,
  ): Promise<{
    usable: boolean;
    scope: 'tenant' | 'platform_env' | 'none';
    /** Which KIND of problem it is, for a caller that treats them differently. */
    code: SenderProblem | null;
    reason: string | null;
    resolvedBy: string | null;
  }> {
    const sender = await this.credentials.senderFor(organisationId, route ?? {});
    return {
      usable: sender.usable,
      scope: sender.scope,
      code: sender.code,
      reason: sender.reason,
      resolvedBy: sender.resolvedBy,
    };
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

  /**
   * Tell WhatsApp a customer's message has been READ — the blue ticks on their
   * phone (client, Nov 2026: "there is no read receipt... the customer is not
   * able to see whether we have seen it or not").
   *
   * ## Why it goes through `send`
   *
   * This is not a message to the customer, but it IS something the customer
   * sees, so it belongs behind the same door as everything else that reaches
   * them: `senderFor` decides WHICH of the tenant's numbers claims the read
   * (Graph only accepts the receipt on the number that received the message),
   * and MESSAGING_RECIPIENT_ALLOWLIST still decides whether this environment
   * may touch that person at all.
   *
   * A second path with its own copy of the allowlist check would be a blast
   * door with a second entrance. Copies drift, and the day the copy drifts is
   * the day staging ticks a real customer's message.
   *
   * ## Why `to` is unset in the body
   *
   * The Cloud API's read receipt takes only `{messaging_product, status,
   * message_id}` — there is no recipient field, because the message id already
   * names the thread. `send` builds `{messaging_product, to, ...body}`, and
   * `JSON.stringify` drops a key whose value is `undefined`, so this sends
   * exactly the documented body while still passing the number through `send`
   * for the allowlist check and the masked logging.
   */
  async markRead(
    organisationId: string,
    /** The customer's number. Used for the allowlist and the log, not the body. */
    to: string,
    /** The provider's id for THEIR message — what is being acknowledged. */
    providerMessageId: string,
    route?: SenderRoute,
  ): Promise<WhatsAppSendResult> {
    return this.send(
      organisationId,
      to,
      { to: undefined, status: 'read', message_id: providerMessageId },
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
   * Send tappable reply buttons (only inside an open 24h window).
   *
   * WhatsApp allows at most three, each title at most 20 characters. Both
   * limits are ENFORCED here rather than trimmed: a silently truncated option
   * stops meaning what it says, and on a phone nobody can tell it was cut.
   * Callers with more than three choices want `sendList`.
   */
  async sendButtons(
    organisationId: string,
    to: string,
    body: string,
    buttons: { id: string; title: string }[],
    route?: SenderRoute,
  ): Promise<WhatsAppSendResult> {
    if (buttons.length < 1 || buttons.length > 3) {
      throw new Error(`WhatsApp allows 1-3 reply buttons; got ${buttons.length}.`);
    }
    const tooLong = buttons.find((b) => b.title.length > 20);
    if (tooLong) {
      throw new Error(`Button title "${tooLong.title}" exceeds WhatsApp's 20-character limit.`);
    }
    return this.send(
      organisationId,
      to,
      {
        type: 'interactive',
        interactive: {
          type: 'button',
          body: { text: body },
          action: {
            buttons: buttons.map((b) => ({
              type: 'reply',
              reply: { id: b.id, title: b.title },
            })),
          },
        },
      },
      route,
    );
  }

  /**
   * Send a single-select list (only inside an open 24h window).
   *
   * Ten rows across all sections, row titles 24 characters, descriptions 72,
   * and the button that opens the sheet 20. Same reasoning as `sendButtons`:
   * refused, never trimmed.
   */
  async sendList(
    organisationId: string,
    to: string,
    body: string,
    buttonText: string,
    sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[],
    route?: SenderRoute,
  ): Promise<WhatsAppSendResult> {
    const rows = sections.flatMap((s) => s.rows);
    if (rows.length < 1 || rows.length > 10) {
      throw new Error(`WhatsApp allows 1-10 list rows in total; got ${rows.length}.`);
    }
    if (buttonText.length > 20) {
      throw new Error(`List button "${buttonText}" exceeds WhatsApp's 20-character limit.`);
    }
    const badRow = rows.find((r) => r.title.length > 24 || (r.description?.length ?? 0) > 72);
    if (badRow) {
      throw new Error(`List row "${badRow.title}" exceeds WhatsApp's title/description limits.`);
    }
    return this.send(
      organisationId,
      to,
      {
        type: 'interactive',
        interactive: {
          type: 'list',
          body: { text: body },
          action: {
            button: buttonText,
            sections: sections.map((s) => ({
              ...(s.title ? { title: s.title } : {}),
              rows: s.rows.map((r) => ({
                id: r.id,
                title: r.title,
                ...(r.description ? { description: r.description } : {}),
              })),
            })),
          },
        },
      },
      route,
    );
  }

  /**
   * Put bytes in the provider's media store and return the id, without
   * sending anything.
   *
   * A carousel needs this: each card's picture is a separate media id in the
   * send payload, and there is no message to attach them to until all of them
   * exist. The ids are short-lived at Meta (30 days), which is exactly why
   * this happens at send time rather than once at template creation.
   */
  async uploadMedia(
    organisationId: string,
    media: { buffer: Buffer; mimeType: string; filename?: string },
    route?: SenderRoute,
  ): Promise<{ id: string | null; reason?: string }> {
    const sender = await this.credentials.senderFor(organisationId, route ?? {});
    if (!sender.usable || !sender.phoneNumberId || !sender.accessToken) {
      return { id: null, reason: sender.reason ?? 'No usable WhatsApp credential.' };
    }
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', media.mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(media.buffer)], { type: media.mimeType }),
      media.filename ?? 'card.jpg',
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
    const body = (await res.json().catch(() => null)) as
      | { id?: string; error?: { message?: string } }
      | null;
    if (!res.ok || !body?.id) {
      return {
        id: null,
        reason: `HTTP ${res.status}: media upload refused${body?.error?.message ? ` — ${body.error.message}` : ''}`,
      };
    }
    return { id: body.id };
  }

  /**
   * Send a document (a quote PDF) as a WhatsApp document message.
   *
   * Kept as the name the quote flow calls: a PDF is a document, and reading
   * `sendDocument` at that call site says what is happening. The work is
   * `sendMedia`, which an image uses too.
   */
  async sendDocument(
    organisationId: string,
    to: string,
    document: { buffer: Buffer; filename: string; mimeType: string; caption?: string },
    route?: SenderRoute,
    template?: { name: string; languageCode: string; components?: unknown[] },
  ): Promise<WhatsAppSendResult> {
    return this.sendMedia(organisationId, to, { ...document, kind: 'document' }, route, template);
  }

  /**
   * Send an image — a product photograph a salesperson is showing a customer.
   *
   * Separate from `sendDocument` because WhatsApp renders the two differently:
   * an image appears in the thread, a document appears as a file to download.
   * A photograph sent as a document is technically delivered and useless.
   */
  async sendImage(
    organisationId: string,
    to: string,
    image: { buffer: Buffer; filename: string; mimeType: string; caption?: string },
    route?: SenderRoute,
    template?: { name: string; languageCode: string; components?: unknown[] },
  ): Promise<WhatsAppSendResult> {
    return this.sendMedia(organisationId, to, { ...image, kind: 'image' }, route, template);
  }

  /**
   * Upload bytes to the provider's media store and send them, as a message of
   * their own or as a template's media header.
   *
   * The bytes are uploaded first and the message refers to the returned media
   * id. Nothing is handed to Meta as a link, so no public or long-lived URL to
   * a customer's document or a product photograph ever has to exist.
   *
   * With a template, the media rides in the template's header — the only way
   * it can open a conversation outside the 24-hour window. The template must
   * actually have a header of that format; if it does not, the provider
   * refuses and that refusal is what gets reported.
   *
   * `filename` is sent for a document and withheld for an image: WhatsApp uses
   * it as the download name of a file, and on an image it is rejected.
   */
  private async sendMedia(
    organisationId: string,
    to: string,
    media: {
      buffer: Buffer;
      filename: string;
      mimeType: string;
      caption?: string;
      kind: 'document' | 'image';
    },
    route?: SenderRoute,
    template?: { name: string; languageCode: string; components?: unknown[] },
  ): Promise<WhatsAppSendResult> {
    const document = media;
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
        // A document carries its download name; an image is refused with one.
        const media =
          document.kind === 'document'
            ? { id: uploaded.id, filename: document.filename }
            : { id: uploaded.id };
        if (template) {
          return {
            type: 'template',
            template: {
              name: template.name,
              language: { code: template.languageCode },
              components: [
                {
                  type: 'header',
                  parameters: [{ type: document.kind, [document.kind]: media }],
                },
                ...((template.components ?? []) as { type?: string }[]).filter(
                  (component) => component?.type !== 'header',
                ),
              ],
            },
          };
        }
        return {
          type: document.kind,
          [document.kind]: {
            ...media,
            ...(document.caption ? { caption: document.caption } : {}),
          },
        };
      },
      route,
    );
  }

  /**
   * Fetch an inbound attachment from Meta.
   *
   * Two hops, both authenticated: `GET /{media_id}` returns a short-lived URL,
   * and that URL needs the SAME bearer token to download — a detail that makes
   * the second request look gratuitous and is the usual reason this returns 401
   * when first written.
   *
   * Returns null rather than throwing. A customer's photograph failing to
   * download must not fail the webhook: Meta would redeliver the message, the
   * bot would answer it a second time, and the customer would get the same
   * reply twice because a picture could not be saved.
   */
  async fetchInboundMedia(
    organisationId: string,
    mediaId: string,
    route?: SenderRoute,
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const sender = await this.credentials.senderFor(organisationId, route);
    if (!sender.usable || !sender.accessToken) {
      this.logger.warn(`media ${mediaId} not fetched: ${sender.reason ?? 'no usable credential'}`);
      return null;
    }
    try {
      const lookup = await fetch(`${this.graphBase}/${this.apiVersion}/${mediaId}`, {
        headers: { authorization: `Bearer ${sender.accessToken}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!lookup.ok) {
        this.logger.warn(`media ${mediaId} lookup failed: HTTP ${lookup.status}`);
        return null;
      }
      const meta = (await lookup.json()) as { url?: string; mime_type?: string; file_size?: number };
      if (!meta.url) return null;

      // Refused BEFORE the download when Meta tells us the size, so an
      // oversized file costs one cheap request rather than a full transfer.
      if (typeof meta.file_size === 'number' && meta.file_size > MAX_INBOUND_MEDIA_BYTES) {
        this.logger.warn(`media ${mediaId} refused: ${meta.file_size} bytes exceeds the cap`);
        return null;
      }

      const download = await fetch(meta.url, {
        headers: { authorization: `Bearer ${sender.accessToken}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (!download.ok) {
        this.logger.warn(`media ${mediaId} download failed: HTTP ${download.status}`);
        return null;
      }
      const buffer = Buffer.from(await download.arrayBuffer());
      // Checked again on the bytes actually received: `file_size` is Meta's
      // claim, not a guarantee, and this is the number that reaches the disk.
      if (buffer.byteLength > MAX_INBOUND_MEDIA_BYTES) {
        this.logger.warn(`media ${mediaId} refused after download: ${buffer.byteLength} bytes`);
        return null;
      }
      return {
        buffer,
        mimeType: meta.mime_type || download.headers.get('content-type') || 'application/octet-stream',
      };
    } catch (err) {
      this.logger.warn(
        `media ${mediaId} could not be fetched: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
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
