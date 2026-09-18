import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { Permit } from '../auth/permissions';
import {
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
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
  private readonly logger = new Logger(ProductsController.name);

  constructor(
    private readonly products: ProductsService,
    private readonly aiSearch: AiImageSearchService,
    private readonly jewelry: JewelrySimilarityService,
  ) {}

  /**
   * Re-index one design after its photographs change, without making the
   * caller wait for it.
   *
   * Visual search only ever sees what is in ProductEmbedding, so a photo that
   * is stored but not embedded is a photo the catalogue cannot be searched by.
   * Leaving that to a manual head-office call meant the salesperson who took
   * the picture had no way to make it count, and the feature looked broken to
   * the only person using it.
   *
   * Deliberately not awaited. The inference service is allowed to be asleep and
   * a cold start runs to three minutes while two vision models load; blocking
   * an upload at the counter on that would be worse than the wait for search.
   * The upload is already durable by this point — the worst case is a photo
   * that is visible but not yet searchable, which the next re-index fixes.
   * Scoped to the one design, so it costs one embedding call, not a rebuild.
   */
  private indexAfterPhotoChange(user: AuthUser, store: string | undefined, productId: string) {
    void this.jewelry
      .reindex(user, store, { productId })
      .then((r) =>
        this.logger.log(
          `auto-index ${productId}: ${r.embedded ?? 0} embedded, ${r.skipped ?? 0} skipped, ` +
            `${r.failed ?? 0} failed, ${(r as { pruned?: number }).pruned ?? 0} pruned`,
        ),
      )
      .catch((err) =>
        this.logger.warn(
          `auto-index ${productId} failed: ${err instanceof Error ? err.message : err}`,
        ),
      );
  }

  /**
   * Jewelry visual similarity (M5): photograph a piece → ranked catalogue
   * matches via dual DINOv3 + SigLIP 2 embeddings. Salesperson and above.
   *
   * Takes one photo as `file`, or up to three as repeated `files` — the same
   * piece from several sides. A ring in the hand and a ring in the catalogue
   * are each only ever photographed from somewhere, and one of each is a single
   * guess at which two views happen to correspond. Both field names are
   * accepted so existing callers keep working unchanged.
   */
  @RateLimit('expensive')
  @Permit('catalogue.read')
  @Post('jewelry/similarity-search')
  @UseInterceptors(
    FileFieldsInterceptor(
      [{ name: 'file', maxCount: 1 }, { name: 'files', maxCount: 3 }],
      { limits: { fileSize: 12 * 1024 * 1024 } },
    ),
  )
  similaritySearch(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @UploadedFiles() uploaded: { file?: any[]; files?: any[] },
    @Query() query: SimilaritySearchQueryDto,
  ) {
    const shots = [...(uploaded?.file ?? []), ...(uploaded?.files ?? [])];
    return this.jewelry.search(
      user,
      shots,
      { category: query.category, limit: query.limit },
      store,
    );
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
    @Query('background') background?: string,
  ) {
    const opts = { force: force === '1' || force === 'true', productId };
    // The whole catalogue outlasts any request; `background=1` starts it and
    // returns, and GET below reports progress.
    if (background === '1' && !productId) return this.jewelry.startReindex(user, store, opts);
    return this.jewelry.reindex(user, store, opts);
  }

  /** The catalogue-wide background re-index: running, progress, last outcome. */
  @Roles('head_office')
  @Get('embeddings/reindex')
  reindexStatus(@CurrentUser() user: AuthUser) {
    return this.jewelry.reindexStatus(user);
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
    @Query('q') q?: string,
    @Query('category') category?: ProductCategory,
    @Query('metal') metal?: MetalKind,
    @Query('storeId') storeId?: string,
    @Query('availability') availability?: Availability,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.products.list(
      user,
      { q, category, metal, storeId, availability },
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
  async uploadImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store: string | undefined,
    @UploadedFile() file: any,
  ) {
    const updated = await this.products.setImage(user, id, file);
    this.indexAfterPhotoChange(user, store, id);
    return updated;
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
  async addImages(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store: string | undefined,
    @UploadedFiles() files: any[],
    @Body('angles') angles?: string | string[],
  ) {
    // One repeated multipart field arrives as a string, several as an array.
    const list = angles == null ? undefined : Array.isArray(angles) ? angles : [angles];
    const gallery = await this.products.addImages(user, id, files, list);
    this.indexAfterPhotoChange(user, store, id);
    return gallery;
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
  async deleteImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
    @StoreHeader() store?: string,
  ) {
    const gallery = await this.products.deleteImage(user, id, imageId);
    // Prunes the deleted photo’s vector. A stale one is worse than a missing
    // one: the design keeps matching searches for a picture that is gone.
    this.indexAfterPhotoChange(user, store, id);
    return gallery;
  }
}
