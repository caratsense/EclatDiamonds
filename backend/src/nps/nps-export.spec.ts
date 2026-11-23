import { Workbook } from 'exceljs';

import { AuthUser } from '../common/auth-user';
import { NpsService } from './nps.service';

/**
 * The NPS workbook, in the shop's own clock.
 *
 * The importer stores a sheet timestamp as the shop's wall clock, so every
 * instant in NPS is a wall clock that has been anchored — 13:08 in the branch
 * is 07:38 UTC. The export rendered and ranged all of them in UTC, so every row
 * came out 5h30m early against the Google Sheet it is reconciled with, and each
 * day's window started and ended 5h30m early too.
 *
 * These tests state the RULE — what the branch submitted at a given wall clock
 * is what the file says, and a day's range is that day AT THE BRANCH — rather
 * than how the formatter is written.
 */

const USER: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: 'org_eclat',
  storeIds: ['nagpur'],
  allStores: true,
};

/** IST is +5:30, so these are the UTC instants the importer would have stored. */
const IST = {
  /** 13 Nov 2026, 13:08:59 at the branch. */
  ronitSubmitted: new Date('2026-11-13T07:38:59Z'),
  /** 10 Nov 2026, 10:13 at the branch. */
  visit: new Date('2026-11-10T04:43:00Z'),
  /** 15 Nov 2026, 00:00 at the branch — a bare date, anchored to local midnight. */
  followupDate: new Date('2026-11-14T18:30:00Z'),
  /** 15 Nov 2026, 12:21 at the branch. */
  followupSubmitted: new Date('2026-11-15T06:51:00Z'),
  /** 1 Nov 2026, 02:00 at the branch — inside November, outside UTC November. */
  firstHoursOfNovember: new Date('2026-10-31T20:30:00Z'),
  /** 30 Nov 2026, 23:30 at the branch — the last half hour of the range. */
  lastHoursOfNovember: new Date('2026-11-30T18:00:00Z'),
  /** 1 Dec 2026, 04:00 at the branch — December, however UTC reads it. */
  firstHoursOfDecember: new Date('2026-11-30T22:30:00Z'),
};

interface Row {
  submittedAt: Date;
  [key: string]: unknown;
}

interface RangeWhere {
  submittedAt?: { gte?: Date; lt?: Date };
  timeIn?: { gte?: Date; lte?: Date };
}

const inRange = (at: Date, r?: { gte?: Date; lt?: Date; lte?: Date }) =>
  (!r?.gte || at >= r.gte) &&
  (!r?.lt || at < r.lt) &&
  (!r?.lte || at <= r.lte);

const response = (submittedAt: Date, rawName: string): Row => ({
  submittedAt,
  rawName,
  rawNumber: '8888155700',
  firstPurchase: 'Yes',
  recommendAnswer: '10 - Extremely likely',
  visitPurpose: null,
  likedMost: null,
  couldImprove: null,
  notFound: null,
  heardAboutUs: null,
  followsSocial: null,
  concerns: null,
  score: 10,
  matchState: 'matched',
  matchNote: 'Matched on 918888155700.',
  party: { name: 'Ronit Gurav' },
  checkIn: { timeIn: IST.visit, store: { name: 'Nagpur' } },
});

const followup = (submittedAt: Date, followupDate: Date | null): Row => ({
  submittedAt,
  followupDate,
  rawName: 'Ronit Gurav',
  rawNumber: '8888155700',
  response: 'Will visit again',
  matchState: 'matched',
});

/** A visit as `updates()` selects it, with no ask and no submission attached. */
const visitRow = (timeIn: Date) => ({
  id: 'visit-1',
  customerName: 'Ronit Gurav',
  phone: '8888155700',
  timeIn,
  visitDate: timeIn,
  repName: 'Sales 1',
  managerName: 'Manager 1',
  npsMessageSentAt: null,
  npsResponseReceivedAt: null,
  partyId: 'party-1',
  store: { id: 'nagpur', name: 'Nagpur' },
  party: { id: 'party-1', name: 'Ronit Gurav' },
  npsResponses: [],
  npsFollowups: [{ id: 'f1', submittedAt: IST.followupSubmitted, followupDate: IST.followupDate, response: 'Will visit again' }],
});

function service(data: {
  visits?: ReturnType<typeof visitRow>[];
  responses?: Row[];
  followups?: Row[];
}) {
  const visits = data.visits ?? [];
  const dated = (rows: Row[], where: RangeWhere) =>
    rows.filter((r) => inRange(r.submittedAt, where.submittedAt));

  const prisma = {
    checkIn: {
      findMany: async ({ where }: { where: RangeWhere }) =>
        visits.filter((v) => inRange(v.timeIn, where.timeIn)),
      count: async ({ where }: { where: RangeWhere }) =>
        visits.filter((v) => inRange(v.timeIn, where.timeIn)).length,
    },
    feedbackRequest: { findMany: async () => [] },
    npsResponse: { findMany: async ({ where }: { where: RangeWhere }) => dated(data.responses ?? [], where) },
    npsFollowup: { findMany: async ({ where }: { where: RangeWhere }) => dated(data.followups ?? [], where) },
    organisation: { findUnique: async () => ({ settings: null }) },
  };
  const scope = {
    storeFilter: () => ({ storeId: { in: USER.storeIds } }),
    resolveTimezone: async () => 'Asia/Kolkata',
  };
  return new NpsService(prisma as never, scope as never);
}

/** The produced workbook, read back the way the client opens it. */
async function sheets(buffer: Buffer) {
  const wb = new Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const cells = (name: string) => {
    const ws = wb.getWorksheet(name)!;
    const out: string[][] = [];
    ws.eachRow((row) => {
      const values: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => values.push(String(cell.value ?? '')));
      out.push(values);
    });
    return out;
  };
  return cells;
}

describe('the NPS export is written in the branch clock, not UTC', () => {
  it('shows a 13:08 submission as 13:08, not 07:38', async () => {
    // Her sheet says 13/11/2026 13:08:59. A file that says 07:38 disagrees with
    // the source on every single row, which is what reconciliation is for.
    const svc = service({ responses: [response(IST.ronitSubmitted, 'Ronit Gurav')] });
    const out = await svc.exportXlsx(USER);

    const cells = await sheets(out.buffer);
    expect(cells('NPS Responses')[1][0]).toBe('2026-11-13 13:08');
  });

  it('shows a follow-up date on the day it names, not the evening before', async () => {
    // `followupDate` is a bare date anchored to local midnight, so UTC slicing
    // moved it back a whole day — 15 November was filed as the 14th.
    const svc = service({ followups: [followup(IST.followupSubmitted, IST.followupDate)] });
    const out = await svc.exportXlsx(USER);

    const cells = await sheets(out.buffer);
    expect(cells('Followup answers')[1]).toEqual(
      expect.arrayContaining(['2026-11-15 12:21', '2026-11-15 00:00']),
    );
  });

  it('shows a visit at the time the branch saw it', async () => {
    const svc = service({ visits: [visitRow(IST.visit)] });
    const out = await svc.exportXlsx(USER);

    const cells = await sheets(out.buffer);
    const [, row] = cells('NPS Updates');
    expect(row[4]).toBe('2026-11-10 10:13');
    // The follow-up column carries its date through the same formatter.
    expect(row[14]).toBe('2026-11-15 00:00: Will visit again');
  });

  it('ranges a day by the branch day, both ends', async () => {
    // "1 to 30 November" is November AT THE SHOP. Read in UTC the window slid
    // 5h30m early: it dropped the first hours of the 1st and swept in the small
    // hours of 1 December.
    const svc = service({
      responses: [
        response(IST.firstHoursOfNovember, 'First'),
        response(IST.lastHoursOfNovember, 'Last'),
        response(IST.firstHoursOfDecember, 'December'),
      ],
    });
    const out = await svc.exportXlsx(USER, { from: '2026-11-01', to: '2026-11-30' });

    const cells = await sheets(out.buffer);
    const names = cells('NPS Responses').slice(1).map((r) => r[1]);
    expect(names).toEqual(['First', 'Last']);
    expect(out.responses).toBe(2);
  });

  it('keeps a visit in the small hours of the next day out of the range', async () => {
    // Same boundary on the Updates tab, which is ranged on the visit instead.
    const svc = service({
      visits: [visitRow(new Date('2026-11-30T19:00:00Z')), visitRow(IST.visit)],
    });
    const out = await svc.exportXlsx(USER, { from: '2026-11-01', to: '2026-11-30' });

    expect(out.rows).toBe(1);
  });

  it('says in the file which clock the times are on', async () => {
    // The About tab stamps "Taken" in UTC; without this row a reader would take
    // the rows for UTC too.
    const svc = service({ responses: [response(IST.ronitSubmitted, 'Ronit Gurav')] });
    const out = await svc.exportXlsx(USER);

    const cells = await sheets(out.buffer);
    expect(cells('About')).toEqual(
      expect.arrayContaining([['Times shown in', 'Asia/Kolkata']]),
    );
  });
});
