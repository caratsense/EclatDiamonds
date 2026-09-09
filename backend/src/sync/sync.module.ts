import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { GatiIngestionGuard } from './gati-ingestion.guard';

/** Legacy-sync ingestion (data pipeline sink for the on-site SQL Server agent). */
@Module({
  controllers: [SyncController],
  providers: [SyncService, GatiIngestionGuard],
})
export class SyncModule {}
