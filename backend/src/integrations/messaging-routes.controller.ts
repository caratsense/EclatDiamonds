import { Body, Controller, Delete, Get, Param, Put, Query } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';

import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import {
  MessagingRoutesService,
  ROUTABLE_CHANNELS,
  RoutableChannel,
} from './messaging-routes.service';

export class SetMessagingRouteDto {
  @IsString()
  assetId!: string;

  @IsOptional()
  @IsIn(ROUTABLE_CHANNELS as unknown as string[])
  channel?: RoutableChannel;
}

/**
 * Which number each branch sends from.
 *
 * A separate path from `/integrations` because that controller is the webhook
 * door and carries the machine-sized rate bucket; this is a settings screen for
 * people, and `@HumansOnly()` says so — a Connect agent has no business changing
 * who a branch appears to be.
 *
 * Head office only. A store manager mapping their own branch onto a different
 * number would change which business a customer sees answering them, and the
 * number probably belongs to another branch.
 */
@HumansOnly()
@Roles('head_office')
@Controller('messaging-routes')
export class MessagingRoutesController {
  constructor(private readonly routes: MessagingRoutesService) {}

  /** Numbers, branches and mappings together — see the service for why. */
  @Get()
  overview(@CurrentUser() user: AuthUser, @Query('channel') channel?: RoutableChannel) {
    return this.routes.overview(user, channel ?? 'whatsapp');
  }

  @Put(':storeId')
  set(
    @CurrentUser() user: AuthUser,
    @Param('storeId') storeId: string,
    @Body() dto: SetMessagingRouteDto,
  ) {
    return this.routes.set(user, { storeId, assetId: dto.assetId, channel: dto.channel });
  }

  @Delete(':storeId')
  clear(
    @CurrentUser() user: AuthUser,
    @Param('storeId') storeId: string,
    @Query('channel') channel?: RoutableChannel,
  ) {
    return this.routes.clear(user, storeId, channel ?? 'whatsapp');
  }
}
