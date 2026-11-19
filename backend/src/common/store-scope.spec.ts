import { ForbiddenException } from '@nestjs/common';

import { AuthUser } from './auth-user';
import { StoreScopeService } from './store-scope.service';

/**
 * What the branch picker in the top bar is allowed to do.
 *
 * The report that prompted these: head office chose Mumbai Bandra and kept
 * getting Borivali's conversations. The filter had to start narrowing — and
 * the two properties that matter while it does are that it can only ever
 * REMOVE rows (never reach a branch the caller is not scoped to), and that it
 * treats a row with no branch the same way on every screen.
 *
 * `storeFilter`, `storeOrUnbranchedFilter` and `assertStoreAllowed` never touch
 * the database, so the real service answers here with no Prisma at all.
 */
const scope = new StoreScopeService(undefined as never);

const user = (over: Partial<AuthUser> = {}): AuthUser => ({
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: 'org_eclat',
  storeIds: ['mumbai-bandra', 'mumbai-borivali'],
  allStores: true,
  ...over,
});

describe('the chosen branch narrows the list', () => {
  it('pins the query to that one branch', () => {
    expect(scope.storeFilter(user(), 'mumbai-bandra')).toEqual({ storeId: 'mumbai-bandra' });
  });

  it('falls back to every branch in scope when nothing is chosen', () => {
    expect(scope.storeFilter(user())).toEqual({
      storeId: { in: ['mumbai-bandra', 'mumbai-borivali'] },
    });
  });

  it('treats the "All Stores" aggregate as no narrowing at all', () => {
    // The switcher sends the aggregate's id like any other store, and `all` is
    // in nobody's scope — read as a branch it would 403 head office out of its
    // own company.
    expect(scope.storeFilter(user(), 'all')).toEqual({
      storeId: { in: ['mumbai-bandra', 'mumbai-borivali'] },
    });
  });
});

describe('the chosen branch can never widen the list', () => {
  it("refuses a branch outside the caller's scope", () => {
    const manager = user({ role: 'store_manager', allStores: false, storeIds: ['mumbai-bandra'] });
    expect(() => scope.storeFilter(manager, 'mumbai-borivali')).toThrow(ForbiddenException);
  });

  it('refuses it for head office too, because storeIds is organisation-bounded', () => {
    // A store belonging to another tenant is not in `storeIds`, so the same
    // check is what keeps the picker inside the organisation.
    expect(() => scope.storeFilter(user(), 'another-tenants-shop')).toThrow(ForbiddenException);
  });

  it('refuses it on the unbranched variant as well', () => {
    const manager = user({ role: 'store_manager', allStores: false, storeIds: ['mumbai-bandra'] });
    expect(() => scope.storeOrUnbranchedFilter(manager, 'mumbai-borivali')).toThrow(
      ForbiddenException,
    );
  });

  it('assertStoreAllowed gates a write to the same set', () => {
    const manager = user({ role: 'store_manager', allStores: false, storeIds: ['mumbai-bandra'] });
    expect(() => scope.assertStoreAllowed(manager, 'mumbai-bandra')).not.toThrow();
    expect(() => scope.assertStoreAllowed(manager, 'mumbai-borivali')).toThrow(ForbiddenException);
  });
});

describe('rows with no branch at all', () => {
  it('survive a branch choice', () => {
    // THE decision: an org-level customer, an unrouted ad thread or a
    // head-office task is not AT another branch, so choosing one does not
    // hide it.
    expect(scope.storeOrUnbranchedFilter(user(), 'mumbai-bandra')).toEqual({
      OR: [{ storeId: 'mumbai-bandra' }, { storeId: null }],
    });
  });

  it('are there when no branch is chosen either', () => {
    expect(scope.storeOrUnbranchedFilter(user())).toEqual({
      OR: [{ storeId: { in: ['mumbai-bandra', 'mumbai-borivali'] } }, { storeId: null }],
    });
  });

  it('are there for a store manager, who has no "All Stores" to fall back on', () => {
    // The whole reason the rule is this way round: only head office and an area
    // manager are offered the aggregate, so a store manager always sends a
    // concrete branch. Hiding unbranched rows under a branch choice would hide
    // them from this person permanently.
    const manager = user({ role: 'store_manager', allStores: false, storeIds: ['mumbai-bandra'] });
    expect(scope.storeOrUnbranchedFilter(manager, 'mumbai-bandra')).toEqual({
      OR: [{ storeId: 'mumbai-bandra' }, { storeId: null }],
    });
  });
});
