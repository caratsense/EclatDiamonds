import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { TicketingService } from './ticketing.service';
import {
  CreateTicketDto,
  CreateTicketMessageDto,
  UpdateTicketDto,
} from './dto/ticket.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';

@Controller('tickets')
export class TicketingController {
  constructor(private readonly ticketing: TicketingService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @StoreHeader() store?: string) {
    return this.ticketing.list(user, store);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.ticketing.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTicketDto) {
    return this.ticketing.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.ticketing.update(user, id, dto);
  }

  @Post(':id/messages')
  addMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CreateTicketMessageDto,
  ) {
    return this.ticketing.addMessage(user, id, dto);
  }
}
