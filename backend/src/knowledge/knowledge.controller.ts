import { Controller, Delete, Get, Param, Post, Query, Body, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { RateLimit } from '../common/rate-limit';
import { KnowledgeService } from './knowledge.service';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.knowledge.list(user);
  }

  @Get('search')
  search(@CurrentUser() user: AuthUser, @Query('q') query = '') {
    return this.knowledge.search(user, query);
  }

  @Post()
  @Roles('store_manager', 'head_office')
  @RateLimit('expensive')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 12 * 1024 * 1024 } }))
  upload(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string },
    @Body('title') title?: string,
  ) {
    return this.knowledge.upload(user, file, title);
  }

  @Delete(':id')
  @Roles('store_manager', 'head_office')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.knowledge.remove(user, id);
  }
}
