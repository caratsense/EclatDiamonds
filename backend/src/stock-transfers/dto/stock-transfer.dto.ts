import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { StockTransferStatus } from '@prisma/client';

/**
 * Create a transfer request. `fromStoreId` is the SOURCE the pieces leave; it is
 * still validated against the caller's scope server-side — the DTO value is a
 * hint, never trusted for authorization. `stockItemIds` are the physical pieces
 * to move; they must all currently live at `fromStoreId` (checked in the service).
 *
 * The same body raises a PULL (POST /stock-transfers/pull). The shape is
 * identical because the movement is identical; what differs is which end must
 * be the caller's own branch — the source for a push, the destination for a
 * pull — and the service decides that per endpoint, never the client.
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
  @ArrayNotEmpty()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  stockItemIds!: string[];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/**
 * GET /stock-transfers/pullable — one other branch's available pieces, so the
 * asker can choose what to ask for. `fromStoreId` is the branch being asked;
 * the service checks it is a trading branch of the caller's organisation and
 * not one of the caller's own (those are on the ordinary stock list).
 */
export class PullableStockQueryDto {
  @IsString()
  @IsNotEmpty()
  fromStoreId!: string;

  /** Free-text over SKU / name / design number / piece number. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  q?: string;
}

/** Reason payload for reject/cancel/decline. */
export class ReasonDto {
  @IsOptional()
  @IsString()
  // Crosses branches now: a decline reason lands in the asking branch's bell.
  @MaxLength(500)
  reason?: string;
}

/** List filter — optional status + direction (?direction=in|out|all). */
export class ListStockTransferDto {
  @IsOptional()
  @IsIn([
    'draft', 'pending_source', 'submitted', 'ho_approved', 'dispatched', 'received',
    'acknowledged', 'declined', 'rejected', 'cancelled',
  ])
  status?: StockTransferStatus;

  @IsOptional()
  @IsIn(['in', 'out', 'all'])
  direction?: 'in' | 'out' | 'all';
}
