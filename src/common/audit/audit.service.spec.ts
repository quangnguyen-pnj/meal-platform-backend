import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditService } from './audit.service';

interface AuditRow {
  organizationId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details?: unknown;
  createdAt: Date;
}

interface MutationRow {
  id: string;
}

/**
 * In-memory Prisma double that models transaction atomicity: writes made
 * inside a `$transaction` callback are staged and only merged into the
 * committed store when the callback resolves. If the callback throws, the
 * staged writes are discarded, exactly like a real rollback. This lets the
 * spec prove the audit row commits with the mutation and rolls back with it.
 *
 * `healthCheck` stands in for an arbitrary business mutation: it is the one
 * model whose `create` accepts a trivial payload, so the double stays typed
 * against the real `Prisma.TransactionClient` without reproducing a full
 * domain row.
 */
function createTransactionalPrisma(): {
  prisma: PrismaService;
  committedAudit: AuditRow[];
  committedMutations: MutationRow[];
} {
  const committedAudit: AuditRow[] = [];
  const committedMutations: MutationRow[] = [];

  const prisma = {
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const stagedAudit: AuditRow[] = [];
      const stagedMutations: MutationRow[] = [];
      const tx = {
        auditLog: {
          create: ({ data }: { data: Omit<AuditRow, 'createdAt'> }) => {
            stagedAudit.push({ ...data, createdAt: new Date() });
            return Promise.resolve(data);
          },
        },
        healthCheck: {
          create: ({ data }: { data: { id?: string } }) => {
            const row: MutationRow = { id: data.id ?? 'generated' };
            stagedMutations.push(row);
            return Promise.resolve(row);
          },
        },
      } as unknown as Prisma.TransactionClient;

      const result = await fn(tx);
      // Only reached when the callback resolves: commit the staged writes.
      committedAudit.push(...stagedAudit);
      committedMutations.push(...stagedMutations);
      return result;
    },
  } as unknown as PrismaService;

  return { prisma, committedAudit, committedMutations };
}

describe('AuditService', () => {
  it('writes an audit row with actor, action, entity, and a timestamp in the same transaction as the mutation', async () => {
    const { prisma, committedAudit, committedMutations } =
      createTransactionalPrisma();
    const audit = new AuditService(prisma);

    const created = await audit.recordWithTransaction(
      (tx) => tx.healthCheck.create({ data: { id: 'row-1' } }),
      (row) => ({
        organizationId: 'org-1',
        actorId: 'acc-1',
        action: 'employee.create',
        entityType: 'Employee',
        entityId: row.id,
      }),
    );

    expect(created.id).toBe('row-1');
    expect(committedMutations).toHaveLength(1);
    expect(committedAudit).toHaveLength(1);
    expect(committedAudit[0]).toMatchObject({
      organizationId: 'org-1',
      actorId: 'acc-1',
      action: 'employee.create',
      entityType: 'Employee',
      entityId: 'row-1',
    });
    expect(committedAudit[0].createdAt).toBeInstanceOf(Date);
  });

  it('rolls back the audit row when the mutation fails', async () => {
    const { prisma, committedAudit, committedMutations } =
      createTransactionalPrisma();
    const audit = new AuditService(prisma);

    await expect(
      audit.recordWithTransaction(
        async (tx) => {
          await tx.healthCheck.create({ data: { id: 'row-2' } });
          throw new Error('mutation failed after staging');
        },
        () => ({
          organizationId: 'org-1',
          actorId: 'acc-1',
          action: 'employee.create',
          entityType: 'Employee',
          entityId: 'row-2',
        }),
      ),
    ).rejects.toThrow(/mutation failed/);

    // Neither the mutation nor the audit row was committed.
    expect(committedMutations).toHaveLength(0);
    expect(committedAudit).toHaveLength(0);
  });

  it('records on a caller-supplied transaction client via record()', async () => {
    const { prisma, committedAudit } = createTransactionalPrisma();
    const audit = new AuditService(prisma);

    await prisma.$transaction(async (tx) => {
      await audit.record(tx, {
        organizationId: 'org-1',
        actorId: null,
        action: 'role.assign',
        entityType: 'UserRole',
        entityId: 'ur-1',
        details: { roleCode: 'FactoryAdmin' },
      });
    });

    expect(committedAudit).toHaveLength(1);
    expect(committedAudit[0]).toMatchObject({
      actorId: null,
      action: 'role.assign',
      details: { roleCode: 'FactoryAdmin' },
    });
  });
});
