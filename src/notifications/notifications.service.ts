import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { Language, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { escapeHtml, renderTemplate } from './template-renderer';

/** Keys of the `EmailTemplate` rows seeded by prisma/seed.ts — keep in sync with that file. */
export const EMAIL_TEMPLATE_KEYS = {
  OTP_VERIFICATION: 'OTP_VERIFICATION',
  STAFF_ACCOUNT_CREATED: 'STAFF_ACCOUNT_CREATED',
  LOW_STOCK_ALERT: 'LOW_STOCK_ALERT',
} as const;

/** PlatformSetting key that switches low-stock alerts on and off from the admin panel. */
export const LOW_STOCK_ALERTS_SETTING = 'notifications.lowStockAlerts';

/**
 * Bilingual (EN/RW) email + SMS sending, abstracted behind a provider name
 * read from config. Defaults to logging to the console so local development
 * and CI never require real SMTP/SMS credentials.
 *
 * Email copy lives in the `EmailTemplate` table (seeded, editable without a
 * deploy) rather than hardcoded strings — see EMAIL_TEMPLATE_KEYS. The OTP
 * path falls back to a hardcoded message if its template is ever missing
 * (e.g. seed not run yet), since a broken OTP email blocks login entirely;
 * every other email is skipped (with a logged warning) if its template is
 * missing, since those are non-critical notifications.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly emailProvider: string;
  private readonly smsProvider: string;
  private transporter: Transporter | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.emailProvider = config.get<string>('notifications.emailProvider') ?? 'console';
    this.smsProvider = config.get<string>('notifications.smsProvider') ?? 'console';
  }

  async onModuleInit() {
    if (this.emailProvider !== 'smtp') return;
    try {
      await this.getTransporter().verify();
      this.logger.log('SMTP connection verified.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`SMTP connection failed to verify: ${message}`);
    }
  }

  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const port = this.config.get<number>('notifications.smtp.port') ?? 587;
    this.transporter = createTransport({
      host: this.config.get<string>('notifications.smtp.host'),
      port,
      secure: port === 465,
      requireTLS: port !== 465,
      auth: {
        user: this.config.get<string>('notifications.smtp.user'),
        // Gmail app passwords are shown with spaces for readability; strip them defensively.
        pass: (this.config.get<string>('notifications.smtp.password') ?? '').replace(/\s+/g, ''),
      },
    });
    return this.transporter;
  }

  /** Fetches a template for `language`, falling back to EN if that language's row doesn't exist. */
  private async getTemplate(key: string, language: Language) {
    const template = await this.prisma.emailTemplate.findFirst({
      where: { key, language, isActive: true },
    });
    if (template) return template;
    if (language === Language.EN) return null;

    return this.prisma.emailTemplate.findFirst({
      where: { key, language: Language.EN, isActive: true },
    });
  }

  private async sendEmail(to: string, subject: string, text: string, html: string): Promise<void> {
    if (this.emailProvider === 'console') {
      this.logger.log(`[email:console] -> ${to} | ${subject}\n${text}`);
      return;
    }

    if (this.emailProvider !== 'smtp') {
      this.logger.warn(`Email provider "${this.emailProvider}" not implemented yet.`);
      return;
    }

    try {
      await this.getTransporter().sendMail({
        from: this.config.get<string>('notifications.smtp.from'),
        to,
        subject,
        text,
        html,
      });
    } catch (error) {
      // Never log the transporter/auth config here — it carries the SMTP password.
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Failed to send email to ${to}: ${message}`);
      throw new Error('Failed to send email.');
    }
  }

  private otpFallbackMessage(code: string, language: Language) {
    return language === Language.RW
      ? `Umubare wawe wo kwemeza kuri Magnificat Smart Space ni: ${code}. Ntuwusangire n'undi muntu.`
      : `Your Magnificat Smart Space verification code is: ${code}. Do not share it with anyone.`;
  }

  async sendOtpEmail(
    email: string,
    code: string,
    language: Language = Language.EN,
    expiresInSeconds = 300,
  ): Promise<void> {
    const expiresInMinutes = String(Math.round(expiresInSeconds / 60));
    const template = await this.getTemplate(EMAIL_TEMPLATE_KEYS.OTP_VERIFICATION, language);

    if (!template) {
      this.logger.warn(
        `EmailTemplate "${EMAIL_TEMPLATE_KEYS.OTP_VERIFICATION}" not found — using fallback text. Run \`npm run prisma:seed\`.`,
      );
      const message = this.otpFallbackMessage(code, language);
      return this.sendEmail(
        email,
        'Your verification code',
        message,
        `<p>${escapeHtml(message)}</p>`,
      );
    }

    const vars = { code, expiresInMinutes };
    return this.sendEmail(
      email,
      renderTemplate(template.subject, vars),
      renderTemplate(template.bodyText, vars),
      renderTemplate(template.bodyHtml, vars),
    );
  }

  async sendStaffAccountCreatedEmail(
    email: string,
    fullName: string,
    role: string,
    language: Language = Language.EN,
  ): Promise<void> {
    const template = await this.getTemplate(EMAIL_TEMPLATE_KEYS.STAFF_ACCOUNT_CREATED, language);
    if (!template) {
      this.logger.warn(
        `EmailTemplate "${EMAIL_TEMPLATE_KEYS.STAFF_ACCOUNT_CREATED}" not found — skipping notification. Run \`npm run prisma:seed\`.`,
      );
      return;
    }

    const vars = { fullName, role, loginEmail: email };
    const htmlVars = {
      fullName: escapeHtml(fullName),
      role: escapeHtml(role),
      loginEmail: escapeHtml(email),
    };
    await this.sendEmail(
      email,
      renderTemplate(template.subject, vars),
      renderTemplate(template.bodyText, vars),
      renderTemplate(template.bodyHtml, htmlVars),
    );
  }

  sendOtpSms(phone: string, code: string, language: Language = Language.EN): Promise<void> {
    const message = this.otpFallbackMessage(code, language);
    if (this.smsProvider === 'console') {
      this.logger.log(`[sms:${this.smsProvider}] -> ${phone}: ${message}`);
      return Promise.resolve();
    }
    // TODO: wire a real SMS gateway (e.g. Africa's Talking) here.
    this.logger.warn(`SMS provider "${this.smsProvider}" not implemented yet.`);
    return Promise.resolve();
  }

  /**
   * "Receive low-stock notifications" (doc 3.11, stock manager). Called after
   * anything that can move stock down; emails every stock manager and admin
   * about the products that have fallen to or below their threshold. Best-effort
   * by design — a mail failure must never roll back the stock change that
   * triggered it, so this resolves rather than throwing.
   */
  async notifyLowStock(productIds: string[]): Promise<void> {
    if (productIds.length === 0) return;

    try {
      const setting = await this.prisma.platformSetting.findUnique({
        where: { key: LOW_STOCK_ALERTS_SETTING },
      });
      if (setting && setting.value === false) return;

      const inventories = await this.prisma.inventory.findMany({
        where: { productId: { in: productIds } },
        include: { product: true },
      });
      const low = inventories.filter((row) => row.quantityOnHand <= row.lowStockThreshold);
      if (low.length === 0) return;

      const recipients = await this.prisma.user.findMany({
        where: {
          role: { in: [Role.STOCK_MANAGER, Role.ADMIN] },
          status: 'ACTIVE',
          email: { not: null },
        },
        select: { email: true, fullName: true, language: true },
      });
      if (recipients.length === 0) return;

      const lines = low.map(
        (row) =>
          `- ${row.product.name} (${row.product.sku}): ${row.quantityOnHand} pieces on hand, ` +
          `threshold ${row.lowStockThreshold}`,
      );

      for (const recipient of recipients) {
        const template = await this.getTemplate(
          EMAIL_TEMPLATE_KEYS.LOW_STOCK_ALERT,
          recipient.language,
        );
        if (!template) {
          this.logger.warn(
            `EmailTemplate "${EMAIL_TEMPLATE_KEYS.LOW_STOCK_ALERT}" not found — skipping low-stock alert. Run \`npm run prisma:seed\`.`,
          );
          return;
        }

        const vars = {
          fullName: recipient.fullName,
          itemCount: String(low.length),
          items: lines.join('\n'),
        };
        const htmlVars = {
          fullName: escapeHtml(recipient.fullName),
          itemCount: String(low.length),
          items: lines.map((line) => escapeHtml(line)).join('<br />'),
        };
        await this.sendEmail(
          recipient.email!,
          renderTemplate(template.subject, vars),
          renderTemplate(template.bodyText, vars),
          renderTemplate(template.bodyHtml, htmlVars),
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to send low-stock alert: ${message}`);
    }
  }
}
