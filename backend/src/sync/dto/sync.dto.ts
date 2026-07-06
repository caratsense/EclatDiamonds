import { ArrayMaxSize, IsArray, IsString } from 'class-validator';

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
