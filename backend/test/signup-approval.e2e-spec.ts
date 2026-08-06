import { canApproveSignup, handleBase, uniqueEmailHandle } from '../src/users/users.util';

/**
 * The self-signup approval boundary (users.util.canApproveSignup).
 *
 * This is the security core of the new signup flow: it decides both what a
 * manager sees in the approval queue and — mirrored by the throwing guards in
 * approve()/reject() — what they may grant. The rule the client described:
 * "the first person signs up → head office approves them as store/area manager →
 * that manager then approves the salespeople". These cases pin that rule down.
 */
describe('signup approval — who may approve whom', () => {
  const HO = { role: 'head_office' as const, allStores: true, storeIds: [] };
  const AREA = { role: 'area_manager' as const, allStores: false, storeIds: ['s-bandra', 's-borivali'] };
  const SM = { role: 'store_manager' as const, allStores: false, storeIds: ['s-bandra'] };
  const SP = { role: 'salesperson' as const, allStores: false, storeIds: ['s-bandra'] };

  it('head office approves store/area-manager signups (the store-bootstrap step)', () => {
    expect(canApproveSignup(HO, 'store_manager', 's-bandra')).toBe(true);
    expect(canApproveSignup(HO, 'area_manager', 's-borivali')).toBe(true);
    expect(canApproveSignup(HO, 'salesperson', 's-anything')).toBe(true); // HO ignores store scope
  });

  it('a store manager approves ONLY salespeople, and ONLY in their own store', () => {
    expect(canApproveSignup(SM, 'salesperson', 's-bandra')).toBe(true);
    // out-of-scope store → not theirs to approve
    expect(canApproveSignup(SM, 'salesperson', 's-borivali')).toBe(false);
    // cannot approve a peer or a superior — the whole point of the tiered flow
    expect(canApproveSignup(SM, 'store_manager', 's-bandra')).toBe(false);
    expect(canApproveSignup(SM, 'area_manager', 's-bandra')).toBe(false);
  });

  it('an area manager may approve store managers + salespeople inside their region stores', () => {
    expect(canApproveSignup(AREA, 'store_manager', 's-bandra')).toBe(true);
    expect(canApproveSignup(AREA, 'salesperson', 's-borivali')).toBe(true);
    expect(canApproveSignup(AREA, 'store_manager', 's-elsewhere')).toBe(false); // not in scope
    expect(canApproveSignup(AREA, 'area_manager', 's-bandra')).toBe(false); // never a peer
  });

  it('nobody — not even head office — can approve a head_office signup', () => {
    expect(canApproveSignup(HO, 'head_office' as never, 's-bandra')).toBe(false);
    expect(canApproveSignup(AREA, 'head_office' as never, 's-bandra')).toBe(false);
  });

  it('a salesperson can approve nobody (they never reach the queue anyway)', () => {
    expect(canApproveSignup(SP, 'salesperson', 's-bandra')).toBe(false);
  });

  describe('login-handle generation', () => {
    it('is firstname.storeslug, lowercased and stripped', () => {
      expect(handleBase('Shreyansh Kashyap', 'MUMBAI BANDRA')).toBe('shreyansh.mumbaibandra');
      expect(handleBase('Priya', 'Udaipur — Ashok Nagar')).toBe('priya.udaipurashoknagar');
    });

    it('same name at DIFFERENT stores stays distinct — that is the point', () => {
      expect(handleBase('Shreyansh', 'Mumbai Bandra')).not.toEqual(
        handleBase('Shreyansh', 'Udaipur'),
      );
    });

    it('appends a numeric suffix only when the base is already taken', async () => {
      const taken = new Set(['shreyansh.mumbaibandra@eclatdiamonds.in']);
      const first = await uniqueEmailHandle('Shreyansh', 'Mumbai Bandra', async (e) =>
        taken.has(e),
      );
      expect(first).toBe('shreyansh.mumbaibandra2@eclatdiamonds.in');

      const fresh = await uniqueEmailHandle('Aarav', 'Mumbai Bandra', async (e) =>
        taken.has(e),
      );
      expect(fresh).toBe('aarav.mumbaibandra@eclatdiamonds.in'); // no suffix when free
    });
  });

  it('a missing requested store blocks a scoped approver but not head office', () => {
    expect(canApproveSignup(SM, 'salesperson', null)).toBe(false);
    expect(canApproveSignup(SM, 'salesperson', undefined)).toBe(false);
    expect(canApproveSignup(HO, 'salesperson', null)).toBe(true);
  });
});
