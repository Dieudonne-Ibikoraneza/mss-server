import { validateSettingValue } from './settings.validation';

describe('support contact settings validation', () => {
  describe('support.phone (Rwandan numbers only)', () => {
    it('accepts Rwandan numbers and stores them in one format', () => {
      expect(validateSettingValue('support.phone', '+250 788 300 400')).toBe('+250 788 300 400');
      expect(validateSettingValue('support.phone', '  +250788300400  ')).toBe('+250 788 300 400');
      expect(validateSettingValue('support.phone', '+250-788-300-400')).toBe('+250 788 300 400');
      expect(validateSettingValue('support.phone', '+250 721 000 111')).toBe('+250 721 000 111');
    });

    it.each([
      '0788300400', // local format, no country code
      '788 300 400',
      '+250',
      '+25078',
      '+250 688 300 400', // does not start with 7
      '+250 788 300 40', // one digit short
      '+250 788 300 4000', // one digit too many
      '+1 415 555 0132', // not Rwanda
      '(+250) 788 300 400',
      '+250 788 abc 400',
      'call me',
      'javascript:alert(1)',
    ])('rejects %p', (value) => {
      expect(() => validateSettingValue('support.phone', value)).toThrow(/Rwandan phone number/);
    });
  });

  describe('support.whatsapp (any international number)', () => {
    it('accepts Rwandan numbers, stored in one format', () => {
      expect(validateSettingValue('support.whatsapp', '+250788300400')).toBe('+250 788 300 400');
    });

    it('accepts numbers from other countries', () => {
      expect(validateSettingValue('support.whatsapp', '+1 415 555 0132')).toBe('+1 415 555 0132');
      expect(validateSettingValue('support.whatsapp', ' +44 7911 123456 ')).toBe('+44 7911 123456');
    });

    it.each([
      '0788300400', // no country code
      '788 300 400',
      '+250', // too short
      '+1234', // too short
      '+12345678901234567', // more than 15 digits
      '+0 788 300 400', // no country code starts with 0
      '+250 788 abc 400',
      'call me',
      'javascript:alert(1)',
    ])('rejects %p', (value) => {
      expect(() => validateSettingValue('support.whatsapp', value)).toThrow(/international number/);
    });
  });

  it.each(['support.phone', 'support.whatsapp', 'support.email'] as const)(
    '%s may be cleared to hide the channel',
    (key) => {
      expect(validateSettingValue(key, '')).toBe('');
      expect(validateSettingValue(key, '   ')).toBe('');
    },
  );

  it('support.email is still checked', () => {
    expect(validateSettingValue('support.email', ' help@example.com ')).toBe('help@example.com');
    expect(() => validateSettingValue('support.email', 'not-an-email')).toThrow(/valid email/);
  });
});
