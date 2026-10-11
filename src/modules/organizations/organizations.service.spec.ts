import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import {
  ResourceScope,
  ScopeGrant,
} from '../../common/authorization/resource-scope';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../common/database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { OrganizationsService } from './organizations.service';

interface FactoryRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
}

interface DepartmentRow {
  id: string;
  organizationId: string;
  factoryId: string;
  code: string;
  name: string;
}

interface TeamRow {
  id: string;
  organizationId: string;
  factoryId: string;
  departmentId: string;
  code: string;
  name: string;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
}

const ORG = 'org-1';
const FACTORY_A = 'fac-a';
const FACTORY_B = 'fac-b';
const DEP_A1 = 'dep-a1';
const DEP_A2 = 'dep-a2';
const DEP_B1 = 'dep-b1';
const TEAM_A1A = 'team-a1a';
const TEAM_A1B = 'team-a1b';
const TEAM_A2A = 'team-a2a';
const TEAM_B1A = 'team-b1a';

/**
 * In-memory Prisma double seeded with a two-factory tree:
 *
 *   Factory A
 *     Dept A1 -> Team A1a, Team A1b
 *     Dept A2 -> Team A2a
 *   Factory B
 *     Dept B1 -> Team B1a
 *
 * Enough breadth for a narrow (department/team) grant to have sibling units it
 * must NOT see. `findMany` honours the service's `where` (organizationId plus
 * the OR scope clauses and an optional AND narrowing); the factory `findMany`
 * also honours the nested department/team `where` used by getScopeTree. Writes
 * inside `$transaction` are staged and committed together so the audit row
 * lands with the mutation.
 */
function createPrisma(): {
  prisma: PrismaService;
  audit: AuditRow[];
  teams: TeamRow[];
} {
  const factories: FactoryRow[] = [
    { id: FACTORY_A, organizationId: ORG, code: 'FAC-A', name: 'Factory A' },
    { id: FACTORY_B, organizationId: ORG, code: 'FAC-B', name: 'Factory B' },
  ];
  const departments: DepartmentRow[] = [
    {
      id: DEP_A1,
      organizationId: ORG,
      factoryId: FACTORY_A,
      code: 'DEP-A1',
      name: 'Dept A1',
    },
    {
      id: DEP_A2,
      organizationId: ORG,
      factoryId: FACTORY_A,
      code: 'DEP-A2',
      name: 'Dept A2',
    },
    {
      id: DEP_B1,
      organizationId: ORG,
      factoryId: FACTORY_B,
      code: 'DEP-B1',
      name: 'Dept B1',
    },
  ];
  const teams: TeamRow[] = [
    {
      id: TEAM_A1A,
      organizationId: ORG,
      factoryId: FACTORY_A,
      departmentId: DEP_A1,
      code: 'TEAM-A1A',
      name: 'Team A1a',
    },
    {
      id: TEAM_A1B,
      organizationId: ORG,
      factoryId: FACTORY_A,
      departmentId: DEP_A1,
      code: 'TEAM-A1B',
      name: 'Team A1b',
    },
    {
      id: TEAM_A2A,
      organizationId: ORG,
      factoryId: FACTORY_A,
      departmentId: DEP_A2,
      code: 'TEAM-A2A',
      name: 'Team A2a',
    },
    {
      id: TEAM_B1A,
      organizationId: ORG,
      factoryId: FACTORY_B,
      departmentId: DEP_B1,
      code: 'TEAM-B1A',
      name: 'Team B1a',
    },
  ];
  const committedAudit: AuditRow[] = [];

  const findFirst =
    <T extends { id: string; organizationId: string }>(store: T[]) =>
    ({ where }: { where: { id?: string; organizationId?: string } }) =>
      Promise.resolve(
        store.find(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.organizationId === undefined ||
              row.organizationId === where.organizationId),
        ) ?? null,
      );

  // Match a single clause ({ id: { in } } | { factoryId: { in } } | ...) or a
  // direct equality against a row.
  const matchClause = (
    source: object,
    clause: Record<string, unknown>,
  ): boolean => {
    const row = source as Record<string, unknown>;
    return Object.entries(clause).every(([key, value]) => {
      if (
        value &&
        typeof value === 'object' &&
        'in' in (value as Record<string, unknown>)
      ) {
        const ids = (value as { in: string[] }).in;
        return ids.includes(row[key] as string);
      }
      return row[key] === value;
    });
  };

  // Match the service's where: organizationId plus an optional OR (scope
  // clauses) plus an optional AND (explicit-id narrowing).
  const matchWhere = (
    row: object,
    where: Record<string, unknown> | undefined,
  ): boolean => {
    if (!where) return true;
    const { OR, AND, ...rest } = where as {
      OR?: Record<string, unknown>[];
      AND?: Record<string, unknown>[];
      [key: string]: unknown;
    };
    if (!matchClause(row, rest)) return false;
    if (OR && !OR.some((clause) => matchClause(row, clause))) return false;
    if (AND && !AND.every((clause) => matchClause(row, clause))) return false;
    return true;
  };

  const prisma = {
    factory: {
      findFirst: findFirst(factories),
      findUnique: () => Promise.resolve(null),
      findMany: ({
        where,
        include,
      }: {
        where?: Record<string, unknown>;
        include?: {
          departments?: {
            where?: Record<string, unknown>;
            include?: { teams?: { where?: Record<string, unknown> } };
          };
        };
      }) => {
        const matched = factories.filter((f) => matchWhere(f, where));
        if (!include?.departments) {
          return Promise.resolve(matched);
        }
        const depWhere = include.departments.where;
        const teamWhere = include.departments.include?.teams?.where;
        return Promise.resolve(
          matched.map((factory) => ({
            ...factory,
            departments: departments
              .filter((d) => d.factoryId === factory.id)
              .filter((d) => matchWhere(d, depWhere))
              .map((department) => ({
                ...department,
                teams: teams
                  .filter((t) => t.departmentId === department.id)
                  .filter((t) => matchWhere(t, teamWhere)),
              })),
          })),
        );
      },
    },
    department: {
      findFirst: findFirst(departments),
      findUnique: () => Promise.resolve(null),
      findMany: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(departments.filter((d) => matchWhere(d, where))),
    },
    team: {
      findFirst: findFirst(teams),
      findUnique: () => Promise.resolve(null),
      findMany: ({ where }: { where?: Record<string, unknown> }) =>
        Promise.resolve(teams.filter((t) => matchWhere(t, where))),
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const stagedTeams: TeamRow[] = [];
      const stagedAudit: AuditRow[] = [];
      const tx = {
        team: {
          create: ({
            data,
          }: {
            data: Omit<TeamRow, 'id'> & { id?: string };
          }) => {
            const row: TeamRow = {
              id: data.id ?? `generated-${teams.length + stagedTeams.length}`,
              ...data,
            };
            stagedTeams.push(row);
            return Promise.resolve(row);
          },
        },
        auditLog: {
          create: ({ data }: { data: AuditRow }) => {
            stagedAudit.push(data);
            return Promise.resolve(data);
          },
        },
      } as unknown as Prisma.TransactionClient;

      const result = await fn(tx);
      teams.push(...stagedTeams);
      committedAudit.push(...stagedAudit);
      return result;
    },
  } as unknown as PrismaService;

  return { prisma, audit: committedAudit, teams };
}

/**
 * ScopeAuthorizer stub driven by a single grant. `assertScope` enforces the
 * subtree rule for single-resource reads; `listableScopeGrants` returns the
 * grant (or `'all'` for an org-level grant) so the list/tree queries build the
 * same per-table filter the production authorizer feeds them.
 */
function scopedAuthorizer(grant: ScopeGrant | 'org'): ScopeAuthorizer {
  const resolved: ScopeGrant | null =
    grant === 'org'
      ? {
          organizationId: ORG,
          factoryId: null,
          departmentId: null,
          teamId: null,
        }
      : grant;

  const covers = (scope: ResourceScope): boolean => {
    if (!resolved) return false;
    if (resolved.teamId) return scope.teamId === resolved.teamId;
    if (resolved.departmentId)
      return scope.departmentId === resolved.departmentId;
    if (resolved.factoryId) return scope.factoryId === resolved.factoryId;
    return true;
  };

  return {
    assertPermission: () => Promise.resolve(),
    assertScope: ({ scope }: { scope: ResourceScope }) =>
      covers(scope)
        ? Promise.resolve()
        : Promise.reject(
            new AppError('FORBIDDEN', 'Target is outside your granted scope.'),
          ),
    listableScopeGrants: () =>
      Promise.resolve(grant === 'org' ? 'all' : [resolved!]),
  } as unknown as ScopeAuthorizer;
}

const principal: RequestPrincipal = {
  userAccountId: 'acc-1',
  organizationId: ORG,
  tokenId: 'tok-1',
};

function makeService(grant: ScopeGrant | 'org'): {
  service: OrganizationsService;
  audit: AuditRow[];
  teams: TeamRow[];
} {
  const { prisma, audit, teams } = createPrisma();
  const service = new OrganizationsService(
    prisma,
    scopedAuthorizer(grant),
    new AuditService(prisma),
  );
  return { service, audit, teams };
}

const factoryGrant = (factoryId: string): ScopeGrant => ({
  organizationId: ORG,
  factoryId,
  departmentId: null,
  teamId: null,
});

const departmentGrant = (
  factoryId: string,
  departmentId: string,
): ScopeGrant => ({
  organizationId: ORG,
  factoryId,
  departmentId,
  teamId: null,
});

const teamGrant = (
  factoryId: string,
  departmentId: string,
  teamId: string,
): ScopeGrant => ({ organizationId: ORG, factoryId, departmentId, teamId });

describe('OrganizationsService containment and audit', () => {
  it('rejects a team whose factory differs from its department factory', async () => {
    const { service } = makeService(factoryGrant(FACTORY_A));

    await expect(
      service.createTeam(principal, {
        // Department dep-a1 belongs to factory A, but the team claims factory B.
        factoryId: FACTORY_B,
        departmentId: DEP_A1,
        code: 'TEAM-X',
        name: 'Team X',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('lets a factory-scoped principal create a team under its own factory and audits it', async () => {
    const { service, audit, teams } = makeService(factoryGrant(FACTORY_A));
    const before = teams.length;

    const team = await service.createTeam(principal, {
      factoryId: FACTORY_A,
      departmentId: DEP_A1,
      code: 'TEAM-NEW',
      name: 'Team New',
    });

    expect(team.factoryId).toBe(FACTORY_A);
    expect(team.departmentId).toBe(DEP_A1);
    expect(teams).toHaveLength(before + 1);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'team.create',
      entityType: 'Team',
      entityId: team.id,
      actorId: 'acc-1',
    });
  });

  it('forbids a factory-scoped principal from creating a team in another factory', async () => {
    const { service, audit, teams } = makeService(factoryGrant(FACTORY_A));
    const before = teams.length;

    await expect(
      service.createTeam(principal, {
        factoryId: FACTORY_B,
        departmentId: DEP_B1,
        code: 'TEAM-B',
        name: 'Team B',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Nothing was written: neither the team nor an audit row.
    expect(teams).toHaveLength(before);
    expect(audit).toHaveLength(0);
  });
});

describe('OrganizationsService single-resource scope', () => {
  it('forbids a factory-scoped principal from reading another factory department', async () => {
    const { service } = makeService(factoryGrant(FACTORY_A));

    await expect(
      service.getDepartment(principal, DEP_B1),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets a factory-scoped principal read a department in its own factory', async () => {
    const { service } = makeService(factoryGrant(FACTORY_A));

    const department = await service.getDepartment(principal, DEP_A1);
    expect(department.id).toBe(DEP_A1);
    expect(department.factoryId).toBe(FACTORY_A);
  });
});

describe('OrganizationsService narrow-scope list isolation', () => {
  it('does not leak sibling departments to a department-scoped principal', async () => {
    // Granted only Dept A1. Must NOT see Dept A2 (sibling in the same factory)
    // or Dept B1 (another factory).
    const { service } = makeService(departmentGrant(FACTORY_A, DEP_A1));

    const departments = await service.listDepartments(principal);
    expect(departments.map((d) => d.id)).toEqual([DEP_A1]);
  });

  it('does not leak sibling teams to a department-scoped principal', async () => {
    // Dept A1 contains teams A1a and A1b; both are in scope, but A2a (sibling
    // department) and B1a (other factory) are not.
    const { service } = makeService(departmentGrant(FACTORY_A, DEP_A1));

    const teams = await service.listTeams(principal);
    expect(teams.map((t) => t.id).sort()).toEqual([TEAM_A1A, TEAM_A1B]);
  });

  it('does not leak sibling teams to a team-scoped principal', async () => {
    // Granted only Team A1a. Must NOT see A1b (sibling team in the same
    // department), nor A2a or B1a.
    const { service } = makeService(teamGrant(FACTORY_A, DEP_A1, TEAM_A1A));

    const teams = await service.listTeams(principal);
    expect(teams.map((t) => t.id)).toEqual([TEAM_A1A]);
  });

  it('shows a team-scoped principal only its own department, not siblings', async () => {
    const { service } = makeService(teamGrant(FACTORY_A, DEP_A1, TEAM_A1A));

    const departments = await service.listDepartments(principal);
    expect(departments.map((d) => d.id)).toEqual([DEP_A1]);
  });

  it('scopes getScopeTree for a team-scoped principal to its own branch only', async () => {
    const { service } = makeService(teamGrant(FACTORY_A, DEP_A1, TEAM_A1A));

    const tree = await service.getScopeTree(principal);

    // Only Factory A is visible, with only Dept A1 and only Team A1a inside it.
    expect(tree.factories.map((f) => f.id)).toEqual([FACTORY_A]);
    const factory = tree.factories[0];
    expect(factory.departments.map((d) => d.id)).toEqual([DEP_A1]);
    expect(factory.departments[0].teams.map((t) => t.id)).toEqual([TEAM_A1A]);
  });

  it('scopes getScopeTree for a department-scoped principal to its department', async () => {
    const { service } = makeService(departmentGrant(FACTORY_A, DEP_A1));

    const tree = await service.getScopeTree(principal);

    expect(tree.factories.map((f) => f.id)).toEqual([FACTORY_A]);
    expect(tree.factories[0].departments.map((d) => d.id)).toEqual([DEP_A1]);
    expect(
      tree.factories[0].departments[0].teams.map((t) => t.id).sort(),
    ).toEqual([TEAM_A1A, TEAM_A1B]);
  });

  it('an explicit factoryId filter cannot widen a department-scoped grant', async () => {
    // Asking for Factory B while granted only Dept A1 returns nothing, never
    // Factory B's departments.
    const { service } = makeService(departmentGrant(FACTORY_A, DEP_A1));

    const departments = await service.listDepartments(principal, FACTORY_B);
    expect(departments).toEqual([]);
  });

  it('lets an org-scoped principal see the whole tree', async () => {
    const { service } = makeService('org');

    const tree = await service.getScopeTree(principal);
    expect(tree.factories.map((f) => f.id).sort()).toEqual([
      FACTORY_A,
      FACTORY_B,
    ]);
    const departments = await service.listDepartments(principal);
    expect(departments.map((d) => d.id).sort()).toEqual([
      DEP_A1,
      DEP_A2,
      DEP_B1,
    ]);
  });
});
