import { IsOptional, IsString } from 'class-validator';

/**
 * Browsers never send this: their refresh token rides in an HttpOnly cookie.
 * The body field exists for non-browser callers and to migrate a session that
 * was stored by an older client build.
 */
export class RefreshTokenDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
