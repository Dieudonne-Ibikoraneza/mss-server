import { Body, Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/common/decorators/public.decorator';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @ApiOperation({
    summary: 'List "how did you hear about us?" options',
    description:
      "The canonical set of values accepted by register's heardAboutUs field — fetch this instead of " +
      'hardcoding options client-side, so the two never drift out of sync.',
  })
  @Get('discovery-sources')
  listDiscoverySources() {
    return this.authService.listDiscoverySources();
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Register',
    description:
      'Submit profile details (name, email, phone, how you heard about us). No code needed yet — ' +
      'this sends a verification code to the email and the signup stays pending until verify-otp confirms it.',
  })
  @Post('register')
  register(@Body() dto: RegisterDto) {
    return this.authService.register(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Log in',
    description:
      'For an existing, already-registered account. Sends a login code to the email; follow up with verify-otp.',
  })
  @Post('login')
  login(@Body() dto: RequestOtpDto) {
    return this.authService.login(dto);
  }

  @Public()
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Resend the OTP code',
    description:
      'Resends the pending registration code, or a login code, for whichever is currently pending. Rate-limited.',
  })
  @Post('otp/resend')
  resendOtp(@Body() dto: RequestOtpDto) {
    return this.authService.resendOtp(dto);
  }

  @Public()
  @ApiOperation({
    summary: 'Verify the OTP code',
    description:
      'Confirms the code sent by register, login, or otp/resend. Completes a pending registration, or logs an ' +
      'existing account in (client or staff) — either way, returns an access/refresh token pair.',
  })
  @Post('verify-otp')
  verifyOtp(@Body() dto: VerifyOtpDto) {
    return this.authService.verifyOtp(dto);
  }

  @Public()
  @ApiOperation({
    summary: 'Refresh access token',
    description: 'Rotates a refresh token for a new access/refresh token pair.',
  })
  @Post('refresh')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Log out', description: 'Revokes the given refresh token.' })
  @Post('logout')
  async logout(@Body() dto: RefreshTokenDto) {
    await this.authService.logout(dto.refreshToken);
  }
}
