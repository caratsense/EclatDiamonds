import { AuthUser } from '../common/auth-user';
import { compileSegment, parseSegmentDefinition } from './audience-segment.dsl';
import {
  HAS_CONTACT_POINT,
  campaignAudienceWhere,
  campaignContactValue,
  previewAudienceWhere,
  visibleStores,
} from './campaign-audience';

/**
 * The preview and the send have to be talking about the same people.
 *
 * They were not. `previewAudience` scoped through a helper that excluded
 * archived contacts; `runExpansion` — the half that writes the recipient rows
 * and therefore decides who is actually messaged — built its own filter and
 * left the archive out. A customer the shop had archived was absent from the
 * number the manager approved and was messaged anyway.
 *
 * So what is pinned here is agreement, not either side's behaviour: the same
 * audience, asked for by each caller in the way it really asks, has to compile
 * to the same filter. Both entry points are the real exported ones the service
 * calls — a copy of the clause written out in this file would have passed
 * happily on the day the bug shipped.
 */

const NOW = new Date('2026-11-19T00:00:00Z');

const ORG = 'org-nibhana';

const compile = (definition: unknown) =>
  compileSegment(parseSegmentDefinition(definition), NOW).where;

const user = (over: Partial<AuthUser> = {}): AuthUser =>
  ({
    id: 'u1',
    name: 'Ayushi',
    email: 'ayushi@example.com',
    role: 'head_office',
    organisationId: ORG,
    storeIds: [],
    allStores: true,
    ...over,
  }) as AuthUser;

/** Every customer, which is the audience a real broadcast is usually built on. */
const EVERY_CUSTOMER = {
  match: 'all',
  conditions: [{ field: 'party.type', op: 'in', value: ['customer'] }],
};

describe('the preview and the send agree', () => {
  it('compiles one audience to one filter, whichever side asks', () => {
    const compiled = compile(EVERY_CUSTOMER);
    const preview = previewAudienceWhere(user(), compiled);
    const expansion = campaignAudienceWhere({ organisationId: ORG, storeIds: [] }, compiled);
    expect(expansion).toEqual(preview);
  });

  it('agrees on a branch-scoped campaign too', () => {
    const compiled = compile(EVERY_CUSTOMER);
    const preview = previewAudienceWhere(user(), compiled, ['store-pune']);
    const expansion = campaignAudienceWhere(
      { organisationId: ORG, storeIds: ['store-pune'] },
      compiled,
    );
    expect(expansion).toEqual(preview);
  });

  it('leaves an archived customer out of BOTH, which is the whole defect', () => {
    const compiled = compile(EVERY_CUSTOMER);
    expect(previewAudienceWhere(user(), compiled)).toMatchObject({ archivedAt: null });
    expect(
      campaignAudienceWhere({ organisationId: ORG, storeIds: [] }, compiled),
    ).toMatchObject({ archivedAt: null });
  });

  it('never lets a tenant rule switch the archive back on', () => {
    // `archivedAt` sits beside the compiled rule, never inside it, so a segment
    // naming the field cannot widen the audience to archived people.
    const where = previewAudienceWhere(user(), { archivedAt: { not: null } });
    expect(where.archivedAt).toBeNull();
    expect(where.AND).toEqual([{ archivedAt: { not: null } }]);
  });

  it('keeps both sides inside the one tenant', () => {
    const compiled = compile(EVERY_CUSTOMER);
    expect(previewAudienceWhere(user(), compiled).organisationId).toBe(ORG);
    expect(
      campaignAudienceWhere({ organisationId: ORG, storeIds: [] }, compiled).organisationId,
    ).toBe(ORG);
  });
});

describe('the branches an audience reaches', () => {
  it('keeps org-level customers visible to a branch-limited manager', () => {
    // A customer with no branch belongs to the tenant, not to a shop. Dropping
    // them would silently lose every head-office record from the send.
    const where = previewAudienceWhere(
      user({ role: 'store_manager', storeIds: ['store-pune'], allStores: false }),
      compile(EVERY_CUSTOMER),
    );
    expect(where.OR).toEqual([{ storeId: { in: ['store-pune'] } }, { storeId: null }]);
  });

  it('does not narrow by branch at all when the campaign is org-wide', () => {
    const where = campaignAudienceWhere({ organisationId: ORG, storeIds: [] }, compile(EVERY_CUSTOMER));
    expect(where.OR).toBeUndefined();
  });

  it('refuses a manager who holds no branch instead of meaning "every branch"', () => {
    // The one divergence that would have sent MORE messages than were approved:
    // the preview read an empty list as "no branch" and showed almost nobody,
    // while a campaign stores [] to mean "every branch" and would have expanded
    // to the entire tenant.
    expect(() =>
      visibleStores(user({ role: 'store_manager', storeIds: [], allStores: false })),
    ).toThrow(/not assigned to a branch/i);
  });

  it('refuses a branch the manager cannot see rather than quietly dropping it', () => {
    expect(() =>
      visibleStores(user({ role: 'store_manager', storeIds: ['store-pune'], allStores: false }), [
        'store-mumbai',
      ]),
    ).toThrow(/do not have access/i);
  });

  it('intersects a chosen branch with what the manager may actually see', () => {
    expect(
      visibleStores(user({ role: 'store_manager', storeIds: ['store-pune', 'store-nagpur'], allStores: false }), [
        'store-pune',
      ]),
    ).toEqual(['store-pune']);
  });

  it('holds the campaign to the branches frozen onto it, not to later access', () => {
    // Branch access granted or withdrawn between approval and send must not
    // move the audience — the approver signed off on a number.
    const compiled = compile(EVERY_CUSTOMER);
    expect(
      campaignAudienceWhere({ organisationId: ORG, storeIds: ['store-pune'] }, compiled).OR,
    ).toEqual([{ storeId: { in: ['store-pune'] } }, { storeId: null }]);
  });
});

describe('the number a campaign will message', () => {
  // The expansion's real normaliser, reduced to the rule that matters here:
  // ten Indian digits starting 6-9, anything else unreadable.
  const normalise = (raw: string) => (/^[6-9]\d{9}$/.test(raw.trim()) ? `91${raw.trim()}` : null);

  it('uses WhatsApp when both are on file', () => {
    expect(
      campaignContactValue({ whatsapp: '9812345678', phone: '9800000000' }, normalise),
    ).toBe('919812345678');
  });

  it('falls back to the phone number when the WhatsApp field is unreadable', () => {
    // The gap the preview could not keep: it asks only whether EITHER field is
    // filled in, while expansion read `whatsapp ?? phone` and gave up on the
    // first one — dropping a customer whose phone number was perfectly good.
    expect(campaignContactValue({ whatsapp: 'ask at counter', phone: '9812345678' }, normalise)).toBe(
      '919812345678',
    );
  });

  it('falls back when the WhatsApp field is empty', () => {
    expect(campaignContactValue({ whatsapp: null, phone: '9812345678' }, normalise)).toBe(
      '919812345678',
    );
  });

  it('gives up only when neither number can be read', () => {
    expect(campaignContactValue({ whatsapp: 'n/a', phone: '12345' }, normalise)).toBeNull();
    expect(campaignContactValue({ whatsapp: null, phone: null }, normalise)).toBeNull();
  });

  it('asks the database the same question the preview counts', () => {
    // Both numbers, so the filter and `campaignContactValue` are looking at the
    // same two fields rather than one each.
    expect(HAS_CONTACT_POINT).toEqual({
      OR: [{ whatsapp: { not: null } }, { phone: { not: null } }],
    });
  });
});
