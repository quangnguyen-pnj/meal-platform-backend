import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Prisma } from '../../generated/prisma/client';
import { MealSessionsService } from './meal-sessions.service';

interface MenuRow {
  id: string;
  organizationId: string;
  factoryId: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}

interface MenuItemRow {
  id: string;
  weeklyMenuId: string;
  serviceDate: Date;
  mealType: 'LUNCH' | 'DINNER';
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
  publishedAt: Date | null;
  publishedByUserId: string | null;
}

interface SessionDishRow {
  id: string;
  mealSessionId: string;
  dishId: string;
  sortOrder: number;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
}

const ORG = 'org-1';
const FACTORY = 'factory-1';
const OTHER_FACTORY = 'factory-2';
const MENU = 'menu-1';
// A Monday and Tuesday in HCM; stored as UTC-midnight date-only values.
const DAY_MON = '2025-03-10';
const DAY_TUE = '2025-03-11';
const OPENS_ISO = '2025-03-09T02:00:00.000Z';
const CUTOFF_ISO = '2025-03-10T02:00:00.000Z';

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * In-memory Prisma double for meal sessions. Models the shapes the service
 * calls: menu + item reads, session reads/creates (with nested dish creates),
 * session updates, and audit writes staged inside `$transaction` so an audit
 * row commits only with its mutation.
 */
function createPrisma(options: {
  menuStatus?: MenuRow['status'];
  items?: MenuItemRow[];
  sessions?: SessionRow[];
  sessionDishes?: SessionDishRow[];
  failOnMealType?: 'LUNCH' | 'DINNER';
}): {
  prisma: PrismaService;
  audit: AuditRow[];
  sessions: SessionRow[];
  sessionDishes: SessionDishRow[];
} {
  const menus: MenuRow[] = [
    {
      id: MENU,
      organizationId: ORG,
      factoryId: FACTORY,
      status: options.menuStatus ?? 'PUBLISHED',
    },
  ];
  const items: MenuItemRow[] = options.items ?? [];
  const sessions: SessionRow[] = options.sessions ?? [];
  const sessionDishes: SessionDishRow[] = options.sessionDishes ?? [];
  const committedAudit: AuditRow[] = [];
  let idSeq = 0;

  const dishesFor = (sessionId: string): SessionDishRow[] =>
    sessionDishes
      .filter((row) => row.mealSessionId === sessionId)
      .map((row) => ({ ...row }));

  const withDishes = (
    session: SessionRow,
  ): SessionRow & { dishes: SessionDishRow[] } => ({
    ...session,
    dishes: dishesFor(session.id),
  });

  const prisma = {
    weeklyMenu: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; organizationId?: string };
      }) => {
        const found = menus.find(
          (row) =>
            (where.id === undefined || row.id === where.id) &&
            (where.organizationId === undefined ||
              row.organizationId === where.organizationId),
        );
        return Promise.resolve(
          found
            ? {
                ...found,
                items: items.filter((item) => item.weeklyMenuId === found.id),
              }
            : null,
        );
      },
    },
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
        return Promise.resolve(found ? withDishes(found) : null);
      },
      findMany: ({
        where,
      }: {
        where: {
          organizationId?: string;
          factoryId?: string;
          weeklyMenuId?: string;
          serviceDate?: Date;
        };
      }) =>
        Promise.resolve(
          sessions
            .filter(
              (row) =>
                (where.organizationId === undefined ||
                  row.organizationId === where.organizationId) &&
                (where.factoryId === undefined ||
                  row.factoryId === where.factoryId) &&
                (where.weeklyMenuId === undefined ||
                  row.weeklyMenuId === where.weeklyMenuId) &&
                (where.serviceDate === undefined ||
                  row.serviceDate.getTime() === where.serviceDate.getTime()),
            )
            .map(withDishes),
        ),
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const stagedSessions: SessionRow[] = [];
      const stagedDishes: SessionDishRow[] = [];
      const stagedUpdates: Array<{ id: string; data: Partial<SessionRow> }> =
        [];
      const stagedAudit: AuditRow[] = [];

      const tx = {
        mealSession: {
          create: ({
            data,
          }: {
            data: Omit<
              SessionRow,
              'id' | 'status' | 'publishedAt' | 'publishedByUserId'
            > &
              Partial<SessionRow> & {
                dishes?: {
                  create: Array<{ dishId: string; sortOrder: number }>;
                };
              };
          }) => {
            if (
              options.failOnMealType &&
              data.mealType === options.failOnMealType
            ) {
              return Promise.reject(
                new Error(`create failed for ${data.mealType} slot`),
              );
            }
            const id = `session-new-${idSeq++}`;
            const row: SessionRow = {
              id,
              organizationId: data.organizationId,
              factoryId: data.factoryId,
              weeklyMenuId: data.weeklyMenuId ?? null,
              serviceDate: data.serviceDate,
              mealType: data.mealType,
              status: data.status ?? 'DRAFT',
              opensAt: data.opensAt,
              cutoffAt: data.cutoffAt,
              publishedAt: data.publishedAt ?? null,
              publishedByUserId: data.publishedByUserId ?? null,
            };
            stagedSessions.push(row);
            const created = data.dishes?.create ?? [];
            const dishes = created.map((dish) => ({
              id: `dish-new-${idSeq++}`,
              mealSessionId: id,
              dishId: dish.dishId,
              sortOrder: dish.sortOrder,
            }));
            stagedDishes.push(...dishes);
            return Promise.resolve({ ...row, dishes });
          },
          update: ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<SessionRow>;
          }) => {
            stagedUpdates.push({ id: where.id, data });
            const base = sessions.find(
              (row) => row.id === where.id,
            ) as SessionRow;
            const merged = { ...base, ...data };
            return Promise.resolve({ ...merged, dishes: dishesFor(where.id) });
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
      sessions.push(...stagedSessions);
      sessionDishes.push(...stagedDishes);
      for (const upd of stagedUpdates) {
        const target = sessions.find((row) => row.id === upd.id);
        if (target) Object.assign(target, upd.data);
      }
      committedAudit.push(...stagedAudit);
      return result;
    },
  } as unknown as PrismaService;

  return { prisma, audit: committedAudit, sessions, sessionDishes };
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
    menuStatus?: MenuRow['status'];
    items?: MenuItemRow[];
    sessions?: SessionRow[];
    sessionDishes?: SessionDishRow[];
    failOnMealType?: 'LUNCH' | 'DINNER';
  } = {},
): {
  service: MealSessionsService;
  audit: AuditRow[];
  sessions: SessionRow[];
  sessionDishes: SessionDishRow[];
} {
  const { prisma, audit, sessions, sessionDishes } = createPrisma(options);
  const service = new MealSessionsService(
    prisma,
    stubAuthorizer({
      hasPermission: options.hasPermission ?? true,
      allowedFactoryId: options.allowedFactoryId ?? 'all',
    }),
    new AuditService(prisma),
  );
  return { service, audit, sessions, sessionDishes };
}

function item(
  id: string,
  serviceDate: string,
  mealType: 'LUNCH' | 'DINNER',
  dishId: string,
  sortOrder = 0,
): MenuItemRow {
  return {
    id,
    weeklyMenuId: MENU,
    serviceDate: utcDate(serviceDate),
    mealType,
    dishId,
    sortOrder,
  };
}

function existingSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'session-1',
    organizationId: ORG,
    factoryId: FACTORY,
    weeklyMenuId: MENU,
    serviceDate: utcDate(DAY_MON),
    mealType: 'LUNCH',
    status: 'DRAFT',
    opensAt: new Date(OPENS_ISO),
    cutoffAt: new Date(CUTOFF_ISO),
    publishedAt: null,
    publishedByUserId: null,
    ...overrides,
  };
}

describe('MealSessionsService', () => {
  describe('createSessionsFromMenu', () => {
    it('derives one session per serviceDate+mealType slot, carrying that slot dishes, and audits each', async () => {
      const { service, sessions, sessionDishes, audit } = makeService({
        items: [
          item('i1', DAY_MON, 'LUNCH', 'dish-a', 0),
          item('i2', DAY_MON, 'LUNCH', 'dish-b', 1),
          item('i3', DAY_TUE, 'DINNER', 'dish-c', 0),
        ],
      });

      const views = await service.createSessionsFromMenu(principal, {
        weeklyMenuId: MENU,
        opensAt: OPENS_ISO,
        cutoffAt: CUTOFF_ISO,
      });

      expect(views).toHaveLength(2);
      expect(sessions).toHaveLength(2);

      const monday = views.find(
        (v) => v.serviceDate === DAY_MON && v.mealType === 'LUNCH',
      );
      expect(monday?.dishes.map((d) => d.dishId)).toEqual(['dish-a', 'dish-b']);
      const tuesday = views.find(
        (v) => v.serviceDate === DAY_TUE && v.mealType === 'DINNER',
      );
      expect(tuesday?.dishes.map((d) => d.dishId)).toEqual(['dish-c']);

      expect(sessionDishes).toHaveLength(3);
      expect(
        audit.filter((row) => row.action === 'meal-session.create'),
      ).toHaveLength(2);
    });

    it('rejects deriving sessions from a non-published menu', async () => {
      const { service, sessions, audit } = makeService({
        menuStatus: 'DRAFT',
        items: [item('i1', DAY_MON, 'LUNCH', 'dish-a')],
      });

      await expect(
        service.createSessionsFromMenu(principal, {
          weeklyMenuId: MENU,
          opensAt: OPENS_ISO,
          cutoffAt: CUTOFF_ISO,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(sessions).toHaveLength(0);
      expect(audit).toHaveLength(0);
    });

    it('does not duplicate a session for a factory/date/meal that already exists', async () => {
      const { service, sessions } = makeService({
        items: [
          item('i1', DAY_MON, 'LUNCH', 'dish-a'),
          item('i2', DAY_TUE, 'DINNER', 'dish-c'),
        ],
        sessions: [existingSession()],
      });

      const views = await service.createSessionsFromMenu(principal, {
        weeklyMenuId: MENU,
        opensAt: OPENS_ISO,
        cutoffAt: CUTOFF_ISO,
      });

      // The Monday LUNCH slot already has a session; only Tuesday DINNER is new.
      expect(sessions).toHaveLength(2);
      expect(views).toHaveLength(2);
      const tuesdayNew = sessions.find((s) => s.id.startsWith('session-new-'));
      expect(tuesdayNew?.mealType).toBe('DINNER');
    });

    it('writes no sessions when a later slot fails (derivation is atomic)', async () => {
      const { service, sessions, sessionDishes, audit } = makeService({
        items: [
          item('i1', DAY_MON, 'LUNCH', 'dish-a', 0),
          item('i2', DAY_TUE, 'DINNER', 'dish-c', 0),
        ],
        // The LUNCH slot is created first, then the DINNER create throws. One
        // transaction must roll both back.
        failOnMealType: 'DINNER',
      });

      await expect(
        service.createSessionsFromMenu(principal, {
          weeklyMenuId: MENU,
          opensAt: OPENS_ISO,
          cutoffAt: CUTOFF_ISO,
        }),
      ).rejects.toThrow();

      expect(sessions).toHaveLength(0);
      expect(sessionDishes).toHaveLength(0);
      expect(audit).toHaveLength(0);
    });

    it('rejects a cutoff at or before opens', async () => {
      const { service } = makeService({
        items: [item('i1', DAY_MON, 'LUNCH', 'dish-a')],
      });
      await expect(
        service.createSessionsFromMenu(principal, {
          weeklyMenuId: MENU,
          opensAt: CUTOFF_ISO,
          cutoffAt: OPENS_ISO,
        }),
      ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    });

    it('forbids a factory-scoped principal from deriving sessions for another factory menu', async () => {
      const { service, sessions } = makeService({
        allowedFactoryId: OTHER_FACTORY,
        items: [item('i1', DAY_MON, 'LUNCH', 'dish-a')],
      });

      await expect(
        service.createSessionsFromMenu(principal, {
          weeklyMenuId: MENU,
          opensAt: OPENS_ISO,
          cutoffAt: CUTOFF_ISO,
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(sessions).toHaveLength(0);
    });
  });

  describe('serviceDate timezone round-trip', () => {
    it('emits serviceDate as the HCM YYYY-MM-DD it was created from', async () => {
      const { service } = makeService({
        items: [item('i1', DAY_MON, 'LUNCH', 'dish-a')],
      });
      const [view] = await service.createSessionsFromMenu(principal, {
        weeklyMenuId: MENU,
        opensAt: OPENS_ISO,
        cutoffAt: CUTOFF_ISO,
      });
      expect(view.serviceDate).toBe(DAY_MON);
    });
  });

  describe('lifecycle transitions', () => {
    it('publishes a DRAFT session, recording publishedAt/By, and audits it', async () => {
      const { service, sessions, audit } = makeService({
        sessions: [existingSession({ status: 'DRAFT' })],
      });

      const view = await service.publishSession(principal, 'session-1');

      expect(view.status).toBe('PUBLISHED');
      expect(view.publishedAt).not.toBeNull();
      expect(view.publishedByUserId).toBe('acc-1');
      expect(sessions.find((s) => s.id === 'session-1')?.status).toBe(
        'PUBLISHED',
      );
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        action: 'meal-session.publish',
        entityType: 'MealSession',
        entityId: 'session-1',
        actorId: 'acc-1',
      });
    });

    it('runs the full DRAFT->PUBLISHED->OPEN->CLOSED path and audits every step', async () => {
      const { service, audit } = makeService({
        sessions: [existingSession({ status: 'DRAFT' })],
      });

      await service.publishSession(principal, 'session-1');
      await service.openSession(principal, 'session-1');
      const closed = await service.closeSession(principal, 'session-1');

      expect(closed.status).toBe('CLOSED');
      expect(audit.map((row) => row.action)).toEqual([
        'meal-session.publish',
        'meal-session.open',
        'meal-session.close',
      ]);
    });

    it('rejects opening a session that was never published', async () => {
      const { service, sessions, audit } = makeService({
        sessions: [existingSession({ status: 'DRAFT' })],
      });

      await expect(
        service.openSession(principal, 'session-1'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(sessions.find((s) => s.id === 'session-1')?.status).toBe('DRAFT');
      expect(audit).toHaveLength(0);
    });

    it('rejects opening a CANCELLED session', async () => {
      const { service } = makeService({
        sessions: [existingSession({ status: 'CANCELLED' })],
      });
      await expect(
        service.openSession(principal, 'session-1'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('rejects re-publishing an already published session', async () => {
      const { service } = makeService({
        sessions: [existingSession({ status: 'PUBLISHED' })],
      });
      await expect(
        service.publishSession(principal, 'session-1'),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    });

    it('cancels an OPEN session and audits it', async () => {
      const { service, sessions, audit } = makeService({
        sessions: [existingSession({ status: 'OPEN' })],
      });

      const view = await service.cancelSession(principal, 'session-1');
      expect(view.status).toBe('CANCELLED');
      expect(sessions.find((s) => s.id === 'session-1')?.status).toBe(
        'CANCELLED',
      );
      expect(audit[0]).toMatchObject({ action: 'meal-session.cancel' });
    });
  });

  describe('updateTiming', () => {
    it('updates a DRAFT session timing and audits it', async () => {
      const { service, sessions, audit } = makeService({
        sessions: [existingSession({ status: 'DRAFT' })],
      });

      const newOpens = '2025-03-09T05:00:00.000Z';
      const newCutoff = '2025-03-10T05:00:00.000Z';
      const view = await service.updateTiming(principal, 'session-1', {
        opensAt: newOpens,
        cutoffAt: newCutoff,
      });

      expect(view.opensAt).toBe(newOpens);
      expect(view.cutoffAt).toBe(newCutoff);
      expect(
        sessions.find((s) => s.id === 'session-1')?.opensAt.toISOString(),
      ).toBe(newOpens);
      expect(audit[0]).toMatchObject({
        action: 'meal-session.update-timing',
      });
    });

    it('rejects changing timing once the session is no longer a draft', async () => {
      const { service, audit } = makeService({
        sessions: [existingSession({ status: 'OPEN' })],
      });
      await expect(
        service.updateTiming(principal, 'session-1', {
          opensAt: '2025-03-09T05:00:00.000Z',
        }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(audit).toHaveLength(0);
    });
  });

  describe('scope', () => {
    it('forbids a factory-scoped principal from managing another factory session', async () => {
      const { service, sessions } = makeService({
        allowedFactoryId: OTHER_FACTORY,
        sessions: [existingSession({ status: 'DRAFT' })],
      });

      await expect(
        service.publishSession(principal, 'session-1'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(sessions.find((s) => s.id === 'session-1')?.status).toBe('DRAFT');
    });

    it('forbids listing sessions for a factory outside scope', async () => {
      const { service } = makeService({ allowedFactoryId: FACTORY });
      await expect(
        service.listSessions(principal, OTHER_FACTORY),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('registration window on views', () => {
    it('reports CUTOFF_PASSED on an OPEN session whose cutoff has already passed, with no job run', async () => {
      const past = new Date(Date.now() - 60_000);
      const { service } = makeService({
        allowedFactoryId: 'all',
        sessions: [
          existingSession({
            status: 'OPEN',
            opensAt: new Date(Date.now() - 120_000),
            cutoffAt: past,
          }),
        ],
      });

      const view = await service.getSession(principal, 'session-1');
      expect(view.status).toBe('OPEN');
      expect(view.registrationWindow.state).toBe('CUTOFF_PASSED');
      expect(view.registrationWindow.isOpen).toBe(false);
    });
  });
});
