import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { ReportsService } from './reports.service';

interface DishRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
}

interface SessionRow {
  id: string;
  organizationId: string;
  factoryId: string;
  serviceDate: Date;
  mealType: 'LUNCH' | 'DINNER';
  status: 'DRAFT' | 'PUBLISHED' | 'OPEN' | 'CLOSED' | 'CANCELLED';
}

interface SessionDishRow {
  id: string;
  mealSessionId: string;
  dishId: string;
  sortOrder: number;
}

interface RegistrationRow {
  mealSessionId: string;
  mealSessionDishId: string;
  status: 'REGISTERED' | 'CANCELLED' | 'ABSENT';
}

interface ReserveAllocationRow {
  mealSessionId: string;
  mealSessionDishId: string;
  quantity: number;
  status: 'ALLOCATED' | 'CANCELLED';
}

const ORG = 'org-1';
const FACTORY = 'factory-1';
const OTHER_FACTORY = 'factory-2';
const DAY_MON = '2025-03-10';

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * In-memory Prisma double for the reports read path. It serves the two reads
 * the service makes (session + offered dishes, catalog dishes) and records any
 * attempt to open a transaction or write an audit row, so a test can prove the
 * report path performs no writes.
 */
function createPrisma(options: {
  sessions?: SessionRow[];
  sessionDishes?: SessionDishRow[];
  dishes?: DishRow[];
  registrations?: RegistrationRow[];
  reserveAllocations?: ReserveAllocationRow[];
}): { prisma: PrismaService; writes: string[] } {
  const sessions = options.sessions ?? [];
  const sessionDishes = options.sessionDishes ?? [];
  const dishes = options.dishes ?? [];
  const registrations = options.registrations ?? [];
  const reserveAllocations = options.reserveAllocations ?? [];
  const writes: string[] = [];

  const prisma = {
    mealSession: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; organizationId?: string };
      }) => {
        const found = sessions.find(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.organizationId === undefined ||
              row.organizationId === where.organizationId),
        );
        return Promise.resolve(
          found
            ? {
                ...found,
                dishes: sessionDishes
                  .filter((dish) => dish.mealSessionId === found.id)
                  .map((dish) => ({ ...dish })),
              }
            : null,
        );
      },
      create: () => {
        writes.push('mealSession.create');
        return Promise.reject(new Error('writes are not allowed in reports'));
      },
      update: () => {
        writes.push('mealSession.update');
        return Promise.reject(new Error('writes are not allowed in reports'));
      },
    },
    dish: {
      findMany: ({
        where,
      }: {
        where: { organizationId?: string; id?: { in: string[] } };
      }) =>
        Promise.resolve(
          dishes
            .filter(
              (row) =>
                (where.organizationId === undefined ||
                  row.organizationId === where.organizationId) &&
                (where.id === undefined || where.id.in.includes(row.id)),
            )
            .map((row) => ({ id: row.id, code: row.code, name: row.name })),
        ),
    },
    mealRegistration: {
      groupBy: ({
        where,
      }: {
        where: { mealSessionId: string; status: { in: string[] } };
      }) => {
        const matching = registrations.filter(
          (row) =>
            row.mealSessionId === where.mealSessionId &&
            where.status.in.includes(row.status),
        );
        const byKey = new Map<
          string,
          { mealSessionDishId: string; status: string; count: number }
        >();
        for (const row of matching) {
          const key = `${row.mealSessionDishId}|${row.status}`;
          const entry = byKey.get(key) ?? {
            mealSessionDishId: row.mealSessionDishId,
            status: row.status,
            count: 0,
          };
          entry.count += 1;
          byKey.set(key, entry);
        }
        return Promise.resolve(
          [...byKey.values()].map((entry) => ({
            mealSessionDishId: entry.mealSessionDishId,
            status: entry.status,
            _count: { _all: entry.count },
          })),
        );
      },
    },
    reserveAllocation: {
      groupBy: ({
        where,
      }: {
        where: { mealSessionId: string; status: string };
      }) => {
        const byDish = new Map<string, number>();
        for (const row of reserveAllocations) {
          if (
            row.mealSessionId === where.mealSessionId &&
            row.status === where.status
          ) {
            byDish.set(
              row.mealSessionDishId,
              (byDish.get(row.mealSessionDishId) ?? 0) + row.quantity,
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
    },
    auditLog: {
      create: () => {
        writes.push('auditLog.create');
        return Promise.reject(new Error('writes are not allowed in reports'));
      },
    },
    $transaction: () => {
      writes.push('$transaction');
      return Promise.reject(new Error('writes are not allowed in reports'));
    },
  } as unknown as PrismaService;

  return { prisma, writes };
}

function stubAuthorizer(options: {
  hasPermission: boolean;
  allowedFactoryId: string | 'all';
}): ScopeAuthorizer {
  return {
    assertPermission: () =>
      options.hasPermission
        ? Promise.resolve()
        : Promise.reject(
            new AppError('FORBIDDEN', 'Missing required permission.'),
          ),
    assertScope: ({ scope }: { scope: { factoryId?: string | null } }) => {
      if (options.allowedFactoryId === 'all') return Promise.resolve();
      return scope.factoryId === options.allowedFactoryId
        ? Promise.resolve()
        : Promise.reject(
            new AppError('FORBIDDEN', 'Target is outside your granted scope.'),
          );
    },
  } as unknown as ScopeAuthorizer;
}

const principal: RequestPrincipal = {
  userAccountId: 'acc-1',
  organizationId: ORG,
  tokenId: 'tok-1',
};

function makeService(
  options: {
    hasPermission?: boolean;
    allowedFactoryId?: string | 'all';
    sessions?: SessionRow[];
    sessionDishes?: SessionDishRow[];
    dishes?: DishRow[];
    registrations?: RegistrationRow[];
    reserveAllocations?: ReserveAllocationRow[];
  } = {},
): { service: ReportsService; writes: string[] } {
  const { prisma, writes } = createPrisma(options);
  const service = new ReportsService(
    prisma,
    stubAuthorizer({
      hasPermission: options.hasPermission ?? true,
      allowedFactoryId: options.allowedFactoryId ?? 'all',
    }),
  );
  return { service, writes };
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    organizationId: ORG,
    factoryId: FACTORY,
    serviceDate: utcDate(DAY_MON),
    mealType: 'LUNCH',
    status: 'OPEN',
    ...overrides,
  };
}

const fullSetup = {
  sessions: [session()],
  sessionDishes: [
    { id: 'sd-2', mealSessionId: 'session-1', dishId: 'dish-b', sortOrder: 1 },
    { id: 'sd-1', mealSessionId: 'session-1', dishId: 'dish-a', sortOrder: 0 },
  ],
  dishes: [
    { id: 'dish-a', organizationId: ORG, code: 'COM-GA', name: 'Cơm gà' },
    { id: 'dish-b', organizationId: ORG, code: 'CHAO', name: 'Cháo chay' },
  ],
};

describe('ReportsService.getSessionSummary', () => {
  it('resolves offered dishes to catalog code/name, ordered by sortOrder', async () => {
    const { service } = makeService(fullSetup);

    const summary = await service.getSessionSummary(principal, 'session-1');

    expect(summary.mealSessionId).toBe('session-1');
    expect(summary.factoryId).toBe(FACTORY);
    expect(summary.serviceDate).toBe(DAY_MON);
    expect(summary.mealType).toBe('LUNCH');
    expect(summary.status).toBe('OPEN');
    expect(summary.offeredDishCount).toBe(2);
    expect(summary.dishes.map((d) => d.code)).toEqual(['COM-GA', 'CHAO']);
    expect(summary.dishes.map((d) => d.name)).toEqual(['Cơm gà', 'Cháo chay']);
    expect(summary.dishes.map((d) => d.sortOrder)).toEqual([0, 1]);
  });

  it('aggregates real per-dish counts and totalRegistered from Phase 2 data', async () => {
    // dish-a (sd-1): 2 REGISTERED, 1 ABSENT, 1 CANCELLED (ignored), reserve 2.
    // dish-b (sd-2): 1 REGISTERED, reserve 0.
    const { service } = makeService({
      ...fullSetup,
      registrations: [
        {
          mealSessionId: 'session-1',
          mealSessionDishId: 'sd-1',
          status: 'REGISTERED',
        },
        {
          mealSessionId: 'session-1',
          mealSessionDishId: 'sd-1',
          status: 'REGISTERED',
        },
        {
          mealSessionId: 'session-1',
          mealSessionDishId: 'sd-1',
          status: 'ABSENT',
        },
        {
          mealSessionId: 'session-1',
          mealSessionDishId: 'sd-1',
          status: 'CANCELLED',
        },
        {
          mealSessionId: 'session-1',
          mealSessionDishId: 'sd-2',
          status: 'REGISTERED',
        },
      ],
      reserveAllocations: [
        {
          mealSessionId: 'session-1',
          mealSessionDishId: 'sd-1',
          quantity: 2,
          status: 'ALLOCATED',
        },
        {
          mealSessionId: 'session-1',
          mealSessionDishId: 'sd-1',
          quantity: 3,
          status: 'CANCELLED',
        },
      ],
    });

    const summary = await service.getSessionSummary(principal, 'session-1');

    // dishes are ordered by sortOrder: dish-a (0) then dish-b (1).
    const dishA = summary.dishes[0];
    const dishB = summary.dishes[1];
    expect(dishA.code).toBe('COM-GA');
    expect(dishA).toMatchObject({
      registeredCount: 2,
      absentCount: 1,
      reserveCount: 2,
    });
    expect(dishB.code).toBe('CHAO');
    expect(dishB).toMatchObject({
      registeredCount: 1,
      absentCount: 0,
      reserveCount: 0,
    });
    // totalRegistered sums REGISTERED only, not ABSENT or reserve.
    expect(summary.totalRegistered).toBe(3);
  });

  it('reports zero registration counts for a session with no Phase 2 data', async () => {
    const { service } = makeService(fullSetup);

    const summary = await service.getSessionSummary(principal, 'session-1');

    expect(summary.totalRegistered).toBe(0);
    for (const dish of summary.dishes) {
      expect(dish.registeredCount).toBe(0);
      expect(dish.absentCount).toBe(0);
      expect(dish.reserveCount).toBe(0);
    }
  });

  it('allows a factory-scoped principal to summarize its own factory session', async () => {
    const { service } = makeService({
      ...fullSetup,
      allowedFactoryId: FACTORY,
    });

    const summary = await service.getSessionSummary(principal, 'session-1');
    expect(summary.offeredDishCount).toBe(2);
  });

  it('forbids a factory-scoped principal from summarizing another factory session', async () => {
    const { service } = makeService({
      ...fullSetup,
      allowedFactoryId: OTHER_FACTORY,
    });

    await expect(
      service.getSessionSummary(principal, 'session-1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('forbids a principal missing report:read', async () => {
    const { service } = makeService({ ...fullSetup, hasPermission: false });

    await expect(
      service.getSessionSummary(principal, 'session-1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('returns NOT_FOUND for a session outside the organization', async () => {
    const { service } = makeService(fullSetup);

    await expect(
      service.getSessionSummary(principal, 'missing'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('performs no writes: no transaction and no audit row', async () => {
    const { service, writes } = makeService(fullSetup);

    await service.getSessionSummary(principal, 'session-1');

    expect(writes).toEqual([]);
  });
});
