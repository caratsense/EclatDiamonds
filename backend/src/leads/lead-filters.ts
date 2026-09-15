import { Prisma } from '@prisma/client';

/**
 * Filter fragments shared by the CRM board (GET /leads) and the Excel export, so
 * the file a manager downloads is the list they were looking at — not a second
 * interpretation of the same filter.
 */

/**
 * Leads carrying ANY of these tags.
 *
 * ANY, not ALL: "show me everything flagged potential or VIP" is the question
 * people ask. The tag must belong to the caller's organisation, so a foreign id
 * matches nothing and says nothing about whether it exists. Retired tags still
 * match — retiring takes a tag out of the picker, not off the leads that carried
 * it. Undefined for an empty list: no tags selected means every lead.
 */
export function leadTagWhere(
  organisationId: string,
  tagIds: readonly string[] | undefined,
): Prisma.LeadWhereInput | undefined {
  if (!tagIds?.length) return undefined;
  return {
    tagAssignments: { some: { tagId: { in: [...tagIds] }, tag: { organisationId } } },
  };
}

/** Free-text search over name, reference and phone digits. */
export function leadSearchWhere(q: string | undefined): Prisma.LeadWhereInput | undefined {
  const text = q?.trim();
  if (!text) return undefined;
  const or: Prisma.LeadWhereInput[] = [
    { customerName: { contains: text, mode: 'insensitive' } },
    { ref: { contains: text, mode: 'insensitive' } },
  ];
  // Only a query that is mostly a number searches phones, so "Ria" does not
  // match every number and "98123 40001" still finds 9812340001.
  const digits = text.replace(/\D/g, '');
  if (digits.length >= 4) or.push({ phone: { contains: digits } });
  return { OR: or };
}
