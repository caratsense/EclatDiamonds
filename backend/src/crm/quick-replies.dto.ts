import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import { QUICK_REPLY_KINDS, type QuickReplyKind } from './quick-replies';

/** Longer than this and it is not a chip any more; it is a paragraph. */
export const LABEL_MAX = 32;
/**
 * The same ceiling the composer has (`QueueOmnichannelMessageDto.body`), so a
 * reply that saves can always be sent. A shortcut that stores more than
 * WhatsApp carries would fail at the provider, one customer at a time.
 */
export const BODY_MAX = 4096;

export class CreateQuickReplyDto {
  @IsString()
  @Length(2, LABEL_MAX)
  label!: string;

  @IsIn(QUICK_REPLY_KINDS)
  kind!: QuickReplyKind;

  /** Required for 'free_text', refused for 'template' — checked in the service,
   *  where the message can say which kind was chosen. */
  @IsOptional()
  @IsString()
  @Length(1, BODY_MAX)
  body?: string;

  /** `IntegrationAsset.id` of an approved WhatsApp template. */
  @IsOptional()
  @IsString()
  @Length(1, 80)
  templateAssetId?: string;

  /**
   * The branch this belongs to. Absent or null means every branch, which only
   * head office may write.
   */
  @IsOptional()
  @IsString()
  @Length(1, 80)
  storeId?: string | null;
}

export class UpdateQuickReplyDto {
  @IsOptional()
  @IsString()
  @Length(2, LABEL_MAX)
  label?: string;

  @IsOptional()
  @IsIn(QUICK_REPLY_KINDS)
  kind?: QuickReplyKind;

  @IsOptional()
  @IsString()
  @Length(1, BODY_MAX)
  body?: string;

  @IsOptional()
  @IsString()
  @Length(1, 80)
  templateAssetId?: string;

  /**
   * `null` is a real value here — it moves a branch reply to every branch — so
   * this field being absent and being null mean different things. The service
   * reads `'storeId' in dto` rather than `dto.storeId !== undefined`.
   */
  @IsOptional()
  @IsString()
  @Length(1, 80)
  storeId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class ReorderQuickRepliesDto {
  /**
   * The ids in the order they should appear, as the screen shows them. The
   * whole visible list, not a pair of swapped ids: two managers dragging rows
   * at once then converge on a state instead of racing to increment.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids!: string[];
}
