import { Role, SpecialRequestKind } from '@prisma/client';

import {
  REQUEST_KIND_LABELS,
  canDecide,
  resolveRequiredRole,
  roleAbove,
} from './request-routing';
import { describeHistory, removalOutcome } from '../parties/party-history';

/**
 * Removing a customer, approved by somebody above you.
 *
 * The client, 16 Nov: "if manager wants to it goes to headoffice for approval
 * and if salesperson does it it should go to manager for approval." Nothing in
 * the product could delete a customer at all before this — `DELETE /parties`
 * is head-office-only and refuses anyone with history.
 */
describe('customer deletion requests', () => {
  const KIND = SpecialRequestKind.customer_deletion;

  it('is a kind of request, with a name an approver can read', () => {
    expect(REQUEST_KIND_LABELS[KIND]).toBe('Customer deletion');
  });

  describe('who has to approve it', () => {
    it("a salesperson's goes to their manager", () => {
      expect(resolveRequiredRole(KIND, Role.salesperson)).toBe(Role.store_manager);
    });

    it("a manager's goes to head office", () => {
      // Not area_manager: `roleAbove` skips that retired tier, which is what
      // stops a manager's request stopping one rung short of head office.
      expect(resolveRequiredRole(KIND, Role.store_manager)).toBe(Role.head_office);
      expect(roleAbove(Role.store_manager)).toBe(Role.head_office);
    });

    it("an area manager's also goes to head office", () => {
      expect(resolveRequiredRole(KIND, Role.area_manager)).toBe(Role.head_office);
    });

    it("head office's own stays at head office, needing a second person", () => {
      // There is nobody above, so the four-eyes rule is carried by
      // assertNotSelfApproval rather than by the rank.
      expect(resolveRequiredRole(KIND, Role.head_office)).toBe(Role.head_office);
    });

    it('a marketing user is treated as front line, like a salesperson', () => {
      expect(resolveRequiredRole(KIND, Role.marketing)).toBe(Role.store_manager);
    });
  });

  describe('who may act on one', () => {
    it('a salesperson can never approve a deletion', () => {
      // The floor exists for exactly this: without it the one-rank-above rule
      // alone would let a salesperson approve another salesperson's request.
      expect(canDecide(Role.salesperson, Role.store_manager)).toBe(false);
      expect(canDecide(Role.marketing, Role.store_manager)).toBe(false);
    });

    it('a manager can approve a salesperson\'s', () => {
      expect(canDecide(Role.store_manager, Role.store_manager)).toBe(true);
    });

    it("a manager cannot approve another manager's", () => {
      expect(canDecide(Role.store_manager, Role.head_office)).toBe(false);
    });

    it('head office can approve anything', () => {
      expect(canDecide(Role.head_office, Role.store_manager)).toBe(true);
      expect(canDecide(Role.head_office, Role.head_office)).toBe(true);
    });
  });

  describe('what approving it actually does', () => {
    it('deletes a customer with nothing on record', () => {
      expect(removalOutcome([])).toBe('delete');
    });

    it('archives a customer with any history at all', () => {
      // One quote is enough. Deleting would take the quote, and every number
      // built on it, with the customer.
      expect(removalOutcome([['quotes', 1]])).toBe('archive');
    });

    it('names what is held, so the approver agrees to a consequence', () => {
      expect(describeHistory([['sales', 2], ['payments', 1]])).toBe('2 sales, 1 payments');
    });

    it('says nothing when nothing is held', () => {
      expect(describeHistory([])).toBe('');
    });
  });
});
