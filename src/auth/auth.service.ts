import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { PrismaService } from '@/prisma/prisma.service';
import { RedisService } from '@/redis/redis.service';
import { OtpService } from '@/otp/otp.service';
import { RegisterDto } from './dto/register.dto';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import type { AuthenticatedUser } from './types/authenticated-user.type';
import { DISCOVERY_SOURCES, type DiscoverySourceOption } from './discovery-sources';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

interface PendingRegistration {
  fullName: string;
  email: string;
  phone: string;
  heardAboutUs: RegisterDto['heardAboutUs'];
  language: RegisterDto['language'];
}

/**
 * Registration is two steps: submit profile details (no code yet), then
 * verify the emailed OTP. Until verified, the submission only lives in
 * Redis (keyed by email, same TTL as the code) — no User row is created,
 * so an abandoned signup never leaves a half-registered account behind.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly otp: OtpService,
  ) {}

  listDiscoverySources(): DiscoverySourceOption[] {
    return DISCOVERY_SOURCES;
  }

  private pendingKey(email: string) {
    return `registration:pending:${email.toLowerCase()}`;
  }

  private get pendingTtlSeconds(): number {
    return this.config.get<number>('otp.ttlSeconds') ?? 300;
  }

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email: dto.email }, { phone: dto.phone }] },
    });
    if (existing) {
      throw new ConflictException('An account with this email or phone already exists.');
    }

    const pending: PendingRegistration = {
      fullName: dto.fullName,
      email: dto.email,
      phone: dto.phone,
      heardAboutUs: dto.heardAboutUs,
      language: dto.language,
    };
    await this.redis.set(this.pendingKey(dto.email), pending, this.pendingTtlSeconds);

    return this.otp.send(dto.email, 'email', 'register');
  }

  /** Starts a login: sends a code to an existing, already-registered account. */
  async login(dto: RequestOtpDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new NotFoundException('No account found for this email. Please register first.');
    }

    return this.otp.send(dto.email, 'email', 'login');
  }

  /** Resends whichever code is currently pending: a registration code, or a login code. */
  async resendOtp(dto: RequestOtpDto) {
    const pending = await this.redis.get<PendingRegistration>(this.pendingKey(dto.email));
    if (pending) {
      return this.otp.send(dto.email, 'email', 'register');
    }

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      throw new NotFoundException(
        'No account or pending registration found for this email. Please register first.',
      );
    }

    return this.otp.send(dto.email, 'email', 'login');
  }

  /** Verifies the OTP and either completes a pending registration or logs an existing user in. */
  async verifyOtp(dto: VerifyOtpDto): Promise<TokenPair> {
    const pendingKey = this.pendingKey(dto.email);
    const pending = await this.redis.get<PendingRegistration>(pendingKey);

    if (pending) {
      const valid = await this.otp.verify(dto.email, 'register', dto.otp);
      if (!valid) throw new BadRequestException('Invalid or expired verification code.');

      const user = await this.prisma.user.create({
        data: {
          fullName: pending.fullName,
          email: pending.email,
          phone: pending.phone,
          heardAboutUs: pending.heardAboutUs,
          language: pending.language,
          emailVerifiedAt: new Date(),
        },
      });
      await this.redis.del(pendingKey);

      return this.issueTokens(user.id, user.role);
    }

    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) throw new UnauthorizedException('No account found for this email.');

    const valid = await this.otp.verify(dto.email, 'login', dto.otp);
    if (!valid) throw new BadRequestException('Invalid or expired verification code.');

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    return this.issueTokens(user.id, user.role);
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired.');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user) throw new UnauthorizedException('Account no longer exists.');

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(user.id, user.role);
  }

  async logout(refreshToken: string) {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private hashToken(token: string) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async issueTokens(userId: string, role: AuthenticatedUser['role']): Promise<TokenPair> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, role },
      {
        secret: this.config.get<string>('jwt.accessSecret'),
        expiresIn: this.config.get<string>('jwt.accessTtl') as unknown as number,
      },
    );

    const refreshToken = crypto.randomBytes(48).toString('hex');
    const refreshTtl = this.config.get<string>('jwt.refreshTtl') ?? '30d';
    const expiresAt = new Date(Date.now() + this.parseDurationMs(refreshTtl));

    await this.prisma.refreshToken.create({
      data: { userId, tokenHash: this.hashToken(refreshToken), expiresAt },
    });

    return { accessToken, refreshToken };
  }

  private parseDurationMs(duration: string): number {
    const match = /^(\d+)([smhd])$/.exec(duration.trim());
    if (!match) return 30 * 24 * 60 * 60 * 1000;
    const value = Number(match[1]);
    const unit = match[2];
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 86_400_000;
    return value * unitMs;
  }
}
