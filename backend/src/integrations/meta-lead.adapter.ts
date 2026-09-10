import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../common/auth-user';
import { AdvancedCrmService } from '../crm/advanced-crm.service';
import { IdentityService } from '../crm/identity.service';
import { AttributionService } from '../crm/attribution.service';
import { AdSetRulesService } from '../crm/adset-rules.service';
import { ActivityService } from '../crm/activity.service';
import { SequenceService } from '../common/sequence.service';
import type { MetaLeadRecord, MetaLeadSink, MetaLeadSinkResult } from './meta-contracts';
import { MetaLeadAdsService } from './meta-lead-ads.service';

/** Cap on how much provider form data we retain per lead. */
const MAX_RETAINED_FIELDS = 40;
const MAX_FIELD_NAME = 120;
const MAX_FIELD_VALUE = 500;

/** Form questions we understand well enough to promote to real columns. */
const KNOWN_FIELD_NAMES = new Set([
  'full_name', 'fullname', 'name', 'first_name', 'firstname', 'last_name', 'lastname',
  'phone_number', 'phone', 'mobile_number', 'mobile',
  'email', 'email_address',
  'city', 'state', 'province', 'country', 'zip_code', 'post_code', 'street_address',
  'company_name', 'job_title',
]);

/**
 * Turns a verified Meta Lead Ads submission into CRM records.
 *
 * ## Why this file exists at all
 *
 * `MetaLeadAdsService` fetched the lead, re-checked Page ownership and then
 * handed it to a sink that nobody ever registered — so every Lead Ads job threw
 * "Meta Lead Ads CRM sink is not registered" and dead-lettered after five
 * attempts. The provider half was complete; this is the CRM half.
 *
 * ## What it deliberately does NOT do
 *
 * It performs no provider I/O, resolves no tenant and verifies no signature.
 * All three happened before the record reached here: the webhook verified the
 * signature over the raw body, persisted the event, and resolved the tenant from
 * a Page asset the tenant owns. `MetaLeadRecord.organisationId` is therefore
 * already server-resolved, and nothing in this file reads a tenant from
 * provider data.
 *
 * ## Idempotency
 *
 * `originKey = meta_lead:<leadgenId>` under the existing unique index on
 * (organisationId, originKey) is the real protection, not the lookup that
 * precedes it. Meta redelivers webhooks, the job retries, and two deliveries can
 * race — all three end at the same lead, because the second create loses on the
 * index and returns the winner.
 */
@Injectable()
export class MetaLeadAdapter implements MetaLeadSink, OnModuleInit {
  private readonly logger = new Logger(MetaLeadAdapter.name);

  constructor(
    private readonly leadAds: MetaLeadAdsService,
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
    private readonly attribution: AttributionService,
    private readonly adSetRules: AdSetRulesService,
    private readonly activity: ActivityService,
    private readonly sequence: SequenceService,
    private readonly advanced: AdvancedCrmService,
  ) {}

  onModuleInit(): void {
    this.leadAds.registerSink(this);
  }

  async acceptMetaLead(lead: MetaLeadRecord): Promise<MetaLeadSinkResult> {
    const originKey = `meta_lead:${lead.leadgenId}`;

    // Fast path for a redelivery. Not the concurrency guard — the unique index
    // below is — but it saves an identity write on the common case.
    const seen = await this.prisma.lead.findFirst({
      where: { organisationId: lead.organisationId, originKey },
      select: { id: true },
    });
    if (seen) {
      return { accepted: true, duplicate: true, leadId: seen.id };
    }

    /*
     * Routing decides the store, and only a rule may decide it.
     *
     * A Lead requires a store and a store must never be guessed: filing a
     * Bengaluru enquiry against the Delhi branch is worse than filing it
     * nowhere, because Delhi will not chase it and Bengaluru will never see it.
     * With no matching rule the lead is still created — against the tenant's
     * default store if one is configured — and left unassigned rather than
     * pushed to an arbitrary branch.
     */
    const route = await this.adSetRules.resolve(lead.organisationId, {
      ...(lead.adId ? { adId: lead.adId } : {}),
      ...(lead.adSetId ? { adSetId: lead.adSetId } : {}),
      ...(lead.adSetName ? { adSetName: lead.adSetName } : {}),
    });

    const storeId = route?.storeId ?? (await this.defaultStoreId(lead.organisationId));
    if (!storeId) {
      // Honest refusal. The job stays visible and retryable rather than being
      // acknowledged as a success that wrote nothing.
      return {
        accepted: false,
        reason:
          'No ad-set routing rule matched and the organisation has no store to file the lead against.',
      };
    }

    // Identity through the existing CRM contract, so a Meta lead resolves to the
    // same customer as their WhatsApp thread rather than a second record.
    const identity = await this.resolveIdentity(lead, storeId);

    const custom = this.retainedFields(lead);
    const seq = await this.sequence.next('LD:global');

    let leadId: string;
    try {
      const created = await this.prisma.lead.create({
        data: {
          organisationId: lead.organisationId,
          ref: `LD-${5000 + seq}`,
          storeId,
          partyId: identity.partyId,
          customerName: lead.fullName ?? 'Meta lead',
          phone: lead.phone,
          // Lead has no email column by design — an email address is a
          // ContactPoint on the Party, which is where `resolveIdentity` above
          // has already put it. Duplicating it here would create a second copy
          // that nothing keeps in step.
          // The honest source. Not `instagram` (that is the organic channel) and
          // not `website`.
          source: 'meta_ads',
          originKey,
          ...(route?.assignedUserId ? { ownerId: route.assignedUserId } : {}),
          ...(custom.length
            ? { attributes: { metaLeadForm: custom } as Prisma.InputJsonValue }
            : {}),
        },
        select: { id: true },
      });
      leadId = created.id;
    } catch (err) {
      // Lost the race with a concurrent delivery of the same leadgen id.
      // Returning theirs IS the correct outcome.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.lead.findFirst({
          where: { organisationId: lead.organisationId, originKey },
          select: { id: true },
        });
        if (!winner) throw err;
        return { accepted: true, duplicate: true, leadId: winner.id };
      }
      throw err;
    }

    /*
     * Measured attribution. Only identifiers Meta actually returned are written:
     * an absent campaign id stays null rather than becoming 'organic' or a
     * placeholder, because a fabricated id is indistinguishable from a real one
     * once it is in the table.
     */
    await this.attribution.recordTouch(lead.organisationId, {
      leadId,
      partyId: null,
      channel: 'ad',
      source: 'meta_ads',
      medium: 'lead_form',
      externalCampaignId: lead.campaignId,
      externalAdSetId: lead.adSetId,
      externalAdId: lead.adId,
      clickId: null,
      evidence: 'measured',
      dedupeKey: `meta_lead:${lead.organisationId}:${lead.leadgenId}`,
      metadata: {
        leadgenId: lead.leadgenId,
        pageId: lead.pageId,
        formId: lead.formId,
        adName: lead.adName,
        adSetName: lead.adSetName,
        campaignName: lead.campaignName,
        submittedAt: lead.createdAt?.toISOString() ?? null,
      } as Prisma.InputJsonValue,
    });

    await this.activity.record({
      organisationId: lead.organisationId,
      storeId,
      partyId: identity.partyId,
      type: 'lead.created',
      // No customer name, phone or email in the summary line.
      summary: `Lead captured from a Meta lead form${route ? ` via rule "${route.ruleName}"` : ''}`,
      entityType: 'Lead',
      entityId: leadId,
      channel: 'meta_ads',
      sourceSystem: 'provider',
      dedupeKey: `meta_lead_activity:${lead.leadgenId}`,
      metadata: {
        leadgenId: lead.leadgenId,
        formId: lead.formId,
        ruleId: route?.ruleId ?? null,
        assigned: Boolean(route?.assignedUserId),
      } as Prisma.InputJsonValue,
    });

    /*
     * Put the lead in the branch's fair queue when the rule did not name an
     * owner.
     *
     * A routing rule may legitimately choose a store and leave the assignee to
     * the queue. Before this, that lead stayed unowned while a QR scan or an ad
     * click into the same branch was assigned immediately — three doors, three
     * different outcomes for the same enquiry. Nobody chased the Meta ones
     * because nobody's name was on them.
     *
     * After the activity record and outside the create: a lead that exists and
     * is unassigned is a far better outcome than a Meta webhook retried because
     * the tenant has no eligible salesperson. `autoAssignLead` swallows its own
     * failures and is idempotent on an already-owned lead, so a redelivery
     * cannot reassign one.
     */
    const assigned = route?.assignedUserId
      ? null
      : await this.advanced.autoAssignLead(lead.organisationId, leadId);

    // Identifiers only — never the form answers, the name, the phone or the email.
    this.logger.log(
      `Meta lead ${lead.leadgenId} filed as ${leadId} (store ${storeId}` +
        `${route ? `, rule ${route.ruleId}` : ', unrouted'}` +
        `${assigned ? `, queued to ${assigned.assignedUserId}` : ''})`,
    );

    return { accepted: true, duplicate: false, leadId };
  }

  /**
   * Resolve or create the customer through the CRM's own identity contract.
   *
   * Phone first, then email: a phone number is the identity the rest of the
   * product can actually act on (WhatsApp, a call), and it is what an inbound
   * message will match on later. Ambiguity is never resolved by merging here —
   * `resolveInbound` returns its own outcome and any duplicate it surfaces stays
   * a merge candidate for a human.
   */
  private async resolveIdentity(
    lead: MetaLeadRecord,
    storeId: string,
  ): Promise<{ partyId: string | null }> {
    let partyId: string | null = null;

    // First identity wins the party. Phone leads because it is the identity the
    // rest of the product can act on — a WhatsApp thread, a call — and it is
    // what a later inbound message matches on.
    for (const [kind, value] of [
      ['phone', lead.phone],
      ['email', lead.email],
    ] as const) {
      if (!value) continue;
      try {
        const resolved = await this.identity.resolveInbound(lead.organisationId, {
          kind,
          value,
          name: lead.fullName ?? null,
          storeId,
          source: 'meta_ads',
        });
        if (resolved.partyId) {
          partyId = resolved.partyId;
          break;
        }
      } catch (err) {
        // An unusable contact value must not lose the lead. The lead is still
        // created; it simply has no linked customer yet.
        this.logger.warn(
          `Meta lead ${lead.leadgenId}: ${kind} could not be resolved to a customer` +
            ` (${err instanceof Error ? err.message : 'unknown error'})`,
        );
      }
    }

    /*
     * Attach the remaining contact details to that same party.
     *
     * Without this, a form that captured both a phone and an email produced a
     * customer reachable only by phone — the email was resolved away and
     * dropped, so a later email enquiry from the same person opened a second
     * customer record.
     *
     * `link()` is used rather than a second `resolveInbound` precisely because
     * it refuses to steal an identity: if the email already belongs to a
     * DIFFERENT party it raises a merge candidate for a human instead of
     * silently merging two customers.
     */
    if (partyId) {
      for (const [kind, value] of [
        ['phone', lead.phone],
        ['email', lead.email],
      ] as const) {
        if (!value) continue;
        try {
          await this.identity.link(this.principal(lead.organisationId), partyId, {
            kind,
            value,
            source: 'meta_ads',
          });
        } catch (err) {
          this.logger.warn(
            `Meta lead ${lead.leadgenId}: ${kind} not linked to the customer` +
              ` (${err instanceof Error ? err.message : 'unknown error'})`,
          );
        }
      }
    }

    return { partyId };
  }

  /**
   * A principal that is a tenant and nothing more.
   *
   * A Lead Ads webhook has no signed-in user — the caller is a provider. This
   * carries the organisation and no store scope at all, mirroring the pattern
   * `KnowledgeRetrievalService` already uses for the assistant's webhook path.
   * Every identity call below filters on `organisationId`, so this is exactly as
   * wide as it needs to be; if a later change starts reading store scope off the
   * principal, this one has none and the call fails closed rather than quietly
   * reaching every branch.
   */
  private principal(organisationId: string): AuthUser {
    return {
      id: 'system-meta-lead-ads',
      name: 'Meta Lead Ads',
      email: 'system@caratos.local',
      role: Role.head_office,
      organisationId,
      storeIds: [],
      allStores: false,
    };
  }

  /**
   * Unknown form answers, kept bounded and inert.
   *
   * Retained so a tenant can still read what their own form asked, but as
   * NAMED DATA inside one JSON column — never spread onto the record, which
   * would let an arbitrary provider key mass-assign a database field. Known
   * fields are already promoted to real columns and are dropped here rather
   * than stored twice.
   */
  private retainedFields(lead: MetaLeadRecord): { name: string; values: string[] }[] {
    return lead.fields
      .filter((f) => !KNOWN_FIELD_NAMES.has(f.name.toLowerCase()))
      .slice(0, MAX_RETAINED_FIELDS)
      .map((f) => ({
        name: f.name.slice(0, MAX_FIELD_NAME),
        values: f.values.slice(0, 10).map((v) => String(v).slice(0, MAX_FIELD_VALUE)),
      }));
  }

  /**
   * The tenant's single real store, when it has exactly one.
   *
   * Returns null the moment there is a choice to make. A one-branch tenant has
   * no ambiguity to resolve; a multi-branch tenant does, and picking for them is
   * the mis-filing this guards against.
   */
  private async defaultStoreId(organisationId: string): Promise<string | null> {
    const stores = await this.prisma.store.findMany({
      where: { organisationId, isAggregate: false, status: { not: 'closed' } },
      select: { id: true },
      take: 2,
    });
    return stores.length === 1 ? stores[0].id : null;
  }
}
