import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Errors the client can show in the user's own language.
 *
 * Every error the API raises on purpose carries a stable `code` (for example
 * `orders.deliveryLocked`) and the values it mentions as `params`. The
 * storefront looks the code up in its own translations; the English `message`
 * is what a caller that doesn't know the code (a script, `curl`, an old client)
 * still gets. The message is written once, here at the call site, as a template
 * — `{{name}}` placeholders are filled from `params`, and the client uses the
 * same `{{name}}` syntax in its translations.
 *
 *   throw notFound('orders.notFound', 'Order not found.');
 *   throw badRequest('orders.cannotMove', 'An order that is {{from}} cannot move to {{to}}.', { from, to });
 */
export type ErrorParams = Record<string, string | number>;

/** Fills `{{name}}` placeholders; a placeholder with no matching param is left as written. */
export const renderErrorMessage = (template: string, params?: ErrorParams): string =>
  template.replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) =>
    params && name in params ? String(params[name]) : placeholder,
  );

const body = (code: string, message: string, params?: ErrorParams) => ({
  message: renderErrorMessage(message, params),
  code,
  ...(params ? { params } : {}),
});

export const badRequest = (code: string, message: string, params?: ErrorParams) =>
  new BadRequestException(body(code, message, params));
export const unauthorized = (code: string, message: string, params?: ErrorParams) =>
  new UnauthorizedException(body(code, message, params));
export const forbidden = (code: string, message: string, params?: ErrorParams) =>
  new ForbiddenException(body(code, message, params));
export const notFound = (code: string, message: string, params?: ErrorParams) =>
  new NotFoundException(body(code, message, params));
export const conflict = (code: string, message: string, params?: ErrorParams) =>
  new ConflictException(body(code, message, params));
export const payloadTooLarge = (code: string, message: string, params?: ErrorParams) =>
  new PayloadTooLargeException(body(code, message, params));
export const unprocessable = (code: string, message: string, params?: ErrorParams) =>
  new UnprocessableEntityException(body(code, message, params));
export const internalError = (code: string, message: string, params?: ErrorParams) =>
  new InternalServerErrorException(body(code, message, params));
export const serviceUnavailable = (code: string, message: string, params?: ErrorParams) =>
  new ServiceUnavailableException(body(code, message, params));
export const notImplemented = (code: string, message: string, params?: ErrorParams) =>
  new NotImplementedException(body(code, message, params));
