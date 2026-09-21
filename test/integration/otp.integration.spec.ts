import { BadRequestException, HttpException } from '@nestjs/common';
import Redis from 'ioredis';
import { OtpService } from '../../src/otp/otp.service';
import { RedisService } from '../../src/redis/redis.service';
import { prisma } from './harness';

/**
 * The OTP limiter against real Redis and against the Postgres fallback used when there is no
 * Redis — both must give the same guarantees. This is where the interesting failures live: a
 * counter that is read and then written lets a burst of simultaneous guesses all
 * see "0 attempts so far". Every test uses its own random destination, so runs
 * never interfere with each other or with real codes.
 */
describe.each(['redis', 'postgres'] as const)(
  'one-time codes under concurrent guessing (%s)',
  (backend) => {
    const url = process.env.REDIS_URL;
    if (backend === 'redis' && !url)
      throw new Error('REDIS_URL is not set — these tests need a Redis to talk to.');

    const redisClient = backend === 'redis' ? new Redis(url!, { maxRetriesPerRequest: 3 }) : null;
    const redis = new RedisService(redisClient, prisma as never);
    const sentCodes: string[] = [];
    const notifications = {
      sendOtpEmail: (_to: string, code: string) => {
        sentCodes.push(code);
        return Promise.resolve();
      },
      sendOtpSms: () => Promise.resolve(),
    };
    const settings: Record<string, unknown> = {
      'otp.length': 6,
      'otp.ttlSeconds': 120,
      'otp.maxAttempts': 5,
      'otp.resendCooldownSeconds': 60,
      'app.env': 'production', // no dev bypass code
    };
    const service = new OtpService(
      redis,
      notifications as never,
      { get: (key: string) => settings[key] } as never,
    );

    const destinations: string[] = [];
    const freshDestination = () => {
      const destination = `it-otp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}@example.test`;
      destinations.push(destination);
      return destination;
    };
    /** Requests a code for a new destination and returns it with the code that was "emailed". */
    const issueCode = async () => {
      const destination = freshDestination();
      await service.send(destination, 'email', 'login');
      return { destination, code: sentCodes[sentCodes.length - 1] };
    };
    const wrongCodeFor = (right: string) => (right === '000000' ? '111111' : '000000');

    afterAll(async () => {
      for (const destination of destinations) {
        for (const purpose of ['login', 'register']) {
          await redis.del(`otp:${purpose}:${destination}`);
          await redis.del(`otp:attempts:${purpose}:${destination}`);
          await redis.del(`otp:cooldown:${purpose}:${destination}`);
        }
      }
      redisClient?.disconnect();
    });

    it('a burst of simultaneous wrong guesses shares one budget of five — not one budget each', async () => {
      const { destination, code } = await issueCode();

      const results = await Promise.allSettled(
        Array.from({ length: 40 }, () => service.verify(destination, 'login', wrongCodeFor(code))),
      );

      const evaluated = results.filter((result) => result.status === 'fulfilled'); // resolved to `false`
      const refused = results.filter((result) => result.status === 'rejected');
      expect(evaluated.length).toBeLessThanOrEqual(5);
      expect(refused.length).toBeGreaterThanOrEqual(35);
      for (const result of refused) {
        expect(result.reason).toBeInstanceOf(BadRequestException);
      }
    });

    it('once the budget is spent the code is dead — even the right one no longer works', async () => {
      const { destination, code } = await issueCode();
      await Promise.allSettled(
        Array.from({ length: 12 }, () => service.verify(destination, 'login', wrongCodeFor(code))),
      );

      await expect(service.verify(destination, 'login', code)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('the right code works within the budget, and only once — even submitted six times at the same moment', async () => {
      const { destination, code } = await issueCode();

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => service.verify(destination, 'login', code)),
      );

      expect(
        results.filter((result) => result.status === 'fulfilled' && result.value === true),
      ).toHaveLength(1);
      // The code is spent: a seventh try finds nothing.
      await expect(service.verify(destination, 'login', code)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('a wrong guess does not spend the code; a few wrong guesses then the right one still succeeds', async () => {
      const { destination, code } = await issueCode();
      for (let i = 0; i < 3; i++)
        expect(await service.verify(destination, 'login', wrongCodeFor(code))).toBe(false);
      expect(await service.verify(destination, 'login', code)).toBe(true);
    });

    it('two simultaneous requests for a code produce one code, not two', async () => {
      const destination = freshDestination();
      const before = sentCodes.length;

      const results = await Promise.allSettled(
        [1, 2, 3, 4].map(() => service.send(destination, 'email', 'login')),
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected')
          expect((result.reason as HttpException).getStatus()).toBe(429);
      }
      expect(sentCodes.length - before).toBe(1);
    });

    it('a fresh code starts with a fresh budget of guesses', async () => {
      const first = await issueCode();
      for (let i = 0; i < 4; i++)
        await service.verify(first.destination, 'login', wrongCodeFor(first.code));
      // The customer asks again once the cooldown is over.
      await redis.del(`otp:cooldown:login:${first.destination}`);
      await service.send(first.destination, 'email', 'login');
      const second = sentCodes[sentCodes.length - 1];

      for (let i = 0; i < 5; i++)
        expect(await service.verify(first.destination, 'login', wrongCodeFor(second))).toBe(false);
      await expect(
        service.verify(first.destination, 'login', wrongCodeFor(second)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  },
);
