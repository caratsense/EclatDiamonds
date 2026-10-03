import { BadRequestException, Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { MetaGraphClient } from '../integrations/meta-graph.client';
import { JobContext, JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { providerTemplateStatus, type ProviderTemplateStatus } from './omnichannel-policy';
import {
  TemplateDraftError,
  buildTemplatePayload,
  placeholdersIn,
  previewOf,
  type TemplateDraft,
} from './template-draft';

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
  /** HEADER / BODY / FOOTER / BUTTONS, each with its own text and examples. */
  components?: unknown;
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
          {
            // `components` carries the wording. Without it a synchronised
            // template was a name and a verdict, and the campaign wizard could
            // only offer a bare identifier to choose between — which is how
            // somebody sends the wrong one to several thousand people.
            fields: 'id,name,language,status,category,components',
            limit: PAGE_SIZE,
            ...(after ? { after } : {}),
          },
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
    // Name:language pairs this connection already holds. `externalId` is that
    // composite, so two languages of one template are two rows and discovery
    // can create the missing language without touching the one that exists.
    const localKeys = new Set(
      local
        .map((a) => templateKey(a.name, jsonObject(a.metadata).languageCode) ?? a.externalId)
        .filter(Boolean),
    );
    const languagesByName = new Map<string, string[]>();
    for (const row of provider.values()) {
      const name = cleanName(row.name);
      const language = cleanLanguage(row.language);
      if (name && language) languagesByName.set(name, [...(languagesByName.get(name) ?? []), language]);
    }

    for (const asset of local) {
      const metadata = jsonObject(asset.metadata);
      const key = templateKey(asset.name, metadata.languageCode);
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
      const name = cleanName(asset.name);
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
            /*
             * The wording, refreshed from the provider.
             *
             * Written on every sync rather than only when absent: Meta lets a
             * template's text be edited while it keeps its name, and a preview
             * that silently describes last month's version is worse than none
             * — it is what an approver reads before signing off a send.
             */
            ...(row ? previewFromComponents(row.components) : {}),
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
      const key = templateKey(name, language);
      if (!name || !language || !key || localKeys.has(key)) continue;
      const status = providerTemplateStatus(row.status);
      if (status === 'APPROVED') approved += 1;
      discovered += 1;
      localKeys.add(key);
      await this.prisma.integrationAsset.create({
        data: {
          organisationId,
          integrationId,
          kind: TEMPLATE_ASSET_KIND,
          externalId: key,
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
            ...previewFromComponents(row.components),
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

  /**
   * Write a template to Meta and record what Meta said about it.
   *
   * This is the half that did not exist. Templates could be SYNCED — read back
   * from Meta and have their verdict recorded — but never created, so every
   * template had to be typed into WhatsApp Manager by somebody with access to
   * Éclat's Business account. Which meant, in practice, that there were none:
   * the WABA holds one template, and it is the `hello_world` sample Meta ships.
   * A reminder campaign had nothing it was allowed to send.
   *
   * ## The local row is written from the RESPONSE, never from the request
   *
   * Meta decides the template's id, its status, and sometimes its category —
   * it silently re-files a template as MARKETING when the text reads like
   * marketing, whatever was asked for. Recording what we sent would make the
   * local row disagree with Meta on all three, and the disagreement would only
   * surface when a send failed. So the row is built from what came back.
   *
   * `providerStatus` lands as PENDING, and ONLY `syncNow` can ever raise it to
   * APPROVED. That rule is the whole point of this service and submission does
   * not get an exception: nothing here can authorise a send.
   */
  async submit(user: AuthUser, integrationId: string, draft: TemplateDraft) {
    const integration = await this.load(user.organisationId, integrationId);
    const account = wabaId(integration.config);
    if (!account) {
      throw new BadRequestException(
        'Set the WhatsApp Business Account id on this connection before submitting templates.',
      );
    }

    let payload;
    try {
      payload = buildTemplatePayload(draft);
    } catch (error) {
      // A draft problem is the author's to fix and is phrased for them; it is
      // not a provider failure and must not be recorded as one on the
      // integration.
      if (error instanceof TemplateDraftError) throw new BadRequestException(error.message);
      throw error;
    }

    const key = templateKey(payload.name, payload.language);
    if (!key) throw new BadRequestException('A template needs a valid name and language code.');

    /*
     * Meta rejects a duplicate name+language with a message about the API. A
     * local check first turns that into a sentence about the template, and
     * saves a review cycle on a submission that was never going to land.
     */
    const clash = await this.prisma.integrationAsset.findFirst({
      where: { integrationId, kind: TEMPLATE_ASSET_KIND, externalId: key },
      select: { id: true, metadata: true },
    });
    if (clash) {
      const status = jsonObject(clash.metadata).providerStatus;
      throw new BadRequestException(
        `A template called "${payload.name}" already exists in ${payload.language}` +
          (typeof status === 'string' ? ` and Meta reports it as ${status}` : '') +
          '. Use a different name, or delete that one at Meta first.',
      );
    }

    let response: { id?: unknown; status?: unknown; category?: unknown };
    try {
      response = await this.graph.postForIntegration(
        user.organisationId,
        integrationId,
        `${account}/message_templates`,
        payload,
        WHATSAPP_PROVIDER_CODE,
      );
    } catch (error) {
      const message = bounded(error);
      await this.prisma.integration
        .updateMany({ where: { id: integrationId, organisationId: user.organisationId }, data: { lastError: message } })
        .catch(() => undefined);
      this.logger.warn(`WhatsApp template submission failed for ${integrationId}: ${message}`);
      throw error;
    }

    const submittedAt = new Date();
    const status = providerTemplateStatus(response.status);
    const category =
      typeof response.category === 'string' ? response.category.toUpperCase() : payload.category;

    const asset = await this.prisma.integrationAsset.create({
      data: {
        organisationId: user.organisationId,
        integrationId,
        kind: TEMPLATE_ASSET_KIND,
        externalId: key,
        name: payload.name,
        isActive: true,
        // Submitted is not approved. Only syncNow may set this true.
        providerOwnershipVerified: false,
        lastVerifiedAt: submittedAt,
        lastError: `Submitted to Meta; awaiting review. Provider reports ${status}.`,
        metadata: {
          channel: 'whatsapp',
          languageCode: payload.language,
          category: category.toLowerCase(),
          approvalStatus: 'pending',
          variables: placeholdersIn(draft.body).map((n) => `{{${n}}}`),
          bodyPreview: previewOf(draft.body, draft.examples ?? []),
          recordedAt: submittedAt.toISOString(),
          providerStatus: status,
          providerSyncedAt: submittedAt.toISOString(),
          ...(typeof response.id === 'string' ? { providerTemplateId: response.id } : {}),
          submittedFromDashboard: true,
        } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true, name: true, externalId: true, metadata: true },
    });

    await this.audit.record(user, {
      action: 'omnichannel.template_submitted',
      entityType: 'IntegrationAsset',
      entityId: asset.id,
      summary: `${user.name ?? 'Head office'} submitted the WhatsApp template "${payload.name}" (${payload.language}) to Meta for review`,
      metadata: { integrationId, category, providerStatus: status },
    });

    this.logger.log(`template ${payload.name}:${payload.language} submitted -> ${status}`);

    return {
      id: asset.id,
      name: asset.name,
      languageCode: payload.language,
      category: category.toLowerCase(),
      providerStatus: status,
      providerTemplateId: typeof response.id === 'string' ? response.id : null,
      preview: previewOf(draft.body, draft.examples ?? []),
      submittedAt: submittedAt.toISOString(),
    };
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

/**
 * The readable message from a provider template's components.
 *
 * Meta returns the BODY text with its placeholders intact and, separately, the
 * sample values it was approved with. Substituting them gives the sentence a
 * customer actually receives, which is what somebody picking a template in the
 * campaign wizard needs to read — "Hi {{1}}, your order at {{2}} is ready" is
 * not a message anybody can sign off on.
 *
 * Returns an empty object rather than a null field when there is nothing to
 * say, so the caller can spread it and leave any existing preview untouched.
 */
function previewFromComponents(components: unknown): { bodyPreview?: string } {
  if (!Array.isArray(components)) return {};
  const body = components.find(
    (c) => jsonObject(c).type === 'BODY' && typeof jsonObject(c).text === 'string',
  );
  const text = body ? String(jsonObject(body).text) : '';
  if (!text.trim()) return {};

  // example.body_text is an array OF arrays: one row per example set, and Meta
  // sends one row. A template with no variables has no example block at all.
  const example = jsonObject(jsonObject(body).example);
  const rows = Array.isArray(example.body_text) ? example.body_text : [];
  const values = Array.isArray(rows[0]) ? (rows[0] as unknown[]) : [];

  const filled = text.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, digits: string) => {
    const value = values[Number(digits) - 1];
    return typeof value === 'string' && value.trim() ? value.trim() : whole;
  });

  return { bodyPreview: filled.slice(0, 2_000) };
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
