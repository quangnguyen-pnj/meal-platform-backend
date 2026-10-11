import { RequestPrincipal } from '../auth/request-principal';
import {
  PrincipalAuthorizationService,
  ResolvedAuthorization,
} from './principal-authorization.service';
import { ScopeAuthorizer } from './scope-authorizer.service';

const principal: RequestPrincipal = {
  userAccountId: 'acc-1',
  organizationId: 'org-1',
  tokenId: 'jti-1',
};

function build(resolved: Partial<ResolvedAuthorization>): ScopeAuthorizer {
  const full: ResolvedAuthorization = {
    roles: [],
    permissions: [],
    scopeGrants: [],
    employee: null,
    ...resolved,
  };
  const principalAuthorization = {
    resolve: jest.fn().mockResolvedValue(full),
  } as unknown as PrincipalAuthorizationService;
  return new ScopeAuthorizer(principalAuthorization);
}

describe('ScopeAuthorizer', () => {
  describe('assertPermission', () => {
    it('passes when the resolved permissions include the required code', async () => {
      const authorizer = build({ permissions: ['employee:manage'] });

      await expect(
        authorizer.assertPermission({
          principal,
          permission: 'employee:manage',
        }),
      ).resolves.toBeUndefined();
    });

    it('throws the standard 403 FORBIDDEN when the permission is missing', async () => {
      const authorizer = build({ permissions: ['employee:read'] });

      await expect(
        authorizer.assertPermission({
          principal,
          permission: 'employee:manage',
        }),
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        details: { requiredPermission: 'employee:manage' },
      });
    });
  });

  describe('assertScope', () => {
    const teamGrant = {
      roleCode: 'TeamRepresentative',
      roleName: 'Team Representative',
      organizationId: 'org-1',
      factoryId: 'fac-1',
      departmentId: 'dep-1',
      teamId: 'team-A',
    };
    const orgGrant = {
      roleCode: 'OrganizationAdmin',
      roleName: 'Organization Admin',
      organizationId: 'org-1',
      factoryId: null,
      departmentId: null,
      teamId: null,
    };

    it('allows a team-scoped principal to act on its own team', async () => {
      const authorizer = build({ scopeGrants: [teamGrant] });

      await expect(
        authorizer.assertScope({
          principal,
          scope: {
            organizationId: 'org-1',
            factoryId: 'fac-1',
            departmentId: 'dep-1',
            teamId: 'team-A',
          },
        }),
      ).resolves.toBeUndefined();
    });

    it('denies a team-scoped principal targeting another team', async () => {
      const authorizer = build({ scopeGrants: [teamGrant] });

      await expect(
        authorizer.assertScope({
          principal,
          scope: {
            organizationId: 'org-1',
            factoryId: 'fac-1',
            departmentId: 'dep-1',
            teamId: 'team-B',
          },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('allows an org-scoped principal across any factory, department, and team in its org', async () => {
      const authorizer = build({ scopeGrants: [orgGrant] });

      await expect(
        authorizer.assertScope({
          principal,
          scope: {
            organizationId: 'org-1',
            factoryId: 'fac-9',
            departmentId: 'dep-9',
            teamId: 'team-Z',
          },
        }),
      ).resolves.toBeUndefined();

      await expect(
        authorizer.assertScope({
          principal,
          scope: { organizationId: 'org-1', factoryId: 'fac-1' },
        }),
      ).resolves.toBeUndefined();
    });

    it('denies crossing into another organization even with an org grant', async () => {
      const authorizer = build({ scopeGrants: [orgGrant] });

      await expect(
        authorizer.assertScope({
          principal,
          scope: { organizationId: 'org-2', factoryId: 'fac-1' },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('denies when the principal holds no grants at all', async () => {
      const authorizer = build({ scopeGrants: [] });

      await expect(
        authorizer.assertScope({
          principal,
          scope: { organizationId: 'org-1', teamId: 'team-A' },
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('scopeFilter', () => {
    it('returns an org-only filter for an org-scoped principal', async () => {
      const authorizer = build({
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
      });

      await expect(authorizer.scopeFilter(principal)).resolves.toEqual({
        organizationId: 'org-1',
      });
    });

    it('returns a single leaf clause for one narrow grant', async () => {
      const authorizer = build({
        scopeGrants: [
          {
            roleCode: 'TeamRepresentative',
            roleName: 'Team Representative',
            organizationId: 'org-1',
            factoryId: 'fac-1',
            departmentId: 'dep-1',
            teamId: 'team-A',
          },
        ],
      });

      await expect(authorizer.scopeFilter(principal)).resolves.toEqual({
        organizationId: 'org-1',
        teamId: 'team-A',
      });
    });

    it('ORs multiple narrow grants together', async () => {
      const authorizer = build({
        scopeGrants: [
          {
            roleCode: 'TeamRepresentative',
            roleName: 'Team Representative',
            organizationId: 'org-1',
            factoryId: 'fac-1',
            departmentId: 'dep-1',
            teamId: 'team-A',
          },
          {
            roleCode: 'FactoryAdmin',
            roleName: 'Factory Admin',
            organizationId: 'org-1',
            factoryId: 'fac-2',
            departmentId: null,
            teamId: null,
          },
        ],
      });

      await expect(authorizer.scopeFilter(principal)).resolves.toEqual({
        organizationId: 'org-1',
        OR: [{ teamId: 'team-A' }, { factoryId: 'fac-2' }],
      });
    });

    it('throws FORBIDDEN when the principal has no grant in the current organization', async () => {
      const authorizer = build({
        scopeGrants: [
          {
            roleCode: 'OrganizationAdmin',
            roleName: 'Organization Admin',
            organizationId: 'org-other',
            factoryId: null,
            departmentId: null,
            teamId: null,
          },
        ],
      });

      await expect(authorizer.scopeFilter(principal)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });
});
