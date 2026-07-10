import { IsString, MinLength } from 'class-validator';

/** POST /auth/reset-password — a manager resets a subordinate's password. */
export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  userId!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
