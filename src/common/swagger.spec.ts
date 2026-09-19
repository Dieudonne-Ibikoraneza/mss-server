import type { NextFunction, Request, Response } from 'express';
import { validationSchema } from '@/config/validation.schema';
import { docsBasicAuth, resolveDocsEnabled } from './swagger';

describe('resolveDocsEnabled', () => {
  it.each([
    ['development', undefined, true],
    ['test', undefined, true],
    ['production', undefined, false],
    ['production', '', false],
    ['production', 'false', false],
    ['production', 'true', true],
    ['production', ' TRUE ', true],
    ['development', 'false', false],
  ])('env=%s SWAGGER_ENABLED=%j -> %s', (env, explicit, expected) => {
    expect(resolveDocsEnabled(env, explicit)).toBe(expected);
  });
});

describe('docsBasicAuth', () => {
  const middleware = docsBasicAuth('docs-admin', 'a-long: password');

  const run = (authorization?: string) => {
    const res = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      send: jest.fn(),
    };
    const next = jest.fn();
    middleware(
      { headers: { authorization } } as unknown as Request,
      res as unknown as Response,
      next as NextFunction,
    );
    return { res, next };
  };
  const basic = (credentials: string) => `Basic ${Buffer.from(credentials).toString('base64')}`;

  it('lets the right credentials through (a password may itself contain a colon)', () => {
    const { next, res } = run(basic('docs-admin:a-long: password'));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    ['no header', undefined],
    ['a bearer token', 'Bearer abc'],
    ['a wrong password', basic('docs-admin:nope')],
    ['a wrong user', basic('someone:a-long: password')],
    ['no separator', basic('docs-admin')],
    ['garbage', 'Basic !!!'],
  ])('answers 401 with a Basic challenge for %s', (_label, header) => {
    const { next, res } = run(header);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.setHeader).toHaveBeenCalledWith(
      'WWW-Authenticate',
      expect.stringContaining('Basic'),
    );
  });
});

describe('environment validation — API docs', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'x'.repeat(20),
    JWT_REFRESH_SECRET: 'y'.repeat(20),
  };
  const errorFor = (env: Record<string, string>) =>
    validationSchema.validate({ ...base, ...env }).error;

  it('allows production with the docs off (the default)', () => {
    expect(errorFor({ NODE_ENV: 'production' })).toBeUndefined();
    expect(errorFor({ NODE_ENV: 'production', SWAGGER_ENABLED: 'false' })).toBeUndefined();
  });

  it('refuses to start in production with the docs on but unprotected', () => {
    expect(errorFor({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' })?.message).toMatch(
      /SWAGGER_USER/,
    );
    expect(
      errorFor({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true', SWAGGER_USER: 'admin' })?.message,
    ).toMatch(/SWAGGER_PASSWORD/);
  });

  it('requires a real password when the docs are on in production', () => {
    expect(
      errorFor({
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'true',
        SWAGGER_USER: 'admin',
        SWAGGER_PASSWORD: 'short',
      })?.message,
    ).toMatch(/SWAGGER_PASSWORD/);
    expect(
      errorFor({
        NODE_ENV: 'production',
        SWAGGER_ENABLED: 'true',
        SWAGGER_USER: 'admin',
        SWAGGER_PASSWORD: 'a-long-enough-password',
      }),
    ).toBeUndefined();
  });

  it('keeps development frictionless (credentials optional)', () => {
    expect(errorFor({ NODE_ENV: 'development' })).toBeUndefined();
    expect(errorFor({ NODE_ENV: 'development', SWAGGER_ENABLED: 'true' })).toBeUndefined();
  });

  it('rejects a malformed SWAGGER_ENABLED', () => {
    expect(errorFor({ SWAGGER_ENABLED: 'yes' })?.message).toMatch(/SWAGGER_ENABLED/);
  });
});

describe('environment validation — session cookie', () => {
  const base = {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    JWT_ACCESS_SECRET: 'x'.repeat(20),
    JWT_REFRESH_SECRET: 'y'.repeat(20),
  };
  const errorFor = (env: Record<string, string>) =>
    validationSchema.validate({ ...base, ...env }).error;

  it('accepts the defaults in development and production', () => {
    expect(errorFor({ NODE_ENV: 'development' })).toBeUndefined();
    expect(errorFor({ NODE_ENV: 'production' })).toBeUndefined();
  });

  it('refuses SameSite=None without Secure (browsers would drop the cookie)', () => {
    expect(errorFor({ COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' })?.message).toMatch(
      /COOKIE_SAMESITE=none requires COOKIE_SECURE/,
    );
    expect(errorFor({ COOKIE_SAMESITE: 'None' })?.message).toMatch(/requires COOKIE_SECURE/); // dev default Secure=false
    expect(errorFor({ COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'true' })).toBeUndefined();
    expect(errorFor({ NODE_ENV: 'production', COOKIE_SAMESITE: 'none' })).toBeUndefined();
  });

  it('refuses an insecure session cookie in production', () => {
    expect(errorFor({ NODE_ENV: 'production', COOKIE_SECURE: 'false' })?.message).toMatch(
      /must not be false in production/,
    );
  });

  it('rejects an unknown SameSite value', () => {
    expect(errorFor({ COOKIE_SAMESITE: 'sometimes' })?.message).toMatch(/COOKIE_SAMESITE/);
  });
});
