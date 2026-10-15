import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { QuotesService } from './quotes.service';
import { QuoteApprovalService } from './quote-approval.service';
import { DecideQuoteDto, QuoteApprovalSettingsDto } from './dto/quote-approval.dto';
import {
  ConvertToOrderDto,
  CreateQuoteDto,
  ShareQuoteDto,
  QuotePhotoDto,
  SendQuotePdfDto,
  UpdateQuoteDetailsDto,
  UpdateQuoteDto,
} from './dto/quote.dto';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

@Controller('quotes')
export class QuotesController {
  constructor(
    private readonly quotes: QuotesService,
    private readonly approval: QuoteApprovalService,
  ) {}

  /** The quote book as Excel — same scope as the list; kaccha never exports. */
  @Get('export.xlsx')
  @Header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  async exportXlsx(
    @CurrentUser() user: AuthUser,
    @Res({ passthrough: true }) res: Response,
    @StoreHeader() store?: string,
  ) {
    const { buffer, rows } = await this.quotes.exportXlsx(user, store);
    res.setHeader('Content-Disposition', 'attachment; filename="quotations.xlsx"');
    res.setHeader('X-Export-Rows', String(rows));
    return new StreamableFile(buffer);
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @StoreHeader() store?: string,
    @Query('includeKaccha') includeKaccha?: string,
  ) {
    // "@" kaccha quotes stay hidden unless a head_office user explicitly opts in.
    const include = includeKaccha === 'true' || includeKaccha === '1';
    return this.quotes.list(user, store, include);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.quotes.get(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateQuoteDto) {
    return this.quotes.create(user, dto);
  }

  /** Re-price a quote. Bumps its revision, and withdraws nothing. */
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateQuoteDto) {
    return this.quotes.update(user, id, dto);
  }

  /** The customer and the payments after saving. Not the price: the revision stays put. */
  @Patch(':id/details')
  updateDetails(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateQuoteDetailsDto,
  ) {
    return this.quotes.updateDetails(user, id, dto);
  }

  /**
   * The detailed quote PDF, as bytes from an authorised route. The stored copy
   * has no URL of its own. Anyone who can open the quote can download it.
   */
  @Get(':id/pdf')
  @Header('Content-Type', 'application/pdf')
  @Header('Cache-Control', 'private, no-store')
  async pdf(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { buffer, filename } = await this.quotes.pdf(user, id);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return new StreamableFile(buffer);
  }

  /**
   * Remove a quotation (client, 9 Oct). Managers and above; a quote that
   * became an order is refused in the service.
   */
  @Roles('store_manager', 'head_office')
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.quotes.remove(user, id);
  }

  /** Queue the detailed quote PDF to the quote's own customer on WhatsApp. */
  @Post(':id/send-pdf')
  sendPdf(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: SendQuotePdfDto,
  ) {
    return this.quotes.sendPdf(user, id, dto);
  }

  /** Attach a reference / repair photo (multipart field `file`, optional `label`). Managers and above. */
  @Roles('store_manager', 'head_office')
  @Post(':id/photo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 8 * 1024 * 1024 } }))
  uploadPhoto(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @UploadedFile() file: any,
    @Body() body: QuotePhotoDto,
  ) {
    return this.quotes.addPhoto(user, id, file, body.label);
  }

  /**
   * Send this quote to its own customer on WhatsApp. Open to any role that can
   * already see the quote — the recipient comes from the record, not the caller,
   * so this is not a general-purpose "message anyone" route.
   */
  @Post(':id/share')
  share(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ShareQuoteDto,
  ) {
    return this.quotes.share(user, id, dto?.to);
  }

  /* ----------------------------------------------- approval (removed 13 Oct)
   * "A quotation once created is created — no approval from anybody." The
   * routes stay answerable so an old screen does not crash: reads report the
   * feature as off, writes answer 410 with the reason. Past decisions stay
   * readable in the audit log and on the quote's own columns.
   */

  /** Reads as switched off, for any screen still asking. */
  @Roles('store_manager', 'head_office')
  @Get('approval/settings')
  approvalSettings(@CurrentUser() user: AuthUser) {
    return this.approval.settingsFor(user.organisationId);
  }

  /** 410 — the policy no longer exists to be set. */
  @Roles('head_office')
  @Put('approval/settings')
  saveApprovalSettings(@CurrentUser() user: AuthUser, @Body() dto: QuoteApprovalSettingsDto) {
    return this.approval.saveSettings(user, dto);
  }

  /** Always empty — nothing waits on anybody. */
  @Roles('store_manager', 'head_office')
  @Get('approval/pending')
  pendingApprovals() {
    return this.approval.pending();
  }

  /** Always cleared; still 404s outside the caller's reach, like the quote. */
  @Get(':id/approval')
  async approvalState(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.quotes.get(user, id);
    return this.approval.gate(user.organisationId, id);
  }

  /** 410 after the same scope check as the quote screen. */
  @Post(':id/request-approval')
  requestApproval(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.approval.request(user, id);
  }

  /** 410 — there is nothing to decide. */
  @Roles('store_manager', 'head_office')
  @Post(':id/decide')
  decide(@Body() _dto: DecideQuoteDto) {
    return this.approval.decide();
  }

  /** Fork a custom order (timeline) from this quote and mark it accepted. */
  @Post(':id/convert-to-order')
  convertToOrder(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ConvertToOrderDto,
  ) {
    return this.quotes.convertToOrder(user, id, dto);
  }
}
