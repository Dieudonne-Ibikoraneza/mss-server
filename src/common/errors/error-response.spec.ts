/* eslint-disable @typescript-eslint/no-unsafe-assignment -- `expect.objectContaining(...)` matchers are typed `any` */
import { ArgumentsHost, HttpException, ValidationPipe } from '@nestjs/common';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { badRequest, notFound } from './app-error';
import { validationException } from './validation-errors';
import { HttpExceptionFilter } from '../filters/http-exception.filter';

const respond = (exception: unknown) => {
  const json = jest.fn();
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status: () => ({ json }) }),
      getRequest: () => ({ url: '/x' }),
    }),
  } as unknown as ArgumentsHost;
  new HttpExceptionFilter().catch(exception, host);
  return (json.mock.calls as [Record<string, unknown>][])[0][0];
};

describe('error responses carry a code and params for the client to translate', () => {
  it('keeps the English message and adds code + params', () => {
    const body = respond(
      badRequest('orders.cannotMove', 'An order that is {{from}} cannot move to {{to}}.', {
        from: 'PENDING',
        to: 'SHIPPED',
      }),
    );
    expect(body).toMatchObject({
      statusCode: 400,
      message: 'An order that is PENDING cannot move to SHIPPED.',
      code: 'orders.cannotMove',
      params: { from: 'PENDING', to: 'SHIPPED' },
    });
    expect(respond(notFound('orders.notFound', 'Order not found.'))).toMatchObject({
      statusCode: 404,
      code: 'orders.notFound',
    });
  });

  it('gives the framework’s own errors generic codes, and an unexpected crash a safe message', () => {
    expect(respond(new HttpException('ThrottlerException: Too Many Requests', 429))).toMatchObject({
      code: 'common.tooManyRequests',
    });
    expect(respond(new HttpException('Unauthorized', 401))).toMatchObject({
      code: 'common.unauthorized',
    });
    expect(respond(new HttpException('Cannot GET /nope', 404))).toMatchObject({
      code: 'common.routeNotFound',
    });
    expect(
      respond(new HttpException('Validation failed (enum string is expected)', 400)),
    ).toMatchObject({ code: 'validation.invalidParameter' });
    const crash = respond(new Error('secret database detail'));
    expect(crash).toMatchObject({
      statusCode: 500,
      message: 'Internal server error',
      code: 'common.internalError',
    });
    expect(JSON.stringify(crash)).not.toContain('secret');
  });

  it('leaves an unrecognised error uncoded, so its own message still reaches the user', () => {
    expect(respond(new HttpException('File too large', 413))).not.toHaveProperty('code');
  });
});

class Body {
  @IsString() @IsNotEmpty() city: string;
  @IsString() @MaxLength(5) name: string;
}

describe('validation errors are structured per field', () => {
  it('lists each failed rule with its field and limit, and keeps the English list', async () => {
    const pipe = new ValidationPipe({ exceptionFactory: validationException });
    const error = await pipe
      .transform({ city: '', name: 'far too long' }, { type: 'body', metatype: Body })
      .catch((e: unknown) => e as HttpException);
    const body = (error as HttpException).getResponse() as {
      message: string[];
      code: string;
      errors: { field: string; constraint: string; limit?: number }[];
    };
    expect(body.code).toBe('validation.failed');
    expect(body.message.length).toBe(2);
    expect(body.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'city', constraint: 'isNotEmpty' }),
        expect.objectContaining({ field: 'name', constraint: 'maxLength', limit: 5 }),
      ]),
    );
  });
});
