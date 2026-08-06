import { IsIn, IsNumber, Min } from 'class-validator';

/** POST /integrations/gold-rate — a manager sets today's gold rate by hand. */
export class SetGoldRateDto {
  /** The rate being entered, in INR per gram, for the given karat. */
  @IsNumber()
  @Min(1)
  ratePerGram!: number;

  /** Which purity the entered rate is for (22k is the usual Indian quote). */
  @IsIn([22, 24])
  karat!: 22 | 24;
}
