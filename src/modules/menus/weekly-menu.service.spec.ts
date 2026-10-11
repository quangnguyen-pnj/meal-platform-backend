import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Prisma } from '../../generated/prisma/client';
import { WeeklyMenuService } from './weekly-menu.service';

interface DishRow {
  id: string;
  organizationId: string;
  isActive: boolean;
}

interface MenuRow {
  id: string;
  organizationId: string;
  factoryId: string;
  weekStartDate: Date;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  publishedAt: Date | null;
  publishedByUserId: string | null;
}

interface ItemRow {
  id: string;
  weeklyMenuId: string;
  serviceDate: Date;
  mealType: 'LUNCH' | 'DINNER';
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
const DISH_ACTIVE = 'dish-active';
const DISH_INACTIVE = 'dish-inactive';
// A Wednesday; its week starts Monday 2025-03-10.
const WEEK_DAY = '2025-03-12';
const WEEK_START_ISO = '2025-03-10';

function utcDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

/**
 * In-memory Prisma double for weekly menus and their items. Only the shapes the
 * service actually calls are implemented. Reads see committed state; writes run
 * inside `$transaction` and are staged then committed together, so an audit row
 * lands only alongside the mutation it belongs to.
 */
function createPrisma(seedItems: ItemRow[] = []): {
  prisma: PrismaService;
  audit: AuditRow[];
  menus: MenuRow[];
  items: ItemRow[];
} {
  const dishes: DishRow[] = [
    { id: DISH_ACTIVE, organizationId: ORG, isActive: true },
    { id: DISH_INACTIVE, organizationId: ORG, isActive: false },
  ];
  const menus: MenuRow[] = [
    {
      id: 'menu-1',
      organizationId: ORG,
      factoryId: FACTORY,
      weekStartDate: utcDate(WEEK_START_ISO),
      status: 'DRAFT',
      publishedAt: null,
      publishedByUserId: null,
    },
  ];
  const items: ItemRow[] = [...seedItems];
  const committedAudit: AuditRow[] = [];
  let idSeq = 0;

  const itemsFor = (menuId: string): ItemRow[] =>
    items
      .filter((item) => item.weeklyMenuId === menuId)
      .map((item) => ({ ...item }));

  const withItems = (menu: MenuRow): MenuRow & { items: ItemRow[] } => ({
    ...menu,
    items: itemsFor(menu.id),
  });

  const prisma = {
    dish: {
      findFirst: ({
        where,
      }: {
        where: { id?: string; organizationId?: string };
      }) =>
        Promise.resolve(
          dishes.find(
            (row) =>
              (where.id === undefined || row.id === where.id) &&
              (where.organizationId === undefined ||
                row.organizationId === where.organizationId),
          ) ?? null,
        ),
    },
    weeklyMenu: {
      findUnique: ({
        where,
      }: {
        where: {
          factoryId_weekStartDate: { factoryId: string; weekStartDate: Date };
        };
      }) =>
        Promise.resolve(
          menus.find(
            (row) =>
              row.factoryId === where.factoryId_weekStartDate.factoryId &&
              row.weekStartDate.getTime() ===
                where.factoryId_weekStartDate.weekStartDate.getTime(),
          ) ?? null,
        ),
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
        return Promise.resolve(found ? withItems(found) : null);
      },
      findMany: ({
        where,
      }: {
        where: { organizationId?: string; factoryId?: string };
      }) =>
        Promise.resolve(
          menus
            .filter(
              (row) =>
                (where.organizationId === undefined ||
                  row.organizationId === where.organizationId) &&
                (where.factoryId === undefined ||
                  row.factoryId === where.factoryId),
            )
            .map(withItems),
        ),
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const stagedMenus: MenuRow[] = [];
      const stagedItemsAdd: ItemRow[] = [];
      const stagedItemsDelete: string[] = [];
      const stagedMenuUpdates: Array<{ id: string; data: Partial<MenuRow> }> =
        [];
      const stagedItemUpdates: Array<{ id: string; data: Partial<ItemRow> }> =
        [];
      const stagedAudit: AuditRow[] = [];

      const tx = {
        weeklyMenu: {
          create: ({
            data,
          }: {
            data: Omit<
              MenuRow,
              'id' | 'status' | 'publishedAt' | 'publishedByUserId'
            > &
              Partial<MenuRow>;
          }) => {
            const row: MenuRow = {
              id: `menu-new-${idSeq++}`,
              organizationId: data.organizationId,
              factoryId: data.factoryId,
              weekStartDate: data.weekStartDate,
              status: data.status ?? 'DRAFT',
              publishedAt: data.publishedAt ?? null,
              publishedByUserId: data.publishedByUserId ?? null,
            };
            stagedMenus.push(row);
            return Promise.resolve({ ...row, items: [] });
          },
          update: ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<MenuRow>;
          }) => {
            stagedMenuUpdates.push({ id: where.id, data });
            const base = menus.find((row) => row.id === where.id) as MenuRow;
            return Promise.resolve(withItems({ ...base, ...data }));
          },
        },
        menuItem: {
          create: ({
            data,
          }: {
            data: Omit<ItemRow, 'id'> & Partial<ItemRow>;
          }) => {
            const row: ItemRow = {
              id: `item-new-${idSeq++}`,
              weeklyMenuId: data.weeklyMenuId,
              serviceDate: data.serviceDate,
              mealType: data.mealType,
              dishId: data.dishId,
              sortOrder: data.sortOrder ?? 0,
            };
            stagedItemsAdd.push(row);
            return Promise.resolve({ ...row });
          },
          update: ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<ItemRow>;
          }) => {
            stagedItemUpdates.push({ id: where.id, data });
            const base = items.find((row) => row.id === where.id) as ItemRow;
            return Promise.resolve({ ...base, ...data });
          },
          delete: ({ where }: { where: { id: string } }) => {
            stagedItemsDelete.push(where.id);
            const base = items.find((row) => row.id === where.id) as ItemRow;
            return Promise.resolve({ ...base });
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
      menus.push(...stagedMenus);
      items.push(...stagedItemsAdd);
      for (const id of stagedItemsDelete) {
        const index = items.findIndex((row) => row.id === id);
        if (index >= 0) items.splice(index, 1);
      }
      for (const upd of stagedMenuUpdates) {
        const target = menus.find((row) => row.id === upd.id);
        if (target) Object.assign(target, upd.data);
      }
      for (const upd of stagedItemUpdates) {
        const target = items.find((row) => row.id === upd.id);
        if (target) Object.assign(target, upd.data);
      }
      committedAudit.push(...stagedAudit);
      return result;
    },
  } as unknown as PrismaService;

  return { prisma, audit: committedAudit, menus, items };
}

/**
 * ScopeAuthorizer stub. `hasPermission` gates `menu:manage`; `allowedFactoryId`
 * gates `assertScope` so a factory-scoped principal is forbidden from touching
 * another factory, mirroring the production authorizer.
 */
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
    seedItems?: ItemRow[];
  } = {},
): {
  service: WeeklyMenuService;
  audit: AuditRow[];
  menus: MenuRow[];
  items: ItemRow[];
} {
  const { prisma, audit, menus, items } = createPrisma(options.seedItems);
  const service = new WeeklyMenuService(
    prisma,
    stubAuthorizer({
      hasPermission: options.hasPermission ?? true,
      allowedFactoryId: options.allowedFactoryId ?? 'all',
    }),
    new AuditService(prisma),
  );
  return { service, audit, menus, items };
}

describe('WeeklyMenuService', () => {
  it('rejects a second weekly menu for the same factory and week with CONFLICT', async () => {
    const { service, menus, audit } = makeService();
    const before = menus.length;

    // menu-1 already covers the week of WEEK_DAY; any day in that week collides.
    await expect(
      service.createWeeklyMenu(principal, {
        factoryId: FACTORY,
        weekStartDate: WEEK_DAY,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(menus).toHaveLength(before);
    expect(audit).toHaveLength(0);
  });

  it('creates a draft weekly menu normalised to the Monday of the week, and audits it', async () => {
    const { service, menus, audit } = makeService();

    const menu = await service.createWeeklyMenu(principal, {
      factoryId: FACTORY,
      // A different week (the following Wednesday) so it does not collide.
      weekStartDate: '2025-03-19',
    });

    expect(menu.status).toBe('DRAFT');
    expect(menu.weekStartDate).toBe('2025-03-17');
    expect(menus).toHaveLength(2);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'weekly-menu.create',
      entityType: 'WeeklyMenu',
      entityId: menu.id,
      actorId: 'acc-1',
    });
  });

  it('rejects adding an inactive dish to a menu item', async () => {
    const { service, items, audit } = makeService();
    const before = items.length;

    await expect(
      service.addMenuItem(principal, 'menu-1', {
        serviceDate: WEEK_DAY,
        mealType: 'LUNCH',
        dishId: DISH_INACTIVE,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(items).toHaveLength(before);
    expect(audit).toHaveLength(0);
  });

  it('adds an active dish inside the week and audits it', async () => {
    const { service, items, audit } = makeService();

    const menu = await service.addMenuItem(principal, 'menu-1', {
      serviceDate: WEEK_DAY,
      mealType: 'LUNCH',
      dishId: DISH_ACTIVE,
    });

    expect(items).toHaveLength(1);
    expect(menu.items).toHaveLength(1);
    expect(menu.items[0]).toMatchObject({
      serviceDate: WEEK_DAY,
      mealType: 'LUNCH',
      dishId: DISH_ACTIVE,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'menu-item.add',
      entityType: 'MenuItem',
    });
  });

  it('rejects a service date outside the menu week', async () => {
    const { service, items, audit } = makeService();
    const before = items.length;

    await expect(
      service.addMenuItem(principal, 'menu-1', {
        // 2025-03-17 is the Monday of the NEXT week, outside menu-1's week.
        serviceDate: '2025-03-17',
        mealType: 'LUNCH',
        dishId: DISH_ACTIVE,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(items).toHaveLength(before);
    expect(audit).toHaveLength(0);
  });

  it('rejects the same dish twice in the same slot with CONFLICT', async () => {
    const { service } = makeService({
      seedItems: [
        {
          id: 'item-seed',
          weeklyMenuId: 'menu-1',
          serviceDate: utcDate(WEEK_START_ISO),
          mealType: 'LUNCH',
          dishId: DISH_ACTIVE,
          sortOrder: 0,
        },
      ],
    });

    await expect(
      service.addMenuItem(principal, 'menu-1', {
        serviceDate: WEEK_START_ISO,
        mealType: 'LUNCH',
        dishId: DISH_ACTIVE,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('rejects editing items after the menu is published', async () => {
    const { service, menus, items } = makeService({
      seedItems: [
        {
          id: 'item-seed',
          weeklyMenuId: 'menu-1',
          serviceDate: utcDate(WEEK_START_ISO),
          mealType: 'LUNCH',
          dishId: DISH_ACTIVE,
          sortOrder: 0,
        },
      ],
    });

    await service.publishWeeklyMenu(principal, 'menu-1');
    expect(menus.find((m) => m.id === 'menu-1')?.status).toBe('PUBLISHED');

    const before = items.length;
    await expect(
      service.addMenuItem(principal, 'menu-1', {
        serviceDate: WEEK_DAY,
        mealType: 'DINNER',
        dishId: DISH_ACTIVE,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      service.removeMenuItem(principal, 'menu-1', 'item-seed'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(items).toHaveLength(before);
  });

  it('forbids a factory-scoped principal from creating a menu in another factory', async () => {
    const { service, menus } = makeService({ allowedFactoryId: FACTORY });
    const before = menus.length;

    await expect(
      service.createWeeklyMenu(principal, {
        factoryId: OTHER_FACTORY,
        weekStartDate: '2025-03-19',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(menus).toHaveLength(before);
  });

  it('forbids a factory-scoped principal from publishing another factory menu', async () => {
    const { service } = makeService({
      allowedFactoryId: OTHER_FACTORY,
      seedItems: [
        {
          id: 'item-seed',
          weeklyMenuId: 'menu-1',
          serviceDate: utcDate(WEEK_START_ISO),
          mealType: 'LUNCH',
          dishId: DISH_ACTIVE,
          sortOrder: 0,
        },
      ],
    });

    await expect(
      service.publishWeeklyMenu(principal, 'menu-1'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects publishing an empty menu', async () => {
    const { service, menus, audit } = makeService();

    await expect(
      service.publishWeeklyMenu(principal, 'menu-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });

    expect(menus.find((m) => m.id === 'menu-1')?.status).toBe('DRAFT');
    expect(audit).toHaveLength(0);
  });

  it('publishes a valid menu, setting status and publishedAt, and writes an audit row', async () => {
    const { service, menus, audit } = makeService({
      seedItems: [
        {
          id: 'item-seed',
          weeklyMenuId: 'menu-1',
          serviceDate: utcDate(WEEK_START_ISO),
          mealType: 'LUNCH',
          dishId: DISH_ACTIVE,
          sortOrder: 0,
        },
      ],
    });

    const menu = await service.publishWeeklyMenu(principal, 'menu-1');

    expect(menu.status).toBe('PUBLISHED');
    expect(menu.publishedAt).not.toBeNull();
    expect(menu.publishedByUserId).toBe('acc-1');
    expect(menus.find((m) => m.id === 'menu-1')?.status).toBe('PUBLISHED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'weekly-menu.publish',
      entityType: 'WeeklyMenu',
      entityId: 'menu-1',
      actorId: 'acc-1',
    });
  });

  it('archives a menu and audits it', async () => {
    const { service, menus, audit } = makeService();

    const menu = await service.archiveWeeklyMenu(principal, 'menu-1');

    expect(menu.status).toBe('ARCHIVED');
    expect(menus.find((m) => m.id === 'menu-1')?.status).toBe('ARCHIVED');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'weekly-menu.archive',
      entityType: 'WeeklyMenu',
      entityId: 'menu-1',
    });
  });
});
