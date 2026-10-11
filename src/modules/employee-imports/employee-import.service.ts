import { Injectable } from '@nestjs/common';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { AuditService } from '../../common/audit/audit.service';
import { ResourceScope } from '../../common/authorization/resource-scope';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { AppError } from '../../common/errors/app-error';
import {
  Prisma,
  Department,
  EmployeeImportJob,
  EmployeeImportRow,
  Factory,
  Team,
} from '../../generated/prisma/client';
import { ImportJobStatus, ImportRowStatus } from '../../generated/prisma/enums';
import { EmployeeImportWorkbookService } from './employee-import-workbook.service';
import {
  ImportApplyResult,
  ImportJobView,
  ImportRowView,
  ParsedImportRow,
  ResolvedRow,
  RowError,
  ValidatedRow,
} from './employee-imports.types';

const EMPLOYEE_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * Owns the employee-import business rules: parse an uploaded workbook, validate
 * every row as a unit against the principal's tenant tree and scope, persist
 * the job plus its parsed rows for preview, and atomically upsert employees on
 * apply.
 *
 * Two invariants drive the design:
 *
 * - An invalid file never writes partial employee data. Validation runs over
 *   the whole file first; apply refuses a job that is not VALIDATED or that
 *   holds any invalid row, before touching the employee table.
 * - Apply is idempotent. Employees are upserted by `(organizationId,
 *   employeeCode)`, so re-applying the same file updates in place and never
 *   creates duplicates. The upsert and its audit row share one transaction.
 */
@Injectable()
export class EmployeeImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scopeAuthorizer: ScopeAuthorizer,
    private readonly audit: AuditService,
    private readonly workbook: EmployeeImportWorkbookService,
  ) {}

  /** The authoritative, always-current download template. */
  buildTemplate(): Promise<Buffer> {
    return this.workbook.buildTemplate();
  }

  /**
   * Parse and validate an uploaded workbook, persisting an import job and one
   * row per parsed line with its per-row outcome. The job lands VALIDATED when
   * every row is valid and FAILED otherwise, so a later apply can trust the
   * stored status. No employee data is written here.
   */
  async uploadAndValidate(
    principal: RequestPrincipal,
    file: { originalname: string; buffer: Buffer },
  ): Promise<ImportJobView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:import',
    });

    const parsedRows = await this.workbook.parse(file.buffer);
    const validatedRows = await this.validateRows(principal, parsedRows);
    const errorCount = validatedRows.filter(
      (row) => row.status === ImportRowStatus.INVALID,
    ).length;
    const status =
      errorCount === 0 ? ImportJobStatus.VALIDATED : ImportJobStatus.FAILED;

    const job = await this.prisma.$transaction(async (tx) => {
      const created = await tx.employeeImportJob.create({
        data: {
          organizationId: principal.organizationId,
          status,
          originalFilename: file.originalname,
          uploadedById: principal.userAccountId,
          rowCount: parsedRows.length,
          errorCount,
        },
      });
      await tx.employeeImportRow.createMany({
        data: parsedRows.map((parsed) => {
          const validated = validatedRows.find(
            (row) => row.rowNumber === parsed.rowNumber,
          )!;
          return {
            importJobId: created.id,
            rowNumber: parsed.rowNumber,
            employeeCode: parsed.employeeCode,
            fullName: parsed.fullName,
            email: parsed.email,
            factoryCode: parsed.factoryCode,
            departmentCode: parsed.departmentCode,
            teamCode: parsed.teamCode,
            hasPersonalDevice: parseBoolean(parsed.hasPersonalDevice),
            status: validated.status,
            errors:
              validated.errors.length > 0
                ? (validated.errors as unknown as Prisma.InputJsonValue)
                : Prisma.JsonNull,
          };
        }),
      });
      return created;
    });

    return toJobView(job);
  }

  async getJob(
    principal: RequestPrincipal,
    jobId: string,
  ): Promise<ImportJobView> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:import',
    });
    const job = await this.loadJob(principal, jobId);
    return toJobView(job);
  }

  async getJobRows(
    principal: RequestPrincipal,
    jobId: string,
  ): Promise<ImportRowView[]> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:import',
    });
    await this.loadJob(principal, jobId);
    const rows = await this.prisma.employeeImportRow.findMany({
      where: { importJobId: jobId },
      orderBy: { rowNumber: 'asc' },
    });
    return rows.map(toRowView);
  }

  /**
   * Apply a validated job: upsert every row's employee by `(organizationId,
   * employeeCode)` in a single transaction and record the import audit entry on
   * that same transaction. Rejected (writing nothing) when the job is not
   * VALIDATED or holds any invalid row, so a file with any error never writes
   * partial data. Re-applying revalidates the stored rows against the current
   * tenant tree so a stale job cannot slip past.
   */
  async apply(
    principal: RequestPrincipal,
    jobId: string,
  ): Promise<ImportApplyResult> {
    await this.scopeAuthorizer.assertPermission({
      principal,
      permission: 'employee:import',
    });
    const job = await this.loadJob(principal, jobId);
    if (job.status !== ImportJobStatus.VALIDATED) {
      throw new AppError(
        'VALIDATION_ERROR',
        'Only a validated import job can be applied.',
        { status: job.status },
      );
    }

    const rows = await this.prisma.employeeImportRow.findMany({
      where: { importJobId: jobId },
      orderBy: { rowNumber: 'asc' },
    });

    // Revalidate from the stored row values so a tenant-tree change since
    // upload cannot let an invalid placement through, and so the resolved ids
    // are fresh. Any invalid row aborts before any employee write.
    const parsed: ParsedImportRow[] = rows.map((row) => ({
      rowNumber: row.rowNumber,
      employeeCode: row.employeeCode,
      fullName: row.fullName,
      email: row.email,
      factoryCode: row.factoryCode,
      departmentCode: row.departmentCode,
      teamCode: row.teamCode,
      hasPersonalDevice:
        row.hasPersonalDevice === null ? null : String(row.hasPersonalDevice),
    }));
    const validated = await this.validateRows(principal, parsed);
    const invalid = validated.filter(
      (row) => row.status === ImportRowStatus.INVALID,
    );
    if (invalid.length > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'The import job contains invalid rows and cannot be applied.',
        { invalidRowNumbers: invalid.map((row) => row.rowNumber) },
      );
    }

    const resolved = validated.map((row) => row.resolved!);

    const result = await this.prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      for (const row of resolved) {
        const existing = await tx.employee.findUnique({
          where: {
            organizationId_employeeCode: {
              organizationId: principal.organizationId,
              employeeCode: row.employeeCode,
            },
          },
        });
        await tx.employee.upsert({
          where: {
            organizationId_employeeCode: {
              organizationId: principal.organizationId,
              employeeCode: row.employeeCode,
            },
          },
          create: {
            organizationId: principal.organizationId,
            factoryId: row.factoryId,
            departmentId: row.departmentId,
            teamId: row.teamId,
            employeeCode: row.employeeCode,
            fullName: row.fullName,
            email: row.email,
            hasPersonalDevice: row.hasPersonalDevice,
          },
          update: {
            factoryId: row.factoryId,
            departmentId: row.departmentId,
            teamId: row.teamId,
            fullName: row.fullName,
            email: row.email,
            hasPersonalDevice: row.hasPersonalDevice,
          },
        });
        if (existing) {
          updated += 1;
        } else {
          created += 1;
        }
      }

      const committed = await tx.employeeImportJob.update({
        where: { id: job.id },
        data: { status: ImportJobStatus.COMMITTED },
      });

      await this.audit.record(tx, {
        organizationId: principal.organizationId,
        actorId: principal.userAccountId,
        action: 'employee-import.apply',
        entityType: 'EmployeeImportJob',
        entityId: job.id,
        details: {
          rowCount: resolved.length,
          created,
          updated,
        },
      });

      return { job: committed, created, updated };
    });

    return {
      jobId: result.job.id,
      status: result.job.status,
      created: result.created,
      updated: result.updated,
    };
  }

  // --- Validation ----------------------------------------------------------

  /**
   * Validate every parsed row against required fields, employeeCode format, the
   * tenant tree resolved by code, containment (team under department under
   * factory), and the principal's scope. Tenant units are cached per code so a
   * large file does not re-query the same factory/department/team.
   */
  private async validateRows(
    principal: RequestPrincipal,
    parsedRows: ParsedImportRow[],
  ): Promise<ValidatedRow[]> {
    const factoryCache = new Map<string, Factory | null>();
    const departmentCache = new Map<string, Department | null>();
    const teamCache = new Map<string, Team | null>();

    // Codes that appear on more than one row in this file. The apply loop
    // upserts by (organizationId, employeeCode), so without this check two rows
    // sharing a code would silently merge into one employee with the last row's
    // values. Flagging every offending row makes the job FAILED instead.
    const duplicateCodes = findDuplicateEmployeeCodes(parsedRows);

    const result: ValidatedRow[] = [];
    for (const row of parsedRows) {
      const errors: RowError[] = [];

      const employeeCode = requireField(
        row.employeeCode,
        'employeeCode',
        errors,
      );

      if (employeeCode && duplicateCodes.has(employeeCode)) {
        errors.push({
          field: 'employeeCode',
          message: `employeeCode ${employeeCode} appears on more than one row in this file.`,
        });
      }
      const fullName = requireField(row.fullName, 'fullName', errors);
      const factoryCode = requireField(row.factoryCode, 'factoryCode', errors);
      const departmentCode = requireField(
        row.departmentCode,
        'departmentCode',
        errors,
      );
      const teamCode = requireField(row.teamCode, 'teamCode', errors);

      if (employeeCode && !EMPLOYEE_CODE_PATTERN.test(employeeCode)) {
        errors.push({
          field: 'employeeCode',
          message:
            'employeeCode must be alphanumeric with optional dashes, up to 64 characters.',
        });
      }

      const hasPersonalDevice = parseBooleanStrict(
        row.hasPersonalDevice,
        errors,
      );

      let resolved: ResolvedRow | null = null;
      if (factoryCode && departmentCode && teamCode) {
        resolved = await this.resolvePlacementByCode(
          principal,
          { factoryCode, departmentCode, teamCode },
          errors,
          { factoryCache, departmentCache, teamCache },
        );
      }

      if (errors.length === 0 && resolved && employeeCode && fullName) {
        resolved.employeeCode = employeeCode;
        resolved.fullName = fullName;
        resolved.email = row.email;
        resolved.hasPersonalDevice = hasPersonalDevice ?? false;
      } else {
        resolved = null;
      }

      result.push({
        rowNumber: row.rowNumber,
        status:
          errors.length === 0 ? ImportRowStatus.VALID : ImportRowStatus.INVALID,
        errors,
        resolved,
      });
    }
    return result;
  }

  /**
   * Resolve the factory/department/team named by code in the principal's org
   * and verify containment: the team's department must be the named department
   * and that department's factory the named factory. Then assert the resulting
   * team scope is inside the principal's grants, so a factory-scoped user
   * cannot import into another factory. Appends structured errors instead of
   * throwing so one bad row never aborts the whole-file validation.
   */
  private async resolvePlacementByCode(
    principal: RequestPrincipal,
    codes: { factoryCode: string; departmentCode: string; teamCode: string },
    errors: RowError[],
    caches: {
      factoryCache: Map<string, Factory | null>;
      departmentCache: Map<string, Department | null>;
      teamCache: Map<string, Team | null>;
    },
  ): Promise<ResolvedRow | null> {
    const factory = await this.loadByCode(
      caches.factoryCache,
      codes.factoryCode,
      (code) =>
        this.prisma.factory.findFirst({
          where: { organizationId: principal.organizationId, code },
        }),
    );
    const department = await this.loadByCode(
      caches.departmentCache,
      codes.departmentCode,
      (code) =>
        this.prisma.department.findFirst({
          where: { organizationId: principal.organizationId, code },
        }),
    );
    const team = await this.loadByCode(
      caches.teamCache,
      codes.teamCode,
      (code) =>
        this.prisma.team.findFirst({
          where: { organizationId: principal.organizationId, code },
        }),
    );

    if (!factory) {
      errors.push({
        field: 'factoryCode',
        message: `Unknown factory code: ${codes.factoryCode}.`,
      });
    }
    if (!department) {
      errors.push({
        field: 'departmentCode',
        message: `Unknown department code: ${codes.departmentCode}.`,
      });
    }
    if (!team) {
      errors.push({
        field: 'teamCode',
        message: `Unknown team code: ${codes.teamCode}.`,
      });
    }
    if (!factory || !department || !team) {
      return null;
    }

    if (department.factoryId !== factory.id) {
      errors.push({
        field: 'departmentCode',
        message: 'department does not belong to the given factory.',
      });
    }
    if (team.departmentId !== department.id) {
      errors.push({
        field: 'teamCode',
        message: 'team does not belong to the given department.',
      });
    }
    if (
      errors.some(
        (error) =>
          error.field === 'teamCode' || error.field === 'departmentCode',
      )
    ) {
      return null;
    }

    const scope: ResourceScope = {
      organizationId: principal.organizationId,
      factoryId: team.factoryId,
      departmentId: team.departmentId,
      teamId: team.id,
    };
    try {
      await this.scopeAuthorizer.assertScope({ principal, scope });
    } catch {
      errors.push({
        field: 'teamCode',
        message: 'target team is outside your granted scope.',
      });
      return null;
    }

    return {
      employeeCode: '',
      fullName: '',
      email: null,
      factoryId: team.factoryId,
      departmentId: team.departmentId,
      teamId: team.id,
      hasPersonalDevice: false,
    };
  }

  private async loadByCode<T>(
    cache: Map<string, T | null>,
    code: string,
    load: (code: string) => Promise<T | null>,
  ): Promise<T | null> {
    if (cache.has(code)) {
      return cache.get(code)!;
    }
    const value = await load(code);
    cache.set(code, value);
    return value;
  }

  private async loadJob(
    principal: RequestPrincipal,
    jobId: string,
  ): Promise<EmployeeImportJob> {
    const job = await this.prisma.employeeImportJob.findFirst({
      where: { id: jobId, organizationId: principal.organizationId },
    });
    if (!job) {
      throw new AppError('NOT_FOUND', 'Import job not found.', { jobId });
    }
    return job;
  }
}

/**
 * Employee codes that occur on two or more rows of the same file. Blank codes
 * are ignored here; the required-field check already reports them.
 */
function findDuplicateEmployeeCodes(rows: ParsedImportRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const code = row.employeeCode;
    if (code === null || code.length === 0) {
      continue;
    }
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [code, count] of counts) {
    if (count > 1) {
      duplicates.add(code);
    }
  }
  return duplicates;
}

function requireField(
  value: string | null,
  field: string,
  errors: RowError[],
): string | null {
  if (value === null || value.length === 0) {
    errors.push({ field, message: `${field} is required.` });
    return null;
  }
  return value;
}

/** Lenient boolean read used when persisting the raw parsed value. */
function parseBoolean(value: string | null): boolean | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  return null;
}

/**
 * Strict boolean read for validation: a blank cell defaults to false, but a
 * non-boolean value is an error so garbage never silently becomes false.
 */
function parseBooleanStrict(
  value: string | null,
  errors: RowError[],
): boolean | null {
  if (value === null || value.length === 0) {
    return false;
  }
  const parsed = parseBoolean(value);
  if (parsed === null) {
    errors.push({
      field: 'hasPersonalDevice',
      message: 'hasPersonalDevice must be a boolean (true/false).',
    });
  }
  return parsed;
}

function toJobView(job: EmployeeImportJob): ImportJobView {
  return {
    id: job.id,
    organizationId: job.organizationId,
    status: job.status,
    originalFilename: job.originalFilename,
    rowCount: job.rowCount,
    errorCount: job.errorCount,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function toRowView(row: EmployeeImportRow): ImportRowView {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    employeeCode: row.employeeCode,
    fullName: row.fullName,
    email: row.email,
    factoryCode: row.factoryCode,
    departmentCode: row.departmentCode,
    teamCode: row.teamCode,
    hasPersonalDevice: row.hasPersonalDevice,
    status: row.status,
    errors: (row.errors as unknown as RowError[]) ?? [],
  };
}
