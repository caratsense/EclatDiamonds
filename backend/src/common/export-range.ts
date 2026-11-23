import { BadRequestException } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsISO8601, IsOptional } from 'class-validator';
import type { Workbook } from 'exceljs';

/**
 * The date range every Excel download asks for.
 *
 * ## Why one helper rather than a range per export
 *
 * Six screens offer a workbook and each one had its own idea of a window: the
 * lead export read `from`/`to` as UTC days, the walk-ins export took a
 * `{ from, to }` of instants that only the scheduler ever filled, and customers,
 * quotations and NPS took none at all. The client (21 Nov) asked for the same
 * pop-up everywhere, which only works if "from this to this date" means the same
 * thing everywhere.
 *
 * ## The two rules that are easy to get wrong
 *
 * **The upper bound is EXCLUSIVE.** A person asking for 1–30 September means the
 * whole of the 30th, so `to=2026-09-30` resolves to `< 1 October 00:00`, never
 * `<= 30 September 00:00` — which would silently drop a full day's rows off the
 * end of every range.
 *
 * **Both bounds absent is a legitimate answer.** "All time" is not a missing
 * input to be rejected; it is what the client downloads today and must stay one
 * click away. An empty range therefore produces no filter at all rather than an
 * open-ended one.
 */

/** A resolved window. `to` is EXCLUSIVE; either end may be absent ("all time"). */
export interface ExportRange {
  from?: Date;
  to?: Date;
}

/** `from`/`to` as they arrive on the query string: `YYYY-MM-DD`, or absent. */
export class ExportRangeQueryDto {
  @IsOptional()
  @IsISO8601()
  @Transform(blankToUndefined)
  from?: string;

  @IsOptional()
  @IsISO8601()
  @Transform(blankToUndefined)
  to?: string;
}

/**
 * An omitted parameter and an empty one both mean "no bound".
 *
 * The dialog sends `?from=&to=` for All time rather than rebuilding the query
 * string, and `@IsISO8601()` would reject the empty strings — so a tenant asking
 * for everything would get a 400 instead of a workbook.
 */
function blankToUndefined({ value }: { value: unknown }): string | undefined {
  if (value == null) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

const DAY_MS = 86_400_000;

/**
 * Turn the two calendar dates into instants.
 *
 * Read as UTC days, deliberately. A manager picking a range by hand is choosing
 * dates off a calendar, and shifting those by a branch's offset would make
 * "1 November" mean 31 October in the file — the opposite of the surprise it
 * would be protecting against. Callers that must be exact to a branch's midnight
 * (the scheduled reports) compute their own instants and never come through here.
 */
export function resolveExportRange(from?: string, to?: string): ExportRange {
  const range: ExportRange = {};
  if (from) {
    const start = new Date(`${from.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) throw new BadRequestException('That "from" date is not a date.');
    range.from = start;
  }
  if (to) {
    const endOfDay = new Date(`${to.slice(0, 10)}T00:00:00.000Z`);
    if (Number.isNaN(endOfDay.getTime())) throw new BadRequestException('That "to" date is not a date.');
    range.to = new Date(endOfDay.getTime() + DAY_MS);
  }
  if (range.from && range.to && range.to <= range.from) {
    throw new BadRequestException('The "to" date is before the "from" date.');
  }
  return range;
}

/**
 * The range as a Prisma filter on one named column, or `{}` for all time.
 *
 * The column is the caller's choice and it matters: a lead is ranged by when the
 * lead arrived, a walk-in by when the customer walked in, an NPS response by
 * when it was submitted. Ranging all of them on `createdAt` because it exists on
 * every table produces files that look right and reconcile wrong.
 */
export function rangeWhere<T extends string>(
  column: T,
  range: ExportRange,
): Record<T, { gte?: Date; lt?: Date }> | Record<string, never> {
  if (!range.from && !range.to) return {};
  return {
    [column]: {
      ...(range.from ? { gte: range.from } : {}),
      ...(range.to ? { lt: range.to } : {}),
    },
  } as Record<T, { gte?: Date; lt?: Date }>;
}

/**
 * The upper bound as an INCLUSIVE instant, for a reader that compares with
 * `lte` rather than `lt`.
 *
 * `NpsService.updates` and `CheckinsService.exportXlsx` both predate this helper
 * and both take a closed interval. Taking the millisecond off here, once, is why
 * neither of them has to be rewritten — and why neither of them picks up a row
 * stamped exactly midnight on the day AFTER the range, which is the one boundary
 * somebody reconciles by hand.
 */
export function inclusiveTo(range: ExportRange): Date | undefined {
  return range.to ? new Date(range.to.getTime() - 1) : undefined;
}

/** What the range covers, in the words that go in the file and on screen. */
export function describeExportRange(from?: string, to?: string): string {
  const f = from?.slice(0, 10);
  const t = to?.slice(0, 10);
  if (f && t) return `${f} to ${t} (inclusive)`;
  if (f) return `${f} onwards`;
  if (t) return `up to and including ${t}`;
  return 'All time';
}

/**
 * The range in the FILENAME.
 *
 * Two workbooks on a desk with the same name, different row counts and nothing
 * to tell them apart is the next question we get asked. All time keeps the plain
 * stem, so the download people already do every day is unchanged.
 */
export function rangeFilename(stem: string, from?: string, to?: string): string {
  const f = from?.slice(0, 10);
  const t = to?.slice(0, 10);
  if (f && t) return `${stem}-${f}-to-${t}.xlsx`;
  if (f) return `${stem}-from-${f}.xlsx`;
  if (t) return `${stem}-to-${t}.xlsx`;
  return `${stem}.xlsx`;
}

/**
 * State the range inside the workbook.
 *
 * A spreadsheet outlives the screen it came from, and a reader six months later
 * has no other way to know whether a short file is a quiet month or a narrow
 * filter. Written as a sheet rather than a banner row above the headings because
 * a row above the headings breaks every `AutoFilter`, `VLOOKUP` and pivot built
 * on the file — which is what people do with these.
 *
 * `management.controller.ts` already shipped this convention as its "About" tab;
 * this is that tab, extracted so all six exports say it the same way.
 */
export function addExportAboutSheet(
  wb: Workbook,
  about: {
    /** What the workbook is, in the tenant's words: "Leads", "Walk-ins". */
    what: string;
    /** The column the range was applied to, named as a person would say it. */
    rangedOn: string;
    from?: string;
    to?: string;
    /**
     * The window already in words, for a caller that no longer holds the two
     * dates. The scheduled reports and the walk-ins service both receive
     * instants rather than calendar strings, and re-deriving "1 to 30 November"
     * from a pair of instants would reintroduce the timezone question the
     * calling layer has already answered.
     */
    label?: string;
    rows: number;
    /** Anything else worth stating: a store filter, an exclusion. */
    notes?: [string, string][];
  },
): void {
  const ws = wb.addWorksheet('About');
  ws.addRow(['Export', about.what]);
  ws.addRow(['Covers', about.label ?? describeExportRange(about.from, about.to)]);
  ws.addRow(['Dated by', about.rangedOn]);
  ws.addRow(['Rows', about.rows]);
  ws.addRow(['Taken', new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC']);
  for (const [label, value] of about.notes ?? []) ws.addRow([label, value]);
  ws.getColumn(1).font = { bold: true };
  ws.getColumn(1).width = 22;
  ws.getColumn(2).width = 80;
}
