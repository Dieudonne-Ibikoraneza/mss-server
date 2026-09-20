import { badRequest } from '@/common/errors/app-error';
import { SETTINGS_DEFAULTS, type SettingKey } from './settings.defaults';

/** Anything a person types and another person reads — no control characters (they break PDFs and emails). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const MAX_TEXT_LENGTH = 200;

const fail = (
  key: string,
  code: string,
  message: string,
  params?: Record<string, string | number>,
): never => {
  throw badRequest(code, `Setting "{{key}}" ${message}`, { key, ...params });
};

/**
 * Checks one value against what its setting is meant to hold, and returns the
 * value to store (text is trimmed). Before this, the settings endpoint stored
 * whatever JSON it was given — a number for the platform name, a paragraph for a
 * bank SWIFT code — and everything that read it had to cope.
 */
export function validateSettingValue(key: SettingKey, value: unknown): string | number | boolean {
  const expected = typeof SETTINGS_DEFAULTS[key];

  if (expected === 'boolean') {
    if (typeof value !== 'boolean') fail(key, 'settings.mustBeBoolean', 'must be true or false.');
    return value as boolean;
  }

  if (expected === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value))
      fail(key, 'settings.mustBeNumber', 'must be a number.');
    const number = value as number;
    if (key === 'calculator.defaultWastagePercent' && (number < 0 || number > 100)) {
      fail(key, 'settings.mustBePercent', 'must be between 0 and 100.');
    }
    if (key === 'stock.lowStockThreshold' && number < 0)
      fail(key, 'settings.mustNotBeNegative', 'must not be negative.');
    return number;
  }

  if (typeof value !== 'string') fail(key, 'settings.mustBeText', 'must be text.');
  const text = (value as string).trim();
  if (text.length > MAX_TEXT_LENGTH)
    fail(key, 'settings.tooLong', 'must be at most {{max}} characters.', { max: MAX_TEXT_LENGTH });
  if (CONTROL_CHARACTERS.test(text))
    fail(key, 'settings.noControlCharacters', 'must not contain control characters.');

  if (key === 'platform.defaultLanguage' && text !== 'EN' && text !== 'RW') {
    fail(key, 'settings.invalidLanguage', 'must be EN or RW.');
  }
  if (key === 'platform.defaultCurrency' && !/^[A-Z]{3}$/.test(text)) {
    fail(key, 'settings.invalidCurrency', 'must be a 3-letter currency code such as RWF.');
  }
  if (key === 'support.email' && text !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
    fail(key, 'settings.invalidEmail', 'must be a valid email address.');
  }
  if (
    key === 'payment.bankSwift' &&
    text !== '' &&
    !/^[A-Za-z0-9]{8}([A-Za-z0-9]{3})?$/.test(text)
  ) {
    fail(key, 'settings.invalidSwift', 'must be an 8 or 11 character SWIFT/BIC code.');
  }
  if (key === 'payment.bankSwift') return text.toUpperCase();
  return text;
}
