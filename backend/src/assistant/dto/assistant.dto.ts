import { IsString, MaxLength, MinLength } from 'class-validator';

/** POST /assistant/ask — one question from the chat panel. */
export class AskDto {
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  text!: string;
}
