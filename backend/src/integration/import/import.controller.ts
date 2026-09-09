import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../../auth/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/auth-user';
import {
  FieldMappingInput,
  ImportService,
  MAX_IMPORT_MAPPING_NAME_CHARACTERS,
} from './import.service';
import { RateLimit } from '../../common/rate-limit';
import { AllowMachine } from '../../auth/machine.decorator';
import { MAX_IMPORT_COLUMNS } from './csv.util';

/**
 * CaratOS import endpoints (Phase 3). Onboarding is a management action, so the
 * whole controller is store_manager+ (head_office inherits). Organisation is taken
 * from the authenticated user inside the service — never from the request.
 *
 * Flow: POST discover (file) → POST preview (file + mappings) → POST run
 * (file + mappings [+ storeId]) → GET / (history). The file is re-uploaded at
 * each step so the server holds no cross-request state.
 */
export const IMPORT_UPLOAD_OPTIONS = {
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1,
    fields: 12,
    parts: 13,
    fieldNameSize: 128,
    fieldSize: 256 * 1024,
    headerPairs: 100,
  },
};

const MAX_MAPPING_JSON_CHARACTERS = 128 * 1024;

export function parseMappings(raw: unknown): FieldMappingInput[] {
  if (raw == null || raw === '') return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    if (raw.length > MAX_MAPPING_JSON_CHARACTERS) {
      throw new BadRequestException('`mappings` is too large');
    }
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('`mappings` must be valid JSON');
    }
  }
  if (!Array.isArray(parsed)) throw new BadRequestException('`mappings` must be an array');
  if (parsed.length > MAX_IMPORT_COLUMNS) {
    throw new BadRequestException(
      `Import mappings may contain at most ${MAX_IMPORT_COLUMNS} entries.`,
    );
  }
  for (const mapping of parsed) {
    if (
      !mapping ||
      typeof mapping !== 'object' ||
      typeof (mapping as Record<string, unknown>).sourceColumn !== 'string' ||
      typeof (mapping as Record<string, unknown>).canonicalField !== 'string'
    ) {
      throw new BadRequestException(
        'Every mapping must contain string sourceColumn and canonicalField values.',
      );
    }
    const { sourceColumn, canonicalField } = mapping as unknown as FieldMappingInput;
    if (
      sourceColumn.length > MAX_IMPORT_MAPPING_NAME_CHARACTERS ||
      canonicalField.length > MAX_IMPORT_MAPPING_NAME_CHARACTERS ||
      /[\u0000-\u001F\u007F]/.test(sourceColumn) ||
      /[\u0000-\u001F\u007F]/.test(canonicalField)
    ) {
      throw new BadRequestException(
        `Mapping names may contain at most ${MAX_IMPORT_MAPPING_NAME_CHARACTERS} characters and no control characters.`,
      );
    }
  }
  return parsed as FieldMappingInput[];
}

@Roles('store_manager', 'head_office')
// File parsing and bulk writes: costed in CPU seconds, so a low limit keyed on
// the USER — one person's runaway import must not lock out their colleagues.
@RateLimit('expensive')
@Controller('imports')
export class ImportController {
  constructor(private readonly imports: ImportService) {}

  /** Recent import runs for the caller's organisation. */
  @Get()
  history(@CurrentUser() user: AuthUser) {
    return this.imports.history(user);
  }

  /** Downloadable CSV template for an entity (headers marked required and recommended). */
  @Get(':entity/template')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  template(@Param('entity') entity: string) {
    return this.imports.template(entity);
  }

  /** Step 1 — discovery: columns, row count, mapping suggestions. */
  @Post(':entity/discover')
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  discover(
    @CurrentUser() user: AuthUser,
    @Param('entity') entity: string,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string },
  ) {
    return this.imports.discover(user, entity, file);
  }

  /** Step 2 — preview (dry run): validate rows, no writes. */
  @Post(':entity/preview')
  @AllowMachine()
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  preview(
    @CurrentUser() user: AuthUser,
    @Param('entity') entity: string,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string },
    @Body('mappings') mappings: unknown,
    @Body('storeId') storeId?: string,
    @Body('sourceSystem') sourceSystem?: string,
    @Body('profileId') profileId?: string,
    @Body('profileHash') profileHash?: string,
    @Body('sourceInstanceHash') sourceInstanceHash?: string,
  ) {
    return this.imports.preview(
      user,
      entity,
      file,
      parseMappings(mappings),
      storeId || undefined,
      sourceSystem || undefined,
      profileId || undefined,
      profileHash || undefined,
      sourceInstanceHash || undefined,
    );
  }

  /** Step 3 — import: idempotent, org-scoped, reconciled. Requires explicit confirm. */
  @Post(':entity/run')
  @AllowMachine()
  @UseInterceptors(FileInterceptor('file', IMPORT_UPLOAD_OPTIONS))
  run(
    @CurrentUser() user: AuthUser,
    @Param('entity') entity: string,
    @UploadedFile() file: { buffer?: Buffer; originalname?: string },
    @Body('mappings') mappings: unknown,
    @Body('storeId') storeId?: string,
    @Body('sourceSystem') sourceSystem?: string,
    @Body('runKey') runKey?: string,
    @Body('profileId') profileId?: string,
    @Body('profileHash') profileHash?: string,
    @Body('sourceInstanceHash') sourceInstanceHash?: string,
    @Body('configRevision') configRevision?: string,
  ) {
    return this.imports.run(
      user,
      entity,
      file,
      parseMappings(mappings),
      storeId || undefined,
      sourceSystem || undefined,
      runKey || undefined,
      profileId || undefined,
      profileHash || undefined,
      sourceInstanceHash || undefined,
      configRevision || undefined,
    );
  }
}
