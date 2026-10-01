import { createHash } from 'crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { ImportMaterialsDto } from './dto/materials.dto';
import { GATI_ITEM_MASTER_TABLES, buildGatiItemMaster } from './gati-item-master';

/**
 * The item master a quote is priced from: item types, metals, diamonds,
 * colour stones and stone sizes by the ERP's codes, and each design's default
 * bill of materials. Read by everyone who quotes; loaded by head office.
 */
@Injectable()
export class MaterialsService {
  private readonly logger = new Logger(MaterialsService.name);
  /** What was last written for each organisation, so an unchanged master is not rewritten. */
  private readonly lastGatiMaster = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  /** Everything the quote builder's dropdowns need, in one read. */
  async master(user: AuthUser) {
    const organisationId = user.organisationId;
    const [materials, sizes] = await Promise.all([
      this.prisma.material.findMany({
        where: { organisationId, isActive: true },
        orderBy: [{ kind: 'asc' }, { code: 'asc' }],
        select: {
          code: true, name: true, kind: true, groupCode: true, groupName: true, karat: true,
          tone: true, shape: true, quality: true, saleRates: true,
        },
      }),
      this.prisma.materialSize.findMany({
        where: { organisationId },
        orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
        select: { code: true, mm: true, caratPerPiece: true, sizeGroup: true },
      }),
    ]);
    const of = (kind: string) => materials.filter((m) => m.kind === kind);
    return {
      itemTypes: of('item_type').map(({ code, name }) => ({ code, name })),
      metals: of('metal'),
      diamonds: of('diamond'),
      stones: of('stone'),
      sizes: sizes.map((s) => ({ ...s, caratPerPiece: s.caratPerPiece == null ? null : Number(s.caratPerPiece) })),
    };
  }

  /**
   * A design's default materials, by its style number. A partial number that
   * matches exactly one design loads that design: typing "778" and pressing
   * Enter should do what picking `10778RG` from the list does.
   */
  async style(user: AuthUser, styleCode: string) {
    const term = styleCode.trim();
    const organisationId = user.organisationId;
    const select = { styleCode: true, itemType: true, itemSize: true, lines: true };
    const exact = await this.prisma.styleBom.findFirst({
      where: { organisationId, styleCode: { equals: term, mode: 'insensitive' } },
      select,
    });
    if (exact) return exact;
    const near = await this.prisma.styleBom.findMany({
      where: { organisationId, styleCode: { contains: term, mode: 'insensitive' } },
      take: 2,
      select,
    });
    if (near.length === 1) return near[0];
    if (near.length > 1) {
      throw new NotFoundException(`More than one style matches "${term}" — pick one from the list`);
    }
    throw new NotFoundException(`No style ${term} in the item master`);
  }

  /**
   * Style numbers for the search box. A style code is matched anywhere in the
   * string, not only at its start: the ERP's codes are mostly numeric
   * (`10778RG`, `09987RG`), so a salesperson who remembers "778" or the "RG"
   * tail would otherwise find nothing. A code that STARTS with the term is
   * still offered first. One character is enough to search.
   */
  async searchStyles(user: AuthUser, q: string) {
    const term = q.trim();
    if (!term) return [];
    const rows = await this.prisma.styleBom.findMany({
      where: { organisationId: user.organisationId, styleCode: { contains: term, mode: 'insensitive' } },
      orderBy: { styleCode: 'asc' },
      take: 50,
      select: { styleCode: true, itemType: true, itemSize: true },
    });
    const starts = term.toLowerCase();
    return rows
      .sort((a, b) => {
        const aFirst = a.styleCode.toLowerCase().startsWith(starts) ? 0 : 1;
        const bFirst = b.styleCode.toLowerCase().startsWith(starts) ? 0 : 1;
        return aFirst - bFirst || a.styleCode.localeCompare(b.styleCode);
      })
      .slice(0, 20);
  }

  /**
   * Load or refresh the master. Upserts by code, so running it again with a
   * newer export updates in place; nothing missing from the file is deleted.
   */
  async import(user: AuthUser, dto: ImportMaterialsDto) {
    const organisationId = user.organisationId;
    const counts = await this.write(organisationId, dto);
    await this.audit.record(user, {
      action: 'materials.import',
      entityType: 'Material',
      entityId: organisationId,
      summary: `Item master loaded: ${counts.materials} items, ${counts.sizes} sizes, ${counts.styles} styles`,
      metadata: counts,
    });
    return counts;
  }

  /**
   * The item master and the designs' materials, rebuilt from Gati's own tables
   * as the sync mirrors them. A design keyed into Gati is quotable here within
   * the hour, and a rate changed there is the rate quoted here.
   *
   * Returns null, and writes nothing, when the mirror does not hold Gati's item
   * table yet: an empty mirror is "not synced", never "Gati has no items".
   * Upserts only: nothing here is deleted because Gati no longer lists it.
   */
  async refreshFromGati(organisationId: string) {
    const rows = await this.prisma.legacyRow.findMany({
      where: {
        organisationId,
        OR: GATI_ITEM_MASTER_TABLES.map((t) => ({ sourceTable: { equals: t, mode: 'insensitive' as const } })),
      },
      select: { sourceTable: true, data: true },
    });
    const tables: Record<string, Record<string, unknown>[]> = {};
    for (const r of rows) (tables[r.sourceTable.toLowerCase()] ??= []).push(r.data as Record<string, unknown>);
    if (!tables['spm_items']?.length) return null;

    const master = buildGatiItemMaster(tables);
    const fingerprint = createHash('sha256').update(JSON.stringify(master)).digest('hex');
    const counts = { materials: master.materials.length, sizes: master.sizes.length, styles: master.styles.length };
    if (this.lastGatiMaster.get(organisationId) === fingerprint) return { ...counts, changed: false };

    await this.write(organisationId, master as ImportMaterialsDto);
    this.lastGatiMaster.set(organisationId, fingerprint);
    await this.audit.recordSystem(organisationId, 'gati_item_master', {
      action: 'materials.import',
      entityType: 'Material',
      entityId: organisationId,
      summary: `Item master refreshed from Gati: ${counts.materials} items, ${counts.sizes} sizes, ${counts.styles} styles`,
      metadata: counts,
    });
    return { ...counts, changed: true };
  }

  /** Every organisation whose mirror holds Gati's item table, once an hour. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'materials.gati-refresh' })
  async refreshAllFromGati(): Promise<void> {
    if ((this.config.get<string>('SCHEDULER_ENABLED') ?? 'true') === 'false') return;
    const orgs = await this.prisma.legacyRow.groupBy({
      by: ['organisationId'],
      where: { sourceTable: { equals: 'SPM_Items', mode: 'insensitive' } },
    });
    for (const { organisationId } of orgs) {
      try {
        const r = await this.refreshFromGati(organisationId);
        if (r?.changed) this.logger.log(`item master from Gati ${organisationId}: ${r.materials} items, ${r.sizes} sizes, ${r.styles} styles`);
      } catch (e) {
        this.logger.warn(`item master from Gati ${organisationId} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /** Upsert the three lists by code. Shared by the file load and the Gati refresh. */
  private async write(organisationId: string, dto: ImportMaterialsDto) {
    const json = (v: unknown) => (v == null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
    for (const m of dto.materials ?? []) {
      const data = {
        name: m.name.trim(),
        groupCode: m.groupCode ?? null,
        groupName: m.groupName ?? null,
        karat: m.karat ?? null,
        tone: m.tone ?? null,
        shape: m.shape ?? null,
        quality: m.quality ?? null,
        saleRates: json(m.saleRates),
        isActive: m.isActive ?? true,
        legacyId: m.legacyId ?? null,
      };
      await this.prisma.material.upsert({
        where: { organisationId_kind_code: { organisationId, kind: m.kind, code: m.code.trim() } },
        create: { organisationId, kind: m.kind, code: m.code.trim(), ...data },
        update: data,
      });
    }
    for (const s of dto.sizes ?? []) {
      const data = {
        mm: s.mm ?? null,
        caratPerPiece: s.caratPerPiece != null ? new Prisma.Decimal(s.caratPerPiece) : null,
        sizeGroup: s.sizeGroup ?? null,
        sortOrder: s.sortOrder ?? 0,
        legacyId: s.legacyId ?? null,
      };
      await this.prisma.materialSize.upsert({
        where: { organisationId_code: { organisationId, code: s.code.trim() } },
        create: { organisationId, code: s.code.trim(), ...data },
        update: data,
      });
    }
    for (const st of dto.styles ?? []) {
      const data = {
        itemType: st.itemType ?? null,
        itemSize: st.itemSize ?? null,
        lines: st.lines as unknown as Prisma.InputJsonValue,
        legacyId: st.legacyId ?? null,
      };
      await this.prisma.styleBom.upsert({
        where: { organisationId_styleCode: { organisationId, styleCode: st.styleCode.trim() } },
        create: { organisationId, styleCode: st.styleCode.trim(), ...data },
        update: data,
      });
    }
    return {
      materials: dto.materials?.length ?? 0,
      sizes: dto.sizes?.length ?? 0,
      styles: dto.styles?.length ?? 0,
    };
  }
}
