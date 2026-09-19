/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.any(...)` matchers are typed `any` */
import {
  clearRefreshCookie,
  readRefreshCookie,
  REFRESH_COOKIE_NAME,
  setRefreshCookie,
  type RefreshCookieSettings,
} from './refresh-cookie';

const settings: RefreshCookieSettings = { secure: true, sameSite: 'lax', path: '/api/v1/auth' };
const req = (cookie?: string) => ({ headers: { cookie } }) as never;

describe('readRefreshCookie', () => {
  it('finds the token among other cookies', () => {
    expect(readRefreshCookie(req(`a=1; ${REFRESH_COOKIE_NAME}=abc123; b=2`))).toBe('abc123');
  });

  it('works when it is the only cookie, with or without spaces', () => {
    expect(readRefreshCookie(req(`${REFRESH_COOKIE_NAME}=abc123`))).toBe('abc123');
    expect(readRefreshCookie(req(`x=1;${REFRESH_COOKIE_NAME}=abc123`))).toBe('abc123');
  });

  it.each([
    ['no Cookie header', undefined],
    ['an empty header', ''],
    ['other cookies only', 'a=1; b=2'],
    ['an empty value', `${REFRESH_COOKIE_NAME}=`],
    ['a malformed pair', 'garbage'],
  ])('is undefined for %s', (_label, header) => {
    expect(readRefreshCookie(req(header))).toBeUndefined();
  });

  it('does not match cookies that merely contain the name', () => {
    expect(
      readRefreshCookie(req(`x${REFRESH_COOKIE_NAME}=nope; ${REFRESH_COOKIE_NAME}x=nope`)),
    ).toBeUndefined();
  });

  it('keeps a value that itself contains "="', () => {
    expect(readRefreshCookie(req(`${REFRESH_COOKIE_NAME}=ab=cd`))).toBe('ab=cd');
  });
});

describe('setRefreshCookie / clearRefreshCookie', () => {
  it('sets an HttpOnly, Secure, SameSite cookie scoped to the auth path, living as long as the token', () => {
    const cookie = jest.fn();
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);

    setRefreshCookie({ cookie } as never, 'token-value', expiresAt, settings);

    expect(cookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, 'token-value', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: undefined,
      path: '/api/v1/auth',
      maxAge: expect.any(Number),
    });
    const options = (cookie.mock.calls as [string, string, { maxAge: number }][])[0][2];
    expect(options.maxAge).toBeGreaterThan(29 * 86_400_000);
    expect(options.maxAge).toBeLessThanOrEqual(30 * 86_400_000);
  });

  it('never gives an already-expired token a negative lifetime', () => {
    const cookie = jest.fn();
    setRefreshCookie({ cookie } as never, 't', new Date(0), settings);
    expect((cookie.mock.calls as [string, string, { maxAge: number }][])[0][2].maxAge).toBe(0);
  });

  it('honours the configured attributes', () => {
    const cookie = jest.fn();
    setRefreshCookie({ cookie } as never, 't', new Date(Date.now() + 1000), {
      secure: true,
      sameSite: 'none',
      domain: '.example.com',
      path: '/x',
    });
    expect(cookie).toHaveBeenCalledWith(
      REFRESH_COOKIE_NAME,
      't',
      expect.objectContaining({ sameSite: 'none', domain: '.example.com', path: '/x' }),
    );
  });

  it('clears with the same attributes it was set with (or the browser keeps it)', () => {
    const clearCookie = jest.fn();
    clearRefreshCookie({ clearCookie } as never, { ...settings, domain: '.example.com' });
    expect(clearCookie).toHaveBeenCalledWith(REFRESH_COOKIE_NAME, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      domain: '.example.com',
      path: '/api/v1/auth',
    });
  });
});
