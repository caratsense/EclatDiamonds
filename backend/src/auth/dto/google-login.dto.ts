import { IsString, MinLength } from 'class-validator';

/** Google Identity Services returns a JWT "credential" (ID token) we verify server-side. */
export class GoogleLoginDto {
  @IsString()
  @MinLength(10)
  credential!: string;
}
