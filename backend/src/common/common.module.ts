import { Global, Module } from '@nestjs/common';
import { StoreScopeService } from './store-scope.service';
import { AuditService } from './audit.service';
import { SequenceService } from './sequence.service';

/**
 * Shared cross-cutting providers (store-scoping, audit trail, document-reference
 * sequences) available everywhere.
 */
@Global()
@Module({
  providers: [StoreScopeService, AuditService, SequenceService],
  exports: [StoreScopeService, AuditService, SequenceService],
})
export class CommonModule {}
