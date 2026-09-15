import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { Permit } from '../../auth/permissions';
import { FileInterceptor } from '@nestjs/platform-express';

import { AllowMachine } from '../../auth/machine.decorator';
import { Roles } from '../../auth/roles.decorator';
import { AuthUser, CurrentUser } from '../../common/auth-user';
import { RateLimit } from '../../common/rate-limit';
import { parseMappings } from './import.controller';
import { MappingProfilesService } from './mapping-profiles.service';
import {
  ImageZipService,
  MATCH_BY,
  MAX_ZIP_BYTES,
  type ImageZipOptions,
  type MatchBy,
} from './image-zip.service';

/**
 * Saved column mappings.
 *
 * A separate prefix from `/imports` on purpose: `ImportController` routes
 * `:entity/preview` and `:entity/run`, so anything mounted under `/imports` with
 * two path segments would be decided by whichever controller Nest registered
 * first. Two explicit prefixes are worth more than one tidy-looking tree that
 * breaks the day somebody reorders a module.
 */
@Roles('store_manager', 'head_office')
@Controller('import-mappings')
export class ImportMappingsController {
  constructor(private readonly profiles: MappingProfilesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('entity') entity?: string) {
    return this.profiles.list(user, entity || undefined);
  }

  @Post()
  save(
    @CurrentUser() user: AuthUser,
    @Body('name') name: string,
    @Body('entity') entity: string,
    @Body('mappings') mappings: unknown,
    @Body('sourceHeaders') sourceHeaders?: unknown,
  ) {
    if (typeof name !== 'string' || typeof entity !== 'string') {
      throw new BadRequestException('A saved mapping needs a name and an entity.');
    }
    return this.profiles.save(user, {
      name,
      entity,
      mappings: parseMappings(mappings),
      sourceHeaders: Array.isArray(sourceHeaders)
        ? sourceHeaders.filter((h): h is string => typeof h === 'string')
        : undefined,
    });
  }

  /**
   * Fit a saved mapping to the columns of the file in hand.
   *
   * Takes the HEADERS, not the file: discovery has already read them, and
   * re-uploading a 40MB workbook to answer "does my saved mapping still fit"
   * would be the slowest possible way to ask.
   */
  @Post(':id/apply')
  apply(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body('headers') headers: unknown,
  ) {
    if (!Array.isArray(headers) || headers.some((h) => typeof h !== 'string')) {
      throw new BadRequestException('`headers` must be the file’s column names.');
    }
    return this.profiles.apply(user, id, headers as string[]);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.profiles.remove(user, id);
  }
}

/** A ZIP of images is bigger than a spreadsheet, and has its own ceiling. */
const ZIP_UPLOAD_OPTIONS = {
  limits: {
    fileSize: MAX_ZIP_BYTES,
    files: 1,
    fields: 8,
    parts: 9,
    fieldNameSize: 128,
    fieldSize: 4 * 1024,
    headerPairs: 100,
  },
};

function parseOptions(body: Record<string, unknown>): ImageZipOptions {
  const matchBy = String(body.matchBy ?? 'sku');
  if (!(MATCH_BY as string[]).includes(matchBy)) {
    throw new BadRequestException(`matchBy must be one of: ${MATCH_BY.join(', ')}.`);
  }
  const str = (v: unknown, max = 40) => {
    if (v == null || v === '') return undefined;
    const s = String(v);
    if (s.length > max) throw new BadRequestException('That prefix or suffix is too long.');
    return s;
  };
  // Multipart bodies are strings, so "false" arrives as a truthy value unless
  // it is compared rather than coerced.
  const bool = (v: unknown) => v === true || v === 'true' || v === '1';
  return {
    matchBy: matchBy as MatchBy,
    stripPrefix: str(body.stripPrefix),
    stripSuffix: str(body.stripSuffix),
    stripNumericSuffix: bool(body.stripNumericSuffix),
    storeId: str(body.storeId, 64),
    overwriteExisting: bool(body.overwriteExisting),
  };
}

/**
 * Product photographs, a folder at a time.
 *
 * Preview then run, like every other import here: nothing reaches storage or the
 * catalogue until somebody has seen which files matched which products and which
 * did not match anything.
 */
@Roles('store_manager', 'head_office')
// Decompressing and uploading thousands of images is costed in CPU and network,
// so the limit is keyed on the USER — one person's archive must not lock out
// their colleagues.
@RateLimit('expensive')
@Controller('import-images')
export class ImportImagesController {
  constructor(private readonly images: ImageZipService) {}

  /** Dry run: every entry's fate, nothing written. */
  @Permit('catalogue.images')
  @Post('preview')
  @AllowMachine()
  @UseInterceptors(FileInterceptor('file', ZIP_UPLOAD_OPTIONS))
  preview(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: { buffer?: Buffer },
    @Body() body: Record<string, unknown>,
  ) {
    return this.images.preview(user, file, parseOptions(body));
  }

  @Permit('catalogue.images')
  @Post('run')
  @AllowMachine()
  @UseInterceptors(FileInterceptor('file', ZIP_UPLOAD_OPTIONS))
  run(
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: { buffer?: Buffer },
    @Body() body: Record<string, unknown>,
  ) {
    return this.images.run(user, file, parseOptions(body));
  }
}
