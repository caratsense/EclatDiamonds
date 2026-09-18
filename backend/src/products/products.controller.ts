import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import { Permit } from '../auth/permissions';
import {
  FileFieldsInterceptor,
  FileInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import { ProductsService, parseProductFilters } from './products.service';
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
   * Jewelry visual similarity (M5): photograph a piece → ranked catalogue
   * matches via dual DINOv2 + SigLIP 2 embeddings. Salesperson and above.
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
    @Res({ passthrough: true }) res: Response,
  ) {
    const shots = [...(uploaded?.file ?? []), ...(uploaded?.files ?? [])];
    // `res` only receives Server-Timing, and Retry-After on a 429.
    return this.jewelry.search(
      user,
      shots,
      { category: query.category, limit: query.limit },
      store,
      res,
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
   * Queue the store-scoped catalogue's pictures for DINOv2 + SigLIP 2
   * embedding (M5, HO-only) and return at once — the durable job queue does
   * the work. Only pictures not indexed at the current model/pipeline version
   * are queued; `?force=1` queues them all (also retries dead ones);
   * `?productId=` scopes to one design. `background` is accepted and ignored:
   * every rebuild is in the background now.
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
    return this.jewelry.startReindex(user, store, { force: force === '1' || force === 'true', productId });
  }

  /** Index progress: counts by picture status, plus search latency p50/p95. */
  @Roles('head_office')
  @Get('embeddings/reindex')
  reindexStatus(@CurrentUser() user: AuthUser) {
    return this.jewelry.reindexStatus(user);
  }

  /**
   * List catalogue products. Without `page`/`pageSize` returns the plain array
   * (legacy shape); with either param returns { items, total, page, pageSize }.
   * Filters (all optional, validated in parseProductFilters): q, category,
   * subCategory, size, karat, colour, metal, priceMin, priceMax, storeId,
   * availability, source, imageCoverage.
   */
  @Permit('catalogue.read')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @Query() query: Record<string, string | undefined>,
  ) {
    return this.products.list(
      user,
      parseProductFilters(query),
      store,
      parsePagination(query.page, query.pageSize),
    );
  }

  /**
   * Everything about one design for the detail dialog (lazy). Cost fields are
   * stripped by role inside the service — see ProductsService.full.
   */
  @Permit('catalogue.read')
  @Get(':id/full')
  full(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @StoreHeader() store?: string,
  ) {
    return this.products.full(user, id, store);
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
    // Indexing is queued durably inside the service (CatalogueIndexService).
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

  /** Pin one photo as the design’s cover (outranks the CAD-first default). */
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

  /** Unpin: the cover returns to the default order (CAD first). */
  @Roles('store_manager', 'head_office')
  @Permit('catalogue.images')
  @Delete(':id/images/:imageId/primary')
  unpinPrimaryImage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.products.unpinPrimaryImage(user, id, imageId);
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
    // The service drops the photo's vectors in the same transaction.
    return this.products.deleteImage(user, id, imageId);
  }
}
