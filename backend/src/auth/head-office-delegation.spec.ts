import { routeForPath } from './access';
import { UsersService } from '../users/users.service';
import type { AuthUser } from '../common/auth-user';

/**
 * Delegating head office, and the two holes that opening it would otherwise
 * leave.
 *
 * Reported from production: the client appointed a second executive to run
 * People & Access, then could not edit her name, her login, or one screen —
 * "You cannot manage a user at or above your own role" on a person they had
 * just created. The 7 Oct rule let head office CREATE an equal but never
 * manage one, which made delegation a one-way door.
 *
 * Peer management is the ordinary administrator model. It is only safe because
 * the destructive paths refuse to act on the actor's own account and refuse to
 * leave the organisation without an executive, so both are asserted here
 * alongside the thing that was actually broken.
 */

const ho = (id: string): AuthUser =>
  ({ id, organisationId: 'org1', role: 'head_office', storeIds: ['s1'] }) as AuthUser;

const manager = (id: string): AuthUser =>
  ({ id, organisationId: 'org1', role: 'store_manager', storeIds: ['s1'] }) as AuthUser;

/** `count` answers "how many OTHER active head office accounts exist". */
function service(otherHeadOffices: number) {
  const prisma = { user: { count: async () => otherHeadOffices } };
  const scope = { assertStoreAllowed: () => undefined };
  // (prisma, audit, scope, whatsappIdentity, email)
  return new UsersService(
    prisma as never,
    null as never,
    scope as never,
    null as never,
    null as never,
  );
}

const canManage = (svc: UsersService, actor: AuthUser, targetRole: string) =>
  (svc as unknown as {
    assertCanManage: (a: AuthUser, r: string, s?: string | null) => void;
  }).assertCanManage(actor, targetRole, null);

const notSelf = (svc: UsersService, actor: AuthUser, targetId: string) =>
  (svc as unknown as {
    assertNotSelf: (a: AuthUser, id: string, action: string) => void;
  }).assertNotSelf(actor, targetId, 'deactivate');

const notLast = (svc: UsersService, targetId: string, role: string) =>
  (svc as unknown as {
    assertNotLastHeadOffice: (o: string, id: string, r: string, a: string) => Promise<void>;
  }).assertNotLastHeadOffice('org1', targetId, role, 'deactivate');

describe('a head office may manage a peer head office', () => {
  it('allows the edit that was refused in production', () => {
    // Exactly the screenshot: head office opens a head office colleague and saves.
    expect(() => canManage(service(1), ho('ayushi'), 'head_office')).not.toThrow();
  });

  it('still allows managing everyone below', () => {
    for (const role of ['store_manager', 'salesperson', 'storeperson', 'marketing']) {
      expect(() => canManage(service(1), ho('ayushi'), role)).not.toThrow();
    }
  });
});

describe('the exception is head office only', () => {
  it('does not let a store manager manage a peer store manager', () => {
    expect(() => canManage(service(1), manager('m1'), 'store_manager')).toThrow(
      /at or above your own role/,
    );
  });

  it('does not let a store manager manage a head office', () => {
    expect(() => canManage(service(1), manager('m1'), 'head_office')).toThrow(
      /at or above your own role/,
    );
  });
});

describe('an account cannot disarm itself', () => {
  /*
   * Before peer management this was impossible by accident — an account could
   * never be its own target, because its role was never below itself. Opening
   * peer management removes the accident, so it has to be stated.
   */
  it('refuses an action aimed at the actor', () => {
    expect(() => notSelf(service(5), ho('ayushi'), 'ayushi')).toThrow(/your own account/);
  });

  it('allows the same action aimed at somebody else', () => {
    expect(() => notSelf(service(5), ho('ayushi'), 'stuti')).not.toThrow();
  });
});

describe('the organisation is never left without an executive', () => {
  it('refuses when no other active head office remains', async () => {
    await expect(notLast(service(0), 'stuti', 'head_office')).rejects.toThrow(
      /only active head office/,
    );
  });

  it('allows it while another remains', async () => {
    await expect(notLast(service(1), 'stuti', 'head_office')).resolves.toBeUndefined();
  });

  it('does not apply to any other role', async () => {
    // A store manager is not an executive; the count is irrelevant.
    await expect(notLast(service(0), 'someone', 'store_manager')).resolves.toBeUndefined();
  });
});

describe('a person owns their own attendance, whatever screens they hold', () => {
  /*
   * `['hrms','hrms']` handed the whole /hrms API to the HR hub, so turning that
   * screen off also stopped the person clocking in and reading their own
   * punches — seen in production as repeated 403s on GET /hrms/attendance/me
   * and GET /hrms/geofence after a head office tailored a colleague's screens.
   */
  const selfServe = [
    'hrms/attendance/me',
    'hrms/attendance/check-in',
    'hrms/attendance/check-out',
    'hrms/geofence',
    'hrms/schedule/me',
    'hrms/regularize',
    'hrms/leave/balances',
    'hrms/leave/preview',
    'hrms/holidays',
    'hrms/shifts',
  ];

  for (const path of selfServe) {
    it(`${path} is not gated on the HR screen`, () => {
      expect(routeForPath(path)).toBeNull();
    });
  }

  it('survives a query string, which is how the 403 was actually produced', () => {
    expect(routeForPath('hrms/attendance/me?month=2026-11')).toBeNull();
  });
});

describe('what still belongs to the HR screen', () => {
  it('keeps the roster, which the service widens to the whole scope', () => {
    expect(routeForPath('hrms/attendance')?.module).toBe('hrms');
  });

  it('keeps the leave list for the same reason', () => {
    expect(routeForPath('hrms/leave')?.module).toBe('hrms');
  });

  it('keeps the rest of the HR API', () => {
    for (const p of ['hrms/employees', 'hrms/payroll', 'hrms/approvals']) {
      expect(routeForPath(p)?.module).toBe('hrms');
    }
  });
});
