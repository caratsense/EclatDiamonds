import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CheckinsService } from './checkins.service';
import { CheckoutDto, CreateCheckInDto } from './dto/checkin.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';

@Controller('checkins')
export class CheckinsController {
  constructor(private readonly checkins: CheckinsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.checkins.list(user, store);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCheckInDto) {
    return this.checkins.create(user, dto);
  }

  @Patch(':id')
  checkout(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CheckoutDto,
    @StoreHeader() store?: string,
  ) {
    return this.checkins.checkout(user, id, store, dto);
  }
}
