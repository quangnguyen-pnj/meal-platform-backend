import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Machine-readable error codes returned in the `code` field of every error
 * response. Add new codes here as domain modules introduce new failure modes.
 */
export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'INTERNAL_ERROR';

const CODE_TO_STATUS: Record<AppErrorCode, HttpStatus> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  CONFLICT: HttpStatus.CONFLICT,
  INTERNAL_ERROR: HttpStatus.INTERNAL_SERVER_ERROR,
};

/**
 * Domain-level error carrying a stable `code` and optional structured
 * `details`. The global exception filter turns this into the standard error
 * response shape. Throw this (or a subclass) from services instead of raw
 * HttpExceptions so the response contract stays consistent.
 */
export class AppError extends HttpException {
  readonly code: AppErrorCode;
  readonly details?: unknown;

  constructor(code: AppErrorCode, message: string, details?: unknown) {
    super(message, CODE_TO_STATUS[code]);
    this.code = code;
    this.details = details;
  }
}
