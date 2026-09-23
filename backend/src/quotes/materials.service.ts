import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { ImportMaterialsDto } from './dto/materials.dto';

/**
 * The item master a quote is priced from: item types, metals, diamonds,
 * colour stones and stone sizes by the ERP's codes, and each design's default
 * bill of materials. Read by everyone who quotes; loaded by head office.
 */
@Injectable()
export class MaterialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
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
    const counts = {
      materials: dto.materials?.length ?? 0,
      sizes: dto.sizes?.length ?? 0,
      styles: dto.styles?.length ?? 0,
    };
    await this.audit.record(user, {
      action: 'materials.import',
      entityType: 'Material',
      entityId: organisationId,
      summary: `Item master loaded: ${counts.materials} items, ${counts.sizes} sizes, ${counts.styles} styles`,
      metadata: counts,
    });
    return counts;
  }
}
