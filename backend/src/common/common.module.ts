import { Global, Module } from '@nestjs/common';
import { StoreScopeService } from './store-scope.service';

/** Shared cross-cutting providers (store-scoping) available everywhere. */
@Global()
@Module({
  providers: [StoreScopeService],
  exports: [StoreScopeService],
})
export class CommonModule {}
