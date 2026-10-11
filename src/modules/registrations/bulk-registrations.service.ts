import { Injectable } from '@nestjs/common';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import { Clock } from '../../common/time/clock';
import { MealRegistration, Prisma } from '../../generated/prisma/client';
import {
  RegistrationBatchStatus,
  RegistrationChangeKind,
  RegistrationSource,
  RegistrationStatus,
} from '../../generated/prisma/enums';
import { MealSessionAccess } from '../meal-sessions/meal-session-access.service';
import {
  BulkCommitResult,
  BulkEntryInput,
  BulkEntryResult,
  BulkValidationResult,
  DishTotal,
  MealRegistrationView,
  RegistrationBatchEntryView,
  RegistrationBatchView,
} from './registrations.types';

/**
 * The flow-specific parts of a batch commit. Everything else (scope, atomicity,
 * cutoff, upsert, change, audit) is shared, so BULK (P2-04) and PAPER_FORM
 * (P2-06) differ only in these values rather than in a forked code path.
 */
interface CommitOptions {
  source: RegistrationSource;
  paperReference: string | null;
  reason?: string;
  auditAction: string;
}

/**
 * A factory employee the acting principal may act on, with the tenant-tree
 * ids scope checks compare against.
 */
interface ScopedEmployee {
  id: string;
  factoryId: string;
  departmentId: string;
  teamId: string;
}

/** The session a batch targets, loaded once per command. */
interface BatchSession {
  id: string;
  factoryId: string;
  dishIds: Set<string>;
}

/**
 * Owns the Phase 2 bulk-registration rules (P2-04): a team representative or
 * admin registering many of their employees for one meal session in a single
 * batch, with whole-batch atomicity.
 *
 * The invariants mirror the plan's Flow C:
 *  - Scope-bounded. The acting principal may only register employees inside
 *    its granted scope. Every entry's employee is checked with
 *    `ScopeAuthorizer.assertScope` against that employee's team path, and the
 *    employee must belong to the session's factory. An out-of-scope or
 *    foreign-factory employee makes that entry INVALID.
 *  - Whole-batch atomic. Validation runs over ALL entries first. If any entry
 *    is invalid (out of scope, dish not in session, duplicate within the
 *    batch, malformed row), `commit` writes NO registrations and records the
 *    batch as REJECTED. A valid commit writes every registration in ONE
 *    transaction, upserting the `[mealSessionId, employeeId]` row so a
 *    re-submit corrects rather than duplicates.
 *  - Cutoff is not decided here. `commit` asks `MealSessionAccess` whether the
 *    window is open for `clock.now()`; a closed window is rejected with the
 *    window's own reason (post-cutoff change is admin-only, P2-08).
 *  - Unselected is surfaced. Both preview and commit report how many in-scope
 *    factory employees have no entry at all, distinct from those explicitly
 *    marked not-eating, plus totals by dish, so the UI can force a confirmation
 *    before submit (P2-05).
 *
 * Each committed registration records a `RegistrationChange`, and the batch
 * commit records a single `AuditLog` row, all in the same transaction.
 */
@Injectable()
export class BulkRegistrationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly mealSessionAccess: MealSessionAccess,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /**
   * Validate a set of staged entries without writing anything (preview). The
   * window is NOT required to be open to preview, so a representative can
   * build and check a batch ahead of time; `commit` enforces the window.
   */
  async validate(
    principal: RequestPrincipal,
    mealSessionId: string,
    entries: BulkEntryInput[],
  ): Promise<BulkValidationResult> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'registration:bulk',
    });
    const session = await this.loadSession(principal, mealSessionId);
    const scopedEmployees = await this.loadScopedFactoryEmployees(
      principal,
      session.factoryId,
    );
    return this.evaluate(entries, session, scopedEmployees);
  }

  /**
   * Commit a set of staged entries as one batch. Validates every entry first;
   * if any is invalid, records a REJECTED batch and throws without writing a
   * single registration. A valid commit requires the window to be open, then
   * upserts all registrations with source=BULK, each with a change, plus one
   * batch audit row, in a single transaction.
   */
  async commit(
    principal: RequestPrincipal,
    mealSessionId: string,
    entries: BulkEntryInput[],
    reason?: string,
  ): Promise<BulkCommitResult> {
    return this.commitBatch(principal, mealSessionId, entries, {
      source: RegistrationSource.BULK,
      paperReference: null,
      reason,
      auditAction: 'registration.bulk.commit',
    });
  }

  /**
   * Validate a set of staged paper-form entries without writing anything
   * (preview). Identical to {@link validate} - paper rows go through the same
   * grid - but requires a non-empty paper reference up front so the UI cannot
   * build a paper batch that commit would then reject.
   */
  async validatePaperForm(
    principal: RequestPrincipal,
    mealSessionId: string,
    paperReference: string,
    entries: BulkEntryInput[],
  ): Promise<BulkValidationResult> {
    this.assertPaperReference(paperReference);
    return this.validate(principal, mealSessionId, entries);
  }

  /**
   * Commit a set of staged entries as a PAPER_FORM batch (P2-06). This is the
   * SAME path as {@link commit}: same scope checks, whole-batch atomicity,
   * cutoff gate, `[mealSessionId, employeeId]` upsert (so re-entering the same
   * paper form corrects rather than duplicates), per-row change, and single
   * batch audit row. The only differences are source=PAPER_FORM and a REQUIRED
   * `paperReference` persisted on the batch; a blank reference is rejected
   * before anything is written.
   */
  async commitPaperForm(
    principal: RequestPrincipal,
    mealSessionId: string,
    paperReference: string,
    entries: BulkEntryInput[],
    reason?: string,
  ): Promise<BulkCommitResult> {
    this.assertPaperReference(paperReference);
    return this.commitBatch(principal, mealSessionId, entries, {
      source: RegistrationSource.PAPER_FORM,
      paperReference: paperReference.trim(),
      reason,
      auditAction: 'registration.paper.commit',
    });
  }

  /**
   * Read one batch (P2-06) so the paper-form UI can track which forms are
   * entered versus pending. Exposes the batch source, status, paper reference,
   * and the stored per-row entries. Tenant-scoped to the principal's org.
   */
  async getBatch(
    principal: RequestPrincipal,
    batchId: string,
  ): Promise<RegistrationBatchView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'registration:bulk',
    });
    const batch = await this.prisma.registrationBatch.findFirst({
      where: { id: batchId, organizationId: principal.organizationId },
      select: {
        id: true,
        factoryId: true,
        source: true,
        status: true,
        paperReference: true,
        reason: true,
        submittedAt: true,
        createdAt: true,
        entries: {
          orderBy: [{ rowNumber: 'asc' }, { createdAt: 'asc' }],
          select: {
            employeeId: true,
            mealSessionDishId: true,
            rowNumber: true,
            status: true,
            errors: true,
          },
        },
      },
    });
    if (!batch) {
      throw new AppError('NOT_FOUND', 'Registration batch not found.', {
        batchId,
      });
    }
    const entries: RegistrationBatchEntryView[] = batch.entries.map(
      (entry) => ({
        employeeId: entry.employeeId,
        mealSessionDishId: entry.mealSessionDishId,
        rowNumber: entry.rowNumber,
        status: entry.status,
        errors: Array.isArray(entry.errors) ? (entry.errors as string[]) : [],
      }),
    );
    return {
      id: batch.id,
      factoryId: batch.factoryId,
      source: batch.source,
      status: batch.status,
      paperReference: batch.paperReference,
      reason: batch.reason,
      submittedAt: batch.submittedAt ? batch.submittedAt.toISOString() : null,
      createdAt: batch.createdAt.toISOString(),
      entries,
    };
  }

  /**
   * Shared commit core for BULK and PAPER_FORM. Validates every entry, records
   * a REJECTED batch and throws on any invalid row (whole-batch atomicity),
   * enforces the cutoff window, then upserts every eating entry on
   * `[mealSessionId, employeeId]` with the flow's source - plus a per-row
   * change and one batch audit row - inside a single transaction.
   */
  private async commitBatch(
    principal: RequestPrincipal,
    mealSessionId: string,
    entries: BulkEntryInput[],
    options: CommitOptions,
  ): Promise<BulkCommitResult> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'registration:bulk',
    });
    const session = await this.loadSession(principal, mealSessionId);
    const scopedEmployees = await this.loadScopedFactoryEmployees(
      principal,
      session.factoryId,
    );
    const result = this.evaluate(entries, session, scopedEmployees);

    if (!result.isValid) {
      // Whole-batch atomicity: nothing is registered. Persist the attempt as a
      // REJECTED batch so the failure is traceable, then surface the row errors.
      await this.recordRejectedBatch(principal, session, result, options);
      throw new AppError(
        'VALIDATION_ERROR',
        'The batch has invalid entries; no registrations were written.',
        {
          mealSessionId,
          invalidEntries: result.entries.filter(
            (entry) => entry.status === 'INVALID',
          ),
        },
      );
    }

    await this.assertWindowOpen(principal, mealSessionId);

    const actorId = principal.userAccountId;
    const now = this.clock.now();
    const eatingEntries = result.entries.filter((entry) => !entry.notEating);

    const { batchId, registrations } = await this.prisma.$transaction(
      async (tx) => {
        const batch = await tx.registrationBatch.create({
          data: {
            organizationId: principal.organizationId,
            factoryId: session.factoryId,
            source: options.source,
            status: RegistrationBatchStatus.COMMITTED,
            reason: options.reason ?? null,
            paperReference: options.paperReference,
            createdByUserId: actorId,
            submittedAt: now,
          },
        });

        const written: MealRegistration[] = [];
        for (const entry of eatingEntries) {
          const dishId = entry.mealSessionDishId as string;
          const existing = await tx.mealRegistration.findUnique({
            where: {
              mealSessionId_employeeId: {
                mealSessionId,
                employeeId: entry.employeeId,
              },
            },
          });

          let registration: MealRegistration;
          let kind: RegistrationChangeKind;
          let before: Prisma.InputJsonValue | undefined;
          if (!existing) {
            registration = await tx.mealRegistration.create({
              data: {
                organizationId: principal.organizationId,
                mealSessionId,
                employeeId: entry.employeeId,
                mealSessionDishId: dishId,
                status: RegistrationStatus.REGISTERED,
                source: options.source,
                registrationBatchId: batch.id,
                createdByUserId: actorId,
                registeredAt: now,
              },
            });
            kind = RegistrationChangeKind.CREATED;
            before = undefined;
          } else {
            before = snapshot(existing);
            registration = await tx.mealRegistration.update({
              where: { id: existing.id },
              data: {
                mealSessionDishId: dishId,
                status: RegistrationStatus.REGISTERED,
                source: options.source,
                registrationBatchId: batch.id,
                updatedByUserId: actorId,
                cancelledAt: null,
                registeredAt: now,
              },
            });
            kind =
              existing.status === RegistrationStatus.REGISTERED
                ? RegistrationChangeKind.DISH_CHANGED
                : RegistrationChangeKind.CREATED;
          }

          await tx.registrationChange.create({
            data: {
              mealRegistrationId: registration.id,
              kind,
              before,
              after: snapshot(registration),
              actorUserId: actorId,
            },
          });

          written.push(registration);
        }

        await this.audit.record(tx, {
          organizationId: principal.organizationId,
          actorId,
          action: options.auditAction,
          entityType: 'RegistrationBatch',
          entityId: batch.id,
          details: {
            mealSessionId,
            factoryId: session.factoryId,
            source: options.source,
            paperReference: options.paperReference,
            registered: written.length,
            notEating: result.notEatingCount,
            unselected: result.unselected,
          },
        });

        return { batchId: batch.id, registrations: written };
      },
    );

    return {
      batchId,
      status: RegistrationBatchStatus.COMMITTED,
      source: options.source,
      paperReference: options.paperReference,
      registrations: registrations.map(toView),
      totalsByDish: result.totalsByDish,
      eatingCount: result.eatingCount,
      notEatingCount: result.notEatingCount,
      unselected: result.unselected,
      inScopeEmployeeCount: result.inScopeEmployeeCount,
    };
  }

  /**
   * A paper-form batch must carry a reference/note (P2-06). This is the one
   * invariant that distinguishes it from a bulk batch; enforce it before any
   * read or write so a blank reference can never reach the commit.
   */
  private assertPaperReference(paperReference: string): void {
    if (!paperReference || paperReference.trim().length === 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'A paper-form batch requires a non-empty paper reference.',
      );
    }
  }

  /**
   * Pure evaluation shared by preview and commit: validate every entry, then
   * derive totals by dish and the unselected count. No database writes.
   */
  private evaluate(
    entries: BulkEntryInput[],
    session: BatchSession,
    scopedEmployees: ScopedEmployee[],
  ): BulkValidationResult {
    const inScopeById = new Map(
      scopedEmployees.map((employee) => [employee.id, employee]),
    );
    const seen = new Set<string>();
    const results: BulkEntryResult[] = entries.map((entry) =>
      this.evaluateEntry(entry, session, inScopeById, seen),
    );

    const isValid = results.every((entry) => entry.status === 'VALID');
    const eatingResults = results.filter(
      (entry) => entry.status === 'VALID' && !entry.notEating,
    );
    const notEatingCount = results.filter(
      (entry) => entry.status === 'VALID' && entry.notEating,
    ).length;

    const totalsByDish = tallyByDish(eatingResults);

    // "Unselected" is an in-scope factory employee with no entry of any kind.
    const enteredEmployeeIds = new Set(
      results.map((entry) => entry.employeeId),
    );
    const unselected = scopedEmployees.filter(
      (employee) => !enteredEmployeeIds.has(employee.id),
    ).length;

    return {
      mealSessionId: session.id,
      factoryId: session.factoryId,
      isValid,
      entries: results,
      totalsByDish,
      eatingCount: eatingResults.length,
      notEatingCount,
      unselected,
      inScopeEmployeeCount: scopedEmployees.length,
    };
  }

  private evaluateEntry(
    entry: BulkEntryInput,
    session: BatchSession,
    inScopeById: Map<string, ScopedEmployee>,
    seen: Set<string>,
  ): BulkEntryResult {
    const notEating = entry.notEating === true;
    const dishId = entry.mealSessionDishId ?? null;
    const errors: string[] = [];

    if (seen.has(entry.employeeId)) {
      errors.push('Employee appears more than once in this batch.');
    }
    seen.add(entry.employeeId);

    if (notEating && dishId) {
      errors.push('An entry marked not-eating must not also choose a dish.');
    }
    if (!notEating && !dishId) {
      errors.push('An eating entry must choose a dish.');
    }

    if (!inScopeById.has(entry.employeeId)) {
      // Not in the acting principal's scope, or not in the session's factory.
      errors.push(
        'Employee is outside your scope or not in this session factory.',
      );
    }

    if (!notEating && dishId && !session.dishIds.has(dishId)) {
      errors.push('The chosen dish is not offered by this meal session.');
    }

    return {
      employeeId: entry.employeeId,
      mealSessionDishId: notEating ? null : dishId,
      notEating,
      rowNumber: entry.rowNumber ?? null,
      status: errors.length === 0 ? 'VALID' : 'INVALID',
      errors,
    };
  }

  /**
   * Load the session (tenant-scoped) and its offered dish ids.
   */
  private async loadSession(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<BatchSession> {
    const session = await this.prisma.mealSession.findFirst({
      where: { id: mealSessionId, organizationId: principal.organizationId },
      select: { id: true, factoryId: true, dishes: { select: { id: true } } },
    });
    if (!session) {
      throw new AppError('NOT_FOUND', 'Meal session not found.', {
        mealSessionId,
      });
    }
    return {
      id: session.id,
      factoryId: session.factoryId,
      dishIds: new Set(session.dishes.map((dish) => dish.id)),
    };
  }

  /**
   * The employees of the session's factory the acting principal may register:
   * the factory's employees narrowed by the principal's scope filter. A team
   * representative sees only their team's employees; a department/factory/org
   * grant widens the set. This is the authoritative in-scope set used both to
   * validate entries and to count unselected employees.
   */
  private async loadScopedFactoryEmployees(
    principal: RequestPrincipal,
    factoryId: string,
  ): Promise<ScopedEmployee[]> {
    const scopeFilter = await this.scopeAuthorizer.scopeFilter(principal);
    const employees = await this.prisma.employee.findMany({
      where: { AND: [scopeFilter, { factoryId }] },
      select: {
        id: true,
        factoryId: true,
        departmentId: true,
        teamId: true,
      },
    });
    return employees;
  }

  /**
   * Ask the single cutoff authority whether the window is open now. A closed
   * window is rejected with the window's own reason so the API explains why.
   */
  private async assertWindowOpen(
    principal: RequestPrincipal,
    mealSessionId: string,
  ): Promise<void> {
    const window = await this.mealSessionAccess.getRegistrationWindow({
      mealSessionId,
      organizationId: principal.organizationId,
      now: this.clock.now(),
    });
    if (!window.isOpen) {
      throw new AppError('CONFLICT', window.reason, {
        mealSessionId,
        state: window.state,
      });
    }
  }

  /**
   * Record a failed batch as REJECTED with its invalid entries, writing no
   * registrations. This is the atomic-failure path: the batch exists for
   * traceability, nothing else is touched.
   */
  private async recordRejectedBatch(
    principal: RequestPrincipal,
    session: BatchSession,
    result: BulkValidationResult,
    options: CommitOptions,
  ): Promise<void> {
    const actorId = principal.userAccountId;
    await this.prisma.$transaction(async (tx) => {
      const batch = await tx.registrationBatch.create({
        data: {
          organizationId: principal.organizationId,
          factoryId: session.factoryId,
          source: options.source,
          status: RegistrationBatchStatus.REJECTED,
          reason: options.reason ?? null,
          paperReference: options.paperReference,
          createdByUserId: actorId,
          submittedAt: this.clock.now(),
        },
      });

      await tx.registrationBatchEntry.createMany({
        data: result.entries.map((entry) => ({
          registrationBatchId: batch.id,
          employeeId: entry.employeeId,
          mealSessionId: session.id,
          mealSessionDishId: entry.mealSessionDishId,
          rowNumber: entry.rowNumber ?? undefined,
          status: entry.status,
          errors: entry.errors.length > 0 ? entry.errors : undefined,
        })),
      });

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        actorId,
        action: `${options.auditAction}.reject`,
        entityType: 'RegistrationBatch',
        entityId: batch.id,
        details: {
          mealSessionId: session.id,
          factoryId: session.factoryId,
          source: options.source,
          invalid: result.entries.filter((entry) => entry.status === 'INVALID')
            .length,
        },
      });
    });
  }
}

/**
 * Count VALID eating entries per dish for the totals-by-dish view.
 */
function tallyByDish(eatingEntries: BulkEntryResult[]): DishTotal[] {
  const counts = new Map<string, number>();
  for (const entry of eatingEntries) {
    const dishId = entry.mealSessionDishId as string;
    counts.set(dishId, (counts.get(dishId) ?? 0) + 1);
  }
  return [...counts.entries()].map(([mealSessionDishId, count]) => ({
    mealSessionDishId,
    count,
  }));
}

/**
 * A `RegistrationChange.before`/`after` JSON snapshot of a registration.
 */
function snapshot(registration: MealRegistration): Prisma.InputJsonValue {
  return {
    mealSessionDishId: registration.mealSessionDishId,
    status: registration.status,
    source: registration.source,
  };
}

function toView(registration: MealRegistration): MealRegistrationView {
  return {
    id: registration.id,
    mealSessionId: registration.mealSessionId,
    employeeId: registration.employeeId,
    mealSessionDishId: registration.mealSessionDishId,
    status: registration.status,
    source: registration.source,
    registeredAt: registration.registeredAt.toISOString(),
    cancelledAt: registration.cancelledAt
      ? registration.cancelledAt.toISOString()
      : null,
  };
}
