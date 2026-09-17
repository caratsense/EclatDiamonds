import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { Permit } from '../auth/permissions';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
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
  @Permit('catalogue.read')
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
  @Permit('catalogue.read')
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
  @Permit('catalogue.read')
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
  @Permit('catalogue.read')
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
  @Permit('catalogue.read')
  @Get(':id/pieces')
  pieces(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store?: string,
  ) {
    return this.products.pieces(user, id, store);
  }

  @Permit('catalogue.read')
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
  @Permit('catalogue.images')
  @Post(':id/image')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    return this.products.setImage(user, id, file);
  }

  /** Every photograph of a design, cover first. */
  @Permit('catalogue.read')
  @Get(':id/images')
  listImages(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.products.listImages(user, id);
  }

  /**
   * Add photographs of a design (multipart field `files`, up to 10).
   *
   * Ten at a time because the pictures are taken in one go at the counter, and
   * a round trip per angle over a shop’s wifi is how people give up and upload
   * one. Optional `angles` (repeated field, positional) labels each view.
   */
  @Roles('store_manager', 'head_office')
  @Permit('catalogue.images')
  @Post(':id/images')
  @UseInterceptors(FilesInterceptor('files', 10, { limits: { fileSize: 12 * 1024 * 1024 } }))
  addImages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFiles() files: any[],
    @Body('angles') angles?: string | string[],
  ) {
    // One repeated multipart field arrives as a string, several as an array.
    const list = angles == null ? undefined : Array.isArray(angles) ? angles : [angles];
    return this.products.addImages(user, id, files, list);
  }

  /** Make one photo the design’s cover. */
  @Roles('store_manager', 'head_office')
  @Permit('catalogue.images')
  @Post(':id/images/:imageId/primary')
  setPrimaryImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.products.setPrimaryImage(user, id, imageId);
  }

  /** Remove one photo; the cover is re-elected if it was the one removed. */
  @Roles('store_manager', 'head_office')
  @Permit('catalogue.images')
  @Delete(':id/images/:imageId')
  deleteImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.products.deleteImage(user, id, imageId);
  }
}
