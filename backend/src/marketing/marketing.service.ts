import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { CreateCampaignDto } from './dto/marketing.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

@Injectable()
export class MarketingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * Campaigns target stores via the CampaignStore join. A campaign is in scope if
   * it targets any store the user can see (head_office sees all).
   */
  private async campaignFilter(user: AuthUser, headerStore?: string): Promise<Prisma.MarketingCampaignWhereInput> {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    if (user.allStores && (!headerStore || headerStore === 'all')) return {};
    return { stores: { some: { storeId: { in: storeIds } } } };
  }

  /** Shape a MarketingCampaign row (with stores included) into the planner view. */
  private toView(c: any) {
    return {
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      start: c.startDate ? c.startDate.toISOString().slice(0, 10) : '',
      end: c.endDate ? c.endDate.toISOString().slice(0, 10) : '',
      budget: num(c.budget),
      spent: num(c.spend),
      owner: c.ownerName ?? '',
      agency: c.agency ?? '',
      stores: (c.stores ?? []).map((s: any) => s.store?.name ?? s.storeId),
      channels: [],
    };
  }

  /** GET /marketing/campaigns — campaign planner rows, store-scoped via targets. */
  async campaigns(user: AuthUser, headerStore?: string) {
    const rows = await this.prisma.marketingCampaign.findMany({
      where: await this.campaignFilter(user, headerStore),
      include: { stores: { include: { store: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((c) => this.toView(c));
  }

  /**
   * POST /marketing/campaigns — create a campaign. Money is Decimal-wrapped;
   * dates are coerced to Date. Campaign-store targets are optional in the model,
   * so with no store input we leave them empty (campaign is pan-India by default).
   */
  async create(user: AuthUser, dto: CreateCampaignDto) {
    const campaign = await this.prisma.marketingCampaign.create({
      data: {
        name: dto.name,
        type: dto.type,
        status: dto.status ?? 'planning',
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        budget: dto.budget != null ? new Prisma.Decimal(dto.budget) : null,
        ownerName: dto.ownerName ?? user.name,
        agency: dto.agency ?? null,
      },
      include: { stores: { include: { store: true } } },
    });
    return this.toView(campaign);
  }

  /** GET /marketing/assets — agency deliverables / shared assets for in-scope campaigns. */
  async assets(user: AuthUser, headerStore?: string) {
    const campaigns = await this.prisma.marketingCampaign.findMany({
      where: await this.campaignFilter(user, headerStore),
      select: { id: true, agency: true },
    });
    const ids = campaigns.map((c) => c.id);
    const agencyById = new Map(campaigns.map((c) => [c.id, c.agency ?? '']));
    if (ids.length === 0) return [];

    const assets = await this.prisma.marketingAsset.findMany({
      where: { campaignId: { in: ids } },
      orderBy: { dueDate: 'desc' },
    });
    return assets.map((a) => ({
      id: a.id,
      name: a.title,
      kind: kindOf(a.title),
      campaignId: a.campaignId,
      agency: agencyById.get(a.campaignId) ?? '',
      updatedAt: a.dueDate ? a.dueDate.toISOString().slice(0, 10) : '',
      approved: a.status === 'approved',
    }));
  }

  /** GET /marketing/agency-tasks — the same deliverables shaped as agency tasks. */
  async agencyTasks(user: AuthUser, headerStore?: string) {
    const campaigns = await this.prisma.marketingCampaign.findMany({
      where: await this.campaignFilter(user, headerStore),
      select: { id: true, agency: true, ownerName: true },
    });
    const ids = campaigns.map((c) => c.id);
    const metaById = new Map(campaigns.map((c) => [c.id, c]));
    if (ids.length === 0) return [];

    const assets = await this.prisma.marketingAsset.findMany({
      where: { campaignId: { in: ids } },
      orderBy: { dueDate: 'asc' },
    });
    const STATUS_MAP: Record<string, string> = {
      pending: 'awaiting_brief',
      in_progress: 'in_progress',
      submitted: 'submitted',
      approved: 'approved',
      changes_requested: 'changes_requested',
    };
    return assets.map((a) => {
      const meta = metaById.get(a.campaignId);
      return {
        id: a.id,
        title: a.title,
        agency: meta?.agency ?? '',
        campaignId: a.campaignId,
        assignee: meta?.ownerName ?? '',
        dueDate: a.dueDate ? a.dueDate.toISOString().slice(0, 10) : '',
        status: STATUS_MAP[a.status ?? 'pending'] ?? 'awaiting_brief',
        assetCount: 1,
      };
    });
  }
}

function kindOf(title: string): 'video' | 'image' | 'pdf' | 'copy' {
  const t = title.toLowerCase();
  if (t.endsWith('.mp4') || t.includes('film') || t.includes('video')) return 'video';
  if (t.endsWith('.pdf')) return 'pdf';
  if (t.endsWith('.docx') || t.includes('copy')) return 'copy';
  return 'image';
}
