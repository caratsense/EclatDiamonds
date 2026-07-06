import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { CreateProjectDto } from './dto/new-store.dto';

function num(v: Prisma.Decimal | number | null | undefined): number {
  return v == null ? 0 : Number(v);
}

const DEPARTMENTS = ['it', 'inventory', 'interiors', 'hr', 'marketing'] as const;

function checklistProgress(tasks: { status: string }[]): number {
  if (tasks.length === 0) return 0;
  const score = tasks.reduce((acc, t) => {
    if (t.status === 'done') return acc + 1;
    if (t.status === 'in_progress') return acc + 0.5;
    return acc;
  }, 0);
  return Math.round((score / tasks.length) * 100);
}

@Injectable()
export class NewStoreService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * GET /new-store/projects — store-launch projects with checklists (grouped by
   * department), milestones, and vendors. The store doesn't exist yet, so these
   * are scoped by REGION (OP-4): head office sees all launches; an area manager
   * sees only launches in their assigned region(s).
   */
  async projects(user: AuthUser) {
    let where: Prisma.NewStoreProjectWhereInput = {};
    if (user.role === 'area_manager' && !user.allStores) {
      const stores = await this.prisma.store.findMany({
        where: { id: { in: user.storeIds } },
        select: { regionId: true },
      });
      const regionIds = [...new Set(stores.map((s) => s.regionId).filter((r): r is string => !!r))];
      where = { regionId: { in: regionIds } };
    }

    const projects = await this.prisma.newStoreProject.findMany({
      where,
      include: {
        checklists: true,
        milestones: { orderBy: { date: 'asc' } },
        vendors: true,
      },
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

    return {
      id: p.id,
      name: p.name,
      city: p.city,
      launchDate: p.launchDate ? p.launchDate.toISOString().slice(0, 10) : '',
      overallProgress: checklistProgress(allTasks),
      budget: p.vendors.reduce((s: number, _v: any) => s, 0) || 0,
      spent: 0,
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
        dueDate: v.dueDate ? v.dueDate.toISOString().slice(0, 10) : '',
        status: v.status ?? 'pending',
      })),
    };
  }

  /**
   * POST /new-store/projects — kick off a store-launch project. Region defaults to
   * the area manager's own region so OP-4 region scoping holds on subsequent reads.
   */
  async createProject(user: AuthUser, dto: CreateProjectDto) {
    let regionId = dto.regionId ?? null;
    if (!regionId && user.role === 'area_manager' && !user.allStores) {
      const store = await this.prisma.store.findFirst({
        where: { id: { in: user.storeIds } },
        select: { regionId: true },
      });
      regionId = store?.regionId ?? null;
    }

    const project = await this.prisma.newStoreProject.create({
      data: {
        name: dto.name,
        city: dto.city,
        launchDate: dto.launchDate ? new Date(dto.launchDate) : null,
        leadName: dto.leadName ?? null,
        regionId,
      },
      include: {
        checklists: true,
        milestones: { orderBy: { date: 'asc' } },
        vendors: true,
      },
    });
    return this.toView(project);
  }
}
