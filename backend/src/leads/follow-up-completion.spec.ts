import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { FollowUpRemindersService } from '../crm/follow-up-reminders.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { LeadsService, hasMeaningfulRemark } from './leads.service';

/**
 * What "mark follow-up done" means, in the client's words (Nov):
 *
 *  1. "Remark has to be added after each follow-up" — a completed follow-up
 *     without one is refused by the SERVER, not only by the dialog.
 *  2. "There should be an option to close the reminders. If the follow-up is
 *     done and everything is sorted, no further reminder for that customer is
 *     needed." — a decision of its own: completing a follow-up never stops the
 *     next one by itself, and stopping touches nobody else's customer.
 *  3. "Maybe they do not want to follow up this month, they want next month.
 *     There should be a button to edit the follow-up date." — the new date
 *     REPLACES the pending schedule instead of standing beside it.
 *
 * The follow-up rows live in a small in-memory stand-in for Prisma rather than
 * in Postgres: every rule above is about which rows the service writes and what
 * it leaves on them, which is exactly what this can show, in a second.
 */

const DAY_MS = 86_400_000;

interface Row {
  id: string;
  leadId: string;
  storeId: string;
  seq: number;
  dueDate: Date;
  done: boolean;
  doneAt: Date | null;
  doneById: string | null;
  note: string | null;
  assigneeId: string | null;
  reminderAt: Date | null;
  reminderNotifiedAt: Date | null;
}

const MANAGER: AuthUser = {
  id: 'mgr_bandra',
  name: 'Ayushi',
  email: 'ayushi@nibhana.local',
  role: Role.store_manager,
  organisationId: 'org_nibhana',
  storeIds: ['store_bandra'],
  allStores: false,
};

const LEADS: Record<string, any> = {
  lead_priya: {
    id: 'lead_priya',
    ref: 'LD-2041',
    customerName: 'Priya Shah',
    phone: '9876543210',
    ownerId: 'rep_bandra',
    organisationId: MANAGER.organisationId,
    partyId: 'party_priya',
    store: { name: 'Bandra', timezone: 'Asia/Kolkata' },
  },
  lead_meera: {
    id: 'lead_meera',
    ref: 'LD-2042',
    customerName: 'Meera Rao',
    phone: '9876501234',
    ownerId: 'rep_bandra',
    organisationId: MANAGER.organisationId,
    partyId: 'party_meera',
    store: { name: 'Bandra', timezone: 'Asia/Kolkata' },
  },
};

/** Prisma, as far as `updateFollowUp` uses it. */
function fakePrisma(rows: Row[]) {
  const notes: { leadId: string; text: string | null }[] = [];
  let created = 0;
  const prisma = {
    notes,
    leadFollowUp: {
      findUnique: async ({ where }: any) => {
        const row = rows.find((r) => r.id === where.id);
        return row ? { ...row, lead: LEADS[row.leadId] } : null;
      },
      findMany: async ({ where }: any) =>
        rows
          .filter((r) => r.leadId === where.leadId && r.done === where.done)
          .map((r) => ({ ...r })),
      aggregate: async ({ where }: any) => ({
        _max: {
          seq: rows
            .filter((r) => r.leadId === where.leadId)
            .reduce<number | null>((max, r) => (max === null || r.seq > max ? r.seq : max), null),
        },
      }),
      update: async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        const { doneBy, ...scalars } = data;
        Object.assign(row, scalars);
        // The service connects the actor through the relation, as Prisma does.
        if (doneBy?.connect) row.doneById = doneBy.connect.id;
        if (doneBy?.disconnect) row.doneById = null;
        return { ...row, lead: LEADS[row.leadId] };
      },
      create: async ({ data }: any) => {
        const row: Row = {
          id: `new_${++created}`,
          done: false,
          doneAt: null,
          doneById: null,
          note: null,
          reminderNotifiedAt: null,
          ...data,
        };
        rows.push(row);
        return { ...row, lead: LEADS[row.leadId] };
      },
    },
    lead: { update: async () => ({}) },
    leadNote: {
      create: async ({ data }: any) => {
        notes.push({ leadId: data.leadId, text: data.text ?? null });
        return data;
      },
    },
    $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
  };
  return prisma;
}

function serviceFor(rows: Row[]) {
  const prisma = fakePrisma(rows);
  // Only three collaborators are reached from this path; the rest belong to
  // lead creation and are never called here.
  const unused = undefined as never;
  const service = new LeadsService(
    prisma as unknown as PrismaService,
    { assertStoreAllowed: () => {} } as unknown as StoreScopeService,
    unused,
    unused,
    unused,
    unused,
    {
      resolveReminderAt: async ({ dueDay }: { dueDay: Date }) =>
        new Date(dueDay.getTime() + 10 * 3_600_000),
    } as unknown as FollowUpRemindersService,
    // Tagging belongs to lead CREATION; nothing on this path reaches it.
    unused,
  );
  return { service, prisma };
}

/** The SOP pair a new lead is seeded with, plus one for another customer. */
function schedule(): Row[] {
  const base = Date.now();
  const row = (id: string, leadId: string, seq: number, days: number, note: string | null): Row => ({
    id,
    leadId,
    storeId: 'store_bandra',
    seq,
    dueDate: new Date(base + days * DAY_MS),
    done: false,
    doneAt: null,
    doneById: null,
    note,
    assigneeId: 'rep_bandra',
    reminderAt: new Date(base + days * DAY_MS),
    reminderNotifiedAt: null,
  });
  return [
    row('fu_priya_1', 'lead_priya', 1, 7, null),
    row('fu_priya_2', 'lead_priya', 2, 30, 'Diwali budget'),
    row('fu_meera_1', 'lead_meera', 1, 7, null),
  ];
}

const pending = (rows: Row[], leadId: string) =>
  rows.filter((r) => r.leadId === leadId && !r.done);

describe('A remark after each follow-up', () => {
  it('refuses a completed follow-up with no remark at all', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await expect(service.updateFollowUp(MANAGER, 'fu_priya_1', { done: true })).rejects.toThrow(
      BadRequestException,
    );
    expect(pending(rows, 'lead_priya')).toHaveLength(2);
  });

  it('refuses a remark of nothing but whitespace', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await expect(
      service.updateFollowUp(MANAGER, 'fu_priya_1', { done: true, note: '   \n\t ' }),
    ).rejects.toThrow(BadRequestException);
    // Refused before anything was written: the follow-up is still owed.
    expect(rows.find((r) => r.id === 'fu_priya_1')!.done).toBe(false);
  });

  it('refuses punctuation that says nothing', () => {
    expect(hasMeaningfulRemark('...')).toBe(false);
    expect(hasMeaningfulRemark('—')).toBe(false);
    expect(hasMeaningfulRemark('')).toBe(false);
    expect(hasMeaningfulRemark(undefined)).toBe(false);
  });

  it('takes a remark in the words the counter actually uses', () => {
    expect(hasMeaningfulRemark('ok')).toBe(true);
    expect(hasMeaningfulRemark('Paid 20000')).toBe(true);
    expect(hasMeaningfulRemark('शनिवार को आएंगे')).toBe(true);
  });

  it('keeps the remark, who marked it done and when', async () => {
    const rows = schedule();
    const { service, prisma } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', {
      done: true,
      note: 'Spoke to her — coming in Saturday to finalise.',
    });
    const row = rows.find((r) => r.id === 'fu_priya_1')!;
    expect(row.done).toBe(true);
    expect(row.note).toBe('Spoke to her — coming in Saturday to finalise.');
    expect(row.doneById).toBe(MANAGER.id);
    expect(row.doneAt).toBeInstanceOf(Date);
    // And it reaches the lead's own notes, where the next person looks.
    expect(prisma.notes).toEqual([
      { leadId: 'lead_priya', text: 'Spoke to her — coming in Saturday to finalise.' },
    ]);
  });
});

describe('Closing the reminders for a customer', () => {
  it('does not happen just because a follow-up was completed', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', { done: true, note: 'Called, will visit' });
    // The +30d reminder still goes: being done with today is not being done.
    expect(pending(rows, 'lead_priya').map((r) => r.id)).toEqual(['fu_priya_2']);
  });

  it('closes every follow-up still pending on that lead when asked', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', {
      done: true,
      note: 'Bought the set, nothing pending',
      stopReminders: true,
    });
    expect(pending(rows, 'lead_priya')).toHaveLength(0);
  });

  it('leaves another customer’s follow-ups alone', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', {
      done: true,
      note: 'Bought the set, nothing pending',
      stopReminders: true,
    });
    expect(pending(rows, 'lead_meera').map((r) => r.id)).toEqual(['fu_meera_1']);
  });

  it('keeps what was already written on a closed row, and names who closed it', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', {
      done: true,
      note: 'Bought the set, nothing pending',
      stopReminders: true,
    });
    const closed = rows.find((r) => r.id === 'fu_priya_2')!;
    expect(closed.note).toBe('Diwali budget · Reminders stopped by Ayushi');
    expect(closed.doneById).toBe(MANAGER.id);
    // The one that was actually done keeps its own remark, untouched.
    expect(rows.find((r) => r.id === 'fu_priya_1')!.note).toBe('Bought the set, nothing pending');
  });
});

describe('Moving the follow-up to next month', () => {
  const nextMonth = '2027-01-15';

  it('replaces the pending schedule instead of adding a second reminder', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', {
      done: true,
      note: 'Not buying this month, asked to be called in January',
      nextDueDate: nextMonth,
    });
    const still = pending(rows, 'lead_priya');
    expect(still).toHaveLength(1);
    expect(still[0].dueDate.toISOString().slice(0, 10)).toBe(nextMonth);
    // Next in the lead's own sequence, so it sorts after the SOP pair.
    expect(still[0].seq).toBe(3);
    expect(still[0].assigneeId).toBe('rep_bandra');
    expect(still[0].reminderAt).toBeInstanceOf(Date);
  });

  it('says on the old row where the follow-up went', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', {
      done: true,
      note: 'Not buying this month, asked to be called in January',
      nextDueDate: nextMonth,
    });
    expect(rows.find((r) => r.id === 'fu_priya_2')!.note).toBe(
      `Diwali budget · Next follow-up moved to ${nextMonth}`,
    );
  });

  it('leaves another customer’s schedule where it was', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await service.updateFollowUp(MANAGER, 'fu_priya_1', {
      done: true,
      note: 'Not buying this month, asked to be called in January',
      nextDueDate: nextMonth,
    });
    expect(pending(rows, 'lead_meera').map((r) => r.id)).toEqual(['fu_meera_1']);
  });

  it('refuses stopping the reminders and booking the next one at once', async () => {
    const rows = schedule();
    const { service } = serviceFor(rows);
    await expect(
      service.updateFollowUp(MANAGER, 'fu_priya_1', {
        done: true,
        note: 'Sorted',
        stopReminders: true,
        nextDueDate: nextMonth,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(pending(rows, 'lead_priya')).toHaveLength(2);
  });
});
