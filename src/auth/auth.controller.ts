import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public } from '@/common/decorators/public.decorator';
import { AuthService, type TokenPair } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import {
  clearRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
  type RefreshCookieSettings,
} from './refresh-cookie';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService,
  ) {}

  private get cookieSettings(): RefreshCookieSettings {
    return {
      secure: this.config.get<boolean>('session.cookieSecure') ?? true,
      sameSite:
        this.config.get<RefreshCookieSettings['sameSite']>('session.cookieSameSite') ?? 'lax',
      domain: this.config.get<string>('session.cookieDomain'),
      path: this.config.get<string>('session.cookiePath') ?? '/api/v1/auth',
    };
  }

  /**
   * Hands the refresh token to the browser as an HttpOnly cookie and returns
   * only the short-lived access token in the body — the refresh token is
   * never readable by page script.
   */
  private startSession(res: Response, tokens: TokenPair) {
    setRefreshCookie(res, tokens.refreshToken, tokens.refreshExpiresAt, this.cookieSettings);
    return { accessToken: tokens.accessToken };
  }

  /**
   * The cookie authenticates `refresh`/`logout` by itself, so a page on another
   * site must not be able to trigger them. `SameSite` already keeps the cookie
   * off cross-site requests; this is the second line: a browser-sent `Origin`
   * that isn't one of ours is refused. (No `Origin` = not a browser fetch.)
   */
  private assertTrustedOrigin(req: Request) {
    const origin = req.headers.origin;
    const allowed = this.config.get<string[]>('app.corsOrigins') ?? [];
    if (origin && !allowed.includes(origin)) {
      throw new ForbiddenException('This origin is not allowed.');
    }
  }

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
      'existing account in (client or staff). Returns the short-lived `accessToken` in the body; the refresh ' +
      'token is set as an HttpOnly cookie and never appears in the response body.',
  })
  @Post('verify-otp')
  async verifyOtp(@Body() dto: VerifyOtpDto, @Res({ passthrough: true }) res: Response) {
    return this.startSession(res, await this.authService.verifyOtp(dto));
  }

  @Public()
  @ApiOperation({
    summary: 'Refresh access token',
    description:
      'Rotates the refresh token (read from the HttpOnly cookie) for a new access token and a new cookie. ' +
      'A `refreshToken` in the body is accepted only for non-browser callers and to migrate a session stored ' +
      'by an older client. Answers 401 (and clears the cookie) when the session is gone.',
  })
  @Post('refresh')
  async refresh(
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertTrustedOrigin(req);
    const token = readRefreshCookie(req) ?? dto.refreshToken;
    if (!token) throw new UnauthorizedException('No active session.');

    try {
      return this.startSession(res, await this.authService.refresh(token));
    } catch (error) {
      // A dead session shouldn't leave a dead cookie behind to be re-sent forever.
      if (error instanceof UnauthorizedException) clearRefreshCookie(res, this.cookieSettings);
      throw error;
    }
  }

  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Log out',
    description:
      "Revokes the session's refresh token (cookie, or body for non-browser callers) and clears the cookie.",
  })
  @Post('logout')
  async logout(
    @Req() req: Request,
    @Body() dto: RefreshTokenDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertTrustedOrigin(req);
    const tokens = new Set(
      [readRefreshCookie(req), dto.refreshToken].filter((t): t is string => !!t),
    );
    await Promise.all([...tokens].map((token) => this.authService.logout(token)));
    clearRefreshCookie(res, this.cookieSettings);
  }
}
