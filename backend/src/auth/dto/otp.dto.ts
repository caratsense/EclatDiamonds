import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** POST /auth/otp/request — phone in any human format (+91, spaces, dashes ok). */
export class RequestOtpDto {
  @IsString()
  @MinLength(10)
  @MaxLength(20)
  @Matches(/^[\d\s\-+()]+$/, { message: 'phone must contain only digits, spaces, +, -, ()' })
  phone!: string;
}

/** POST /auth/otp/verify — the phone the code was requested for + the 6-digit code. */
export class VerifyOtpDto {
  @IsString()
  @MinLength(10)
  @MaxLength(20)
  @Matches(/^[\d\s\-+()]+$/, { message: 'phone must contain only digits, spaces, +, -, ()' })
  phone!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}
