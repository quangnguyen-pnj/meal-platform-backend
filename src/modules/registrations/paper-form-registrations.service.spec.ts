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
const PAPER_REF = 'FORM-2025-03-09-A';

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
  organizationId: string;
  factoryId: string;
  status: 'DRAFT' | 'COMMITTED' | 'REJECTED';
  source: string;
  reason: string | null;
  paperReference: string | null;
  submittedAt: Date | null;
  createdAt: Date;
}

interface BatchEntryRow {
  registrationBatchId: string;
  employeeId: string;
  mealSessionDishId: string | null;
  rowNumber: number | null;
  status: string;
  errors?: string[];
  createdAt: Date;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
}

/**
 * In-memory Prisma double for paper-form registration. Mirrors the bulk double
 * but captures the batch `source`/`paperReference` and the stored entries with
 * their `rowNumber`, and supports `registrationBatch.findFirst` so `getBatch`
 * can read a committed batch back.
 */
function createPrisma(options: {
  employees: EmployeeRow[];
  dishIds: string[];
  registrations?: RegistrationRow[];
}): {
  prisma: PrismaService;
  registrations: RegistrationRow[];
  batches: BatchRow[];
  batchEntries: BatchEntryRow[];
  audit: AuditRow[];
} {
  const employees = options.employees;
  const dishIds = options.dishIds;
  const registrations: RegistrationRow[] = options.registrations ?? [];
  const batches: BatchRow[] = [];
  const batchEntries: BatchEntryRow[] = [];
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
          organizationId: data.organizationId as string,
          factoryId: data.factoryId as string,
          status: data.status ?? 'DRAFT',
          source: data.source ?? 'BULK',
          reason: data.reason ?? null,
          paperReference: data.paperReference ?? null,
          submittedAt: data.submittedAt ?? null,
          createdAt: new Date('2025-03-09T12:00:00.000Z'),
        };
        batches.push(row);
        return Promise.resolve({ ...row });
      },
    },
    registrationBatchEntry: {
      createMany: ({ data }: { data: Partial<BatchEntryRow>[] }) => {
        for (const entry of data) {
          batchEntries.push({
            registrationBatchId: entry.registrationBatchId as string,
            employeeId: entry.employeeId as string,
            mealSessionDishId: entry.mealSessionDishId ?? null,
            rowNumber: entry.rowNumber ?? null,
            status: entry.status as string,
            errors: entry.errors,
            createdAt: new Date('2025-03-09T12:00:00.000Z'),
          });
        }
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
          source: data.source ?? 'PAPER_FORM',
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
      create: ({ data }: { data: unknown }) => Promise.resolve(data),
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
    registrationBatch: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; organizationId?: string };
      }) => {
        const batch = batches.find(
          (b) =>
            b.id === where.id &&
            (!where.organizationId ||
              b.organizationId === where.organizationId),
        );
        if (!batch) return Promise.resolve(null);
        const entries = batchEntries
          .filter((e) => e.registrationBatchId === batch.id)
          .sort((a, b) => (a.rowNumber ?? 0) - (b.rowNumber ?? 0))
          .map((e) => ({
            employeeId: e.employeeId,
            mealSessionDishId: e.mealSessionDishId,
            rowNumber: e.rowNumber,
            status: e.status,
            errors: e.errors ?? null,
          }));
        return Promise.resolve({ ...batch, entries });
      },
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => fn(txClient),
  } as unknown as PrismaService;

  return { prisma, registrations, batches, batchEntries, audit };
}

function stubScopeAuthorizer(
  scopeFilter?: Record<string, unknown>,
): ScopeAuthorizer {
  return {
    assertPermission: () => Promise.resolve(),
    scopeFilter: () =>
      Promise.resolve(scopeFilter ?? { organizationId: ORG, teamId: TEAM }),
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
  window?: Partial<RegistrationWindow>;
  scopeFilter?: Record<string, unknown>;
}) {
  const store = createPrisma({
    employees: options.employees,
    dishIds: options.dishIds ?? [DISH_A, DISH_B],
    registrations: options.registrations,
  });
  const service = new BulkRegistrationsService(
    store.prisma,
    stubScopeAuthorizer(options.scopeFilter),
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
    source: 'PAPER_FORM',
    registrationBatchId: 'batch-old',
    createdByUserId: 'acc-rep',
    updatedByUserId: null,
    registeredAt: new Date('2025-03-08T00:00:00.000Z'),
    cancelledAt: null,
    absentAt: null,
    ...overrides,
  };
}

describe('BulkRegistrationsService paper-form (P2-06)', () => {
  it('commits a paper-form batch with source PAPER_FORM, the stored paper reference, and COMMITTED status', async () => {
    const { service, registrations, batches, audit } = makeService({
      employees: [employee('emp-1'), employee('emp-2')],
    });
    const entries: BulkEntryInput[] = [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A, rowNumber: 1 },
      { employeeId: 'emp-2', notEating: true, rowNumber: 2 },
    ];

    const result = await service.commitPaperForm(
      principal,
      SESSION,
      PAPER_REF,
      entries,
    );

    expect(result.status).toBe('COMMITTED');
    expect(result.source).toBe('PAPER_FORM');
    expect(result.paperReference).toBe(PAPER_REF);
    expect(result.registrations).toHaveLength(1);
    expect(registrations.every((r) => r.source === 'PAPER_FORM')).toBe(true);
    expect(batches[0].source).toBe('PAPER_FORM');
    expect(batches[0].paperReference).toBe(PAPER_REF);
    expect(batches[0].status).toBe('COMMITTED');
    expect(audit[0]).toMatchObject({
      action: 'registration.paper.commit',
      entityType: 'RegistrationBatch',
    });
  });

  it('rejects a commit with a blank paper reference, writing nothing', async () => {
    const { service, registrations, batches } = makeService({
      employees: [employee('emp-1')],
    });

    await expect(
      service.commitPaperForm(principal, SESSION, '   ', [
        { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(registrations).toHaveLength(0);
    expect(batches).toHaveLength(0);
  });

  it('re-applying the same paper form upserts the per-employee row without duplicating', async () => {
    const { service, registrations } = makeService({
      employees: [employee('emp-1')],
      registrations: [existingRegistration({ mealSessionDishId: DISH_A })],
    });

    const result = await service.commitPaperForm(
      principal,
      SESSION,
      PAPER_REF,
      [{ employeeId: 'emp-1', mealSessionDishId: DISH_B }],
    );

    expect(registrations).toHaveLength(1);
    expect(registrations[0].id).toBe('reg-existing');
    expect(registrations[0].mealSessionDishId).toBe(DISH_B);
    expect(result.registrations[0].mealSessionDishId).toBe(DISH_B);
  });

  it('writes nothing when one paper row is out of scope, recording a REJECTED PAPER_FORM batch', async () => {
    const { service, registrations, batches } = makeService({
      employees: [employee('emp-1')],
    });

    await expect(
      service.commitPaperForm(principal, SESSION, PAPER_REF, [
        { employeeId: 'emp-1', mealSessionDishId: DISH_A },
        { employeeId: 'emp-ghost', mealSessionDishId: DISH_B },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(registrations).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0].status).toBe('REJECTED');
    expect(batches[0].source).toBe('PAPER_FORM');
    expect(batches[0].paperReference).toBe(PAPER_REF);
  });

  it('rejects a paper-form commit after cutoff with the window reason, writing nothing', async () => {
    const { service, registrations, batches } = makeService({
      employees: [employee('emp-1')],
      window: {
        state: 'CUTOFF_PASSED',
        isOpen: false,
        reason: 'The cutoff time has passed; registration is closed.',
      },
    });

    await expect(
      service.commitPaperForm(principal, SESSION, PAPER_REF, [
        { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      ]),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The cutoff time has passed; registration is closed.',
    });
    expect(registrations).toHaveLength(0);
    // Batch was valid, so no REJECTED batch; the cutoff stops the write.
    expect(batches).toHaveLength(0);
  });

  it('validatePaperForm previews totals and unselected without writing, and requires a reference', async () => {
    const { service, batches } = makeService({
      employees: [employee('emp-1'), employee('emp-2'), employee('emp-3')],
    });

    const preview = await service.validatePaperForm(
      principal,
      SESSION,
      PAPER_REF,
      [
        { employeeId: 'emp-1', mealSessionDishId: DISH_A },
        { employeeId: 'emp-2', mealSessionDishId: DISH_A },
      ],
    );

    expect(preview.isValid).toBe(true);
    expect(preview.unselected).toBe(1);
    expect(preview.totalsByDish).toEqual([
      { mealSessionDishId: DISH_A, count: 2 },
    ]);
    expect(batches).toHaveLength(0);

    await expect(
      service.validatePaperForm(principal, SESSION, '', [
        { employeeId: 'emp-1', mealSessionDishId: DISH_A },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('getBatch returns the paper batch source, status, reference, and ordered entries', async () => {
    const { service } = makeService({
      employees: [employee('emp-1'), employee('emp-2')],
    });

    const committed = await service.commitPaperForm(
      principal,
      SESSION,
      PAPER_REF,
      [
        { employeeId: 'emp-1', mealSessionDishId: DISH_A, rowNumber: 1 },
        { employeeId: 'emp-2', notEating: true, rowNumber: 2 },
      ],
    );

    const view = await service.getBatch(principal, committed.batchId);

    expect(view.source).toBe('PAPER_FORM');
    expect(view.status).toBe('COMMITTED');
    expect(view.paperReference).toBe(PAPER_REF);
    expect(view.id).toBe(committed.batchId);
  });

  it('getBatch is tenant-scoped: a batch in another org is not found', async () => {
    const { service, batches } = makeService({
      employees: [employee('emp-1')],
    });
    await service.commitPaperForm(principal, SESSION, PAPER_REF, [
      { employeeId: 'emp-1', mealSessionDishId: DISH_A },
    ]);
    // Force the stored batch into another org, then read as org-1.
    batches[0].organizationId = 'org-other';

    await expect(
      service.getBatch(principal, batches[0].id),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
