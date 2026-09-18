import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { CatalogueSyncController } from './catalogue-sync.controller';
import { WebsiteCatalogueClient } from './website/website-catalogue.client';
import { WebsiteCatalogueService } from './website/website-catalogue.service';

/**
 * Catalogue sources: the website connector, sync runs, the conflict queue and
 * the integration health board. See docs/modules/05-catalogue-sources.md.
 */
@Module({
  imports: [ProductsModule],
  controllers: [CatalogueSyncController],
  providers: [WebsiteCatalogueService, WebsiteCatalogueClient],
  exports: [WebsiteCatalogueService],
})
export class CatalogueModule {}
