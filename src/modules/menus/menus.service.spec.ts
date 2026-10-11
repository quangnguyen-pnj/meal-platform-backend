import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { AppError } from '../../common/errors/app-error';
import { PrismaService } from '../../common/database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { MenusService } from './menus.service';

interface DishRow {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  description: string | null;
  category: string | null;
  dietaryTags: string[];
  isActive: boolean;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
}

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const DISH_ACTIVE = 'dish-active';
const DISH_OTHER_ORG = 'dish-other';

/**
 * In-memory Prisma double for the dish catalog. It seeds one active dish in
 * ORG and one dish in a different organization (to prove tenant isolation on
 * loads). `findUnique` resolves the `organizationId_code` compound key used by
 * the duplicate-code guard; `findFirst` honours the id + organizationId filter
 * the loader uses. Writes inside `$transaction` are staged and committed
 * together so an audit row lands only with the mutation.
 */
function createPrisma(): {
  prisma: PrismaService;
  audit: AuditRow[];
  dishes: DishRow[];
} {
  const dishes: DishRow[] = [
    {
      id: DISH_ACTIVE,
      organizationId: ORG,
      code: 'COM-GA',
      name: 'Com ga',
      description: null,
      category: null,
      dietaryTags: [],
      isActive: true,
    },
    {
      id: DISH_OTHER_ORG,
      organizationId: OTHER_ORG,
      code: 'COM-GA',
      name: 'Com ga (other org)',
      description: null,
      category: null,
      dietaryTags: [],
      isActive: true,
    },
  ];
  const committedAudit: AuditRow[] = [];

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
      findUnique: ({
        where,
      }: {
        where: {
          organizationId_code: { organizationId: string; code: string };
        };
      }) =>
        Promise.resolve(
          dishes.find(
            (row) =>
              row.organizationId === where.organizationId_code.organizationId &&
              row.code === where.organizationId_code.code,
          ) ?? null,
        ),
      findMany: ({
        where,
      }: {
        where?: { organizationId?: string; isActive?: boolean };
      }) =>
        Promise.resolve(
          dishes.filter(
            (row) =>
              (where?.organizationId === undefined ||
                row.organizationId === where.organizationId) &&
              (where?.isActive === undefined ||
                row.isActive === where.isActive),
          ),
        ),
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const stagedDishes: DishRow[] = [];
      const stagedAudit: AuditRow[] = [];
      const tx = {
        dish: {
          create: ({ data }: { data: Partial<DishRow> }) => {
            const row: DishRow = {
              id: data.id ?? `generated-${dishes.length + stagedDishes.length}`,
              organizationId: data.organizationId as string,
              code: data.code as string,
              name: data.name as string,
              description: data.description ?? null,
              category: data.category ?? null,
              dietaryTags: data.dietaryTags ?? [],
              isActive: data.isActive ?? true,
            };
            stagedDishes.push(row);
            return Promise.resolve(row);
          },
          update: ({
            where,
            data,
          }: {
            where: { id: string };
            data: Partial<DishRow>;
          }) => {
            const target = dishes.find((row) => row.id === where.id);
            if (!target) {
              return Promise.reject(new Error('dish not found'));
            }
            Object.assign(target, data);
            return Promise.resolve({ ...target });
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
      dishes.push(...stagedDishes);
      committedAudit.push(...stagedAudit);
      return result;
    },
  } as unknown as PrismaService;

  return { prisma, audit: committedAudit, dishes };
}

/**
 * ScopeAuthorizer stub. `hasPermission` controls the `menu:manage` gate;
 * `hasGrant` controls whether the principal holds a grant inside its
 * organization. Either failing is a FORBIDDEN, mirroring the production
 * authorizer.
 */
function stubAuthorizer(options: {
  hasPermission: boolean;
  hasGrant: boolean;
}): ScopeAuthorizer {
  return {
    assertPermission: () =>
      options.hasPermission
        ? Promise.resolve()
        : Promise.reject(
            new AppError('FORBIDDEN', 'Missing required permission.'),
          ),
    assertScope: () =>
      options.hasGrant
        ? Promise.resolve()
        : Promise.reject(
            new AppError('FORBIDDEN', 'Target is outside your granted scope.'),
          ),
  } as unknown as ScopeAuthorizer;
}

const principal: RequestPrincipal = {
  userAccountId: 'acc-1',
  organizationId: ORG,
  tokenId: 'tok-1',
};

function makeService(
  authOptions: { hasPermission: boolean; hasGrant: boolean } = {
    hasPermission: true,
    hasGrant: true,
  },
): {
  service: MenusService;
  audit: AuditRow[];
  dishes: DishRow[];
} {
  const { prisma, audit, dishes } = createPrisma();
  const service = new MenusService(
    prisma,
    stubAuthorizer(authOptions),
    new AuditService(prisma),
  );
  return { service, audit, dishes };
}

describe('MenusService dish catalog', () => {
  it('rejects a duplicate dish code within the organization with CONFLICT', async () => {
    const { service, dishes, audit } = makeService();
    const before = dishes.length;

    await expect(
      service.createDish(principal, { code: 'COM-GA', name: 'Com ga 2' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // Nothing was written: neither a dish nor an audit row.
    expect(dishes).toHaveLength(before);
    expect(audit).toHaveLength(0);
  });

  it('creates a dish and audits it', async () => {
    const { service, dishes, audit } = makeService();
    const before = dishes.length;

    const dish = await service.createDish(principal, {
      code: 'CHAO-GA',
      name: 'Chao ga',
      category: 'chao',
      dietaryTags: ['soft'],
    });

    expect(dish.code).toBe('CHAO-GA');
    expect(dish.isActive).toBe(true);
    expect(dish.dietaryTags).toEqual(['soft']);
    expect(dishes).toHaveLength(before + 1);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'dish.create',
      entityType: 'Dish',
      entityId: dish.id,
      actorId: 'acc-1',
    });
  });

  it('forbids a principal without menu:manage from creating a dish', async () => {
    const { service, dishes, audit } = makeService({
      hasPermission: false,
      hasGrant: true,
    });
    const before = dishes.length;

    await expect(
      service.createDish(principal, { code: 'NEW', name: 'New dish' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(dishes).toHaveLength(before);
    expect(audit).toHaveLength(0);
  });

  it('forbids a principal with no in-org grant from creating a dish', async () => {
    const { service, dishes, audit } = makeService({
      hasPermission: true,
      hasGrant: false,
    });
    const before = dishes.length;

    await expect(
      service.createDish(principal, { code: 'NEW', name: 'New dish' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(dishes).toHaveLength(before);
    expect(audit).toHaveLength(0);
  });

  it('disables a dish by setting isActive false without deleting it, and audits it', async () => {
    const { service, dishes, audit } = makeService();
    const before = dishes.length;

    const dish = await service.disableDish(principal, DISH_ACTIVE);

    expect(dish.isActive).toBe(false);
    // The row still exists; disabling is a soft update, never a delete.
    expect(dishes).toHaveLength(before);
    expect(dishes.find((d) => d.id === DISH_ACTIVE)?.isActive).toBe(false);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'dish.disable',
      entityType: 'Dish',
      entityId: DISH_ACTIVE,
      actorId: 'acc-1',
    });
  });

  it('re-enables a disabled dish and audits it', async () => {
    const { service, audit } = makeService();

    await service.disableDish(principal, DISH_ACTIVE);
    const dish = await service.enableDish(principal, DISH_ACTIVE);

    expect(dish.isActive).toBe(true);
    expect(audit).toHaveLength(2);
    expect(audit[1]).toMatchObject({
      action: 'dish.enable',
      entityType: 'Dish',
      entityId: DISH_ACTIVE,
    });
  });

  it('audits an update mutation', async () => {
    const { service, audit } = makeService();

    const dish = await service.updateDish(principal, DISH_ACTIVE, {
      name: 'Com ga xoi mo',
    });

    expect(dish.name).toBe('Com ga xoi mo');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      action: 'dish.update',
      entityType: 'Dish',
      entityId: DISH_ACTIVE,
    });
  });

  it('excludes inactive dishes from the default list but includes them on request', async () => {
    const { service } = makeService();

    await service.disableDish(principal, DISH_ACTIVE);

    const activeOnly = await service.listDishes(principal);
    expect(activeOnly.map((d) => d.id)).toEqual([]);

    const all = await service.listDishes(principal, true);
    expect(all.map((d) => d.id)).toEqual([DISH_ACTIVE]);
  });

  it('does not load a dish from another organization', async () => {
    const { service } = makeService();

    await expect(
      service.getDish(principal, DISH_OTHER_ORG),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
