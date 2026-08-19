import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AiImageSearchService } from './ai-image-search.service';
import { ImageEmbeddingService } from './image-embedding.service';
import { MlInferenceService } from './ml-inference.service';
import { JewelryRankingService } from './jewelry-ranking.service';
import { JewelrySimilarityService } from './jewelry-similarity.service';

@Module({
  controllers: [ProductsController],
  providers: [
    ProductsService,
    AiImageSearchService,
    ImageEmbeddingService,
    MlInferenceService,
    JewelryRankingService,
    JewelrySimilarityService,
  ],
})
export class ProductsModule {}
