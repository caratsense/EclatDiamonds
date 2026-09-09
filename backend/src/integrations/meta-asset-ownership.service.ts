import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';

export const META_ADS_PROVIDER_CODE = 'meta_ads';
export const META_ROUTING_ASSET_KIND = 'page';

export interface MetaAssetOwner {
  organisationId: string;
  integrationId: string;
}

/**
 * Owns the trust boundary between a provider-side Page id and a CaratOS tenant.
 * A Page id from the webhook body is only a lookup key; it does not assert its
 * own tenant. Exactly one active IntegrationAsset must claim it, and the
 * denormalised tenant on the asset must agree with its parent Integration.
 */
@Injectable()
export class MetaAssetOwnershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async ownerForPage(pageId: string): Promise<MetaAssetOwner | null> {
    const externalId = normaliseMetaId(pageId);
    if (!externalId) return null;

    const rows = await this.prisma.integrationAsset.findMany({
      where: {
        kind: META_ROUTING_ASSET_KIND,
        externalId,
        isActive: true,
        integration: {
          providerCode: META_ADS_PROVIDER_CODE,
          status: { not: 'disabled' },
        },
      },
      take: 2,
      select: {
        organisationId: true,
        integrationId: true,
        integration: { select: { organisationId: true } },
      },
    });

    if (rows.length !== 1) return null;
    const row = rows[0];
    if (row.organisationId !== row.integration.organisationId) return null;
    return {
      organisationId: row.integration.organisationId,
      integrationId: row.integrationId,
    };
  }

  /**
   * Register an id only after the tenant has selected it in Meta's own UI.
   * `providerOwnershipVerified` stays false until a live Graph lookup proves
   * that the saved token can actually read it.
   */
  async register(
    user: AuthUser,
    input: {
      integrationId: string;
      kind: 'page' | 'ad_account' | 'form';
      externalId: string;
      name?: string;
    },
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: input.integrationId,
        organisationId: user.organisationId,
        providerCode: META_ADS_PROVIDER_CODE,
      },
      select: { id: true, name: true },
    });
    if (!integration) throw new NotFoundException('Meta Ads integration not found');

    const externalId = normaliseMetaId(input.externalId);
    if (!externalId) {
      throw new BadRequestException('Meta asset id must contain 3 to 64 digits.');
    }

    const ownershipKey = `${META_ADS_PROVIDER_CODE}:${input.kind}:${externalId}`;
    let asset:
      | { id: string; kind: string; externalId: string; name: string | null; isActive: boolean }
      | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        asset = await this.prisma.$transaction(
          async (tx) => {
            const conflict = await tx.integrationAsset.findFirst({
              where: {
                kind: input.kind,
                externalId,
                isActive: true,
                integration: { providerCode: META_ADS_PROVIDER_CODE },
                NOT: { integrationId: integration.id },
              },
              select: { id: true },
            });
            if (conflict) {
              throw new BadRequestException(
                'That Meta asset is already registered to another connection.',
              );
            }
            return tx.integrationAsset.upsert({
              where: {
                integrationId_kind_externalId: {
                  integrationId: integration.id,
                  kind: input.kind,
                  externalId,
                },
              },
              create: {
                organisationId: user.organisationId,
                integrationId: integration.id,
                kind: input.kind,
                externalId,
                name: input.name?.trim() || null,
                isActive: true,
                ownershipKey,
                metadata: { providerOwnershipVerified: false },
              },
              update: {
                organisationId: user.organisationId,
                name: input.name?.trim() || null,
                isActive: true,
                ownershipKey,
                metadata: { providerOwnershipVerified: false },
              },
              select: { id: true, kind: true, externalId: true, name: true, isActive: true },
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
        break;
      } catch (error) {
        if (error instanceof BadRequestException) throw error;
        const code = (error as { code?: string }).code;
        if (code === 'P2002') {
          throw new BadRequestException(
            'That Meta asset is already registered to another connection.',
          );
        }
        if (code !== 'P2034' || attempt === 2) throw error;
      }
    }
    if (!asset) throw new InternalServerErrorException('Meta asset registration did not finish.');

    await this.audit.record(user, {
      action: 'integration.meta_asset_registered',
      entityType: 'Integration',
      entityId: integration.id,
      summary: `Registered a Meta ${input.kind.replace('_', ' ')} for "${integration.name}".`,
      metadata: { kind: input.kind, providerOwnershipVerified: false },
    });
    return { ...asset, providerOwnershipVerified: false };
  }
}

export function normaliseMetaId(value: unknown): string | null {
  const id = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : String(value ?? '').trim();
  return /^\d{3,64}$/.test(id) ? id : null;
}

