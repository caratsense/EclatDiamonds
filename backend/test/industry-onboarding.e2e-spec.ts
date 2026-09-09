import * as fs from 'fs';
import * as path from 'path';

import { Prisma } from '@prisma/client';

import {
  DEFAULT_PACK_CODE,
  getPack,
  INDUSTRY_PACKS,
  listPacks,
} from '../src/config/industry-packs/packs';
import {
  labelsFor,
  lexiconFor,
  MAX_LEXICON_TERM,
  NEUTRAL_LEXICON,
  REWRITABLE_LABELS,
} from '../src/config/industry-packs/lexicon';
import { provisionIndustryPack } from '../src/config/industry-packs/provision';
import {
  capabilityForPath,
  familyForPath,
  GATED_CAPABILITIES,
  packAllows,
  packMaintainsMetalRates,
  ROUTE_FAMILIES,
} from '../src/config/entitlements';

/**
 * Industry packs: what a tenant gets, and what a tenant must never get.
 *
 * These are pure unit tests over the pack definitions and the provisioning
 * function — no database, no HTTP. The behaviour they guard is decided entirely
 * in code, so testing it in code is both faster and stricter than driving it
 * through an API. The database-facing half lives in tenant-config.e2e-spec.ts.
 */

/** Every pack code, so a new pack cannot quietly skip the per-pack sweeps. */
const ALL_CODES = Object.keys(INDUSTRY_PACKS);

/**
 * The five industries the product owner named as the acceptance set, plus the
 * two that must stay neutral. Listed explicitly rather than derived: if someone
 * deletes the healthcare pack, this array should fail to resolve, not silently
 * test one pack fewer.
 */
const MUST_PROVISION = [
  'healthcare',
  'manufacturing',
  'textile',
  'retail',
  'other_services',
] as const;

/**
 * Screens that belong to Eclat's jewellery operations. Not one of them may
 * appear in a non-jewellery pack's navigation.
 *
 * Asserted ONE AT A TIME below. The previous version of this file wrote
 * `expect(nav).not.toEqual(expect.arrayContaining([...all of them]))`, which
 * fails only when the array contains EVERY listed route — so a pack that leaked
 * `finance` alone, or all but one, passed. That is the exact regression this
 * list exists to catch, and it was invisible.
 */
const JEWELLERY_ONLY_ROUTES = [
  'dashboards',
  'reporting',
  'store-comparison',
  'quotation',
  'returns',
  'discounts',
  'loyalty',
  'sales-performance',
  'inventory',
  'stock-transfers',
  'payments',
  'finance',
  'new-store',
  'marketing',
  'approvals',
  'requests',
  'ticketing',
  'settings/rates',
  'settings/targets',
] as const;

/** The universal suite every industry gets, jewellery included. */
const UNIVERSAL_ROUTES = [
  'crm',
  'conversations',
  'customers',
  'reminders',
  'catalogue',
  'checkins',
  'hrms',
  'settings/onboarding',
  'settings/stores',
  'settings/team',
  'settings/configuration',
  'data',
  'settings/integrations',
  'settings/audit',
] as const;

describe('industry packs — the catalogue', () => {
  it('offers every advertised industry exactly once, with a neutral default', () => {
    const codes = listPacks().map((pack) => pack.code);
    expect(codes.sort()).toEqual(
      [
        'automotive',
        'education',
        'financial_services',
        'healthcare',
        'hospitality',
        'jewellery',
        'logistics',
        'manufacturing',
        'other_services',
        'pharmacy',
        'professional_services',
        'real_estate',
        'retail',
        'technology',
        'textile',
        'wholesale_distribution',
      ].sort(),
    );
    // Not `arrayContaining`: an exact set, so a pack added without a test, or
    // one silently dropped, both fail here. (A duplicate-code check used to sit
    // below this line; the exact comparison above already makes it unfailable.)
    expect(getPack(DEFAULT_PACK_CODE)).toBeDefined();
  });

  it('gives every pack a usable onboarding profile', () => {
    for (const pack of Object.values(INDUSTRY_PACKS)) {
      expect(pack.onboarding).toBeDefined();
      expect(pack.onboarding!.aiCrmContext.length).toBeGreaterThan(20);
      expect(pack.onboarding!.qualificationFields.length).toBeGreaterThan(0);
      // Three stages, bridged to the LeadStage enum the existing reports read.
      expect(pack.onboarding!.pipeline.stages.map((s) => s.systemValue)).toEqual([
        'inquiry',
        'quotation',
        'order_placed',
      ]);
      expect(pack.onboarding!.pipeline.stages.map((s) => s.outcome)).toEqual([
        'open',
        'open',
        'won',
      ]);
      // Stage labels are the pack's own words; only the bridge is shared.
      expect(new Set(pack.onboarding!.pipeline.stages.map((s) => s.label)).size).toBe(3);
    }
  });
});

describe('industry packs — navigation', () => {
  it.each(ALL_CODES)('%s enables the whole universal suite', (code) => {
    const nav = getPack(code)!.onboarding!.enabledNavigation;
    for (const route of UNIVERSAL_ROUTES) {
      expect(nav).toContain(route);
    }
  });

  it.each(ALL_CODES.filter((c) => c !== 'jewellery'))(
    '%s exposes no jewellery operations screen',
    (code) => {
      const nav = getPack(code)!.onboarding!.enabledNavigation;
      // One assertion per route. A leak of a single screen fails, and the
      // message names which one.
      for (const route of JEWELLERY_ONLY_ROUTES) {
        expect(nav).not.toContain(route);
      }
      // And nothing beyond the universal suite at all.
      expect([...nav].sort()).toEqual([...UNIVERSAL_ROUTES].sort());
    },
  );

  /**
   * The Eclat guarantee, checked against the frontend rather than against a
   * copy of it.
   *
   * "Preserve every existing Eclat route" cannot be proven by a list written in
   * this file — that list would just agree with itself. So the navigation
   * source is read and its slugs extracted. If someone adds a nav item and
   * forgets the jewellery pack, Eclat would silently lose that item the first
   * time its pack were applied; this fails instead.
   */
  /*
   * Deployment reality: the backend is built and deployed on its own
   * (root_dir=backend), where `frontend/` does not exist and this would be an
   * ENOENT rather than a comparison. It is skipped there — but by name, in the
   * report, so a run that quietly stops checking the Eclat guarantee is visible
   * rather than silent.
   */
  const NAV_SOURCE = path.join(__dirname, '..', '..', 'frontend', 'src', 'lib', 'navigation.ts');
  const withFrontend = fs.existsSync(NAV_SOURCE) ? it : it.skip;

  withFrontend('jewellery covers every route the frontend navigation defines', () => {
    const navSource = fs.readFileSync(NAV_SOURCE, 'utf8');
    const slugs = [...navSource.matchAll(/^\s+slug: "([^"]+)"/gm)].map((m) => m[1]);

    // A sanity floor: if the regex ever stops matching, fail loudly here rather
    // than passing an empty comparison.
    expect(slugs.length).toBeGreaterThan(25);
    expect(new Set(slugs).size).toBe(slugs.length);

    const jewellery = getPack('jewellery')!.onboarding!.enabledNavigation;
    expect([...jewellery].sort()).toEqual([...slugs].sort());
    expect(getPack('jewellery')!.version).toBe(1);
  });
});

describe('industry packs — entitlement registry', () => {
  /*
   * The registry in config/entitlements.ts classifies EVERY controller in the
   * application, not just the ones to block. The test that makes that claim true
   * is the enumeration below: it reads the source tree, so a controller added
   * without a verdict fails here rather than quietly becoming universal.
   */

  /** Every `@Controller('…')` prefix declared anywhere in src/. */
  function declaredControllerPrefixes(): { prefix: string; file: string }[] {
    const srcRoot = path.join(__dirname, '..', 'src');
    const found: { prefix: string; file: string }[] = [];

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.controller.ts')) continue;
        const source = fs.readFileSync(full, 'utf8');
        for (const match of source.matchAll(/@Controller\(\s*['"]([^'"]*)['"]/g)) {
          found.push({
            prefix: `/${match[1].replace(/^\/+/, '')}`,
            file: path.relative(srcRoot, full).replace(/\\/g, '/'),
          });
        }
      }
    };
    walk(srcRoot);
    return found;
  }

  it('classifies every controller in the application', () => {
    const declared = declaredControllerPrefixes();
    // A guard on the guard: if this ever finds nothing, the walk is broken and
    // every assertion below would pass vacuously.
    expect(declared.length).toBeGreaterThan(40);

    const unclassified = declared
      .filter((c) => familyForPath(c.prefix) === null)
      .map((c) => `${c.prefix} (${c.file})`);

    // If this fails, add the controller to ROUTE_FAMILIES with either a
    // capability or an explicit `capability: null` and a reason. Do not delete
    // the assertion: an unclassified vertical controller is reachable by every
    // industry, which is the hole this whole registry exists to close.
    expect(unclassified).toEqual([]);
  });

  it('gives every registry entry a reason a human can review', () => {
    for (const family of ROUTE_FAMILIES) {
      expect(family.prefix.startsWith('/')).toBe(true);
      expect(family.why.length).toBeGreaterThan(15);
    }
    // No duplicate prefixes: two entries for one path means one of them is dead
    // and nobody knows which.
    const prefixes = ROUTE_FAMILIES.map((f) => f.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('demands only capabilities that are real navigation slugs', () => {
    const known = new Set(
      Object.values(INDUSTRY_PACKS).flatMap((p) => p.onboarding?.enabledNavigation ?? []),
    );
    for (const capability of GATED_CAPABILITIES) {
      expect(known).toContain(capability);
    }
  });

  it('never gates a route the universal suite depends on', () => {
    // If any of these ever resolved to a capability, every non-jewellery tenant
    // would lose a module the product promises to every industry.
    for (const path of [
      '/config/bootstrap',
      '/auth/login',
      '/crm/conversations',
      '/crm/customers',
      '/parties',
      '/products',
      '/products/jewelry/similarity-search',
      '/hrms/attendance',
      '/checkins',
      '/leads',
      '/stores',
      '/users',
      '/audit',
      '/imports/preview',
      '/integration/connect/agents',
      '/integrations',
      '/integrations/whatsapp/send',
      '/notifications',
      '/search',
      '/onboarding/tour',
      '/knowledge',
    ]) {
      expect(capabilityForPath(path)).toBeNull();
    }
  });

  it('gates each vertical module, and matches on whole segments only', () => {
    expect(capabilityForPath('/finance')).toBe('finance');
    expect(capabilityForPath('/finance/ledger?from=2026-01-01')).toBe('finance');
    expect(capabilityForPath('/loyalty/schemes')).toBe('loyalty');
    // Longest prefix wins: /stock-transfers is its own module, not /stock.
    expect(capabilityForPath('/stock')).toBe('inventory');
    expect(capabilityForPath('/stock-transfers')).toBe('stock-transfers');
    expect(capabilityForPath('/stock-transfers/abc/dispatch')).toBe('stock-transfers');
    // Order timelines are reached from the quotation screen and gate with it.
    expect(capabilityForPath('/timelines/orders')).toBe('quotation');
    // The one jewellery screen inside an otherwise universal controller.
    expect(capabilityForPath('/integrations/gold-rate')).toBe('settings/rates');
    expect(capabilityForPath('/integrations/gold-rate/refresh')).toBe('settings/rates');
    // …and its neighbour, one character different, is not that screen.
    expect(capabilityForPath('/integrations-registry')).toBeNull();
    // Segment boundary: a longer word starting with a gated prefix is not gated.
    expect(capabilityForPath('/salesforce-webhook')).toBeNull();
    expect(capabilityForPath('/financeer')).toBeNull();
  });

  it('lets jewellery reach every gated module, and no other pack reach any', () => {
    for (const capability of GATED_CAPABILITIES) {
      expect(packAllows('jewellery', capability)).toBe(true);
      expect(packAllows('healthcare', capability)).toBe(false);
      expect(packAllows('manufacturing', capability)).toBe(false);
    }
  });

  it('fails CLOSED on a vertical capability when the pack cannot be resolved', () => {
    // An organisation with no pack applied, or one this release does not ship,
    // is refused a VERTICAL module: the honest answer to "does their industry
    // include Finance?" when we cannot tell is no.
    expect(packAllows(null, 'finance')).toBe(false);
    expect(packAllows('a_pack_from_the_future', 'finance')).toBe(false);
    // The universal suite is unaffected, because it never reaches packAllows at
    // all — the registry answers "no capability required" first. This is what
    // keeps a half-finished onboarding usable.
    for (const path of ['/config/bootstrap', '/products', '/crm/customers', '/hrms/attendance']) {
      expect(capabilityForPath(path)).toBeNull();
    }
    // Nothing starts accruing gold prices for a tenant we cannot classify.
    expect(packMaintainsMetalRates(null)).toBe(false);
    expect(packMaintainsMetalRates('a_pack_from_the_future')).toBe(false);
    expect(packMaintainsMetalRates('healthcare')).toBe(false);
    expect(packMaintainsMetalRates('jewellery')).toBe(true);
  });
});

describe('industry packs — vocabulary', () => {
  it('leaves the neutral verticals unlabelled, so their wording cannot drift', () => {
    // Jewellery is the live product: an empty map is what guarantees Eclat
    // renders precisely the strings it renders today.
    for (const code of ['jewellery', 'retail', 'other_services']) {
      expect(getPack(code)!.lexicon).toBeUndefined();
      expect(labelsFor(getPack(code))).toEqual({});
    }
  });

  it.each(ALL_CODES)('%s produces sane, in-bounds labels', (code) => {
    const pack = getPack(code)!;
    const labels = labelsFor(pack);

    for (const [neutral, replacement] of Object.entries(labels)) {
      // Only the declared surface may be rewritten — never arbitrary prose.
      expect(REWRITABLE_LABELS).toContain(neutral);
      expect(replacement.trim()).toBe(replacement);
      expect(replacement.length).toBeGreaterThan(0);
      // A substitution swaps nouns; it must not balloon the string. Bounded
      // against the neutral label rather than a flat number, so the three
      // subtitle entries are held to the same rule as a sidebar row.
      expect(replacement.length).toBeLessThanOrEqual(
        neutral.length + MAX_LEXICON_TERM * 2,
      );
      expect(replacement).not.toBe(neutral);
    }

    // Every noun resolves, whether or not this pack overrode it.
    const resolved = lexiconFor(pack);
    for (const key of Object.keys(NEUTRAL_LEXICON)) {
      expect(typeof resolved[key as keyof typeof resolved]).toBe('string');
      expect(resolved[key as keyof typeof resolved].length).toBeLessThanOrEqual(
        MAX_LEXICON_TERM,
      );
    }
  });

  it('gives the industries that asked for their own words exactly those words', () => {
    // The three the product owner named, spelled out so a silent edit is caught.
    expect(lexiconFor(getPack('healthcare')).customer_plural).toBe('Patients');
    expect(lexiconFor(getPack('healthcare')).lead).toBe('Enquiry');
    expect(lexiconFor(getPack('manufacturing')).customer).toBe('Account');
    expect(lexiconFor(getPack('textile')).customer).toBe('Buyer');
    expect(lexiconFor(getPack('textile')).product).toBe('Article');

    // And the labels those nouns actually become on screen.
    expect(labelsFor(getPack('healthcare'))['Customers']).toBe('Patients');
    expect(labelsFor(getPack('healthcare'))['CRM & Leads']).toBe('CRM & Enquiries');
    expect(labelsFor(getPack('textile'))['Add Product']).toBe('Add Article');
  });

  it('never claims a regulated workflow it has not built', () => {
    // Healthcare may say "Patient" for a CRM contact; it must not imply records
    // or scheduling that do not exist. Financial services must not imply a
    // ledger. These are the words that would make the product a liar.
    const forbidden = /appointment|prescription|diagnos|medical record|ledger|policy number/i;
    for (const code of ALL_CODES) {
      for (const value of Object.values(lexiconFor(getPack(code)))) {
        expect(value).not.toMatch(forbidden);
      }
    }
  });
});

describe('industry packs — provisioning', () => {
  /**
   * A transaction client that records what a pack would write.
   *
   * `integrationCredential` is a tripwire, not a dependency: provisioning has no
   * business reading or writing a credential, and if it ever grows one these
   * spies say so immediately.
   */
  function fakeTx() {
    let n = 0;
    const created = {
      terms: [] as Prisma.TaxonomyTermCreateArgs['data'][],
      attributes: [] as Prisma.AttributeDefinitionCreateArgs['data'][],
      policies: [] as Prisma.FieldPolicyCreateArgs['data'][],
      pipelines: [] as Record<string, unknown>[],
    };
    const tx = {
      taxonomyTerm: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: { data: never }) => {
          created.terms.push(data);
          return { id: `term-${++n}` };
        }),
      },
      attributeDefinition: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: { data: never }) => {
          created.attributes.push(data);
          return { id: `attr-${++n}` };
        }),
      },
      fieldPolicy: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: { data: never }) => {
          created.policies.push(data);
          return { id: `policy-${++n}` };
        }),
      },
      pipeline: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(async ({ data }: { data: never }) => {
          created.pipelines.push(data);
          return { id: `pipeline-${++n}` };
        }),
        update: jest.fn().mockResolvedValue({ id: 'pipeline' }),
      },
      pipelineStage: {
        create: jest.fn().mockResolvedValue({ id: 'stage' }),
        update: jest.fn().mockResolvedValue({ id: 'stage' }),
      },
      organisation: {
        // Provisioning reads the settings bag to find the previous ownership
        // record, then writes the new one back under a row lock.
        findUnique: jest.fn().mockResolvedValue({ settings: {} }),
        update: jest.fn().mockResolvedValue({ id: 'org' }),
      },
      // The `SELECT … FOR UPDATE` that makes the settings write atomic.
      $queryRaw: jest.fn().mockResolvedValue([{ settings: {} }]),
      integrationCredential: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    return { tx, created };
  }

  it.each(MUST_PROVISION)('%s materialises exactly what its pack declares', async (code) => {
    const pack = getPack(code)!;
    const { tx, created } = fakeTx();

    const counts = await provisionIndustryPack(
      tx as unknown as Prisma.TransactionClient,
      `org-${code}`,
      pack,
    );

    // Counts are DERIVED from the pack, not hardcoded. A hardcoded number
    // breaks whenever a shared vocabulary gains a term, which teaches everyone
    // to update the number rather than to read the diff.
    const expectedTerms = pack.taxonomies.reduce((n, t) => n + t.terms.length, 0);
    expect(counts).toEqual({
      terms: expectedTerms,
      attributes: pack.attributes.length,
      fieldPolicies: pack.fieldPolicies.length,
      pipelines: pack.onboarding?.pipeline ? 1 : 0,
      // A brand-new tenant has no funnel to converge; the pipeline is created
      // whole, so nothing is counted as a stage correction.
      pipelineStages: 0,
    });

    // Every row is stamped with THIS organisation and THIS pack.
    for (const row of [...created.terms, ...created.attributes, ...created.policies]) {
      expect(row.organisationId).toBe(`org-${code}`);
      expect((row as { packCode?: string }).packCode).toBe(code);
    }

    // The vocabulary is the pack's own, term for term.
    expect(created.terms.map((t) => `${t.kind}:${t.code}`).sort()).toEqual(
      pack.taxonomies.flatMap((t) => t.terms.map((term) => `${t.kind}:${term.code}`)).sort(),
    );
    expect(created.attributes.map((a) => `${a.entity}.${a.key}`).sort()).toEqual(
      pack.attributes.map((a) => `${a.entity}.${a.key}`).sort(),
    );

    // The CRM pipeline is created, is the default, and carries the pack's name.
    expect(created.pipelines).toHaveLength(1);
    expect(created.pipelines[0]).toMatchObject({
      organisationId: `org-${code}`,
      entity: 'lead',
      name: pack.onboarding!.pipeline.name,
      isDefault: true,
    });

    // The organisation is moved onto the pack, and nothing else about it is touched.
    expect(tx.organisation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: `org-${code}` },
        data: expect.objectContaining({
          industryPackCode: code,
          industryPackVersion: pack.version,
        }),
      }),
    );
    const updateData = tx.organisation.update.mock.calls[0][0].data as Record<string, unknown>;
    void updateData;
    // Notably NOT `settings`: provisioning must not rewrite a bag that three
    // other services read-modify-write, and navigation is derived, not stored.
    expect(Object.keys(updateData).sort()).toEqual(
      ['configVersion', 'industryPackCode', 'industryPackVersion'].sort(),
    );

    // No credential was so much as looked at.
    for (const spy of Object.values(tx.integrationCredential)) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it('is a no-op the second time, so an upgrade can re-run it safely', async () => {
    const pack = getPack('healthcare')!;
    const { tx } = fakeTx();
    // Everything already exists this time round.
    tx.taxonomyTerm.findUnique.mockResolvedValue({ id: 'existing' });
    tx.attributeDefinition.findUnique.mockResolvedValue({ id: 'existing' });
    tx.fieldPolicy.findUnique.mockResolvedValue({ id: 'existing' });
    // An existing funnel this same pack owns and already worded. Stamped with
    // the pack's code, so convergence is genuinely allowed to rewrite it — and
    // still does not, because there is nothing to change.
    tx.pipeline.findUnique.mockResolvedValue({
      id: 'existing',
      name: pack.onboarding!.pipeline.name,
      packCode: pack.code,
      stages: pack.onboarding!.pipeline.stages.map((st) => ({
        id: `stage-${st.code}`,
        code: st.code,
        label: st.label,
        packCode: pack.code,
      })),
    });

    const counts = await provisionIndustryPack(
      tx as unknown as Prisma.TransactionClient,
      'org-again',
      pack,
    );

    expect(counts).toEqual({
      terms: 0,
      attributes: 0,
      fieldPolicies: 0,
      pipelines: 0,
      pipelineStages: 0,
    });
    // And crucially: nothing was UPDATED either. A tenant's renamed term is
    // safe because provisioning has no update path at all, not because the
    // update happens to be harmless.
    expect(tx.taxonomyTerm.create).not.toHaveBeenCalled();
    expect(tx.attributeDefinition.create).not.toHaveBeenCalled();
    expect(tx.fieldPolicy.create).not.toHaveBeenCalled();
    expect(tx.pipeline.create).not.toHaveBeenCalled();
  });

  it('hides the jewellery product inputs for every non-jewellery industry', async () => {
    for (const code of ALL_CODES.filter((c) => c !== 'jewellery')) {
      const { tx, created } = fakeTx();
      await provisionIndustryPack(
        tx as unknown as Prisma.TransactionClient,
        `org-${code}`,
        getPack(code)!,
      );
      const hidden = created.policies
        .filter((p) => p.requirement === 'hidden')
        .map((p) => p.field);
      expect(hidden).toEqual(
        expect.arrayContaining([
          // `metal` first, because it is the one that decided STORED data rather
          // than a rendered input: it is a required column whose form default was
          // gold_22k, so every product of every non-jewellery tenant was recorded
          // as gold until this policy existed.
          'metal',
          'purity',
          'grossWeight',
          'netWeight',
          'makingChargeType',
          'huid',
        ]),
      );
    }
  });

  it('never seeds a regulated vocabulary it would be guessing at', () => {
    // Therapeutic classification is jurisdictional. The pack declares the
    // vocabulary so the tenant has somewhere to put theirs, and seeds nothing.
    const pharmacy = getPack('pharmacy')!;
    const regulated = pharmacy.taxonomies.find((t) => t.kind === 'medicine_category');
    expect(regulated).toBeDefined();
    expect(regulated!.terms).toHaveLength(0);
  });
});
