import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { CheckoutDto, CreateCheckInDto } from './dto/checkin.dto';

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

function hhmm(d?: Date | null): string | null {
  if (!d) return null;
  return d.toISOString().slice(11, 16);
}

/** Shape a CheckIn row into the frontend `CheckIn` (mock/checkins.ts). */
function toView(c: any) {
  const durationMin =
    c.timeOut ? Math.round((c.timeOut.getTime() - c.timeIn.getTime()) / 60000) : null;
  return {
    id: c.id,
    storeId: c.storeId,
    customer: c.customerName,
    returning: !!c.partyId,
    phone: c.phone ?? '',
    partySize: 1,
    purpose: PURPOSE_LABEL[c.purpose] ?? 'Browsing',
    repId: c.repId ?? '',
    repName: c.repName ?? '',
    repInitials: initialsOf(c.repName),
    timeIn: hhmm(c.timeIn),
    timeOut: hhmm(c.timeOut),
    durationMin,
    outcome: c.outcome,
  };
}

@Injectable()
export class CheckinsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /** GET /checkins — footfall log, store-scoped (most recent first). */
  async list(user: AuthUser, headerStore?: string) {
    const where: Prisma.CheckInWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
    };
    // A salesperson only sees the walk-ins assigned to them; managers see all.
    if (user.role === 'salesperson') where.repId = user.id;
    const rows = await this.prisma.checkIn.findMany({
      where,
      orderBy: { timeIn: 'desc' },
      take: 200,
    });
    return rows.map(toView);
  }

  /** POST /checkins — register a walk-in. */
  async create(user: AuthUser, dto: CreateCheckInDto) {
    this.scope.assertStoreAllowed(user, dto.storeId);
    const row = await this.prisma.checkIn.create({
      data: {
        storeId: dto.storeId,
        customerName: dto.customerName,
        phone: dto.phone,
        purpose: dto.purpose ?? 'browsing',
        outcome: 'in_store',
        repId: dto.repId ?? user.id,
        repName: dto.repName ?? user.name,
        timeIn: new Date(),
      },
    });
    return toView(row);
  }

  /** PATCH /checkins/:id — check the customer out (records timeOut + outcome). */
  async checkout(user: AuthUser, id: string, dto: CheckoutDto) {
    const existing = await this.prisma.checkIn.findFirst({
      where: { id, ...this.scope.storeFilter(user) },
    });
    if (!existing) throw new NotFoundException('Check-in not found');
    const row = await this.prisma.checkIn.update({
      where: { id },
      data: { timeOut: new Date(), outcome: dto.outcome ?? 'left' },
    });
    return toView(row);
  }
}
