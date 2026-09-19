import { Injectable, NotImplementedException } from '@nestjs/common';
import type {
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentProvider,
} from './payment-provider.interface';

/**
 * Visa/Mastercard integration point (e.g. Flutterwave, Stripe, DPO). No
 * integration exists yet, so this refuses instead of simulating a charge —
 * see `MomoProvider` for why. Customers pay with the bank details on the
 * quotation instead.
 */
@Injectable()
export class CardProvider implements PaymentProvider {
  initiate(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    return Promise.reject(
      new NotImplementedException(
        'Online card payment is not available yet. Pay using the bank details on your quotation, then confirm the payment on the order.',
      ),
    );
  }
}
