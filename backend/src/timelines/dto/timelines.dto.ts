import {
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderKind, OrderStatus, ProductCategory } from '@prisma/client';

/**
 * PATCH /timelines/orders/:id/stage — advance a custom order to the next
 * production stage (Module 8). `stage` is the schema OrderStatus enum
 * (booked → designing → casting → stone_setting → polishing → qc → ready →
 * delivered; `cancelled` is the other terminal state).
 */
export class AdvanceStageDto {
  @IsEnum(OrderStatus)
  stage!: OrderStatus;

  /**
   * Note recorded on the stage-change event. REQUIRED when cancelling — writing
   * off a booked order without stating why leaves nothing to reconcile the
   * customer's advance against.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  /**
   * Who physically collected the piece. REQUIRED for the `delivered` transition:
   * handover is the point the store's liability for the item ends, so the record
   * needs to name the person it went to.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  deliveredTo?: string;
}

export class CreateWorkflowDto {
  @IsString()
  @IsNotEmpty({ message: 'A customer name is required' })
  customer!: string;

  @IsString()
  @IsNotEmpty({ message: 'An item description is required' })
  item!: string;

  @IsString()
  @IsNotEmpty({ message: 'A store is required' })
  storeId!: string;
}

/**
 * Module 2 — Custom Order Booking + Stock Orders.
 * Store manager books a custom piece (or a stock/replenishment order) that then
 * flows through the Module 8 production timeline. `kind` distinguishes the two;
 * `estimation` maps to CustomOrder.value (quoted amount).
 */
export class CreateOrderDto {
  @IsString()
  @IsNotEmpty({ message: 'A store is required' })
  storeId!: string;

  @IsString()
  @IsNotEmpty({ message: 'A customer name is required' })
  customerName!: string;

  /** 'custom' (default) or 'stock' replenishment order. */
  @IsOptional()
  @IsEnum(OrderKind)
  kind?: OrderKind;

  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty?: number;

  /** Free-text spec, e.g. "red stone → green, ring size 16, diamond 1.71ct". */
  @IsOptional()
  @IsString()
  details?: string;

  /** Optional display item label; falls back to category, then 'Custom piece'. */
  @IsOptional()
  @IsString()
  item?: string;

  /** Quoted/estimated amount (persisted as CustomOrder.value). */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  estimation?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  advanceReceived?: number;

  /** Order-placed date (yyyy-mm-dd). Defaults to today. */
  @IsOptional()
  @IsISO8601()
  bookedOn?: string;

  /** Estimated delivery date (yyyy-mm-dd). Stock orders auto-set +21d if omitted. */
  @IsOptional()
  @IsISO8601()
  eta?: string;

  // Round 2 — custom-order booking detail (all additive/optional).
  /** Ring size (custom order booking detail). */
  @IsOptional()
  @IsString()
  ringSize?: string;

  /** Bangle size (custom order booking detail). */
  @IsOptional()
  @IsString()
  bangleSize?: string;

  /** Metal colour, open text: yellow / white / rose / platinum / silver. */
  @IsOptional()
  @IsString()
  metalColor?: string;

  /** Advance payment mode: cash / card / upi / bank. */
  @IsOptional()
  @IsString()
  advanceMode?: string;

  /** Promised customer-facing delivery date (yyyy-mm-dd). */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  deliveryDate?: string;
}

/** Query filter for GET /timelines/orders. */
export class OrdersQueryDto {
  /** Filter by order kind; 'all' returns both. Default 'all'. */
  @IsOptional()
  @IsIn(['custom', 'stock', 'all'])
  kind?: 'custom' | 'stock' | 'all';

  /** 'ongoing' (default) excludes delivered + cancelled; 'all' returns everything. */
  @IsOptional()
  @IsIn(['ongoing', 'all'])
  scope?: 'ongoing' | 'all';
}
