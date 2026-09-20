import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttpException ? exception.getResponse() : null;
    const details = (typeof body === 'object' && body !== null ? body : {}) as {
      message?: unknown;
      code?: unknown;
      params?: unknown;
      errors?: unknown;
    };

    const message = isHttpException
      ? typeof body === 'string'
        ? body
        : (details.message ?? exception.message)
      : 'Internal server error';

    // Errors raised on purpose carry their own code. The rest are the framework's
    // own — an unexpected failure, the rate limiter, a missing token, an unknown
    // route — and get a generic code so those are translated too.
    const code =
      typeof details.code === 'string'
        ? details.code
        : genericCode(status, typeof message === 'string' ? message : '');

    if (!isHttpException) {
      this.logger.error(exception instanceof Error ? exception.stack : exception);
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      path: request.url,
      timestamp: new Date().toISOString(),
      message,
      ...(code ? { code } : {}),
      ...(details.params ? { params: details.params } : {}),
      ...(details.errors ? { errors: details.errors } : {}),
    });
  }
}

/**
 * Codes for the framework's own errors, recognised by status and by the text the
 * framework uses. Anything else stays uncoded and is shown as the English
 * message it carries.
 */
const genericCode = (status: number, message: string): string | undefined => {
  if (status >= 500) return 'common.internalError';
  if (status === 429) return 'common.tooManyRequests';
  // Nest's own check of an enum-valued path or query parameter.
  if (status === 400 && /^validation failed \(/i.test(message))
    return 'validation.invalidParameter';
  if (status === 401 && /^unauthorized$/i.test(message)) return 'common.unauthorized';
  if (status === 403 && /^forbidden/i.test(message)) return 'common.forbidden';
  if (status === 404 && /^cannot (get|post|put|patch|delete) /i.test(message)) {
    return 'common.routeNotFound';
  }
  return undefined;
};
