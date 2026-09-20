import { Injectable } from '@nestjs/common';
import { notImplemented } from '@/common/errors/app-error';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * MTN/Airtel Mobile Money integration point. No integration exists yet, so
 * this refuses instead of pretending: an earlier version returned a fake
 * "pending" request-to-pay that could never settle, which made a payment look
 * like it had really been started. Customers pay with the MoMo code shown on
 * the quotation instead (see the quotation endpoints in `orders`).
 *
 * When the real Collections API is wired in, `initiate` must call it and
 * return the provider's own reference — and a verified settlement path (a
 * signature-checked webhook or polling the provider) has to be built with it.
 */
@Injectable()
export class MomoProvider implements PaymentProvider {
  initiate(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    return Promise.reject(
      notImplemented(
        'payments.momoUnavailable',
        'Online Mobile Money payment is not available yet. Pay using the MoMo details on your quotation, then confirm the payment on the order.',
      ),
    );
  }
}
