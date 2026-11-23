import { BadRequestException } from '@nestjs/common';

import {
  describeExportRange,
  inclusiveTo,
  rangeFilename,
  rangeWhere,
  resolveExportRange,
} from './export-range';

/**
 * The rules the Excel dialog's range depends on, not the plumbing around them.
 *
 * Each of these has a failure mode that only shows up in a downloaded file:
 * a day missing off the end, a month's rows filed in the wrong month, or a
 * refusal where the client expected everything.
 */
describe('resolveExportRange', () => {
  it('treats the upper bound as the END of its day', () => {
    // 1-30 September means the whole of the 30th. An exclusive bound at
    // 1 October 00:00 is the only way to say that without enumerating hours.
    const range = resolveExportRange('2026-09-01', '2026-09-30');
    expect(range.from?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(range.to?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('is empty for all time, rather than very wide', () => {
    // The client downloads the whole sheet today. An absent bound has to mean
    // no filter, or every one of those downloads gains a WHERE clause and a
    // claim about dates nobody made.
    expect(resolveExportRange()).toEqual({});
    expect(resolveExportRange(undefined, undefined)).toEqual({});
  });

  it('accepts one end on its own', () => {
    // "Everything since 1 November" is a real question.
    expect(resolveExportRange('2026-11-01').to).toBeUndefined();
    expect(resolveExportRange(undefined, '2026-11-30').from).toBeUndefined();
  });

  it('refuses a backwards range instead of returning nothing', () => {
    // Zero rows and a successful download look identical on a desk.
    expect(() => resolveExportRange('2026-11-30', '2026-11-01')).toThrow(BadRequestException);
  });

  it('refuses a single day expressed backwards-free', () => {
    // One day is from == to, and must NOT be refused: its exclusive upper
    // bound is the next midnight, which is strictly after the lower one.
    const range = resolveExportRange('2026-11-21', '2026-11-21');
    expect(range.to!.getTime() - range.from!.getTime()).toBe(86_400_000);
  });
});

describe('rangeWhere', () => {
  it('names the column it was given, not createdAt', () => {
    // The whole point: a walk-in is dated by `timeIn`, an NPS response by
    // `submittedAt`. Ranging everything on `createdAt` because every table has
    // one produces files that look right and reconcile wrong.
    const where = rangeWhere('timeIn', resolveExportRange('2026-11-01', '2026-11-30'));
    expect(Object.keys(where)).toEqual(['timeIn']);
  });

  it('filters on nothing at all for all time', () => {
    // Spread into a Prisma `where`, `{}` adds no condition. A `{ gte: undefined }`
    // would, and Prisma reads an explicit undefined differently from an absent key.
    expect(rangeWhere('createdAt', {})).toEqual({});
  });

  it('uses lt, never lte, for the upper bound', () => {
    const where = rangeWhere('createdAt', resolveExportRange(undefined, '2026-11-30')) as {
      createdAt: { gte?: Date; lt?: Date };
    };
    expect(where.createdAt.lt).toBeDefined();
    expect(where.createdAt.gte).toBeUndefined();
  });
});

describe('inclusiveTo', () => {
  it('steps back one millisecond, for the readers that compare with lte', () => {
    const range = resolveExportRange('2026-11-01', '2026-11-30');
    // `NpsService.updates` and `CheckinsService.exportXlsx` both take a closed
    // interval. Handing them the exclusive instant would pull in a row stamped
    // exactly midnight on 1 December — one row, in the wrong month.
    expect(inclusiveTo(range)?.toISOString()).toBe('2026-11-30T23:59:59.999Z');
  });

  it('stays undefined when there is no upper bound', () => {
    expect(inclusiveTo({})).toBeUndefined();
  });
});

describe('naming the file', () => {
  it('puts the range in the name, so two downloads are told apart', () => {
    expect(rangeFilename('leads', '2026-11-01', '2026-11-30')).toBe(
      'leads-2026-11-01-to-2026-11-30.xlsx',
    );
  });

  it('leaves the plain name alone for all time', () => {
    // The download people already do every day must not change its name.
    expect(rangeFilename('walk-ins')).toBe('walk-ins.xlsx');
  });

  it('says which end it has when only one was given', () => {
    expect(rangeFilename('leads', '2026-11-01')).toBe('leads-from-2026-11-01.xlsx');
    expect(rangeFilename('leads', undefined, '2026-11-30')).toBe('leads-to-2026-11-30.xlsx');
  });
});

describe('describeExportRange', () => {
  it('says inclusive, because the boundary is what gets queried', () => {
    expect(describeExportRange('2026-11-01', '2026-11-30')).toBe(
      '2026-11-01 to 2026-11-30 (inclusive)',
    );
  });

  it('calls no range All time rather than leaving it blank', () => {
    expect(describeExportRange()).toBe('All time');
  });
});
