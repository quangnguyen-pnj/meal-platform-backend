import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import {
  PrincipalAuthorizationService,
  ResolvedAuthorization,
} from '../../common/authorization/principal-authorization.service';
import { PrismaService } from '../../common/database/prisma.service';
import { Clock } from '../../common/time/clock';
import { Prisma } from '../../generated/prisma/client';
import { MealSessionAccess } from '../meal-sessions/meal-session-access.service';
import { RegistrationWindow } from '../meal-sessions/meal-sessions.types';
import { RegistrationsService } from './registrations.service';

const ORG = 'org-1';
const FACTORY = 'factory-1';
const OTHER_FACTORY = 'factory-2';
const SESSION = 'session-1';
const DISH_A = 'dish-a';
const DISH_B = 'dish-b';
const SELF_EMPLOYEE = 'emp-self';

interface SessionRow {
  id: string;
  organizationId: string;
  factoryId: string;
}

interface SessionDishRow {
  id: string;
  mealSessionId: string;
}

interface RegistrationRow {
  id: string;
  organizationId: string;
  mealSessionId: string;
  employeeId: string;
  mealSessionDishId: string;
  status: 'REGISTERED' | 'CANCELLED' | 'ABSENT';
  source: 'SELF' | 'BULK' | 'PAPER_FORM' | 'ADMIN_ADJUSTMENT';
  createdByUserId: string;
  updatedByUserId: string | null;
  registeredAt: Date;
  cancelledAt: Date | null;
  absentAt: Date | null;
}

interface ChangeRow {
  mealRegistrationId: string;
  kind: string;
  before: unknown;
  after: unknown;
  actorUserId: string | null;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
}

const principal: RequestPrincipal = {
  userAccountId: 'acc-self',
  organizationId: ORG,
  tokenId: 'tok-1',
};

/**
 * In-memory Prisma double for self-registration. Models the reads/writes the
 * service makes: session + dish lookups, the single `[session, employee]`
 * registration row (findUnique/create/update), and `$transaction` staging so a
 * change + audit row commit only with their registration write.
 */
function createPrisma(options: {
  sessions: SessionRow[];
  dishes: SessionDishRow[];
  registrations?: RegistrationRow[];
}): {
  prisma: PrismaService;
  registrations: RegistrationRow[];
  changes: ChangeRow[];
  audit: AuditRow[];
} {
  const sessions = options.sessions;
  const dishes = options.dishes;
  const registrations: RegistrationRow[] = options.registrations ?? [];
  const changes: ChangeRow[] = [];
  const audit: AuditRow[] = [];
  let idSeq = 0;

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
    mealRegistration: {
      create: ({ data }: { data: Partial<RegistrationRow> }) => {
        const row: RegistrationRow = {
          id: `reg-${idSeq++}`,
          organizationId: data.organizationId as string,
          mealSessionId: data.mealSessionId as string,
          employeeId: data.employeeId as string,
          mealSessionDishId: data.mealSessionDishId as string,
          status: data.status ?? 'REGISTERED',
          source: data.source ?? 'SELF',
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
        const found = sessions.find(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.organizationId === undefined ||
              row.organizationId === where.organizationId),
        );
        return Promise.resolve(found ? { ...found } : null);
      },
    },
    mealSessionDish: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; mealSessionId?: string };
      }) => {
        const found = dishes.find(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.mealSessionId === undefined ||
              row.mealSessionId === where.mealSessionId),
        );
        return Promise.resolve(found ? { ...found } : null);
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
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => fn(txClient),
  } as unknown as PrismaService;

  return { prisma, registrations, changes, audit };
}

function stubPrincipalAuthorization(options: {
  hasPermission?: boolean;
  employeeFactoryId?: string | null;
}): PrincipalAuthorizationService {
  const resolved: ResolvedAuthorization = {
    roles: [],
    permissions: options.hasPermission === false ? [] : ['registration:self'],
    scopeGrants: [],
    employee:
      options.employeeFactoryId === null
        ? null
        : {
            id: SELF_EMPLOYEE,
            employeeCode: 'E-SELF',
            fullName: 'Self Employee',
            factoryId: options.employeeFactoryId ?? FACTORY,
            departmentId: 'dept-1',
            teamId: 'team-1',
          },
  };
  // A real instance with only `resolve` stubbed, so the shared
  // `resolveSelfEmployee` gate (permission + linked employee) is exercised.
  const service = new PrincipalAuthorizationService(
    undefined as unknown as PrismaService,
  );
  jest.spyOn(service, 'resolve').mockResolvedValue(resolved);
  return service;
}

function stubMealSessionAccess(window: Partial<RegistrationWindow>): {
  access: MealSessionAccess;
} {
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
    access: {
      getRegistrationWindow: () => Promise.resolve(full),
    } as unknown as MealSessionAccess,
  };
}

function fixedClock(iso = '2025-03-09T12:00:00.000Z'): Clock {
  return { now: () => new Date(iso) } as unknown as Clock;
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: SESSION,
    organizationId: ORG,
    factoryId: FACTORY,
    ...overrides,
  };
}

function makeService(options: {
  sessions?: SessionRow[];
  dishes?: SessionDishRow[];
  registrations?: RegistrationRow[];
  hasPermission?: boolean;
  employeeFactoryId?: string | null;
  window?: Partial<RegistrationWindow>;
}) {
  const { prisma, registrations, changes, audit } = createPrisma({
    sessions: options.sessions ?? [session()],
    dishes: options.dishes ?? [
      { id: DISH_A, mealSessionId: SESSION },
      { id: DISH_B, mealSessionId: SESSION },
    ],
    registrations: options.registrations,
  });
  const service = new RegistrationsService(
    prisma,
    stubPrincipalAuthorization({
      hasPermission: options.hasPermission,
      employeeFactoryId: options.employeeFactoryId,
    }),
    stubMealSessionAccess(options.window ?? {}).access,
    new AuditService(prisma),
    fixedClock(),
  );
  return { service, registrations, changes, audit };
}

function existingRegistration(
  overrides: Partial<RegistrationRow> = {},
): RegistrationRow {
  return {
    id: 'reg-existing',
    organizationId: ORG,
    mealSessionId: SESSION,
    employeeId: SELF_EMPLOYEE,
    mealSessionDishId: DISH_A,
    status: 'REGISTERED',
    source: 'SELF',
    createdByUserId: 'acc-self',
    updatedByUserId: null,
    registeredAt: new Date('2025-03-08T00:00:00.000Z'),
    cancelledAt: null,
    absentAt: null,
    ...overrides,
  };
}

describe('RegistrationsService', () => {
  it('creates then changes the same employee registration, reusing one row and recording DISH_CHANGED', async () => {
    const { service, registrations, changes, audit } = makeService({});

    const created = await service.upsertSelfRegistration(
      principal,
      SESSION,
      DISH_A,
    );
    expect(created.mealSessionDishId).toBe(DISH_A);
    expect(created.status).toBe('REGISTERED');
    expect(created.source).toBe('SELF');
    expect(registrations).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      kind: 'CREATED',
      actorUserId: 'acc-self',
    });

    const changed = await service.upsertSelfRegistration(
      principal,
      SESSION,
      DISH_B,
    );
    expect(changed.id).toBe(created.id);
    expect(changed.mealSessionDishId).toBe(DISH_B);
    // Still a single row for the session/employee pair.
    expect(registrations).toHaveLength(1);
    expect(changes.map((c) => c.kind)).toEqual(['CREATED', 'DISH_CHANGED']);
    expect(audit.map((a) => a.action)).toEqual([
      'registration.self.create',
      'registration.self.change',
    ]);
    expect(registrations[0].updatedByUserId).toBe('acc-self');
  });

  it('re-submitting the same dish on an existing registration is a no-op (no duplicate, no new change)', async () => {
    const { service, registrations, changes } = makeService({
      registrations: [existingRegistration({ mealSessionDishId: DISH_A })],
    });

    const result = await service.upsertSelfRegistration(
      principal,
      SESSION,
      DISH_A,
    );

    expect(result.id).toBe('reg-existing');
    expect(registrations).toHaveLength(1);
    expect(changes).toHaveLength(0);
  });

  it('forbids a self-registration when the account has no linked employee', async () => {
    const { service, registrations } = makeService({ employeeFactoryId: null });

    await expect(
      service.upsertSelfRegistration(principal, SESSION, DISH_A),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(registrations).toHaveLength(0);
  });

  it('forbids acting on a session that belongs to another factory', async () => {
    const { service, registrations } = makeService({
      employeeFactoryId: OTHER_FACTORY,
    });

    await expect(
      service.upsertSelfRegistration(principal, SESSION, DISH_A),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(registrations).toHaveLength(0);
  });

  it('rejects registration before the window opens, with the window reason', async () => {
    const { service, registrations } = makeService({
      window: {
        state: 'BEFORE_OPEN',
        isOpen: false,
        reason: 'Registration has not opened yet.',
      },
    });

    await expect(
      service.upsertSelfRegistration(principal, SESSION, DISH_A),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'Registration has not opened yet.',
    });
    expect(registrations).toHaveLength(0);
  });

  it('rejects registration after cutoff, with the window reason', async () => {
    const { service, registrations } = makeService({
      window: {
        state: 'CUTOFF_PASSED',
        isOpen: false,
        reason: 'The cutoff time has passed; registration is closed.',
      },
    });

    await expect(
      service.upsertSelfRegistration(principal, SESSION, DISH_A),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The cutoff time has passed; registration is closed.',
    });
    expect(registrations).toHaveLength(0);
  });

  it('rejects a dish that is not offered by the session', async () => {
    const { service, registrations } = makeService({});

    await expect(
      service.upsertSelfRegistration(principal, SESSION, 'dish-not-here'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(registrations).toHaveLength(0);
  });

  it('cancels the employee registration, writing a CANCELLED change and an audit row', async () => {
    const { service, registrations, changes, audit } = makeService({
      registrations: [existingRegistration()],
    });

    const cancelled = await service.cancelSelfRegistration(principal, SESSION);

    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).not.toBeNull();
    expect(registrations).toHaveLength(1);
    expect(registrations[0].status).toBe('CANCELLED');
    expect(changes.map((c) => c.kind)).toEqual(['CANCELLED']);
    expect(audit.map((a) => a.action)).toEqual(['registration.self.cancel']);
  });

  it('cancelling an already-cancelled registration is a no-op', async () => {
    const { service, changes, audit } = makeService({
      registrations: [existingRegistration({ status: 'CANCELLED' })],
    });

    const result = await service.cancelSelfRegistration(principal, SESSION);
    expect(result.status).toBe('CANCELLED');
    expect(changes).toHaveLength(0);
    expect(audit).toHaveLength(0);
  });

  it('rejects cancelling when there is no registration', async () => {
    const { service } = makeService({});
    await expect(
      service.cancelSelfRegistration(principal, SESSION),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('re-registering after a cancel reuses the row and clears cancelledAt', async () => {
    const { service, registrations, changes } = makeService({
      registrations: [
        existingRegistration({
          status: 'CANCELLED',
          cancelledAt: new Date('2025-03-08T01:00:00.000Z'),
        }),
      ],
    });

    const result = await service.upsertSelfRegistration(
      principal,
      SESSION,
      DISH_B,
    );

    expect(result.status).toBe('REGISTERED');
    expect(result.cancelledAt).toBeNull();
    expect(result.mealSessionDishId).toBe(DISH_B);
    expect(registrations).toHaveLength(1);
    // Re-opening a cancelled row is recorded as CREATED (it was not registered).
    expect(changes.map((c) => c.kind)).toEqual(['CREATED']);
  });

  it('forbids a self-registration without the registration:self permission', async () => {
    const { service } = makeService({ hasPermission: false });
    await expect(
      service.upsertSelfRegistration(principal, SESSION, DISH_A),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('reads the current self registration', async () => {
    const { service } = makeService({
      registrations: [existingRegistration()],
    });
    const view = await service.getSelfRegistration(principal, SESSION);
    expect(view?.mealSessionDishId).toBe(DISH_A);
  });
});
