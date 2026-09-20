import { BadRequestException, Logger } from '@nestjs/common';
import { readPaymentDetails } from './payment-details';
import { SETTINGS_DEFAULTS, type SettingKey } from './settings.defaults';
import { SettingsService } from './settings.service';
import { validateSettingValue } from './settings.validation';

describe('setting values are checked and cleaned before they are stored', () => {
  const ok = (key: SettingKey, value: unknown) => validateSettingValue(key, value);
  const bad = (key: SettingKey, value: unknown) =>
    expect(() => validateSettingValue(key, value)).toThrow(BadRequestException);

  it('text is trimmed', () => {
    expect(ok('payment.bankName', '  Bank of Kigali  ')).toBe('Bank of Kigali');
  });

  it('a value must be the kind of thing the setting holds', () => {
    bad('platform.name', 42);
    bad('notifications.orderUpdates', 'yes');
    bad('stock.lowStockThreshold', '20');
    bad('stock.lowStockThreshold', Number.NaN);
  });

  it('ranges and formats', () => {
    bad('stock.lowStockThreshold', -1);
    bad('calculator.defaultWastagePercent', 101);
    expect(ok('calculator.defaultWastagePercent', 12.5)).toBe(12.5);
    bad('platform.defaultLanguage', 'FR');
    bad('platform.defaultCurrency', 'rwf');
    bad('support.email', 'not-an-email');
    expect(ok('support.email', '')).toBe('');
  });

  it('payment details: length, control characters, SWIFT shape (and SWIFT is stored upper-case)', () => {
    bad('payment.momoCode', 'x'.repeat(201));
    bad('payment.bankAccountNumber', '123\n456'); // would break the PDF layout
    bad('payment.bankSwift', 'NOTASWIFT!');
    bad('payment.bankSwift', 'BKIG');
    expect(ok('payment.bankSwift', 'bkigrwrw')).toBe('BKIGRWRW');
    expect(ok('payment.bankSwift', 'BKIGRWRWXXX')).toBe('BKIGRWRWXXX');
    expect(ok('payment.momoCode', '*182*8*1*45231#')).toBe('*182*8*1*45231#');
    expect(ok('payment.momoCode', '')).toBe(''); // a method can be switched off
  });

  it('a fresh installation invents no payment details', () => {
    for (const key of Object.keys(SETTINGS_DEFAULTS).filter((k) => k.startsWith('payment.'))) {
      expect(SETTINGS_DEFAULTS[key as SettingKey]).toBe('');
    }
  });
});

describe('SettingsService#update', () => {
  const build = (stored: { key: string; value: unknown }[] = []) => {
    const prisma = {
      platformSetting: {
        findMany: jest.fn().mockResolvedValue(stored),
        upsert: jest.fn((args: unknown) => args),
      },
      $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
    };
    return { service: new SettingsService(prisma as never), prisma };
  };

  it('rejects a bad value without writing anything — even alongside good ones', async () => {
    const { service, prisma } = build();
    await expect(
      service.update({ 'platform.name': 'Shop', 'payment.bankSwift': '!!!' }, 'admin-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('logs who changed the payment details, and only when they actually changed', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { service } = build([{ key: 'payment.momoCode', value: '*111#' }]);

    await service.update({ 'payment.momoCode': '*111#', 'platform.name': 'Shop' }, 'admin-1'); // unchanged
    expect(warn).not.toHaveBeenCalled();

    await service.update(
      { 'payment.momoCode': '*222#', 'payment.bankSwift': 'BKIGRWRW' },
      'admin-7',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('admin-7');
    expect(line).toContain('payment.momoCode');
    expect(line).toContain('payment.bankSwift');
    expect(line).not.toContain('*222#'); // the trail names the fields, it does not copy the numbers into the logs
    warn.mockRestore();
  });
});

describe('readPaymentDetails', () => {
  it('returns what is stored, empty for anything that is not', async () => {
    const prisma = {
      platformSetting: {
        findMany: jest.fn().mockResolvedValue([
          { key: 'payment.momoCode', value: '*182*8*1*1#' },
          { key: 'payment.bankName', value: 42 }, // a bad legacy value is ignored, not printed
        ]),
      },
    };
    expect(await readPaymentDetails(prisma as never)).toEqual({
      momoCode: '*182*8*1*1#',
      momoName: '',
      bankName: '',
      bankAccountName: '',
      bankAccountNumber: '',
      bankSwift: '',
    });
  });
});
