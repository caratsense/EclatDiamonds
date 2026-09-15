import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { isSalesScoped } from '../common/sales-scope';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from './activity.service';

/** Longest tag anyone can read on a table row before it is truncated anyway. */
const NAME_MAX = 40;
/** Beyond this a tag list stops being a vocabulary and becomes a search box. */
export const TAGS_PER_TENANT_MAX = 60;

/**
 * Normalise a tag name for duplicate detection.
 *
 * Case and inner whitespace only. Punctuation is deliberately KEPT — "VIP" and
 * "V.I.P." are plausibly two different things to a jeweller, and collapsing them
 * would silently refuse the second with a message about the first.
 */
export function tagSlug(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export interface TagView {
  id: string;
  name: string;
  colour: string | null;
  isActive: boolean;
  sortOrder: number;
  leadCount?: number;
}

/**
 * Tenant-defined labels on a lead.
 *
 * Every read and write is filtered by `organisationId` from the caller's token,
 * never from the request body — the tag id in a URL is untrusted, so a tag that
 * belongs to another tenant must read as "not found", not as someone else's row.
 */
@Injectable()
export class LeadTagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly activity: ActivityService,
  ) {}

  /** The tenant's tag vocabulary. Inactive tags are included only on request. */
  async list(user: AuthUser, includeInactive = false): Promise<TagView[]> {
    const rows = await this.prisma.leadTag.findMany({
      where: {
        ...this.scope.orgFilter(user),
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        colour: true,
        isActive: true,
        sortOrder: true,
        _count: { select: { assignments: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      colour: r.colour,
      isActive: r.isActive,
      sortOrder: r.sortOrder,
      leadCount: r._count.assignments,
    }));
  }

  async create(
    user: AuthUser,
    input: { name: string; colour?: string | null; sortOrder?: number },
  ): Promise<TagView> {
    const name = input.name.trim();
    if (name.length < 2 || name.length > NAME_MAX) {
      throw new BadRequestException(`A tag name must be 2 to ${NAME_MAX} characters.`);
    }

    // Counted before inserting rather than enforced by a constraint: the limit is
    // a product judgement, not data integrity, and the message has to say why.
    const existing = await this.prisma.leadTag.count({ where: this.scope.orgFilter(user) });
    if (existing >= TAGS_PER_TENANT_MAX) {
      throw new BadRequestException(
        `This organisation already has ${TAGS_PER_TENANT_MAX} tags. Retire one before adding another.`,
      );
    }

    try {
      const row = await this.prisma.leadTag.create({
        data: {
          organisationId: user.organisationId,
          name,
          slug: tagSlug(name),
          colour: input.colour?.trim() || null,
          sortOrder: input.sortOrder ?? existing,
          createdById: user.id,
        },
        select: { id: true, name: true, colour: true, isActive: true, sortOrder: true },
      });
      return { ...row, leadCount: 0 };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`A tag called "${name}" already exists here.`);
      }
      throw e;
    }
  }

  async update(
    user: AuthUser,
    tagId: string,
    input: { name?: string; colour?: string | null; isActive?: boolean; sortOrder?: number },
  ): Promise<TagView> {
    await this.mustOwn(user, tagId);

    const data: Prisma.LeadTagUpdateInput = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (name.length < 2 || name.length > NAME_MAX) {
        throw new BadRequestException(`A tag name must be 2 to ${NAME_MAX} characters.`);
      }
      data.name = name;
      data.slug = tagSlug(name);
    }
    if (input.colour !== undefined) data.colour = input.colour?.trim() || null;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    try {
      const row = await this.prisma.leadTag.update({
        where: { id: tagId },
        data,
        select: {
          id: true,
          name: true,
          colour: true,
          isActive: true,
          sortOrder: true,
          _count: { select: { assignments: true } },
        },
      });
      return {
        id: row.id,
        name: row.name,
        colour: row.colour,
        isActive: row.isActive,
        sortOrder: row.sortOrder,
        leadCount: row._count.assignments,
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Another tag here already uses that name.');
      }
      throw e;
    }
  }

  /**
   * Retire a tag.
   *
   * Deactivates rather than deletes, and says how many leads still carry it. A
   * tag that has been used is part of the record of what somebody thought at the
   * time; deleting it rewrites that. `isActive: false` takes it out of the
   * pickers and leaves the history intact.
   */
  async retire(user: AuthUser, tagId: string): Promise<{ retired: true; stillOnLeads: number }> {
    await this.mustOwn(user, tagId);
    const [, count] = await this.prisma.$transaction([
      this.prisma.leadTag.update({ where: { id: tagId }, data: { isActive: false } }),
      this.prisma.leadTagAssignment.count({ where: { tagId } }),
    ]);
    return { retired: true, stillOnLeads: count };
  }

  /** Every tag currently on a lead. */
  async forLead(user: AuthUser, leadId: string): Promise<TagView[]> {
    await this.mustReachLead(user, leadId);
    const rows = await this.prisma.leadTagAssignment.findMany({
      where: { leadId, ...this.scope.orgFilter(user) },
      select: {
        tag: { select: { id: true, name: true, colour: true, isActive: true, sortOrder: true } },
      },
      orderBy: { tag: { sortOrder: 'asc' } },
    });
    return rows.map((r) => r.tag);
  }

  /**
   * Replace the tags on a lead with exactly this set.
   *
   * A set operation rather than add/remove calls: the CRM board sends what the
   * row should look like, and two people editing the same lead converge on a
   * state instead of racing to append.
   */
  async setForLead(user: AuthUser, leadId: string, tagIds: string[]): Promise<TagView[]> {
    const lead = await this.mustReachLead(user, leadId);
    const wanted = [...new Set(tagIds)];

    if (wanted.length) {
      // Every id must belong to THIS tenant. Counting is enough — a mismatch
      // means at least one id was not ours, and naming which one would confirm
      // the existence of another tenant's row.
      const owned = await this.prisma.leadTag.count({
        where: { id: { in: wanted }, ...this.scope.orgFilter(user) },
      });
      if (owned !== wanted.length) {
        throw new NotFoundException('One or more of those tags do not exist here.');
      }
    }

    const before = await this.prisma.leadTagAssignment.findMany({
      where: { leadId },
      select: { tagId: true },
    });
    const had = new Set(before.map((r) => r.tagId));
    const want = new Set(wanted);
    const added = wanted.filter((id) => !had.has(id));
    const removed = [...had].filter((id) => !want.has(id));

    if (!added.length && !removed.length) return this.forLead(user, leadId);

    await this.prisma.$transaction([
      ...(removed.length
        ? [this.prisma.leadTagAssignment.deleteMany({ where: { leadId, tagId: { in: removed } } })]
        : []),
      ...(added.length
        ? [
            this.prisma.leadTagAssignment.createMany({
              data: added.map((tagId) => ({
                organisationId: user.organisationId,
                leadId,
                tagId,
                assignedById: user.id,
              })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    // The timeline records what changed, by name, because "tags updated" tells a
    // manager reading it back in a month precisely nothing.
    const names = await this.prisma.leadTag.findMany({
      where: { id: { in: [...added, ...removed] } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const parts = [
      added.length ? `added ${added.map((id) => nameOf.get(id) ?? id).join(', ')}` : null,
      removed.length ? `removed ${removed.map((id) => nameOf.get(id) ?? id).join(', ')}` : null,
    ].filter(Boolean);

    await this.activity.recordFor(user, {
      type: 'lead.tags_changed',
      summary: `Tags ${parts.join('; ')}`,
      leadId,
      partyId: lead.partyId,
      storeId: lead.storeId,
      entityType: 'lead',
      entityId: leadId,
      metadata: { added, removed },
    });

    return this.forLead(user, leadId);
  }

  /** Fail as "not found" for another tenant's tag, never as "forbidden". */
  private async mustOwn(user: AuthUser, tagId: string): Promise<void> {
    const row = await this.prisma.leadTag.findFirst({
      where: { id: tagId, ...this.scope.orgFilter(user) },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Tag not found.');
  }

  /**
   * The lead must be inside the caller's organisation AND one of their stores —
   * a salesperson in Surat must not label a Mumbai lead.
   */
  private async mustReachLead(
    user: AuthUser,
    leadId: string,
  ): Promise<{ storeId: string; partyId: string | null }> {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user),
        ...(isSalesScoped(user) ? { ownerId: user.id } : {}),
      },
      select: { storeId: true, partyId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found.');
    return lead;
  }
}
