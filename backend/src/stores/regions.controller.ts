import { Body, Controller, Get, Post } from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateRegionDto } from './dto/stores.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';

/** Regions — org-scoped options for branch setup and area rollups. */
@Controller('regions')
export class RegionsController {
  constructor(private readonly stores: StoresService) {}

  /** Managers editing an assigned branch need the read-only region picker. */
  @Roles('head_office', 'area_manager', 'store_manager')
  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.stores.listRegions(user);
  }

  /** Only head office may change the organisation's region master. */
  @Roles('head_office')
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRegionDto) {
    return this.stores.createRegion(user, dto);
  }
}
