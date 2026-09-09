import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { NewStoreDept, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import {
  AddChecklistItemDto,
  AddMilestoneDto,
  AddVendorDto,
  CreateProjectDto,
  UpdateChecklistItemDto,
  UpdateMilestoneDto,
  UpdateVendorDto,
} from './dto/new-store.dto';

const DEPARTMENTS = ['it', 'inventory', 'interiors', 'hr', 'marketing'] as const;

/**
 * Readiness = share of checklist tasks that are fully done (Module 11).
 * Strict done/total — an in-progress task does not count as partially ready.
 */
function readinessPct(tasks: { status: string }[]): number {
  if (tasks.length === 0) return 0;
  const done = tasks.filter((t) => t.status === 'done').length;
  return Math.round((done / tasks.length) * 100);
}

/**
 * Standard store-opening checklist seeded on every new launch so a fresh project
 * is actionable instead of empty. Spans the five setup departments.
 */
const DEFAULT_CHECKLIST: { department: NewStoreDept; title: string }[] = [
  { department: 'interiors', title: 'Finalise site lease & legal handover' },
  { department: 'interiors', title: 'Complete interior fit-out & fixtures' },
  { department: 'inventory', title: 'Transfer opening inventory & tagging' },
  { department: 'inventory', title: 'Set up display & merchandising plan' },
  { department: 'hr', title: 'Recruit & onboard store staff' },
  { department: 'hr', title: 'Staff training & induction' },
  { department: 'marketing', title: 'Plan & launch opening campaign' },
  { department: 'it', title: 'Install POS terminals & network' },
  { department: 'it', title: 'Configure billing & inventory software' },
];

const PROJECT_INCLUDE = {
  checklists: true,
  milestones: { orderBy: { date: 'asc' as const } },
  vendors: true,
} satisfies Prisma.NewStoreProjectInclude;

@Injectable()
export class NewStoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * GET /new-store/projects — store-launch projects with checklists (grouped by
   * department), milestones, and vendors. The store doesn't exist yet, so these
   * are scoped by REGION (OP-4): head office sees all launches; an area manager
   * sees only launches in their assigned region(s).
   */
  async projects(user: AuthUser) {
    // Always organisation-bounded: HO (allStores) sees every launch IN THIS ORG,
    // never DB-wide. Lower roles narrow further by their region(s).
    let where: Prisma.NewStoreProjectWhereInput = { organisationId: user.organisationId };
    if (!user.allStores) {
      const regionIds = await this.userRegionIds(user);
      where = { organisationId: user.organisationId, regionId: { in: regionIds } };
    }

    const projects = await this.prisma.newStoreProject.findMany({
      where,
      include: PROJECT_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    return projects.map((p) => this.toView(p));
  }

  /** Shape a NewStoreProject (with checklists/milestones/vendors loaded) into the view. */
  private toView(p: any) {
    const checklists = DEPARTMENTS.map((key) => ({
      key,
      tasks: p.checklists
        .filter((c: any) => c.department === key)
        .map((c: any) => ({ id: c.id, label: c.title, status: c.status })),
    })).filter((c) => c.tasks.length > 0);

    const allTasks = p.checklists.map((c: any) => ({ status: c.status }));

    // Budget = total contracted vendor cost; spent = vendors already settled.
    const PAID_VENDOR_STATUS = new Set(['paid', 'complete', 'completed', 'settled']);
    const budget = p.vendors.reduce(
      (s: number, v: any) => s + (v.amount != null ? Number(v.amount) : 0),
      0,
    );
    const spent = p.vendors.reduce(
      (s: number, v: any) =>
        s + (v.amount != null && PAID_VENDOR_STATUS.has(v.status) ? Number(v.amount) : 0),
      0,
    );

    return {
      id: p.id,
      name: p.name,
      city: p.city,
      launchDate: p.launchDate ? p.launchDate.toISOString().slice(0, 10) : '',
      // Real readiness from checklist completion (was hardcoded 0 / partial credit).
      overallProgress: readinessPct(allTasks),
      // Real budget/spent from per-vendor amounts.
      budget,
      spent,
      leadName: p.leadName ?? '',
      checklists,
      milestones: p.milestones.map((m: any) => ({
        marker: m.marker,
        date: m.date.toISOString().slice(0, 10),
        title: m.title,
        summary: m.summary ?? '',
        state: m.state,
      })),
      vendors: p.vendors.map((v: any) => ({
        id: v.id,
        task: v.task ?? v.name,
        vendor: v.name,
        amount: v.amount != null ? Number(v.amount) : null,
        dueDate: v.dueDate ? v.dueDate.toISOString().slice(0, 10) : '',
        status: v.status ?? 'pending',
      })),
    };
  }

  /**
   * POST /new-store/projects — kick off a store-launch project. Region defaults to
   * the area manager's own region so OP-4 region scoping holds on subsequent reads.
   * Seeds the standard opening checklist so the project is usable immediately.
   */
  async createProject(user: AuthUser, dto: CreateProjectDto) {
    let regionId = dto.regionId ?? null;
    if (!regionId && !user.allStores) {
      const store = await this.prisma.store.findFirst({
        where: { id: { in: user.storeIds } },
        select: { regionId: true },
      });
      regionId = store?.regionId ?? null;
    }

    const project = await this.prisma.newStoreProject.create({
      data: {
        organisationId: user.organisationId,
        name: dto.name,
        city: dto.city,
        launchDate: dto.launchDate ? new Date(dto.launchDate) : null,
        leadName: dto.leadName ?? null,
        regionId,
        checklists: { create: DEFAULT_CHECKLIST },
      },
      include: PROJECT_INCLUDE,
    });

    await this.audit.record(user, {
      action: 'new_store.project_create',
      entityType: 'NewStoreProject',
      entityId: project.id,
      storeId: project.storeId ?? null,
      summary: `Created store-launch project ${project.name} (${project.city})`,
      metadata: { regionId, checklistSeeded: DEFAULT_CHECKLIST.length },
    });

    return this.toView(project);
  }

  // ---- Checklist -----------------------------------------------------------

  async addChecklistItem(user: AuthUser, projectId: string, dto: AddChecklistItemDto) {
    const project = await this.requireProjectInScope(user, projectId);
    const item = await this.prisma.newStoreChecklistItem.create({
      data: {
        projectId,
        department: dto.dept ?? 'inventory',
        title: dto.title,
        status: dto.status ?? 'todo',
      },
    });
    await this.audit.record(user, {
      action: 'new_store.checklist_add',
      entityType: 'NewStoreChecklistItem',
      entityId: item.id,
      storeId: project.storeId ?? null,
      summary: `Added checklist task "${dto.title}" to ${project.name}`,
      metadata: { projectId, department: item.department, status: item.status },
    });
    return this.projectView(projectId);
  }

  async updateChecklistItem(user: AuthUser, id: string, dto: UpdateChecklistItemDto) {
    const existing = await this.prisma.newStoreChecklistItem.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!existing) throw new NotFoundException('Checklist item not found');
    await this.assertProjectInScope(user, existing.project);

    const item = await this.prisma.newStoreChecklistItem.update({
      where: { id },
      data: {
        ...(dto.status != null ? { status: dto.status } : {}),
        ...(dto.title != null ? { title: dto.title } : {}),
      },
    });
    await this.audit.record(user, {
      action: 'new_store.checklist_update',
      entityType: 'NewStoreChecklistItem',
      entityId: id,
      storeId: existing.project.storeId ?? null,
      summary: `Updated checklist task "${item.title}" on ${existing.project.name}`,
      metadata: { from: existing.status, to: item.status },
    });
    return this.projectView(existing.projectId);
  }

  // ---- Milestones ----------------------------------------------------------

  async addMilestone(user: AuthUser, projectId: string, dto: AddMilestoneDto) {
    const project = await this.requireProjectInScope(user, projectId);
    const milestone = await this.prisma.newStoreMilestone.create({
      data: {
        projectId,
        marker: dto.phase ?? 'Milestone',
        title: dto.title,
        summary: dto.summary ?? null,
        date: new Date(dto.dueDate),
        state: 'upcoming',
      },
    });
    await this.audit.record(user, {
      action: 'new_store.milestone_add',
      entityType: 'NewStoreMilestone',
      entityId: milestone.id,
      storeId: project.storeId ?? null,
      summary: `Added milestone "${dto.title}" to ${project.name}`,
      metadata: { projectId, marker: milestone.marker, date: dto.dueDate },
    });
    return this.projectView(projectId);
  }

  async updateMilestone(user: AuthUser, id: string, dto: UpdateMilestoneDto) {
    const existing = await this.prisma.newStoreMilestone.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!existing) throw new NotFoundException('Milestone not found');
    await this.assertProjectInScope(user, existing.project);

    const milestone = await this.prisma.newStoreMilestone.update({
      where: { id },
      data: {
        ...(dto.status != null ? { state: dto.status } : {}),
        ...(dto.dueDate != null ? { date: new Date(dto.dueDate) } : {}),
      },
    });
    await this.audit.record(user, {
      action: 'new_store.milestone_update',
      entityType: 'NewStoreMilestone',
      entityId: id,
      storeId: existing.project.storeId ?? null,
      summary: `Updated milestone "${milestone.title}" on ${existing.project.name}`,
      metadata: { from: existing.state, to: milestone.state },
    });
    return this.projectView(existing.projectId);
  }

  // ---- Vendors -------------------------------------------------------------
  // NOTE: NewStoreVendor has no `amount` column, so vendor cost / project budget
  // cannot be captured here without a schema change (see TASK 3 report).

  async addVendor(user: AuthUser, projectId: string, dto: AddVendorDto) {
    const project = await this.requireProjectInScope(user, projectId);
    const vendor = await this.prisma.newStoreVendor.create({
      data: {
        projectId,
        name: dto.name,
        task: dto.scope,
        status: dto.status ?? 'pending',
        ...(dto.amount != null ? { amount: dto.amount } : {}),
      },
    });
    await this.audit.record(user, {
      action: 'new_store.vendor_add',
      entityType: 'NewStoreVendor',
      entityId: vendor.id,
      storeId: project.storeId ?? null,
      summary: `Added vendor ${dto.name} (${dto.scope}) to ${project.name}`,
      metadata: { projectId, status: vendor.status },
    });
    return this.projectView(projectId);
  }

  async updateVendor(user: AuthUser, id: string, dto: UpdateVendorDto) {
    const existing = await this.prisma.newStoreVendor.findUnique({
      where: { id },
      include: { project: true },
    });
    if (!existing) throw new NotFoundException('Vendor not found');
    await this.assertProjectInScope(user, existing.project);

    const vendor = await this.prisma.newStoreVendor.update({
      where: { id },
      data: {
        ...(dto.status != null ? { status: dto.status } : {}),
        ...(dto.amount != null ? { amount: dto.amount } : {}),
      },
    });
    await this.audit.record(user, {
      action: 'new_store.vendor_update',
      entityType: 'NewStoreVendor',
      entityId: id,
      storeId: existing.project.storeId ?? null,
      summary: `Updated vendor ${vendor.name} on ${existing.project.name}`,
      metadata: { from: existing.status, to: vendor.status },
    });
    return this.projectView(existing.projectId);
  }

  // ---- Helpers -------------------------------------------------------------

  /** Region ids the user (area manager) is assigned to, via their store set. */
  private async userRegionIds(user: AuthUser): Promise<string[]> {
    const stores = await this.prisma.store.findMany({
      where: { id: { in: user.storeIds } },
      select: { regionId: true },
    });
    return [...new Set(stores.map((s) => s.regionId).filter((r): r is string => !!r))];
  }

  /** Enforce OP-4 region scoping on a project the user is trying to mutate. */
  private async assertProjectInScope(
    user: AuthUser,
    project: { regionId: string | null; organisationId: string },
  ) {
    // Organisation is the hard boundary — a project from another org is never in
    // scope, not even for head_office. HO/allStores of THIS org sees every launch.
    if (project.organisationId !== user.organisationId) {
      throw new ForbiddenException('Project not in your organisation');
    }
    if (user.allStores || user.role === 'head_office') return;
    // Non-HO managers (store managers now hold the former area-manager authority)
    // are scoped to their own region's launches.
    const regionIds = await this.userRegionIds(user);
    if (project.regionId && regionIds.includes(project.regionId)) return;
    throw new ForbiddenException('Project not in your region');
  }

  private async requireProjectInScope(user: AuthUser, projectId: string) {
    const project = await this.prisma.newStoreProject.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException('Project not found');
    await this.assertProjectInScope(user, project);
    return project;
  }

  private async projectView(projectId: string) {
    const p = await this.prisma.newStoreProject.findUnique({
      where: { id: projectId },
      include: PROJECT_INCLUDE,
    });
    return this.toView(p);
  }
}
