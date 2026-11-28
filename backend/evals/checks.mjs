/**
 * What the numbers must never say.
 *
 * Every check here exists because something shipped past 931 unit tests, 481
 * frontend tests and 164 e2e specs and was still wrong on the screen. They all
 * failed the same way: the code ran correctly and produced a figure nobody
 * compared to anything. A unit test asserts the shape its author had in mind;
 * an e2e test seeds data that satisfies the code. Neither notices that Finance
 * says ₹3.23 Cr for a month in which Store Comparison says ₹73.8L.
 *
 * So these are not tests of code. They are assertions about the DATA the live
 * system is holding, run against it, and each one names the day it would have
 * earned its keep.
 *
 * Each check returns { ok, detail } and may also return `figures` for the
 * report. A check that cannot run — the table is empty, the month has no sales
 * — returns ok with a detail saying so rather than passing silently, because
 * "nothing to check" and "checked and fine" are different facts.
 */

const INR = (n) => `₹${Math.round(Number(n)).toLocaleString('en-IN')}`;
/** Figures from different code paths rarely tie to the rupee; a tenth of a percent is agreement. */
const agrees = (a, b) => {
  const big = Math.max(Math.abs(a), Math.abs(b));
  return big === 0 ? a === b : Math.abs(a - b) / big < 0.001;
};

/** Month boundaries in the chain's own clock, not the container's. */
function monthWindow(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  return { from: new Date(Date.UTC(y, m, 1)), to: new Date(Date.UTC(y, m + 1, 1)) };
}

export const CHECKS = [
  {
    id: 'revenue-agrees-across-screens',
    why:
      '27 Nov: Finance read ₹3.23 Cr for November while Store Comparison, Reporting and ' +
      'the dashboard trend all read ₹73.8L. Revenue was sales PLUS the ledger postings ' +
      'that mirror those same sales, plus branch transfers.',
    async run(prisma, org) {
      const { from, to } = monthWindow();
      const sales = await prisma.sale.aggregate({
        _sum: { totalAmount: true },
        where: { organisationId: org.id, isCancelled: false, docType: 'sale', docDate: { gte: from, lt: to } },
      });
      const byStore = await prisma.sale.groupBy({
        by: ['storeId'],
        _sum: { totalAmount: true },
        where: { organisationId: org.id, isCancelled: false, docType: 'sale', docDate: { gte: from, lt: to } },
      });
      const total = Number(sales._sum.totalAmount ?? 0);
      const summed = byStore.reduce((n, r) => n + Number(r._sum.totalAmount ?? 0), 0);
      if (total === 0) return { ok: true, detail: 'no billed sales this month yet' };
      return {
        ok: agrees(total, summed),
        detail: `org total ${INR(total)} vs per-branch ${INR(summed)} across ${byStore.length} branches`,
        figures: { total, summed },
      };
    },
  },

  {
    id: 'no-transfers-in-profit-and-loss',
    why:
      '27 Nov: ₹1.60 Cr of branch-to-branch stock movement sat inside one month of ' +
      '"Operating Expense", and the matching branch sales inside revenue. Nothing was ' +
      'earned and nothing was spent — the rings were in the same company either side of it.',
    async run(prisma, org) {
      // The sync writes the transaction type into the narration in brackets.
      const pl = await prisma.ledgerEntry.findMany({
        where: { organisationId: org.id, kind: { in: ['income', 'expense'] } },
        select: { narration: true, amount: true, kind: true },
      });
      const INTERNAL = /\((B[A-Z]*(SL|PH)|JWPH|MPH)\)\s*$/;
      const strays = pl.filter((r) => INTERNAL.test(r.narration ?? ''));
      const value = strays.reduce((n, r) => n + Number(r.amount), 0);
      return {
        ok: strays.length === 0,
        detail: strays.length
          ? `${strays.length} transfer or stock-purchase postings filed as profit and loss, ${INR(value)}`
          : `${pl.length} P&L postings, none of them internal movement`,
      };
    },
  },

  {
    id: 'stock-ageing-is-not-all-zero',
    why:
      '27 Nov: Fast vs Slow Movers reported 0 days of stock for all eight categories and ' +
      'called every one of them "Fast", including a category that had sold nothing in ' +
      'thirty days. It averaged `ageDays`, a column the Gati sync has never written.',
    async run(prisma, org) {
      const held = await prisma.stockItem.count({
        where: { organisationId: org.id, status: { in: ['in_stock', 'aging', 'dead_stock', 'reserved'] } },
      });
      if (!held) return { ok: true, detail: 'no stock on hand to age' };
      const datable = await prisma.stockItem.count({
        where: {
          organisationId: org.id,
          status: { in: ['in_stock', 'aging', 'dead_stock', 'reserved'] },
          OR: [{ inwardDate: { not: null } }, { ageDays: { not: null } }],
        },
      });
      const share = datable / held;
      return {
        ok: share > 0.5,
        detail: `${datable} of ${held} pieces can be aged (${Math.round(share * 100)}%)`,
      };
    },
  },

  {
    id: 'template-category-matches-the-provider',
    why:
      "27 Nov: Meta reclassified two templates from utility to marketing. The sync read the " +
      'new category, wrote it to a key nothing read, and the app went on sending them as ' +
      'service messages — which Meta refused, while the screen still said "Utility".',
    async run(prisma, org) {
      const rows = await prisma.integrationAsset.findMany({
        where: { organisationId: org.id, kind: 'message_template' },
        select: { name: true, metadata: true },
      });
      if (!rows.length) return { ok: true, detail: 'no templates recorded' };
      const drifted = rows.filter((r) => {
        const m = r.metadata ?? {};
        return (
          typeof m.providerCategory === 'string' &&
          typeof m.category === 'string' &&
          m.providerCategory !== m.category
        );
      });
      return {
        ok: drifted.length === 0,
        detail: drifted.length
          ? `${drifted.length} disagree with Meta: ${drifted.map((d) => d.name).join(', ')}`
          : `${rows.length} templates, every category matches Meta`,
      };
    },
  },

  {
    id: 'every-selling-branch-has-a-target',
    why:
      '27 Nov: Store Comparison footed to "7384% achieved". One sales target existed in the ' +
      'whole database — ₹1L against the one branch that had sold nothing — so eleven of ' +
      'twelve branches showed a dash and the total was meaningless.',
    async run(prisma, org) {
      const { from, to } = monthWindow();
      const selling = await prisma.sale.groupBy({
        by: ['storeId'],
        where: { organisationId: org.id, isCancelled: false, docType: 'sale', docDate: { gte: from, lt: to } },
      });
      const stores = selling.map((s) => s.storeId).filter(Boolean);
      if (!stores.length) return { ok: true, detail: 'no branch has billed this month' };
      // SalesTarget is scoped by its store, not by the organisation directly —
      // the branch it belongs to is what makes it this tenant's.
      const targets = await prisma.salesTarget.findMany({
        where: { storeId: { in: stores } },
        select: { storeId: true },
      });
      const have = new Set(targets.map((t) => t.storeId));
      const missing = stores.filter((s) => !have.has(s));
      return {
        ok: missing.length === 0,
        detail: `${stores.length - missing.length} of ${stores.length} selling branches have a target`,
      };
    },
  },

  {
    id: 'ad-threads-reach-a-branch',
    why:
      '27 Nov: an advert nobody had scripted answered a customer with four questions from a ' +
      'questionnaire that predates the campaign editor, and the thread sat at no branch and ' +
      'no owner. An enquiry an advert paid for should reach the shop that paid for it.',
    async run(prisma, org) {
      const adThreads = await prisma.conversation.count({
        where: { organisationId: org.id, audience: 'customer', sourceAdId: { not: null } },
      });
      if (!adThreads) return { ok: true, detail: 'no ad-originated threads' };
      const stranded = await prisma.conversation.count({
        where: {
          organisationId: org.id,
          audience: 'customer',
          sourceAdId: { not: null },
          storeId: null,
          assignedUserId: null,
        },
      });
      return {
        ok: stranded === 0,
        detail: `${stranded} of ${adThreads} ad threads have neither a branch nor an owner`,
      };
    },
  },

  {
    id: 'the-inbox-is-reachable-past-its-first-page',
    why:
      '24 Nov: the inbox fetched fifty threads and no control anywhere asked for the ' +
      'fifty-first, so every conversation older than that was unreachable from the screen. ' +
      'The client found the edge by reading the dates.',
    async run(prisma, org) {
      const PAGE = 50;
      const total = await prisma.conversation.count({
        where: { organisationId: org.id, audience: 'customer' },
      });
      // A cursor page is only unambiguous if the ordering has a unique tiebreak,
      // which is what `id` is for. Proven here by walking one page.
      const first = await prisma.conversation.findMany({
        where: { organisationId: org.id, audience: 'customer' },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: PAGE,
        select: { id: true },
      });
      if (total <= PAGE) return { ok: true, detail: `${total} threads, one page holds them all` };
      const next = await prisma.conversation.findMany({
        where: { organisationId: org.id, audience: 'customer' },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        cursor: { id: first[first.length - 1].id },
        skip: 1,
        take: PAGE,
        select: { id: true },
      });
      const overlap = next.filter((r) => first.some((f) => f.id === r.id)).length;
      return {
        ok: next.length > 0 && overlap === 0,
        detail: `${total} threads; page two returned ${next.length} with ${overlap} repeated`,
      };
    },
  },

  {
    id: 'customers-from-the-erp-say-so',
    why:
      "27 Nov, the client: \"all the customers coming from Gati should have a tag of GATI in " +
      'customers section." The sync tags as it writes; the party feed is watermarked, so ' +
      'anything already pulled stays untagged unless somebody backfills it.',
    async run(prisma, org) {
      const fromErp = await prisma.party.count({
        where: { organisationId: org.id, legacyId: { not: null } },
      });
      if (!fromErp) return { ok: true, detail: 'no customers from the ERP' };
      const tag = await prisma.leadTag.findFirst({
        where: { organisationId: org.id, slug: 'gati' },
        select: { id: true },
      });
      if (!tag) return { ok: false, detail: `${fromErp} customers from the ERP and no Gati tag exists` };
      const tagged = await prisma.partyTagAssignment.count({
        where: { organisationId: org.id, tagId: tag.id },
      });
      return {
        ok: tagged >= fromErp,
        detail: `${tagged} of ${fromErp} ERP customers carry the tag`,
      };
    },
  },

  {
    id: 'no-stale-business-name-on-outbound',
    why:
      'The organisation row said "Eclat" long after the rename, and every signed outbound ' +
      'message carried it. A name is the one thing in a message a customer is certain to read.',
    async run(prisma, org) {
      const settings = org.settings ?? {};
      const display = settings?.branding?.displayName ?? org.name;
      return {
        ok: !/eclat|éclat|èclat/i.test(display),
        detail: `outbound signs as "${display}"`,
      };
    },
  },
];
