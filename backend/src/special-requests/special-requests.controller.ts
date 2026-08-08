import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { SpecialRequestsService } from './special-requests.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';
import {
  AddRequestMessageDto,
  CancelSpecialRequestDto,
  CreateSpecialRequestDto,
  DecideSpecialRequestDto,
  EscalateSpecialRequestDto,
  ListSpecialRequestsQueryDto,
} from './dto/special-request.dto';

/**
 * Special requests — a branch asking someone above it for a decision.
 *
 * Raising is open to any authenticated role (a salesperson at the counter is
 * often the one who needs a rate). Deciding is gated per-request by the required
 * approver role in the service, not by a blanket route guard, because the level
 * depends on what is being asked and for how much.
 */
@Controller('requests')
export class SpecialRequestsController {
  constructor(private readonly requests: SpecialRequestsService) {}

  /** GET /requests?scope=inbox|mine|open|all — store-scoped, role-aware. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListSpecialRequestsQueryDto,
    @StoreHeader() store?: string,
  ) {
    return this.requests.list(user, query, store);
  }

  /** GET /requests/:id — one request plus its message thread. */
  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.requests.get(user, id);
  }

  /** POST /requests — raise a request. The approver level is derived, not chosen. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSpecialRequestDto) {
    return this.requests.create(user, dto);
  }

  /**
   * PATCH /requests/:id/decide — approve or reject (manager+; the service also
   * checks the request's own required role and refuses self-approval).
   */
  @Roles('store_manager', 'head_office')
  @Patch(':id/decide')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecideSpecialRequestDto,
  ) {
    return this.requests.decide(user, id, dto);
  }

  /** PATCH /requests/:id/escalate — hand it to the next role up. */
  @Roles('store_manager', 'head_office')
  @Patch(':id/escalate')
  escalate(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: EscalateSpecialRequestDto,
  ) {
    return this.requests.escalate(user, id, dto);
  }

  /** PATCH /requests/:id/cancel — withdraw your own request. */
  @Patch(':id/cancel')
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: CancelSpecialRequestDto,
  ) {
    return this.requests.cancel(user, id, dto);
  }

  /** POST /requests/:id/messages — add to the thread (notifies the other side). */
  @Post(':id/messages')
  addMessage(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddRequestMessageDto,
  ) {
    return this.requests.addMessage(user, id, dto);
  }
}
