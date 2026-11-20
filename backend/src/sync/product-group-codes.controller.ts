import { Body, Controller, Get, Post } from '@nestjs/common';
import { IsArray } from 'class-validator';

import { Roles } from '../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../common/auth-user';
import { GROUP_CATEGORIES, ProductGroupCode } from './product-group-codes';
import { ProductGroupCodesService } from './product-group-codes.service';

export class SaveProductGroupCodesDto {
  /**
   * The whole list, not a change to it.
   *
   * Validated by `normaliseGroupCodes` rather than by decorators on a nested
   * class: the same reading has to run when the stored bag is read back years
   * later, and one rule that both paths share cannot drift from itself.
   */
  @IsArray()
  codes!: ProductGroupCode[];
}

/**
 * Head office's reading of the product-group codes in Gati's design codes.
 *
 * Head office only, in both directions. The list decides how the whole
 * catalogue files itself, and the counts beside it are an inventory summary;
 * neither belongs to a branch. `settings/product-groups` is in
 * HEAD_OFFICE_DELEGABLE, so the owner can still hand the screen — and with it
 * these routes — to the merchandiser who actually knows the codes.
 */
@Controller('product-groups')
export class ProductGroupCodesController {
  constructor(private readonly codes: ProductGroupCodesService) {}

  @Roles('head_office')
  @Get()
  async read(@CurrentUser() user: AuthUser) {
    const [codes, usage] = await Promise.all([
      this.codes.list(user.organisationId),
      this.codes.usage(user.organisationId),
    ]);
    return { codes, usage, categories: GROUP_CATEGORIES };
  }

  @Roles('head_office')
  @Post()
  save(@CurrentUser() user: AuthUser, @Body() body: SaveProductGroupCodesDto) {
    return this.codes.replace(user, body.codes);
  }
}
