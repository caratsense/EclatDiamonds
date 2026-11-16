import { HEAD_OFFICE_DELEGABLE, ModuleSlug, routeForPath } from './access';

/**
 * A delegated screen has to work end to end, not just open.
 *
 * Reported from production on 16 Nov: head office switched "Bot Scripts —
 * allow editing" and "Message Templates" on for a marketing user, she could
 * see both screens, and every button on them was dead.
 *
 * Three separate causes, each of which alone was enough:
 *
 *   1. the client never mirrored the server's head-office elevation, so the
 *      page was served at her own role and disabled its own controls
 *      (fixed in module-gate.ts, covered by module-gate.test.ts);
 *   2. the templates page reads `integrations-registry` to find the WhatsApp
 *      account id, and that controller is head-office-only — it was mapped to
 *      Conversations, so a delegated holder was never raised for it and the
 *      call 403'd, leaving the composer disabled with no explanation;
 *   3. saving a campaign conversation fell to the generic `crm` mapping, which
 *      raises a delegated editor only to store manager, and the route wants
 *      head office.
 *
 * These assert 2 and 3 — that each route a delegated screen depends on is
 * governed by the screen that was delegated, and not by something else.
 */
describe('a delegated screen governs the routes it depends on', () => {
  const TEMPLATES = 'settings/integrations/templates' as ModuleSlug;
  const BOT_EDIT = 'bot-script/edit' as ModuleSlug;

  const governedBy = (path: string, slug: ModuleSlug) => {
    const route = routeForPath(path);
    expect({ path, module: route?.module }).toEqual({ path, module: slug });
    // SOFT, so anybody WITHOUT the screen is unaffected and still meets the
    // route's own @Roles. Hard-mapping these would lock out the roles that
    // legitimately reach them today.
    expect({ path, soft: route?.soft }).toEqual({ path, soft: true });
  };

  describe('Message Templates', () => {
    it('is delegable at all', () => {
      expect(HEAD_OFFICE_DELEGABLE).toContain(TEMPLATES);
    });

    it.each([
      'omnichannel/templates',
      'omnichannel/integrations',
      // The one that was missing. Without it the composer disables itself,
      // because it cannot read the WhatsApp Business Account id.
      'integrations-registry',
    ])('%s is governed by the templates screen', (path) => {
      governedBy(path, TEMPLATES);
    });
  });

  describe('Bot Scripts — allow editing', () => {
    it('is delegable at all', () => {
      expect(HEAD_OFFICE_DELEGABLE).toContain(BOT_EDIT);
    });

    it.each([
      'crm/qualification/bot-script',
      'crm/qualification/bot-default',
      // The one that was missing: "Add campaign" writes here.
      'crm/qualification/adset-rules',
    ])('%s is governed by the edit right', (path) => {
      governedBy(path, BOT_EDIT);
    });

    it('leaves the rest of that controller on CRM scoping', () => {
      // The elevation must not spread to the whole qualification controller.
      expect(routeForPath('crm/qualification/ai-settings')?.module).toBe('crm');
      expect(routeForPath('crm/qualification/meta-ads')?.module).toBe('crm');
    });
  });

  it('still refuses a screen nobody was given', () => {
    // `settings/access` edits access itself, so it is never delegable — the
    // holder could grant themselves anything, head office included.
    expect(HEAD_OFFICE_DELEGABLE).not.toContain('settings/access' as ModuleSlug);
  });
});
