import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuthUser } from './auth-user';

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
 * Best-effort by contract: an audit-write failure must NEVER break the main
 * mutation, so every write is wrapped in try/catch and errors are swallowed
 * (logged, not thrown). Call it AFTER the primary write has succeeded.
 *
 * Global (exported from CommonModule) so any service can inject it.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Write one AuditLog row. Swallows all errors (audit is never load-bearing). */
  async record(user: AuthUser, e: AuditEvent): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: user.id,
          actorName: user.name,
          actorRole: user.role,
          action: e.action,
          entityType: e.entityType,
          entityId: e.entityId,
          storeId: e.storeId ?? null,
          summary: e.summary,
          metadata: e.metadata ?? undefined,
        },
      });
    } catch (err) {
      this.logger.warn(
        `audit.record failed for ${e.action} ${e.entityType}#${e.entityId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }
}
