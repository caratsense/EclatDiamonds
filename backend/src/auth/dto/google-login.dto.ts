import { IsOptional, IsString, MinLength } from 'class-validator';

/** Google Identity Services returns a JWT "credential" (ID token) we verify server-side. */
export class GoogleLoginDto {
  @IsString()
  @MinLength(10)
  credential!: string;

  /** The value the frontend handed to GIS; checked against the token's nonce claim. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  nonce?: string;
}
