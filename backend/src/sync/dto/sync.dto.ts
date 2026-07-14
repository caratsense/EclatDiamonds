import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * One bulk-upsert batch from the on-site sync agent. `records` holds raw legacy
 * rows (legacy column names) for a single entity; SyncService maps + upserts them.
 * Elements are intentionally not whitelisted — legacy columns vary by install and
 * are normalised server-side, not validated field-by-field.
 */
export class SyncBatchDto {
  @IsArray()
  @ArrayMaxSize(5000)
  records!: Record<string, unknown>[];
}

/** One Gati branch/location row → upserted into Store on `legacyId`. */
export class StoreSyncRowDto {
  @IsString()
  @MinLength(1)
  legacyId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  code?: string;
}

/**
 * POST /sync/stores — auto-ingest Gati branches. New legacyIds are created as
 * `pending` (HO/AM fills geo+region on activation); known ones only refresh
 * name/city/code. Idempotent.
 */
export class SyncStoresDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StoreSyncRowDto)
  records!: StoreSyncRowDto[];
}

/**
 * One raw-mirror batch for the generic legacy dump. `table` is the source table
 * name; each record carries the full row plus `_rowKey` (its primary key) and
 * optional `_updatedAt` (its UpdateDate/EntryDate). Stored verbatim in LegacyRow.
 */
export class RawSyncDto {
  @IsString()
  table!: string;

  @IsArray()
  @ArrayMaxSize(5000)
  records!: Record<string, unknown>[];
}
