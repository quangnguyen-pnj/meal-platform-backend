import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { RequestPrincipal } from '../auth/request-principal';
import { PermissionGuard } from './permission.guard';
import { ScopeAuthorizer } from './scope-authorizer.service';

const principal: RequestPrincipal = {
  userAccountId: 'acc-1',
  organizationId: 'org-1',
  tokenId: 'jti-1',
};

function contextFor(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

function build(options: {
  required: string | undefined;
  assertPermission?: jest.Mock;
}): { guard: PermissionGuard; assertPermission: jest.Mock } {
  const reflector = {
    getAllAndOverride: jest.fn().mockReturnValue(options.required),
  } as unknown as Reflector;
  const assertPermission =
    options.assertPermission ?? jest.fn().mockResolvedValue(undefined);
  const scopeAuthorizer = { assertPermission } as unknown as ScopeAuthorizer;
  return {
    guard: new PermissionGuard(reflector, scopeAuthorizer),
    assertPermission,
  };
}

describe('PermissionGuard', () => {
  it('allows a route with no @RequirePermission metadata', async () => {
    const { guard } = build({ required: undefined });

    await expect(guard.canActivate(contextFor({ principal }))).resolves.toBe(
      true,
    );
  });

  it('delegates to assertPermission and allows when it passes', async () => {
    const { guard, assertPermission } = build({ required: 'employee:manage' });

    await expect(guard.canActivate(contextFor({ principal }))).resolves.toBe(
      true,
    );
    expect(assertPermission).toHaveBeenCalledWith({
      principal,
      permission: 'employee:manage',
    });
  });

  it('propagates the FORBIDDEN thrown by assertPermission', async () => {
    const assertPermission = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('nope'), { code: 'FORBIDDEN' }),
      );
    const { guard } = build({ required: 'employee:manage', assertPermission });

    await expect(
      guard.canActivate(contextFor({ principal })),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('throws UNAUTHORIZED when the route is guarded but no principal is attached', async () => {
    const { guard } = build({ required: 'employee:manage' });

    await expect(guard.canActivate(contextFor({}))).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
