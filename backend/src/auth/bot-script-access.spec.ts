import {
  HEAD_OFFICE_DELEGABLE,
  HEAD_OFFICE_ONLY,
  MODULES,
  ModuleSlug,
  effectiveAccess,
  routeForPath,
} from './access';

/**
 * Editing the bot script, delegated.
 *
 * The client's marketing team writes the campaign scripts, but saving one was
 * head-office-only at the API with no way to hand it over — so the owner had to
 * either do the typing herself or make her marketing staff head office, which
 * also hands them money, access and every branch.
 *
 * The obvious fix was wrong and these tests exist to keep it wrong: putting
 * plain 'bot-script' into HEAD_OFFICE_DELEGABLE would have elevated EVERY
 * salesperson, because they all hold that screen in order to read the wording.
 * The right to change it therefore had to be its own slug.
 */
describe('bot-script/edit — delegating the right to change the wording', () => {
  const SLUG = 'bot-script/edit' as ModuleSlug;

  it('is a real module', () => {
    expect(MODULES as readonly string[]).toContain(SLUG);
  });

  it('is head-office-only, so no role picks it up by being promoted', () => {
    expect(HEAD_OFFICE_ONLY).toContain(SLUG);
  });

  it('is delegable, so head office can hand it to one person', () => {
    expect(HEAD_OFFICE_DELEGABLE).toContain(SLUG);
  });

  it('is offered in People & Access', () => {
    // Mirrors users.service.ts: grantable = MODULES - (HEAD_OFFICE_ONLY - DELEGABLE)
    const grantable = (MODULES as readonly string[]).filter(
      (s) =>
        !(HEAD_OFFICE_ONLY as readonly string[]).includes(s) ||
        (HEAD_OFFICE_DELEGABLE as readonly string[]).includes(s),
    );
    expect(grantable).toContain(SLUG);
  });

  it('does NOT elevate the readable screen — every salesperson holds that one', () => {
    // The whole reason for a separate slug. If this ever fails, the sales floor
    // can rewrite what the bot says to every customer.
    expect(HEAD_OFFICE_DELEGABLE).not.toContain('bot-script' as ModuleSlug);
  });

  describe('route mapping', () => {
    it.each([
      'crm/qualification/bot-script',
      'crm/qualification/bot-default',
      '/crm/qualification/bot-script',
    ])('%s belongs to the edit screen, softly', (path) => {
      const route = routeForPath(path);
      expect(route?.module).toBe(SLUG);
      // SOFT is what lets the open GET and the head-office PUT share one path:
      // a person without the screen falls through to the route's own @Roles.
      expect(route?.soft).toBe(true);
    });

    it('leaves the rest of that controller on CRM scoping', () => {
      expect(routeForPath('crm/qualification/ai-settings')?.module).toBe('crm');
      expect(routeForPath('crm/qualification/adset-rules')?.module).toBe('crm');
    });
  });

  describe('who ends up holding it', () => {
    const holds = (role: Parameters<typeof effectiveAccess>[0]) =>
      Boolean(effectiveAccess(role, null, 'org_eclat')[SLUG]);

    it.each(['salesperson', 'store_manager', 'marketing'] as const)(
      'not %s by default',
      (role) => {
        expect(holds(role)).toBe(false);
      },
    );

    it('head office always', () => {
      expect(holds('head_office')).toBe(true);
    });

    it('a marketing person head office switched it on for', () => {
      const access = effectiveAccess('marketing', { [SLUG]: 'store' }, 'org_eclat');
      expect(access[SLUG]).toBeTruthy();
    });

    it('and switching it on does not disturb their other screens', () => {
      const before = effectiveAccess('marketing', null, 'org_eclat');
      const after = effectiveAccess('marketing', { [SLUG]: 'store' }, 'org_eclat');
      for (const slug of Object.keys(before)) {
        expect(after[slug]).toBe(before[slug]);
      }
    });
  });
});
