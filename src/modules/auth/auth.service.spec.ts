import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/database/prisma.service';
import { AccessTokenClaims } from '../../common/auth/jwt-auth.guard';
import { IdentityProvider } from '../../common/auth/identity-provider';
import {
  PrincipalAuthorizationService,
  ResolvedAuthorization,
} from '../../common/authorization/principal-authorization.service';
import { AuthService } from './auth.service';

const JWT_SECRET = 'test-secret-at-least-32-characters-long';
const ACCESS_TTL = 900;
const REFRESH_TTL = 2592000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Minimal in-memory stand-in for the RefreshSession table so rotation and
 * revocation can be exercised without a database.
 */
interface SessionRow {
  id: string;
  userAccountId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

function createPrismaMock(options: {
  grantOrgId: string | null;
  userAccount?: Record<string, unknown> | null;
}): { prisma: PrismaService; sessions: SessionRow[] } {
  const sessions: SessionRow[] = [];
  let nextId = 1;

  const prisma = {
    userRole: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.grantOrgId ? { organizationId: options.grantOrgId } : null,
        ),
    },
    userAccount: {
      findUnique: jest.fn().mockResolvedValue(options.userAccount ?? null),
    },
    refreshSession: {
      create: jest.fn(
        ({ data }: { data: Omit<SessionRow, 'id' | 'revokedAt'> }) => {
          // Mirror the Prisma default: revokedAt is null until revoked.
          const row: SessionRow = {
            id: `s-${nextId++}`,
            revokedAt: null,
            ...data,
          };
          sessions.push(row);
          return Promise.resolve(row);
        },
      ),
      findUnique: jest.fn(({ where }: { where: { tokenHash: string } }) => {
        const row = sessions.find((s) => s.tokenHash === where.tokenHash);
        if (!row) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          ...row,
          userAccount: options.userAccount ?? {
            id: row.userAccountId,
            email: 'user@example.com',
            isActive: true,
          },
        });
      }),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<SessionRow>;
        }) => {
          const row = sessions.find((s) => s.id === where.id);
          if (row) {
            Object.assign(row, data);
          }
          return Promise.resolve(row);
        },
      ),
      updateMany: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id?: string; tokenHash?: string; revokedAt: null };
          data: Partial<SessionRow>;
        }) => {
          let count = 0;
          for (const row of sessions) {
            const idMatches = where.id === undefined || row.id === where.id;
            const hashMatches =
              where.tokenHash === undefined ||
              row.tokenHash === where.tokenHash;
            if (idMatches && hashMatches && row.revokedAt === null) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return Promise.resolve({ count });
        },
      ),
    },
  } as unknown as PrismaService;

  // The service runs refresh rotation inside a transaction; the double shares
  // the same `sessions` store so conditional revocation behaves identically.
  (prisma as unknown as { $transaction: unknown }).$transaction = (
    fn: (tx: PrismaService) => Promise<unknown>,
  ) => fn(prisma);

  return { prisma, sessions };
}

function createIdentityProvider(
  identity: { userAccountId: string; email: string } | null,
): IdentityProvider {
  return {
    provider: 'local',
    authenticate: jest.fn().mockResolvedValue(identity),
  };
}

function createConfig(): ConfigService {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'JWT_ACCESS_TTL_SECONDS') return ACCESS_TTL;
      if (key === 'JWT_REFRESH_TTL_SECONDS') return REFRESH_TTL;
      throw new Error(`unexpected config key ${key}`);
    }),
  } as unknown as ConfigService;
}

describe('AuthService', () => {
  const jwtService = new JwtService({ secret: JWT_SECRET });

  function build(options: {
    identity: { userAccountId: string; email: string } | null;
    grantOrgId: string | null;
    userAccount?: Record<string, unknown> | null;
    resolved?: ResolvedAuthorization;
  }): { service: AuthService; sessions: SessionRow[] } {
    const { prisma, sessions } = createPrismaMock({
      grantOrgId: options.grantOrgId,
      userAccount: options.userAccount,
    });
    const principalAuthorization = {
      resolve: jest.fn().mockResolvedValue(
        options.resolved ?? {
          roles: [],
          permissions: [],
          scopeGrants: [],
          employee: null,
        },
      ),
    } as unknown as PrincipalAuthorizationService;
    const service = new AuthService(
      createIdentityProvider(options.identity),
      prisma,
      jwtService,
      principalAuthorization,
      createConfig(),
    );
    return { service, sessions };
  }

  describe('login', () => {
    it('issues a signed access token and a stored refresh session on success', async () => {
      const { service, sessions } = build({
        identity: { userAccountId: 'acc-1', email: 'a@b.com' },
        grantOrgId: 'org-1',
      });

      const tokens = await service.login('a@b.com', 'pw');

      expect(tokens.tokenType).toBe('Bearer');
      expect(tokens.expiresIn).toBe(ACCESS_TTL);

      const claims = jwtService.verify<AccessTokenClaims>(tokens.accessToken, {
        secret: JWT_SECRET,
      });
      expect(claims.sub).toBe('acc-1');
      expect(claims.org).toBe('org-1');
      expect(typeof claims.jti).toBe('string');

      // Only the hash is persisted, never the raw refresh token.
      expect(sessions).toHaveLength(1);
      expect(sessions[0].tokenHash).toBe(hashToken(tokens.refreshToken));
      expect(sessions[0].tokenHash).not.toBe(tokens.refreshToken);
    });

    it('rejects wrong credentials with a 401 UNAUTHORIZED', async () => {
      const { service } = build({ identity: null, grantOrgId: 'org-1' });

      await expect(service.login('a@b.com', 'bad')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('refresh', () => {
    it('rotates the token and invalidates the old refresh token', async () => {
      const { service, sessions } = build({
        identity: { userAccountId: 'acc-1', email: 'a@b.com' },
        grantOrgId: 'org-1',
        userAccount: { id: 'acc-1', email: 'a@b.com', isActive: true },
      });

      const first = await service.login('a@b.com', 'pw');
      const second = await service.refresh(first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);

      // The original session is now revoked, and reusing the old token fails.
      const original = sessions.find(
        (s) => s.tokenHash === hashToken(first.refreshToken),
      );
      expect(original?.revokedAt).toBeInstanceOf(Date);

      await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });

      // The new token still works.
      await expect(service.refresh(second.refreshToken)).resolves.toBeDefined();
    });

    it('rejects a second refresh with the same token (no double-spend)', async () => {
      const { service, sessions } = build({
        identity: { userAccountId: 'acc-1', email: 'a@b.com' },
        grantOrgId: 'org-1',
        userAccount: { id: 'acc-1', email: 'a@b.com', isActive: true },
      });

      const first = await service.login('a@b.com', 'pw');
      // The first refresh claims the session by revoking it conditionally.
      await service.refresh(first.refreshToken);
      const sessionCountAfterFirst = sessions.length;

      // A second refresh presenting the same (now-revoked) token must fail and
      // must not mint a new refresh session.
      await expect(service.refresh(first.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
      expect(sessions).toHaveLength(sessionCountAfterFirst);
    });

    it('rejects an unknown refresh token', async () => {
      const { service } = build({
        identity: null,
        grantOrgId: 'org-1',
        userAccount: { id: 'acc-1', email: 'a@b.com', isActive: true },
      });

      await expect(service.refresh('not-a-token')).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });
  });

  describe('logout', () => {
    it('revokes the current refresh session so the token can no longer refresh', async () => {
      const { service } = build({
        identity: { userAccountId: 'acc-1', email: 'a@b.com' },
        grantOrgId: 'org-1',
        userAccount: { id: 'acc-1', email: 'a@b.com', isActive: true },
      });

      const tokens = await service.login('a@b.com', 'pw');
      await service.logout(tokens.refreshToken);

      await expect(service.refresh(tokens.refreshToken)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    it('is a no-op for an unknown token', async () => {
      const { service } = build({ identity: null, grantOrgId: 'org-1' });

      await expect(service.logout('nope')).resolves.toBeUndefined();
    });
  });

  describe('getPrincipalView', () => {
    it('returns the account plus the roles, permissions, scope grants, and employee resolved from the shared resolver', async () => {
      const resolved: ResolvedAuthorization = {
        roles: ['OrganizationAdmin'],
        permissions: ['organization:read', 'employee:read'],
        scopeGrants: [
          {
            roleCode: 'OrganizationAdmin',
            roleName: 'Organization Admin',
            organizationId: 'org-1',
            factoryId: null,
            departmentId: null,
            teamId: null,
          },
        ],
        employee: {
          id: 'emp-1',
          employeeCode: 'PNJP-0001',
          fullName: 'Tran Thi Lan',
          factoryId: 'fac-1',
          departmentId: 'dep-1',
          teamId: 'team-1',
        },
      };
      const { service } = build({
        identity: null,
        grantOrgId: 'org-1',
        userAccount: { id: 'acc-1', email: 'a@b.com', isActive: true },
        resolved,
      });

      const view = await service.getPrincipalView({
        userAccountId: 'acc-1',
        organizationId: 'org-1',
        tokenId: 'jti-1',
      });

      expect(view.userAccountId).toBe('acc-1');
      expect(view.email).toBe('a@b.com');
      expect(view.organizationId).toBe('org-1');
      expect(view.employee).toMatchObject({ employeeCode: 'PNJP-0001' });
      expect(view.roles).toEqual(['OrganizationAdmin']);
      expect(view.permissions.sort()).toEqual([
        'employee:read',
        'organization:read',
      ]);
      expect(view.scopeGrants).toEqual(resolved.scopeGrants);
    });
  });
});
