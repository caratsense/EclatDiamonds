import { Body, Controller, Get, Post } from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateRegionDto } from './dto/stores.dto';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';

/** Regions — optional grouping for stores (area rollups). Head office only. */
@Roles('head_office')
@Controller('regions')
export class RegionsController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.stores.listRegions(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateRegionDto) {
    return this.stores.createRegion(user, dto);
  }
}
