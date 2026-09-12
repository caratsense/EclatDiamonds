import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../common/audit.service';
import { AuthUser } from '../common/auth-user';
import { StoreScopeService } from '../common/store-scope.service';
import { WHATSAPP_PROVIDER_CODE } from './whatsapp-credentials.service';

/**
 * Which number each branch sends from (Block 12).
 *
 * ## What this is for
 *
 * A tenant with eight WhatsApp numbers across two WABA accounts needs to say
 * which branch speaks on which number. Until this existed the resolver took the
 * oldest active number for every send, so a customer who wrote to the Surat shop
 * was answered from Mumbai — and nothing in the product said so.
 *
 * ## Two rules that are not obvious
 *
 * A NUMBER MAY SERVE SEVERAL BRANCHES. A head-office line answering for three
 * shops is an ordinary arrangement, so the asset side of the mapping is not
 * unique. What is unique is the branch side: one sender per branch per channel,
 * because two would be a coin toss at send time.
 *
 * MAPPING IS NOT OWNERSHIP. Registering a phone-number id against an
 * integration is what claims it (and `IntegrationAsset.ownershipKey` is what
 * stops two tenants claiming the same one). This service only decides who USES
 * an already-claimed number, and every write re-checks that the asset and the
 * branch belong to the caller's own organisation — because both ids arrive in
 * the request body.
 */

/** The channels a branch can be routed on today. */
export const ROUTABLE_CHANNELS = ['whatsapp'] as const;
export type RoutableChannel = (typeof ROUTABLE_CHANNELS)[number];

@Injectable()
export class MessagingRoutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: StoreScopeService,
  ) {}

  /**
   * The whole routing picture for a channel: the numbers available, the branches
   * that need one, and what each is mapped to.
   *
   * Returned together on purpose. A screen that fetched these separately would
   * show a branch as "unrouted" while its number was still loading, and the
   * operator's next action depends on seeing both halves at once.
   */
  async overview(user: AuthUser, channel: RoutableChannel = 'whatsapp') {
    this.assertChannel(channel);

    const [assets, stores, routes] = await Promise.all([
      this.prisma.integrationAsset.findMany({
        where: {
          organisationId: user.organisationId,
          kind: 'phone_number',
          integration: {
            providerCode: WHATSAPP_PROVIDER_CODE,
            status: { notIn: ['disabled'] },
          },
        },
        orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
        select: {
          id: true,
          externalId: true,
          name: true,
          isActive: true,
          providerOwnershipVerified: true,
          lastVerifiedAt: true,
          integrationId: true,
          integration: { select: { id: true, name: true, status: true } },
        },
      }),
      this.prisma.store.findMany({
        where: {
          organisationId: user.organisationId,
          // An aggregate row is a reporting rollup, not a place with a phone.
          isAggregate: false,
          ...(user.allStores ? {} : { id: { in: user.storeIds } }),
        },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, city: true },
      }),
      this.prisma.storeMessagingRoute.findMany({
        where: { organisationId: user.organisationId, channel },
        select: { storeId: true, assetId: true, integrationId: true, updatedAt: true },
      }),
    ]);

    const byStore = new Map(routes.map((r) => [r.storeId, r]));
    const activeNumbers = assets.filter((a) => a.isActive).length;

    return {
      channel,
      /**
       * The two WABA accounts show up here as two integrations. Grouped so a
       * screen can say which account a number belongs to — with two accounts
       * the tokens differ, and a number is only usable with its own account's.
       */
      accounts: dedupeAccounts(assets),
      numbers: assets.map((a) => ({
        id: a.id,
        /** Last four only. Enough to recognise, useless to an interceptor. */
        phoneNumberIdSuffix: `…${a.externalId.slice(-4)}`,
        name: a.name,
        isActive: a.isActive,
        // Never presented as proven unless a live provider call proved it.
        providerOwnershipVerified: a.providerOwnershipVerified,
        lastVerifiedAt: a.lastVerifiedAt,
        accountId: a.integrationId,
        accountName: a.integration.name,
        branchesUsing: routes.filter((r) => r.assetId === a.id).length,
      })),
      branches: stores.map((s) => {
        const route = byStore.get(s.id);
        return {
          storeId: s.id,
          name: s.name,
          city: s.city,
          assetId: route?.assetId ?? null,
          routedAt: route?.updatedAt ?? null,
          /**
           * What would actually happen if this branch sent right now. Stated per
           * branch because that is the question an operator has, and because
           * "unroutable" is only true when there is more than one number to
           * choose between.
           */
          effective: route
            ? ('routed' as const)
            : activeNumbers === 1
              ? ('only_number' as const)
              : activeNumbers === 0
                ? ('no_number' as const)
                : ('ambiguous' as const),
        };
      }),
      /** Branches that would refuse to send. The list to act on. */
      unroutable:
        activeNumbers > 1
          ? stores.filter((s) => !byStore.has(s.id)).map((s) => s.name)
          : [],
    };
  }

  /** Map a branch to the number it sends from. */
  async set(
    user: AuthUser,
    input: { storeId: string; assetId: string; channel?: RoutableChannel },
  ) {
    const channel = input.channel ?? 'whatsapp';
    this.assertChannel(channel);
    // Both ids came from the request body, so both are re-checked against the
    // caller's own scope. Without this a head-office user of one tenant could
    // name another tenant's asset and route their branch onto somebody else's
    // number.
    this.scope.assertStoreAllowed(user, input.storeId);

    const store = await this.prisma.store.findFirst({
      where: { id: input.storeId, organisationId: user.organisationId },
      select: { id: true, name: true, isAggregate: true },
    });
    if (!store) throw new NotFoundException('That branch does not exist in this organisation.');
    if (store.isAggregate) {
      throw new BadRequestException(
        'An aggregate row is a reporting rollup, not a branch that sends messages.',
      );
    }

    const asset = await this.prisma.integrationAsset.findFirst({
      where: {
        id: input.assetId,
        organisationId: user.organisationId,
        kind: 'phone_number',
        integration: { providerCode: WHATSAPP_PROVIDER_CODE },
      },
      select: {
        id: true,
        externalId: true,
        isActive: true,
        integrationId: true,
        integration: { select: { name: true, status: true } },
      },
    });
    if (!asset) {
      throw new NotFoundException('That number is not registered to this organisation.');
    }
    // Routing a branch onto a number that cannot send produces a branch that
    // looks configured and silently fails. Refuse now, with the reason.
    if (!asset.isActive) {
      throw new BadRequestException(
        'That number is no longer active on its account. Re-register it before routing a branch to it.',
      );
    }
    if (asset.integration.status === 'disabled') {
      throw new BadRequestException(
        `The "${asset.integration.name}" connection is disabled, so nothing can be sent from its numbers.`,
      );
    }

    const route = await this.prisma.storeMessagingRoute.upsert({
      where: { storeId_channel: { storeId: store.id, channel } },
      create: {
        organisationId: user.organisationId,
        storeId: store.id,
        channel,
        integrationId: asset.integrationId,
        assetId: asset.id,
        createdById: user.id,
      },
      // The integration is rewritten alongside the asset: moving a branch to a
      // number on the OTHER WABA account must move the account with it, or the
      // route would name a token that cannot use the number.
      update: { integrationId: asset.integrationId, assetId: asset.id },
      select: { id: true, storeId: true, assetId: true, channel: true },
    });

    await this.audit.record(user, {
      action: 'integration.messaging_route_set',
      entityType: 'Store',
      entityId: store.id,
      storeId: store.id,
      summary:
        `${store.name} now sends ${channel} from …${asset.externalId.slice(-4)} ` +
        `("${asset.integration.name}").`,
      metadata: { channel, assetId: asset.id, integrationId: asset.integrationId },
    });

    return route;
  }

  /**
   * Unmap a branch.
   *
   * With several numbers connected this makes the branch unable to send, which
   * is the honest outcome and is stated in the response — the alternative would
   * be to fall back to an arbitrary number, which is exactly the behaviour this
   * whole block removed.
   */
  async clear(user: AuthUser, storeId: string, channel: RoutableChannel = 'whatsapp') {
    this.assertChannel(channel);
    this.scope.assertStoreAllowed(user, storeId);

    const deleted = await this.prisma.storeMessagingRoute.deleteMany({
      where: { organisationId: user.organisationId, storeId, channel },
    });
    if (!deleted.count) throw new NotFoundException('That branch has no route on this channel.');

    const active = await this.prisma.integrationAsset.count({
      where: {
        organisationId: user.organisationId,
        kind: 'phone_number',
        isActive: true,
        integration: {
          providerCode: WHATSAPP_PROVIDER_CODE,
          status: { notIn: ['disabled'] },
        },
      },
    });

    await this.audit.record(user, {
      action: 'integration.messaging_route_cleared',
      entityType: 'Store',
      entityId: storeId,
      storeId,
      summary: `Removed the ${channel} sender mapping for this branch.`,
      metadata: { channel },
    });

    return {
      removed: true,
      /** Said out loud, because the branch has just stopped being able to send. */
      warning:
        active > 1
          ? `This branch can no longer send ${channel}: ${active} numbers are connected and none is now mapped to it.`
          : null,
    };
  }

  private assertChannel(channel: string): void {
    if (!(ROUTABLE_CHANNELS as readonly string[]).includes(channel)) {
      throw new BadRequestException(
        `Routing is not implemented for "${channel}". Only ${ROUTABLE_CHANNELS.join(', ')} ` +
          'can be routed per branch today, because only it has an outbound adapter.',
      );
    }
  }
}

/** The distinct provider accounts a tenant's numbers live under. */
function dedupeAccounts(
  assets: { integrationId: string; integration: { id: string; name: string; status: string } }[],
) {
  const seen = new Map<string, { id: string; name: string; status: string; numbers: number }>();
  for (const a of assets) {
    const existing = seen.get(a.integrationId);
    if (existing) existing.numbers += 1;
    else
      seen.set(a.integrationId, {
        id: a.integration.id,
        name: a.integration.name,
        status: a.integration.status,
        numbers: 1,
      });
  }
  return [...seen.values()];
}
