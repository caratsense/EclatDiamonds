import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { QuotesService } from './quotes.service';
import { ConvertToOrderDto, CreateQuoteDto, QuotePhotoDto } from './dto/quote.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('quotes')
export class QuotesController {
  constructor(private readonly quotes: QuotesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.quotes.list(user, store);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.quotes.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateQuoteDto) {
    return this.quotes.create(user, dto);
  }

  /** Attach a reference / repair photo (multipart field `file`, optional `label`). Managers and above. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadPhoto(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body() body: QuotePhotoDto,
  ) {
    return this.quotes.addPhoto(user, id, file, body.label);
  }

  /** Fork a custom order (timeline) from this quote and mark it accepted. */
  @Post(':id/convert-to-order')
  convertToOrder(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConvertToOrderDto,
  ) {
    return this.quotes.convertToOrder(user, id, dto);
  }
}
