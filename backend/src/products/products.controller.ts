import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Availability, MetalKind, ProductCategory } from '@prisma/client';
import { ProductsService } from './products.service';
import { AiImageSearchService } from './ai-image-search.service';
import { JewelrySimilarityService } from './jewelry-similarity.service';
import { CreateProductDto } from './dto/product.dto';
import { SimilarityFeedbackDto, SimilaritySearchQueryDto } from './dto/jewelry-similarity.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { parsePagination } from '../common/pagination';
import { Roles } from '../auth/roles.decorator';
import { RateLimit } from '../common/rate-limit';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly aiSearch: AiImageSearchService,
    private readonly jewelry: JewelrySimilarityService,
  ) {}

  /**
   * Jewelry visual similarity (M5): upload a photo → ranked catalogue matches via
   * dual DINOv3 + SigLIP 2 embeddings. Sales tool — salesperson and above.
   */
  @RateLimit('expensive')
  @Post('jewelry/similarity-search')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024 } }))
  similaritySearch(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @UploadedFile() file: any,
    @Query() query: SimilaritySearchQueryDto,
  ) {
    return this.jewelry.search(user, file, { category: query.category, limit: query.limit }, store);
  }

  /** Record relevance feedback on a similarity-search hit (M5 training signal). */
  @Post('jewelry/similarity-feedback')
  similarityFeedback(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @Body() dto: SimilarityFeedbackDto,
  ) {
    return this.jewelry.feedback(user, dto, store);
  }

  /** AI image search (M5): upload a design photo → ranked catalogue matches. */
  @RateLimit('expensive')
  @Post('image-search')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024 } }))
  imageSearch(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @UploadedFile() file: any,
  ) {
    return this.aiSearch.search(user, file, store);
  }

  /**
   * (Re)build dual visual embeddings (DINOv3 + SigLIP 2) for the store-scoped
   * catalogue into ProductEmbedding (M5, HO-only). Idempotent — skips unchanged
   * images/model versions. `?force=1` re-embeds everything; `?productId=` scopes
   * to a single design (single-product reindex / failed-row retry).
   */
  @Roles('head_office')
  @RateLimit('expensive')
  @Post('embeddings/reindex')
  reindexEmbeddings(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @Query('force') force?: string,
    @Query('productId') productId?: string,
  ) {
    return this.jewelry.reindex(user, store, {
      force: force === '1' || force === 'true',
      productId,
    });
  }

  /**
   * List catalogue products. Without `page`/`pageSize` returns the plain array
   * (legacy shape); with either param returns { items, total, page, pageSize }.
   */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @Query('category') category?: ProductCategory,
    @Query('metal') metal?: MetalKind,
    @Query('storeId') storeId?: string,
    @Query('availability') availability?: Availability,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.products.list(
      user,
      { category, metal, storeId, availability },
      store,
      parsePagination(page, pageSize),
    );
  }

  /** Create a catalogue product. Managers and above. */
  @Roles('store_manager', 'head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.products.create(user, dto);
  }

  /** The physical pieces of this design on hand, with real tag price + tracking. */
  @Get(':id/pieces')
  pieces(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store?: string,
  ) {
    return this.products.pieces(user, id, store);
  }

  @Get(':id')
  get(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store?: string,
  ) {
    return this.products.get(user, id, store);
  }

  /** Upload/replace a product photo (multipart field `file`). Managers and above. */
  @Roles('store_manager', 'head_office')
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    return this.products.setImage(user, id, file);
  }
}
