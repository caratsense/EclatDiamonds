import { OrderStatus } from '@prisma/client';
import {
  assertStageRoleAllowed,
  assertTransitionAllowed,
  nextStages,
  TERMINAL_STAGES,
} from '../src/timelines/order-stages';

/**
 * The production state machine (Module 8) — the safety boundary behind order
 * timelines. Pure logic, runs without an app/DB. Pins BOTH the transition rules
 * (no illegal jumps, no backward slides, QC→re-polish rework) AND the 2026-08
 * authority change: cancellation moved from area_manager to store_manager.
 */
describe('order-stages state machine', () => {
  describe('transition validation (unchanged safety boundary)', () => {
    it('rejects an illegal jump booked → delivered', () => {
      expect(() =>
        assertTransitionAllowed(OrderStatus.booked, OrderStatus.delivered),
      ).toThrow();
    });

    it('rejects a backward slide ready → designing', () => {
      expect(() =>
        assertTransitionAllowed(OrderStatus.ready, OrderStatus.designing),
      ).toThrow();
    });

    it('allows the explicit QC → polishing rework', () => {
      expect(() =>
        assertTransitionAllowed(OrderStatus.qc, OrderStatus.polishing),
      ).not.toThrow();
    });

    it('allows a normal one-step move casting → stone_setting', () => {
      expect(() =>
        assertTransitionAllowed(OrderStatus.casting, OrderStatus.stone_setting),
      ).not.toThrow();
    });

    it('always allows cancellation from a non-terminal stage', () => {
      expect(() =>
        assertTransitionAllowed(OrderStatus.booked, OrderStatus.cancelled),
      ).not.toThrow();
      expect(nextStages(OrderStatus.polishing)).toContain(OrderStatus.cancelled);
    });

    it('lets nothing move out of a terminal stage', () => {
      for (const t of TERMINAL_STAGES) {
        expect(nextStages(t)).toEqual([]);
      }
    });
  });

  describe('cancellation authority now sits with the store manager (2026-08)', () => {
    it('now ADMITS a store manager into cancelled (the transferred power)', () => {
      expect(() =>
        assertStageRoleAllowed('store_manager', OrderStatus.cancelled),
      ).not.toThrow();
    });

    it('still REJECTS a salesperson from cancelled', () => {
      expect(() =>
        assertStageRoleAllowed('salesperson', OrderStatus.cancelled),
      ).toThrow();
    });

    it('keeps delivery at store_manager and rejects a salesperson', () => {
      expect(() =>
        assertStageRoleAllowed('store_manager', OrderStatus.delivered),
      ).not.toThrow();
      expect(() =>
        assertStageRoleAllowed('salesperson', OrderStatus.delivered),
      ).toThrow();
    });
  });
});
