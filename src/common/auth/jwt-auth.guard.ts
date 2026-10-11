import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AppError } from '../errors/app-error';
import { RequestPrincipal } from './request-principal';

/**
 * Shape of the signed access-token payload. Claims are intentionally minimal:
 * subject (account id), organization, token id, and the standard timing
 * claims added by the signer. Role names are deliberately NOT included;
 * authorization resolves roles and permissions from the database.
 */
export interface AccessTokenClaims {
  sub: string;
  org: string;
  jti: string;
}

/**
 * Authenticated-only guard. It verifies the Bearer access token, then attaches
 * the resolved principal to the request. It does NOT make any permission or
 * scope decision; that is the job of the F0-05 scope guard. Use this guard to
 * require a logged-in user (e.g. for `GET /auth/me`).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractBearerToken(request);

    if (!token) {
      throw new AppError('UNAUTHORIZED', 'Authentication is required.');
    }

    let claims: AccessTokenClaims;
    try {
      claims = this.jwtService.verify<AccessTokenClaims>(token);
    } catch {
      throw new AppError('UNAUTHORIZED', 'Invalid or expired access token.');
    }

    const principal: RequestPrincipal = {
      userAccountId: claims.sub,
      organizationId: claims.org,
      tokenId: claims.jti,
    };
    request.principal = principal;
    return true;
  }

  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) {
      return null;
    }
    const [scheme, value] = header.split(' ');
    if (scheme !== 'Bearer' || !value) {
      return null;
    }
    return value;
  }
}
