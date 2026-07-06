import { Module } from '@nestjs/common';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { AiImageSearchService } from './ai-image-search.service';

@Module({
  controllers: [ProductsController],
  providers: [ProductsService, AiImageSearchService],
})
export class ProductsModule {}
