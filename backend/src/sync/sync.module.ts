import { Module } from '@nestjs/common';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';
import { GatiIngestionGuard } from './gati-ingestion.guard';
import { ProductsModule } from '../products/products.module';
import { CatalogueModule } from '../catalogue/catalogue.module';

/** Legacy-sync ingestion (data pipeline sink for the on-site SQL Server agent). */
@Module({
  imports: [ProductsModule, CatalogueModule],
  controllers: [SyncController],
  providers: [SyncService, GatiIngestionGuard],
})
export class SyncModule {}
