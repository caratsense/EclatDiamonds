import { Controller, Get, Query } from '@nestjs/common';
import { AuditReadService } from './audit-read.service';
import { CurrentUser, AuthUser } from '../common/auth-user';
import { StoreHeader } from '../common/store-header.decorator';
import { Roles } from '../auth/roles.decorator';

/** Audit-trail read surface — area_manager & head_office only. */
@Roles('store_manager', 'head_office')
@Controller('audit')
export class AuditController {
  constructor(private readonly audit: AuditReadService) {}

  /** GET /audit — filtered, paginated audit log (newest first), store-scoped. */
  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @StoreHeader() store?: string,
  ) {
    return this.audit.list(user, { entityType, entityId, action, from, to, page, pageSize }, store);
  }
}
