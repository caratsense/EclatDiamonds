import { resolveAdSetRule, type AdSetAutomationRule } from '../src/crm/adset-rules.service';

const rules: AdSetAutomationRule[] = [
  {
    id: 'generic_hyderabad', name: 'Hyderabad retail', enabled: true, priority: 100,
    matchField: 'ad_set_name', matchValue: 'Hyderabad', storeId: 'hyd', assignedUserId: null,
    handling: 'ai',
  },
  {
    id: 'franchise', name: 'Franchise enquiries', enabled: true, priority: 200,
    matchField: 'tag', matchValue: 'franchise', storeId: null, assignedUserId: 'owner',
    handling: 'human',
  },
];

describe('Ad-set automation rule resolution', () => {
  it('uses the highest-priority match and preserves human-only handling', () => {
    expect(resolveAdSetRule(rules, {
      adSetName: 'September | Hyderabad | Leadgen',
      tags: ['Franchise'],
    })).toMatchObject({ id: 'franchise', handling: 'human', assignedUserId: 'owner' });
  });

  it('matches names case-insensitively and leaves unmatched traffic unassigned', () => {
    expect(resolveAdSetRule(rules, { adSetName: 'HYDERABAD bridal' }))
      .toMatchObject({ id: 'generic_hyderabad', storeId: 'hyd', handling: 'ai' });
    expect(resolveAdSetRule(rules, { adSetName: 'Mumbai bridal' })).toBeNull();
  });
});

/**
 * Two showrooms whose names contain one another.
 *
 * Éclat runs Bandra and Bandra Broadway. Every ad set named for Broadway also
 * contains the word "bandra", so the naive rule pair sends Broadway's customers
 * to Bandra — with nothing logged and nobody told.
 */
describe('Overlapping showroom names', () => {
  const overlapping: AdSetAutomationRule[] = [
    {
      id: 'bandra', name: 'Bandra', enabled: true, priority: 100,
      matchField: 'ad_set_name', matchValue: 'bandra', storeId: 'store_bandra',
      assignedUserId: null, handling: 'ai',
    },
    {
      // Deliberately the LOWER priority number: the point is that specificity
      // decides this, not the number somebody remembered to type.
      id: 'broadway', name: 'Bandra Broadway', enabled: true, priority: 10,
      matchField: 'ad_set_name', matchValue: 'bandra broadway', storeId: 'store_broadway',
      assignedUserId: null, handling: 'ai',
    },
  ];

  it('sends a Broadway ad set to Broadway even though Bandra also matches', () => {
    expect(resolveAdSetRule(overlapping, {
      adSetName: 'Lead Campaign - bandra broadway 23-07-2026',
    })).toMatchObject({ id: 'broadway', storeId: 'store_broadway' });
  });

  it('still sends a plain Bandra ad set to Bandra', () => {
    expect(resolveAdSetRule(overlapping, {
      adSetName: 'Lead Campaign Bandra linking - 23-07-2026',
    })).toMatchObject({ id: 'bandra', storeId: 'store_bandra' });
  });

  it('lets priority decide only when two rules are equally specific', () => {
    const tie: AdSetAutomationRule[] = [
      { ...overlapping[0], id: 'first', matchValue: 'udaipur', storeId: 'store_a', priority: 10 },
      { ...overlapping[0], id: 'second', matchValue: 'udaipur', storeId: 'store_b', priority: 900 },
    ];
    expect(resolveAdSetRule(tie, { adSetName: 'Lead Campaign Udaipur' }))
      .toMatchObject({ id: 'second', storeId: 'store_b' });
  });
});

describe('Match field precedence and safety', () => {
  it('an exact ad id beats a longer name match', () => {
    const mixed: AdSetAutomationRule[] = [
      {
        id: 'by_name', name: 'Udaipur', enabled: true, priority: 900,
        matchField: 'ad_set_name', matchValue: 'lead campaign udaipur', storeId: 'store_udaipur',
        assignedUserId: null, handling: 'ai',
      },
      {
        id: 'pinned', name: 'One pinned ad', enabled: true, priority: 1,
        matchField: 'ad_id', matchValue: '120254521670780226', storeId: 'store_flagship',
        assignedUserId: null, handling: 'human',
      },
    ];
    // An id names one ad and cannot mean two showrooms, so pinning wins.
    expect(resolveAdSetRule(mixed, {
      adId: '120254521670780226',
      adSetName: 'Lead Campaign Udaipur - 23-07-2026',
    })).toMatchObject({ id: 'pinned', storeId: 'store_flagship' });
  });

  it('routes on campaign name when the ad set name carries no showroom', () => {
    const byCampaign: AdSetAutomationRule[] = [
      {
        id: 'kala_ghoda', name: 'Kala Ghoda', enabled: true, priority: 100,
        matchField: 'campaign_name', matchValue: 'kala ghoda', storeId: 'store_kg',
        assignedUserId: null, handling: 'ai',
      },
    ];
    expect(resolveAdSetRule(byCampaign, {
      adSetName: 'New Engagement ad set',
      campaignName: 'Lead Campaign Kala Ghoda - 23-07-2026 – updated',
    })).toMatchObject({ id: 'kala_ghoda', storeId: 'store_kg' });
  });

  it('an empty match value routes nothing, rather than everything', () => {
    const blank: AdSetAutomationRule[] = [
      {
        id: 'blank', name: 'Broken rule', enabled: true, priority: 999,
        matchField: 'ad_set_name', matchValue: '   ', storeId: 'store_everything',
        assignedUserId: null, handling: 'ai',
      },
    ];
    // `''.includes()` is true for every string — this rule would otherwise send
    // the entire country's traffic to one branch.
    expect(resolveAdSetRule(blank, { adSetName: 'Lead Campaign Udaipur' })).toBeNull();
  });

  it('a disabled rule never wins, however specific', () => {
    const disabled: AdSetAutomationRule[] = [
      {
        id: 'off', name: 'Retired showroom', enabled: false, priority: 100,
        matchField: 'ad_set_name', matchValue: 'bandra broadway', storeId: 'store_broadway',
        assignedUserId: null, handling: 'ai',
      },
      {
        id: 'on', name: 'Bandra', enabled: true, priority: 100,
        matchField: 'ad_set_name', matchValue: 'bandra', storeId: 'store_bandra',
        assignedUserId: null, handling: 'ai',
      },
    ];
    expect(resolveAdSetRule(disabled, { adSetName: 'bandra broadway push' }))
      .toMatchObject({ id: 'on', storeId: 'store_bandra' });
  });

  it('a name rule cannot fire when the lookup supplied no name', () => {
    // The fail-safe: if MetaAdMetadataService could not resolve the ad, there is
    // no ad-set name in the context and the thread must stay unrouted.
    expect(resolveAdSetRule(rules, { adId: '120254521670780226' })).toBeNull();
  });
});
