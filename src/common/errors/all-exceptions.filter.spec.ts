import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { AppError } from './app-error';
import { ErrorResponse } from './error-response';

function createHost(requestId?: string): {
  host: ArgumentsHost;
  getStatus: () => number;
  getBody: () => ErrorResponse;
} {
  let capturedStatus = 0;
  let capturedBody: ErrorResponse = {} as ErrorResponse;

  const response = {
    status: (code: number) => {
      capturedStatus = code;
      return response;
    },
    json: (body: ErrorResponse) => {
      capturedBody = body;
      return response;
    },
  };

  const request = { requestId, method: 'GET', url: '/v1/test' };

  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    getStatus: () => capturedStatus,
    getBody: () => capturedBody,
  };
}

describe('AllExceptionsFilter', () => {
  const filter = new AllExceptionsFilter();

  it('maps an AppError to the standard shape with code, details and requestId', () => {
    const { host, getStatus, getBody } = createHost('req-123');

    filter.catch(
      new AppError('NOT_FOUND', 'Employee not found', { employeeId: 'e1' }),
      host,
    );

    expect(getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(getBody()).toEqual({
      code: 'NOT_FOUND',
      message: 'Employee not found',
      details: { employeeId: 'e1' },
      requestId: 'req-123',
    });
  });

  it('maps validation BadRequest violations into details', () => {
    const { host, getBody } = createHost('req-456');

    filter.catch(
      new BadRequestException({
        statusCode: 400,
        message: ['email must be an email', 'name should not be empty'],
        error: 'Bad Request',
      }),
      host,
    );

    const body = getBody();
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(body.message).toBe('Validation failed.');
    expect(body.details).toEqual({
      violations: ['email must be an email', 'name should not be empty'],
    });
    expect(body.requestId).toBe('req-456');
  });

  it('maps unknown errors to a generic 500 without leaking internals', () => {
    const { host, getStatus, getBody } = createHost('req-789');

    filter.catch(new Error('secret stack detail'), host);

    expect(getStatus()).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = getBody();
    expect(body.code).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('An unexpected error occurred.');
    expect(body.message).not.toContain('secret');
    expect(body.requestId).toBe('req-789');
  });

  it('generates a requestId when none is present on the request', () => {
    const { host, getBody } = createHost(undefined);

    filter.catch(new AppError('CONFLICT', 'Duplicate'), host);

    expect(getBody().requestId).toMatch(/[0-9a-f-]{36}/);
  });
});
