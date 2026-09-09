import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { MetaGraphClient } from '../integrations/meta-graph.client';
import { JobContext, JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { providerTemplateStatus, type ProviderTemplateStatus } from './omnichannel-policy';

export const TEMPLATE_SYNC_JOB = 'omnichannel.templates.sync';
export const TEMPLATE_ASSET_KIND = 'message_template';
const WHATSAPP_PROVIDER_CODE = 'whatsapp_cloud';
const MAX_PAGES = 50;
const PAGE_SIZE = '100';
const MAX_ERROR = 300;

interface ProviderTemplate {
  id?: unknown;
  name?: unknown;
  language?: unknown;
  status?: unknown;
  category?: unknown;
}

interface ProviderTemplatePage {
  data?: ProviderTemplate[];
  paging?: { cursors?: { after?: string }; next?: string };
}

export interface TemplateSyncResult {
  integrationId: string;
  syncedAt: string;
  providerTemplates: number;
  approved: number;
  /** Held locally, absent from the provider's list. These fail closed. */
  removed: number;
  /** Present at the provider but not known locally until this run. */
  discovered: number;
}

/**
 * Makes the provider the authority on whether a template may be sent.
 *
 * Before this, a head-office user typed `status: "approved"` into a form and
 * that word was what unlocked sending outside the 24-hour customer-care window.
 * Nothing reconciled it with Meta and nothing expired it, so a template Meta
 * later paused for quality stayed "approved" here indefinitely — and every
 * message built on it was rejected by the provider, or worse, accepted while
 * burning the sender's quality rating.
 *
 * What this service writes is deliberately narrow: the provider's own status
 * string, the moment it was read, and nothing else. It never invents an
 * approval, never upgrades one, and treats "the provider did not mention this
 * template" as REMOVED rather than as unchanged.
 */
@Injectable()
export class TemplateSyncService implements OnModuleInit {
  private readonly logger = new Logger(TemplateSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.jobs.register(TEMPLATE_SYNC_JOB, async (payload, context) => this.runJob(payload, context));
  }

  /** Queue a durable background sync. Repeat requests collapse within the hour. */
  async schedule(user: AuthUser, integrationId: string) {
    const integration = await this.load(user.organisationId, integrationId);
    const hour = new Date().toISOString().slice(0, 13);
    const queued = await this.jobs.enqueue({
      kind: TEMPLATE_SYNC_JOB,
      organisationId: user.organisationId,
      payload: { integrationId: integration.id } as unknown as Prisma.InputJsonValue,
      idempotencyKey: [TEMPLATE_SYNC_JOB, user.organisationId, integration.id, hour].join(':'),
      maxAttempts: 5,
      createdById: user.id,
    });
    return { queued: true, jobId: queued.id, deduplicated: queued.deduplicated };
  }

  /**
   * Every tenant connection that could be synced, for the scheduled sweep.
   *
   * Only integrations that are not disabled and that name a WhatsApp Business
   * Account. A connection nobody finished setting up is skipped rather than
   * failed repeatedly.
   */
  async syncableIntegrations(limit = 200) {
    const rows = await this.prisma.integration.findMany({
      where: { providerCode: WHATSAPP_PROVIDER_CODE, status: { not: 'disabled' } },
      select: { id: true, organisationId: true, config: true },
      take: limit,
    });
    return rows.filter((row) => wabaId(row.config) !== null);
  }

  /** Read the provider's template list and record what it says. */
  async sync(organisationId: string, integrationId: string): Promise<TemplateSyncResult> {
    const integration = await this.load(organisationId, integrationId);
    const account = wabaId(integration.config);
    if (!account) {
      throw new BadRequestException(
        'Set the WhatsApp Business Account id on this connection before synchronising templates.',
      );
    }

    const provider = new Map<string, ProviderTemplate>();
    let after: string | undefined;
    const seenCursors = new Set<string>();

    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const body = await this.graph.getForIntegration<ProviderTemplatePage>(
          organisationId,
          integrationId,
          `${account}/message_templates`,
          { fields: 'id,name,language,status,category', limit: PAGE_SIZE, ...(after ? { after } : {}) },
          WHATSAPP_PROVIDER_CODE,
        );
        if (!body || !Array.isArray(body.data)) {
          throw new Error('The provider returned a template list without a data array.');
        }
        for (const row of body.data) {
          const key = templateKey(row.name, row.language);
          if (key) provider.set(key, row);
        }
        const next = body.paging?.next;
        if (!next) break;
        const cursor = body.paging?.cursors?.after;
        if (!cursor || cursor.length > 2048 || seenCursors.has(cursor)) {
          throw new Error('The provider returned an invalid or repeated pagination cursor.');
        }
        seenCursors.add(cursor);
        after = cursor;
      }
    } catch (error) {
      const message = bounded(error);
      await this.prisma.integration
        .updateMany({ where: { id: integrationId, organisationId }, data: { lastError: message } })
        .catch(() => undefined);
      this.logger.warn(`WhatsApp template sync failed for ${integrationId}: ${message}`);
      throw error;
    }

    const syncedAt = new Date();
    const local = await this.prisma.integrationAsset.findMany({
      where: { organisationId, integrationId, kind: TEMPLATE_ASSET_KIND },
    });

    let approved = 0;
    let removed = 0;
    // Names this connection already holds. A template asset is keyed by name
    // alone -- `@@unique([integrationId, kind, externalId])` -- so discovery
    // must never upsert onto a name that exists, or it would overwrite one
    // language's row with another language's verdict.
    const localNames = new Set(local.map((a) => cleanName(a.externalId)).filter(Boolean) as string[]);
    const languagesByName = new Map<string, string[]>();
    for (const row of provider.values()) {
      const name = cleanName(row.name);
      const language = cleanLanguage(row.language);
      if (name && language) languagesByName.set(name, [...(languagesByName.get(name) ?? []), language]);
    }

    for (const asset of local) {
      const metadata = jsonObject(asset.metadata);
      const key = templateKey(asset.externalId, metadata.languageCode);
      const row = key ? provider.get(key) : undefined;
      /*
       * A template the provider did not list is REMOVED, not "unchanged".
       * Leaving the previous verdict in place would keep a deleted template
       * sendable until somebody noticed, which is precisely the failure mode
       * this sync exists to close.
       */
      const status: ProviderTemplateStatus = row ? providerTemplateStatus(row.status) : 'REMOVED';
      if (status === 'APPROVED') approved += 1;
      if (status === 'REMOVED') removed += 1;

      // A name the provider has, but not in the language recorded here. Say so:
      // "removed" alone would send an operator looking for a deleted template
      // that is in fact sitting there under another language.
      const name = cleanName(asset.externalId);
      const otherLanguages = !row && name ? (languagesByName.get(name) ?? []) : [];
      const reason = otherLanguages.length
        ? `The provider has this template only in ${otherLanguages.join(', ')}; this connection records it as ${String(metadata.languageCode ?? 'an unknown language')}.`
        : `Provider reports this template as ${status}.`;

      await this.prisma.integrationAsset.update({
        where: { id: asset.id },
        data: {
          metadata: {
            ...metadata,
            providerStatus: status,
            providerSyncedAt: syncedAt.toISOString(),
            ...(row && typeof row.id === 'string' ? { providerTemplateId: row.id } : {}),
            ...(row && typeof row.category === 'string'
              ? { providerCategory: row.category.toLowerCase() }
              : {}),
          } as unknown as Prisma.InputJsonValue,
          // The same three columns Meta asset health uses, meaning the same
          // thing: a live provider call confirmed this, and here is when.
          providerOwnershipVerified: status === 'APPROVED',
          lastVerifiedAt: syncedAt,
          lastError: status === 'APPROVED' ? null : reason,
        },
      });
    }

    // Templates the provider has that this tenant never recorded. Created so an
    // operator sees what actually exists rather than only what someone typed in.
    let discovered = 0;
    for (const row of provider.values()) {
      const name = cleanName(row.name);
      const language = cleanLanguage(row.language);
      if (!name || !language || localNames.has(name)) continue;
      const status = providerTemplateStatus(row.status);
      if (status === 'APPROVED') approved += 1;
      discovered += 1;
      localNames.add(name);
      await this.prisma.integrationAsset.create({
        data: {
          organisationId,
          integrationId,
          kind: TEMPLATE_ASSET_KIND,
          externalId: name,
          name,
          isActive: true,
          providerOwnershipVerified: status === 'APPROVED',
          lastVerifiedAt: syncedAt,
          lastError: status === 'APPROVED' ? null : `Provider reports this template as ${status}.`,
          metadata: {
            channel: 'whatsapp',
            languageCode: language,
            category:
              typeof row.category === 'string' ? row.category.toLowerCase() : 'utility',
            // Discovered, never declared. The local declaration stays empty so
            // nothing pretends a person recorded this.
            approvalStatus: 'pending',
            variables: [],
            recordedAt: syncedAt.toISOString(),
            providerStatus: status,
            providerSyncedAt: syncedAt.toISOString(),
            ...(typeof row.id === 'string' ? { providerTemplateId: row.id } : {}),
            discoveredFromProvider: true,
          } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    await this.prisma.integration.updateMany({
      where: { id: integrationId, organisationId },
      data: { lastSyncAt: syncedAt, lastError: null },
    });

    this.logger.log(
      `WhatsApp templates synced for ${integrationId}: ${provider.size} at provider, ${approved} approved, ${removed} removed, ${discovered} discovered`,
    );
    return {
      integrationId,
      syncedAt: syncedAt.toISOString(),
      providerTemplates: provider.size,
      approved,
      removed,
      discovered,
    };
  }

  /** On-demand sync from the administration screen. Audited, head office only. */
  async syncNow(user: AuthUser, integrationId: string): Promise<TemplateSyncResult> {
    const result = await this.sync(user.organisationId, integrationId);
    await this.audit.record(user, {
      action: 'omnichannel.templates_synced',
      entityType: 'Integration',
      entityId: integrationId,
      summary: 'Refreshed message-template approval from the provider.',
      metadata: {
        providerTemplates: result.providerTemplates,
        approved: result.approved,
        removed: result.removed,
        discovered: result.discovered,
      },
    });
    return result;
  }

  private async runJob(payload: unknown, context: JobContext) {
    const p = payload as { integrationId?: string } | null;
    if (!context.organisationId || !p?.integrationId) {
      throw new Error('Invalid template sync job payload.');
    }
    return this.sync(context.organisationId, p.integrationId);
  }

  private async load(organisationId: string, integrationId: string) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organisationId, providerCode: WHATSAPP_PROVIDER_CODE },
      select: { id: true, config: true, status: true },
    });
    if (!integration) throw new NotFoundException('WhatsApp integration not found');
    return integration;
  }
}

/**
 * A WhatsApp template is identified by name AND language: the same name exists
 * once per language and they are approved independently. Matching on name alone
 * would let an approved English template vouch for an unreviewed Hindi one.
 */
export function templateKey(name: unknown, language: unknown): string | null {
  const n = cleanName(name);
  const l = cleanLanguage(language);
  return n && l ? `${n}:${l}` : null;
}

function cleanName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9_]{1,512}$/.test(name) ? name : null;
}

function cleanLanguage(value: unknown): string | null {
  // Graph returns either "en_US" or { language: "en_US" } depending on the edge.
  const raw =
    typeof value === 'string'
      ? value
      : typeof (value as { language?: unknown })?.language === 'string'
        ? ((value as { language: string }).language)
        : '';
  const code = raw.trim();
  return /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})?$/.test(code) ? code : null;
}

/** The WhatsApp Business Account id, from non-secret connection settings. */
function wabaId(config: unknown): string | null {
  const raw = jsonObject(config).whatsappBusinessAccountId;
  const id = typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : String(raw ?? '').trim();
  return /^\d{5,32}$/.test(id) ? id : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function bounded(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .slice(0, MAX_ERROR);
}
