import { Body, Controller, Delete, Get, Header, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { PartyType } from '@prisma/client';
import { PartiesService } from './parties.service';
import { ArchivePartyDto, CreatePartyDto } from './dto/party.dto';
import { PartyArchiveService } from './party-archive.service';
import { Roles } from '../auth/roles.decorator';
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
  constructor(
    private readonly parties: PartiesService,
    private readonly archiveSvc: PartyArchiveService,
  ) {}

  /** The directory as Excel — same scope as the list, archived rows excluded. */
  @Get('export.xlsx')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportXlsx(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @StoreHeader() store?: string,
  ) {
    const { buffer, rows } = await this.parties.exportXlsx(user, store);
    res.setHeader('Content-Disposition', 'attachment; filename="customers.xlsx"');
    res.setHeader('X-Export-Rows', String(rows));
    return new StreamableFile(buffer);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store: string | undefined,
    @Query('q') q?: string,
    @Query('type') type?: PartyType | 'all',
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('archived') archived?: string,
    @Query('tagId') tagId?: string,
  ) {
    // New endpoint → always the paginated envelope (default page 1).
    const pagination =
      parsePagination(page ?? '1', pageSize) ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE };
    return this.parties.list(
      user,
      { q, type: type ?? 'customer', archived: archived === 'true', tagId: tagId || undefined },
      store,
      pagination,
    );
  }

  /** POST /parties — add a customer. Store scope enforced in the service. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreatePartyDto) {
    return this.parties.create(user, dto);
  }

  /**
   * Archive a contact. Manager-level: a salesperson removing customers from
   * everyone else's lists is not a floor decision.
   */
  @Roles('store_manager')
  @Post(':id/archive')
  archive(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ArchivePartyDto,
  ) {
    return this.archiveSvc.archive(user, id, dto.reason);
  }

  /**
   * Put a contact back in the working lists.
   *
   * Note this does NOT make them messageable again by itself — consent, opt-out
   * and the blacklist are separate records and are untouched.
   */
  /**
   * DELETE /parties/:id (client, 9 Oct) — only a customer with NO history: no
   * sales, money, quotes, leads, conversations, visits, schemes or returns.
   * Anyone with records is refused with the counts and pointed at Archive,
   * which hides them reversibly and keeps every number true. Head office only.
   */
  @Roles('head_office')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.parties.remove(user, id);
  }

  @Roles('store_manager')
  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.archiveSvc.restore(user, id);
  }
}
