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
import { SalesService } from './sales.service';
import { CreateSaleDto, SalesQueryDto } from './dto/sales.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('sales')
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  /** GET /sales?scope=manual|all — store-scoped direct-sales list (default manual). */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: SalesQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.sales.list(user, query, store);
  }

  /** POST /sales — record a manual direct sale with advance payment folded in. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSaleDto) {
    return this.sales.create(user, dto);
  }

  /** GET /sales/:id — one sale plus its payments. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.sales.get(user, id);
  }

  /** POST /sales/:id/quotation — upload the quotation photo (multipart `file`). Managers+. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post(':id/quotation')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadQuotation(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    return this.sales.setQuotation(user, id, file);
  }

  /** POST /sales/:id/invoice — upload the invoice photo (multipart `file`). Managers+. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post(':id/invoice')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadInvoice(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    return this.sales.setInvoice(user, id, file);
  }

  /** POST /sales/:id/receipt — upload the receipt photo (multipart `file`). Managers+. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post(':id/receipt')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadReceipt(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
  ) {
    return this.sales.setReceipt(user, id, file);
  }
}
