import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

/** Legacy-sync ingestion (data pipeline sink for the on-site SQL Server agent). */
@Module({
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
