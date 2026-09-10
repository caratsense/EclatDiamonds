import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';

import { WhatsAppBotService } from '../whatsapp-bot/whatsapp-bot.service';
import type { MetaDeliveryReceipt, MetaDeliveryReceiptSink } from './meta-contracts';
import { MetaAssetOwnershipService, normaliseMetaId } from './meta-asset-ownership.service';
import { MetaLeadAdsService } from './meta-lead-ads.service';
import { safeEqual } from './integrations.util';
import { WebhookIntakeService, type WebhookOutcome } from './webhook-intake.service';
import { WhatsAppCredentialsService } from './whatsapp-credentials.service';

/** Signature verification plus durable routing for Meta-owned webhooks. */
@Injectable()
export class MetaWebhookService {
  private receiptSink: MetaDeliveryReceiptSink | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly intake: WebhookIntakeService,
    private readonly assets: MetaAssetOwnershipService,
    private readonly leadAds: MetaLeadAdsService,
    private readonly whatsappBot: WhatsAppBotService,
    private readonly whatsappCredentials: WhatsAppCredentialsService,
  ) {}

  registerDeliveryReceiptSink(sink: MetaDeliveryReceiptSink): void {
    if (this.receiptSink && this.receiptSink !== sink) {
      throw new Error('A Meta delivery-receipt sink is already registered.');
    }
    this.receiptSink = sink;
  }

  verifyLeadAdsChallenge(mode?: string, token?: string, challenge?: string): string | null {
    const expected = this.config.get<string>('META_WEBHOOK_VERIFY_TOKEN');
    return mode === 'subscribe' && expected && token && safeEqual(token, expected)
      ? challenge ?? ''
      : null;
  }

  verifyLeadAdsSignature(rawBody?: Buffer, signature?: string): boolean {
    const secret = this.config.get<string>('META_APP_SECRET') ?? '';
    if (!secret || !rawBody || !signature || !/^sha256=[0-9a-f]{64}$/i.test(signature)) {
      return false;
    }
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return safeEqual(expected.toLowerCase(), signature.toLowerCase());
  }

  async receiveLeadAds(rawBody: Buffer): Promise<WebhookOutcome & { duplicate?: boolean }> {
    const payload = parseJsonObject(rawBody);
    return this.intake.intake(
      {
        providerCode: 'meta_ads',
        externalId: deliveryId(rawBody),
        signatureVerified: true,
        payload,
        headers: {},
      },
      () => this.routeLeadAds(payload),
    );
  }

  /** WhatsApp uses its existing verifier, then enters the same durable boundary. */
  async receiveWhatsApp(
    rawBody: Buffer,
  ): Promise<WebhookOutcome & { duplicate?: boolean }> {
    const payload = parseJsonObject(rawBody);
    return this.intake.intake(
      {
        providerCode: 'whatsapp_cloud',
        externalId: deliveryId(rawBody),
        signatureVerified: true,
        payload,
        headers: {},
      },
      async () => {
        const result = await this.whatsappBot.ingest(payload);
        // Resolve the tenant BEFORE dispatching receipts, and only from a phone
        // number id we own. `singleWhatsAppOwner` returns null when zero or more
        // than one tenant matches, and a receipt with no certain owner is
        // dropped rather than applied to a guess — applying it to the wrong
        // tenant would mark another organisation's message delivered.
        const owner = await this.singleWhatsAppOwner(payload);
        const receipts = extractWhatsAppDeliveryReceipts(payload);
        if (this.receiptSink && owner) {
          for (const receipt of receipts) {
            await this.receiptSink.acceptMetaDeliveryReceipt(receipt, owner);
          }
        }
        return {
          handled: result.received + result.duplicates + result.statuses > 0,
          reason:
            result.received + result.duplicates + result.statuses > 0
              ? undefined
              : 'no supported WhatsApp events',
          organisationId: owner?.organisationId ?? null,
          integrationId: owner?.integrationId ?? null,
        };
      },
    );
  }

  private async routeLeadAds(payload: Record<string, unknown>): Promise<WebhookOutcome> {
    const changes = extractLeadgenChanges(payload);
    if (changes.length === 0) return { handled: false, reason: 'no leadgen changes' };

    const owners = new Map<string, { organisationId: string; integrationId: string }>();
    let queued = 0;
    let unowned = 0;
    for (const change of changes) {
      const owner = await this.assets.ownerForPage(change.pageId);
      if (!owner) {
        unowned += 1;
        continue;
      }
      owners.set(`${owner.organisationId}:${owner.integrationId}`, owner);
      await this.leadAds.enqueue({
        ...owner,
        leadgenId: change.leadgenId,
        pageId: change.pageId,
        formId: change.formId,
        webhookCreatedAt: change.createdAt?.toISOString() ?? null,
      });
      queued += 1;
    }

    const onlyOwner = owners.size === 1 ? [...owners.values()][0] : null;
    return {
      handled: queued > 0,
      reason:
        queued > 0
          ? `${queued} lead fetch job(s) queued${unowned ? `; ${unowned} unowned change(s) ignored` : ''}`
          : `${unowned} change(s) ignored because no tenant owns the Meta Page`,
      organisationId: onlyOwner?.organisationId ?? null,
      integrationId: onlyOwner?.integrationId ?? null,
    };
  }

  private async singleWhatsAppOwner(payload: Record<string, unknown>) {
    const ids = whatsappPhoneIds(payload);
    const owners = new Map<string, { organisationId: string; integrationId: string | null }>();
    for (const id of ids) {
      const owner = await this.whatsappCredentials.organisationForPhoneNumberId(id);
      if (owner) owners.set(`${owner.organisationId}:${owner.integrationId ?? ''}`, owner);
    }
    return owners.size === 1 ? [...owners.values()][0] : null;
  }
}

export function deliveryId(rawBody: Buffer): string {
  return `body-sha256:${createHash('sha256').update(rawBody).digest('hex')}`;
}

export function extractLeadgenChanges(payload: unknown): Array<{
  leadgenId: string;
  pageId: string;
  formId: string | null;
  createdAt: Date | null;
}> {
  const root = object(payload);
  if (!root || root.object !== 'page' || !Array.isArray(root.entry)) return [];
  const unique = new Map<string, { leadgenId: string; pageId: string; formId: string | null; createdAt: Date | null }>();
  for (const entryRaw of root.entry.slice(0, 100)) {
    const entry = object(entryRaw);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const changeRaw of entry.changes.slice(0, 100)) {
      const change = object(changeRaw);
      if (!change || change.field !== 'leadgen') continue;
      const value = object(change.value);
      const leadgenId = normaliseMetaId(value?.leadgen_id);
      const pageId = normaliseMetaId(value?.page_id) ?? normaliseMetaId(entry.id);
      const formId = value?.form_id == null ? null : normaliseMetaId(value.form_id);
      if (!leadgenId || !pageId || (value?.form_id != null && !formId)) continue;
      const createdAt = unixDate(value?.created_time ?? entry.time);
      unique.set(`${pageId}:${leadgenId}`, { leadgenId, pageId, formId, createdAt });
    }
  }
  return [...unique.values()];
}

export function extractWhatsAppDeliveryReceipts(payload: unknown): MetaDeliveryReceipt[] {
  const root = object(payload);
  if (!root || !Array.isArray(root.entry)) return [];
  const result: MetaDeliveryReceipt[] = [];
  for (const entryRaw of root.entry.slice(0, 100)) {
    const entry = object(entryRaw);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const changeRaw of entry.changes.slice(0, 100)) {
      const value = object(object(changeRaw)?.value);
      if (!value || !Array.isArray(value.statuses)) continue;
      for (const statusRaw of value.statuses.slice(0, 1_000)) {
        const row = object(statusRaw);
        const id = text(row?.id, 512);
        if (!id) continue;
        const state = text(row?.status, 32);
        const conversation = object(row?.conversation);
        const pricing = object(row?.pricing);
        const errors = Array.isArray(row?.errors) ? row.errors : [];
        result.push({
          provider: 'whatsapp_cloud',
          externalMessageId: id,
          recipientId: text(row?.recipient_id, 64),
          status: ['sent', 'delivered', 'read', 'failed'].includes(state ?? '')
            ? (state as MetaDeliveryReceipt['status'])
            : 'unknown',
          occurredAt: unixDate(row?.timestamp),
          conversationId: text(conversation?.id, 512),
          pricingCategory: text(pricing?.category, 64),
          providerErrorCodes: errors
            .slice(0, 20)
            .map((error) => text(object(error)?.code, 32))
            .filter((code): code is string => Boolean(code)),
        });
      }
    }
  }
  return result;
}

function whatsappPhoneIds(payload: unknown): string[] {
  const ids = new Set<string>();
  const root = object(payload);
  if (!root || !Array.isArray(root.entry)) return [];
  for (const entryRaw of root.entry.slice(0, 100)) {
    const entry = object(entryRaw);
    if (!entry || !Array.isArray(entry.changes)) continue;
    for (const changeRaw of entry.changes.slice(0, 100)) {
      const metadata = object(object(object(changeRaw)?.value)?.metadata);
      const id = normaliseMetaId(metadata?.phone_number_id);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function parseJsonObject(rawBody: Buffer): Record<string, unknown> {
  if (!rawBody.length || rawBody.length > 5 * 1024 * 1024) {
    throw new BadRequestException('Webhook body is empty or too large.');
  }
  try {
    const parsed = JSON.parse(rawBody.toString('utf8'));
    const row = object(parsed);
    if (!row) throw new Error('not an object');
    return row;
  } catch {
    throw new BadRequestException('Webhook body must be a JSON object.');
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const result = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return result ? result.slice(0, max) : null;
}

function unixDate(value: unknown): Date | null {
  const seconds = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isFinite(date.getTime()) ? date : null;
}

