import { Body, Controller, Get, Headers, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';

import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { LeadFormsService } from './lead-forms.service';
import { LeadIntakeService } from './lead-intake.service';
import { OpenImportLeadsDto } from './dto/lead-forms.dto';
import { CreateLeadFormDto, SubmitLeadFormDto, UpdateLeadFormDto } from './dto/lead-forms.dto';

/**
 * Managing the forms. Store manager and above, because publishing a form mints a
 * key that lets anonymous callers file leads into a branch — the same weight as
 * issuing a QR poster.
 */
@Roles('store_manager')
@Controller('crm/lead-forms')
export class CrmLeadFormsController {
  constructor(private readonly forms: LeadFormsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.forms.list(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: CreateLeadFormDto) {
    return this.forms.create(user, body);
  }

  /** Also the kill switch: `{ "enabled": false }` stops the form immediately. */
  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateLeadFormDto) {
    return this.forms.update(user, id, body);
  }
}

/**
 * The public form. Anonymous, and the second write of its kind in the CRM after
 * QR capture.
 *
 * Tenant and branch come from the server-side record found by the key, never
 * from the request body, so a caller cannot choose whose CRM to write into. The
 * per-IP bound is tighter than the ordinary public category because this route
 * creates records; a honeypot field and a client-supplied submission id handle
 * the two remaining shapes of abuse (bots, and double-submits).
 */
@Public()
@RateLimit('public')
@Controller('public/lead-forms')
export class PublicLeadFormsController {
  constructor(private readonly forms: LeadFormsService) {}

  /** What the embedded page needs to render itself. Reveals no tenant detail. */
  @Get(':publicKey')
  @Throttle({ public: { limit: 30, ttl: 60_000 } })
  view(@Param('publicKey') publicKey: string) {
    return this.forms.publicView(publicKey);
  }

  @Post(':publicKey')
  @HttpCode(201)
  @Throttle({ public: { limit: 10, ttl: 60_000 } })
  submit(
    @Param('publicKey') publicKey: string,
    @Body() body: SubmitLeadFormDto,
    @Headers('origin') origin?: string,
  ) {
    return this.forms.submit(publicKey, body, origin);
  }
}

/**
 * Opening leads for an import that has already landed.
 *
 * A separate command from the import itself, and store-manager gated, because it
 * can put thousands of records into somebody's pipeline in one call.
 */
@Roles('store_manager')
@Controller('crm/import-batches')
export class CrmImportLeadsController {
  constructor(private readonly intake: LeadIntakeService) {}

  @Post(':batchId/leads')
  open(
    @CurrentUser() user: AuthUser,
    @Param('batchId') batchId: string,
    @Body() body: OpenImportLeadsDto,
  ) {
    return this.intake.openLeadsForImportBatch(user.organisationId, batchId, body);
  }
}
