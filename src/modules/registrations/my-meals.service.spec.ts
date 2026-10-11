import { RequestPrincipal } from '../../common/auth/request-principal';
import {
  PrincipalAuthorizationService,
  ResolvedAuthorization,
} from '../../common/authorization/principal-authorization.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Clock } from '../../common/time/clock';
import { MyMealsService } from './my-meals.service';

const ORG = 'org-1';
const FACTORY = 'factory-1';
const OTHER_FACTORY = 'factory-2';
const SELF_EMPLOYEE = 'emp-self';
const NOW = '2025-03-10T04:00:00.000Z'; // 2025-03-10 11:00 HCM

interface DishRow {
  id: string;
  code: string;
  name: string;
}

interface SessionDishRow {
  id: string;
  mealSessionId: string;
  dishId: string;
  sortOrder: number;
}

interface SessionRow {
  id: string;
  organizationId: string;
  factoryId: string;
  weeklyMenuId: string | null;
  serviceDate: Date;
  mealType: 'LUNCH' | 'DINNER';
  status: 'DRAFT' | 'PUBLISHED' | 'OPEN' | 'CLOSED' | 'CANCELLED';
  opensAt: Date;
  cutoffAt: Date;
}

interface RegistrationRow {
  id: string;
  organizationId: string;
  mealSessionId: string;
  employeeId: string;
  mealSessionDishId: string;
  status: 'REGISTERED' | 'CANCELLED' | 'ABSENT';
  source: 'SELF' | 'BULK' | 'PAPER_FORM' | 'ADMIN_ADJUSTMENT';
  registeredAt: Date;
  cancelledAt: Date | null;
}

const principal: RequestPrincipal = {
  userAccountId: 'acc-self',
  organizationId: ORG,
  tokenId: 'tok-1',
};

const DISHES: DishRow[] = [
  { id: 'dish-com', code: 'COM', name: 'Com ga' },
  { id: 'dish-chay', code: 'CHAY', name: 'Com chay' },
  { id: 'dish-chao', code: 'CHAO', name: 'Chao' },
];

/**
 * In-memory Prisma double for the My Meals read. Models `mealSession.findMany`
 * / `findFirst` with the status + serviceDate + factory filters the service
 * uses, each session's dishes joined to the catalog, and
 * `mealRegistration.findMany` scoped to one employee.
 */
function createPrisma(options: {
  sessions: SessionRow[];
  sessionDishes: SessionDishRow[];
  registrations?: RegistrationRow[];
}): PrismaService {
  const { sessions, sessionDishes } = options;
  const registrations = options.registrations ?? [];

  const attachDishes = (session: SessionRow) => ({
    ...session,
    dishes: sessionDishes
      .filter((sd) => sd.mealSessionId === session.id)
      .map((sd) => ({
        ...sd,
        dish: DISHES.find((d) => d.id === sd.dishId)!,
      })),
  });

  return {
    mealSession: {
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          factoryId?: string;
          status?: { in: string[] };
          serviceDate?: { gte: Date };
        };
      }) => {
        const found = sessions
          .filter(
            (s) =>
              (where.organizationId === undefined ||
                s.organizationId === where.organizationId) &&
              (where.factoryId === undefined ||
                s.factoryId === where.factoryId) &&
              (where.status === undefined ||
                where.status.in.includes(s.status)) &&
              (where.serviceDate === undefined ||
                s.serviceDate.getTime() >= where.serviceDate.gte.getTime()),
          )
          .sort(
            (a, b) =>
              a.serviceDate.getTime() - b.serviceDate.getTime() ||
              a.mealType.localeCompare(b.mealType),
          )
          .map(attachDishes);
        return Promise.resolve(found);
      },
      findFirst: ({
        where,
      }: {
        where: {
          id?: string;
          organizationId?: string;
          factoryId?: string;
        };
      }) => {
        const found = sessions.find(
          (s) =>
            (where.id === undefined || s.id === where.id) &&
            (where.organizationId === undefined ||
              s.organizationId === where.organizationId) &&
            (where.factoryId === undefined || s.factoryId === where.factoryId),
        );
        return Promise.resolve(found ? attachDishes(found) : null);
      },
    },
    mealRegistration: {
      findMany: ({
        where,
      }: {
        where: { employeeId?: string; mealSessionId?: { in: string[] } };
      }) => {
        const found = registrations.filter(
          (r) =>
            (where.employeeId === undefined ||
              r.employeeId === where.employeeId) &&
            (where.mealSessionId === undefined ||
              where.mealSessionId.in.includes(r.mealSessionId)),
        );
        return Promise.resolve(found.map((r) => ({ ...r })));
      },
    },
  } as unknown as PrismaService;
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
  const service = new PrincipalAuthorizationService(
    undefined as unknown as PrismaService,
  );
  jest.spyOn(service, 'resolve').mockResolvedValue(resolved);
  return service;
}

function fixedClock(iso = NOW): Clock {
  return { now: () => new Date(iso) } as unknown as Clock;
}

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    organizationId: ORG,
    factoryId: FACTORY,
    weeklyMenuId: 'menu-1',
    serviceDate: new Date(Date.UTC(2025, 2, 11)),
    mealType: 'LUNCH',
    status: 'OPEN',
    opensAt: new Date('2025-03-09T00:00:00.000Z'),
    cutoffAt: new Date('2025-03-11T02:00:00.000Z'),
    ...overrides,
  };
}

function makeService(options: {
  sessions?: SessionRow[];
  sessionDishes?: SessionDishRow[];
  registrations?: RegistrationRow[];
  hasPermission?: boolean;
  employeeFactoryId?: string | null;
}): MyMealsService {
  const prisma = createPrisma({
    sessions: options.sessions ?? [session()],
    sessionDishes: options.sessionDishes ?? [
      {
        id: 'sd-com',
        mealSessionId: 'session-1',
        dishId: 'dish-com',
        sortOrder: 1,
      },
      {
        id: 'sd-chay',
        mealSessionId: 'session-1',
        dishId: 'dish-chay',
        sortOrder: 2,
      },
    ],
    registrations: options.registrations,
  });
  return new MyMealsService(
    prisma,
    stubPrincipalAuthorization({
      hasPermission: options.hasPermission,
      employeeFactoryId: options.employeeFactoryId,
    }),
    fixedClock(),
  );
}

describe('MyMealsService', () => {
  it('lists only the employee own factory eligible sessions with dish names', async () => {
    const service = makeService({
      sessions: [
        session({ id: 'own-open', factoryId: FACTORY, status: 'OPEN' }),
        session({
          id: 'own-published',
          factoryId: FACTORY,
          status: 'PUBLISHED',
        }),
        session({
          id: 'other-factory',
          factoryId: OTHER_FACTORY,
          status: 'OPEN',
        }),
        session({ id: 'own-draft', factoryId: FACTORY, status: 'DRAFT' }),
        session({
          id: 'own-cancelled',
          factoryId: FACTORY,
          status: 'CANCELLED',
        }),
      ],
      sessionDishes: [
        {
          id: 'sd-com',
          mealSessionId: 'own-open',
          dishId: 'dish-com',
          sortOrder: 1,
        },
        {
          id: 'sd-chay',
          mealSessionId: 'own-open',
          dishId: 'dish-chay',
          sortOrder: 2,
        },
        {
          id: 'sd-p',
          mealSessionId: 'own-published',
          dishId: 'dish-com',
          sortOrder: 1,
        },
      ],
    });

    const result = await service.listEligibleSessions(principal);

    expect(result.map((s) => s.id).sort()).toEqual([
      'own-open',
      'own-published',
    ]);
    const open = result.find((s) => s.id === 'own-open')!;
    expect(open.dishes).toEqual([
      {
        mealSessionDishId: 'sd-com',
        dishId: 'dish-com',
        code: 'COM',
        name: 'Com ga',
        sortOrder: 1,
        isSelected: false,
      },
      {
        mealSessionDishId: 'sd-chay',
        dishId: 'dish-chay',
        code: 'CHAY',
        name: 'Com chay',
        sortOrder: 2,
        isSelected: false,
      },
    ]);
  });

  it('excludes past service dates (current and upcoming only)', async () => {
    const service = makeService({
      sessions: [
        session({ id: 'past', serviceDate: new Date(Date.UTC(2025, 2, 9)) }),
        session({ id: 'today', serviceDate: new Date(Date.UTC(2025, 2, 10)) }),
        session({ id: 'future', serviceDate: new Date(Date.UTC(2025, 2, 12)) }),
      ],
      sessionDishes: [],
    });

    const result = await service.listEligibleSessions(principal);
    expect(result.map((s) => s.id)).toEqual(['today', 'future']);
  });

  it('reflects the employee current pick via isSelected and myRegistration', async () => {
    const service = makeService({
      registrations: [
        {
          id: 'reg-1',
          organizationId: ORG,
          mealSessionId: 'session-1',
          employeeId: SELF_EMPLOYEE,
          mealSessionDishId: 'sd-chay',
          status: 'REGISTERED',
          source: 'SELF',
          registeredAt: new Date('2025-03-09T01:00:00.000Z'),
          cancelledAt: null,
        },
      ],
    });

    const [view] = await service.listEligibleSessions(principal);
    expect(view.myRegistration?.mealSessionDishId).toBe('sd-chay');
    expect(view.myRegistration?.employeeId).toBe(SELF_EMPLOYEE);
    expect(view.dishes.map((d) => d.isSelected)).toEqual([false, true]);
  });

  it('never returns another employee registration', async () => {
    const service = makeService({
      registrations: [
        {
          id: 'reg-other',
          organizationId: ORG,
          mealSessionId: 'session-1',
          employeeId: 'someone-else',
          mealSessionDishId: 'sd-com',
          status: 'REGISTERED',
          source: 'SELF',
          registeredAt: new Date('2025-03-09T01:00:00.000Z'),
          cancelledAt: null,
        },
      ],
    });

    const [view] = await service.listEligibleSessions(principal);
    expect(view.myRegistration).toBeNull();
    expect(view.dishes.every((d) => d.isSelected === false)).toBe(true);
  });

  it('includes the live registration window from the single evaluator', async () => {
    const service = makeService({});
    const [view] = await service.listEligibleSessions(principal);
    expect(view.registrationWindow.state).toBe('OPEN');
    expect(view.registrationWindow.isOpen).toBe(true);
  });

  it('forbids an account without a linked employee', async () => {
    const service = makeService({ employeeFactoryId: null });
    await expect(service.listEligibleSessions(principal)).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
  });

  it('forbids an account lacking registration:self', async () => {
    const service = makeService({ hasPermission: false });
    await expect(service.listEligibleSessions(principal)).rejects.toMatchObject(
      {
        code: 'FORBIDDEN',
      },
    );
  });

  it('gets a single eligible session for the own factory', async () => {
    const service = makeService({});
    const view = await service.getEligibleSession(principal, 'session-1');
    expect(view.id).toBe('session-1');
    expect(view.dishes.map((d) => d.name)).toEqual(['Com ga', 'Com chay']);
  });

  it('reports a session in another factory as not found', async () => {
    const service = makeService({
      sessions: [session({ id: 'session-1', factoryId: OTHER_FACTORY })],
    });
    await expect(
      service.getEligibleSession(principal, 'session-1'),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      service.getEligibleSession(principal, 'session-1'),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
