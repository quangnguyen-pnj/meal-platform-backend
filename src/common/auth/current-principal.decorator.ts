import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { AppError } from '../errors/app-error';
import { RequestPrincipal } from './request-principal';

/**
 * Injects the authenticated `RequestPrincipal` set by `JwtAuthGuard`. Throwing
 * here guards against accidentally using the decorator on a route that is not
 * protected by the guard.
 */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestPrincipal => {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.principal) {
      throw new AppError(
        'UNAUTHORIZED',
        'No authenticated principal on the request.',
      );
    }
    return request.principal;
  },
);
