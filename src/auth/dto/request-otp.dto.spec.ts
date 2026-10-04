import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { Language } from '@prisma/client';
import { validationException } from '@/common/errors/validation-errors';
import { RequestOtpDto } from './request-otp.dto';

describe('RequestOtpDto validation', () => {
  const pipe = new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
    exceptionFactory: validationException,
  });
  const validate = (body: Record<string, unknown>) =>
    pipe.transform(body, { type: 'body', metatype: RequestOtpDto });

  it.each([Language.EN, Language.RW])('accepts language %s with an email', async (language) => {
    await expect(validate({ email: 'person@example.com', language })).resolves.toEqual({
      email: 'person@example.com',
      language,
    });
  });

  it('accepts email-only requests without overriding the stored language', async () => {
    await expect(validate({ email: 'person@example.com' })).resolves.toEqual({
      email: 'person@example.com',
    });
  });

  it('rejects an unsupported language', async () => {
    await expect(validate({ email: 'person@example.com', language: 'FR' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('continues to reject unrecognized properties', async () => {
    await expect(validate({ email: 'person@example.com', extra: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
