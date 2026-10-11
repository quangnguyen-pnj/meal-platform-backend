import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { Clock } from '../../common/time/clock';
import { Prisma } from '../../generated/prisma/client';
import { MealSessionAccess } from '../meal-sessions/meal-session-access.service';
import { RegistrationWindow } from '../meal-sessions/meal-sessions.types';
import { BulkRegistrationsService } from './bulk-registrations.service';
import { BulkEntryInput } from './registrations.types';

const ORG = 'org-1';
const FACTORY = 'factory-1';
const SESSION = 'session-1';
const DISH_A = 'dish-a';
const DISH_B = 'dish-b';
const TEAM = 'team-1';
const DEPT = 'dept-1';

const principal: RequestPrincipal = {
  userAccountId: 'acc-rep',
  organizationId: ORG,
  tokenId: 'tok-1',
};

interface EmployeeRow {
  id: string;
  organizationId: string;
  factoryId: string;
  departmentId: string;
  teamId: string;
}

interface RegistrationRow {
  id: string;
  organizationId: string;
  mealSessionId: string;
  employeeId: string;
  mealSessionDishId: string;
  status: 'REGISTERED' | 'CANCELLED' | 'ABSENT';
  source: 'SELF' | 'BULK' | 'PAPER_FORM' | 'ADMIN_ADJUSTMENT';
  registrationBatchId: string | null;
  createdByUserId: string;
  updatedByUserId: string | null;
  registeredAt: Date;
  cancelledAt: Date | null;
  absentAt: Date | null;
}

interface BatchRow {
  id: string;
  status: 'DRAFT' | 'COMMITTED' | 'REJECTED';
  source: string;
  reason: string | null;
}

interface BatchEntryRow {
  registrationBatchId: string;
  employeeId: string;
  status: string;
}

interface ChangeRow {
  mealRegistrationId: string;
  kind: string;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
}

/**
 * In-memory Prisma double for bulk registration. Models the reads/writes the
 * service makes: session + dish lookup, scoped employee listing, the single
 * `[session, employee]` registration row (findUnique/create/update), batch and
 * batch-entry creation, change + audit staging inside `$transaction`.
 */
function createPrisma(options: {
  employees: EmployeeRow[];
  dishIds: string[];
  registrations?: RegistrationRow[];
  sessionExists?: boolean;
}): {
  prisma: PrismaService;
  registrations: RegistrationRow[];
  batches: BatchRow[];
  batchEntries: BatchEntryRow[];
  changes: ChangeRow[];
  audit: AuditRow[];
} {
  const employees = options.employees;
  const dishIds = options.dishIds;
  const registrations: RegistrationRow[] = options.registrations ?? [];
  const batches: BatchRow[] = [];
  const batchEntries: BatchEntryRow[] = [];
  const changes: ChangeRow[] = [];
  const audit: AuditRow[] = [];
  let idSeq = 0;

  const matchesWhere = (
    employee: EmployeeRow,
    where: Record<string, unknown>,
  ): boolean => {
    if (where.AND) {
      return (where.AND as Record<string, unknown>[]).every((clause) =>
        matchesWhere(employee, clause),
      );
    }
    if (where.OR) {
      return (where.OR as Record<string, unknown>[]).some((clause) =>
        matchesWhere(employee, clause),
      );
    }
    return Object.entries(where).every(
      ([key, value]) =>
        (employee as unknown as Record<string, unknown>)[key] === value,
    );
  };

  const findRegistration = (where: {
    mealSessionId_employeeId?: { mealSessionId: string; employeeId: string };
  }): RegistrationRow | null => {
    const key = where.mealSessionId_employeeId;
    if (!key) return null;
    return (
      registrations.find(
        (row) =>
          row.mealSessionId === key.mealSessionId &&
          row.employeeId === key.employeeId,
      ) ?? null
    );
  };

  const txClient = {
    registrationBatch: {
      create: ({ data }: { data: Partial<BatchRow> }) => {
        const row: BatchRow = {
          id: `batch-${idSeq++}`,
          status: data.status ?? 'DRAFT',
          source: data.source ?? 'BULK',
          reason: data.reason ?? null,
        };
        batches.push(row);
        return Promise.resolve({ ...row });
      },
    },
    registrationBatchEntry: {
      createMany: ({ data }: { data: BatchEntryRow[] }) => {
        batchEntries.push(...data);
        return Promise.resolve({ count: data.length });
      },
    },
    mealRegistration: {
      findUnique: ({
        where,
      }: {
        where: {
          mealSessionId_employeeId?: {
            mealSessionId: string;
            employeeId: string;
          };
        };
      }) => {
        const found = findRegistration(where);
        return Promise.resolve(found ? { ...found } : null);
      },
      create: ({ data }: { data: Partial<RegistrationRow> }) => {
        const row: RegistrationRow = {
          id: `reg-${idSeq++}`,
          organizationId: data.organizationId as string,
          mealSessionId: data.mealSessionId as string,
          employeeId: data.employeeId as string,
          mealSessionDishId: data.mealSessionDishId as string,
          status: data.status ?? 'REGISTERED',
          source: data.source ?? 'BULK',
          registrationBatchId: data.registrationBatchId ?? null,
          createdByUserId: data.createdByUserId as string,
          updatedByUserId: data.updatedByUserId ?? null,
          registeredAt: (data.registeredAt as Date) ?? new Date(),
          cancelledAt: data.cancelledAt ?? null,
          absentAt: data.absentAt ?? null,
        };
        registrations.push(row);
        return Promise.resolve({ ...row });
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<RegistrationRow>;
      }) => {
        const row = registrations.find((r) => r.id === where.id);
        if (!row) throw new Error('registration not found');
        Object.assign(row, data);
        return Promise.resolve({ ...row });
      },
    },
    registrationChange: {
      create: ({ data }: { data: ChangeRow }) => {
        changes.push(data);
        return Promise.resolve(data);
      },
    },
    auditLog: {
      create: ({ data }: { data: AuditRow }) => {
        audit.push(data);
        return Promise.resolve(data);
      },
    },
  } as unknown as Prisma.TransactionClient;

  const prisma = {
    mealSession: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; organizationId?: string };
      }) => {
        if (options.sessionExists === false) return Promise.resolve(null);
        if (where.organizationId && where.organizationId !== ORG) {
          return Promise.resolve(null);
        }
        return Promise.resolve({
          id: SESSION,
          factoryId: FACTORY,
          dishes: dishIds.map((id) => ({ id })),
        });
      },
    },
    employee: {
      findMany: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          employees
            .filter((employee) => matchesWhere(employee, where))
            .map((employee) => ({ ...employee })),
        ),
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => fn(txClient),
  } as unknown as PrismaService;

  return { prisma, registrations, batches, batchEntries, changes, audit };
}

/**
 * A ScopeAuthorizer double. `scopeFilter` returns a team-level filter by
 * default (the representative sees only their own team), so the service's
 * in-scope employee set is just that team's employees in the factory.
 */
function stubScopeAuthorizer(options: {
  hasPermission?: boolean;
  scopeFilter?: Record<string, unknown>;
}): ScopeAuthorizer {
  return {
    assertPermission: () => {
      if (options.hasPermission === false) {
        return Promise.reject(
          Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }),
        );
      }
      return Promise.resolve();
    },
    scopeFilter: () =>
      Promise.resolve(
        options.scopeFilter ?? { organizationId: ORG, teamId: TEAM },
      ),
  } as unknown as ScopeAuthorizer;
}

function stubMealSessionAccess(
  window: Partial<RegistrationWindow>,
): MealSessionAccess {
  const full: RegistrationWindow = {
    mealSessionId: SESSION,
    state: 'OPEN',
    isOpen: true,
    reason: 'Registration is open.',
    opensAt: new Date().toISOString(),
    cutoffAt: new Date().toISOString(),
    ...window,
  };
  return {
    getRegistrationWindow: () => Promise.resolve(full),
  } as unknown as MealSessionAccess;
}

function fixedClock(iso = '2025-03-09T12:00:00.000Z'): Clock {
  return { now: () => new Date(iso) } as unknown as Clock;
}

function employee(
  id: string,
  overrides: Partial<EmployeeRow> = {},
): EmployeeRow {
  return {
    id,
    organizationId: ORG,
    factoryId: FACTORY,
    departmentId: DEPT,
    teamId: TEAM,
    ...overrides,
  };
}

function makeService(options: {
  employees: EmployeeRow[];
  dishIds?: string[];
  registrations?: RegistrationRow[];
  hasPermission?: boolean;
  scopeFilter?: Record<string, unknown>;
  window?: Partial<RegistrationWindow>;
  sessionExists?: boolean;
}) {
  const store = createPrisma({
    employees: options.employees,
    dishIds: options.dishIds ?? [DISH_A, DISH_B],
    registrations: options.registrations,
    sessionExists: options.sessionExists,
  });
  const service = new BulkRegistrationsService(
    store.prisma,
    stubScopeAuthorizer({
      hasPermission: options.hasPermission,
      scopeFilter: options.scopeFilter,
    }),
    stubMealSessionAccess(options.window ?? {}),
    new AuditService(store.prisma),
    fixedClock(),
  );
  return { service, ...store };
}

function existingRegistration(
  overrides: Partial<RegistrationRow> = {},
): RegistrationRow {
  return {
    id: 'reg-existing',
    organizationId: ORG,
    mealSessionId: SESSION,
    employeeId: 'emp-1',
    mealSessionDishId: DISH_A,
    status: 'REGISTERED',
    source: 'BULK',
    registrationBatchId: 'batch-old',
    createdByUserId: 'acc-rep',
    updatedByUserId: null,
    registeredAt: new Date('2025-03-08T00:00:00.000Z'),
    cancelledAt: null,
    absentAt: null,
    ...overrides,
  };
}

describe('BulkRegistrationsService', () => {
  it('registers multiple in-scope employees in one commit, each with a change and a single batch audit row', async () => {
    const { service, registrations, batches, changes, audit } = makeService({
      employees: [employee('emp-1'), employee('emp-2'), employee('emp-3')],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      { employeeId: 'emp-2', mealSessionDishId: DISH_B },
      { employeeId: 'emp-3', notEating: true },
    ];

    const result = await service.commit(principal, SESSION, entries);

    expect(result.status).toBe('COMMITTED');
    expect(result.registrations).toHaveLength(2);
    expect(registrations).toHaveLength(2);
    expect(registrations.every((r) => r.source === 'BULK')).toBe(true);
    expect(
      registrations.every((r) => r.registrationBatchId === batches[0].id),
    ).toBe(true);
    expect(changes).toHaveLength(2);
    expect(changes.every((c) => c.kind === 'CREATED')).toBe(true);
    // Exactly one batch audit row for the whole commit.
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'registration.bulk.commit',
      entityType: 'RegistrationBatch',
    });
    expect(result.notEatingCount).toBe(1);
    expect(batches[0].status).toBe('COMMITTED');
  });

  it('writes nothing when one entry is out of scope, recording a REJECTED batch', async () => {
    // emp-ghost is not in the scoped employee set, so its entry is INVALID.
    const { service, registrations, batches, changes } = makeService({
      employees: [employee('emp-1'), employee('emp-2')],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      { employeeId: 'emp-ghost', mealSessionDishId: DISH_B },
    ];

    await expect(
      service.commit(principal, SESSION, entries),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(registrations).toHaveLength(0);
    expect(changes).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0].status).toBe('REJECTED');
  });

  it('writes nothing when a chosen dish is not offered by the session', async () => {
    const { service, registrations, batches } = makeService({
      employees: [employee('emp-1')],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: 'dish-not-here' },
    ];

    await expect(
      service.commit(principal, SESSION, entries),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(registrations).toHaveLength(0);
    expect(batches[0].status).toBe('REJECTED');
  });

  it('validate returns unselected count, not-eating count, and totals by dish', async () => {
    const { service } = makeService({
      employees: [
        employee('emp-1'),
        employee('emp-2'),
        employee('emp-3'),
        employee('emp-4'),
        employee('emp-5'),
      ],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      { employeeId: 'emp-2', mealSessionDishId: DISH_A },
      { employeeId: 'emp-3', mealSessionDishId: DISH_B },
      { employeeId: 'emp-4', notEating: true },
    ];

    const result = await service.validate(principal, SESSION, entries);

    expect(result.isValid).toBe(true);
    expect(result.inScopeEmployeeCount).toBe(5);
    expect(result.eatingCount).toBe(3);
    expect(result.notEatingCount).toBe(1);
    // emp-5 has no entry at all.
    expect(result.unselected).toBe(1);
    expect(result.totalsByDish).toEqual(
      expect.arrayContaining([
        { mealSessionDishId: DISH_A, count: 2 },
        { mealSessionDishId: DISH_B, count: 1 },
      ]),
    );
  });

  it('commit response carries the unselected count and totals by dish', async () => {
    const { service } = makeService({
      employees: [employee('emp-1'), employee('emp-2'), employee('emp-3')],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      { employeeId: 'emp-2', mealSessionDishId: DISH_A },
    ];

    const result = await service.commit(principal, SESSION, entries);

    expect(result.unselected).toBe(1);
    expect(result.totalsByDish).toEqual([
      { mealSessionDishId: DISH_A, count: 2 },
    ]);
  });

  it('rejects commit after cutoff with the window reason, writing nothing', async () => {
    const { service, registrations, batches } = makeService({
      employees: [employee('emp-1')],
      window: {
        state: 'CUTOFF_PASSED',
        isOpen: false,
        reason: 'The cutoff time has passed; registration is closed.',
      },
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
    ];

    await expect(
      service.commit(principal, SESSION, entries),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The cutoff time has passed; registration is closed.',
    });
    expect(registrations).toHaveLength(0);
    // The batch was valid, so no REJECTED batch is written; cutoff stops it.
    expect(batches).toHaveLength(0);
  });

  it('re-committing corrected entries updates the existing per-employee row without duplicating', async () => {
    const { service, registrations, changes } = makeService({
      employees: [employee('emp-1')],
      registrations: [existingRegistration({ mealSessionDishId: DISH_A })],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_B },
    ];

    const result = await service.commit(principal, SESSION, entries);

    expect(registrations).toHaveLength(1);
    expect(registrations[0].id).toBe('reg-existing');
    expect(registrations[0].mealSessionDishId).toBe(DISH_B);
    expect(result.registrations[0].mealSessionDishId).toBe(DISH_B);
    expect(changes.map((c) => c.kind)).toEqual(['DISH_CHANGED']);
  });

  it('rejects an entry that is both not-eating and has a dish', async () => {
    const { service, registrations } = makeService({
      employees: [employee('emp-1')],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A, notEating: true },
    ];

    await expect(
      service.commit(principal, SESSION, entries),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(registrations).toHaveLength(0);
  });

  it('rejects a duplicate employee within the batch', async () => {
    const { service } = makeService({
      employees: [employee('emp-1')],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      { employeeId: 'emp-1', mealSessionDishId: DISH_B },
    ];

    const result = await service.validate(principal, SESSION, entries);
    expect(result.isValid).toBe(false);
    expect(result.entries[1].errors).toContain(
      'Employee appears more than once in this batch.',
    );
  });

  it('forbids bulk registration without the registration:bulk permission', async () => {
    const { service } = makeService({
      employees: [employee('emp-1')],
      hasPermission: false,
    });

    await expect(
      service.validate(principal, SESSION, [
        { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      ]),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a wider (factory) scope grant includes employees across teams', async () => {
    const { service } = makeService({
      employees: [
        employee('emp-1', { teamId: 'team-1' }),
        employee('emp-2', { teamId: 'team-2' }),
      ],
      // Factory-level grant: scopeFilter widens to the whole factory.
      scopeFilter: { organizationId: ORG, factoryId: FACTORY },
    });

    const result = await service.validate(principal, SESSION, [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      { employeeId: 'emp-2', mealSessionDishId: DISH_B },
    ]);

    expect(result.isValid).toBe(true);
    expect(result.inScopeEmployeeCount).toBe(2);
  });
});
