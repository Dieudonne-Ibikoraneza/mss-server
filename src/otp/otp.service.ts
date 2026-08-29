import { BadRequestException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Language } from '@prisma/client';
import * as crypto from 'crypto';
import { RedisService } from '@/redis/redis.service';
import { NotificationsService } from '@/notifications/notifications.service';

export type OtpChannel = 'email' | 'sms';
export type OtpPurpose = 'register' | 'login';

interface OtpRecord {
  codeHash: string;
  attempts: number;
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
    this.devBypassCode = !isProduction && bypassCode ? bypassCode : undefined;
  }

  private codeKey(destination: string, purpose: OtpPurpose) {
    return `otp:${purpose}:${destination}`;
  }

  private cooldownKey(destination: string, purpose: OtpPurpose) {
    return `otp:cooldown:${purpose}:${destination}`;
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
    const onCooldown = await this.redis.get(this.cooldownKey(destination, purpose));
    if (onCooldown) {
      throw new HttpException(
        'Please wait before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = this.generateCode();
    const record: OtpRecord = { codeHash: this.hash(code), attempts: 0, purpose };
    await this.redis.set(this.codeKey(destination, purpose), record, this.ttlSeconds);
    await this.redis.set(this.cooldownKey(destination, purpose), '1', this.resendCooldownSeconds);

    if (this.devBypassCode) {
      // Dev bypass is on — skip the real send entirely (no SMTP/SMS calls,
      // no waiting on a provider) since `devBypassCode` logs anyone in anyway.
      this.logger.log(
        `OTP for ${destination} (${purpose}): ${code} — dev bypass "${this.devBypassCode}" also works.`,
      );
    } else if (channel === 'email') {
      await this.notifications.sendOtpEmail(destination, code, language, this.ttlSeconds);
    } else {
      await this.notifications.sendOtpSms(destination, code, language);
    }

    const minutes = Math.round(this.ttlSeconds / 60);
    const via = channel === 'email' ? 'email' : 'phone number';
    return {
      message: `We've sent a verification code to your ${via} (${destination}). It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      expiresInSeconds: this.ttlSeconds,
    };
  }

  async verify(destination: string, purpose: OtpPurpose, code: string): Promise<boolean> {
    // Dev-only bypass: always accepts `devBypassCode`, real code or not, so
    // login/register can be exercised without a working email/SMS provider.
    if (this.devBypassCode && code === this.devBypassCode) {
      await this.redis.del(this.codeKey(destination, purpose));
      return true;
    }

    const key = this.codeKey(destination, purpose);
    const record = await this.redis.get<OtpRecord>(key);
    if (!record) {
      throw new BadRequestException('Code expired or not requested. Please request a new one.');
    }

    if (record.attempts >= this.maxAttempts) {
      await this.redis.del(key);
      throw new BadRequestException('Too many incorrect attempts. Please request a new code.');
    }

    if (record.codeHash !== this.hash(code)) {
      record.attempts += 1;
      await this.redis.set(key, record, this.ttlSeconds);
      return false;
    }

    await this.redis.del(key);
    return true;
  }
}
