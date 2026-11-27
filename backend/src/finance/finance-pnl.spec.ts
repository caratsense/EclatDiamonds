import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { FinanceService } from './finance.service';

/**
 * What the Finance cards are allowed to say.
 *
 * Two defects shipped together on this screen and the screen printed its own
 * proof. On 27 Nov it read: revenue ₹3.23 Cr, gross margin ₹77.49L, operating
 * expense ₹2.46 Cr, EBITDA −₹1.68 Cr.
 *
 *   - ₹3.23 Cr was sales PLUS the ledger's income postings, which are the
 *     double-entry mirror of those same sales plus branch-to-branch transfers.
 *     Every other screen said ₹73.8L for that month.
 *   - −₹1.68 Cr was gross profit minus the expenses a second time.
 *
 * Both are arithmetic over two aggregates, so both are testable without a
 * database — which is the point, because a number this wrong went unnoticed
 * precisely because nothing asserted it.
 */

function financeWith(sales: number, expense: number): FinanceService {
  const prisma = {
    sale: { aggregate: async () => ({ _sum: { totalAmount: sales } }) },
    ledgerEntry: {
      aggregate: async ({ where }: { where: { kind: string } }) => ({
        _sum: { amount: where.kind === 'expense' ? expense : 0 },
      }),
    },
  };
  const scope = {
    effectiveStoreIds: () => ['mumbai-bandra'],
    resolveTimezone: async () => 'Asia/Kolkata',
  } as unknown as StoreScopeService;
  return new FinanceService(prisma as never, scope, undefined as never);
}

const user: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: 'org_eclat',
  storeIds: ['mumbai-bandra'],
  allStores: true,
};

const valueOf = (cards: { id: string; value: number }[], id: string) =>
  cards.find((c) => c.id === id)?.value;

describe('the Finance P&L cards', () => {
  it('counts revenue as what was billed, and not the ledger mirror of it', async () => {
    const rows = (await financeWith(7_384_459, 0).summary(user)) as {
      id: string;
      value: number;
    }[];
    // The Sale table alone — the same basis Store Comparison and Reporting use,
    // so the three screens reconcile instead of disagreeing fourfold.
    expect(valueOf(rows, 'revenue')).toBe(7_384_459);
  });

  it('does not subtract the expenses twice', async () => {
    const rows = (await financeWith(10_000_000, 2_000_000).summary(user)) as {
      id: string;
      value: number;
    }[];
    expect(valueOf(rows, 'opex')).toBe(2_000_000);
    expect(valueOf(rows, 'gross')).toBe(8_000_000);
    // The bug returned 6,000,000 here: gross profit less the same expenses
    // again. With one expense bucket and no COGS modelled, EBITDA IS gross
    // profit, and saying so beats manufacturing a difference.
    expect(valueOf(rows, 'ebitda')).toBe(8_000_000);
  });

  it('never reports a loss out of a month that only earned', async () => {
    const rows = (await financeWith(7_384_459, 0).summary(user)) as {
      id: string;
      value: number;
    }[];
    expect(valueOf(rows, 'ebitda')).toBeGreaterThan(0);
  });
});
