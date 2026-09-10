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
