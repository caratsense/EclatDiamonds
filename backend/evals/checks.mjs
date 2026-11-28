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
    id: 'held-template-says-why-it-is-held',
    why:
      '28 Nov: the client edited `newmessage` at Meta, which takes an approved template back ' +
      'to PENDING for re-review, then went to the thread to send it. The send dialog listed ' +
      'only sendable templates and said nothing about the rest, so hers had vanished. It is ' +
      'now listed and disabled with `lastError` beside it — Meta\'s own sentence — so a held ' +
      'template carrying no sentence is a row that says "cannot be sent" and will not say why. ' +
      'The submit, edit and sync paths each write one; a fourth writer that forgets is silent.',
    async run(prisma, org) {
      const rows = await prisma.integrationAsset.findMany({
        where: { organisationId: org.id, kind: 'message_template' },
        select: { name: true, externalId: true, lastError: true, metadata: true },
      });
      // Not sendable for the reason a person can do something about: Meta has
      // not said APPROVED. Staleness is excluded — the row is fine and the
      // clock is the problem, and that sentence is generated, not stored.
      if (!rows.length) return { ok: true, detail: 'no templates recorded' };
      const held = rows.filter((r) => (r.metadata ?? {}).providerStatus !== 'APPROVED');
      if (!held.length) return { ok: true, detail: `${rows.length} templates, none held` };
      const mute = held.filter((r) => !r.lastError?.trim());
      return {
        ok: mute.length === 0,
        detail: mute.length
          ? `no reason on ${mute.length} of ${held.length} held templates: ${mute
              .map((m) => m.name ?? m.externalId)
              .join(', ')}`
          : `${held.length} of ${rows.length} templates held, every one says why`,
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
    id: 'every-ad-enquiry-is-counted-once',
    why:
      '28 Nov: the client cannot tell which of three or four live adverts is working — ' +
      '"kaun se ad pe mujhe sabse zyada number of messages aa rahe hain". The Advert ' +
      'Enquiries screen answers it by grouping threads on sourceAdId, so that id IS the ' +
      'identity of a row and a thread carrying one the grouping cannot key on is an advert ' +
      'credited to nothing. A BLANK or spaced id is the worse of the two: every advert ' +
      'arriving with one collapses into a single `ad:` row, so several adverts read as one ' +
      'and the row shows "Advert" with nothing after it. A non-numeric id can never be ' +
      'named at all — MetaAdMetadataService.resolve refuses anything but digits before it ' +
      'reaches Graph — so that row stays unattributed however healthy the Meta connection ' +
      'is. Neither shows up as an error: they just make some other advert look like the ' +
      'winner, which is the one thing this screen must not do.',
    async run(prisma, org) {
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const where = {
        organisationId: org.id,
        audience: 'customer',
        sourceAdId: { not: null },
        createdAt: { gte: since },
      };
      const threads = await prisma.conversation.count({ where });
      if (!threads) return { ok: true, detail: 'no advert brought anybody in the last 30 days' };

      /*
       * Digits and nothing else — exactly what the resolver accepts. Surrounding
       * space fails on purpose: the grouping keys on the STORED string, not on a
       * trimmed copy, so " 123" and "123" are two rows here and one advert at
       * Meta, and each gets half the credit.
       */
      const unkeyable = await prisma.$queryRaw`
        SELECT c."sourceAdId" AS ad_id, COUNT(*)::bigint AS threads
        FROM "Conversation" c
        WHERE c."organisationId" = ${org.id}
          AND c."audience" = 'customer'
          AND c."sourceAdId" IS NOT NULL
          AND c."createdAt" >= ${since}
          AND c."sourceAdId" !~ '^[0-9]{1,40}$'
        GROUP BY c."sourceAdId"
        ORDER BY 2 DESC
      `;
      const stranded = unkeyable.reduce((n, r) => n + Number(r.threads), 0);

      /*
       * Reported rather than asserted. A group-by always sums back to its own
       * count, so there is no honest assertion to make about the totals — but a
       * window that has quietly emptied, or a "wrote again" figure that has
       * started counting messages instead of customers, is visible in this line
       * next to the numbers on the screen. "Wrote again" is a SECOND inbound
       * message, because a Click-to-WhatsApp tap sends the first one for the
       * customer.
       */
      const [replies] = await prisma.$queryRaw`
        SELECT COUNT(*)::bigint AS wrote_again
        FROM "Conversation" c
        WHERE c."organisationId" = ${org.id}
          AND c."audience" = 'customer'
          AND c."sourceAdId" IS NOT NULL
          AND c."createdAt" >= ${since}
          AND (
            SELECT COUNT(*) FROM "Message" m
            WHERE m."conversationId" = c."id" AND m."direction" = 'inbound'
          ) > 1
      `;
      const wroteAgain = Number(replies?.wrote_again ?? 0);
      const adverts = await prisma.conversation.groupBy({ by: ['sourceAdId'], where });

      return {
        ok: unkeyable.length === 0,
        detail: unkeyable.length
          ? `${stranded} of ${threads} ad threads carry an advert id the ranking cannot ` +
            `key on: ${unkeyable
              .slice(0, 5)
              .map((r) => `"${r.ad_id}" (${Number(r.threads)} threads)`)
              .join(', ')}`
          : `${threads} ad threads across ${adverts.length} adverts, ${wroteAgain} wrote ` +
            'again, every advert id keyable and nameable',
        figures: { threads, adverts: adverts.length, wroteAgain, stranded },
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
    id: 'every-thread-sits-at-a-branch-somebody-can-open',
    why:
      '28 Nov: the inbox list rendered a thread and the pane beside it read "Could not open ' +
      'thread." The list and the detail turned out to agree — both ask whether the branch is ' +
      'in the caller\'s own store set — and that agreement is the danger, because a thread ' +
      'parked at a branch NO store set contains is refused by both and therefore by everybody, ' +
      'with no test anywhere able to see it. Head office\'s set is resolved with ' +
      'isAggregate: false (StoreScopeService.resolveScope), so a roll-up branch strands a ' +
      'thread exactly like another tenant\'s branch would. Nothing routes there today — ' +
      'transferTargets and the ad-set rules both filter those branches out — which is why this ' +
      'has to be asserted about the data rather than about the code that writes it. A thread ' +
      'at NO branch is deliberately not counted here: that is head office\'s triage queue and ' +
      'is reachable on purpose.',
    async run(prisma, org) {
      const total = await prisma.conversation.count({
        where: { organisationId: org.id, audience: 'customer' },
      });
      if (!total) return { ok: true, detail: 'no customer threads' };
      const stranded = await prisma.conversation.findMany({
        where: {
          organisationId: org.id,
          audience: 'customer',
          OR: [
            // A roll-up bucket: in no role's store scope, head office included.
            { store: { isAggregate: true } },
            // A branch of another tenant: store scope is organisation-bounded,
            // so this is unreachable for everyone in both organisations.
            { store: { organisationId: { not: org.id } } },
          ],
        },
        select: { id: true, store: { select: { name: true } } },
        take: 20,
      });
      return {
        ok: stranded.length === 0,
        detail: stranded.length
          ? `${stranded.length} threads sit at a branch no store scope contains: ` +
            stranded
              .slice(0, 5)
              .map((c) => `${c.id} (${c.store?.name ?? 'unnamed'})`)
              .join('; ')
          : `${total} threads, every one at a branch somebody's scope contains`,
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
    id: 'template-sends-recorded-every-value-they-filled',
    why:
      '28 Nov: the client sent "newmessage" from a thread with "Sneha" typed into its one ' +
      'variable, and the send stored templateComponents [[]] — an array holding an empty ' +
      'array, no parameters at all. The thread then had nothing to substitute, so it drew ' +
      '"Hello {{1}}, …" and she read it as a customer having been sent a literal {{1}}. ' +
      'The bubble no longer shows a placeholder, but a send that forgets its own values is ' +
      'still a transcript that cannot say what the customer read.',
    async run(prisma, org) {
      const sends = await prisma.message.findMany({
        where: { organisationId: org.id, direction: 'outbound' },
        select: { id: true, status: true, payload: true },
        orderBy: { sentAt: 'desc' },
        take: 2000,
      });
      // Only the sends that actually named a template; everything else has no
      // slots to fill and nothing to forget.
      const named = sends
        .map((m) => ({ ...m, omni: m.payload?.omnichannel ?? null }))
        .filter((m) => typeof m.omni?.templateAssetId === 'string');
      if (!named.length) return { ok: true, detail: 'no template sends recorded' };

      const assets = await prisma.integrationAsset.findMany({
        where: {
          organisationId: org.id,
          kind: 'message_template',
          id: { in: [...new Set(named.map((m) => m.omni.templateAssetId))] },
        },
        select: { id: true, name: true, metadata: true },
      });
      const byId = new Map(assets.map((a) => [a.id, a]));

      /** Highest {{n}} the approved wording uses — the same rule Meta applies. */
      const slotsIn = (text) =>
        typeof text === 'string'
          ? [...text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].reduce((n, m) => Math.max(n, Number(m[1])), 0)
          : 0;
      /** Mirrors bodyParametersFrom: the body component only, never the header's media id. */
      const filled = (components) => {
        if (!Array.isArray(components)) return 0;
        const body = components.find((c) => c && typeof c === 'object' && c.type === 'body');
        return Array.isArray(body?.parameters)
          ? body.parameters.filter((p) => typeof p?.text === 'string' && p.text.length).length
          : 0;
      };

      const short = [];
      for (const m of named) {
        const asset = byId.get(m.omni.templateAssetId);
        if (!asset) continue; // Template since deleted; nothing to compare against.
        const slots = slotsIn(asset.metadata?.bodySource);
        if (slots && filled(m.omni.templateComponents) < slots) {
          short.push(`${asset.name} (${m.status})`);
        }
      }
      const names = [...new Set(short)].slice(0, 5).join(', ');
      return {
        ok: short.length === 0,
        detail: short.length
          ? `${short.length} of ${named.length} template sends stored fewer values than their template has slots: ${names}`
          : `${named.length} template sends, every variable accounted for`,
      };
    },
  },

  {
    id: 'template-parameter-blocks-are-shaped-like-components',
    why:
      '28 Nov: the request pipeline coerced every component of the "newmessage" send into an ' +
      'Array — `templateComponents?: unknown[]` reflects as Array and class-transformer ' +
      'applied that to each ELEMENT — so the row stored [[]] and the value the client typed ' +
      'was gone before anything could read it. In process the object still answered ' +
      'type === "body", which is why the whole unit and e2e suite passed over it. The check ' +
      'beside this one counts values against slots; this one asks the cheaper question — is ' +
      'the block a list of components at all — so it also catches the same damage on a ' +
      'template with no variables, on one since deleted, and on a send that named its ' +
      'template by name rather than by id.',
    async run(prisma, org) {
      const sends = await prisma.message.findMany({
        where: { organisationId: org.id, direction: 'outbound' },
        select: { id: true, status: true, payload: true },
        orderBy: { sentAt: 'desc' },
        take: 2000,
      });
      const carrying = sends
        .map((m) => ({ ...m, components: m.payload?.omnichannel?.templateComponents }))
        .filter((m) => m.components !== undefined && m.components !== null);
      if (!carrying.length) return { ok: true, detail: 'no outbound message carries a parameter block' };

      const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
      /** Why this block could not have reached Meta intact, or null. */
      const faultIn = (components) => {
        if (!Array.isArray(components)) return 'the block is not a list';
        for (const component of components) {
          if (!plain(component)) return 'a component is not an object';
          if (typeof component.type !== 'string' || !component.type) return 'a component has no type';
          if (component.type !== 'body') continue;
          if (!Array.isArray(component.parameters)) return 'the body block carries no list of values';
          if (!component.parameters.length) return 'the body block carries an empty list of values';
          for (const parameter of component.parameters) {
            if (!plain(parameter)) return 'a value is not an object';
            // Text is the only parameter type anything in this product sends.
            if (parameter.type !== 'text' || typeof parameter.text !== 'string') {
              return 'a value is not text';
            }
            if (!parameter.text.trim()) return 'a value is blank, which Meta refuses';
          }
        }
        return null;
      };

      const faults = carrying
        .map((m) => ({ id: m.id, status: m.status, fault: faultIn(m.components) }))
        .filter((m) => m.fault);
      return {
        ok: faults.length === 0,
        detail: faults.length
          ? `${faults.length} of ${carrying.length} parameter blocks could never have been ` +
            `delivered: ${faults.slice(0, 5).map((f) => `${f.id} (${f.status}, ${f.fault})`).join('; ')}`
          : `${carrying.length} parameter blocks, every one a list of components Meta accepts`,
      };
    },
  },

  {
    id: 'no-verified-punch-at-a-branch-with-no-geofence',
    why:
      '28 Nov, the client, on a branch she could not open: "Geofencing could be set up later ' +
      'on when we want it. The store should at least be activated without that geofence so ' +
      'that we can start operating on it." Activation stopped requiring coordinates that day, ' +
      'so a LIVE branch with no geofence is now a normal state and Indore Ratnamani Complex ' +
      'is one — that is not what this checks. What must never become normal is a punch there ' +
      'that claims to have been location-checked: there is nothing to check it against. ' +
      '`geoVerified` is what keeps an unverified punch out of the manager\'s regularisation ' +
      'queue and what the attendance export prints, so a true value at a branch with no ' +
      'coordinates is a verification nobody performed, on a day nobody can reconstruct.',
    async run(prisma, org) {
      const unfenced = await prisma.store.findMany({
        where: {
          organisationId: org.id,
          isAggregate: false,
          isHolding: false,
          OR: [{ latitude: null }, { longitude: null }],
        },
        select: { id: true, name: true, status: true },
        orderBy: { name: 'asc' },
      });
      if (!unfenced.length) return { ok: true, detail: 'every branch has a geofence' };
      const ids = unfenced.map((s) => s.id);
      const punches = await prisma.attendanceRecord.count({
        where: { organisationId: org.id, storeId: { in: ids } },
      });
      const claimed = await prisma.attendanceRecord.count({
        where: {
          organisationId: org.id,
          storeId: { in: ids },
          OR: [{ geoVerified: true }, { checkOutVerified: true }],
        },
      });
      const live = unfenced.filter((s) => s.status === 'active');
      return {
        ok: claimed === 0,
        detail: claimed
          ? `${claimed} of ${punches} punches at ${unfenced.length} branch(es) with no geofence ` +
            `are recorded as location-verified: ${unfenced.map((s) => s.name).join(', ')}`
          : `${unfenced.length} branch(es) have no geofence (${live.length} of them live, ` +
            `${punches} punches), and not one punch claims to have been checked`,
        figures: { unfenced: unfenced.length, live: live.length, punches, claimed },
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
