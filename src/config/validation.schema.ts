import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().default(4000),
  // 'api' only — main.ts appends the URI version segment, giving /api/v1/...
  API_PREFIX: Joi.string().default('api'),
  CORS_ORIGINS: Joi.string().default('http://localhost:3000'),

  // API docs (Swagger UI at /docs): on outside production, off in production
  // unless SWAGGER_ENABLED=true — and then they must sit behind Basic auth.
  SWAGGER_ENABLED: Joi.string().valid('true', 'false').optional(),
  SWAGGER_USER: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.when('SWAGGER_ENABLED', {
      is: 'true',
      then: Joi.string().min(1).required(),
      otherwise: Joi.string().optional(),
    }),
    otherwise: Joi.string().optional(),
  }),
  SWAGGER_PASSWORD: Joi.when('NODE_ENV', {
    is: 'production',
    then: Joi.when('SWAGGER_ENABLED', {
      is: 'true',
      then: Joi.string().min(12).required(),
      otherwise: Joi.string().optional(),
    }),
    otherwise: Joi.string().optional(),
  }),

  // Refresh-token cookie. SameSite=None is only valid together with Secure.
  COOKIE_SECURE: Joi.string().valid('true', 'false').optional(),
  COOKIE_SAMESITE: Joi.string()
    .valid('lax', 'strict', 'none', 'Lax', 'Strict', 'None')
    .default('lax'),
  COOKIE_DOMAIN: Joi.string().optional(),
  COOKIE_PATH: Joi.string().optional(),

  DATABASE_URL: Joi.string().uri().required(),
  REDIS_URL: Joi.string().uri().default('redis://localhost:6379'),

  JWT_ACCESS_SECRET: Joi.string().min(16).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(16).required(),
  JWT_REFRESH_TTL: Joi.string().default('30d'),

  OTP_LENGTH: Joi.number().default(4),
  OTP_TTL_SECONDS: Joi.number().default(300),
  OTP_MAX_ATTEMPTS: Joi.number().default(5),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().default(60),

  THROTTLE_TTL_MS: Joi.number().default(60000),
  THROTTLE_LIMIT: Joi.number().default(100),

  STORAGE_DRIVER: Joi.string().valid('local', 'supabase').default('local'),
  STORAGE_LOCAL_PATH: Joi.string().default('./uploads'),
  SUPABASE_PROJECT_ID: Joi.string().default('yinatdmepjyfvqjekbjp'),
  SUPABASE_URL: Joi.string().uri().optional(),
  SUPABASE_SERVICE_ROLE_KEY: Joi.when('STORAGE_DRIVER', {
    is: 'supabase',
    then: Joi.string().min(20).required(),
    otherwise: Joi.string().optional(),
  }),
}).custom((env: Record<string, string | undefined>, helpers) => {
  const sameSite = (env.COOKIE_SAMESITE ?? 'lax').toLowerCase();
  const secure =
    env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production';
  if (sameSite === 'none' && !secure) {
    return helpers.message({
      custom: 'COOKIE_SAMESITE=none requires COOKIE_SECURE=true (browsers reject it otherwise).',
    });
  }
  if (env.NODE_ENV === 'production' && !secure) {
    return helpers.message({
      custom:
        'COOKIE_SECURE must not be false in production: the session cookie would travel over plain HTTP.',
    });
  }
  return env;
});
