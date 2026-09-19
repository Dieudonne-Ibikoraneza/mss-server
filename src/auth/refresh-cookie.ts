import type { Request, Response } from 'express';

/**
 * The refresh token never reaches JavaScript: it travels only in this cookie
 * (`HttpOnly`, so page script — including anything an XSS injects — cannot read
 * it) and is scoped to the auth endpoints, the only routes that ever need it.
 * The short-lived access token, by contrast, is returned in the response body
 * and held in memory by the client.
 */
export const REFRESH_COOKIE_NAME = 'mss_refresh';

export interface RefreshCookieSettings {
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  /** Leave unset for a host-only cookie (the safest default). */
  domain?: string;
  /** Kept to the auth endpoints so the cookie isn't sent with every API call. */
  path: string;
}

/** Extracts the refresh token from the `Cookie` header, or `undefined` if absent. */
export const readRefreshCookie = (req: Pick<Request, 'headers'>): string | undefined => {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== REFRESH_COOKIE_NAME) continue;
    const value = part.slice(separator + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
};

export const setRefreshCookie = (
  res: Pick<Response, 'cookie'>,
  token: string,
  expiresAt: Date,
  settings: RefreshCookieSettings,
) => {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    path: settings.path,
    // Survives a browser restart for as long as the token itself is valid.
    maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
  });
};

/** Attributes must match the ones it was set with, or the browser keeps the old cookie. */
export const clearRefreshCookie = (
  res: Pick<Response, 'clearCookie'>,
  settings: RefreshCookieSettings,
) => {
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: settings.secure,
    sameSite: settings.sameSite,
    domain: settings.domain,
    path: settings.path,
  });
};
