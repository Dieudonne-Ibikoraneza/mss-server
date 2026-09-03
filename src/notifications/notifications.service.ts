import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport, type Transporter } from 'nodemailer';
import { Language, Role } from '@prisma/client';
import { PrismaService } from '@/prisma/prisma.service';
import { getLowStockThreshold } from '@/common/utils/stock-status';
import { escapeHtml, renderTemplate } from './template-renderer';

/** Keys of the `EmailTemplate` rows seeded by prisma/seed.ts — keep in sync with that file. */
export const EMAIL_TEMPLATE_KEYS = {
  OTP_VERIFICATION: 'OTP_VERIFICATION',
  STAFF_ACCOUNT_CREATED: 'STAFF_ACCOUNT_CREATED',
  LOW_STOCK_ALERT: 'LOW_STOCK_ALERT',
  QUOTATION_READY: 'QUOTATION_READY',
  ORDER_RESERVATION_EXPIRED: 'ORDER_RESERVATION_EXPIRED',
  ORDER_WAITLISTED: 'ORDER_WAITLISTED',
  ORDER_WAITLIST_AVAILABLE: 'ORDER_WAITLIST_AVAILABLE',
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
      // Nodemailer's own defaults leave `socketTimeout` unbounded, so a stalled
      // SMTP connection hangs `sendMail` indefinitely. Every caller here awaits
      // this inside a sequential loop over orders (reservation sweeps, waitlist
      // promotion) — one stuck send stalls that whole cron tick, and since the
      // schedule doesn't wait for the previous tick to finish, the next one
      // fires anyway, piling up concurrent runs that each eventually want a
      // database connection. Bounded timeouts turn a silent hang into a fast,
      // logged failure instead.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
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

      const [products, lowStockThreshold] = await Promise.all([
        this.prisma.product.findMany({ where: { id: { in: productIds } } }),
        getLowStockThreshold(this.prisma),
      ]);
      const low = products.filter((row) => Number(row.quantityOnHandSqm) <= lowStockThreshold);
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
          `- ${row.name} (${row.sku}): ${Number(row.quantityOnHandSqm)} m² on hand, ` +
          `threshold ${lowStockThreshold} m²`,
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

  /**
   * "The quotation is ready" — sent once the stock team costs an order's
   * transport and sends its quotation (`OrdersService#sendQuotation`), so the
   * customer knows to come back and pay rather than polling the app. Doubles
   * as the source for the frontend's global "quotation ready" dialog: the
   * customer doesn't have to see this email to get that prompt (it re-checks
   * `quotationStatus` on its own), but this is what tells them to go look.
   * Best-effort, same reasoning as `notifyLowStock`: a mail failure must
   * never undo the quotation that was already sent.
   */
  async sendQuotationReadyEmail(
    email: string,
    fullName: string,
    orderNumber: string,
    orderId: string,
    language: Language = Language.EN,
  ): Promise<void> {
    try {
      const template = await this.getTemplate(EMAIL_TEMPLATE_KEYS.QUOTATION_READY, language);
      if (!template) {
        this.logger.warn(
          `EmailTemplate "${EMAIL_TEMPLATE_KEYS.QUOTATION_READY}" not found — skipping quotation-ready email. Run \`npm run prisma:seed\`.`,
        );
        return;
      }

      const orderUrl = `${this.config.get<string>('app.clientUrl')}/account/orders/${orderId}`;
      const vars = { fullName, orderNumber, orderUrl };
      const htmlVars = {
        fullName: escapeHtml(fullName),
        orderNumber: escapeHtml(orderNumber),
        orderUrl,
      };
      await this.sendEmail(
        email,
        renderTemplate(template.subject, vars),
        renderTemplate(template.bodyText, vars),
        renderTemplate(template.bodyHtml, htmlVars),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to send quotation-ready email for order ${orderNumber}: ${message}`);
    }
  }

  /**
   * The other end of a stock reservation (`OrdersService#releaseExpiredReservations`):
   * the customer's payment window lapsed before the order advanced, so it was
   * auto-cancelled and its stock released back for other customers to buy.
   * Best-effort, same reasoning as `notifyLowStock`.
   */
  async sendOrderReservationExpiredEmail(
    email: string,
    fullName: string,
    orderNumber: string,
    language: Language = Language.EN,
  ): Promise<void> {
    try {
      const template = await this.getTemplate(
        EMAIL_TEMPLATE_KEYS.ORDER_RESERVATION_EXPIRED,
        language,
      );
      if (!template) {
        this.logger.warn(
          `EmailTemplate "${EMAIL_TEMPLATE_KEYS.ORDER_RESERVATION_EXPIRED}" not found — skipping reservation-expired email. Run \`npm run prisma:seed\`.`,
        );
        return;
      }

      const vars = { fullName, orderNumber };
      const htmlVars = { fullName: escapeHtml(fullName), orderNumber: escapeHtml(orderNumber) };
      await this.sendEmail(
        email,
        renderTemplate(template.subject, vars),
        renderTemplate(template.bodyText, vars),
        renderTemplate(template.bodyHtml, htmlVars),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Failed to send reservation-expired email for order ${orderNumber}: ${message}`,
      );
    }
  }

  /**
   * "Your order has been accepted, but part of it is waiting on stock" —
   * sent the moment `OrdersService#create` accepts a cart it can't fully
   * cover yet as a WAITLISTED order, so the customer has written
   * confirmation immediately instead of only the in-app order message.
   * Best-effort, same reasoning as `notifyLowStock`.
   */
  async sendOrderWaitlistedEmail(
    email: string,
    fullName: string,
    orderNumber: string,
    orderId: string,
    language: Language = Language.EN,
  ): Promise<void> {
    try {
      const template = await this.getTemplate(EMAIL_TEMPLATE_KEYS.ORDER_WAITLISTED, language);
      if (!template) {
        this.logger.warn(
          `EmailTemplate "${EMAIL_TEMPLATE_KEYS.ORDER_WAITLISTED}" not found — skipping waitlisted email. Run \`npm run prisma:seed\`.`,
        );
        return;
      }

      const orderUrl = `${this.config.get<string>('app.clientUrl')}/account/orders/${orderId}`;
      const vars = { fullName, orderNumber, orderUrl };
      const htmlVars = {
        fullName: escapeHtml(fullName),
        orderNumber: escapeHtml(orderNumber),
        orderUrl,
      };
      await this.sendEmail(
        email,
        renderTemplate(template.subject, vars),
        renderTemplate(template.bodyText, vars),
        renderTemplate(template.bodyHtml, htmlVars),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(`Failed to send waitlisted email for order ${orderNumber}: ${message}`);
    }
  }

  /**
   * The good half of the waitlist (`OrdersService#promoteWaitlistedOrders`):
   * enough stock finally came in to cover the order, so it was promoted to
   * PENDING — its payment window is now running — and the customer needs to
   * know to come pay before it lapses. Best-effort, same reasoning as
   * `notifyLowStock`.
   */
  async sendOrderWaitlistAvailableEmail(
    email: string,
    fullName: string,
    orderNumber: string,
    orderId: string,
    language: Language = Language.EN,
  ): Promise<void> {
    try {
      const template = await this.getTemplate(
        EMAIL_TEMPLATE_KEYS.ORDER_WAITLIST_AVAILABLE,
        language,
      );
      if (!template) {
        this.logger.warn(
          `EmailTemplate "${EMAIL_TEMPLATE_KEYS.ORDER_WAITLIST_AVAILABLE}" not found — skipping waitlist-available email. Run \`npm run prisma:seed\`.`,
        );
        return;
      }

      const orderUrl = `${this.config.get<string>('app.clientUrl')}/account/orders/${orderId}`;
      const vars = { fullName, orderNumber, orderUrl };
      const htmlVars = {
        fullName: escapeHtml(fullName),
        orderNumber: escapeHtml(orderNumber),
        orderUrl,
      };
      await this.sendEmail(
        email,
        renderTemplate(template.subject, vars),
        renderTemplate(template.bodyText, vars),
        renderTemplate(template.bodyHtml, htmlVars),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.warn(
        `Failed to send waitlist-available email for order ${orderNumber}: ${message}`,
      );
    }
  }
}
