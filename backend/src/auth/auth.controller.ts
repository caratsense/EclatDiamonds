import { Body, Controller, Get, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { SignupDto } from './dto/signup.dto';
import { GoogleLoginDto } from './dto/google-login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { RequestOtpDto, VerifyOtpDto } from './dto/otp.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { Public } from './public.decorator';
import { Roles } from './roles.decorator';
import { CurrentUser, AuthUser } from '../common/auth-user';

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
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.auth.signup(dto);
  }

  /** Sign in with a Google ID token. Throttled to match otp/verify. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
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
  @Post('otp/request')
  requestOtp(@Body() dto: RequestOtpDto) {
    return this.auth.requestOtp(dto.phone);
  }

  /** Exchange phone + 6-digit code for the same session payload as /auth/login. */
  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('otp/verify')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.auth.verifyOtp(dto.phone, dto.code);
  }

  /** Manager resets a subordinate's password (store-scope + role-rank gated). */
  @Roles('store_manager', 'area_manager', 'head_office')
  @Post('reset-password')
  resetPassword(@CurrentUser() user: AuthUser, @Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(user, dto.userId, dto.newPassword);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.auth.me(user);
  }

  @Post('change-password')
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(user, dto.currentPassword, dto.newPassword);
  }
}
