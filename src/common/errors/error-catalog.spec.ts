import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderErrorMessage } from './app-error';

/**
 * Every error code this server can raise must have a sentence in both languages
 * in the storefront's locale files (`apiErrors`). Adding `badRequest('x.y', …)`
 * without translating it fails here, so no error message can quietly be shown
 * in English to a Kinyarwanda user. Skipped when the client isn't checked out
 * next to the server.
 */
const clientLocales = resolve(__dirname, '../../../../client/src/lib/i18n/locales');
const describeIfClient = existsSync(clientLocales) ? describe : describe.skip;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });

const HELPER =
  /\b(?:badRequest|notFound|forbidden|conflict|unauthorized|serviceUnavailable|payloadTooLarge|unprocessable|internalError|notImplemented)\(\s*'([\w.]+)',\s*(['"])((?:\\.|(?!\2).)*)\2/gs;
const SETTING_FAIL = /fail\(\s*key,\s*'([\w.]+)',\s*'((?:\\.|[^'\\])*)'/g;
const RAW_CODE = /code:\s*'([\w.]+)'/g; // HttpException bodies and the filter's generic codes

/** code → English template, read from the server's own source. */
const serverCodes = (): Map<string, string> => {
  const codes = new Map<string, string>();
  for (const file of sourceFiles(resolve(__dirname, '../..'))) {
    const source = readFileSync(file, 'utf8');
    for (const [, code, , message] of source.matchAll(HELPER))
      codes.set(code, message.replace(/\\(['"])/g, '$1'));
    for (const [, code, message] of source.matchAll(SETTING_FAIL))
      codes.set(code, `Setting "{{key}}" ${message}`);
    for (const [, code] of source.matchAll(RAW_CODE)) if (!codes.has(code)) codes.set(code, '');
  }
  return codes;
};

const placeholders = (text: string) =>
  [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort();

describeIfClient('API error codes are translated', () => {
  const load = (lang: string) =>
    (
      JSON.parse(readFileSync(join(clientLocales, lang, 'common.json'), 'utf8')) as {
        apiErrors: Record<string, string>;
      }
    ).apiErrors;
  const en = load('en');
  const rw = load('rw');
  const codes = serverCodes();

  it('finds the server’s codes (guards against the scan silently matching nothing)', () => {
    expect(codes.size).toBeGreaterThan(100);
    expect(codes.has('orders.notFound')).toBe(true);
  });

  it.each(['en', 'rw'] as const)('every server code has a %s sentence', (lang) => {
    const catalog = lang === 'en' ? en : rw;
    const missing = [...codes.keys()].filter((code) => !catalog[code]);
    expect(missing).toEqual([]);
  });

  it('a translation mentions exactly the values the server passes (no lost or invented {{placeholders}})', () => {
    const problems: string[] = [];
    for (const [code, template] of codes) {
      if (!template) continue;
      for (const [lang, catalog] of [
        ['en', en],
        ['rw', rw],
      ] as const) {
        if (
          JSON.stringify(placeholders(catalog[code] ?? '')) !==
          JSON.stringify(placeholders(template))
        ) {
          problems.push(`${lang} ${code}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('the English catalog says what the server says', () => {
    const different = [...codes]
      .filter(([code, template]) => template && en[code] !== template)
      .map(([code]) => code);
    expect(different).toEqual([]);
  });

  it('the framework’s generic errors and every validation rule in use are translated', () => {
    for (const key of [
      'common.internalError',
      'common.tooManyRequests',
      'common.unauthorized',
      'common.forbidden',
      'common.routeNotFound',
      'common.network',
      'validation.failed',
      'validation.invalidParameter',
      'validation.isNotEmpty',
      'validation.maxLength',
      'validation.isUUID',
      'validation.isEnum',
    ]) {
      expect(en[key]).toBeTruthy();
      expect(rw[key]).toBeTruthy();
    }
  });
});

describe('renderErrorMessage', () => {
  it('fills placeholders and leaves unknown ones as written', () => {
    expect(renderErrorMessage('{{a}} then {{b}}', { a: 1 })).toBe('1 then {{b}}');
    expect(renderErrorMessage('no params')).toBe('no params');
  });
});
