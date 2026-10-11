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
import { RegistrationAdjustmentsService } from './registration-adjustments.service';

const ORG = 'org-1';
const FACTORY = 'factory-1';
const DEPT = 'dept-1';
const TEAM = 'team-1';
const SESSION = 'session-1';
const DISH_A = 'dish-a';
const DISH_B = 'dish-b';
const EMPLOYEE = 'emp-1';
const REG = 'reg-1';

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
  adjustmentReason: string | null;
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
  reason: string | null;
  actorUserId: string | null;
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
 * In-memory Prisma double for operator-side adjustments. Models the single
 * registration row the service loads (findFirst with the employee include)
 * and updates, plus the change + audit rows staged inside `$transaction`.
 */
function createPrisma(options: {
  employees: EmployeeRow[];
  registrations: RegistrationRow[];
  dishes: { id: string; mealSessionId: string }[];
}): {
  prisma: PrismaService;
  registrations: RegistrationRow[];
  changes: ChangeRow[];
  audit: AuditRow[];
} {
  const employees = options.employees;
  const registrations = options.registrations;
  const dishes = options.dishes;
  const changes: ChangeRow[] = [];
  const audit: AuditRow[] = [];

  const txClient = {
    mealRegistration: {
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
    mealRegistration: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; organizationId?: string };
      }) => {
        const row = registrations.find(
          (r) =>
            (where.id === undefined || r.id === where.id) &&
            (where.organizationId === undefined ||
              r.organizationId === where.organizationId),
        );
        if (!row) return Promise.resolve(null);
        const employee = employees.find((e) => e.id === row.employeeId);
        return Promise.resolve({ ...row, employee: { ...employee } });
      },
    },
    mealSessionDish: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; mealSessionId?: string };
      }) => {
        const found = dishes.find(
          (d) =>
            (where.id === undefined || d.id === where.id) &&
            (where.mealSessionId === undefined ||
              d.mealSessionId === where.mealSessionId),
        );
        return Promise.resolve(found ? { ...found } : null);
      },
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => fn(txClient),
  } as unknown as PrismaService;

  return { prisma, registrations, changes, audit };
}

function stubAuthorization(
  permissions: string[],
): PrincipalAuthorizationService {
  const resolved: ResolvedAuthorization = {
    roles: [],
    permissions,
    // One factory-wide grant so scope covers the employee by default.
    scopeGrants: [
      {
        roleCode: 'role',
        roleName: 'Role',
        organizationId: ORG,
        factoryId: FACTORY,
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

function stubAuthorizationNoScope(
  permissions: string[],
): PrincipalAuthorizationService {
  const resolved: ResolvedAuthorization = {
    roles: [],
    permissions,
    // A grant on a different factory - no scope over the employee.
    scopeGrants: [
      {
        roleCode: 'role',
        roleName: 'Role',
        organizationId: ORG,
        factoryId: 'factory-other',
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
    reason: isOpen
      ? 'Registration is open.'
      : 'The cutoff time has passed; registration is closed.',
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

function employee(overrides: Partial<EmployeeRow> = {}): EmployeeRow {
  return {
    id: EMPLOYEE,
    organizationId: ORG,
    factoryId: FACTORY,
    departmentId: DEPT,
    teamId: TEAM,
    ...overrides,
  };
}

function registration(
  overrides: Partial<RegistrationRow> = {},
): RegistrationRow {
  return {
    id: REG,
    organizationId: ORG,
    mealSessionId: SESSION,
    employeeId: EMPLOYEE,
    mealSessionDishId: DISH_A,
    status: 'REGISTERED',
    source: 'SELF',
    adjustmentReason: null,
    createdByUserId: 'acc-self',
    updatedByUserId: null,
    registeredAt: new Date('2025-03-08T00:00:00.000Z'),
    cancelledAt: null,
    absentAt: null,
    ...overrides,
  };
}

function makeService(options: {
  permissions: string[];
  isOpen: boolean;
  registrations?: RegistrationRow[];
  employees?: EmployeeRow[];
  scoped?: boolean;
}) {
  const { prisma, registrations, changes, audit } = createPrisma({
    employees: options.employees ?? [employee()],
    registrations: options.registrations ?? [registration()],
    dishes: [
      { id: DISH_A, mealSessionId: SESSION },
      { id: DISH_B, mealSessionId: SESSION },
    ],
  });
  const authorization =
    options.scoped === false
      ? stubAuthorizationNoScope(options.permissions)
      : stubAuthorization(options.permissions);
  const service = new RegistrationAdjustmentsService(
    prisma,
    authorization,
    new ScopeAuthorizer(authorization),
    stubWindow(options.isOpen),
    new AuditService(prisma),
    fixedClock(),
  );
  return { service, registrations, changes, audit };
}

describe('RegistrationAdjustmentsService', () => {
  describe('post-cutoff authority', () => {
    it('forbids a non-admin (no registration:adjust) from adjusting after cutoff', async () => {
      const { service, registrations } = makeService({
        permissions: ['registration:bulk'],
        isOpen: false,
      });

      await expect(
        service.adjust(principal, REG, {
          mealSessionDishId: DISH_B,
          reason: 'late change',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      // Nothing changed.
      expect(registrations[0].mealSessionDishId).toBe(DISH_A);
    });

    it('rejects a post-cutoff adjustment with a missing reason (VALIDATION_ERROR)', async () => {
      const { service, changes } = makeService({
        permissions: ['registration:adjust'],
        isOpen: false,
      });

      await expect(
        service.adjust(principal, REG, { mealSessionDishId: DISH_B }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(changes).toHaveLength(0);
    });

    it('rejects a post-cutoff adjustment with a blank reason', async () => {
      const { service } = makeService({
        permissions: ['registration:adjust'],
        isOpen: false,
      });

      await expect(
        service.adjust(principal, REG, {
          mealSessionDishId: DISH_B,
          reason: '   ',
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('lets an admin adjust after cutoff with a reason, recording change + audit with before/after/reason/actor/time', async () => {
      const { service, registrations, changes, audit } = makeService({
        permissions: ['registration:adjust'],
        isOpen: false,
      });

      const result = await service.adjust(principal, REG, {
        mealSessionDishId: DISH_B,
        reason: 'diner swapped dish at the counter',
      });

      expect(result.mealSessionDishId).toBe(DISH_B);
      expect(result.source).toBe('ADMIN_ADJUSTMENT');
      expect(registrations[0].adjustmentReason).toBe(
        'diner swapped dish at the counter',
      );

      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({
        kind: 'POST_CUTOFF_ADJUSTMENT',
        reason: 'diner swapped dish at the counter',
        actorUserId: 'acc-admin',
      });
      expect(changes[0].before).toMatchObject({ mealSessionDishId: DISH_A });
      expect(changes[0].after).toMatchObject({ mealSessionDishId: DISH_B });

      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'registration.adjust',
        entityType: 'MealRegistration',
        entityId: REG,
        actorId: 'acc-admin',
      });
      expect(audit[0].details).toMatchObject({
        reason: 'diner swapped dish at the counter',
        postCutoff: true,
      });
      expect(audit[0].details.before).toMatchObject({
        mealSessionDishId: DISH_A,
      });
      expect(audit[0].details.after).toMatchObject({
        mealSessionDishId: DISH_B,
      });
      // occurredAt/createdAt timestamps are defaulted by the DB; the change
      // carries the actor and the audit action, so actor + time are recorded.
    });
  });

  describe('scope', () => {
    it('forbids an admin without scope over the employee', async () => {
      const { service } = makeService({
        permissions: ['registration:adjust'],
        isOpen: false,
        scoped: false,
      });

      await expect(
        service.adjust(principal, REG, {
          mealSessionDishId: DISH_B,
          reason: 'late change',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('mark-absent', () => {
    it('sets ABSENT + absentAt and writes an ABSENT change', async () => {
      const { service, registrations, changes } = makeService({
        permissions: ['registration:adjust'],
        isOpen: true,
      });

      const result = await service.markAbsent(principal, REG);

      expect(result.status).toBe('ABSENT');
      expect(registrations[0].status).toBe('ABSENT');
      expect(registrations[0].absentAt).not.toBeNull();
      expect(changes.map((c) => c.kind)).toEqual(['ABSENT']);
    });

    it('requires a reason to mark absent after cutoff', async () => {
      const { service } = makeService({
        permissions: ['registration:adjust'],
        isOpen: false,
      });

      await expect(service.markAbsent(principal, REG)).rejects.toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    });

    it('is a no-op when already absent', async () => {
      const { service, changes } = makeService({
        permissions: ['registration:adjust'],
        isOpen: true,
        registrations: [registration({ status: 'ABSENT' })],
      });

      const result = await service.markAbsent(principal, REG);
      expect(result.status).toBe('ABSENT');
      expect(changes).toHaveLength(0);
    });
  });

  describe('cancel', () => {
    it('cancels before cutoff for a Meal Admin, no reason needed', async () => {
      const { service, registrations, changes } = makeService({
        permissions: ['registration:adjust'],
        isOpen: true,
      });

      const result = await service.cancel(principal, REG);

      expect(result.status).toBe('CANCELLED');
      expect(registrations[0].cancelledAt).not.toBeNull();
      expect(changes.map((c) => c.kind)).toEqual(['CANCELLED']);
    });

    it('forbids a representative without registration:adjust from cancelling even before cutoff', async () => {
      const { service, registrations, changes } = makeService({
        permissions: ['registration:bulk'],
        isOpen: true,
      });

      await expect(service.cancel(principal, REG)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(registrations[0].status).toBe('REGISTERED');
      expect(changes).toHaveLength(0);
    });

    it('is a no-op when already cancelled', async () => {
      const { service, changes } = makeService({
        permissions: ['registration:adjust'],
        isOpen: true,
        registrations: [registration({ status: 'CANCELLED' })],
      });

      const result = await service.cancel(principal, REG);
      expect(result.status).toBe('CANCELLED');
      expect(changes).toHaveLength(0);
    });
  });

  describe('no auto-meal', () => {
    it('does not create a registration for an employee who has none (NOT_FOUND)', async () => {
      const { service, registrations } = makeService({
        permissions: ['registration:adjust'],
        isOpen: false,
        registrations: [],
      });

      await expect(
        service.adjust(principal, 'missing-reg', {
          mealSessionDishId: DISH_B,
          reason: 'late add',
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(registrations).toHaveLength(0);
    });
  });
});
