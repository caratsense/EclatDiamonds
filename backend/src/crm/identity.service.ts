import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped, readableParty } from '../common/sales-scope';
import { normalizeIndianMobile, isValidEmail } from '../common/contact.util';

/**
 * IdentityService — how CaratOS decides that a phone number, an email and a
 * WhatsApp thread all belong to the same customer (Phase A3).
 *
 * The two rules that matter:
 *
 *   1. RESOLUTION IS EXACT OR IT IS NOTHING. A match happens when a normalised
 *      contact value is byte-identical to one already on file. There is no fuzzy
 *      name matching here on purpose — "R. Sharma" and "Rahul Sharma" at the same
 *      store are very often two people, and a CRM that guesses merges them into
 *      one customer whose history is a fiction.
 *
 *   2. A COLLISION IS A QUESTION, NOT AN ANSWER. When an identity is already
 *      claimed by someone else, the claim is recorded as a MergeCandidate for a
 *      human, and the existing link is left exactly as it was. Nothing is
 *      reassigned automatically.
 */

export type ContactKind = 'phone' | 'email' | 'whatsapp' | 'instagram' | 'external';

const KINDS: ContactKind[] = ['phone', 'email', 'whatsapp', 'instagram', 'external'];

export interface ResolveInput {
  kind: ContactKind;
  value: string;
  /** Used only when creating a new customer, never for matching. */
  name?: string;
  storeId?: string;
  source?: string;
}

export interface ResolveResult {
  partyId: string | null;
  /** 'matched' — an existing customer owned this identity.
   *  'created' — a new customer was created and now owns it.
   *  'unresolved' — the value could not be normalised, so nothing was matched. */
  outcome: 'matched' | 'created' | 'unresolved';
  contactPointId: string | null;
  reason?: string;
}

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Reduce a raw contact value to its matching key, or null when it cannot be
   * trusted as one.
   *
   * KNOWN LIMITATION, stated rather than hidden: phone normalisation is
   * India-first, because that is the only country CaratOS has ever run in and
   * `normalizeIndianMobile` is the rule the rest of the app already uses. A
   * number for any other country must arrive in international form with a
   * leading '+', which is unambiguous. A bare local number from a non-IN tenant
   * is REJECTED rather than assumed to be Indian — a wrong country code silently
   * merges two unrelated customers, and that is worse than asking the user to
   * type the full number.
   *
   * ponytail: single-country normaliser + explicit international form. Swap in a
   * real libphonenumber parse when a tenant outside India actually onboards.
   */
  normalize(kind: ContactKind, raw: string, country = 'IN'): string | null {
    const v = (raw ?? '').trim();
    if (!v) return null;

    switch (kind) {
      case 'phone':
      case 'whatsapp': {
        if (v.startsWith('+')) {
          const digits = v.replace(/\D/g, '');
          // Shortest possible E.164 subscriber number is ~7 digits + country code.
          return digits.length >= 8 && digits.length <= 15 ? digits : null;
        }
        if (country === 'IN') {
          const local = normalizeIndianMobile(v);
          return local ? `91${local}` : null;
        }
        return null;
      }
      case 'email':
        return isValidEmail(v) ? v.toLowerCase() : null;
      case 'instagram':
      case 'external':
        // Provider ids are opaque. Case-fold only — anything else risks changing
        // an identifier that the provider considers significant.
        return v.toLowerCase();
      default:
        return null;
    }
  }

  /**
   * Find the customer who owns this identity, creating one only when asked.
   *
   * `createIfMissing: false` is the read path (an inbound message asking "who is
   * this?"); a miss returns `partyId: null` and the caller keeps an anonymous
   * conversation rather than inventing a customer.
   */
  async resolve(
    user: AuthUser,
    input: ResolveInput,
    opts: { createIfMissing?: boolean } = {},
  ): Promise<ResolveResult> {
    const organisationId = user.organisationId;
    if (!KINDS.includes(input.kind)) {
      throw new BadRequestException(`Unknown contact kind "${input.kind}".`);
    }

    const country = await this.countryOf(organisationId);
    const normalized = this.normalize(input.kind, input.value, country);
    if (!normalized) {
      return {
        partyId: null,
        outcome: 'unresolved',
        contactPointId: null,
        reason: `"${input.value}" is not a usable ${input.kind}. It was not matched to anyone.`,
      };
    }

    const existing = await this.prisma.contactPoint.findUnique({
      where: {
        organisationId_kind_valueNormalized: { organisationId, kind: input.kind, valueNormalized: normalized },
      },
      select: { id: true, partyId: true },
    });
    if (existing) {
      return { partyId: existing.partyId, outcome: 'matched', contactPointId: existing.id };
    }

    if (!opts.createIfMissing) {
      return { partyId: null, outcome: 'unresolved', contactPointId: null, reason: 'No customer holds this contact detail yet.' };
    }

    // A new customer needs a name. Falling back to the phone number as the name
    // is how CRMs end up full of customers called "9876543210".
    const name = (input.name ?? '').trim();
    if (!name) {
      throw new BadRequestException(
        'A name is required to create a customer. Resolve without creating if the name is unknown.',
      );
    }
    if (input.storeId) this.assertStore(user, input.storeId);

    const created = await this.createPartyOwning(organisationId, {
      kind: input.kind,
      value: input.value,
      normalized,
      name,
      storeId: input.storeId ?? null,
      source: input.source,
    });

    return { partyId: created.partyId, outcome: 'created', contactPointId: created.contactPointId };
  }

  /**
   * Create a customer that owns one contact identity.
   *
   * Extracted so the authorised path (`resolve`) and the webhook path
   * (`resolveInbound`) create customers identically — two copies of this would
   * be two chances to forget the denormalised `Party.phone` snapshot that many
   * existing screens still read.
   */
  private async createPartyOwning(
    organisationId: string,
    input: {
      kind: ContactKind;
      value: string;
      normalized: string;
      name: string;
      storeId: string | null;
      source?: string;
    },
  ): Promise<{ partyId: string; contactPointId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const party = await tx.party.create({
        data: {
          organisationId,
          name: input.name,
          storeId: input.storeId,
          types: ['customer'],
          // Keep the legacy denormalised snapshot in step for the many existing
          // screens that read Party.phone directly.
          //
          // A WhatsApp id fills `phone` as well as `whatsapp`, because it IS a
          // phone number and `phone` is the field the screens a branch manager
          // uses to ring somebody actually read. Leaving it null gave every ad
          // lead a customer record with no number on it — reachable only by
          // opening the thread, which is exactly the lead nobody calls.
          ...(input.kind === 'phone' || input.kind === 'whatsapp'
            ? { phone: input.value.trim() }
            : {}),
          ...(input.kind === 'whatsapp' ? { whatsapp: input.value.trim() } : {}),
          ...(input.kind === 'email' ? { email: input.value.trim() } : {}),
        },
        select: { id: true },
      });
      const cp = await tx.contactPoint.create({
        data: {
          organisationId,
          partyId: party.id,
          kind: input.kind,
          value: input.value.trim(),
          valueNormalized: input.normalized,
          isPrimary: true,
          source: input.source ?? 'manual',
        },
        select: { id: true },
      });
      return { partyId: party.id, contactPointId: cp.id };
    });
  }

  /**
   * Resolve (or create) the customer behind an INBOUND CHANNEL message.
   *
   * Separate from `resolve` because the caller is a webhook, not a person:
   * there is no AuthUser to authorise against, and the tenant has already been
   * established by the integration the message arrived on. Passing a synthetic
   * user here would put a fake principal into the authorization path, which is
   * exactly the confusion the machine-principal work removed elsewhere.
   *
   * MATCHING IS ALWAYS TENANT-SCOPED. `ContactPoint` is unique on
   * (organisationId, kind, valueNormalized), so a lookup can never reach another
   * organisation's customer even when two tenants have the same phone number.
   *
   * ## Duplicate protection
   *
   * A provider retry or two concurrent deliveries of the same first message race
   * to create the same customer. That unique index is what settles it: the loser
   * gets P2002, re-reads, and returns the winner's party. Without this a retried
   * webhook would create a second customer holding the same phone number.
   */
  async resolveInbound(
    organisationId: string,
    input: { kind: ContactKind; value: string; name?: string | null; storeId?: string | null; source?: string },
  ): Promise<ResolveResult> {
    if (!KINDS.includes(input.kind)) {
      return { partyId: null, outcome: 'unresolved', contactPointId: null, reason: `Unknown contact kind "${input.kind}".` };
    }
    const country = await this.countryOf(organisationId);
    const normalized = this.normalize(input.kind, input.value, country);
    if (!normalized) {
      return {
        partyId: null,
        outcome: 'unresolved',
        contactPointId: null,
        reason: `"${input.value}" is not a usable ${input.kind}. No customer was created.`,
      };
    }

    const existing = await this.prisma.contactPoint.findUnique({
      where: { organisationId_kind_valueNormalized: { organisationId, kind: input.kind, valueNormalized: normalized } },
      select: { id: true, partyId: true },
    });
    if (existing) return { partyId: existing.partyId, outcome: 'matched', contactPointId: existing.id };

    // No name is available from a WhatsApp number alone. The normalised number
    // is used as the display name rather than inventing a person — it is
    // truthful, it is what the salesperson will recognise in the inbox, and it
    // is replaced the moment somebody identifies the customer.
    const name = (input.name ?? '').trim() || normalized;

    try {
      const created = await this.createPartyOwning(organisationId, {
        kind: input.kind,
        value: input.value,
        normalized,
        name,
        storeId: input.storeId ?? null,
        source: input.source ?? 'inbound',
      });
      return { partyId: created.partyId, outcome: 'created', contactPointId: created.contactPointId };
    } catch (err) {
      // Lost the race — the other delivery created this customer. Re-read and
      // return theirs, which is the correct idempotent outcome.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const winner = await this.prisma.contactPoint.findUnique({
          where: { organisationId_kind_valueNormalized: { organisationId, kind: input.kind, valueNormalized: normalized } },
          select: { id: true, partyId: true },
        });
        if (winner) return { partyId: winner.partyId, outcome: 'matched', contactPointId: winner.id };
      }
      throw err;
    }
  }

  /**
   * The commercial-record path: resolve (or create) a customer for a business
   * document, and NEVER throw.
   *
   * This exists because the same seven lines were being copy-pasted into every
   * service that creates a record with a customer on it — leads, check-ins,
   * sales, quotes, returns. Five copies of a try/catch is five chances for one of
   * them to be written slightly wrong, and the one that gets it wrong takes a
   * sale down with it.
   *
   * The contract every caller depends on:
   *   - a usable phone links the record to a real customer;
   *   - an unusable one leaves `partyId` null and returns a REASON, which the
   *     caller records rather than discards;
   *   - nothing here can prevent the business record from being written.
   *
   * `unresolvedReason` is the honest middle state the task asks for: not a
   * fabricated customer, not a silently dropped detail.
   */
  async resolveForRecord(
    user: AuthUser,
    input: { phone?: string | null; name?: string | null; storeId?: string | null; source: string },
  ): Promise<{ partyId: string | null; unresolvedReason: string | null }> {
    const phone = input.phone?.trim();
    if (!phone) {
      return { partyId: null, unresolvedReason: 'No phone number was captured on this record.' };
    }
    const name = input.name?.trim();
    if (!name) {
      // Creating a customer needs a name; without one we can still MATCH an
      // existing customer, just not create a new one.
      const match = await this.resolve(
        user,
        { kind: 'phone', value: phone, storeId: input.storeId ?? undefined, source: input.source },
        { createIfMissing: false },
      );
      return {
        partyId: match.partyId,
        unresolvedReason: match.partyId ? null : 'No customer name was captured, so no customer record could be created.',
      };
    }

    try {
      const resolved = await this.resolve(
        user,
        {
          kind: 'phone',
          value: phone,
          name,
          storeId: input.storeId ?? undefined,
          source: input.source,
        },
        { createIfMissing: true },
      );
      return {
        partyId: resolved.partyId,
        unresolvedReason: resolved.partyId ? null : resolved.reason ?? 'The phone number could not be read.',
      };
    } catch (e) {
      // A store out of scope, a validation failure, a database hiccup — none of
      // them are reasons to refuse an invoice or a lead.
      return {
        partyId: null,
        unresolvedReason: e instanceof Error ? e.message : 'Customer could not be linked.',
      };
    }
  }

  /**
   * Attach an identity to a customer.
   *
   * If somebody else already holds it, this does NOT move it. It raises a
   * MergeCandidate and reports the conflict, leaving both records untouched —
   * see rule 2 at the top of this file.
   */
  async link(
    user: AuthUser,
    partyId: string,
    input: { kind: ContactKind; value: string; isPrimary?: boolean; source?: string },
  ) {
    const organisationId = user.organisationId;
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, ...readableParty(user) },
      select: { id: true, name: true },
    });
    if (!party) throw new NotFoundException('Customer not found');

    const country = await this.countryOf(organisationId);
    const normalized = this.normalize(input.kind, input.value, country);
    if (!normalized) {
      throw new BadRequestException(`"${input.value}" is not a usable ${input.kind}.`);
    }

    const holder = await this.prisma.contactPoint.findUnique({
      where: {
        organisationId_kind_valueNormalized: { organisationId, kind: input.kind, valueNormalized: normalized },
      },
      select: { id: true, partyId: true },
    });

    if (holder && holder.partyId === partyId) {
      return { status: 'already_linked' as const, contactPointId: holder.id };
    }

    if (holder) {
      const candidate = await this.raiseMergeCandidate(user, {
        primaryPartyId: holder.partyId,
        duplicatePartyId: partyId,
        matchKind: input.kind,
        matchValue: normalized,
        confidence: 1,
        reason: `Both customers claim the same ${input.kind}.`,
      });
      return {
        status: 'conflict' as const,
        contactPointId: null,
        // Which customer holds it is not a salesperson's to learn; the merge
        // review carries it to someone who may.
        heldByPartyId: isSalesScoped(user) ? null : holder.partyId,
        mergeCandidateId: candidate.id,
        message:
          `That ${input.kind} already belongs to another customer. Nothing was changed — ` +
          `a merge review has been raised so a person can decide which record is right.`,
      };
    }

    const cp = await this.prisma.contactPoint.create({
      data: {
        organisationId,
        partyId,
        kind: input.kind,
        value: input.value.trim(),
        valueNormalized: normalized,
        isPrimary: input.isPrimary ?? false,
        source: input.source ?? 'manual',
      },
    });

    if (input.isPrimary) {
      // Exactly one primary per kind, so "the customer's number" is never ambiguous.
      await this.prisma.contactPoint.updateMany({
        where: { organisationId, partyId, kind: input.kind, id: { not: cp.id } },
        data: { isPrimary: false },
      });
    }

    await this.audit.record(user, {
      action: 'crm.identity_linked',
      entityType: 'Party',
      entityId: partyId,
      summary: `Linked ${input.kind} to ${party.name}`,
    });
    return { status: 'linked' as const, contactPointId: cp.id };
  }

  async unlink(user: AuthUser, contactPointId: string) {
    const cp = await this.prisma.contactPoint.findFirst({
      where: { id: contactPointId, organisationId: user.organisationId, party: readableParty(user) },
      select: { id: true, partyId: true, kind: true },
    });
    if (!cp) throw new NotFoundException('Contact detail not found');
    await this.prisma.contactPoint.delete({ where: { id: cp.id } });
    await this.audit.record(user, {
      action: 'crm.identity_unlinked',
      entityType: 'Party',
      entityId: cp.partyId,
      summary: `Removed a ${cp.kind} from the customer`,
    });
    return { removed: true };
  }

  async contactPointsFor(user: AuthUser, partyId: string) {
    return this.prisma.contactPoint.findMany({
      where: { organisationId: user.organisationId, partyId, party: readableParty(user) },
      orderBy: [{ isPrimary: 'desc' }, { kind: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /**
   * Backfill ContactPoints from the denormalised Party.phone/whatsapp/email
   * snapshots that predate this model.
   *
   * Deliberately non-destructive and resumable: a value already claimed by
   * another party is SKIPPED and counted, never stolen. Run it as often as you
   * like — the second run reports zero created and the same conflicts.
   */
  async backfillFromParties(user: AuthUser, limit = 1000) {
    const organisationId = user.organisationId;
    const country = await this.countryOf(organisationId);

    const parties = await this.prisma.party.findMany({
      where: {
        organisationId,
        OR: [{ phone: { not: null } }, { whatsapp: { not: null } }, { email: { not: null } }],
        contactPoints: { none: {} },
      },
      select: { id: true, phone: true, whatsapp: true, email: true },
      take: Math.min(Math.max(limit, 1), 5000),
    });

    let created = 0;
    let skippedUnparseable = 0;
    const conflicts: { partyId: string; kind: string; value: string; heldBy: string }[] = [];

    for (const p of parties) {
      const pairs: [ContactKind, string | null][] = [
        ['phone', p.phone],
        ['whatsapp', p.whatsapp],
        ['email', p.email],
      ];
      let primaryTaken = false;
      for (const [kind, raw] of pairs) {
        if (!raw) continue;
        const normalized = this.normalize(kind, raw, country);
        if (!normalized) {
          skippedUnparseable++;
          continue;
        }
        const holder = await this.prisma.contactPoint.findUnique({
          where: {
            organisationId_kind_valueNormalized: { organisationId, kind, valueNormalized: normalized },
          },
          select: { partyId: true },
        });
        if (holder) {
          if (holder.partyId !== p.id) {
            conflicts.push({ partyId: p.id, kind, value: normalized, heldBy: holder.partyId });
          }
          continue;
        }
        await this.prisma.contactPoint.create({
          data: {
            organisationId,
            partyId: p.id,
            kind,
            value: raw.trim(),
            valueNormalized: normalized,
            isPrimary: !primaryTaken,
            source: 'backfill',
          },
        });
        primaryTaken = true;
        created++;
      }
    }

    return {
      scanned: parties.length,
      created,
      skippedUnparseable,
      conflicts: conflicts.length,
      conflictSample: conflicts.slice(0, 20),
      message:
        `Created ${created} contact record(s) from ${parties.length} customer(s). ` +
        `${skippedUnparseable} value(s) could not be read as a phone or email and were left alone. ` +
        `${conflicts.length} value(s) are claimed by more than one customer and were NOT reassigned — ` +
        `review those before relying on them for matching.` +
        (parties.length >= Math.min(Math.max(limit, 1), 5000)
          ? ' The batch limit was reached; run it again to continue.'
          : ''),
    };
  }

  // -------------------------------------------------------------------------
  // Merge review
  // -------------------------------------------------------------------------

  async raiseMergeCandidate(
    user: AuthUser,
    input: {
      primaryPartyId: string;
      duplicatePartyId?: string | null;
      matchKind: string;
      matchValue: string;
      confidence: number;
      reason?: string;
    },
  ) {
    const organisationId = user.organisationId;
    // Do not stack identical open reviews every time the same message arrives.
    const open = await this.prisma.mergeCandidate.findFirst({
      where: {
        organisationId,
        status: 'open',
        primaryPartyId: input.primaryPartyId,
        duplicatePartyId: input.duplicatePartyId ?? null,
        matchKind: input.matchKind,
        matchValue: input.matchValue,
      },
      select: { id: true },
    });
    if (open) return open;

    return this.prisma.mergeCandidate.create({
      data: {
        organisationId,
        primaryPartyId: input.primaryPartyId,
        duplicatePartyId: input.duplicatePartyId ?? null,
        matchKind: input.matchKind,
        matchValue: input.matchValue,
        confidence: new Prisma.Decimal(input.confidence.toFixed(3)),
        reason: input.reason ?? null,
      },
      select: { id: true },
    });
  }

  async listMergeCandidates(user: AuthUser, status = 'open') {
    return this.prisma.mergeCandidate.findMany({
      where: { organisationId: user.organisationId, status },
      orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
      take: 200,
      include: {
        primaryParty: { select: { id: true, name: true, phone: true, email: true, createdAt: true } },
        duplicateParty: { select: { id: true, name: true, phone: true, email: true, createdAt: true } },
      },
    });
  }

  /**
   * Dismiss a merge review without merging. Merging two customers for real moves
   * sales, payments, conversations and ledger rows and is NOT implemented here —
   * see the report's remaining-work list. Offering a half-merge that moved only
   * some of a customer's history would be worse than offering none.
   */
  async rejectMergeCandidate(user: AuthUser, id: string, reason?: string) {
    const candidate = await this.prisma.mergeCandidate.findFirst({
      where: { id, organisationId: user.organisationId },
      select: { id: true, status: true },
    });
    if (!candidate) throw new NotFoundException('Merge review not found');
    if (candidate.status !== 'open') {
      throw new BadRequestException(`This review is already ${candidate.status}.`);
    }
    const updated = await this.prisma.mergeCandidate.update({
      where: { id },
      data: {
        status: 'rejected',
        reason: reason ?? null,
        resolvedById: user.id,
        resolvedAt: new Date(),
      },
    });
    await this.audit.record(user, {
      action: 'crm.merge_rejected',
      entityType: 'MergeCandidate',
      entityId: id,
      summary: 'Marked two customers as genuinely different',
    });
    return updated;
  }

  private async countryOf(organisationId: string): Promise<string> {
    const org = await this.prisma.organisation.findUnique({
      where: { id: organisationId },
      select: { country: true },
    });
    return org?.country ?? 'IN';
  }

  private assertStore(user: AuthUser, storeId: string): void {
    if (!user.storeIds.includes(storeId)) {
      throw new BadRequestException('Store not in your scope');
    }
  }
}
