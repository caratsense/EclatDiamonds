import { IsNotEmpty, IsNumber, IsOptional, IsString, Matches, Min } from 'class-validator';

/** POST /targets — set (upsert) a store or per-staff monthly revenue target. */
export class SetTargetDto {
  @IsString()
  @IsNotEmpty()
  storeId!: string;

  /** Omit / null => whole-store target (the one the dashboard achievement uses). */
  @IsOptional()
  @IsString()
  staffId?: string;

  /** Target month as "YYYY-MM". */
  @IsNotEmpty()
  @Matches(/^\d{4}-\d{2}$/, { message: 'period must be "YYYY-MM"' })
  period!: string;

  @IsNumber()
  @Min(0)
  amount!: number;
}

/** PATCH /targets/:id — edit an existing target's amount. */
export class UpdateTargetDto {
  @IsNumber()
  @Min(0)
  amount!: number;
}
