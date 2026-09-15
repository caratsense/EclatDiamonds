import { Body, Controller, Get, Post } from '@nestjs/common';
import { Permit } from './permissions';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { CreateOrganisationDto } from './dto/create-organisation.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { Public } from './public.decorator';
import { RateLimit } from '../common/rate-limit';
import { Roles } from './roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';

/**
 * NOTE ON RATE LIMITING: `@RateLimit('auth')` is applied PER ROUTE below, never
 * on this class. The `auth` bucket is small (10/min) and, for an authenticated
 * request, `CategoryThrottlerGuard.getTracker` keys it on the ORGANISATION — so
 * a class-level tag silently gave the whole tenant ten requests a minute on
 * `/auth/me`, which the session gate calls on every page load. A handful of
 * staff opening the app together were thrown back to the login screen.
 *
 * The tight bucket belongs to the unauthenticated, guessable routes (keyed on
 * IP, where it is the right control) and to nothing else.
 */
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /**
   * Password sign-in. Tighter per-IP throttle than the global 300/min — a human
   * never types 15 logins a minute; a script does. Account lockout (5 fails →
   * 15-min freeze) lives in AuthService for slow distributed brute-force.
   */
  @Public()
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @RateLimit('auth')
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }

  /**
   * Self-registration. Throttled (belt-and-braces against pending-queue spam) and
   * creates only a powerless pending request — see AuthService.signup. Approval is
   * a separate, authenticated step (POST /users/:id/approve).
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RateLimit('auth')
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  /** Public industry catalogue for the new-organisation onboarding screen. */
  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @RateLimit('public')
  @Get('industries')
  industries() {
    return this.auth.availableIndustries();
  }

  /**
   * Self-service tenant provisioning. Tighter than employee signup because it
   * materialises a complete isolated organisation and active owner account.
   */
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @RateLimit('auth')
  @Post('organisations')
  createOrganisation(@Body() dto: CreateOrganisationDto) {
    return this.auth.createOrganisation(dto);
  }

  /** Sign in with a Google ID token. Throttled to match otp/verify. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RateLimit('auth')
  @Post('google')
  google(@Body() dto: GoogleLoginDto) {
    return this.auth.loginWithGoogle(dto.credential, dto.nonce);
  }

  /**
   * Request a WhatsApp sign-in code. Always {sent:true} — never leaks known phones.
   * IP-level throttle is belt-and-braces; the per-phone cooldown in AuthService
   * stays the primary abuse guard.
   */
  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @RateLimit('auth')
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  /** Exchange phone + 6-digit code for the same session payload as /auth/login. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @RateLimit('auth')
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code);
  }

  /** Manager resets a subordinate's password (store-scope + role-rank gated). */
  @Roles('store_manager', 'head_office')
  @RateLimit('auth')
  @Post('reset-password')
  resetPassword(@CurrentUser() user: AuthUser, @Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(user, dto.userId, dto.newPassword);
  }

  /**
   * Deliberately NOT `@RateLimit('auth')`: this is an authenticated session read
   * the frontend issues on every page load, so it falls to the default bucket
   * (300/min, keyed on the organisation) rather than the 10/min credential one.
   */
  @Permit('session')
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  /** Authenticated, and rank-gated in the service — not a credential-guessing surface. */
  @Permit('session')
  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user, dto.currentPassword, dto.newPassword);
  }
}
