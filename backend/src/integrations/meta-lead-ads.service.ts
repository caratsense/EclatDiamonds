import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { JobsService } from '../jobs/jobs.service';
import { MetaAssetOwnershipService, normaliseMetaId } from './meta-asset-ownership.service';
import { MetaGraphClient } from './meta-graph.client';
import type { MetaLeadField, MetaLeadRecord, MetaLeadSink } from './meta-contracts';

export const META_LEAD_FETCH_JOB = 'meta.lead_ads.fetch';

interface MetaLeadJobPayload {
  organisationId: string;
  integrationId: string;
  leadgenId: string;
  pageId: string;
  formId: string | null;
  webhookCreatedAt: string | null;
}

interface GraphLeadData {
  id?: unknown;
  created_time?: unknown;
  ad_id?: unknown;
  ad_name?: unknown;
  adset_id?: unknown;
  adset_name?: unknown;
  campaign_id?: unknown;
  campaign_name?: unknown;
  form_id?: unknown;
  field_data?: unknown;
}

/**
 * Turns a signed `leadgen` notification into durable, tenant-bound work.
 *
 * The webhook contains identifiers, not the submitted answers. Fetching those
 * answers happens in JobsService so Meta receives a quick acknowledgement and a
 * transient Graph failure is retried with the queue's bounded backoff.
 */
@Injectable()
export class MetaLeadAdsService implements OnModuleInit {
  private readonly log = new Logger(MetaLeadAdsService.name);
  private sink: MetaLeadSink | null = null;

  constructor(
    private readonly jobs: JobsService,
    private readonly graph: MetaGraphClient,
    private readonly assets: MetaAssetOwnershipService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(META_LEAD_FETCH_JOB, (payload) =>
      this.handleFetchJob(parseJobPayload(payload)),
    );
  }

  /** CRM registers exactly one adapter without creating a module import cycle. */
  registerSink(sink: MetaLeadSink): void {
    if (this.sink && this.sink !== sink) {
      throw new Error('A Meta Lead Ads sink is already registered.');
    }
    this.sink = sink;
  }

  async enqueue(input: MetaLeadJobPayload) {
    const payload = parseJobPayload(input);
    return this.jobs.enqueue({
      kind: META_LEAD_FETCH_JOB,
      organisationId: payload.organisationId,
      payload: payload as unknown as Prisma.InputJsonValue,
      idempotencyKey:
        `meta-lead:${payload.organisationId}:${payload.integrationId}:${payload.leadgenId}`,
      maxAttempts: 5,
      priority: 5,
    });
  }

  /** Public for fixture tests and controlled operational replay. */
  async fetchLead(payload: MetaLeadJobPayload): Promise<MetaLeadRecord> {
    const input = parseJobPayload(payload);

    // Re-resolve ownership at execution time. If a Page was moved/revoked after
    // enqueue, the old tenant must not fetch or receive its next lead.
    const owner = await this.assets.ownerForPage(input.pageId);
    if (
      !owner ||
      owner.organisationId !== input.organisationId ||
      owner.integrationId !== input.integrationId
    ) {
      throw new Error('Meta Page ownership changed before the lead could be fetched.');
    }

    const response = await this.graph.getForIntegration<GraphLeadData>(
      input.organisationId,
      input.integrationId,
      input.leadgenId,
      {
        fields:
          'id,created_time,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,form_id,field_data',
      },
    );
    const returnedId = normaliseMetaId(response.id);
    if (returnedId !== input.leadgenId) {
      throw new Error('Meta Graph returned a different lead id than requested.');
    }

    const fields = normaliseFields(response.field_data);
    const first = fieldValue(fields, ['first_name', 'firstname']);
    const last = fieldValue(fields, ['last_name', 'lastname']);
    return {
      organisationId: input.organisationId,
      integrationId: input.integrationId,
      leadgenId: input.leadgenId,
      pageId: input.pageId,
      formId: normaliseMetaId(response.form_id) ?? input.formId,
      createdAt: parseDate(response.created_time) ?? parseDate(input.webhookCreatedAt),
      adId: normaliseMetaId(response.ad_id),
      adSetId: normaliseMetaId(response.adset_id),
      campaignId: normaliseMetaId(response.campaign_id),
      adName: shortText(response.ad_name),
      adSetName: shortText(response.adset_name),
      campaignName: shortText(response.campaign_name),
      fullName:
        fieldValue(fields, ['full_name', 'fullname', 'name']) ??
        shortText([first, last].filter(Boolean).join(' ')) ??
        null,
      phone: fieldValue(fields, ['phone_number', 'phone', 'mobile_number', 'mobile']),
      email: fieldValue(fields, ['email', 'email_address']),
      fields,
    };
  }

  private async handleFetchJob(payload: MetaLeadJobPayload) {
    const record = await this.fetchLead(payload);
    if (!this.sink) {
      // Never report a job as successful while throwing its lead away. The row
      // remains retryable/dead and visible until the CRM adapter is registered.
      throw new Error('Meta Lead Ads CRM sink is not registered.');
    }
    const result = await this.sink.acceptMetaLead(record);
    if (!result.accepted && !result.duplicate) {
      throw new Error(shortText(result.reason) ?? 'CRM refused the Meta lead.');
    }
    this.log.log(
      `Meta lead accepted for tenant ${record.organisationId}` +
        (result.duplicate ? ' (already present)' : ''),
    );
    return {
      accepted: result.accepted,
      duplicate: result.duplicate ?? false,
      leadId: result.leadId ?? null,
      conversationId: result.conversationId ?? null,
    };
  }
}

function parseJobPayload(value: unknown): MetaLeadJobPayload {
  const row = value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
  const organisationId = opaqueId(row.organisationId);
  const integrationId = opaqueId(row.integrationId);
  const leadgenId = normaliseMetaId(row.leadgenId);
  const pageId = normaliseMetaId(row.pageId);
  const formId = row.formId == null ? null : normaliseMetaId(row.formId);
  if (!organisationId || !integrationId || !leadgenId || !pageId || (row.formId != null && !formId)) {
    throw new Error('Meta lead job payload is invalid.');
  }
  return {
    organisationId,
    integrationId,
    leadgenId,
    pageId,
    formId,
    webhookCreatedAt: typeof row.webhookCreatedAt === 'string'
      ? row.webhookCreatedAt.slice(0, 40)
      : null,
  };
}

function opaqueId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return /^[A-Za-z0-9_-]{3,128}$/.test(id) ? id : null;
}

function normaliseFields(value: unknown): MetaLeadField[] {
  if (!Array.isArray(value)) return [];
  const result: MetaLeadField[] = [];
  for (const raw of value.slice(0, 200)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const name = typeof row.name === 'string'
      ? row.name.trim().toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 100)
      : '';
    if (!name) continue;
    const values = (Array.isArray(row.values) ? row.values : [])
      .slice(0, 20)
      .map((item) => shortText(item, 1_000))
      .filter((item): item is string => Boolean(item));
    result.push({ name, values });
  }
  return result;
}

function fieldValue(fields: MetaLeadField[], aliases: string[]): string | null {
  for (const alias of aliases) {
    const value = fields.find((field) => field.name === alias)?.values[0];
    if (value) return value;
  }
  return null;
}

function shortText(value: unknown, max = 300): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

