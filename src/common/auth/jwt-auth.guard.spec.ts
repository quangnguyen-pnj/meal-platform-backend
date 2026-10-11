import { ExecutionContext } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AccessTokenClaims, JwtAuthGuard } from './jwt-auth.guard';

const JWT_SECRET = 'test-secret-at-least-32-characters-long';

function contextFor(request: Partial<Request>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('JwtAuthGuard', () => {
  const jwtService = new JwtService({ secret: JWT_SECRET });
  const guard = new JwtAuthGuard(jwtService);

  it('attaches the principal from a valid Bearer token', () => {
    const claims: AccessTokenClaims = {
      sub: 'acc-1',
      org: 'org-1',
      jti: 'jti-1',
    };
    const token = jwtService.sign(claims, { expiresIn: 900 });
    const request: Partial<Request> = {
      headers: { authorization: `Bearer ${token}` },
    };

    expect(guard.canActivate(contextFor(request))).toBe(true);
    expect(request.principal).toEqual({
      userAccountId: 'acc-1',
      organizationId: 'org-1',
      tokenId: 'jti-1',
    });
  });

  it('rejects a request with no Authorization header', () => {
    expect(() => guard.canActivate(contextFor({ headers: {} }))).toThrow(
      /Authentication is required/,
    );
  });

  it('rejects a non-Bearer scheme', () => {
    const request: Partial<Request> = {
      headers: { authorization: 'Basic abc' },
    };
    expect(() => guard.canActivate(contextFor(request))).toThrow(
      /Authentication is required/,
    );
  });

  it('rejects a token signed with the wrong secret', () => {
    const foreign = new JwtService({
      secret: 'another-secret-value-32-characters',
    });
    const token = foreign.sign({ sub: 'acc-1', org: 'org-1', jti: 'x' });
    const request: Partial<Request> = {
      headers: { authorization: `Bearer ${token}` },
    };
    expect(() => guard.canActivate(contextFor(request))).toThrow(
      /Invalid or expired access token/,
    );
  });
});
