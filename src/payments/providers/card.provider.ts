import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentProvider,
} from './payment-provider.interface';

/** Visa/Mastercard integration point (e.g. Flutterwave, Stripe, DPO). */
@Injectable()
export class CardProvider implements PaymentProvider {
  private readonly logger = new Logger(CardProvider.name);
  private readonly configured: boolean;

  constructor(config: ConfigService) {
    this.configured = Boolean(config.get<string>('payments.card.baseUrl'));
  }

  initiate(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    if (!this.configured) {
      this.logger.warn('Card provider not configured; simulating a pending charge.');
    }
    // TODO: call the real card processor's charge/checkout API here once
    // CARD_PROVIDER_API_BASE_URL / CARD_PROVIDER_SECRET_KEY are set.
    return Promise.resolve({ providerRef: `card_${randomUUID()}`, status: 'PENDING' });
  }
}
