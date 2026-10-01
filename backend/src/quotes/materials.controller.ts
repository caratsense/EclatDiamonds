import { Body, Controller, Get, Param, Post, Put, Query } from '@nestjs/common';
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

  /**
   * Rebuild the master from the mirrored Gati tables now, rather than waiting
   * for the hourly run. Head office only. `{ synced: false }` when the mirror
   * does not hold Gati's item table yet.
   */
  @Roles('head_office')
  @Post('refresh-from-gati')
  async refreshFromGati(@CurrentUser() user: AuthUser) {
    const result = await this.materials.refreshFromGati(user.organisationId);
    return result ? { synced: true, ...result } : { synced: false };
  }

  /** Load or refresh the master from the ERP export. Head office only. */
  @Roles('head_office')
  @Put()
  import(@CurrentUser() user: AuthUser, @Body() dto: ImportMaterialsDto) {
    return this.materials.import(user, dto);
  }
}
