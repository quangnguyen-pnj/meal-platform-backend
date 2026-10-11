import * as argon2 from 'argon2';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ResourceScope } from '../../common/authorization/resource-scope';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../common/database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { WorkforceService } from './workforce.service';

const ORG = 'org-1';
const FACTORY = 'fac-1';
const DEPARTMENT = 'dep-1';
const TEAM = 'team-1';
const OTHER_TEAM = 'team-2';

interface TeamRow {
  id: string;
  organizationId: string;
  factoryId: string;
  departmentId: string;
}

interface EmployeeRow {
  id: string;
  organizationId: string;
  factoryId: string;
  departmentId: string;
  teamId: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  hasPersonalDevice: boolean;
  userAccountId: string | null;
}

interface AccountRow {
  id: string;
  email: string;
  passwordHash: string | null;
  isActive: boolean;
}

interface RoleRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
}

interface UserRoleRow {
  id: string;
  userAccountId: string;
  roleId: string;
  organizationId: string;
  factoryId: string | null;
  departmentId: string | null;
  teamId: string | null;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
}

/**
 * In-memory Prisma double. Writes made inside a `$transaction` callback are
 * staged and committed only when the callback resolves, so a mutation and its
 * audit row land together (or not at all). This proves audit rows are written
 * in the same transaction as the mutation without a live database.
 */
function createPrisma(options?: {
  teams?: TeamRow[];
  employees?: EmployeeRow[];
  accounts?: AccountRow[];
  roles?: RoleRow[];
}): {
  prisma: PrismaService;
  audit: AuditRow[];
  employees: EmployeeRow[];
  accounts: AccountRow[];
  userRoles: UserRoleRow[];
} {
  const teams: TeamRow[] = options?.teams ?? [
    {
      id: TEAM,
      organizationId: ORG,
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
    },
  ];
  const employees: EmployeeRow[] = options?.employees ?? [];
  const accounts: AccountRow[] = options?.accounts ?? [];
  const roles: RoleRow[] = options?.roles ?? [];
  const userRoles: UserRoleRow[] = [];
  const committedAudit: AuditRow[] = [];

  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  const matchWhere = (row: object, where: Record<string, unknown>): boolean => {
    const record = row as Record<string, unknown>;
    return Object.entries(where).every(([key, value]) => record[key] === value);
  };

  const makeTx = (
    stagedEmployees: EmployeeRow[],
    stagedAccounts: AccountRow[],
    stagedUserRoles: UserRoleRow[],
    stagedAudit: AuditRow[],
  ): Prisma.TransactionClient =>
    ({
      employee: {
        create: ({ data }: { data: Omit<EmployeeRow, 'id'> }) => {
          const row: EmployeeRow = { id: nextId('emp'), ...data };
          stagedEmployees.push(row);
          return Promise.resolve(row);
        },
        update: ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = employees.find((e) => e.id === where.id);
          if (!row) throw new Error('employee not found in update');
          if (data.userAccount) {
            row.userAccountId = (
              data.userAccount as { connect: { id: string } }
            ).connect.id;
          }
          if (data.fullName !== undefined)
            row.fullName = data.fullName as string;
          return Promise.resolve(row);
        },
        delete: ({ where }: { where: { id: string } }) => {
          const idx = employees.findIndex((e) => e.id === where.id);
          const [row] = employees.splice(idx, 1);
          return Promise.resolve(row);
        },
      },
      userAccount: {
        create: ({ data }: { data: Omit<AccountRow, 'id' | 'isActive'> }) => {
          const row: AccountRow = {
            id: nextId('acc'),
            isActive: true,
            ...data,
          };
          stagedAccounts.push(row);
          return Promise.resolve(row);
        },
      },
      userRole: {
        create: ({ data }: { data: Omit<UserRoleRow, 'id'> }) => {
          const row: UserRoleRow = { id: nextId('ur'), ...data };
          stagedUserRoles.push(row);
          return Promise.resolve(row);
        },
      },
      auditLog: {
        create: ({ data }: { data: AuditRow }) => {
          stagedAudit.push(data);
          return Promise.resolve(data);
        },
      },
    }) as unknown as Prisma.TransactionClient;

  const prisma = {
    team: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(teams.find((t) => matchWhere(t, where)) ?? null),
    },
    employee: {
      findMany: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(employees.filter((e) => matchWhere(e, where ?? {}))),
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(employees.find((e) => matchWhere(e, where)) ?? null),
      findUnique: ({
        where,
      }: {
        where: {
          userAccountId?: string;
          organizationId_employeeCode?: {
            organizationId: string;
            employeeCode: string;
          };
        };
      }) => {
        if (where.userAccountId !== undefined) {
          return Promise.resolve(
            employees.find((e) => e.userAccountId === where.userAccountId) ??
              null,
          );
        }
        const key = where.organizationId_employeeCode;
        return Promise.resolve(
          employees.find(
            (e) =>
              e.organizationId === key?.organizationId &&
              e.employeeCode === key?.employeeCode,
          ) ?? null,
        );
      },
    },
    userAccount: {
      findUnique: ({ where }: { where: { id?: string; email?: string } }) =>
        Promise.resolve(
          accounts.find(
            (a) =>
              (where.id !== undefined && a.id === where.id) ||
              (where.email !== undefined && a.email === where.email),
          ) ?? null,
        ),
    },
    role: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(roles.find((r) => matchWhere(r, where)) ?? null),
    },
    userRole: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(userRoles.find((u) => matchWhere(u, where)) ?? null),
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const stagedEmployees: EmployeeRow[] = [];
      const stagedAccounts: AccountRow[] = [];
      const stagedUserRoles: UserRoleRow[] = [];
      const stagedAudit: AuditRow[] = [];
      const result = await fn(
        makeTx(stagedEmployees, stagedAccounts, stagedUserRoles, stagedAudit),
      );
      employees.push(...stagedEmployees);
      accounts.push(...stagedAccounts);
      userRoles.push(...stagedUserRoles);
      committedAudit.push(...stagedAudit);
      return result;
    },
  } as unknown as PrismaService;

  return { prisma, audit: committedAudit, employees, accounts, userRoles };
}

/**
 * ScopeAuthorizer stub. `assertScope` throws FORBIDDEN for any target outside
 * the single visible team, like a team-scoped grant. `scopeFilter` pins list
 * queries to that team.
 */
function teamScopedAuthorizer(teamId: string): ScopeAuthorizer {
  return {
    assertPermission: () => Promise.resolve(),
    assertScope: ({ scope }: { scope: ResourceScope }) => {
      if (scope.teamId === teamId) {
        return Promise.resolve();
      }
      return Promise.reject(
        new AppError('FORBIDDEN', 'Target is outside your granted scope.'),
      );
    },
    scopeFilter: () => Promise.resolve({ organizationId: ORG, teamId }),
  } as unknown as ScopeAuthorizer;
}

const principal: RequestPrincipal = {
  userAccountId: 'actor-1',
  organizationId: ORG,
  tokenId: 'tok-1',
};

function makeService(
  authorizer: ScopeAuthorizer,
  prismaOptions?: {
    teams?: TeamRow[];
    employees?: EmployeeRow[];
    accounts?: AccountRow[];
    roles?: RoleRow[];
  },
): {
  service: WorkforceService;
  audit: AuditRow[];
  employees: EmployeeRow[];
  accounts: AccountRow[];
  userRoles: UserRoleRow[];
} {
  const { prisma, audit, employees, accounts, userRoles } =
    createPrisma(prismaOptions);
  const service = new WorkforceService(
    prisma,
    authorizer,
    new AuditService(prisma),
  );
  return { service, audit, employees, accounts, userRoles };
}

describe('WorkforceService employees', () => {
  it('rejects a duplicate employeeCode within the organization (CONFLICT)', async () => {
    const existing: EmployeeRow = {
      id: 'emp-existing',
      organizationId: ORG,
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
      employeeCode: 'E-100',
      fullName: 'Existing',
      email: null,
      hasPersonalDevice: false,
      userAccountId: null,
    };
    const { service } = makeService(teamScopedAuthorizer(TEAM), {
      employees: [existing],
    });

    await expect(
      service.createEmployee(principal, {
        employeeCode: 'E-100',
        fullName: 'Duplicate',
        factoryId: FACTORY,
        departmentId: DEPARTMENT,
        teamId: TEAM,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects a placement whose team/department/factory do not line up', async () => {
    const { service } = makeService(teamScopedAuthorizer(TEAM));

    await expect(
      service.createEmployee(principal, {
        employeeCode: 'E-200',
        fullName: 'Mismatch',
        factoryId: FACTORY,
        // Team's real department is DEPARTMENT; claim a different one.
        departmentId: 'dep-other',
        teamId: TEAM,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('creates a device-less worker with no account and audits it', async () => {
    const { service, employees, accounts, audit } = makeService(
      teamScopedAuthorizer(TEAM),
    );

    const view = await service.createEmployee(principal, {
      employeeCode: 'E-300',
      fullName: 'No Device Worker',
      hasPersonalDevice: false,
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
    });

    expect(view.userAccountId).toBeNull();
    expect(view.hasPersonalDevice).toBe(false);
    expect(employees).toHaveLength(1);
    expect(accounts).toHaveLength(0);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'employee.create',
      entityType: 'Employee',
      actorId: 'actor-1',
    });
  });

  it('creates an employee with a linked account and never returns a password hash', async () => {
    const { service, accounts } = makeService(teamScopedAuthorizer(TEAM));

    const view = await service.createEmployee(principal, {
      employeeCode: 'E-400',
      fullName: 'With Account',
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
      account: { email: 'with.account@example.com', password: 'sup3rsecret' },
    });

    expect(view.userAccountId).not.toBeNull();
    // The stored hash is Argon2id, not the plaintext password.
    expect(accounts).toHaveLength(1);
    expect(accounts[0].passwordHash).not.toBe('sup3rsecret');
    expect(accounts[0].passwordHash?.startsWith('$argon2id$')).toBe(true);
    await expect(
      argon2.verify(accounts[0].passwordHash as string, 'sup3rsecret'),
    ).resolves.toBe(true);
    // No password-bearing field is present on any returned view.
    expect(JSON.stringify(view)).not.toContain('sup3rsecret');
    expect(JSON.stringify(view)).not.toContain('passwordHash');
  });

  it('lists only employees in the principal scope', async () => {
    const inScope: EmployeeRow = {
      id: 'emp-in',
      organizationId: ORG,
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
      employeeCode: 'E-IN',
      fullName: 'In',
      email: null,
      hasPersonalDevice: false,
      userAccountId: null,
    };
    const outOfScope: EmployeeRow = {
      ...inScope,
      id: 'emp-out',
      employeeCode: 'E-OUT',
      teamId: OTHER_TEAM,
    };
    const { service } = makeService(teamScopedAuthorizer(TEAM), {
      employees: [inScope, outOfScope],
    });

    const list = await service.listEmployees(principal);
    expect(list.map((e) => e.id)).toEqual(['emp-in']);
  });
});

describe('WorkforceService role grants', () => {
  const employeeRole: RoleRow = {
    id: 'role-emp',
    organizationId: ORG,
    code: 'Employee',
    name: 'Employee',
  };
  const factoryAdminRole: RoleRow = {
    id: 'role-fa',
    organizationId: ORG,
    code: 'FactoryAdmin',
    name: 'Factory Admin',
  };

  function selfLinkedEmployee(): {
    employee: EmployeeRow;
    account: AccountRow;
  } {
    const account: AccountRow = {
      id: 'acc-self',
      email: 'self@example.com',
      passwordHash: 'hash',
      isActive: true,
    };
    const employee: EmployeeRow = {
      id: 'emp-self',
      organizationId: ORG,
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
      employeeCode: 'E-SELF',
      fullName: 'Self',
      email: null,
      hasPersonalDevice: true,
      userAccountId: account.id,
    };
    return { employee, account };
  }

  it('grants the Employee role at the holder own team scope and audits it', async () => {
    const { employee, account } = selfLinkedEmployee();
    const { service, userRoles, audit } = makeService(
      teamScopedAuthorizer(TEAM),
      { employees: [employee], accounts: [account], roles: [employeeRole] },
    );

    const grant = await service.grantRole(principal, {
      userAccountId: account.id,
      roleId: employeeRole.id,
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
    });

    expect(grant.teamId).toBe(TEAM);
    expect(userRoles).toHaveLength(1);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'role.grant',
      entityType: 'UserRole',
    });
  });

  it('rejects an Employee-role grant broader than self scope (FORBIDDEN)', async () => {
    const { employee, account } = selfLinkedEmployee();
    // Authorizer allows the org-level target, isolating the self-scope rule.
    const permissiveAuthorizer = {
      assertPermission: () => Promise.resolve(),
      assertScope: () => Promise.resolve(),
      scopeFilter: () => Promise.resolve({ organizationId: ORG }),
    } as unknown as ScopeAuthorizer;
    const { service, userRoles } = makeService(permissiveAuthorizer, {
      employees: [employee],
      accounts: [account],
      roles: [employeeRole],
    });

    await expect(
      service.grantRole(principal, {
        userAccountId: account.id,
        roleId: employeeRole.id,
        // Organization scope: no factory/department/team ids.
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(userRoles).toHaveLength(0);
  });

  it('forbids granting a role outside the principal own scope', async () => {
    const account: AccountRow = {
      id: 'acc-x',
      email: 'x@example.com',
      passwordHash: 'hash',
      isActive: true,
    };
    // The account is a valid in-org target (linked to an employee here), so the
    // rejection is isolated to the scope rule, not account resolution.
    const employee: EmployeeRow = {
      id: 'emp-x',
      organizationId: ORG,
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
      employeeCode: 'E-X',
      fullName: 'X',
      email: null,
      hasPersonalDevice: false,
      userAccountId: account.id,
    };
    // Principal is team-scoped to TEAM; a factory-wide grant is outside it.
    const { service, userRoles } = makeService(teamScopedAuthorizer(TEAM), {
      employees: [employee],
      accounts: [account],
      roles: [factoryAdminRole],
    });

    await expect(
      service.grantRole(principal, {
        userAccountId: account.id,
        roleId: factoryAdminRole.id,
        factoryId: FACTORY,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(userRoles).toHaveLength(0);
  });

  it('rejects granting a role to an account in another organization', async () => {
    const account: AccountRow = {
      id: 'acc-other-org',
      email: 'other-org@example.com',
      passwordHash: 'hash',
      isActive: true,
    };
    // The account's only employee lives in a different organization, so it is
    // not a valid grant target for this principal. The scope target itself is
    // inside the principal's authority (TEAM), isolating the cross-org rule.
    const foreignEmployee: EmployeeRow = {
      id: 'emp-foreign',
      organizationId: 'org-2',
      factoryId: FACTORY,
      departmentId: DEPARTMENT,
      teamId: TEAM,
      employeeCode: 'E-FOREIGN',
      fullName: 'Foreign',
      email: null,
      hasPersonalDevice: false,
      userAccountId: account.id,
    };
    const { service, userRoles } = makeService(teamScopedAuthorizer(TEAM), {
      employees: [foreignEmployee],
      accounts: [account],
      roles: [factoryAdminRole],
    });

    await expect(
      service.grantRole(principal, {
        userAccountId: account.id,
        roleId: factoryAdminRole.id,
        factoryId: FACTORY,
        departmentId: DEPARTMENT,
        teamId: TEAM,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(userRoles).toHaveLength(0);
  });
});
