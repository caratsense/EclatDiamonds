import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AiImageSearchService } from './ai-image-search.service';
import { ImageEmbeddingService } from './image-embedding.service';
import { MlInferenceService } from './ml-inference.service';
import { JewelryRankingService } from './jewelry-ranking.service';
import { JewelrySimilarityService } from './jewelry-similarity.service';
import { CatalogueExportController } from './catalogue-export.controller';
import { CatalogueExportService } from './catalogue-export.service';
import { CatalogueIndexService } from './catalogue-index.service';

@Module({
  controllers: [ProductsController, CatalogueExportController],
  providers: [
    ProductsService,
    CatalogueExportService,
    AiImageSearchService,
    ImageEmbeddingService,
    MlInferenceService,
    JewelryRankingService,
    JewelrySimilarityService,
    CatalogueIndexService,
  ],
  // Syncs and the catalogue-source connector queue new pictures for indexing.
  exports: [CatalogueIndexService],
})
export class ProductsModule {}
