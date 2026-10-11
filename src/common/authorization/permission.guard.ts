import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppError } from '../errors/app-error';
import { PermissionCode } from './permission-code';
import { REQUIRE_PERMISSION_KEY } from './require-permission.decorator';
import { ScopeAuthorizer } from './scope-authorizer.service';

/**
 * Enforces the permission declared by `@RequirePermission(...)`. It runs after
 * `JwtAuthGuard`, so a principal is already on the request; it resolves that
 * principal's effective permissions from the database (never from the token)
 * and throws the standard 403 FORBIDDEN when the required permission is
 * missing.
 *
 * Scope containment (which team/factory the target belongs to) is a per-target
 * decision the service makes with `ScopeAuthorizer.assertScope`, because the
 * target id is only known inside the handler. This guard covers the coarse
 * "may this account perform this kind of action at all" check.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly scopeAuthorizer: ScopeAuthorizer,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<
      PermissionCode | undefined
    >(REQUIRE_PERMISSION_KEY, [context.getHandler(), context.getClass()]);

    if (!required) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    if (!request.principal) {
      throw new AppError('UNAUTHORIZED', 'Authentication is required.');
    }

    await this.scopeAuthorizer.assertPermission({
      principal: request.principal,
      permission: required,
    });
    return true;
  }
}
