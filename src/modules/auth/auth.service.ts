import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PrismaService } from '../../common/database/prisma.service';
import {
  AuthenticatedIdentity,
  IDENTITY_PROVIDER,
  IdentityProvider,
} from '../../common/auth/identity-provider';
import { AccessTokenClaims } from '../../common/auth/jwt-auth.guard';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { PrincipalAuthorizationService } from '../../common/authorization/principal-authorization.service';
import { AppError } from '../../common/errors/app-error';
import { AuthenticatedPrincipalView, AuthTokens } from './auth.types';

@Injectable()
export class AuthService {
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(
    @Inject(IDENTITY_PROVIDER)
    private readonly identityProvider: IdentityProvider,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly principalAuthorization: PrincipalAuthorizationService,
    config: ConfigService,
  ) {
    this.accessTtlSeconds = config.getOrThrow<number>('JWT_ACCESS_TTL_SECONDS');
    this.refreshTtlSeconds = config.getOrThrow<number>(
      'JWT_REFRESH_TTL_SECONDS',
    );
  }

  /** Authenticate credentials and issue a fresh access/refresh token pair. */
  async login(email: string, password: string): Promise<AuthTokens> {
    const identity = await this.identityProvider.authenticate({
      email,
      password,
    });
    if (!identity) {
      throw new AppError('UNAUTHORIZED', 'Invalid email or password.');
    }

    const organizationId = await this.resolveOrganizationId(
      identity.userAccountId,
    );
    return this.issueTokens(identity, organizationId);
  }

  /**
   * Rotate a refresh token: validate the presented token against a live
   * session, revoke that session, and issue a brand-new token pair. The old
   * refresh token is useless afterwards.
   */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const tokenHash = this.hashToken(refreshToken);

    // Claim the session by revoking it conditionally in one transaction. The
    // `revokedAt: null` guard means only one of two concurrent refreshes with
    // the same token can revoke it; a zero-count result is an already-used
    // (or unknown) token and is rejected, so the token cannot be double-spent.
    const identity = await this.prisma.$transaction(async (tx) => {
      const session = await tx.refreshSession.findUnique({
        where: { tokenHash },
        include: { userAccount: true },
      });

      const now = new Date();
      if (
        !session ||
        session.revokedAt !== null ||
        session.expiresAt <= now ||
        !session.userAccount.isActive
      ) {
        throw new AppError('UNAUTHORIZED', 'Invalid or expired refresh token.');
      }

      const revoked = await tx.refreshSession.updateMany({
        where: { id: session.id, revokedAt: null },
        data: { revokedAt: now },
      });
      if (revoked.count === 0) {
        // A concurrent refresh already claimed this session.
        throw new AppError('UNAUTHORIZED', 'Invalid or expired refresh token.');
      }

      return {
        userAccountId: session.userAccountId,
        email: session.userAccount.email,
      } satisfies AuthenticatedIdentity;
    });

    const organizationId = await this.resolveOrganizationId(
      identity.userAccountId,
    );
    return this.issueTokens(identity, organizationId);
  }

  /**
   * Revoke the refresh session for the presented token. Idempotent: an
   * unknown or already-revoked token is a no-op so logout always succeeds.
   */
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.prisma.refreshSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Resolve the full principal view for `/auth/me`. Roles, permissions, and
   * scope grants are read from the database on every call, never trusted from
   * the token.
   */
  async getPrincipalView(
    principal: RequestPrincipal,
  ): Promise<AuthenticatedPrincipalView> {
    const account = await this.prisma.userAccount.findUnique({
      where: { id: principal.userAccountId },
      select: { id: true, email: true, isActive: true },
    });

    if (!account || !account.isActive) {
      throw new AppError('UNAUTHORIZED', 'Account is no longer active.');
    }

    const resolved = await this.principalAuthorization.resolve(principal);

    return {
      userAccountId: account.id,
      email: account.email,
      organizationId: principal.organizationId,
      employee: resolved.employee,
      roles: resolved.roles,
      permissions: resolved.permissions,
      scopeGrants: resolved.scopeGrants,
    };
  }

  /**
   * Determine the organization an account belongs to from its role grants. In
   * Phase 0-2 every grant for an account is within one organization. An
   * account with no grants cannot be scoped to a tenant, so login is refused.
   */
  private async resolveOrganizationId(userAccountId: string): Promise<string> {
    const grant = await this.prisma.userRole.findFirst({
      where: { userAccountId },
      select: { organizationId: true },
    });
    if (!grant) {
      throw new AppError(
        'FORBIDDEN',
        'Account has no role grant in any organization.',
      );
    }
    return grant.organizationId;
  }

  private async issueTokens(
    identity: AuthenticatedIdentity,
    organizationId: string,
  ): Promise<AuthTokens> {
    const claims: AccessTokenClaims = {
      sub: identity.userAccountId,
      org: organizationId,
      jti: randomUUID(),
    };
    const accessToken = await this.jwtService.signAsync(claims, {
      expiresIn: this.accessTtlSeconds,
    });

    const refreshToken = randomBytes(48).toString('base64url');
    const expiresAt = new Date(Date.now() + this.refreshTtlSeconds * 1000);
    await this.prisma.refreshSession.create({
      data: {
        userAccountId: identity.userAccountId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt,
      },
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTtlSeconds,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
