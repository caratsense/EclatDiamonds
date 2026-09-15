import {
  Body,
  Controller,
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
  QuotePhotoDto,
  SendQuotePdfDto,
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

  /** Re-price a quote. Bumps its revision and withdraws any approval. */
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateQuoteDto) {
    return this.quotes.update(user, id, dto);
  }

  /**
   * The detailed quote PDF, as bytes from an authorised route. The stored copy
   * has no URL of its own. Refused (403) until any required approval exists.
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
  share(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.quotes.share(user, id);
  }

  /* ------------------------------------------------------------ approval */

  /** The tenant's rule: above what amount does a quote need signing off. */
  @Roles('store_manager', 'head_office')
  @Get('approval/settings')
  approvalSettings(@CurrentUser() user: AuthUser) {
    return this.approval.settingsFor(user.organisationId);
  }

  @Roles('head_office')
  @Put('approval/settings')
  saveApprovalSettings(@CurrentUser() user: AuthUser, @Body() dto: QuoteApprovalSettingsDto) {
    return this.approval.saveSettings(user, dto);
  }

  /** Quotes waiting on a decision, scoped to what this manager can see. */
  @Roles('store_manager', 'head_office')
  @Get('approval/pending')
  pendingApprovals(@CurrentUser() user: AuthUser) {
    return this.approval.pending(user);
  }

  /**
   * Whether this quote may be sent, without trying to send it — so the screen
   * can show the state rather than discovering it through an error.
   */
  @Get(':id/approval')
  async approvalState(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    // Reached through the same lookup as the quote itself: store, kaccha and
    // (for a salesperson) assignment. This read any quote in the organisation
    // by id, total and discount reasons included.
    await this.quotes.get(user, id);
    return this.approval.gate(user.organisationId, id);
  }

  /** A salesperson asks for a decision. */
  @Post(':id/request-approval')
  requestApproval(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.approval.request(user, id);
  }

  /** A manager decides. Rejecting requires a reason. */
  @Roles('store_manager', 'head_office')
  @Post(':id/decide')
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: DecideQuoteDto,
  ) {
    return this.approval.decide(user, id, dto.approve, dto.reason, dto.revision);
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
