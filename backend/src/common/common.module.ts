import { Global, Module } from '@nestjs/common';
import { StoreScopeService } from './store-scope.service';
import { AuditService } from './audit.service';
import { SequenceService } from './sequence.service';
import { ProvenanceService } from './provenance.service';
import { CredentialCrypto } from '../integration/framework/credential-crypto';

/**
 * Shared cross-cutting providers (store-scoping, audit trail, document-reference
 * sequences, record provenance) available everywhere.
 *
 * ProvenanceService lives here rather than in IntegrationModule because both the
 * import engine and the legacy sync must consult the same rule, and putting it in
 * IntegrationModule would create a cycle the moment the Gati connector needs
 * SyncService.
 *
 * CredentialCrypto is here for the same reason. It is needed by the integration
 * framework AND by the channel adapters that actually send (WhatsApp), and those
 * live in different modules; registering it twice would give two instances of a
 * key holder, while importing across would make a cycle. It is stateless — a
 * key reader over ConfigService — so one global instance is the right shape.
 */
@Global()
@Module({
  providers: [StoreScopeService, AuditService, SequenceService, ProvenanceService, CredentialCrypto],
  exports: [StoreScopeService, AuditService, SequenceService, ProvenanceService, CredentialCrypto],
})
export class CommonModule {}
