import { Global, Module } from '@nestjs/common';
import { StoreScopeService } from './store-scope.service';
import { AuditService } from './audit.service';

/** Shared cross-cutting providers (store-scoping, audit trail) available everywhere. */
@Global()
@Module({
  providers: [StoreScopeService, AuditService],
  exports: [StoreScopeService, AuditService],
})
export class CommonModule {}
