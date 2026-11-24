import { Body, Controller, Delete, Get, Header, Param, Patch, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { PartyType } from '@prisma/client';
import { PartiesService } from './parties.service';
import {
  ArchivePartyDto,
  AssignPartyBranchDto,
  BulkDeletePartiesDto,
  CreatePartyDto,
  RenamePartyDto,
} from './dto/party.dto';
import { PartyArchiveService } from './party-archive.service';
import { HumansOnly } from '../auth/machine.decorator';
import { Roles } from '../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { rangeFilename } from '../common/export-range';
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

  /**
   * The directory as Excel — same scope as the list, archived rows excluded.
   *
   * `from`/`to` are the Excel dialog's range, filtering on the day the customer
   * was ADDED. That is the only date on a customer that marks an event: birthday
   * and anniversary recur every year, so a range over either would answer a
   * different question entirely ("whose birthday falls in November") and answer
   * it wrongly, since the stored year is their year of birth.
   *
   * Both absent is all time, which is what this did before the dialog existed.
   */
  @Get('export.xlsx')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportXlsx(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @StoreHeader() store?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const { buffer, rows } = await this.parties.exportXlsx(user, store, { from, to });
    const filename = from || to ? rangeFilename('customers', from, to) : 'customers.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
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
    @Query('unbranched') unbranched?: string,
  ) {
    // New endpoint → always the paginated envelope (default page 1).
    const pagination =
      parsePagination(page ?? '1', pageSize) ?? { page: 1, pageSize: DEFAULT_PAGE_SIZE };
    return this.parties.list(
      user,
      {
        q,
        type: type ?? 'customer',
        archived: archived === 'true',
        tagId: tagId || undefined,
        // Head office's "no branch yet" queue. Anyone else asking for it gets
        // an empty list, because their scope holds no unbranched customer.
        unbranched: unbranched === 'true',
      },
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
  /**
   * POST /parties/:id/deletion-request — ask for a customer to be removed.
   *
   * Deliberately open to a salesperson, which the `DELETE` below is not: the
   * point of the client's ask (16 Nov) is that the floor CAN start this and
   * somebody above them finishes it. Routing is the approvals ladder's, so a
   * salesperson's request lands on their manager and a manager's on head
   * office.
   */
  @Post(':id/deletion-request')
  requestDeletion(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ArchivePartyDto,
  ) {
    return this.parties.requestDeletion(user, id, dto.reason);
  }

  /**
   * Delete the customers somebody ticked. Head office only and rule-for-rule
   * identical to the single `DELETE` below — a Gati-synced customer or one with
   * any history is reported back as skipped, with the reason, rather than being
   * forced through.
   *
   * POST rather than `DELETE` with a body: the ids are the request, and bodies
   * on DELETE are the kind of thing a proxy drops without telling anybody.
   *
   * `@HumansOnly()` because the Gati agent carries head-office reach by design.
   * One customer at a time is a repair; two hundred in one call is the request
   * no token sitting on a shop machine should be able to make.
   */
  @HumansOnly()
  @Roles('head_office')
  @Post('bulk-delete')
  removeMany(@CurrentUser() user: AuthUser, @Body() dto: BulkDeletePartiesDto) {
    return this.parties.removeMany(user, dto.ids);
  }

  @Roles('head_office')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.parties.remove(user, id);
  }

  /**
   * Rename a customer (client, 19 Nov) — the Meta-identified ones whose names
   * are hearts and symbols. Manager-level, like archiving: the name is what
   * every colleague's list, export and campaign will show, not a private note.
   */
  @Roles('store_manager')
  @Patch(':id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: RenamePartyDto,
  ) {
    return this.parties.rename(user, id, dto.name);
  }

  /**
   * Give a customer a branch, or move them to another one (client, 23 Nov):
   * "people who have no branch should be visible only to head office, from
   * where they could be reassigned."
   *
   * Head office only, and `@HumansOnly()` for the same reason bulk delete is:
   * the branch a customer belongs to decides whose list and whose campaign
   * audience they land in, and the Gati agent carries head-office reach by
   * design. Moving customers between shops is not a decision for a token
   * sitting on a shop machine.
   */
  @HumansOnly()
  @Roles('head_office')
  @Post(':id/branch')
  assignBranch(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AssignPartyBranchDto,
  ) {
    return this.parties.assignBranch(user, id, dto.storeId);
  }

  @Roles('store_manager')
  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.archiveSvc.restore(user, id);
  }
}
