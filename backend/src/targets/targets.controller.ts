import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { TargetsService } from './targets.service';
import { SetTargetDto, UpdateTargetDto } from './dto/target.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('targets')
export class TargetsController {
  constructor(private readonly targets: TargetsService) {}

  /** GET /targets?period=YYYY-MM — targets in scope for a period. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('period') period?: string,
    @StoreHeader() store?: string,
  ) {
    return this.targets.list(user, period, store);
  }

  /** GET /targets/achievement?period=YYYY-MM — whole-store target vs achieved. */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Get('achievement')
  achievement(
    @CurrentUser() user: AuthUser,
    @Query('period') period?: string,
    @StoreHeader() store?: string,
  ) {
    return this.targets.achievement(user, period, store);
  }

  /** POST /targets — set (upsert) a target. area_manager+ only. */
  @Roles('area_manager', 'head_office')
  @Post()
  set(@CurrentUser() user: AuthUser, @Body() dto: SetTargetDto) {
    return this.targets.set(user, dto);
  }

  /** PATCH /targets/:id — edit an amount. area_manager+ only. */
  @Roles('area_manager', 'head_office')
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateTargetDto) {
    return this.targets.update(user, id, dto);
  }

  /** DELETE /targets/:id — area_manager+ only. */
  @Roles('area_manager', 'head_office')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.targets.remove(user, id);
  }
}
