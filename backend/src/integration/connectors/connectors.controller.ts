import { Controller, Get, Param, Post, Query } from '@nestjs/common';

import { Roles } from '../../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../../common/auth-user';
import { ProvenanceService } from '../../common/provenance.service';
import { ConnectorRegistry } from './connector-registry';
import { ConnectorRuntimeService } from '../framework/connector-runtime.service';
import type { SourceSystem } from '../contracts/provenance';

/**
 * Connector status + runtime orchestration (Phase A7).
 *
 * Read-only and organisation-scoped: every route resolves the tenant from the
 * authenticated user. The registry itself is platform-level (which connectors
 * exist), but everything about a tenant's DATA — watermarks, import batches,
 * provenance counts — is bounded to the caller's organisation.
 *
 * The actual file-import endpoints stay on ImportController, which already owns
 * the multipart handling. Duplicating them here would create a second way to do
 * the same import.
 */
@Roles('store_manager', 'head_office')
@Controller('integration/connectors')
export class ConnectorsController {
  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly runtime: ConnectorRuntimeService,
    private readonly provenance: ProvenanceService,
  ) {}

  /** The raw registry — what connectors exist and what they claim to support. */
  @Get()
  list() {
    return this.registry.list();
  }

  /**
   * The runtime view: adds `intakeMode` and `runnable`, which is what a UI needs
   * to decide whether a "Sync now" button should exist for a source at all.
   */
  @Get('runtime')
  runtime_(@CurrentUser() user: AuthUser) {
    return this.runtime.list(user);
  }

  /** What has this source actually delivered for the caller's organisation? */
  @Get('discover/:sourceSystem')
  @Roles('head_office')
  discover(@CurrentUser() user: AuthUser, @Param('sourceSystem') sourceSystem: string) {
    return this.runtime.discover(user, sourceSystem as SourceSystem);
  }

  /**
   * Where did this organisation's data come from? Counts by origin plus the
   * import totals — the go-live question, answered from provenance rather than
   * from a comparison with a source CaratOS cannot read.
   */
  @Get('reconcile')
  @Roles('head_office')
  reconcile(@CurrentUser() user: AuthUser) {
    return this.runtime.reconcile(user);
  }

  /** Origin of one record, for support questions and the record detail panel. */
  @Get('provenance/:model/:id')
  @Roles('head_office')
  async provenanceOf(
    @CurrentUser() user: AuthUser,
    @Param('model') model: string,
    @Param('id') id: string,
  ) {
    if (!['party', 'product', 'store'].includes(model)) {
      return { supported: false, message: 'Provenance is tracked for customers, products and stores.' };
    }
    const result = await this.provenance.describeRecord(
      user.organisationId,
      model as 'party' | 'product' | 'store',
      id,
    );
    return result ?? { found: false, message: 'Record not found in your organisation.' };
  }
}
