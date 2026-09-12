import { Global, Module } from '@nestjs/common';
import { StoreScopeService } from './store-scope.service';
import { AuditService } from './audit.service';
import { SequenceService } from './sequence.service';
import { ProvenanceService } from './provenance.service';
import { CredentialCrypto } from '../integration/framework/credential-crypto';
import { AiProviderConfig } from '../crm/ai/ai-provider-config';

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
 *
 * AiProviderConfig is here for exactly that reason too. Three places have to
 * agree about whether the AI is configured — the signal extractor, the reply
 * drafter and the adapter report — and they live in two modules. They used to
 * read the environment separately and disagreed about the same variables, which
 * is the bug it exists to close; registering it twice would reintroduce the
 * possibility of two different answers. Stateless, so one instance is right.
 */
@Global()
@Module({
  providers: [
    StoreScopeService,
    AuditService,
    SequenceService,
    ProvenanceService,
    CredentialCrypto,
    AiProviderConfig,
  ],
  exports: [
    StoreScopeService,
    AuditService,
    SequenceService,
    ProvenanceService,
    CredentialCrypto,
    AiProviderConfig,
  ],
})
export class CommonModule {}
