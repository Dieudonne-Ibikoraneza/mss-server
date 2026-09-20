import { LOW_STOCK_ALERTS_SETTING } from '@/notifications/notifications.service';
import { LOW_STOCK_THRESHOLD_SETTING } from '@/common/utils/stock-status';

/**
 * Every platform setting the app knows about, with the value it falls back to
 * when no row has been written yet. `GET /settings` merges stored rows over
 * these, so the admin screen and the storefront always receive a complete,
 * fully-typed settings object even on a fresh database.
 *
 * This is also the allow-list: `PATCH /settings` rejects any key not listed
 * here, so the table can't accumulate arbitrary keys.
 */
export const SETTINGS_DEFAULTS = {
  'platform.name': 'Magnificat Smart Space',
  'platform.defaultCurrency': 'RWF',
  'platform.defaultLanguage': 'EN',
  'platform.version': '1.0.0',

  [LOW_STOCK_ALERTS_SETTING]: true,
  /** One threshold, shared by every product — not settable per product. */
  [LOW_STOCK_THRESHOLD_SETTING]: 20,
  'notifications.orderUpdates': true,
  'notifications.systemNotifications': true,

  // Where customers pay, printed on every quotation PDF. Empty until an admin
  // enters the business's real details (Settings → Payment details): the app
  // never invents a MoMo code or a bank account for customers to pay into. A
  // payment method with no number set is left off the quotation.
  'payment.momoCode': '',
  'payment.momoName': '',
  'payment.bankName': '',
  'payment.bankAccountName': '',
  'payment.bankAccountNumber': '',
  'payment.bankSwift': '',

  // Support channels offered when a customer needs help with an order.
  'support.phone': '+250 788 300 400',
  'support.email': 'support@magnificatsmartspace.rw',
  'support.whatsapp': '+250 788 300 400',

  /** Wastage allowance the floor-plan calculator suggests, as a percentage. */
  'calculator.defaultWastagePercent': 10,
} as const;

export type SettingKey = keyof typeof SETTINGS_DEFAULTS;

export const SETTING_KEYS = Object.keys(SETTINGS_DEFAULTS) as SettingKey[];

/** Settings safe and useful to an anonymous storefront visitor. */
export const PUBLIC_SETTING_KEYS = [
  'platform.name',
  'platform.defaultCurrency',
  'platform.defaultLanguage',
  'support.phone',
  'support.email',
  'support.whatsapp',
  'calculator.defaultWastagePercent',
] as const satisfies readonly SettingKey[];

export type PublicSettingKey = (typeof PUBLIC_SETTING_KEYS)[number];

const KNOWN_KEYS = new Set<string>(SETTING_KEYS);

export const isSettingKey = (key: string): key is SettingKey => KNOWN_KEYS.has(key);
