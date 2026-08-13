import { IsEnum, IsIn, IsISO8601, IsNotEmpty, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ReturnType, SettlementType } from '@prisma/client';
import { IsIndianMobile } from '../../common/contact.util';

/** 'exchange' | 'buyback' — Module 14 calculator option the customer picks. */
export type ChosenOption = 'exchange' | 'buyback';

export class CreateReturnDto {
  @IsString()
  storeId!: string;

  @IsString()
  customerName!: string;

  /** Phone is now mandatory on a return (team checklist) — valid Indian mobile. */
  @IsString()
  @IsNotEmpty()
  @IsIndianMobile()
  phone!: string;

  /** Round 2: 'invoice' (pulled from a bill) vs 'manual' (typed). Defaults to 'manual'. */
  @IsOptional()
  @IsIn(['invoice', 'manual'])
  entryMode?: 'invoice' | 'manual';

  /** Source invoice number; required when entryMode = 'invoice'. */
  @IsOptional()
  @IsString()
  invoiceNo?: string;

  /**
   * Legacy return kind (return / exchange / repair / old_gold). Optional now:
   * when `chosenOption` is supplied the Module-14 calculator derives the type
   * (exchange -> exchange, buyback -> return) instead.
   */
  @IsOptional()
  @IsEnum(ReturnType)
  type?: ReturnType;

  @IsOptional()
  @IsString()
  item?: string;

  /** Original invoice value of the item (INR). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  originalValue?: number;

  /** Old-gold gross weight (grams) for exchange/old_gold. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  oldGoldGrams?: number;

  @IsOptional()
  @IsNumber()
  oldGoldKarat?: number;

  /** Rate per gram applied at intake (INR/g). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  ratePerGram?: number;

  /** Melting-loss / wastage / hallmark deductions (INR). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  deductions?: number;

  @IsOptional()
  @IsEnum(SettlementType)
  settlement?: SettlementType;

  @IsOptional()
  @IsString()
  reason?: string;

  // --- Module 14 exchange / buyback calculator (original purchase inputs) ---
  /** Gold weight from the original bill (grams). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  goldWtG?: number;

  /** Gold purity in karat (24/22/18) — selects today's per-karat gold rate. */
  @IsOptional()
  @IsIn([24, 22, 18])
  goldKarat?: number;

  /** Gold rate on the original bill (INR/g). Captured for the record. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  goldRateAtPurchase?: number;

  /** Diamond weight from the original bill (carat). */
  @IsOptional()
  @IsNumber()
  @Min(0)
  diaCarat?: number;

  /** Diamond spec / internal code (e.g. "1ct", "20cent") — keys today's rate. */
  @IsOptional()
  @IsString()
  diaSpec?: string;

  /** Diamond rate on the original bill (INR/carat). Captured for the record. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  diaRateAtPurchase?: number;

  /** Making charge on the original bill (INR). Captured; NOT returned. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  making?: number;

  /** Override today's gold rate (INR/g) instead of resolving from MetalRate. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  todayGoldRate?: number;

  /** Override today's diamond rate (INR/carat) instead of resolving from DiamondRate. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  todayDiaRate?: number;

  /** Discount given at purchase time (type: 'percent' | 'value' | 'piece'). */
  @IsOptional()
  @IsString()
  purchaseDiscountType?: string;

  /** Discount amount or percentage given at purchase time to be deducted from exchange. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseDiscountValue?: number;

  /** Which option the customer took — drives value + type. */
  @IsOptional()
  @IsIn(['exchange', 'buyback'])
  chosenOption?: ChosenOption;
}

/** POST /returns/valuate — preview the exchange/buyback values (no persist). */
export class ValuateReturnDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  goldWtG?: number;

  /** Gold purity in karat (24/22/18) — selects today's per-karat gold rate. */
  @IsOptional()
  @IsIn([24, 22, 18])
  goldKarat?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  goldRateAtPurchase?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  diaCarat?: number;

  @IsOptional()
  @IsString()
  diaSpec?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  diaRateAtPurchase?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  making?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  todayGoldRate?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  todayDiaRate?: number;

  /** Optional store id so a per-store rate override is applied when resolving. */
  @IsOptional()
  @IsString()
  storeId?: string;

  /** Round 2: 'invoice' vs 'manual' intake toggle (preview only; not persisted). */
  @IsOptional()
  @IsIn(['invoice', 'manual'])
  entryMode?: 'invoice' | 'manual';

  @IsOptional()
  @IsString()
  purchaseDiscountType?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  purchaseDiscountValue?: number;

  @IsOptional()
  @IsString()
  invoiceNo?: string;
}

/** Optional body on returns approve/reject — decision note shown to the requester. */
export class DecideReturnDto {
  @IsOptional()
  @IsString()
  note?: string;
}

/** POST /returns/diamond-rates — HO sets a diamond rate for a spec/code. */
export class CreateDiamondRateDto {
  @IsString()
  spec!: string;

  @IsNumber()
  @Min(0)
  ratePerCarat!: number;

  /** Defaults to now when omitted. */
  @IsOptional()
  @IsISO8601()
  effectiveFrom?: string;

  /** Optional per-store override; null/omitted = applies to all stores. */
  @IsOptional()
  @IsString()
  storeId?: string;
}
