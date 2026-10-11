import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response } from 'express';
import { AppError, AppErrorCode } from './app-error';
import { ErrorResponse } from './error-response';

const STATUS_TO_CODE: Partial<Record<HttpStatus, AppErrorCode>> = {
  [HttpStatus.BAD_REQUEST]: 'VALIDATION_ERROR',
  [HttpStatus.UNAUTHORIZED]: 'UNAUTHORIZED',
  [HttpStatus.FORBIDDEN]: 'FORBIDDEN',
  [HttpStatus.NOT_FOUND]: 'NOT_FOUND',
  [HttpStatus.CONFLICT]: 'CONFLICT',
};

/**
 * Translates every thrown error into the standard
 * `{ code, message, details?, requestId }` response shape.
 *
 * - `AppError` carries its own code/details.
 * - Other `HttpException`s (including the ValidationPipe's BadRequest) are
 *   mapped by status, and validation messages are surfaced in `details`.
 * - Anything else becomes a 500 INTERNAL_ERROR with a generic message so
 *   internals are never leaked to clients.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
    const requestId = request.requestId ?? randomUUID();

    const { status, body } = this.toErrorResponse(exception, requestId);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `Unhandled error [${requestId}] ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json(body);
  }

  private toErrorResponse(
    exception: unknown,
    requestId: string,
  ): { status: number; body: ErrorResponse } {
    if (exception instanceof AppError) {
      return {
        status: exception.getStatus(),
        body: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
          requestId,
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = STATUS_TO_CODE[status as HttpStatus] ?? 'INTERNAL_ERROR';
      const { message, details } = this.extractHttpExceptionBody(exception);
      return { status, body: { code, message, details, requestId } };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      body: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
        requestId,
      },
    };
  }

  private extractHttpExceptionBody(exception: HttpException): {
    message: string;
    details?: unknown;
  } {
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return { message: payload };
    }

    const record = payload as Record<string, unknown>;
    const rawMessage = record.message;

    // The ValidationPipe returns `message` as a string[] of violations.
    if (Array.isArray(rawMessage)) {
      return {
        message: 'Validation failed.',
        details: { violations: rawMessage },
      };
    }

    return {
      message: typeof rawMessage === 'string' ? rawMessage : exception.message,
    };
  }
}
