import { Injectable } from '@nestjs/common';
import { Prisma, ProductCategory } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped, partyWorkedBy } from '../common/sales-scope';
import { isAllStoreRole } from '../common/role.util';

/**
 * Global dashboard search (GET /search?q=) — one query fans out to every entity
 * synced from the legacy SJE Plus system (Party/Product/StockItem/Sale) plus the
 * Eclat-native records (Lead/CustomOrder/Quote). All groups are store-scoped via
 * StoreScopeService.storeFilter (CLAUDE.md rule #1).
 *
 * Performance: current volumes are a few thousand rows per table, so plain
 * case-insensitive `contains` (ILIKE '%q%') is fine. The scale-up path is
 * pg_trgm GIN indexes on the searched text columns — no code change needed here.
 */

/** Fixed group order — the frontend renders groups in exactly this sequence. */
const GROUP_DEFS = [
  { key: 'customers', label: 'Customers' },
  { key: 'designs', label: 'Designs' },
  { key: 'stock', label: 'Stock' },
  { key: 'bills', label: 'Bills' },
  { key: 'leads', label: 'Leads' },
  { key: 'orders', label: 'Orders' },
  { key: 'quotes', label: 'Quotes' },
] as const;

type GroupKey = (typeof GROUP_DEFS)[number]['key'];

const TAKE = 8;

/** Decimal | null -> number | null (Decimals never cross the wire raw). */
function num(d: Prisma.Decimal | null | undefined): number | null {
  return d == null ? null : Number(d);
}

/** Date | null -> ISO string | null. */
function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  async search(user: AuthUser, q: string, headerStore?: string) {
    const scope = this.scope.storeFilter(user, headerStore);

    // Case-insensitive substring on text fields.
    const ci = { contains: q, mode: 'insensitive' as const };

    // Digits-heavy query (>=4 digits): ALSO match phone fields on the raw digit
    // substring, so "98250 12345" / "+91-98250..." style input still finds the row.
    const digits = q.replace(/\D/g, '');
    const phoneDigits = digits.length >= 4 ? digits : null;
    const phoneOr = (field: string): Prisma.Enumerable<any> =>
      phoneDigits ? [{ [field]: { contains: phoneDigits } }] : [];

    // Product.category is an enum — no `contains` possible; match it only when the
    // query is exactly a category value (e.g. "ring", "necklace").
    const catMatch = (Object.values(ProductCategory) as string[]).includes(
      q.toLowerCase(),
    )
      ? [{ category: q.toLowerCase() as ProductCategory }]
      : [];

    // --- Per-group where clauses (every one merges the store scope) -----------

    // Party is synced from legacy PartyMst with storeId always set by the sync
    // agent, so it is store-scoped like everything else (no OR-null carve-out —
    // same treatment finance gives the nullable LedgerEntry.storeId).
    const mine = isSalesScoped(user);
    const partyWhere: Prisma.PartyWhereInput = {
      ...scope,
      ...(mine ? { AND: [partyWorkedBy(user.id)] } : {}),
      // Archived contacts are out of the working lists, and search is the most
      // common way back into one. The Archived Contacts screen is the only door.
      archivedAt: null,
      OR: [{ name: ci }, { phone: ci }, ...phoneOr('phone')],
    };

    const productWhere: Prisma.ProductWhereInput = {
      ...scope,
      OR: [{ name: ci }, { sku: ci }, ...catMatch],
    };

    const stockWhere: Prisma.StockItemWhereInput = {
      ...scope,
      OR: [
        { sku: ci },
        { name: ci },
        { hallmarkNo: ci },
        { certificateNo: ci },
      ],
    };

    const saleWhere: Prisma.SaleWhereInput = {
      ...scope,
      ...(mine ? { salesPersonId: user.id } : {}),
      OR: [
        { docNo: ci },
        { customerName: ci },
        // Legacy-synced bills carry no free-text customerName — their customer
        // lives on the linked Party, so match that too.
        { party: { name: ci } },
      ],
    };

    const leadWhere: Prisma.LeadWhereInput = {
      ...scope,
      // A salesperson only owns their leads — don't leak colleagues' via search.
      ...(mine ? { ownerId: user.id } : {}),
      OR: [{ customerName: ci }, { phone: ci }, { ref: ci }, ...phoneOr('phone')],
    };

    const orderWhere: Prisma.CustomOrderWhereInput = {
      ...scope,
      // An order has no owner of its own; a salesperson sees their customers'.
      ...(mine ? { party: partyWorkedBy(user.id) } : {}),
      OR: [{ ref: ci }, { customerName: ci }, { item: ci }],
    };

    // "@" kaccha quotes are head_office-only everywhere (see quotes.service.ts) —
    // never leak them through global search either.
    const quoteWhere: Prisma.QuoteWhereInput = {
      ...scope,
      ...(mine ? { assignedRepId: user.id } : {}),
      ...(isAllStoreRole(user.role) ? {} : { isKaccha: false }),
      OR: [{ ref: ci }, { customerName: ci }, { phone: ci }, ...phoneOr('phone')],
    };

    // --- Fan out: items (take 8, newest first) + total count per group --------

    const [
      parties,
      partyTotal,
      products,
      productTotal,
      stockItems,
      stockTotal,
      sales,
      saleTotal,
      leads,
      leadTotal,
      orders,
      orderTotal,
      quotes,
      quoteTotal,
    ] = await Promise.all([
      this.prisma.party.findMany({
        where: partyWhere,
        select: { id: true, name: true, phone: true, storeId: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.party.count({ where: partyWhere }),
      this.prisma.product.findMany({
        where: productWhere,
        select: { id: true, name: true, sku: true, category: true, imageUrl: true },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.product.count({ where: productWhere }),
      this.prisma.stockItem.findMany({
        where: stockWhere,
        select: {
          id: true,
          sku: true,
          name: true,
          category: true,
          status: true,
          grossWeight: true,
          netWeight: true,
          tagPrice: true,
          storeId: true,
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.stockItem.count({ where: stockWhere }),
      this.prisma.sale.findMany({
        where: saleWhere,
        select: {
          id: true,
          docNo: true,
          customerName: true,
          totalAmount: true,
          docDate: true,
          storeId: true,
          party: { select: { name: true } },
        },
        orderBy: { docDate: 'desc' },
        take: TAKE,
      }),
      this.prisma.sale.count({ where: saleWhere }),
      this.prisma.lead.findMany({
        where: leadWhere,
        select: {
          id: true,
          ref: true,
          customerName: true,
          phone: true,
          stage: true,
          storeId: true,
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.lead.count({ where: leadWhere }),
      this.prisma.customOrder.findMany({
        where: orderWhere,
        select: {
          id: true,
          ref: true,
          customerName: true,
          item: true,
          stage: true,
          storeId: true,
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.customOrder.count({ where: orderWhere }),
      this.prisma.quote.findMany({
        where: quoteWhere,
        select: {
          id: true,
          ref: true,
          customerName: true,
          grandTotal: true,
          status: true,
          storeId: true,
        },
        orderBy: { createdAt: 'desc' },
        take: TAKE,
      }),
      this.prisma.quote.count({ where: quoteWhere }),
    ]);

    const items: Record<GroupKey, unknown[]> = {
      customers: parties.map((p) => ({
        id: p.id,
        name: p.name,
        phone: p.phone ?? null,
        storeId: p.storeId ?? null,
      })),
      designs: products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        imageUrl: p.imageUrl ?? null,
      })),
      stock: stockItems.map((s) => ({
        id: s.id,
        sku: s.sku ?? null,
        name: s.name ?? null,
        category: s.category,
        status: s.status,
        grossGrams: num(s.grossWeight),
        netGrams: num(s.netWeight),
        tagPrice: num(s.tagPrice),
        storeId: s.storeId,
      })),
      bills: sales.map((s) => ({
        id: s.id,
        docNo: s.docNo,
        customerName: s.customerName ?? s.party?.name ?? null,
        totalAmount: num(s.totalAmount),
        docDate: iso(s.docDate),
        storeId: s.storeId,
      })),
      leads: leads.map((l) => ({
        id: l.id,
        ref: l.ref,
        customerName: l.customerName,
        phone: l.phone ?? null,
        stage: l.stage,
        storeId: l.storeId,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        ref: o.ref,
        customerName: o.customerName,
        item: o.item,
        stage: o.stage,
        storeId: o.storeId,
      })),
      quotes: quotes.map((qt) => ({
        id: qt.id,
        ref: qt.ref,
        customerName: qt.customerName,
        grandTotal: num(qt.grandTotal),
        status: qt.status,
        storeId: qt.storeId,
      })),
    };

    const totals: Record<GroupKey, number> = {
      customers: partyTotal,
      designs: productTotal,
      stock: stockTotal,
      bills: saleTotal,
      leads: leadTotal,
      orders: orderTotal,
      quotes: quoteTotal,
    };

    return {
      q,
      groups: GROUP_DEFS.map((g) => ({
        key: g.key,
        label: g.label,
        total: totals[g.key],
        items: items[g.key],
      })),
    };
  }
}
