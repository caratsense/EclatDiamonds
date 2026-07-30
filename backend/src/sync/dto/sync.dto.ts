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

  // Office address + contact, from the PartyMst branch row. All optional: a
  // branch may have none of it filled in, and a blank field must never fail the
  // whole batch.
  @IsOptional()
  @IsString()
  addressLine1?: string;

  @IsOptional()
  @IsString()
  addressLine2?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  pincode?: string;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  gstin?: string;
}

/**
 * POST /sync/staff — import the client's people.
 *
 * `legacyId` is the PartyMst `PartyNo` (a salesperson row) or the SPM_Users id.
 * `email` is optional because the legacy master frequently has none; a synthetic
 * placeholder is generated so the row can exist, and head office replaces it when
 * activating the person.
 */
export class StaffSyncRowDto {
  @IsString()
  @MinLength(1)
  legacyId!: string;

  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  /** legacyId of the branch this person belongs to, if the source records one. */
  @IsOptional()
  @IsString()
  storeLegacyId?: string;

  /** Free-text role/designation from the source, kept for the activation review. */
  @IsOptional()
  @IsString()
  designation?: string;

  @IsOptional()
  @IsString()
  updatedAt?: string;
}

export class SyncStaffDto {
  @IsArray()
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => StaffSyncRowDto)
  records!: StaffSyncRowDto[];
}

/**
 * POST /sync/purge-demo — remove seeded demo data once real data has landed.
 *
 * Destructive and irreversible, so it is dry-run unless `confirm` carries the
 * exact phrase. See SyncService.purgeDemo for the guards.
 */
export class PurgeDemoDto {
  @IsOptional()
  @IsString()
  confirm?: string;
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
