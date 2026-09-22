import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { Roles } from '../auth/roles.decorator';
import { MaterialsService } from './materials.service';
import { ImportMaterialsDto } from './dto/materials.dto';

/** The item master behind the quote builder (screen: quotation). */
@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Get()
  master(@CurrentUser() user: AuthUser) {
    return this.materials.master(user);
  }

  @Get('styles')
  searchStyles(@CurrentUser() user: AuthUser, @Query('q') q = '') {
    return this.materials.searchStyles(user, q);
  }

  @Get('styles/:code')
  style(@CurrentUser() user: AuthUser, @Param('code') code: string) {
    return this.materials.style(user, code);
  }

  /** Load or refresh the master from the ERP export. Head office only. */
  @Roles('head_office')
  @Put()
  import(@CurrentUser() user: AuthUser, @Body() dto: ImportMaterialsDto) {
    return this.materials.import(user, dto);
  }
}
