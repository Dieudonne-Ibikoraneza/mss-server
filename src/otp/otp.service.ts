import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { badRequest } from '@/common/errors/app-error';
import { ConfigService } from '@nestjs/config';
import { Language } from '@prisma/client';
import * as crypto from 'crypto';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';

export type OtpChannel = 'email' | 'sms';
export type OtpPurpose = 'register' | 'login';

interface OtpRecord {
  codeHash: string;
  purpose: OtpPurpose;
}

/**
 * OTP codes are short-lived and only ever needed once, so they live in Redis
 * (TTL-backed) instead of Postgres. This also gives us free rate limiting
 * (resend cooldown, max verify attempts) via the same store.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly length: number;
  private readonly ttlSeconds: number;
  private readonly maxAttempts: number;
  private readonly resendCooldownSeconds: number;
  /** Non-production only — see `otp.devBypassCode` in configuration.ts. */
  private readonly devBypassCode: string | undefined;

  constructor(
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.length = config.get<number>('otp.length') ?? 6;
    this.ttlSeconds = config.get<number>('otp.ttlSeconds') ?? 300;
    this.maxAttempts = config.get<number>('otp.maxAttempts') ?? 5;
    this.resendCooldownSeconds = config.get<number>('otp.resendCooldownSeconds') ?? 60;

    const isProduction = config.get<string>('app.env') === 'production';
    const bypassCode = config.get<string>('otp.devBypassCode');
    // Off in production unless explicitly switched on (OTP_ALLOW_BYPASS_IN_PRODUCTION=true) —
    // for a deployment that is still being tested and can't deliver real codes yet.
    const bypassAllowed = !isProduction || config.get<boolean>('otp.allowBypassInProduction');
    this.devBypassCode = bypassAllowed && bypassCode ? bypassCode : undefined;
    if (this.devBypassCode && isProduction) {
      this.logger.warn(
        `OTP bypass code is ACTIVE in production (OTP_ALLOW_BYPASS_IN_PRODUCTION=true): "${this.devBypassCode}" signs in ANY account, staff included. Testing only.`,
      );
    }
  }

  private codeKey(destination: string, purpose: OtpPurpose) {
    return `otp:${purpose}:${destination}`;
  }

  private cooldownKey(destination: string, purpose: OtpPurpose) {
    return `otp:cooldown:${purpose}:${destination}`;
  }

  /** Guesses made against the current code — a plain counter Redis increments atomically. */
  private attemptsKey(destination: string, purpose: OtpPurpose) {
    return `otp:attempts:${purpose}:${destination}`;
  }

  private hash(code: string) {
    return crypto.createHash('sha256').update(code).digest('hex');
  }

  private generateCode(): string {
    const max = 10 ** this.length;
    const code = crypto.randomInt(0, max).toString().padStart(this.length, '0');
    return code;
  }

  async send(
    destination: string,
    channel: OtpChannel,
    purpose: OtpPurpose,
    language: Language = Language.EN,
  ) {
    // One atomic claim — checking the cooldown and then setting it lets two
    // simultaneous requests both pass and both send a code.
    const claimed = await this.redis.setIfAbsent(
      this.cooldownKey(destination, purpose),
      '1',
      this.resendCooldownSeconds,
    );
    if (!claimed) {
      throw new HttpException(
        {
          message: 'Please wait before requesting another code.',
          code: 'otp.resendCooldown',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = this.generateCode();
    const record: OtpRecord = { codeHash: this.hash(code), purpose };
    await this.redis.set(this.codeKey(destination, purpose), record, this.ttlSeconds);
    // A new code starts with a clean slate of guesses.
    await this.redis.del(this.attemptsKey(destination, purpose));

    if (this.devBypassCode) {
      // Dev bypass is on — skip the real send entirely (no SMTP/SMS calls,
      // no waiting on a provider) since `devBypassCode` logs anyone in anyway.
      this.logger.log(
        `OTP for ${destination} (${purpose}): ${code} — dev bypass "${this.devBypassCode}" also works.`,
      );
    } else {
      // A delivery failure (e.g. a host that blocks SMTP) must not fail the request: the code is
      // already stored, so the caller carries on and can still verify it (or use the bypass code).
      try {
        if (channel === 'email') {
          await this.notifications.sendOtpEmail(destination, code, language, this.ttlSeconds);
        } else {
          await this.notifications.sendOtpSms(destination, code, language);
        }
      } catch (error) {
        this.logger.warn(
          `Could not deliver the ${purpose} code to ${destination} by ${channel} — continuing anyway: ${
            error instanceof Error ? error.message : 'unknown error'
          }`,
        );
      }
    }

    const minutes = Math.round(this.ttlSeconds / 60);
    const via = channel === 'email' ? 'email' : 'phone number';
    return {
      message: `We've sent a verification code to your ${via} (${destination}). It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      expiresInSeconds: this.ttlSeconds,
    };
  }

  /**
   * Checks a code. Every guess is counted with one atomic `INCR` *before* it is
   * compared, so any number of simultaneous guesses share the same budget of
   * `maxAttempts` — a read-then-write counter lets a burst of parallel guesses
   * all read "0 attempts" and all be evaluated. A right code is consumed with a
   * single `DEL` whose result decides the winner, so it can be used only once
   * even if submitted twice at the same moment.
   */
  async verify(destination: string, purpose: OtpPurpose, code: string): Promise<boolean> {
    const key = this.codeKey(destination, purpose);
    const attemptsKey = this.attemptsKey(destination, purpose);

    // Dev-only bypass: always accepts `devBypassCode`, real code or not, so
    // login/register can be exercised without a working email/SMS provider.
    if (this.devBypassCode && code === this.devBypassCode) {
      await this.redis.del(key);
      await this.redis.del(attemptsKey);
      return true;
    }

    const record = await this.redis.get<OtpRecord>(key);
    if (!record) {
      throw badRequest(
        'otp.codeExpired',
        'Code expired or not requested. Please request a new one.',
      );
    }

    const attempts = await this.redis.incr(attemptsKey, this.ttlSeconds);
    if (attempts > this.maxAttempts) {
      await this.redis.del(key);
      throw badRequest(
        'otp.tooManyAttempts',
        'Too many incorrect attempts. Please request a new code.',
      );
    }

    if (record.codeHash !== this.hash(code)) return false;

    // Right code — only the request that actually removes it may use it.
    const consumed = await this.redis.del(key);
    if (consumed !== 1) {
      throw badRequest(
        'otp.codeExpired',
        'Code expired or not requested. Please request a new one.',
      );
    }
    await this.redis.del(attemptsKey);
    return true;
  }
}
