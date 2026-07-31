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
import { CreateProductDto } from './dto/product.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { parsePagination } from '../common/pagination';
import { Roles } from '../auth/roles.decorator';

@Controller('products')
export class ProductsController {
  constructor(
    private readonly products: ProductsService,
    private readonly aiSearch: AiImageSearchService,
  ) {}

  /** AI image search (M5): upload a design photo → ranked catalogue matches. */
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
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateProductDto) {
    return this.products.create(user, dto);
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
  @Roles('store_manager', 'area_manager', 'head_office')
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
