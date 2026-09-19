import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { REFRESH_COOKIE_NAME } from './refresh-cookie';

describe('AuthController — session cookie', () => {
  let authService: { verifyOtp: jest.Mock; refresh: jest.Mock; logout: jest.Mock };
  let controller: AuthController;

  const settingsValues: Record<string, unknown> = {
    'session.cookieSecure': true,
    'session.cookieSameSite': 'lax',
    'session.cookieDomain': undefined,
    'session.cookiePath': '/api/v1/auth',
    'app.corsOrigins': ['http://localhost:3000', 'https://app.example.com'],
  };
  const pair = () => ({
    accessToken: 'access-jwt',
    refreshToken: 'refresh-secret',
    refreshExpiresAt: new Date(Date.now() + 86_400_000),
  });
  const res = () => ({ cookie: jest.fn(), clearCookie: jest.fn() });
  const req = (headers: Record<string, string> = {}) => ({ headers }) as never;

  beforeEach(() => {
    authService = {
      verifyOtp: jest.fn(),
      refresh: jest.fn(),
      logout: jest.fn().mockResolvedValue(undefined),
    };
    controller = new AuthController(
      authService as never,
      { get: jest.fn((key: string) => settingsValues[key]) } as never,
    );
  });

  describe('verify-otp', () => {
    it('puts the refresh token in an HttpOnly cookie and only the access token in the body', async () => {
      authService.verifyOtp.mockResolvedValue(pair());
      const response = res();

      const body = await controller.verifyOtp({ email: 'a@b.rw', otp: '1234' }, response as never);

      expect(body).toEqual({ accessToken: 'access-jwt' });
      expect(JSON.stringify(body)).not.toContain('refresh-secret');
      expect(response.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        'refresh-secret',
        expect.objectContaining({
          httpOnly: true,
          secure: true,
          sameSite: 'lax',
          path: '/api/v1/auth',
        }),
      );
    });

    it('sets no cookie when verification fails', async () => {
      authService.verifyOtp.mockRejectedValue(new UnauthorizedException());
      const response = res();
      await expect(
        controller.verifyOtp({ email: 'a@b.rw', otp: '0000' }, response as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(response.cookie).not.toHaveBeenCalled();
    });
  });

  describe('refresh', () => {
    it('rotates using the cookie and answers with a new cookie + access token only', async () => {
      authService.refresh.mockResolvedValue({ ...pair(), refreshToken: 'rotated-secret' });
      const response = res();

      const body = await controller.refresh(
        req({ cookie: `${REFRESH_COOKIE_NAME}=old-secret`, origin: 'http://localhost:3000' }),
        {},
        response as never,
      );

      expect(authService.refresh).toHaveBeenCalledWith('old-secret');
      expect(body).toEqual({ accessToken: 'access-jwt' });
      expect(response.cookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        'rotated-secret',
        expect.any(Object),
      );
    });

    it('prefers the cookie over a body token', async () => {
      authService.refresh.mockResolvedValue(pair());
      await controller.refresh(
        req({ cookie: `${REFRESH_COOKIE_NAME}=from-cookie` }),
        { refreshToken: 'from-body' },
        res() as never,
      );
      expect(authService.refresh).toHaveBeenCalledWith('from-cookie');
    });

    it('still accepts a body token (migrating a session stored by an older client)', async () => {
      authService.refresh.mockResolvedValue(pair());
      await controller.refresh(req(), { refreshToken: 'legacy-token' }, res() as never);
      expect(authService.refresh).toHaveBeenCalledWith('legacy-token');
    });

    it('is 401 with no cookie and no body token', async () => {
      await expect(controller.refresh(req(), {}, res() as never)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(authService.refresh).not.toHaveBeenCalled();
    });

    it('clears the dead cookie when the session is rejected', async () => {
      authService.refresh.mockRejectedValue(new UnauthorizedException('revoked'));
      const response = res();

      await expect(
        controller.refresh(req({ cookie: `${REFRESH_COOKIE_NAME}=dead` }), {}, response as never),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(response.clearCookie).toHaveBeenCalledWith(
        REFRESH_COOKIE_NAME,
        expect.objectContaining({ path: '/api/v1/auth' }),
      );
      expect(response.cookie).not.toHaveBeenCalled();
    });

    it('does not clear the cookie for an unexpected server error', async () => {
      authService.refresh.mockRejectedValue(new Error('database down'));
      const response = res();
      await expect(
        controller.refresh(req({ cookie: `${REFRESH_COOKIE_NAME}=ok` }), {}, response as never),
      ).rejects.toThrow('database down');
      expect(response.clearCookie).not.toHaveBeenCalled();
    });

    it('refuses a browser request from an origin that is not ours (CSRF second line)', async () => {
      await expect(
        controller.refresh(
          req({ cookie: `${REFRESH_COOKIE_NAME}=x`, origin: 'https://evil.example' }),
          {},
          res() as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(authService.refresh).not.toHaveBeenCalled();
    });

    it('allows any configured origin, and requests with no Origin header', async () => {
      authService.refresh.mockResolvedValue(pair());
      await controller.refresh(
        req({ cookie: `${REFRESH_COOKIE_NAME}=x`, origin: 'https://app.example.com' }),
        {},
        res() as never,
      );
      await controller.refresh(req({ cookie: `${REFRESH_COOKIE_NAME}=x` }), {}, res() as never);
      expect(authService.refresh).toHaveBeenCalledTimes(2);
    });
  });

  describe('logout', () => {
    it('revokes the cookie token and clears the cookie', async () => {
      const response = res();

      await controller.logout(
        req({ cookie: `${REFRESH_COOKIE_NAME}=session-token` }),
        {},
        response as never,
      );

      expect(authService.logout).toHaveBeenCalledWith('session-token');
      expect(response.clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, expect.any(Object));
    });

    it('revokes both when a body token differs from the cookie, and each only once', async () => {
      await controller.logout(
        req({ cookie: `${REFRESH_COOKIE_NAME}=a` }),
        { refreshToken: 'b' },
        res() as never,
      );
      await controller.logout(
        req({ cookie: `${REFRESH_COOKIE_NAME}=same` }),
        { refreshToken: 'same' },
        res() as never,
      );
      expect((authService.logout.mock.calls as string[][]).map((call) => call[0])).toEqual([
        'a',
        'b',
        'same',
      ]);
    });

    it('still clears the cookie when there is nothing to revoke', async () => {
      const response = res();
      await controller.logout(req(), {}, response as never);
      expect(authService.logout).not.toHaveBeenCalled();
      expect(response.clearCookie).toHaveBeenCalled();
    });

    it('refuses an untrusted origin', async () => {
      await expect(
        controller.logout(req({ origin: 'https://evil.example' }), {}, res() as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
