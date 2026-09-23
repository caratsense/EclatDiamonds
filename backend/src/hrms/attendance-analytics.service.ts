import { BadRequestException, Injectable } from '@nestjs/common';
import { AttendanceRecord, Prisma, Role } from '@prisma/client';
import { Workbook } from 'exceljs';
import { PDFDocument, PDFFont, StandardFonts, rgb } from 'pdf-lib';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import {
  businessDate,
  dateOnly,
  formatHHMMInTz,
  instantFromLocalTime,
  resolveTz,
} from '../common/tz.util';
import { classifyDay, DayState, eligibleStaff, ROSTER_ROLES } from './attendance-ops.service';
import type { AnalyticsQueryDto, ReportKind, ReportQueryDto } from './dto/attendance-analytics.dto';

const MUSTER_CODE: Record<DayState, string> = {
  present: 'P',
  half_day: 'HD',
  absent: 'A',
  on_leave: 'LV',
  week_off: 'WO',
  holiday: 'H',
  not_marked: '-',
};

const DAY_MS = 86_400_000;
const MAX_SPAN_DAYS = 92;

export interface Column {
  key: string;
  label: string;
}
export interface Report {
  kind: ReportKind;
  period: { from: string; to: string };
  columns: Column[];
  rows: Record<string, unknown>[];
  totals?: Record<string, unknown>;
}

interface Ctx {
  user: AuthUser;
  isHO: boolean;
  from: Date;
  to: Date;
  dates: Date[];
  storeIds: string[];
  stores: Map<string, { name: string; tz: string; latitude: number | null; longitude: number | null; radius: number }>;
  departmentId?: string;
  userId?: string;
}

interface Person {
  userId: string;
  name: string;
  phone: string | null;
  email: string;
  role: Role;
  isActive: boolean;
  storeIds: string[];
  employeeCode: string | null;
  departmentId: string | null;
  department: string | null;
  designation: string | null;
  profile: Prisma.EmployeeProfileGetPayload<object> | null;
}

/** One eligible employee-day at one store. */
interface Cell {
  userId: string;
  storeId: string;
  date: string;
  state: DayState;
  isLate: boolean;
  record: AttendanceRecord | null;
}

const hours = (mins: number) => Math.round((mins / 60) * 100) / 100;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const cols = (spec: string): Column[] =>
  spec.split('|').map((s) => {
    const [key, label] = s.split(':');
    return { key, label };
  });

/** One CSV cell, formula-safe (same rule as the catalogue export). */
function csvCell(value: unknown): string {
  const raw = value == null ? '' : String(value);
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(r: Report): string {
  const lines = [r.columns.map((c) => csvCell(c.label)).join(',')];
  for (const row of r.rows) lines.push(r.columns.map((c) => csvCell(row[c.key])).join(','));
  if (r.totals) lines.push(r.columns.map((c) => csvCell(r.totals![c.key])).join(','));
  // BOM so Excel reads UTF-8 names correctly.
  return `${String.fromCharCode(0xfeff)}${lines.join('\r\n')}\r\n`;
}

/** A real Office Open XML workbook, not CSV carrying an .xlsx extension. */
export async function toXlsx(r: Report): Promise<Buffer> {
  const workbook = new Workbook();
  workbook.creator = 'CaratOS';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Attendance', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = r.columns.map((column) => ({
    key: column.key,
    header: column.label,
    width: Math.min(
      42,
      Math.max(
        10,
        column.label.length + 2,
        ...r.rows.slice(0, 250).map((row) => String(row[column.key] ?? '').length + 2),
      ),
    ),
  }));
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3F342D' } };
  for (const row of r.rows) {
    sheet.addRow(Object.fromEntries(r.columns.map((column) => [column.key, row[column.key] ?? ''])));
  }
  if (r.totals) {
    const totals = sheet.addRow(
      Object.fromEntries(r.columns.map((column) => [column.key, r.totals?.[column.key] ?? ''])),
    );
    totals.font = { bold: true };
  }
  if (r.columns.length) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: r.columns.length },
    };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const PDF_PAGE: [number, number] = [841.89, 595.28]; // A4 landscape
const PDF_MARGIN = 24;
const PDF_INK = rgb(0.12, 0.12, 0.14);
const PDF_MUTED = rgb(0.42, 0.42, 0.46);
const PDF_RULE = rgb(0.8, 0.8, 0.83);

function printable(value: unknown, font: PDFFont): string {
  const supported = new Set(font.getCharacterSet());
  return [...String(value ?? '').replace(/₹/g, 'Rs. ').replace(/[\r\n\t]+/g, ' ')]
    .map((ch) => (supported.has(ch.codePointAt(0)!) ? ch : '?'))
    .join('');
}

function fitPdf(value: unknown, font: PDFFont, size: number, width: number): string {
  let text = printable(value, font);
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  while (text.length > 1 && font.widthOfTextAtSize(`${text}...`, size) > width) {
    text = text.slice(0, -1);
  }
  return `${text}...`;
}

/**
 * A compact, printable PDF. Wide reports are split into consecutive column
 * panels rather than silently dropping columns; every panel repeats the title,
 * period and row numbers so printed pages can be reconciled.
 */
export async function toPdf(r: Report): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Attendance ${r.kind}: ${r.period.from} to ${r.period.to}`);
  pdf.setAuthor('CaratOS');
  pdf.setCreator('CaratOS');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const columnPanels = Array.from(
    { length: Math.max(1, Math.ceil(r.columns.length / 7)) },
    (_, index) => r.columns.slice(index * 7, index * 7 + 7),
  );
  const rowsPerPage = 31;
  const printableRows = r.rows.length ? r.rows : [{}];

  for (let panelIndex = 0; panelIndex < columnPanels.length; panelIndex++) {
    const columns = columnPanels[panelIndex];
    for (let start = 0; start < printableRows.length; start += rowsPerPage) {
      const page = pdf.addPage(PDF_PAGE);
      const width = PDF_PAGE[0] - PDF_MARGIN * 2;
      const cellWidth = width / Math.max(columns.length, 1);
      let y = PDF_PAGE[1] - PDF_MARGIN;
      page.drawText(`Attendance - ${r.kind.replace(/-/g, ' ')}`, {
        x: PDF_MARGIN,
        y,
        size: 13,
        font: bold,
        color: PDF_INK,
      });
      page.drawText(`${r.period.from} to ${r.period.to}`, {
        x: PDF_MARGIN,
        y: y - 15,
        size: 8,
        font: regular,
        color: PDF_MUTED,
      });
      page.drawText(
        `Columns ${panelIndex * 7 + 1}-${panelIndex * 7 + columns.length} of ${r.columns.length} | rows ${start + 1}-${Math.min(start + rowsPerPage, r.rows.length)} of ${r.rows.length}`,
        { x: PDF_MARGIN + 210, y: y - 15, size: 8, font: regular, color: PDF_MUTED },
      );
      y -= 34;

      page.drawRectangle({
        x: PDF_MARGIN,
        y: y - 13,
        width,
        height: 16,
        color: rgb(0.25, 0.2, 0.18),
      });
      columns.forEach((column, index) => {
        page.drawText(fitPdf(column.label, bold, 7, cellWidth - 8), {
          x: PDF_MARGIN + index * cellWidth + 4,
          y: y - 8,
          size: 7,
          font: bold,
          color: rgb(1, 1, 1),
        });
      });
      y -= 17;

      for (const row of printableRows.slice(start, start + rowsPerPage)) {
        columns.forEach((column, index) => {
          page.drawText(fitPdf(row[column.key], regular, 6.5, cellWidth - 8), {
            x: PDF_MARGIN + index * cellWidth + 4,
            y: y - 8,
            size: 6.5,
            font: regular,
            color: PDF_INK,
          });
        });
        page.drawLine({
          start: { x: PDF_MARGIN, y: y - 11 },
          end: { x: PDF_PAGE[0] - PDF_MARGIN, y: y - 11 },
          thickness: 0.35,
          color: PDF_RULE,
        });
        y -= 15;
      }

      const isLastDataPage = start + rowsPerPage >= printableRows.length;
      if (r.totals && isLastDataPage) {
        columns.forEach((column, index) => {
          page.drawText(fitPdf(r.totals?.[column.key], bold, 6.5, cellWidth - 8), {
            x: PDF_MARGIN + index * cellWidth + 4,
            y: y - 8,
            size: 6.5,
            font: bold,
            color: PDF_INK,
          });
        });
      }
    }
  }
  return Buffer.from(await pdf.save());
}

/** Attendance KPIs, trends and the report families. See docs/modules/06-attendance.md. */
@Injectable()
export class AttendanceAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  // ==========================================================================
  // Context + shared loaders
  // ==========================================================================

  private async ctx(user: AuthUser, q: AnalyticsQueryDto & { userId?: string }): Promise<Ctx> {
    const storeIds = this.scope.effectiveStoreIds(user, q.storeId);
    const storeRows = storeIds.length
      ? await this.prisma.store.findMany({
          where: {
            id: { in: storeIds },
            organisationId: user.organisationId,
            isHolding: false,
          },
          select: { id: true, name: true, timezone: true, latitude: true, longitude: true, geofenceRadiusM: true },
        })
      : [];
    const stores = new Map(
      storeRows.map((s) => [
        s.id,
        {
          name: s.name,
          tz: resolveTz(s.timezone),
          latitude: s.latitude != null ? Number(s.latitude) : null,
          longitude: s.longitude != null ? Number(s.longitude) : null,
          radius: s.geofenceRadiusM ?? 150,
        },
      ]),
    );
    // Store-local business dates, never UTC today. A multi-zone roll-up anchors
    // to the first store (StoreScopeService.resolveTimezone's documented limit).
    const tz = stores.get(storeIds[0])?.tz ?? resolveTz(undefined);
    const today = businessDate(new Date(), tz);
    const to = q.to ? new Date(`${q.to}T00:00:00Z`) : today;
    const from = q.from
      ? new Date(`${q.from}T00:00:00Z`)
      : new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    if (to < from) throw new BadRequestException('`to` must be on or after `from`');
    const span = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
    if (span > MAX_SPAN_DAYS) throw new BadRequestException(`Date range too large (max ${MAX_SPAN_DAYS} days)`);
    const dates = Array.from({ length: span }, (_, i) => new Date(from.getTime() + i * DAY_MS));
    return {
      user,
      isHO: user.role === Role.head_office,
      from,
      to,
      dates,
      storeIds: [...stores.keys()],
      stores,
      departmentId: q.departmentId,
      userId: q.userId,
    };
  }

  /**
   * Everyone mapped to the scoped stores, with profile, department and
   * designation — one query. Roster roles only (the team rule), including
   * inactive/separated people so hiring/separation reports see them; the
   * attendance grid narrows further through `eligibleStaff`.
   */
  private async people(c: Ctx): Promise<Map<string, Person>> {
    const users = await this.prisma.user.findMany({
      where: {
        organisationId: c.user.organisationId,
        role: { in: ROSTER_ROLES },
        userStores: { some: { storeId: { in: c.storeIds } } },
        ...(c.userId ? { id: c.userId } : {}),
        ...(c.departmentId ? { employeeProfile: { departmentId: c.departmentId } } : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        role: true,
        isActive: true,
        userStores: { where: { storeId: { in: c.storeIds } }, select: { storeId: true } },
        employeeProfile: { include: { department: true, designation: true } },
      },
      orderBy: { name: 'asc' },
    });
    return new Map(
      users.map((u) => {
        const p = u.employeeProfile;
        return [
          u.id,
          {
            userId: u.id,
            name: u.name,
            phone: u.phone,
            email: u.email,
            role: u.role,
            isActive: u.isActive,
            storeIds: u.userStores.map((s) => s.storeId),
            employeeCode: p?.employeeCode ?? null,
            departmentId: p?.departmentId ?? null,
            department: p?.department?.name ?? null,
            designation: p?.designation?.name ?? null,
            profile: p,
          },
        ];
      }),
    );
  }

  /**
   * Every eligible employee-day in the range, classified exactly as Today and
   * day-close classify it (`eligibleStaff` + `classifyDay` from attendance-ops).
   * Records, leave, holidays and week-offs are each loaded ONCE for the range.
   */
  private async grid(c: Ctx, people: Map<string, Person>): Promise<Cell[]> {
    if (c.storeIds.length === 0 || people.size === 0) return [];
    const endExcl = new Date(c.to.getTime() + DAY_MS);
    const [eligibleByDate, records] = await Promise.all([
      // ponytail: one eligibility query per day (<= 92); fold into a range query if it shows in traces.
      Promise.all(c.dates.map((d) => eligibleStaff(this.prisma, c.user.organisationId, c.storeIds, d))),
      this.prisma.attendanceRecord.findMany({
        where: {
          storeId: { in: c.storeIds },
          date: { gte: c.from, lt: endExcl },
          staffId: { in: [...people.keys()] },
        },
      }),
    ]);
    const recordAt = new Map(records.map((r) => [`${r.staffId}|${r.storeId}|${dateOnly(r.date)}`, r]));
    const cells: Cell[] = [];
    c.dates.forEach((d, i) => {
      const date = dateOnly(d);
      for (const e of eligibleByDate[i]) {
        if (!people.has(e.userId)) continue; // department / userId filter
        const record = recordAt.get(`${e.userId}|${e.storeId}|${date}`) ?? null;
        const day = classifyDay(e, record);
        cells.push({ userId: e.userId, storeId: e.storeId, date, state: day.state, isLate: day.isLate, record });
      }
    });
    return cells;
  }

  private base(c: Ctx, p: Person | undefined, storeId?: string) {
    return {
      userId: p?.userId,
      employeeCode: p?.employeeCode ?? '',
      name: p?.name ?? '',
      store: storeId
        ? c.stores.get(storeId)?.name ?? ''
        : (p?.storeIds ?? []).map((s) => c.stores.get(s)?.name).filter(Boolean).join(', '),
      department: p?.department ?? '',
      designation: p?.designation ?? '',
    };
  }

  private local(c: Ctx, storeId: string, at: Date | null | undefined) {
    return formatHHMMInTz(at ?? null, c.stores.get(storeId)?.tz ?? resolveTz(undefined)) ?? '';
  }

  /** A day where the person came in but one punch is missing (or was invented by day-close). */
  private missedPunch(c: Ctx, cell: Cell): string | null {
    const r = cell.record;
    if (!r) return null;
    if (r.checkInAt && !r.checkOutAt) {
      // Today they may simply still be at work.
      const today = dateOnly(businessDate(new Date(), c.stores.get(cell.storeId)?.tz ?? resolveTz(undefined)));
      return cell.date < today ? 'In without out' : null;
    }
    if (!r.checkInAt && r.checkOutAt) return 'Out without in';
    if (r.checkInAt && r.autoClosed) return 'In without out (auto-closed at shift end)';
    return null;
  }

  // ==========================================================================
  // Overview
  // ==========================================================================

  async overview(user: AuthUser, q: AnalyticsQueryDto) {
    const c = await this.ctx(user, q);
    const people = await this.people(c);
    const cells = await this.grid(c, people);
    const period = { from: dateOnly(c.from), to: dateOnly(c.to) };

    type Acc = {
      headcount: Set<string>;
      present: number; half_day: number; absent: number; on_leave: number;
      week_off: number; holiday: number; not_marked: number;
      late: number; lateMins: number; otMins: number; missed: number;
    };
    const acc = (): Acc => ({
      headcount: new Set(), present: 0, half_day: 0, absent: 0, on_leave: 0,
      week_off: 0, holiday: 0, not_marked: 0, late: 0, lateMins: 0, otMins: 0, missed: 0,
    });
    const lastDay = period.to;
    const all = acc();
    const byStore = new Map<string, Acc>();
    const byDept = new Map<string, Acc>();
    const byUser = new Map<string, Acc>();
    const byDate = new Map<string, Acc>(c.dates.map((d) => [dateOnly(d), acc()]));
    const bump = <K>(m: Map<K, Acc>, k: K) => {
      let a = m.get(k);
      if (!a) m.set(k, (a = acc()));
      return a;
    };

    for (const cell of cells) {
      const deptKey = people.get(cell.userId)?.departmentId ?? '';
      for (const a of [all, bump(byStore, cell.storeId), bump(byDept, deptKey), bump(byUser, cell.userId), byDate.get(cell.date)!]) {
        a[cell.state]++;
        if (cell.date === lastDay) a.headcount.add(cell.userId);
        if (cell.isLate) {
          a.late++;
          a.lateMins += cell.record?.lateMinutes ?? 0;
        }
        a.otMins += cell.record?.overtimeMins ?? 0;
        if (this.missedPunch(c, cell)) a.missed++;
      }
    }

    // Attended / (attended + absent + not marked). Week-offs, holidays and leave
    // are not working days, so they never drag the rate down.
    const rate = (a: Acc) =>
      pct(a.present + a.half_day, a.present + a.half_day + a.absent + a.not_marked);

    const profiles = [...people.values()].map((p) => p.profile).filter((p) => p != null);
    const inRange = (d: Date | null) => d != null && d >= c.from && d <= c.to;
    const deptNames = new Map([...people.values()].map((p) => [p.departmentId ?? '', p.department ?? 'Unassigned']));

    return {
      period,
      headcount: all.headcount.size,
      kpis: {
        attendanceRate: rate(all),
        presentDays: all.present,
        absentDays: all.absent,
        leaveDays: all.on_leave,
        lateCount: all.late,
        avgLateMinutes: all.late ? Math.round(all.lateMins / all.late) : 0,
        halfDays: all.half_day,
        overtimeHours: hours(all.otMins),
        missedPunches: all.missed,
        newJoiners: profiles.filter((p) => inRange(p.dateOfJoining)).length,
        exits: profiles.filter((p) => inRange(p.exitDate)).length,
      },
      trend: [...byDate].map(([date, a]) => ({
        date,
        present: a.present,
        late: a.late,
        half_day: a.half_day,
        absent: a.absent,
        on_leave: a.on_leave,
        week_off: a.week_off,
        holiday: a.holiday,
        not_marked: a.not_marked,
      })),
      byStore: [...byStore].map(([storeId, a]) => ({
        storeId,
        storeName: c.stores.get(storeId)?.name ?? '',
        headcount: a.headcount.size,
        attendanceRate: rate(a),
        lateCount: a.late,
        absentDays: a.absent,
      })),
      byDepartment: [...byDept].map(([departmentId, a]) => ({
        departmentId: departmentId || null,
        departmentName: deptNames.get(departmentId) ?? 'Unassigned',
        headcount: a.headcount.size,
        attendanceRate: rate(a),
        lateCount: a.late,
        absentDays: a.absent,
      })),
      topLate: [...byUser]
        .filter(([, a]) => a.late > 0)
        .sort((x, y) => y[1].late - x[1].late)
        .slice(0, 10)
        .map(([userId, a]) => ({
          userId,
          name: people.get(userId)?.name ?? '',
          lateCount: a.late,
          avgLateMinutes: Math.round(a.lateMins / a.late),
        })),
      topAbsent: [...byUser]
        .filter(([, a]) => a.absent > 0)
        .sort((x, y) => y[1].absent - x[1].absent)
        .slice(0, 10)
        .map(([userId, a]) => ({ userId, name: people.get(userId)?.name ?? '', absentDays: a.absent })),
    };
  }

  // ==========================================================================
  // Reports
  // ==========================================================================

  async report(user: AuthUser, kind: ReportKind, q: ReportQueryDto): Promise<Report> {
    const c = await this.ctx(user, q);
    const people = await this.people(c);
    const period = { from: dateOnly(c.from), to: dateOnly(c.to) };
    const out = (columns: Column[], rows: Record<string, unknown>[], totals?: Record<string, unknown>): Report => ({
      kind,
      period,
      columns,
      rows,
      ...(totals ? { totals } : {}),
    });
    const who = 'employeeCode:Code|name:Name|store:Store|department:Department|designation:Designation';

    switch (kind) {
      case 'daily-register': {
        const cells = await this.grid(c, people);
        const rows = cells
          .sort((a, b) => a.date.localeCompare(b.date) || (people.get(a.userId)!.name.localeCompare(people.get(b.userId)!.name)))
          .map((cell) => {
            const r = cell.record;
            return {
              date: cell.date,
              ...this.base(c, people.get(cell.userId), cell.storeId),
              state: cell.state,
              late: cell.isLate ? 'Yes' : '',
              lateMinutes: cell.isLate ? r?.lateMinutes ?? 0 : '',
              in: this.local(c, cell.storeId, r?.checkInAt),
              out: this.local(c, cell.storeId, r?.checkOutAt),
              workedHours: r?.workedMins != null ? hours(r.workedMins) : '',
              overtimeHours: r?.overtimeMins ? hours(r.overtimeMins) : '',
              source: r?.source ?? '',
            };
          });
        return out(
          cols(`date:Date|${who}|state:Status|late:Late|lateMinutes:Late (min)|in:In|out:Out|workedHours:Worked (h)|overtimeHours:OT (h)|source:Source`),
          rows,
        );
      }

      case 'muster':
      case 'in-out': {
        const cells = await this.grid(c, people);
        const dayCols = c.dates.map((d) => ({ key: dateOnly(d), label: dateOnly(d).slice(8) }));
        const rowsByKey = new Map<string, Record<string, unknown>>();
        const counts = new Map<string, Record<string, number>>();
        for (const cell of cells) {
          const key = `${cell.userId}|${cell.storeId}`;
          let row = rowsByKey.get(key);
          if (!row) {
            rowsByKey.set(key, (row = this.base(c, people.get(cell.userId), cell.storeId)));
            counts.set(key, {});
          }
          if (kind === 'muster') {
            const code = cell.state === 'present' && cell.isLate ? 'L' : MUSTER_CODE[cell.state];
            row[cell.date] = code;
            const k = counts.get(key)!;
            k[code] = (k[code] ?? 0) + 1;
          } else {
            const r = cell.record;
            const io = [this.local(c, cell.storeId, r?.checkInAt), this.local(c, cell.storeId, r?.checkOutAt)];
            row[cell.date] = io[0] || io[1] ? io.join('-') : MUSTER_CODE[cell.state];
          }
        }
        const rows = [...rowsByKey].map(([key, row]) =>
          kind === 'muster'
            ? { ...row, ...Object.fromEntries(Object.entries(counts.get(key)!).map(([k, v]) => [`n_${k}`, v])) }
            : row,
        );
        const tail =
          kind === 'muster'
            ? ['P', 'L', 'HD', 'A', 'LV', 'WO', 'H', '-'].map((k) => ({ key: `n_${k}`, label: k }))
            : [];
        for (const r of rows) for (const t of tail) r[t.key] ??= 0;
        return out([...cols(who), ...dayCols, ...tail], rows.sort((a, b) => String(a.name).localeCompare(String(b.name))));
      }

      case 'monthly-summary': {
        const cells = await this.grid(c, people);
        const byKey = new Map<string, Record<string, any>>();
        const keys = ['present', 'late', 'half_day', 'absent', 'on_leave', 'week_off', 'holiday', 'not_marked'] as const;
        for (const cell of cells) {
          const key = `${cell.userId}|${cell.storeId}`;
          let row = byKey.get(key);
          if (!row) {
            row = { ...this.base(c, people.get(cell.userId), cell.storeId), payableDays: 0, workedMins: 0, otMins: 0 };
            for (const k of keys) row[k] = 0;
            byKey.set(key, row);
          }
          row[cell.state]++;
          if (cell.isLate) row.late++;
          const r = cell.record;
          row.workedMins += r?.workedMins ?? 0;
          row.otMins += r?.overtimeMins ?? 0;
          // Payroll's rule (PayrollService.countDays): an attended day earns its
          // dayFraction (1 if never computed); leave, week-off and holiday are
          // paid; absent and not-marked are not.
          if (cell.state === 'present' || cell.state === 'half_day') {
            row.payableDays += r?.dayFraction != null ? Number(r.dayFraction) : cell.state === 'half_day' ? 0.5 : 1;
          } else if (cell.state === 'on_leave' || cell.state === 'week_off' || cell.state === 'holiday') {
            row.payableDays += 1;
          }
        }
        const rows = [...byKey.values()]
          .map(({ workedMins, otMins, ...row }): Record<string, any> => ({
            ...row,
            payableDays: Math.round(row.payableDays * 100) / 100,
            workedHours: hours(workedMins),
            overtimeHours: hours(otMins),
          }))
          .sort((a, b) => String(a.name).localeCompare(String(b.name)));
        const sumKeys = [...keys, 'payableDays', 'workedHours', 'overtimeHours'];
        const totals: Record<string, unknown> = { employeeCode: 'Total' };
        for (const k of sumKeys) {
          totals[k] = Math.round(rows.reduce((s, r) => s + Number((r as any)[k] ?? 0), 0) * 100) / 100;
        }
        return out(
          cols(
            `${who}|present:Present|late:Late|half_day:Half day|absent:Absent|on_leave:Leave|week_off:Week off|holiday:Holiday|not_marked:Not marked|payableDays:Payable days|workedHours:Worked (h)|overtimeHours:OT (h)`,
          ),
          rows,
          totals,
        );
      }

      case 'late-early': {
        const cells = await this.grid(c, people);
        const rows = cells
          .filter((x) => x.isLate || (x.record?.earlyOutMinutes ?? 0) > 0)
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((cell) => ({
            date: cell.date,
            ...this.base(c, people.get(cell.userId), cell.storeId),
            in: this.local(c, cell.storeId, cell.record?.checkInAt),
            out: this.local(c, cell.storeId, cell.record?.checkOutAt),
            lateMinutes: cell.isLate ? cell.record?.lateMinutes ?? 0 : 0,
            earlyOutMinutes: cell.record?.earlyOutMinutes ?? 0,
          }));
        return out(cols(`date:Date|${who}|in:In|out:Out|lateMinutes:Late (min)|earlyOutMinutes:Early out (min)`), rows);
      }

      case 'missed-punch': {
        const cells = await this.grid(c, people);
        const rows = cells
          .map((cell) => ({ cell, issue: this.missedPunch(c, cell) }))
          .filter((x) => x.issue)
          .sort((a, b) => a.cell.date.localeCompare(b.cell.date))
          .map(({ cell, issue }) => ({
            date: cell.date,
            ...this.base(c, people.get(cell.userId), cell.storeId),
            in: this.local(c, cell.storeId, cell.record?.checkInAt),
            out: this.local(c, cell.storeId, cell.record?.checkOutAt),
            issue,
          }));
        return out(cols(`date:Date|${who}|in:In|out:Out|issue:Issue`), rows);
      }

      case 'constant-absent': {
        const minDays = q.minDays ?? 2;
        const cells = await this.grid(c, people);
        const byKey = new Map<string, Cell[]>();
        for (const cell of cells) {
          const k = `${cell.userId}|${cell.storeId}`;
          byKey.set(k, [...(byKey.get(k) ?? []), cell]);
        }
        const rows: Record<string, unknown>[] = [];
        for (const list of byKey.values()) {
          list.sort((a, b) => a.date.localeCompare(b.date));
          // A week-off or holiday inside a run neither breaks nor extends it.
          let run: Cell[] = [];
          const flush = () => {
            if (run.length >= minDays) {
              rows.push({
                ...this.base(c, people.get(run[0].userId), run[0].storeId),
                from: run[0].date,
                to: run[run.length - 1].date,
                days: run.length,
              });
            }
            run = [];
          };
          for (const cell of list) {
            if (cell.state === 'absent') run.push(cell);
            else if (cell.state !== 'week_off' && cell.state !== 'holiday') flush();
          }
          flush();
        }
        rows.sort((a, b) => Number(b.days) - Number(a.days));
        return out(cols(`${who}|from:From|to:To|days:Consecutive absent days`), rows);
      }

      case 'leave-balance': {
        // Balance years are Indian financial years (Apr-Mar) in the app, and the
        // calendar year on EzAttendance imports; show whichever exist for `to`.
        const cy = c.to.getUTCFullYear();
        const fy = c.to.getUTCMonth() >= 3 ? cy : cy - 1;
        const balances = await this.prisma.leaveBalance.findMany({
          where: { userId: { in: [...people.keys()] }, year: { in: [...new Set([fy, cy])] } },
          orderBy: [{ year: 'asc' }, { type: 'asc' }],
        });
        const rows = balances
          .map((b) => ({
            ...this.base(c, people.get(b.userId)),
            type: b.type,
            year: b.year,
            allocated: Number(b.allocated),
            used: Number(b.used),
            remaining: Number(b.allocated) - Number(b.used),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return out(cols(`${who}|type:Leave type|year:Year|allocated:Allocated|used:Used|remaining:Remaining`), rows);
      }

      case 'leave-register': {
        const leaves = await this.prisma.leaveRequest.findMany({
          where: {
            storeId: { in: c.storeIds },
            staffId: { in: [...people.keys()] },
            fromDate: { lte: c.to },
            toDate: { gte: c.from },
          },
          orderBy: { fromDate: 'asc' },
        });
        const rows = leaves.map((l) => ({
          ...this.base(c, people.get(l.staffId), l.storeId),
          type: l.type,
          from: dateOnly(l.fromDate),
          to: dateOnly(l.toDate),
          days: l.days != null ? Number(l.days) : '',
          halfDay: l.halfDay ? 'Yes' : '',
          status: l.status,
          reason: l.reason ?? '',
          decidedBy: l.decidedByName ?? '',
          decidedAt: l.decidedAt ? l.decidedAt.toISOString() : '',
        }));
        return out(
          cols(`${who}|type:Type|from:From|to:To|days:Days|halfDay:Half day|status:Status|reason:Reason|decidedBy:Decided by|decidedAt:Decided at`),
          rows,
        );
      }

      case 'punch-log':
      case 'gps': {
        const ids = [...people.keys()];
        const firstTz = c.stores.get(c.storeIds[0])?.tz ?? resolveTz(undefined);
        // Local-day window, padded by the widest real offset so no store's day is clipped.
        const start = new Date(instantFromLocalTime(c.from, 0, firstTz).getTime() - DAY_MS / 2);
        const end = new Date(instantFromLocalTime(c.to, 24 * 60, firstTz).getTime() + DAY_MS / 2);
        const punches = await this.prisma.rawPunchEvent.findMany({
          where: {
            organisationId: c.user.organisationId,
            userId: { in: ids },
            eventAt: { gte: start, lt: end },
            OR: [{ storeId: { in: c.storeIds } }, { storeId: null }],
            ...(kind === 'gps' ? { lat: { not: null }, lng: { not: null } } : {}),
          },
          orderBy: { eventAt: 'asc' },
        });
        const fromStr = dateOnly(c.from);
        const toStr = dateOnly(c.to);
        const rows = punches
          .map((p) => {
            const storeId = p.storeId ?? people.get(p.userId)?.storeIds[0] ?? '';
            const store = c.stores.get(storeId);
            const tz = store?.tz ?? firstTz;
            const date = dateOnly(businessDate(p.eventAt, tz));
            const lat = p.lat != null ? Number(p.lat) : null;
            const lng = p.lng != null ? Number(p.lng) : null;
            const distanceM =
              lat != null && lng != null && store?.latitude != null && store.longitude != null
                ? Math.round(haversineM(store.latitude, store.longitude, lat, lng))
                : null;
            return {
              date,
              time: formatHHMMInTz(p.eventAt, tz) ?? '',
              ...this.base(c, people.get(p.userId), storeId),
              kind: p.kind,
              source: p.source,
              lat: lat ?? '',
              lng: lng ?? '',
              accuracyM: p.accuracyM ?? '',
              distanceM: distanceM ?? '',
              withinFence: distanceM == null ? '' : distanceM <= store!.radius ? 'Yes' : 'No',
              note: p.note ?? '',
              voided: p.voidedAt ? 'Yes' : '',
            };
          })
          .filter((r) => r.date >= fromStr && r.date <= toStr);
        return kind === 'punch-log'
          ? out(cols(`date:Date|time:Time|${who}|kind:In/Out|source:Source|note:Note|voided:Voided`), rows)
          : out(
              cols(`date:Date|time:Time|${who}|kind:In/Out|lat:Latitude|lng:Longitude|accuracyM:Accuracy (m)|distanceM:Distance (m)|withinFence:In fence|voided:Voided`),
              rows,
            );
      }

      case 'birthdays': {
        const month = q.month ?? c.to.getUTCMonth() + 1;
        const rows = [...people.values()]
          .filter((p) => p.isActive && p.profile?.status === 'active' && p.profile.dateOfBirth?.getUTCMonth() === month - 1)
          .sort((a, b) => a.profile!.dateOfBirth!.getUTCDate() - b.profile!.dateOfBirth!.getUTCDate())
          .map((p) => {
            const dob = p.profile!.dateOfBirth!;
            // Day + month only below head office: a birth year is an age.
            return {
              ...this.base(c, p),
              birthday: c.isHO ? dateOnly(dob) : dob.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }),
            };
          });
        return out(cols(`${who}|birthday:Birthday`), rows);
      }

      case 'hiring':
      case 'separation': {
        const field = kind === 'hiring' ? 'dateOfJoining' : 'exitDate';
        const rows = [...people.values()]
          .filter((p) => {
            const d = p.profile?.[field];
            return d != null && d >= c.from && d <= c.to;
          })
          .sort((a, b) => a.profile![field]!.getTime() - b.profile![field]!.getTime())
          .map((p) => ({
            ...this.base(c, p),
            dateOfJoining: p.profile!.dateOfJoining ? dateOnly(p.profile!.dateOfJoining) : '',
            employmentType: p.profile!.employmentType,
            ...(kind === 'separation'
              ? { exitDate: dateOnly(p.profile!.exitDate!), exitReason: p.profile!.exitReason ?? '' }
              : {}),
          }));
        return kind === 'hiring'
          ? out(cols(`${who}|dateOfJoining:Date of joining|employmentType:Employment type`), rows)
          : out(cols(`${who}|dateOfJoining:Date of joining|exitDate:Exit date|exitReason:Exit reason`), rows);
      }

      case 'employee-details': {
        const rows = [...people.values()].map((p) => {
          const pr = p.profile;
          const d = (x: Date | null | undefined) => (x ? dateOnly(x) : '');
          return {
            ...this.base(c, p),
            role: p.role,
            phone: p.phone ?? '',
            personalEmail: pr?.personalEmail ?? '',
            gender: pr?.gender ?? '',
            unit: pr?.unit ?? '',
            dateOfJoining: d(pr?.dateOfJoining),
            dateOfConfirmation: d(pr?.dateOfConfirmation),
            exitDate: d(pr?.exitDate),
            employmentType: pr?.employmentType ?? '',
            status: pr?.status ?? (p.isActive ? 'active' : 'inactive'),
            shiftCode: pr?.shiftCode ?? '',
            biometricNo: pr?.biometricNo ?? '',
            // Sensitive: head office only (never even sent below it).
            ...(c.isHO
              ? { dateOfBirth: d(pr?.dateOfBirth), bloodGroup: pr?.bloodGroup ?? '', address: pr?.address ?? '' }
              : {}),
          };
        });
        const sensitive = c.isHO ? '|dateOfBirth:Date of birth|bloodGroup:Blood group|address:Address' : '';
        return out(
          cols(
            `${who}|role:Role|phone:Phone|personalEmail:Personal email|gender:Gender|unit:Unit|dateOfJoining:Date of joining|dateOfConfirmation:Date of confirmation|exitDate:Exit date|employmentType:Employment type|status:Status|shiftCode:Shift|biometricNo:Biometric no${sensitive}`,
          ),
          rows,
        );
      }
    }
  }
}

/** Haversine distance in metres. */
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const a =
    Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lng2 - lng1) / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
