import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { AuthUser } from '../common/auth-user';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { ActivityService } from '../crm/activity.service';

/**
 * Archiving a contact.
 *
 * This is the answer to "I can't delete the people who blocked us", and the
 * shape of the answer matters more than the feature.
 *
 * NOTHING IS ERASED. A person who sent STOP is remembered by their record: the
 * consent events, `isBlacklisted`, the delivery history and the audit trail all
 * hang off it. Delete the row and the next inbound message from that number
 * resolves to a brand-new customer carrying no opt-out — and the system messages
 * somebody who told it to stop. Archiving hides the contact from the lists people
 * work from and leaves every one of those records exactly where it was.
 *
 * Identity resolution deliberately still finds archived contacts. That is not an
 * oversight; it is the mechanism that keeps the refusal attached to the person.
 */
@Injectable()
export class PartyArchiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: StoreScopeService,
    private readonly audit: AuditService,
    private readonly activity: ActivityService,
  ) {}

  async archive(user: AuthUser, partyId: string, reason: string) {
    const trimmed = reason.trim();
    if (trimmed.length < 3) {
      throw new BadRequestException('Give a reason for archiving this contact.');
    }

    const party = await this.mustReach(user, partyId);
    if (party.archivedAt) {
      throw new BadRequestException('That contact is already archived.');
    }

    const row = await this.prisma.party.update({
      where: { id: partyId },
      data: { archivedAt: new Date(), archivedById: user.id, archiveReason: trimmed },
      select: { id: true, name: true, archivedAt: true, archiveReason: true },
    });

    await this.audit.record(user, {
      action: 'crm.contact_archived',
      entityType: 'Party',
      entityId: partyId,
      storeId: party.storeId,
      // The reason is the archiver's own words and may name a person, so the
      // summary stays generic and the reason itself lives in metadata where the
      // audit reader already expects sensitive detail.
      summary: 'Contact archived',
      metadata: { reason: trimmed },
    });

    await this.activity.recordFor(user, {
      type: 'contact.archived',
      summary: `Contact archived — ${trimmed.slice(0, 160)}`,
      partyId,
      storeId: party.storeId,
      entityType: 'Party',
      entityId: partyId,
    });

    return { ...row, archived: true as const };
  }

  async restore(user: AuthUser, partyId: string) {
    const party = await this.mustReach(user, partyId);
    if (!party.archivedAt) {
      throw new BadRequestException('That contact is not archived.');
    }

    /*
     * Restoring returns the contact to the working lists. It does NOT return
     * them to a messageable state on its own — consent, opt-out and the
     * blacklist are separate records and are untouched here, so a person who
     * sent STOP stays opted out after being restored. Un-blacklisting is a
     * different, deliberate act.
     */
    const row = await this.prisma.party.update({
      where: { id: partyId },
      data: { archivedAt: null, archivedById: null, archiveReason: null },
      select: { id: true, name: true, isBlacklisted: true },
    });

    await this.audit.record(user, {
      action: 'crm.contact_restored',
      entityType: 'Party',
      entityId: partyId,
      storeId: party.storeId,
      summary: 'Contact restored to the active directory',
      metadata: { wasArchivedAt: party.archivedAt.toISOString() },
    });

    await this.activity.recordFor(user, {
      type: 'contact.restored',
      summary: 'Contact restored to the active directory',
      partyId,
      storeId: party.storeId,
      entityType: 'Party',
      entityId: partyId,
    });

    return { ...row, archived: false as const };
  }

  /** Tenant AND store scoped; another tenant's contact reads as not found. */
  private async mustReach(user: AuthUser, partyId: string) {
    const party = await this.prisma.party.findFirst({
      where: {
        id: partyId,
        ...this.scope.orgFilter(user),
        ...this.scope.storeFilter(user),
      },
      select: { id: true, storeId: true, archivedAt: true },
    });
    if (!party) throw new NotFoundException('Contact not found.');
    return party;
  }
}
