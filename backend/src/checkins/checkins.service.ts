import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from '../crm/activity.service';
import { IdentityService } from '../crm/identity.service';
import { CheckoutDto, CreateCheckInDto } from './dto/checkin.dto';
import { DEFAULT_TZ, formatHHMMInTz } from '../common/tz.util';

const PURPOSE_LABEL: Record<string, string> = {
  bridal: 'Bridal',
  investment: 'Gold Coin / Investment',
  repair: 'Repair / Service',
  quote_followup: 'Quote Follow-up',
  browsing: 'Browsing',
  scheme: 'Gold Scheme',
  other: 'Browsing',
};

function initialsOf(name?: string | null): string {
  if (!name) return '—';
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * Store-local "HH:MM".
 *
 * This used to be `d.toISOString().slice(11, 16)`, which renders the instant in
 * UTC. For an Asia/Kolkata branch a customer who walked in at 10:30 was reported
 * as arriving at 05:00 — five and a half hours early, printed as fact on the
 * walk-in log, the "in store now" panel and the footfall-by-hour chart, which
 * peaked before the shutters were up. `formatHHMMInTz` is the helper the
 * dashboard and the DSR already use for exactly this.
 */
function hhmm(d: Date | null | undefined, tz: string): string | null {
  return formatHHMMInTz(d, tz);
}

/** Shape a CheckIn row into the frontend `CheckIn` (mock/checkins.ts). */
function toView(c: any, tz: string = DEFAULT_TZ) {
  const durationMin =
    c.timeOut ? Math.round((c.timeOut.getTime() - c.timeIn.getTime()) / 60000) : null;
  return {
    id: c.id,
    storeId: c.storeId,
    customer: c.customerName,
    returning: !!c.partyId,
    // The linked customer record, so the counter can open this walk-in's
    // history or log what they were shown. `returning` alone said that a
    // customer EXISTED without saying which one, which made every downstream
    // action re-resolve the phone number and risk resolving it differently.
    partyId: c.partyId ?? null,
    phone: c.phone ?? '',
    partySize: 1,
    purpose: PURPOSE_LABEL[c.purpose] ?? 'Browsing',
    repId: c.repId ?? c.attendedById ?? '',
    repName: c.repName ?? c.attendedBy?.name ?? '',
    repInitials: initialsOf(c.repName ?? c.attendedBy?.name),
    timeIn: hhmm(c.timeIn, tz),
    timeOut: hhmm(c.timeOut, tz),
    /**
     * The arrival as a real instant, alongside the wall clock above.
     *
     * The screen needs both: "10:30" to show a person, and something with a
     * date in it to answer "is this from today". It used to have only the first,
     * and the Check-ins page counted every row it was given as today's footfall.
     */
    timeInAt: c.timeIn,
    durationMin,
    outcome: c.outcome,
  };
}

@Injectable()
export class CheckinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly identity: IdentityService,
    private readonly activity: ActivityService,
  ) {}

  /** GET /checkins — footfall log, store-scoped (most recent first). */
  async list(user: AuthUser, headerStore?: string) {
    const where: Prisma.CheckInWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    // A salesperson only sees the walk-ins assigned to them; managers see all.
    //
    // Both columns, because there are two ways a visit gets attributed: the
    // walk-in form writes `repId`, and the floor app writes `attendedById`.
    // Testing only the first hid every visit the floor app recorded from the
    // person who recorded it.
    if (user.role === 'salesperson') {
      where.OR = [{ repId: user.id }, { attendedById: user.id }];
    }
    const tz = await this.scope.resolveTimezone(user, headerStore);
    const rows = await this.prisma.checkIn.findMany({
      where,
      orderBy: { timeIn: 'desc' },
      take: 200,
      include: { attendedBy: { select: { id: true, name: true } } },
    });
    return rows.map((r) => toView(r, tz));
  }

  /** POST /checkins — register a walk-in. */
  async create(user: AuthUser, dto: CreateCheckInDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);

    // Phase A6 — a walk-in is the moment a real person is in front of a
    // salesperson, which makes it the single best point to establish identity.
    // Best-effort: a check-in must never be blocked by an unusable phone number,
    // because the customer is standing there either way.
    const identity = await this.identity.resolveForRecord(user, {
      phone: dto.phone,
      name: dto.customerName,
      storeId: dto.storeId,
      source: 'checkin',
    });
    const partyId = identity.partyId;

    const row = await this.prisma.checkIn.create({
      data: {
        organisationId: user.organisationId,
        storeId: dto.storeId,
        partyId,
        customerName: dto.customerName,
        phone: dto.phone,
        purpose: dto.purpose ?? 'browsing',
        outcome: 'in_store',
        repId: dto.repId ?? user.id,
        repName: dto.repName ?? user.name,
        timeIn: new Date(),
      },
    });

    const tz = await this.scope.resolveTimezone(user, dto.storeId);

    await this.activity.recordFor(user, {
      type: 'visit.recorded',
      summary: `${dto.customerName} walked in (${dto.purpose ?? 'browsing'})`,
      partyId,
      storeId: dto.storeId,
      entityType: 'CheckIn',
      entityId: row.id,
      channel: 'store',
    });

    return toView(row, tz);
  }

  /** PATCH /checkins/:id — check the customer out (records timeOut + outcome). */
  async checkout(user: AuthUser, id: string, headerStore: string | undefined, dto: CheckoutDto) {
    // The header narrows the WRITE the same way it narrows the read. Without it
    // a manager with several branches could close a walk-in at a branch other
    // than the one their screen is showing.
    const existing = await this.prisma.checkIn.findFirst({
      where: { id, ...this.scope.storeFilter(user, headerStore) },
    });
    if (!existing) throw new NotFoundException('Check-in not found');
    // A salesperson can only close their own walk-in, not another rep's.
    if (user.role === 'salesperson' && existing.repId !== user.id) {
      throw new ForbiddenException('You can only check out your own walk-ins');
    }
    const row = await this.prisma.checkIn.update({
      where: { id },
      data: { timeOut: new Date(), outcome: dto.outcome ?? 'left' },
      include: { attendedBy: { select: { id: true, name: true } } },
    });
    return toView(row, await this.scope.resolveTimezone(user, headerStore));
  }
}
