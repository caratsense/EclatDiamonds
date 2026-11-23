import { BadRequestException } from '@nestjs/common';
import { Workbook } from 'exceljs';

import { AuthUser } from '../common/auth-user';
import { NpsService } from './nps.service';
import {
  NPS_FOLLOWUPS_SHEET,
  NPS_RESPONSES_SHEET,
  cellValue,
  mapFollowupRows,
  mapResponseRows,
  parseNpsTimestamp,
  readNpsUpload,
} from './nps-sheet';

/**
 * Getting the client's sheet in.
 *
 * NPS shipped with a model, a matcher, two screens and an export, and no way to
 * put a row in: nothing called the importers, so production carried 0 responses
 * and 0 follow-ups and none of it could be exercised. These tests cover the
 * route that fixes that, at the two points where it can quietly go wrong —
 * reading her columns, and re-reading the same file.
 */

/** Her workbook's columns, verbatim, including the trailing space she typed. */
const RESPONSE_HEADERS = [
  'Timestamp ',
  'Name',
  'Number',
  'Is this your first purchase with Nibhana?',
  'How likely are you to recommend Nibhana to your friends and family?',
  'What was the purpose of your visit?',
  'What is the one thing you liked about our products and services?',
  'What is the one thing we could improve to serve you better next time?',
  "Was there any product you were searching for but didn't find in our store?",
  'How did you come to know about us?',
  'Do you follow our brand on social media?',
  'Kindly share your concerns or suggestions, if any',
];

const RONIT = [
  '13/11/2026 13:08:59',
  'Ronit Gurav',
  '8888155700',
  'Yes',
  '10 - Extremely likely',
  'Wedding shopping',
  'The designs',
  'Nothing',
  'No',
  'Instagram',
  'Yes',
  '',
];

function sheet(name: string, headers: string[], rows: unknown[][]) {
  return { name, headers, rows };
}

/** Build a workbook that looks like her export: the two tabs, plus the others. */
async function workbook(
  tabs: { name: string; headers: string[]; rows: unknown[][] }[],
): Promise<Buffer> {
  const wb = new Workbook();
  for (const tab of tabs) {
    const ws = wb.addWorksheet(tab.name);
    ws.addRow(tab.headers);
    for (const row of tab.rows) ws.addRow(row);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function csv(headers: string[], rows: string[][]): Buffer {
  const line = (cells: string[]) => cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
  return Buffer.from([line(headers), ...rows.map(line)].join('\n'), 'utf8');
}

/** A parsed table, with the cells flattened the way the readers flatten them. */
const table = (headers: string[], rows: unknown[][]) => ({
  name: NPS_RESPONSES_SHEET,
  headers,
  rows: rows.map((row) => row.map(cellValue)),
  rowNumbers: rows.map((_, i) => i + 2),
});

describe('reading the client NPS workbook', () => {
  it('finds the two tabs by name in a workbook full of others', async () => {
    // Her file has ten tabs and the walk-in register is the FIRST one. The
    // generic import parser reads worksheet 1, which is why this one does not.
    const buffer = await workbook([
      sheet('Walkin Register Answers', ['Timestamp', 'Name'], [['13/11/2026 10:00:00', 'Someone']]),
      sheet(NPS_RESPONSES_SHEET, RESPONSE_HEADERS, [RONIT]),
      sheet('Sheet9', ['x'], [['y']]),
      sheet(NPS_FOLLOWUPS_SHEET, ['Timestamp', 'Followup Date', 'Name', 'Number', 'Followup Response'], [
        ['15/11/2026 12:21:53', '15/11/2026', 'Ronit Gurav', '8888155700', 'Will visit again'],
      ]),
    ]);

    const tables = await readNpsUpload(buffer, 'Daily Walkin Reporting (2).xlsx');
    expect(tables.responses?.name).toBe(NPS_RESPONSES_SHEET);
    expect(tables.followups?.name).toBe(NPS_FOLLOWUPS_SHEET);
    expect(tables.sheetNames).toHaveLength(4);
    expect(mapResponseRows(tables.responses!).rows).toHaveLength(1);
    expect(mapFollowupRows(tables.followups!).rows).toHaveLength(1);
  });

  it('says which tabs it found when neither is there', async () => {
    const buffer = await workbook([sheet('Walkin Register Answers', ['Timestamp'], [['x']])]);
    await expect(readNpsUpload(buffer, 'register.xlsx')).rejects.toThrow(BadRequestException);
    await expect(readNpsUpload(buffer, 'register.xlsx')).rejects.toThrow(
      /Walkin Register Answers/,
    );
  });

  it('reads a single tab exported as CSV, deciding which sheet it is from its columns', async () => {
    const responses = await readNpsUpload(csv(RESPONSE_HEADERS, [RONIT as string[]]), 'nps.csv');
    expect(responses.responses?.headers).toHaveLength(RESPONSE_HEADERS.length);
    expect(responses.followups).toBeNull();

    const followups = await readNpsUpload(
      csv(
        ['Timestamp', 'Followup Date', 'Name', 'Number', 'Followup Response'],
        [['15/11/2026 12:21:53', '15/11/2026', 'Ronit', '8888155700', 'Will visit again']],
      ),
      'followups.csv',
    );
    expect(followups.followups?.rows).toHaveLength(1);
    expect(followups.responses).toBeNull();
  });
});

describe('matching her columns', () => {
  it('ignores case, trailing spaces and the apostrophe Google substitutes', () => {
    const shouted = RESPONSE_HEADERS.map((h) =>
      h.toUpperCase().replace("didn't", 'DIDN’T').concat('  '),
    );
    const { rows } = mapResponseRows(table(shouted, [RONIT]));
    expect(rows[0].recommendAnswer).toBe('10 - Extremely likely');
    expect(rows[0].notFound).toBe('No');
    expect(rows[0].number).toBe('8888155700');
  });

  it('ignores a column it does not recognise instead of refusing the file', () => {
    const headers = [...RESPONSE_HEADERS, 'Internal note added by the team'];
    const { rows, ignoredColumns } = mapResponseRows(table(headers, [[...RONIT, 'call her back']]));
    expect(rows).toHaveLength(1);
    expect(ignoredColumns).toEqual(['Internal note added by the team']);
  });

  it('imports a sheet that is missing an optional question', () => {
    // She removes and re-adds questions between campaigns; the columns that
    // survive must still come through.
    const keep = [0, 1, 2, 4];
    const { rows } = mapResponseRows(
      table(
        keep.map((i) => RESPONSE_HEADERS[i]),
        [keep.map((i) => RONIT[i])],
      ),
    );
    expect(rows[0].recommendAnswer).toBe('10 - Extremely likely');
    expect(rows[0].likedMost).toBeNull();
    expect(rows[0].concerns).toBeNull();
  });

  it('refuses a sheet with no timestamp column, naming what it did find', () => {
    expect(() => mapResponseRows(table(['Name', 'Number'], [['Ronit', '8888155700']]))).toThrow(
      /no Timestamp column/,
    );
  });

  it('keeps a row with no phone number, for the importer to record as unmatched', () => {
    const anonymous = [...RONIT];
    anonymous[2] = '';
    const { rows, skipped } = mapResponseRows(table(RESPONSE_HEADERS, [anonymous]));
    expect(skipped).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBeNull();
  });

  it('skips a row with no usable timestamp and says why, rather than dropping it', () => {
    const undated = [...RONIT];
    undated[0] = '';
    const { rows, skipped } = mapResponseRows(table(RESPONSE_HEADERS, [undated, RONIT]));
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ row: 2, reason: expect.stringContaining('no stable identity') }]);
  });
});

describe('a sheet timestamp is a wall clock in the shop, not UTC', () => {
  it('reads her 13:08:59 as 07:38:59 UTC', () => {
    // Taking the digits as UTC would place the submission 5h30m later than it
    // happened — far enough to swallow that afternoon's visit and attach the
    // feedback to the wrong one of a repeat customer's two visits.
    expect(parseNpsTimestamp('13/11/2026 13:08:59')?.toISOString()).toBe(
      '2026-11-13T07:38:59.000Z',
    );
  });

  it('reads an Excel date cell, which ExcelJS hands back labelled UTC', () => {
    expect(parseNpsTimestamp(new Date(Date.UTC(2026, 10, 13, 13, 8, 59)))?.toISOString()).toBe(
      '2026-11-13T07:38:59.000Z',
    );
  });

  it('takes 05/11/2026 as 5 November, the way en-IN writes it', () => {
    expect(parseNpsTimestamp('05/11/2026 10:00')?.toISOString()).toBe('2026-11-05T04:30:00.000Z');
  });

  it('trusts a string that states its own offset', () => {
    expect(parseNpsTimestamp('2026-11-13T13:08:59Z')?.toISOString()).toBe(
      '2026-11-13T13:08:59.000Z',
    );
  });

  it.each(['', 'not a date', '31/02/2026', '13/11/1970'])('refuses %s', (bad) => {
    expect(parseNpsTimestamp(bad)).toBeNull();
  });
});

// ============================================================ the import itself

const USER: AuthUser = {
  id: 'u1',
  name: 'Ayushi',
  email: 'ayushi@example.com',
  role: 'head_office',
  organisationId: 'org_eclat',
  storeIds: ['nagpur'],
  allStores: true,
};

interface Stored {
  importKey: string;
  matchState: string;
  [key: string]: unknown;
}

/**
 * Enough Prisma to answer the question that matters: does a second upload of
 * the same file create a second row? The store is keyed by `importKey`, exactly
 * as the unique index is.
 */
function fakePrisma(visits: { id: string; partyId: string | null; timeIn: Date; phone: string }[]) {
  const responses = new Map<string, Stored>();
  const followups = new Map<string, Stored>();
  const collection = (store: Map<string, Stored>) => ({
    findUnique: async ({ where }: { where: { importKey: string } }) =>
      store.has(where.importKey) ? { id: where.importKey } : null,
    update: async ({ where, data }: { where: { importKey: string }; data: Stored }) => {
      store.set(where.importKey, { ...data, importKey: where.importKey });
    },
    create: async ({ data }: { data: Stored }) => {
      store.set(data.importKey, data);
    },
  });

  const prisma = {
    npsResponse: collection(responses),
    npsFollowup: collection(followups),
    checkIn: {
      findMany: async ({ where }: { where: { phone: { in: string[] } } }) =>
        visits.filter((v) => where.phone.in.includes(v.phone)),
      updateMany: async () => ({ count: 1 }),
    },
    feedbackRequest: { updateMany: async () => ({ count: 0 }) },
  };
  return { prisma, responses, followups };
}

const nps = (prisma: unknown) => new NpsService(prisma as never, undefined as never);

describe('uploading the sheet', () => {
  const visit = {
    id: 'visit-1',
    partyId: 'party-1',
    timeIn: new Date('2026-11-10T10:13:00Z'),
    phone: '8888155700',
  };

  async function upload(prisma: unknown, buffer: Buffer) {
    return nps(prisma).importUpload(USER, { buffer, originalname: 'Daily Walkin Reporting.xlsx' });
  }

  it('creates the rows the module had none of, and matches them to the visit', async () => {
    const { prisma, responses } = fakePrisma([visit]);
    const buffer = await workbook([
      sheet('Walkin Register Answers', ['Timestamp'], [['13/11/2026 10:00:00']]),
      sheet(NPS_RESPONSES_SHEET, RESPONSE_HEADERS, [RONIT]),
    ]);

    const result = await upload(prisma, buffer);
    expect(result.responses).toMatchObject({
      sheet: NPS_RESPONSES_SHEET,
      received: 1,
      created: 1,
      updated: 0,
      matched: 1,
      ambiguous: 0,
      unmatched: 0,
    });
    expect(result.followups).toBeNull();
    expect(responses.size).toBe(1);
  });

  it('updates instead of duplicating when the same sheet is uploaded again', async () => {
    // Re-uploading is the normal operation, not a mistake: she sends the whole
    // export every time, so the second upload of 50 rows must still be 50 rows.
    const { prisma, responses } = fakePrisma([visit]);
    const buffer = await workbook([sheet(NPS_RESPONSES_SHEET, RESPONSE_HEADERS, [RONIT])]);

    const first = await upload(prisma, buffer);
    const second = await upload(prisma, buffer);

    expect(first.responses).toMatchObject({ created: 1, updated: 0 });
    expect(second.responses).toMatchObject({ created: 0, updated: 1 });
    expect(responses.size).toBe(1);
  });

  it('counts a response it cannot match, rather than hiding it', async () => {
    // The number of rows that reached nobody is the point of the screen.
    const stranger = [...RONIT];
    stranger[2] = '9999999999';
    const noNumber = [...RONIT];
    noNumber[0] = '14/11/2026 09:00:00';
    noNumber[2] = '';

    const { prisma } = fakePrisma([visit]);
    const buffer = await workbook([
      sheet(NPS_RESPONSES_SHEET, RESPONSE_HEADERS, [RONIT, stranger, noNumber]),
    ]);

    const result = await upload(prisma, buffer);
    expect(result.responses).toMatchObject({ received: 3, matched: 1, unmatched: 2 });
  });

  it('imports the follow-up tab in the same upload', async () => {
    const { prisma, followups } = fakePrisma([visit]);
    const buffer = await workbook([
      sheet(NPS_RESPONSES_SHEET, RESPONSE_HEADERS, [RONIT]),
      sheet(
        NPS_FOLLOWUPS_SHEET,
        ['Timestamp', 'Followup Date', 'Name', 'Number', 'Followup Response'],
        [['15/11/2026 12:21:53', '15/11/2026', 'Ronit Gurav', '8888155700', 'Will visit again']],
      ),
    ]);

    const result = await upload(prisma, buffer);
    expect(result.followups).toMatchObject({
      sheet: NPS_FOLLOWUPS_SHEET,
      received: 1,
      created: 1,
      matched: 1,
    });
    expect(followups.size).toBe(1);
  });

  it('refuses an empty upload with something a person can act on', async () => {
    await expect(nps(fakePrisma([]).prisma).importUpload(USER, undefined)).rejects.toThrow(
      /No file uploaded/,
    );
  });
});
