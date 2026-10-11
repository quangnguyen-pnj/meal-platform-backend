import { PrismaService } from '../database/prisma.service';
import { RequestPrincipal } from '../auth/request-principal';
import { PrincipalAuthorizationService } from './principal-authorization.service';

const principal: RequestPrincipal = {
  userAccountId: 'acc-1',
  organizationId: 'org-1',
  tokenId: 'jti-1',
};

function build(
  account: Record<string, unknown> | null,
): PrincipalAuthorizationService {
  const prisma = {
    userAccount: {
      findUnique: jest.fn().mockResolvedValue(account),
    },
  } as unknown as PrismaService;
  return new PrincipalAuthorizationService(prisma);
}

describe('PrincipalAuthorizationService', () => {
  it('de-duplicates permission codes across roles and keeps scope grants and employee', async () => {
    const service = build({
      id: 'acc-1',
      isActive: true,
      employee: {
        id: 'emp-1',
        employeeCode: 'PNJP-0001',
        fullName: 'Tran Thi Lan',
        factoryId: 'fac-1',
        departmentId: 'dep-1',
        teamId: 'team-A',
      },
      userRoles: [
        {
          organizationId: 'org-1',
          factoryId: 'fac-1',
          departmentId: 'dep-1',
          teamId: 'team-A',
          role: {
            code: 'TeamRepresentative',
            name: 'Team Representative',
            rolePermissions: [
              { permission: { code: 'registration:bulk' } },
              { permission: { code: 'employee:read' } },
              { permission: { code: 'employee:read' } },
            ],
          },
        },
      ],
    });

    const resolved = await service.resolve(principal);

    expect(resolved.roles).toEqual(['TeamRepresentative']);
    expect(resolved.permissions.sort()).toEqual([
      'employee:read',
      'registration:bulk',
    ]);
    expect(resolved.scopeGrants).toEqual([
      {
        roleCode: 'TeamRepresentative',
        roleName: 'Team Representative',
        organizationId: 'org-1',
        factoryId: 'fac-1',
        departmentId: 'dep-1',
        teamId: 'team-A',
      },
    ]);
    expect(resolved.employee).toMatchObject({ employeeCode: 'PNJP-0001' });
  });

  it('throws UNAUTHORIZED for a missing account', async () => {
    const service = build(null);

    await expect(service.resolve(principal)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('throws UNAUTHORIZED for a deactivated account', async () => {
    const service = build({ id: 'acc-1', isActive: false, userRoles: [] });

    await expect(service.resolve(principal)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});
