import { PrismaClient } from '@prisma/client';

/**
 * What a customer holds, and therefore whether removing them may delete the
 * row or must archive it.
 *
 * Its own file because two callers decide the same thing and must not drift:
 * the direct head-office delete, and the approval of a deletion REQUEST raised
 * by somebody who could not delete directly. If those two ever disagreed, a
 * request would be approved on the promise of one outcome and carry out the
 * other.
 */

type Counter = Pick<
  PrismaClient,
  | 'sale' | 'ledgerEntry' | 'payment' | 'quote' | 'lead' | 'conversation'
  | 'checkIn' | 'schemeMember' | 'returnRecord' | 'loyaltyAccount'
  | 'customOrder' | 'manufacturingOrder' | 'feedbackRequest' | 'callLog'
  | 'task' | 'leadNote'
>;

/** Each kind of record a customer may hold, with the words used to report it. */
export async function partyHistory(
  prisma: Counter,
  partyId: string,
): Promise<[string, number][]> {
  const where = { where: { partyId } };
  const [
    sales, ledger, payments, quotes, leads, conversations, checkIns, schemes,
    returns, loyalty, customOrders, makingOrders, feedback, calls, tasks, notes,
  ] = await Promise.all([
    prisma.sale.count(where),
    prisma.ledgerEntry.count(where),
    prisma.payment.count(where),
    prisma.quote.count(where),
    prisma.lead.count(where),
    prisma.conversation.count(where),
    prisma.checkIn.count(where),
    prisma.schemeMember.count(where),
    prisma.returnRecord.count(where),
    prisma.loyaltyAccount.count(where),
    prisma.customOrder.count(where),
    prisma.manufacturingOrder.count(where),
    prisma.feedbackRequest.count(where),
    prisma.callLog.count(where),
    prisma.task.count(where),
    prisma.leadNote.count(where),
  ]);

  return (
    [
      ['sales', sales], ['ledger entries', ledger], ['payments', payments],
      ['quotes', quotes], ['leads', leads], ['conversations', conversations],
      ['visits', checkIns], ['scheme memberships', schemes], ['returns', returns],
      ['loyalty accounts', loyalty], ['custom orders', customOrders],
      ['manufacturing orders', makingOrders], ['feedback requests', feedback],
      ['calls', calls], ['tasks', tasks], ['notes', notes],
    ] as [string, number][]
  ).filter(([, count]) => count > 0);
}

/** "3 quotes, 1 visit" — what the approver is being asked to agree to. */
export function describeHistory(held: [string, number][]): string {
  return held.map(([word, count]) => `${count} ${word}`).join(', ');
}

/**
 * Archive or delete?
 *
 * A customer who has done nothing is a typo and may go. A customer with any
 * history is archived instead: deleting them would take the sales, payments
 * and ledger entries that reference them, and every number built on those.
 */
export function removalOutcome(held: [string, number][]): 'delete' | 'archive' {
  return held.length === 0 ? 'delete' : 'archive';
}
