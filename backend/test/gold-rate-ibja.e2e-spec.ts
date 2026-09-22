import { ConfigService } from '@nestjs/config';
import { MetalKind } from '@prisma/client';

import { parseIbja } from '../src/integrations/ibja-rates';
import { GoldRateService } from '../src/integrations/gold-rate.service';
import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * IBJA is the default gold-rate source (India Bullion and Jewellers Association,
 * ibjarates.com): per gram, ex-GST, with its publication date. A synthetic page
 * of the same shape stands in for the site — nothing here reaches it.
 */
const esc = (o: unknown) => JSON.stringify(o).replace(/"/g, '&quot;');
function page(p: { r999?: string; r916?: string; r750?: string; r585?: string; goldDay?: string; silverDay?: string; silverKg?: number } = {}) {
  const day = p.goldDay ?? '18/09/2026';
  return `<html><body>
    <span id="GoldRatesCompare999">${p.r999 ?? '15373'}</span>
    <span id="GoldRatesCompare995">15311</span>
    <span id="GoldRatesCompare916">${p.r916 ?? '14081'}</span>
    <span id="GoldRatesCompare750">${p.r750 ?? '11530'}</span>
    <span id="GoldRatesCompare585">${p.r585 ?? '8993'}</span>
    <input type="hidden" id="HdnGold" value="${esc({ labels: ['17/09/2026', day], purity999: [152000, 153727], purity916: [139000, 140814] })}" />
    <input type="hidden" id="HdnSilver" value="${esc({ labels: ['17/09/2026', p.silverDay ?? day], silverRate: [231000, p.silverKg ?? 236908] })}" />
  </body></html>`;
}

describe('parseIbja', () => {
  it('reads each published fineness per gram, the publication day, and silver per gram', () => {
    const r = parseIbja(page())!;
    expect(r.publishedOn).toBe('2026-09-18');
    expect(r.perGram).toMatchObject({ gold_24k: 15373, gold_22k: 14081, gold_18k: 11530, rose_gold_18k: 11530, gold_14k: 8993, silver: 236.91 });
    // Not published by IBJA: derived from 999 by fineness, and said so.
    expect(r.perGram.gold_9k).toBeCloseTo(15373 * 0.375, 1);
    expect(r.perGram.gold_10k).toBeCloseTo(15373 * 0.417, 1);
    expect(r.perGram.gold_12k).toBeCloseTo(15373 * 0.5, 1);
    expect(r.derived).toEqual(['gold_12k', 'gold_10k', 'gold_9k']);
  });

  it('stores nothing when the page no longer carries a believable 999 rate', () => {
    expect(parseIbja('<html>maintenance</html>')).toBeNull();
    expect(parseIbja(page({ r999: '153727' }))).toBeNull(); // a per-10g figure where per-gram belongs
    expect(parseIbja(page({ goldDay: 'yesterday' }))).toBeNull(); // no publication day, no rate
  });

  it('drops a fineness that disagrees with 999 × fineness instead of storing it', () => {
    const r = parseIbja(page({ r916: '12000' }))!;
    expect(r.perGram.gold_22k).toBeUndefined();
    expect(r.perGram.gold_24k).toBe(15373);
  });

  it('keeps silver only when it is from the same publication day', () => {
    expect(parseIbja(page({ silverDay: '17/09/2026' }))!.perGram.silver).toBeUndefined();
  });
});

describe('GoldRateService with IBJA as the default source', () => {
  // A minimal in-memory MetalRate store: enough to prove what is written.
  function fakePrisma() {
    const rows: { organisationId: string; metal: MetalKind; ratePerGram: number; effectiveFrom: Date; legacyId: string | null; legacyUpdatedAt: Date | null; storeId: null; createdAt: Date }[] = [];
    const metalRate = {
      upsert: async ({ where, create, update }: any) => {
        const hit = rows.find((r) => r.organisationId === where.organisationId_legacyId.organisationId && r.legacyId === where.organisationId_legacyId.legacyId);
        if (hit) Object.assign(hit, update);
        else rows.push({ legacyUpdatedAt: null, storeId: null, createdAt: new Date(), ...create });
      },
      create: async ({ data }: any) => void rows.push({ legacyId: null, legacyUpdatedAt: null, storeId: null, createdAt: new Date(), ...data }),
      findFirst: async ({ where }: any) =>
        rows
          .filter((r) => r.metal === where.metal && r.organisationId === where.organisationId)
          .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null,
    };
    return { rows, prisma: { metalRate } as unknown as PrismaService };
  }

  let fetchSpy: jest.SpyInstance;
  afterEach(() => {
    fetchSpy?.mockRestore();
    jest.useRealTimers();
  });
  /** Only the clock is fake; timers and promises stay real. */
  const at = (iso: string) =>
    jest.useFakeTimers({ now: new Date(iso), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

  it('stores the IBJA publication with no premium, and a re-read renews it without new rows', async () => {
    const { rows, prisma } = fakePrisma();
    const svc = new GoldRateService(new ConfigService({}), prisma);
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response(page(), { status: 200 }));

    at('2026-09-18T15:00:00+05:30'); // Friday, the day of the publication
    const r = await svc.refresh('org_x');
    expect(r.updated).toBe(true);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('https://ibjarates.com/');
    const count = rows.length;
    expect((await svc.currentRates('org_x')).find((x) => x.metal === 'gold_22k')).toMatchObject({
      ratePerGram: 14081, // IBJA as published: ex-GST, no premium on top
      source: 'ibja',
      publishedOn: '2026-09-18',
      derived: false,
      stale: false,
    });
    expect((await svc.currentRates('org_x')).find((x) => x.metal === 'gold_9k')).toMatchObject({ derived: true });

    at('2026-09-19T10:00:00+05:30'); // Saturday: IBJA publishes nothing new
    await svc.refresh('org_x');
    expect(rows.length).toBe(count);
    // Renewed, but still Friday's rate — and it says so.
    expect((await svc.currentRates('org_x')).find((x) => x.metal === 'gold_22k')).toMatchObject({
      ratePerGram: 14081,
      publishedOn: '2026-09-18',
      stale: true,
    });
  });

  it('keeps the last stored rate when IBJA cannot be read', async () => {
    const { rows, prisma } = fakePrisma();
    const svc = new GoldRateService(new ConfigService({}), prisma);
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('<html>changed</html>', { status: 200 }));
    expect(await svc.refresh('org_x')).toMatchObject({ updated: false });
    expect(rows).toHaveLength(0);
  });
});
