import { OtpService } from './otp.service';

/** In-memory stand-in for RedisService — just enough of its surface for OtpService. */
const fakeRedis = () => {
  const store = new Map<string, unknown>();
  return {
    get: (key: string) => Promise.resolve(store.get(key) ?? null),
    set: (key: string, value: unknown) => Promise.resolve(void store.set(key, value)),
    setIfAbsent: (key: string, value: unknown) => {
      if (store.has(key)) return Promise.resolve(false);
      store.set(key, value);
      return Promise.resolve(true);
    },
    del: (key: string) => Promise.resolve(store.delete(key) ? 1 : 0),
    incr: (key: string) => {
      const next = Number(store.get(key) ?? 0) + 1;
      store.set(key, next);
      return Promise.resolve(next);
    },
  };
};

const build = (
  settings: Record<string, unknown>,
  notifications: { sendOtpEmail: jest.Mock; sendOtpSms?: jest.Mock },
) =>
  new OtpService(
    fakeRedis() as never,
    notifications as never,
    { get: (key: string) => ({ 'otp.length': 4, ...settings })[key] } as never,
  );

describe('OtpService: delivery failures and the test bypass', () => {
  const failingEmail = () => ({
    sendOtpEmail: jest.fn().mockRejectedValue(new Error('Failed to send email.')),
  });

  it('a failed email does not fail the request', async () => {
    const notifications = failingEmail();
    const otp = build({ 'app.env': 'production' }, notifications);

    await expect(otp.send('a@example.test', 'email', 'register')).resolves.toMatchObject({
      expiresInSeconds: expect.any(Number) as number,
    });
    expect(notifications.sendOtpEmail).toHaveBeenCalledTimes(1);
  });

  it('a failed SMS does not fail the request either', async () => {
    const otp = build(
      { 'app.env': 'production' },
      { sendOtpEmail: jest.fn(), sendOtpSms: jest.fn().mockRejectedValue(new Error('down')) },
    );
    await expect(otp.send('+250788000000', 'sms', 'login')).resolves.toBeDefined();
  });

  it('the bypass code is ignored in production by default', async () => {
    const otp = build({ 'app.env': 'production', 'otp.devBypassCode': '1234' }, failingEmail());
    await otp.send('a@example.test', 'email', 'login');
    // code never delivered and the bypass is off, so 1234 is just a wrong guess
    expect(await otp.verify('a@example.test', 'login', '1234')).toBe(false);
  });

  it('the bypass code works in production once explicitly allowed — without any email attempt', async () => {
    const notifications = failingEmail();
    const otp = build(
      {
        'app.env': 'production',
        'otp.devBypassCode': '1234',
        'otp.allowBypassInProduction': true,
      },
      notifications,
    );
    await otp.send('a@example.test', 'email', 'login');
    expect(notifications.sendOtpEmail).not.toHaveBeenCalled();
    expect(await otp.verify('a@example.test', 'login', '1234')).toBe(true);
  });

  it('the bypass code still works outside production, as before', async () => {
    const otp = build({ 'app.env': 'development', 'otp.devBypassCode': '1234' }, failingEmail());
    expect(await otp.verify('b@example.test', 'login', '1234')).toBe(true);
  });

  it('the opt-in does nothing when the bypass code is set empty', async () => {
    const otp = build(
      { 'app.env': 'production', 'otp.devBypassCode': '', 'otp.allowBypassInProduction': true },
      failingEmail(),
    );
    await otp.send('a@example.test', 'email', 'login');
    expect(await otp.verify('a@example.test', 'login', '1234')).toBe(false);
  });
});
