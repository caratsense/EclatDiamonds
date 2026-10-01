import { IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /**
   * What the person types to sign in: their Login ID, or the mobile number or
   * personal email they gave when they joined. Still called `email` because
   * every client already sends it under that name.
   */
  @IsString()
  @MinLength(3)
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(4)
  password!: string;
}
