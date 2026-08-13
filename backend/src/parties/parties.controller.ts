import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { PartyType } from '@prisma/client';
import { PartiesService } from './parties.service';
import { CreatePartyDto } from './dto/party.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { parsePagination, DEFAULT_PAGE_SIZE } from '../common/pagination';

/**
 * Party directory (GET /parties) — the customer list screen. Store-scoped,
 * paginated, searchable. Defaults to `type=customer`; pass `type=all|supplier|
 * staff|…` to widen. Visible to every role — a salesperson only ever sees their
 * own store's parties (scope applied server-side).
 */
@Controller('parties')
export class PartiesController {
  constructor(private readonly parties: PartiesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @Query('q') q?: string,
    @Query('type') type?: PartyType | 'all',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    // New endpoint → always the paginated envelope (default page 1).
    const pagination =
      parsePagination(page ?? '1', pageSize) ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE };
    return this.parties.list(user, { q, type: type ?? 'customer' }, store, pagination);
  }

  /** POST /parties — add a customer. Store scope enforced in the service. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePartyDto) {
    return this.parties.create(user, dto);
  }
}
