import { PrismaService } from '@/prisma/prisma.service';
import { SETTINGS_DEFAULTS } from './settings.defaults';

/** Where customers pay — entered by an admin, printed on every quotation. */
export interface PaymentDetails {
  momoCode: string;
  momoName: string;
  bankName: string;
  bankAccountName: string;
  bankAccountNumber: string;
  bankSwift: string;
}

export const PAYMENT_SETTING_KEYS = [
  'payment.momoCode',
  'payment.momoName',
  'payment.bankName',
  'payment.bankAccountName',
  'payment.bankAccountNumber',
  'payment.bankSwift',
] as const;

const FIELD_OF: Record<(typeof PAYMENT_SETTING_KEYS)[number], keyof PaymentDetails> = {
  'payment.momoCode': 'momoCode',
  'payment.momoName': 'momoName',
  'payment.bankName': 'bankName',
  'payment.bankAccountName': 'bankAccountName',
  'payment.bankAccountNumber': 'bankAccountNumber',
  'payment.bankSwift': 'bankSwift',
};

/**
 * The current payment details, read straight from the settings table (the same
 * way `getLowStockThreshold` does, so callers don't need the settings module).
 * Read on every use — never cached — so an admin's change reaches the next
 * quotation a customer opens.
 */
export async function readPaymentDetails(prisma: PrismaService): Promise<PaymentDetails> {
  const rows = await prisma.platformSetting.findMany({
    where: { key: { in: [...PAYMENT_SETTING_KEYS] } },
  });
  const details: PaymentDetails = {
    momoCode: SETTINGS_DEFAULTS['payment.momoCode'],
    momoName: SETTINGS_DEFAULTS['payment.momoName'],
    bankName: SETTINGS_DEFAULTS['payment.bankName'],
    bankAccountName: SETTINGS_DEFAULTS['payment.bankAccountName'],
    bankAccountNumber: SETTINGS_DEFAULTS['payment.bankAccountNumber'],
    bankSwift: SETTINGS_DEFAULTS['payment.bankSwift'],
  };
  for (const row of rows) {
    const field = FIELD_OF[row.key as (typeof PAYMENT_SETTING_KEYS)[number]];
    if (field && typeof row.value === 'string') details[field] = row.value;
  }
  return details;
}
