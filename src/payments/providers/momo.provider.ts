import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * MTN/Airtel Mobile Money integration point. Until real credentials are
 * configured (MOMO_API_BASE_URL etc.) this simulates an async "request to
 * pay" flow so the rest of the order/payment pipeline can be built and
 * tested end-to-end.
 */
@Injectable()
export class MomoProvider implements PaymentProvider {
  private readonly logger = new Logger(MomoProvider.name);
  private readonly configured: boolean;

  constructor(config: ConfigService) {
    this.configured = Boolean(config.get<string>('payments.momo.baseUrl'));
  }

  initiate(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    if (!this.configured) {
      this.logger.warn('MoMo provider not configured; simulating a pending request-to-pay.');
    }
    // TODO: call the MTN MoMo Collections "request to pay" API here once
    // MOMO_API_BASE_URL / MOMO_API_KEY / MOMO_SUBSCRIPTION_KEY are set.
    return Promise.resolve({ providerRef: `momo_${randomUUID()}`, status: 'PENDING' });
  }
}
