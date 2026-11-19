import { Injectable, Logger } from '@nestjs/common';
import { LeadSource } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { provenanceTagForSource } from './provenance-tags';

/**
 * Puts the provenance tag on a lead the moment it is created.
 *
 * The backfill gave the records already in the system their "Meta Leads" and
 * "Walk-in Leads" tags. That is a one-off, and the client's instruction was
 * not: "any new customers when they will come from any source they must come
 * with a proper tag — leads module and customer module, both it applies."
 * Without this, every enquiry from tomorrow arrives untagged and the broadcast
 * audience she builds on tags quietly stops seeing new people.
 *
 * Both records, deliberately. A broadcast reads the CUSTOMER's tags and the
 * CRM board reads the LEAD's, so tagging one leaves the other blind.
 *
 * Never fails the thing it decorates. A tag is a label on a record that was
 * created for a reason of its own; losing the enquiry because the label could
 * not be written would be the wrong trade every time.
 */
@Injectable()
export class ProvenanceTagsService {
  private readonly logger = new Logger(ProvenanceTagsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async tagNewLead(input: {
    organisationId: string;
    leadId: string;
    partyId?: string | null;
    source: LeadSource;
  }): Promise<void> {
    const tag = provenanceTagForSource(input.source);
    if (!tag) return;

    try {
      const row = await this.ensureTag(input.organisationId, tag.name, tag.slug, tag.colour);
      await Promise.all([
        this.prisma.leadTagAssignment.createMany({
          data: [{ organisationId: input.organisationId, leadId: input.leadId, tagId: row.id }],
          skipDuplicates: true,
        }),
        input.partyId
          ? this.prisma.partyTagAssignment.createMany({
              data: [
                { organisationId: input.organisationId, partyId: input.partyId, tagId: row.id },
              ],
              skipDuplicates: true,
            })
          : Promise.resolve(),
      ]);
    } catch (error) {
      this.logger.warn(
        `provenance tag not applied to lead ${input.leadId}: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /**
   * The tenant's own tag of that name, created if this is the first one.
   *
   * Matched on `slug`, which is the vocabulary's own unique key, so a tag
   * somebody renamed in their own words keeps being used rather than a second
   * one appearing beside it. A retired tag is left retired and reused as it
   * stands: switching it back on would undo a decision somebody made.
   */
  private async ensureTag(organisationId: string, name: string, slug: string, colour: string) {
    const existing = await this.prisma.leadTag.findFirst({
      where: { organisationId, slug },
      select: { id: true },
    });
    if (existing) return existing;

    const count = await this.prisma.leadTag.count({ where: { organisationId } });
    return this.prisma.leadTag.create({
      data: { organisationId, name, slug, colour, sortOrder: count },
      select: { id: true },
    });
  }
}
