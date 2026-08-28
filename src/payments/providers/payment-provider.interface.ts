export interface InitiatePaymentInput {
  orderId: string;
  amount: number;
  currency: string;
  phone?: string;
  cardToken?: string;
}

export interface InitiatePaymentResult {
  providerRef: string;
  redirectUrl?: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED';
}

export interface PaymentProvider {
  initiate(input: InitiatePaymentInput): Promise<InitiatePaymentResult>;
}
