import { Body, Controller, Get, Post } from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateRegionDto } from './dto/stores.dto';
import { Roles } from '../auth/roles.decorator';

/** Regions — optional grouping for stores (area rollups). Head office only. */
@Roles('head_office')
@Controller('regions')
export class RegionsController {
  constructor(private readonly stores: StoresService) {}

  @Get()
  list() {
    return this.stores.listRegions();
  }

  @Post()
  create(@Body() dto: CreateRegionDto) {
    return this.stores.createRegion(dto);
  }
}
