import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/** File/object storage (images, return photos) — global so any module can inject it. */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
