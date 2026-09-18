/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.any(...)` matchers are typed `any` */
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { AuthService } from './auth.service';

describe('AuthService — account status enforcement', () => {
  let prisma: {
    user: { findUnique: jest.Mock; update: jest.Mock; create: jest.Mock };
    refreshToken: {
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      create: jest.Mock;
    };
  };
  let redis: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let jwt: { signAsync: jest.Mock };
  let config: { get: jest.Mock };
  let otp: { send: jest.Mock; verify: jest.Mock };
  let service: AuthService;

  const baseUser = {
    id: 'user-1',
    email: 'person@example.com',
    role: 'CLIENT',
    language: 'EN',
    status: UserStatus.ACTIVE,
  };

  beforeEach(() => {
    prisma = {
      user: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
      refreshToken: {
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
    };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn(), del: jest.fn() };
    jwt = { signAsync: jest.fn().mockResolvedValue('signed-access-token') };
    config = {
      get: jest.fn((key: string) => {
        const values: Record<string, unknown> = {
          'otp.ttlSeconds': 300,
          'jwt.accessSecret': 'secret',
          'jwt.accessTtl': '15m',
          'jwt.refreshTtl': '30d',
        };
        return values[key];
      }),
    };
    otp = {
      send: jest.fn().mockResolvedValue({ message: 'sent', expiresInSeconds: 300 }),
      verify: jest.fn().mockResolvedValue(true),
    };

    service = new AuthService(prisma as any, redis as any, jwt as any, config as any, otp as any);
  });

  describe('login', () => {
    it('sends an OTP for an active user', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);

      await service.login({ email: baseUser.email });

      expect(otp.send).toHaveBeenCalledWith(baseUser.email, 'email', 'login', baseUser.language);
    });

    it.each([UserStatus.INACTIVE, UserStatus.SUSPENDED])(
      'does not send an OTP for a %s user, and returns a generic response',
      async (status) => {
        prisma.user.findUnique.mockResolvedValue({ ...baseUser, status });

        const result = await service.login({ email: baseUser.email });

        expect(otp.send).not.toHaveBeenCalled();
        expect(result).toEqual(
          expect.objectContaining({
            message: expect.any(String),
            expiresInSeconds: expect.any(Number),
          }),
        );
      },
    );

    it('still rejects a nonexistent account', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.login({ email: 'nobody@example.com' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('resendOtp', () => {
    it('sends an OTP for an active user with no pending registration', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);

      await service.resendOtp({ email: baseUser.email });

      expect(otp.send).toHaveBeenCalledWith(baseUser.email, 'email', 'login', baseUser.language);
    });

    it.each([UserStatus.INACTIVE, UserStatus.SUSPENDED])(
      'does not send an OTP for a %s user',
      async (status) => {
        prisma.user.findUnique.mockResolvedValue({ ...baseUser, status });

        const result = await service.resendOtp({ email: baseUser.email });

        expect(otp.send).not.toHaveBeenCalled();
        expect(result).toEqual(
          expect.objectContaining({
            message: expect.any(String),
            expiresInSeconds: expect.any(Number),
          }),
        );
      },
    );
  });

  describe('verifyOtp', () => {
    it('issues tokens for an active user with a valid code', async () => {
      prisma.user.findUnique.mockResolvedValue(baseUser);
      prisma.user.update.mockResolvedValue(baseUser);
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.verifyOtp({ email: baseUser.email, otp: '123456' });

      expect(result).toEqual({
        accessToken: 'signed-access-token',
        refreshToken: expect.any(String),
      });
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });

    it.each([UserStatus.INACTIVE, UserStatus.SUSPENDED])(
      'rejects a %s user even with a valid code, without issuing tokens',
      async (status) => {
        prisma.user.findUnique.mockResolvedValue({ ...baseUser, status });

        await expect(
          service.verifyOtp({ email: baseUser.email, otp: '123456' }),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
        expect(jwt.signAsync).not.toHaveBeenCalled();
      },
    );
  });

  describe('refresh', () => {
    const storedToken = {
      id: 'rt-1',
      userId: baseUser.id,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };

    it('rotates the token pair for an active user', async () => {
      prisma.refreshToken.findUnique.mockResolvedValue(storedToken);
      prisma.user.findUnique.mockResolvedValue(baseUser);
      prisma.refreshToken.update.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({});

      const result = await service.refresh('some-refresh-token');

      expect(result).toEqual({
        accessToken: 'signed-access-token',
        refreshToken: expect.any(String),
      });
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: storedToken.id },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it.each([UserStatus.INACTIVE, UserStatus.SUSPENDED])(
      'revokes the presented token and rejects a %s user instead of rotating',
      async (status) => {
        prisma.refreshToken.findUnique.mockResolvedValue(storedToken);
        prisma.user.findUnique.mockResolvedValue({ ...baseUser, status });
        prisma.refreshToken.update.mockResolvedValue({});

        await expect(service.refresh('some-refresh-token')).rejects.toBeInstanceOf(
          UnauthorizedException,
        );

        expect(prisma.refreshToken.update).toHaveBeenCalledWith({
          where: { id: storedToken.id },
          data: { revokedAt: expect.any(Date) },
        });
        expect(prisma.refreshToken.create).not.toHaveBeenCalled();
      },
    );
  });
});
