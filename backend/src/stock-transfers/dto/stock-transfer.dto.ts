import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { StockTransferStatus } from '@prisma/client';

/**
 * Create a transfer request. `fromStoreId` is the SOURCE the pieces leave; it is
 * still validated against the caller's scope server-side — the DTO value is a
 * hint, never trusted for authorization. `stockItemIds` are the physical pieces
 * to move; they must all currently live at `fromStoreId` (checked in the service).
 */
export class CreateStockTransferDto {
  @IsString()
  @IsNotEmpty()
  fromStoreId!: string;

  @IsString()
  @IsNotEmpty()
  toStoreId!: string;

  // Cap the batch: approve/receive loop the pieces inside one transaction holding
  // a row lock per piece, so an unbounded list is a lock-duration DoS.
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  stockItemIds!: string[];

  @IsOptional()
  @IsString()
  note?: string;
}

/** Reason payload for reject/cancel. */
export class ReasonDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

/** List filter — optional status + direction (?direction=in|out|all). */
export class ListStockTransferDto {
  @IsOptional()
  @IsIn(['draft', 'submitted', 'ho_approved', 'dispatched', 'received', 'acknowledged', 'rejected', 'cancelled'])
  status?: StockTransferStatus;

  @IsOptional()
  @IsIn(['in', 'out', 'all'])
  direction?: 'in' | 'out' | 'all';
}
