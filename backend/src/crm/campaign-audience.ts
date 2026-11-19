import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';

/**
 * The audience, as the database sees it.
 *
 * The preview screen and the expansion that writes the recipient rows used to
 * build this filter separately, and they drifted: the preview excluded archived
 * contacts and the expansion did not. A customer the shop had archived was
 * therefore absent from the number a manager approved and was messaged anyway —
 * the approval said one thing and the send did another, which is the worst
 * failure a broadcast screen has.
 *
 * Two lists that have to be kept in step is not a design. There is one list
 * here, and both callers reach it through the two named entry points below, so
 * a future field cannot be added to one side only.
 */

/**
 * The branches an audience may reach. `null` means every branch in the tenant;
 * an empty list is deliberately NOT the same thing and never reaches here — see
 * {@link visibleStores}.
 */
export type AudienceStoreScope = string[] | null;

export interface AudienceScope {
  organisationId: string;
  /** The compiled segment rule. Tenant-written, so nothing below may come from it. */
  compiled: Prisma.PartyWhereInput;
  storeIds: AudienceStoreScope;
}

/**
 * The tenant filter, applied AFTER compilation and never from user input.
 */
export function audienceWhere({
  organisationId,
  compiled,
  storeIds,
}: AudienceScope): Prisma.PartyWhereInput {
  const where: Prisma.PartyWhereInput = {
    organisationId,
    /*
     * An archived contact is never in an audience.
     *
     * This is the single most important exclusion of the set: a segment rule
     * is written once and re-evaluated on every send, so a contact archived
     * after the segment was built would otherwise walk back into it silently.
     * Placed here rather than in the compiled rule because the rule is the
     * tenant's, and this is not theirs to switch off.
     */
    archivedAt: null,
    AND: [compiled],
  };
  if (storeIds) {
    // A party with no branch is org-level and stays visible to anyone who can
    // see any branch — excluding it would silently drop head-office records.
    where.OR = [{ storeId: { in: storeIds } }, { storeId: null }];
  }
  return where;
}

/**
 * What the manager is counting on the preview screen: their own live branch
 * access, narrowed by anything they picked.
 */
export function previewAudienceWhere(
  user: AuthUser,
  compiled: Prisma.PartyWhereInput,
  storeIds?: string[],
): Prisma.PartyWhereInput {
  return audienceWhere({
    organisationId: user.organisationId,
    compiled,
    storeIds: visibleStores(user, storeIds),
  });
}

/**
 * Who the campaign actually messages: the branches frozen onto it when it was
 * created, not whatever access the approver happens to hold at send time.
 *
 * Branch access that changed between approval and send therefore does not move
 * the audience. That is the same promise `audienceSnapshot` makes about the
 * rules — an approver signed off on a number, and the number has to still mean
 * something when the job runs hours later.
 */
export function campaignAudienceWhere(
  campaign: { organisationId: string; storeIds: string[] },
  compiled: Prisma.PartyWhereInput,
): Prisma.PartyWhereInput {
  return audienceWhere({
    organisationId: campaign.organisationId,
    compiled,
    storeIds: campaign.storeIds.length ? campaign.storeIds : null,
  });
}

/** null = every store (org-wide role and no explicit narrowing). */
export function visibleStores(user: AuthUser, requested?: string[]): string[] | null {
  const orgWide = user.role === 'head_office' || user.role === 'area_manager';
  if (orgWide) {
    return requested?.length ? requested : null;
  }
  const own = user.storeIds ?? [];
  if (!own.length) {
    /*
     * Refused rather than returned as an empty list.
     *
     * A campaign stores [] to mean "every branch", so a branch-limited user
     * with no branch assignment would have previewed almost nobody and then
     * expanded to the whole tenant. Of all the ways the two sides can disagree
     * that is the only one that sends MORE messages than were approved.
     */
    throw new BadRequestException(
      'You are not assigned to a branch, so you cannot build an audience.',
    );
  }
  if (!requested?.length) return own;
  const intersection = requested.filter((s) => own.includes(s));
  if (!intersection.length) {
    throw new BadRequestException('You do not have access to the branches you chose.');
  }
  return intersection;
}

/**
 * Has a number worth trying.
 *
 * The cheap half of the contact rule, and deliberately a database filter: the
 * preview COUNTs it over an audience of any size, which a per-row normalisation
 * could not do without reading every customer in the tenant.
 */
export const HAS_CONTACT_POINT: Prisma.PartyWhereInput = {
  OR: [{ whatsapp: { not: null } }, { phone: { not: null } }],
};

/**
 * The number a campaign will actually message, or null.
 *
 * BOTH fields are tried, in that order. Expansion used to read
 * `whatsapp ?? phone`, which drops a customer whose WhatsApp field holds
 * something unreadable even though their phone number is perfectly good — while
 * {@link HAS_CONTACT_POINT}, which asks only whether either field is filled in,
 * counted that customer on the preview. Trying both is what makes the two
 * answers the same set.
 *
 * `normalise` is passed in rather than imported so this stays a pure function
 * the audience spec can run without a Nest container, the same way
 * `compileSegment` takes its own `now`.
 */
export function campaignContactValue(
  party: { whatsapp: string | null; phone: string | null },
  normalise: (raw: string) => string | null,
): string | null {
  for (const raw of [party.whatsapp, party.phone]) {
    if (!raw) continue;
    const value = normalise(raw);
    if (value) return value;
  }
  return null;
}
