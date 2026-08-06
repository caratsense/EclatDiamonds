import { Injectable } from '@nestjs/common';
import { Prisma, PartyType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { PageRequest, Paginated } from '../common/pagination';

/** Decimal | null -> number | null (Decimals never cross the wire raw). */
function num(d: Prisma.Decimal | null | undefined): number | null {
  return d == null ? null : Number(d);
}
/** Date | null -> ISO string | null. */
function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

const VALID_TYPES = new Set(Object.values(PartyType) as string[]);

export interface PartyFilters {
  q?: string;
  /** PartyType to filter by, or 'all'. Controller defaults it to 'customer'. */
  type?: PartyType | 'all';
}

export interface PartyRow {
  id: string;
  name: string;
  code: string | null;
  types: PartyType[];
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  state: string | null;
  pincode: string | null;
  gstin: string | null;
  birthday: string | null;
  anniversary: string | null;
  creditLimit: number | null;
  isBlacklisted: boolean;
  /** Bills this party is linked to — the quick "how much of a customer" signal. */
  salesCount: number;
  createdAt: string | null;
}

/**
 * Party directory — the customer list the shop floor was missing (parties were
 * only reachable via global search before). Store-scoped like every other list
 * (CLAUDE.md rule #1) and searchable on name / code / city / email / phone.
 */
@Injectable()
export class PartiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  async list(
    user: AuthUser,
    f: PartyFilters,
    headerStore: string | undefined,
    pagination: PageRequest,
  ): Promise<Paginated<PartyRow>> {
    const where: Prisma.PartyWhereInput = { ...this.scope.storeFilter(user, headerStore) };

    // Role filter (customer / supplier / …). Unknown values are ignored rather
    // than 500-ing on an invalid enum; 'all' skips the filter entirely.
    if (f.type && f.type !== 'all' && VALID_TYPES.has(f.type)) {
      where.types = { has: f.type as PartyType };
    }

    const q = f.q?.trim();
    if (q) {
      const ci = { contains: q, mode: 'insensitive' as const };
      const digits = q.replace(/\D/g, '');
      where.OR = [
        { name: ci },
        { code: ci },
        { city: ci },
        { email: ci },
        { phone: ci },
        // Digits-heavy query also matches phone/whatsapp on the raw digit run,
        // so "+91 98250-…" style input still finds the row.
        ...(digits.length >= 4
          ? [{ phone: { contains: digits } }, { whatsapp: { contains: digits } }]
          : []),
      ];
    }

    const { page, pageSize } = pagination;
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.party.count({ where }),
      this.prisma.party.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          name: true,
          code: true,
          types: true,
          phone: true,
          whatsapp: true,
          email: true,
          addressLine1: true,
          addressLine2: true,
          city: true,
          state: true,
          pincode: true,
          gstin: true,
          birthday: true,
          anniversary: true,
          creditLimit: true,
          isBlacklisted: true,
          createdAt: true,
          _count: { select: { sales: true } },
        },
      }),
    ]);

    return {
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        code: p.code ?? null,
        types: p.types,
        phone: p.phone ?? null,
        whatsapp: p.whatsapp ?? null,
        email: p.email ?? null,
        addressLine1: p.addressLine1 ?? null,
        addressLine2: p.addressLine2 ?? null,
        city: p.city ?? null,
        state: p.state ?? null,
        pincode: p.pincode ?? null,
        gstin: p.gstin ?? null,
        birthday: iso(p.birthday),
        anniversary: iso(p.anniversary),
        creditLimit: num(p.creditLimit),
        isBlacklisted: p.isBlacklisted,
        salesCount: p._count.sales,
        createdAt: iso(p.createdAt),
      })),
      total,
      page,
      pageSize,
    };
  }
}
