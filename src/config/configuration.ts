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
  database: {
    url: process.env.DATABASE_URL,
  },
  redis: {
    url: process.env.REDIS_URL ?? 'redis://localhost:6379',
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
  payments: {
    momo: {
      baseUrl: process.env.MOMO_API_BASE_URL,
      apiKey: process.env.MOMO_API_KEY,
      apiUser: process.env.MOMO_API_USER,
      subscriptionKey: process.env.MOMO_SUBSCRIPTION_KEY,
    },
    card: {
      baseUrl: process.env.CARD_PROVIDER_API_BASE_URL,
      secretKey: process.env.CARD_PROVIDER_SECRET_KEY,
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
      model: process.env.GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image',
    },
    video: {
      provider: process.env.AI_VIDEO_PROVIDER ?? 'stub',
      apiKey: process.env.AI_VIDEO_API_KEY,
    },
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
