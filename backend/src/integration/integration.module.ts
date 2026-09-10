import { Module } from '@nestjs/common';

import { ImportController } from './import/import.controller';
import { ImportService } from './import/import.service';
import { ConnectorsController } from './connectors/connectors.controller';
import { ConnectorRegistry } from './connectors/connector-registry';
import { FieldOwnershipService } from './framework/field-ownership.service';
import { IntegrationsRegistryService } from './framework/integrations-registry.service';
import { IntegrationsRegistryController } from './framework/integrations-registry.controller';
import { ConnectorRuntimeService } from './framework/connector-runtime.service';
import { ConnectService } from './connect/connect.service';
import { ConnectAdminController, ConnectAgentController } from './connect/connect.controller';

/**
 * Generic import, connector and per-tenant integration boundary.
 *
 * File imports intentionally remain on the bounded synchronous ImportController
 * path. A former dormant background handler was removed because the shared job
 * queue is at-least-once and cannot yet renew/fence a long import lease. It must
 * not be reintroduced until the handler has a durable receipt contract.
 */
@Module({
  controllers: [
    ImportController,
    ConnectorsController,
    IntegrationsRegistryController,
    ConnectAdminController,
    ConnectAgentController,
  ],
  providers: [
    ImportService,
    ConnectorRegistry,
    FieldOwnershipService,
    IntegrationsRegistryService,
    ConnectorRuntimeService,
    ConnectService,
  ],
  exports: [
    IntegrationsRegistryService,
    FieldOwnershipService,
    ConnectorRuntimeService,
    // JwtAuthGuard resolves agent tokens through the same service that issues,
    // rotates and revokes them.
    ConnectService,
  ],
})
export class IntegrationModule {}
