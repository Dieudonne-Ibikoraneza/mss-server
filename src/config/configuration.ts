import { resolveDocsEnabled } from '@/common/swagger';

export default () => ({
  app: {
    env: process.env.NODE_ENV ?? 'development',
    port: parseInt(process.env.PORT ?? '4000', 10),
    apiPrefix: process.env.API_PREFIX ?? 'api',
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000')
      .split(',')
      .map((origin) => origin.trim()),
    /** Where staff/customer-facing links in emails point back to (e.g. "view your quotation"). */
    clientUrl: process.env.CLIENT_URL ?? 'http://localhost:3000',
  },
  /**
   * The Swagger UI at `/docs`. Off by default in production; see
   * `resolveDocsEnabled`. Credentials (HTTP Basic) are required in production.
   */
  docs: {
    enabled: resolveDocsEnabled(process.env.NODE_ENV ?? 'development', process.env.SWAGGER_ENABLED),
    user: process.env.SWAGGER_USER,
    password: process.env.SWAGGER_PASSWORD,
  },
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    // Unset (or empty) = no Redis: state falls back to Postgres and caching is off.
    url: process.env.REDIS_URL || undefined,
  },
  /**
   * The refresh-token cookie (see `auth/refresh-cookie.ts`). `Secure` by default
   * in production; `SameSite=Lax` works when the web app and API share a site
   * (same registrable domain, e.g. app.example.com + api.example.com, or
   * localhost on different ports). Only a genuinely cross-site deployment needs
   * `COOKIE_SAMESITE=none` — which browsers only accept together with `Secure`.
   */
  session: {
    cookieSecure:
      process.env.COOKIE_SECURE !== undefined && process.env.COOKIE_SECURE !== ''
        ? process.env.COOKIE_SECURE === 'true'
        : (process.env.NODE_ENV ?? 'development') === 'production',
    cookieSameSite: (process.env.COOKIE_SAMESITE ?? 'lax').toLowerCase(),
    cookieDomain: process.env.COOKIE_DOMAIN || undefined,
    cookiePath: process.env.COOKIE_PATH || `/${process.env.API_PREFIX ?? 'api'}/v1/auth`,
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET,
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
  },
  otp: {
    // 4 digits to match the frontend's 4-box OTP input.
    length: parseInt(process.env.OTP_LENGTH ?? '4', 10),
    ttlSeconds: parseInt(process.env.OTP_TTL_SECONDS ?? '300', 10),
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5', 10),
    resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? '60', 10),
    /**
     * Non-production only: this code always verifies for any destination, so
     * register/login can be tested end-to-end without a working email/SMS
     * provider. Set to an empty string to disable even in dev.
     */
    devBypassCode: process.env.OTP_DEV_BYPASS_CODE ?? '1234',
  },
  throttle: {
    ttlMs: parseInt(process.env.THROTTLE_TTL_MS ?? '60000', 10),
    limit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
  },
  orders: {
    /**
     * How long a newly-placed order holds its stock before it's automatically
     * cancelled and released, if it hasn't moved off PENDING (or had its
     * payment verified) by then. See `OrdersService`'s reservation methods.
     */
    reservationMinutes: parseInt(process.env.ORDER_RESERVATION_MINUTES ?? '60', 10),
  },
  notifications: {
    emailProvider: process.env.EMAIL_PROVIDER ?? 'console',
    smsProvider: process.env.SMS_PROVIDER ?? 'console',
    smtp: {
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT ?? '587', 10),
      user: process.env.SMTP_USER,
      password: process.env.SMTP_PASSWORD,
      from: process.env.SMTP_FROM ?? 'no-reply@magnificatsmartspace.rw',
    },
    sms: {
      apiKey: process.env.SMS_API_KEY,
      senderId: process.env.SMS_SENDER_ID ?? 'MAGNIFICAT',
    },
  },
  ai: {
    chat: {
      provider: process.env.AI_CHAT_PROVIDER ?? 'stub',
      apiKey: process.env.AI_CHAT_API_KEY,
      model: process.env.GEMINI_MODEL ?? 'gemini-3.6-flash',
    },
    image: {
      provider: process.env.AI_IMAGE_PROVIDER ?? 'stub',
      apiKey: process.env.AI_IMAGE_API_KEY || process.env.AI_CHAT_API_KEY,
      model: process.env.GEMINI_IMAGE_MODEL ?? 'gemini-3.1-flash-lite-image',
    },
  },
  translate: {
    // "stub" (leaves rw fields empty, no external calls) or "google" (real
    // Google Cloud Translation API) — same shape as the AI provider knobs
    // above, so local dev never needs real credentials.
    provider: process.env.TRANSLATE_PROVIDER ?? 'stub',
    googleApiKey: process.env.GOOGLE_TRANSLATE_API_KEY,
  },
  storage: {
    driver: process.env.STORAGE_DRIVER ?? 'local',
    localPath: process.env.STORAGE_LOCAL_PATH ?? './uploads',
    supabase: {
      projectId: process.env.SUPABASE_PROJECT_ID ?? 'yinatdmepjyfvqjekbjp',
      url:
        process.env.SUPABASE_URL ??
        `https://${process.env.SUPABASE_PROJECT_ID ?? 'yinatdmepjyfvqjekbjp'}.supabase.co`,
      serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
    s3: {
      bucket: process.env.S3_BUCKET,
      region: process.env.S3_REGION,
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  },
});
