import { Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../database/prisma.service';

/**
 * One audit entry to record alongside a mutation. `organizationId` keeps the
 * trail tenant-scoped; `actorId` is the account that performed the action, or
 * null for system-originated changes. `createdAt` is set by the database
 * default, so a row always carries a timestamp.
 */
export interface AuditEntry {
  organizationId: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details?: Prisma.InputJsonValue;
}

/**
 * Records audit rows in the SAME transaction as the mutation that caused them.
 *
 * The primary API is `record`, which takes the transaction client the service
 * is already using inside `prisma.$transaction(...)`. Because the audit insert
 * runs on that client, it commits atomically with the change and rolls back
 * with it: a mutation that throws leaves no orphan audit row, and a committed
 * mutation always has its audit row.
 *
 * `recordWithTransaction` is a thin convenience for the common case where the
 * whole unit of work is a single mutation plus its audit row.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write an audit row on the given transaction client. Call this inside your
   * `$transaction` callback, after (or alongside) the mutation, so the two
   * commit together.
   */
  async record(tx: Prisma.TransactionClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        organizationId: entry.organizationId,
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: entry.details,
      },
    });
  }

  /**
   * Run `mutation` and its audit entry in a single transaction. The entry is
   * derived from the mutation's result so the audited `entityId` is the id the
   * mutation actually produced. If `mutation` throws, nothing is written.
   */
  async recordWithTransaction<T>(
    mutation: (tx: Prisma.TransactionClient) => Promise<T>,
    toEntry: (result: T) => AuditEntry,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      const result = await mutation(tx);
      await this.record(tx, toEntry(result));
      return result;
    });
  }
}
