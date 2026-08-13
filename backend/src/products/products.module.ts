import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AiImageSearchService } from './ai-image-search.service';
import { ImageEmbeddingService } from './image-embedding.service';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, AiImageSearchService, ImageEmbeddingService],
})
export class ProductsModule {}
