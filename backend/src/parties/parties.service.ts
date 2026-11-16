import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, PartyType, SpecialRequestKind } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SpecialRequestsService } from '../special-requests/special-requests.service';
import { ROLE_LABELS } from '../common/role.util';
import { describeHistory, partyHistory, removalOutcome } from './party-history';
import { AuditService } from '../common/audit.service';
import { StoreScopeService } from '../common/store-scope.service';
import { AuthUser } from '../common/auth-user';
import { isSalesScoped, partyWorkedBy } from '../common/sales-scope';
import { PageRequest, Paginated } from '../common/pagination';
import { isValidEmail, normalizeCustomerPhone, normalizeIndianMobile } from '../common/contact.util';
import { CreatePartyDto } from './dto/party.dto';

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
  /** true = the Archived Contacts screen. Omitted = active contacts only. */
  archived?: boolean;
  /** Show only customers wearing this tag. */
  tagId?: string;
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
  /** The customer's tags (client, 10 Oct): chips on the directory row. */
  tags: { id: string; name: string; colour: string | null }[];
  createdAt: string | null;
  /** Present only on the archived list, so the screen can show who and why. */
  archivedAt: string | null;
  archivedByName: string | null;
  archiveReason: string | null;
}

/** One place to define the row shape, shared by list + create. */
const PARTY_SELECT = {
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
  archivedAt: true,
  archiveReason: true,
  archivedBy: { select: { name: true } },
  _count: { select: { sales: true } },
  partyTagAssignments: {
    select: { tag: { select: { id: true, name: true, colour: true, sortOrder: true } } },
  },
} satisfies Prisma.PartySelect;

type PartySelected = Prisma.PartyGetPayload<{ select: typeof PARTY_SELECT }>;

function toPartyRow(p: PartySelected): PartyRow {
  return {
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
    tags: [...p.partyTagAssignments]
      .sort((a, b) => a.tag.sortOrder - b.tag.sortOrder)
      .map((a) => ({ id: a.tag.id, name: a.tag.name, colour: a.tag.colour })),
    createdAt: iso(p.createdAt),
    archivedAt: iso(p.archivedAt),
    archivedByName: p.archivedBy?.name ?? null,
    archiveReason: p.archiveReason ?? null,
  };
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
    private readonly audit: AuditService,
    private readonly requests: SpecialRequestsService,
  ) {}

  /**
   * DELETE /parties/:id (client, 9 Oct): only for the row that should never
   * have existed. A customer with ANY history is refused by name and count —
   * their sales and ledger are the shop's own numbers, and the foreign keys
   * would not stop it: most only unlink the row, leaving those numbers
   * attached to nobody, and their notes would go with it. Archive is the door
   * for everyone else: reversible, audited, and the totals stay true.
   */
  /**
   * Ask for a customer to be removed.
   *
   * Nobody below head office may do it outright (client, 16 Nov): a
   * salesperson's ask goes to their manager, a manager's to head office. The
   * routing is not decided here — `resolveRequiredRole` already applies the
   * one-rank-above rule to every kind of request, so this lands in the same
   * approvals queue the branch already works, rather than a second inbox that
   * only ever holds deletions.
   *
   * The consequence is worked out NOW and written into the request, so the
   * approver is agreeing to a named outcome rather than to the word "delete".
   */
  async requestDeletion(user: AuthUser, id: string, reason: string) {
    const trimmed = (reason ?? '').trim();
    if (trimmed.length < 3) {
      throw new BadRequestException('Say why this customer should be removed.');
    }

    const party = await this.prisma.party.findFirst({
      where: { id, organisationId: user.organisationId },
      select: { id: true, name: true, storeId: true, legacyId: true, archivedAt: true },
    });
    if (!party) throw new NotFoundException('Customer not found');
    if (party.archivedAt) {
      throw new BadRequestException(`${party.name} is already archived.`);
    }

    const pending = await this.prisma.specialRequest.findFirst({
      where: {
        organisationId: user.organisationId,
        partyId: id,
        kind: 'customer_deletion',
        status: { in: ['pending', 'escalated'] },
      },
      select: { id: true, ref: true, requiredRole: true },
    });
    if (pending) {
      throw new BadRequestException(
        `${party.name} is already waiting on ${ROLE_LABELS[pending.requiredRole] ?? pending.requiredRole} (${pending.ref}).`,
      );
    }

    const held = await partyHistory(this.prisma, id);
    /*
     * A Gati-synced customer comes straight back on the next sync, so deleting
     * is not an outcome we can honestly offer. Archiving is, and it is what the
     * approver will get — said here rather than discovered at approval time.
     */
    const outcome = party.legacyId ? 'archive' : removalOutcome(held);
    const because = party.legacyId
      ? 'synced from Gati, so a delete would come straight back'
      : held.length
        ? `${describeHistory(held)} on record`
        : 'nothing on record';

    const storeId = party.storeId ?? user.storeIds?.[0];
    if (!storeId) {
      throw new BadRequestException('This customer is not attached to a branch, so nobody owns the approval.');
    }

    const request = await this.requests.create(user, {
      kind: SpecialRequestKind.customer_deletion,
      storeId,
      title: `Remove ${party.name}`,
      details:
        `${trimmed}\n\n` +
        `If approved: ${outcome === 'delete' ? 'the customer record is deleted' : 'the customer is archived'} — ${because}.`,
      partyId: id,
    });

    return { request, outcome, held: describeHistory(held) || null };
  }

  async remove(user: AuthUser, id: string) {
    const party = await this.prisma.party.findFirst({
      where: { id, organisationId: user.organisationId },
      select: { id: true, name: true, types: true, legacyId: true },
    });
    if (!party) throw new NotFoundException('Customer not found');
    if (party.legacyId) {
      throw new BadRequestException(
        'This customer is synced from Gati and would come straight back. Archive them instead.',
      );
    }

    const held = await partyHistory(this.prisma, id);
    if (held.length) {
      throw new BadRequestException(
        `${party.name} has ${describeHistory(held)} on record. Archive them instead — it hides them from lists and keeps every number true.`,
      );
    }

    // Contact points, activity, interactions, attribution and tags cascade.
    await this.prisma.party.delete({ where: { id: party.id } });
    await this.audit.record(user, {
      action: 'crm.contact_deleted',
      entityType: 'Party',
      entityId: id,
      summary: `${party.name} deleted — no history`,
      metadata: { name: party.name, types: party.types },
    });
    return { deleted: true };
  }

  /** The customer directory as a workbook — same scope as the list. */
  async exportXlsx(user: AuthUser, headerStore?: string): Promise<{ buffer: Buffer; rows: number }> {
    const rows = await this.prisma.party.findMany({
      where: {
        ...this.scope.storeFilter(user, headerStore),
        ...(isSalesScoped(user) ? { AND: [partyWorkedBy(user.id)] } : {}),
        archivedAt: null,
      },
      orderBy: { name: 'asc' },
      take: 10000,
      select: {
        name: true, phone: true, email: true, city: true,
        birthday: true, anniversary: true, createdAt: true,
      },
    });
    const { Workbook } = await import('exceljs');
    const wb = new Workbook();
    const ws = wb.addWorksheet('Customers');
    ws.columns = [
      { header: 'Name', key: 'name', width: 26 },
      { header: 'Phone', key: 'phone', width: 14 },
      { header: 'Email', key: 'email', width: 26 },
      { header: 'City', key: 'city', width: 16 },
      { header: 'Birthday', key: 'birthday', width: 12 },
      { header: 'Anniversary', key: 'anniversary', width: 12 },
      { header: 'Added', key: 'createdAt', width: 12 },
    ];
    ws.getRow(1).font = { bold: true };
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');
    for (const r of rows) {
      ws.addRow({
        name: r.name, phone: r.phone ?? '', email: r.email ?? '', city: r.city ?? '',
        birthday: day(r.birthday), anniversary: day(r.anniversary), createdAt: day(r.createdAt),
      });
    }
    const buffer = Buffer.from(await wb.xlsx.writeBuffer());
    return { buffer, rows: rows.length };
  }

  async list(
    user: AuthUser,
    f: PartyFilters,
    headerStore: string | undefined,
    pagination: PageRequest,
  ): Promise<Paginated<PartyRow>> {
    const where: Prisma.PartyWhereInput = {
      ...this.scope.storeFilter(user, headerStore),
      // A salesperson's directory is their own customers — never the branch's
      // phone list.
      ...(isSalesScoped(user) ? { AND: [partyWorkedBy(user.id)] } : {}),
      /*
       * Archived contacts are not in the directory.
       *
       * Set `archived: true` to see only them — that is the Archived Contacts
       * screen, and it is the only way to reach one. There is deliberately no
       * "show both" mode: a list that mixes active and archived people is a list
       * somebody will campaign from by mistake.
       */
      archivedAt: f.archived ? { not: null } : null,
    };

    // Role filter (customer / supplier / …). Unknown values are ignored rather
    // than 500-ing on an invalid enum; 'all' skips the filter entirely.
    if (f.type && f.type !== 'all' && VALID_TYPES.has(f.type)) {
      where.types = { has: f.type as PartyType };
    }
    // Filter by one tag: the chips on the rows are also the way to slice them.
    if (f.tagId) {
      where.partyTagAssignments = { some: { tagId: f.tagId } };
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
        select: PARTY_SELECT,
      }),
    ]);

    return {
      items: rows.map(toPartyRow),
      total,
      page,
      pageSize,
    };
  }

  /**
   * POST /parties — add a customer (type=customer) against a store the caller
   * may write to. Any authenticated role can add (reps create customers), but
   * store scope is enforced via assertStoreAllowed.
   *
   * ## The same person, walked into two shops
   *
   * This path used to create a row with no duplicate check of any kind. A
   * customer who bought at Bandra and then walked into Andheri became two
   * customers the moment the second manager typed their number in: two
   * histories, two intent scores, two entries in an export, and two of them in
   * any campaign counting "customers who have not visited in 90 days".
   *
   * Nothing caught it. `ContactPoint` holds the real tenant-wide uniqueness,
   * but only the identity path (inbound webhooks, `/crm/identity`) ever wrote
   * one; `Party.phone` carries a plain index and no constraint, so the database
   * was perfectly happy. The failure was silent and compounding: nobody notices
   * the duplicate on the day, and by the time anyone does the two records have
   * both grown real history and can no longer simply be deleted.
   *
   * So the number is checked across the WHOLE tenant before anything is
   * written, and a match is refused with the branch named. Refusing rather than
   * silently returning the existing customer is the deliberate part: the person
   * typing believes they are creating somebody, and a success response that
   * quietly did something else is how a manager ends up thinking a customer is
   * theirs when the record still belongs to another shop.
   */
  async create(user: AuthUser, dto: CreatePartyDto): Promise<PartyRow> {
    this.scope.assertStoreAllowed(user, dto.storeId);
    await this.scope.assertTradingStore(dto.storeId);

    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Name is required');

    // @IsCustomerPhone already validated shape. Indian numbers keep the
    // canonical 10-digit form every record written so far uses; a foreign
    // number (client, 13 Oct) falls through to the gentler customer
    // normalisation, which keeps the digits and a leading `+`.
    const phone = normalizeIndianMobile(dto.phone) ?? normalizeCustomerPhone(dto.phone);
    if (!phone) {
      throw new BadRequestException(
        'A valid phone number is required — a 10-digit Indian mobile, or an international number like +971551234567',
      );
    }

    const email = dto.email?.trim() || undefined;
    if (email && !isValidEmail(email)) {
      throw new BadRequestException('Enter a valid email address');
    }
    const city = dto.city?.trim() || undefined;

    await this.refuseDuplicate(user, phone, dto.storeId);

    const party = await this.prisma.party.create({
      data: { organisationId: user.organisationId, storeId: dto.storeId, name, phone, email, city, types: ['customer'] },
      select: PARTY_SELECT,
    });
    return toPartyRow(party);
  }

  /**
   * Refuse a number this tenant already holds, and say where it is.
   *
   * Searched tenant-wide, NOT within the caller's store scope. Scoping the
   * lookup would defeat the whole point: the duplicate that matters is the one
   * at a branch this person cannot see, and a check that cannot see it would
   * report "no duplicate" and create the second record.
   *
   * The message names the branch because the next action depends on it. "This
   * customer already exists" leaves a manager with nothing to do; "already a
   * customer at Mumbai - Bandra" tells them who to ask.
   *
   * Archived contacts count. Somebody who asked us to stop is still that
   * person, and letting a fresh record be typed over the top of their opt-out
   * is how a blocked contact starts receiving messages again.
   */
  private async refuseDuplicate(
    user: AuthUser,
    phone: string,
    storeId: string,
  ): Promise<void> {
    // An international number has two possible stored spellings — with and
    // without the leading `+` (normalizeCustomerPhone keeps whichever the
    // creator typed). The guard must see both, or "+971…" and "971…" become
    // exactly the silent duplicate this method exists to refuse.
    const digits = phone.replace(/\D/g, '');
    const spellings = Array.from(new Set([phone, digits, `+${digits}`]));
    const existing = await this.prisma.party.findFirst({
      where: {
        organisationId: user.organisationId,
        OR: [{ phone: { in: spellings } }, { whatsapp: { in: spellings } }],
        types: { has: 'customer' },
      },
      select: {
        id: true,
        name: true,
        storeId: true,
        archivedAt: true,
        store: { select: { name: true } },
      },
      // Oldest wins: the record with the history is the one to keep, and it is
      // the one a reassignment should move.
      orderBy: { createdAt: 'asc' },
    });
    if (!existing) return;

    const where = existing.store?.name
      ? `at *${existing.store.name}*`
      : 'in this business';

    if (existing.storeId === storeId) {
      throw new ConflictException(
        `${existing.name} is already a customer ${where} on this number. Open their record instead of adding them again.`,
      );
    }

    throw new ConflictException(
      existing.archivedAt
        ? `That number belongs to ${existing.name}, an archived contact ${where}. Ask head office to restore and reassign them rather than creating a new record.`
        : `${existing.name} is already a customer ${where} on this number. Ask head office to reassign them to your branch, or share them, rather than creating a second record.`,
    );
  }
}
