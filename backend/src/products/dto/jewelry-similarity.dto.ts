import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ProductCategory, SimilarityFeedback } from '@prisma/client';

/** Feedback on one jewelry similarity-search hit (Module 5 training signal). */
export class SimilarityFeedbackDto {
  @IsString()
  @IsNotEmpty()
  queryId!: string;

  @IsString()
  @IsNotEmpty()
  productId!: string;

  @IsInt()
  @Min(1)
  rank!: number;

  @IsEnum(SimilarityFeedback)
  feedback!: SimilarityFeedback;
}

/** Optional query params for a similarity search (the image is multipart). */
export class SimilaritySearchQueryDto {
  @IsOptional()
  @IsEnum(ProductCategory)
  category?: ProductCategory;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
