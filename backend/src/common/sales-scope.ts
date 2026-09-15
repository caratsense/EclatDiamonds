import { Prisma } from '@prisma/client';

import { AuthUser } from './auth-user';

/**
 * A salesperson's book of work.
 *
 * Store scope answers "which branch"; this answers "whose". At a branch with
 * eight salespeople, store scope alone let every one of them read, re-price and
 * message every other's customers — and page through the branch's phone numbers.
 * A salesperson works what is theirs: the leads they own, the conversations
 * assigned to them, the visits they served, the quotes assigned to them, the
 * tasks put on them — and the customers behind those. Everything else reaches
 * them only by a manager assigning it (the queue and round-robin flows), which is
 * the point: an unassigned enquiry is not first-come-first-served.
 *
 * Managers and head office are unaffected; machines never carry this role.
 */
export function isSalesScoped(user: Pick<AuthUser, 'role' | 'isMachine'>): boolean {
  return user.role === 'salesperson' && !user.isMachine;
}

/** Customers this person is working with, by any of the records above. */
export function partyWorkedBy(userId: string): Prisma.PartyWhereInput {
  return {
    OR: [
      { leads: { some: { ownerId: userId } } },
      { conversations: { some: { assignedUserId: userId, audience: 'customer' } } },
      { checkIns: { some: { OR: [{ repId: userId }, { attendedById: userId }] } } },
      { quotes: { some: { assignedRepId: userId } } },
      { tasks: { some: { assigneeId: userId } } },
    ],
  };
}

/**
 * Parties this caller may read by id: their organisation, and — for a
 * salesperson — only the customers they are working with.
 */
export function readableParty(user: AuthUser): Prisma.PartyWhereInput {
  return isSalesScoped(user)
    ? { organisationId: user.organisationId, ...partyWorkedBy(user.id) }
    : { organisationId: user.organisationId };
}
