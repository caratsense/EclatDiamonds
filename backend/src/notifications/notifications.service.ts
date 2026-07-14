import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ROLE_RANK } from '../common/role.util';

/** A single actionable-count row surfaced in the notifications bell. */
interface NotificationItem {
  type: 'discount' | 'return' | 'leave' | 'reminder';
  label: string;
  count: number;
  href: string;
}

/** End-of-today as a UTC instant — inclusive upper bound for `@db.Date` dueDate. */
function endOfTodayUtc(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate(), 23, 59, 59, 999));
}

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * GET /notifications/summary — role-aware, store-scoped actionable counts.
   * Every count is computed server-side with Prisma count() (no rows fetched);
   * only items with count > 0 are returned.
   */
  async summary(user: AuthUser, headerStore?: string) {
    const storeWhere = this.scope.storeFilter(user, headerStore);
    const rank = ROLE_RANK[user.role];
    const items: NotificationItem[] = [];

    // --- Discount approvals (store_manager+; only requests the user can act on) ---
    if (rank >= ROLE_RANK.store_manager) {
      // Roles the user outranks-or-equals => may approve a request requiring them.
      const actable = (Object.keys(ROLE_RANK) as Role[]).filter(
        (r) => rank >= ROLE_RANK[r],
      );
      const discount = await this.prisma.discountRequest.count({
        where: {
          ...storeWhere,
          status: { in: ['pending', 'escalated'] },
          OR: [
            { requiredRole: { in: actable } },
            // Legacy rows without requiredRole fall back to requestedRole, then HO.
            { requiredRole: null, requestedRole: { in: actable } },
            ...(user.role === 'head_office'
              ? [{ requiredRole: null, requestedRole: null }]
              : []),
          ],
        },
      });
      if (discount > 0) {
        items.push({ type: 'discount', label: 'Discount approvals', count: discount, href: '/approvals' });
      }
    }

    // --- Return approvals (head_office only) ---
    if (user.role === 'head_office') {
      const ret = await this.prisma.returnRecord.count({
        where: { ...storeWhere, status: 'pending_approval' },
      });
      if (ret > 0) {
        items.push({ type: 'return', label: 'Return approvals', count: ret, href: '/approvals' });
      }
    }

    // --- Leave requests (store_manager+) ---
    if (rank >= ROLE_RANK.store_manager) {
      const leave = await this.prisma.leaveRequest.count({
        where: { ...storeWhere, status: 'pending' },
      });
      if (leave > 0) {
        items.push({ type: 'leave', label: 'Leave requests', count: leave, href: '/approvals' });
      }
    }

    // --- Follow-ups due (everyone, incl. salesperson) ---
    const reminder = await this.prisma.leadFollowUp.count({
      where: { ...storeWhere, done: false, dueDate: { lte: endOfTodayUtc() } },
    });
    if (reminder > 0) {
      items.push({ type: 'reminder', label: 'Follow-ups due', count: reminder, href: '/reminders' });
    }

    const total = items.reduce((sum, i) => sum + i.count, 0);
    return { total, items };
  }
}
