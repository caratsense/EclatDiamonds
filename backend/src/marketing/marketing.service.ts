import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import {
  CreateAgencyTaskDto,
  CreateAssetDto,
  CreateCampaignDto,
  UpdateAgencyTaskStatusDto,
  UpdateAssetStatusDto,
} from './dto/marketing.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

@Injectable()
export class MarketingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Campaigns target stores via the CampaignStore join. A campaign is in scope if
   * it targets any store the user can see (head_office sees all).
   */
  private async campaignFilter(user: AuthUser, headerStore?: string): Promise<Prisma.MarketingCampaignWhereInput> {
    const storeIds = this.scope.effectiveStoreIds(user, headerStore);
    // ALWAYS organisation-bounded: allStores/head_office means "every campaign in
    // THIS org", never DB-wide. Lower roles narrow further by targeted store.
    if (user.allStores && (!headerStore || headerStore === 'all')) {
      return { organisationId: user.organisationId };
    }
    return {
      organisationId: user.organisationId,
      stores: { some: { storeId: { in: storeIds } } },
    };
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
      channels: c.channels ?? [],
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
    // Only target stores inside the creator's scope.
    const storeIds = [...new Set(dto.storeIds ?? [])];
    for (const storeId of storeIds) {
      this.scope.assertStoreAllowed(user, storeId);
    }

    const campaign = await this.prisma.marketingCampaign.create({
      data: {
        organisationId: user.organisationId,
        name: dto.name,
        type: dto.type,
        status: dto.status ?? 'planning',
        startDate: dto.startDate ? new Date(dto.startDate) : null,
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        budget: dto.budget != null ? new Prisma.Decimal(dto.budget) : null,
        ownerName: dto.ownerName ?? user.name,
        agency: dto.agency ?? null,
        channels: dto.channels ?? [],
        stores: storeIds.length
          ? { create: storeIds.map((storeId) => ({ storeId })) }
          : undefined,
      },
      include: { stores: { include: { store: true } } },
    });
    return this.toView(campaign);
  }

  /** Resolve a campaign the user may touch (in scope). Throws if missing/out of scope. */
  private async assertCampaignInScope(user: AuthUser, campaignId: string) {
    const campaign = await this.prisma.marketingCampaign.findFirst({
      where: { id: campaignId, ...(await this.campaignFilter(user)) },
      select: { id: true, name: true },
    });
    if (!campaign) throw new NotFoundException('Campaign not found');
    return campaign;
  }

  /**
   * POST /marketing/assets — create an agency deliverable on a campaign.
   * MarketingAsset.campaignId is required by the model, so a campaign must be given.
   */
  async createAsset(user: AuthUser, dto: CreateAssetDto) {
    if (!dto.campaignId) throw new BadRequestException('campaignId is required');
    await this.assertCampaignInScope(user, dto.campaignId);

    const asset = await this.prisma.marketingAsset.create({
      data: {
        campaignId: dto.campaignId,
        title: dto.title,
        url: dto.url ?? null,
        status: 'pending',
      },
    });
    return {
      id: asset.id,
      name: asset.title,
      campaignId: asset.campaignId,
      type: dto.type,
      url: asset.url ?? '',
      status: asset.status,
    };
  }

  /** PATCH /marketing/assets/:id — approve/reject a deliverable (area_manager+). */
  async updateAssetStatus(user: AuthUser, id: string, dto: UpdateAssetStatusDto) {
    const asset = await this.prisma.marketingAsset.findUnique({ where: { id } });
    if (!asset) throw new NotFoundException('Asset not found');
    await this.assertCampaignInScope(user, asset.campaignId);

    const updated = await this.prisma.marketingAsset.update({
      where: { id },
      data: { status: dto.status },
    });
    await this.audit.record(user, {
      action: 'marketing.asset_status',
      entityType: 'MarketingAsset',
      entityId: id,
      summary: `Deliverable "${asset.title}" ${asset.status ?? 'pending'} → ${dto.status}`,
      metadata: { from: asset.status, to: dto.status, campaignId: asset.campaignId },
    });
    return {
      id: updated.id,
      name: updated.title,
      campaignId: updated.campaignId,
      status: updated.status,
      approved: updated.status === 'approved',
    };
  }

  /**
   * POST /marketing/agency-tasks — create a campaign task. Backed by MarketingAsset
   * (there is no separate agency-task model). `assignee` is derived from the campaign
   * owner in the read view, so it is not persisted here.
   */
  async createAgencyTask(user: AuthUser, dto: CreateAgencyTaskDto) {
    if (!dto.campaignId) throw new BadRequestException('campaignId is required');
    await this.assertCampaignInScope(user, dto.campaignId);

    const task = await this.prisma.marketingAsset.create({
      data: {
        campaignId: dto.campaignId,
        title: dto.title,
        status: 'pending',
        dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
      },
    });
    return {
      id: task.id,
      title: task.title,
      campaignId: task.campaignId,
      assignee: dto.assignee ?? '',
      dueDate: task.dueDate ? task.dueDate.toISOString().slice(0, 10) : '',
      status: task.status,
    };
  }

  /** PATCH /marketing/agency-tasks/:id — progress a task (store_manager+). */
  async updateAgencyTaskStatus(user: AuthUser, id: string, dto: UpdateAgencyTaskStatusDto) {
    const task = await this.prisma.marketingAsset.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('Agency task not found');
    await this.assertCampaignInScope(user, task.campaignId);

    const updated = await this.prisma.marketingAsset.update({
      where: { id },
      data: { status: dto.status },
    });
    await this.audit.record(user, {
      action: 'marketing.task_status',
      entityType: 'MarketingAsset',
      entityId: id,
      summary: `Agency task "${task.title}" ${task.status ?? 'pending'} → ${dto.status}`,
      metadata: { from: task.status, to: dto.status, campaignId: task.campaignId },
    });
    return {
      id: updated.id,
      title: updated.title,
      campaignId: updated.campaignId,
      status: updated.status,
    };
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
