import { Body, Controller, Get, Param, Post, StreamableFile } from '@nestjs/common';
import { Availability, ProductCategory, StockClass } from '@prisma/client';
import { IsBoolean, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { CatalogueExportService } from './catalogue-export.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateCatalogueExportDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  storeId?: string;

  @IsOptional()
  @IsIn(Object.values(ProductCategory))
  category?: ProductCategory;

  /** Style Number or SKU. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string;

  @IsOptional()
  @Matches(DAY, { message: 'updatedFrom must be a date (YYYY-MM-DD)' })
  updatedFrom?: string;

  @IsOptional()
  @Matches(DAY, { message: 'updatedTo must be a date (YYYY-MM-DD)' })
  updatedTo?: string;

  /** The product's status in the catalogue. */
  @IsOptional()
  @IsIn(Object.values(Availability))
  availability?: Availability;

  @IsOptional()
  @IsIn(Object.values(StockClass))
  stockClass?: StockClass;

  /** Mail it to the requester when it is ready. Never to an address from the form. */
  @IsOptional()
  @IsBoolean()
  emailMe?: boolean;
}

/**
 * The catalogue's photographs, as one archive, for head office.
 *
 * Head office only: this is every product photograph the business owns leaving
 * the system in one file. A branch manager has the catalogue screen.
 */
@HumansOnly()
@Roles('head_office')
@Controller('catalogue-exports')
export class CatalogueExportController {
  constructor(private readonly exports: CatalogueExportService) {}

  /** Queue an export. Refused up front when the filters already exceed the limit. */
  @RateLimit('expensive')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCatalogueExportDto) {
    return this.exports.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.exports.list(user);
  }

  /** Status, and every skipped photograph with the reason. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.exports.get(user, id);
  }

  @Get(':id/download')
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<StreamableFile> {
    const file = await this.exports.download(user, id);
    // Streamed from disk; an archive of a few hundred megabytes is never held.
    return new StreamableFile(file.stream, {
      type: 'application/zip',
      disposition: `attachment; filename="${file.filename}"`,
      length: file.size,
    });
  }
}
