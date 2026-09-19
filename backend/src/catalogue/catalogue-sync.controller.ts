import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { WebsiteCatalogueService } from './website/website-catalogue.service';
import { ListConflictsQuery, SetWebsiteCredentialDto, StartWebsiteSyncDto, UpdateConflictDto } from './website/website.dto';

/**
 * Head office's catalogue-sources board: connection health, sync runs and their
 * receipts, the conflict review queue, and the write-only website credential.
 */
@Roles('head_office')
@Controller('catalogue-integration')
export class CatalogueSyncController {
  constructor(private readonly website: WebsiteCatalogueService) {}

  @Get('health')
  health(@CurrentUser() user: AuthUser) {
    return this.website.health(user.organisationId);
  }

  /** Write-only. The token is encrypted at once and never echoed, not even in part. */
  @Post('website/credential')
  setCredential(@CurrentUser() user: AuthUser, @Body() body: SetWebsiteCredentialDto) {
    return this.website.setCredential(user, body.token, body.baseUrl);
  }

  /** A read-only probe of the saved address: page 1, one product. Starts no sync, writes no catalogue row. */
  @Post('website/test')
  test(@CurrentUser() user: AuthUser) {
    return this.website.testConnection(user);
  }

  @Post('website/sync')
  sync(@CurrentUser() user: AuthUser, @Body() body: StartWebsiteSyncDto) {
    return this.website.requestSync(user, body.mode, body.dryRun ?? false);
  }

  @Get('runs')
  runs(@CurrentUser() user: AuthUser) {
    return this.website.listRuns(user.organisationId);
  }

  @Get('conflicts')
  conflicts(@CurrentUser() user: AuthUser, @Query() q: ListConflictsQuery) {
    return this.website.listConflicts(user.organisationId, q.status ?? 'open', q.kind);
  }

  @Patch('conflicts/:id')
  updateConflict(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: UpdateConflictDto) {
    return this.website.updateConflict(user, id, body.status, body.resolution);
  }
}
