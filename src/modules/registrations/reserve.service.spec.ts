import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import {
  PrincipalAuthorizationService,
  ResolvedAuthorization,
} from '../../common/authorization/principal-authorization.service';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { Clock } from '../../common/time/clock';
import { Prisma } from '../../generated/prisma/client';
import { MealSessionAccess } from '../meal-sessions/meal-session-access.service';
import { RegistrationWindow } from '../meal-sessions/meal-sessions.types';
import { ReserveService } from './reserve.service';

const ORG = 'org-1';
const FACTORY = 'factory-1';
const DEPT = 'dept-1';
const TEAM = 'team-1';
const SESSION = 'session-1';
const DISH_A = 'dish-a';
const DISH_B = 'dish-b';
const EMPLOYEE = 'emp-1';

interface SettingRow {
  id: string;
  mealSessionDishId: string;
  isEnabled: boolean;
  quantity: number;
}

interface AllocationRow {
  id: string;
  organizationId: string;
  mealSessionId: string;
  mealSessionDishId: string;
  employeeId: string | null;
  quantity: number;
  status: 'ALLOCATED' | 'CANCELLED';
  reason: string | null;
  allocatedByUserId: string;
  allocatedAt: Date;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  details: Record<string, unknown>;
}

const principal: RequestPrincipal = {
  userAccountId: 'acc-admin',
  organizationId: ORG,
  tokenId: 'tok-1',
};

/**
 * In-memory Prisma double for the reserve service. Models the one session, its
 * dishes, the reserve settings, and the allocation rows. `$queryRaw` emulates
 * the `SELECT ... FOR UPDATE` on the setting row (returning snake_case columns
 * exactly as the real driver does); allocation aggregate/groupBy sum the
 * ALLOCATED rows from the SAME shared array the create pushes into, so a
 * sequential second allocation sees the first's committed total.
 */
function createPrisma(options: {
  settings: SettingRow[];
  allocations?: AllocationRow[];
  mealRegistrations?: unknown[];
  dishes?: { id: string; mealSessionId: string }[];
  employees?: { id: string; factoryId: string }[];
}): {
  prisma: PrismaService;
  settings: SettingRow[];
  allocations: AllocationRow[];
  mealRegistrations: unknown[];
  audit: AuditRow[];
} {
  const settings = options.settings;
  const allocations = options.allocations ?? [];
  const mealRegistrations = options.mealRegistrations ?? [];
  const audit: AuditRow[] = [];
  const dishes = options.dishes ?? [
    { id: DISH_A, mealSessionId: SESSION },
    { id: DISH_B, mealSessionId: SESSION },
  ];
  const employees = options.employees ?? [{ id: EMPLOYEE, factoryId: FACTORY }];
  let allocationSeq = allocations.length;

  const sumAllocated = (mealSessionDishId: string): number =>
    allocations
      .filter(
        (a) =>
          a.mealSessionDishId === mealSessionDishId && a.status === 'ALLOCATED',
      )
      .reduce((total, a) => total + a.quantity, 0);

  const reserveAllocation = {
    aggregate: ({
      where,
    }: {
      where: { mealSessionDishId: string; status: string };
    }) =>
      Promise.resolve({
        _sum: { quantity: sumAllocated(where.mealSessionDishId) },
      }),
    groupBy: ({ where }: { where: { mealSessionId: string } }) => {
      const byDish = new Map<string, number>();
      for (const a of allocations) {
        if (
          a.mealSessionId === where.mealSessionId &&
          a.status === 'ALLOCATED'
        ) {
          byDish.set(
            a.mealSessionDishId,
            (byDish.get(a.mealSessionDishId) ?? 0) + a.quantity,
          );
        }
      }
      return Promise.resolve(
        [...byDish.entries()].map(([mealSessionDishId, quantity]) => ({
          mealSessionDishId,
          _sum: { quantity },
        })),
      );
    },
    create: ({ data }: { data: Omit<AllocationRow, 'id'> }) => {
      const row: AllocationRow = { id: `alloc-${++allocationSeq}`, ...data };
      allocations.push(row);
      return Promise.resolve({ ...row });
    },
  };

  const txClient = {
    reserveAllocation,
    reservePoolSetting: {
      upsert: ({
        where,
        create,
        update,
      }: {
        where: { mealSessionDishId: string };
        create: Omit<SettingRow, 'id'>;
        update: Partial<SettingRow>;
      }) => {
        const existing = settings.find(
          (s) => s.mealSessionDishId === where.mealSessionDishId,
        );
        if (existing) {
          Object.assign(existing, update);
          return Promise.resolve({ ...existing });
        }
        const row: SettingRow = {
          id: `setting-${settings.length + 1}`,
          ...create,
        };
        settings.push(row);
        return Promise.resolve({ ...row });
      },
    },
    auditLog: {
      create: ({ data }: { data: AuditRow }) => {
        audit.push(data);
        return Promise.resolve(data);
      },
    },
    $queryRaw: (query: Prisma.Sql) => queryRawForUpdate(query),
  };

  // The service calls `tx.$queryRaw(Prisma.sql`...`)` with a single
  // `Prisma.Sql` object (not a tagged template), passing the dish id as the one
  // interpolated value. Emulate the row-lock SELECT by returning the matching
  // setting in snake_case, as the pg driver does.
  function queryRawForUpdate(
    query: Prisma.Sql,
  ): Promise<{ id: string; is_enabled: boolean; quantity: number }[]> {
    const dishId = query.values[0] as string;
    const setting = settings.find((s) => s.mealSessionDishId === dishId);
    if (!setting) return Promise.resolve([]);
    return Promise.resolve([
      {
        id: setting.id,
        is_enabled: setting.isEnabled,
        quantity: setting.quantity,
      },
    ]);
  }

  const prisma = {
    mealSession: {
      findFirst: () => Promise.resolve({ factoryId: FACTORY }),
    },
    mealSessionDish: {
      findFirst: ({
        where,
      }: {
        where: { id: string; mealSessionId: string };
      }) => {
        const dish = dishes.find(
          (d) => d.id === where.id && d.mealSessionId === where.mealSessionId,
        );
        if (!dish) return Promise.resolve(null);
        return Promise.resolve({
          id: dish.id,
          mealSession: { factoryId: FACTORY },
        });
      },
      findMany: () =>
        Promise.resolve(
          dishes.map((d) => {
            const setting = settings.find((s) => s.mealSessionDishId === d.id);
            return {
              id: d.id,
              reservePoolSetting: setting
                ? { isEnabled: setting.isEnabled, quantity: setting.quantity }
                : null,
            };
          }),
        ),
    },
    employee: {
      findFirst: ({ where }: { where: { id: string; factoryId: string } }) => {
        const emp = employees.find(
          (e) => e.id === where.id && e.factoryId === where.factoryId,
        );
        if (!emp) return Promise.resolve(null);
        return Promise.resolve({
          organizationId: ORG,
          factoryId: emp.factoryId,
          departmentId: DEPT,
          teamId: TEAM,
        });
      },
    },
    reserveAllocation: {
      aggregate: reserveAllocation.aggregate,
      groupBy: reserveAllocation.groupBy,
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => fn(txClient as unknown as Prisma.TransactionClient),
  } as unknown as PrismaService;

  return { prisma, settings, allocations, mealRegistrations, audit };
}

function stubAuthorization(
  permissions: string[],
  scoped = true,
): PrincipalAuthorizationService {
  const resolved: ResolvedAuthorization = {
    roles: [],
    permissions,
    scopeGrants: [
      {
        roleCode: 'role',
        roleName: 'Role',
        organizationId: ORG,
        factoryId: scoped ? FACTORY : 'factory-other',
        departmentId: null,
        teamId: null,
      },
    ],
    employee: null,
  };
  return {
    resolve: () => Promise.resolve(resolved),
  } as unknown as PrincipalAuthorizationService;
}

function stubWindow(isOpen: boolean): MealSessionAccess {
  const window: RegistrationWindow = {
    mealSessionId: SESSION,
    state: isOpen ? 'OPEN' : 'CUTOFF_PASSED',
    isOpen,
    reason: isOpen ? 'Registration is open.' : 'The cutoff time has passed.',
    opensAt: new Date().toISOString(),
    cutoffAt: new Date().toISOString(),
  };
  return {
    getRegistrationWindow: () => Promise.resolve(window),
  } as unknown as MealSessionAccess;
}

function fixedClock(iso = '2025-03-09T12:00:00.000Z'): Clock {
  return { now: () => new Date(iso) } as unknown as Clock;
}

function makeService(options: {
  permissions?: string[];
  isOpen: boolean;
  scoped?: boolean;
  settings?: SettingRow[];
  allocations?: AllocationRow[];
  employees?: { id: string; factoryId: string }[];
}) {
  const authorization = stubAuthorization(
    options.permissions ?? ['reserve:manage'],
    options.scoped ?? true,
  );
  const { prisma, settings, allocations, audit } = createPrisma({
    settings: options.settings ?? [],
    allocations: options.allocations,
    employees: options.employees,
  });
  const service = new ReserveService(
    prisma,
    new ScopeAuthorizer(authorization),
    stubWindow(options.isOpen),
    new AuditService(prisma),
    fixedClock(),
  );
  return { service, settings, allocations, audit };
}

function setting(overrides: Partial<SettingRow> = {}): SettingRow {
  return {
    id: 'setting-a',
    mealSessionDishId: DISH_A,
    isEnabled: true,
    quantity: 2,
    ...overrides,
  };
}

describe('ReserveService', () => {
  describe('pool off => no allocation', () => {
    it('rejects allocation when the pool has no setting row', async () => {
      const { service, allocations } = makeService({
        isOpen: false,
        settings: [],
      });

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          reason: 'walk-in',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(allocations).toHaveLength(0);
    });

    it('rejects allocation when the pool is disabled', async () => {
      const { service, allocations } = makeService({
        isOpen: false,
        settings: [setting({ isEnabled: false, quantity: 5 })],
      });

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          reason: 'walk-in',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(allocations).toHaveLength(0);
    });
  });

  describe('allocation within remaining', () => {
    it('records reason, actor, time, recipient, status ALLOCATED, and an audit row', async () => {
      const { service, allocations, audit } = makeService({
        isOpen: false,
        settings: [setting({ quantity: 2 })],
      });

      const result = await service.allocate(principal, SESSION, {
        mealSessionDishId: DISH_A,
        employeeId: EMPLOYEE,
        reason: 'late arrival',
      });

      expect(result.status).toBe('ALLOCATED');
      expect(result.quantity).toBe(1);
      expect(result.employeeId).toBe(EMPLOYEE);
      expect(result.reason).toBe('late arrival');
      expect(result.allocatedByUserId).toBe('acc-admin');
      expect(result.allocatedAt).toBe('2025-03-09T12:00:00.000Z');

      expect(allocations).toHaveLength(1);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'reserve.allocate',
        entityType: 'ReserveAllocation',
        actorId: 'acc-admin',
      });
      expect(audit[0].details).toMatchObject({
        reason: 'late arrival',
        employeeId: EMPLOYEE,
      });
    });

    it('allocates an unassigned reserve (no recipient)', async () => {
      const { service } = makeService({
        isOpen: false,
        settings: [setting({ quantity: 1 })],
      });

      const result = await service.allocate(principal, SESSION, {
        mealSessionDishId: DISH_A,
        reason: 'spare meal',
      });
      expect(result.employeeId).toBeNull();
    });

    it('requires a non-empty reason', async () => {
      const { service } = makeService({
        isOpen: false,
        settings: [setting()],
      });

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          reason: '   ',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('over-allocation protection (atomic check-and-insert)', () => {
    it('rejects an allocation that would exceed the pool quantity', async () => {
      const { service, allocations } = makeService({
        isOpen: false,
        settings: [setting({ quantity: 2 })],
      });

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          quantity: 3,
          reason: 'too many',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(allocations).toHaveLength(0);
    });

    it('fills the pool, then rejects one more (remaining computed from committed rows)', async () => {
      const { service, allocations } = makeService({
        isOpen: false,
        settings: [setting({ quantity: 2 })],
      });

      await service.allocate(principal, SESSION, {
        mealSessionDishId: DISH_A,
        quantity: 2,
        reason: 'fill the pool',
      });
      expect(allocations).toHaveLength(1);

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          reason: 'one too many',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(allocations).toHaveLength(1);
    });

    it('fails the second of two sequential allocations summing to more than quantity', async () => {
      const { service, allocations } = makeService({
        isOpen: false,
        settings: [setting({ quantity: 3 })],
      });

      await service.allocate(principal, SESSION, {
        mealSessionDishId: DISH_A,
        quantity: 2,
        reason: 'first',
      });

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          quantity: 2,
          reason: 'second',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      // The first committed; the second re-read its total under the lock and
      // was rejected because 2 + 2 > 3.
      expect(allocations).toHaveLength(1);
    });
  });

  describe('admin-only', () => {
    it('forbids a principal without reserve:manage', async () => {
      const { service } = makeService({
        permissions: ['registration:adjust'],
        isOpen: false,
        settings: [setting()],
      });

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          reason: 'nope',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    it('forbids an admin without scope over the session factory', async () => {
      const { service } = makeService({
        isOpen: false,
        scoped: false,
        settings: [setting()],
      });

      await expect(
        service.allocate(principal, SESSION, {
          mealSessionDishId: DISH_A,
          reason: 'out of scope',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('reserve is separate from registration', () => {
    it('does not create a MealRegistration when allocating', async () => {
      const { service } = makeService({
        isOpen: false,
        settings: [setting({ quantity: 1 })],
      });

      // The in-memory double has no mealRegistration.create; if the service
      // tried to write one the call would throw. A clean allocation proves the
      // reserve path never touches registrations.
      const result = await service.allocate(principal, SESSION, {
        mealSessionDishId: DISH_A,
        employeeId: EMPLOYEE,
        reason: 'reserve, not a registration',
      });
      expect(result.status).toBe('ALLOCATED');
    });
  });

  describe('configuration before cutoff', () => {
    it('enables a pool and sets quantity while the window is open, with audit', async () => {
      const { service, settings, audit } = makeService({
        isOpen: true,
        settings: [],
      });

      const result = await service.configurePool(principal, SESSION, {
        mealSessionDishId: DISH_A,
        isEnabled: true,
        quantity: 5,
      });

      expect(result).toMatchObject({
        isEnabled: true,
        quantity: 5,
        remaining: 5,
      });
      expect(settings).toHaveLength(1);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'reserve.configure' });
    });

    it('rejects configuration after cutoff (pool size locked)', async () => {
      const { service, settings } = makeService({
        isOpen: false,
        settings: [],
      });

      await expect(
        service.configurePool(principal, SESSION, {
          mealSessionDishId: DISH_A,
          isEnabled: true,
          quantity: 5,
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(settings).toHaveLength(0);
    });

    it('refuses to shrink quantity below the already-allocated total', async () => {
      const { service } = makeService({
        isOpen: true,
        settings: [setting({ quantity: 3 })],
        allocations: [
          {
            id: 'alloc-1',
            organizationId: ORG,
            mealSessionId: SESSION,
            mealSessionDishId: DISH_A,
            employeeId: null,
            quantity: 2,
            status: 'ALLOCATED',
            reason: 'existing',
            allocatedByUserId: 'acc-admin',
            allocatedAt: new Date(),
          },
        ],
      });

      await expect(
        service.configurePool(principal, SESSION, {
          mealSessionDishId: DISH_A,
          isEnabled: true,
          quantity: 1,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });
  });

  describe('pool read', () => {
    it('returns quantity, allocated, and remaining per session dish', async () => {
      const { service } = makeService({
        isOpen: false,
        settings: [setting({ mealSessionDishId: DISH_A, quantity: 4 })],
        allocations: [
          {
            id: 'alloc-1',
            organizationId: ORG,
            mealSessionId: SESSION,
            mealSessionDishId: DISH_A,
            employeeId: null,
            quantity: 3,
            status: 'ALLOCATED',
            reason: 'existing',
            allocatedByUserId: 'acc-admin',
            allocatedAt: new Date(),
          },
        ],
      });

      const pools = await service.getPool(principal, SESSION);
      const dishA = pools.find((p) => p.mealSessionDishId === DISH_A);
      const dishB = pools.find((p) => p.mealSessionDishId === DISH_B);

      expect(dishA).toMatchObject({
        isEnabled: true,
        quantity: 4,
        allocated: 3,
        remaining: 1,
      });
      // A dish with no setting reports a disabled, zero pool.
      expect(dishB).toMatchObject({
        isEnabled: false,
        quantity: 0,
        allocated: 0,
        remaining: 0,
      });
    });
  });
});
