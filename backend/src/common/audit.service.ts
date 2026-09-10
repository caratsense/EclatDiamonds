import { Injectable, Logger } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth-user';

type AuditPersistenceClient = Pick<PrismaService, 'auditLog'>;

/**
 * The automations allowed to write a system-attributed row, and the name each
 * one appears under in the trail.
 *
 * A closed list on purpose: "the system did it" is only useful to an auditor if
 * it names WHICH piece of the system, and a free-form string would let that
 * degrade into an untraceable catch-all one call site at a time.
 */
export const SYSTEM_ACTORS = {
  /** The fair round-robin queue placing a lead or conversation with a salesperson. */
  round_robin: 'Automatic assignment',
  /** A visitor submitting the public QR enquiry form. */
  qr_lead_capture: 'QR lead capture',
  /** A visitor submitting a lead form embedded on the tenant's own website. */
  web_form_capture: 'Website enquiry form',
  /** A person converting an ordinary conversation into a sales lead. */
  conversation_conversion: 'Conversation converted to a lead',
  /** A spreadsheet or connector import electing to open leads, not just customers. */
  import_lead_capture: 'Import lead capture',
  /** The background job turning an approved campaign audience into recipients. */
  campaign_expansion: 'Campaign audience expansion',
  /** A verified telephony provider notification opening an enquiry from a call. */
  telephony_webhook: 'Inbound call',
} as const;

export type SystemActor = keyof typeof SYSTEM_ACTORS;

/** The actor columns of an AuditLog row. Exactly one identity is non-null. */
interface AuditActor {
  organisationId: string;
  actorId: string | null;
  machineActorId: string | null;
  systemActorId: string | null;
  actorName: string;
  actorRole: Role;
}

/** The mutation-specific detail an audited action records. */
export interface AuditEvent {
  action: string;
  entityType: string;
  entityId: string;
  storeId?: string | null;
  summary: string;
  metadata?: any;
}

/**
 * AuditService — append an immutable trail row for a sensitive decision.
 *
 * Human call sites are best-effort by default: an audit-write failure is logged
 * after the primary mutation. Security-sensitive connector ingestion supplies
 * its active transaction instead, making the domain write and audit trail one
 * atomic unit.
 *
 * Global (exported from CommonModule) so any service can inject it.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write one AuditLog row.
   *
   * Ordinary mutations retain the historical best-effort contract. A caller
   * may provide its active transaction for security-sensitive machine writes;
   * that form deliberately propagates an audit failure so the domain mutation
   * and its audit trail commit or roll back together.
   */
  async record(
    user: AuthUser,
    e: AuditEvent,
    transaction?: AuditPersistenceClient,
  ): Promise<void> {
    return this.persist(e, transaction, () => {
      if (user.isMachine && !user.agentId) {
        throw new Error('Machine audit identity is missing its Connect agent id.');
      }
      return {
        organisationId: user.organisationId,
        actorId: user.isMachine ? null : user.id,
        machineActorId: user.isMachine ? user.agentId! : null,
        systemActorId: null,
        actorName: user.name,
        actorRole: user.role,
      };
    });
  }

  /**
   * Write one AuditLog row for something the software decided on its own.
   *
   * There are decisions no person makes: an inbound message placing a
   * conversation in the round-robin queue, a public QR form creating a lead.
   * Ownership genuinely changes hands, so the trail must show it — but there is
   * no `AuthUser` to attribute it to, and inventing one would be worse than the
   * gap: a fabricated user id breaks the actor foreign key, and borrowing the
   * Connect-agent column would report automation as a customer's own machine.
   *
   * So the row names the automation itself in a third identity column. That
   * keeps 'exactly one actor' a database CHECK rather than a convention, and
   * gives `GET /audit` an honest third answer beside `user` and `connect_agent`.
   */
  async recordSystem(
    organisationId: string,
    automation: SystemActor,
    e: AuditEvent,
    transaction?: AuditPersistenceClient,
  ): Promise<void> {
    return this.persist(e, transaction, () => ({
      organisationId,
      actorId: null,
      machineActorId: null,
      systemActorId: automation,
      actorName: SYSTEM_ACTORS[automation],
      // actorRole is NOT NULL and Role has no automation member. head_office is
      // the widest scope and matches what these paths can reach; systemActorId
      // is what marks the row as automated, never the role.
      actorRole: Role.head_office,
    }));
  }

  private async persist(
    e: AuditEvent,
    transaction: AuditPersistenceClient | undefined,
    actor: () => AuditActor,
  ): Promise<void> {
    const write = async (db: AuditPersistenceClient) => {
      await db.auditLog.create({
        data: {
          ...actor(),
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          storeId: e.storeId ?? null,
          summary: e.summary,
          metadata: e.metadata ?? undefined,
        },
      });
    };

    if (transaction) {
      await write(transaction);
      return;
    }
    try {
      await write(this.prisma);
    } catch (err) {
      this.logger.warn(
        `audit.record failed for ${e.action} ${e.entityType}#${e.entityId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }
}
