import * as ExcelJS from 'exceljs';
import { AuditService } from '../../common/audit/audit.service';
import { RequestPrincipal } from '../../common/auth/request-principal';
import { ResourceScope } from '../../common/authorization/resource-scope';
import { ScopeAuthorizer } from '../../common/authorization/scope-authorizer.service';
import { PrismaService } from '../../common/database/prisma.service';
import { Prisma } from '../../generated/prisma/client';
import { ImportJobStatus, ImportRowStatus } from '../../generated/prisma/enums';
import { EmployeeImportWorkbookService } from './employee-import-workbook.service';
import { EmployeeImportService } from './employee-import.service';
import { TEMPLATE_COLUMNS } from './employee-imports.types';

const ORG = 'org-1';
const FACTORY = 'fac-1';
const DEPARTMENT = 'dep-1';
const TEAM = 'team-1';
const OTHER_FACTORY = 'fac-2';
const OTHER_DEPARTMENT = 'dep-2';
const OTHER_TEAM = 'team-2';

interface UnitRow {
  id: string;
  organizationId: string;
  code: string;
  factoryId?: string;
  departmentId?: string;
}

interface EmployeeRow {
  id: string;
  organizationId: string;
  factoryId: string;
  departmentId: string;
  teamId: string;
  employeeCode: string;
  fullName: string;
  email: string | null;
  hasPersonalDevice: boolean;
  userAccountId: string | null;
}

interface JobRow {
  id: string;
  organizationId: string;
  status: ImportJobStatus;
  originalFilename: string;
  uploadedById: string | null;
  rowCount: number;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ImportRowRow {
  id: string;
  importJobId: string;
  rowNumber: number;
  employeeCode: string | null;
  fullName: string | null;
  email: string | null;
  factoryCode: string | null;
  departmentCode: string | null;
  teamCode: string | null;
  hasPersonalDevice: boolean | null;
  status: ImportRowStatus;
  errors: unknown;
}

interface AuditRow {
  action: string;
  entityType: string;
  entityId: string;
  actorId: string | null;
  details?: unknown;
}

const factories: UnitRow[] = [
  { id: FACTORY, organizationId: ORG, code: 'F1' },
  { id: OTHER_FACTORY, organizationId: ORG, code: 'F2' },
];
const departments: UnitRow[] = [
  { id: DEPARTMENT, organizationId: ORG, code: 'D1', factoryId: FACTORY },
  {
    id: OTHER_DEPARTMENT,
    organizationId: ORG,
    code: 'D2',
    factoryId: OTHER_FACTORY,
  },
];
const teams: UnitRow[] = [
  {
    id: TEAM,
    organizationId: ORG,
    code: 'T1',
    factoryId: FACTORY,
    departmentId: DEPARTMENT,
  },
  {
    id: OTHER_TEAM,
    organizationId: ORG,
    code: 'T2',
    factoryId: OTHER_FACTORY,
    departmentId: OTHER_DEPARTMENT,
  },
];

function createPrisma(): {
  prisma: PrismaService;
  employees: EmployeeRow[];
  jobs: JobRow[];
  importRows: ImportRowRow[];
  audit: AuditRow[];
} {
  const employees: EmployeeRow[] = [];
  const jobs: JobRow[] = [];
  const importRows: ImportRowRow[] = [];
  const audit: AuditRow[] = [];
  let seq = 0;
  const nextId = (prefix: string): string => `${prefix}-${++seq}`;

  const findByCode = (rows: UnitRow[], where: Record<string, unknown>) =>
    rows.find(
      (r) => r.organizationId === where.organizationId && r.code === where.code,
    ) ?? null;

  const findEmployee = (organizationId: string, employeeCode: string) =>
    employees.find(
      (e) =>
        e.organizationId === organizationId && e.employeeCode === employeeCode,
    );

  const prisma = {
    factory: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(findByCode(factories, where)),
    },
    department: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(findByCode(departments, where)),
    },
    team: {
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(findByCode(teams, where)),
    },
    employee: {
      findUnique: ({
        where,
      }: {
        where: {
          organizationId_employeeCode: {
            organizationId: string;
            employeeCode: string;
          };
        };
      }) => {
        const key = where.organizationId_employeeCode;
        return Promise.resolve(
          findEmployee(key.organizationId, key.employeeCode) ?? null,
        );
      },
    },
    employeeImportJob: {
      create: ({ data }: { data: Partial<JobRow> }) => {
        const now = new Date();
        const row: JobRow = {
          id: nextId('job'),
          organizationId: data.organizationId as string,
          status: data.status ?? ImportJobStatus.UPLOADED,
          originalFilename: data.originalFilename as string,
          uploadedById: data.uploadedById ?? null,
          rowCount: data.rowCount ?? 0,
          errorCount: data.errorCount ?? 0,
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(row);
        return Promise.resolve(row);
      },
      findFirst: ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(
          jobs.find(
            (j) =>
              j.id === where.id && j.organizationId === where.organizationId,
          ) ?? null,
        ),
    },
    employeeImportRow: {
      findMany: ({ where }: { where: { importJobId: string } }) =>
        Promise.resolve(
          importRows
            .filter((r) => r.importJobId === where.importJobId)
            .sort((a, b) => a.rowNumber - b.rowNumber),
        ),
    },
    $transaction: async <T>(
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ): Promise<T> => {
      const stagedEmployees: EmployeeRow[] = [];
      const stagedJobs: JobRow[] = [];
      const stagedRows: ImportRowRow[] = [];
      const stagedAudit: AuditRow[] = [];
      const jobUpdates: Array<{ id: string; status: ImportJobStatus }> = [];

      const tx = {
        employeeImportJob: {
          create: ({ data }: { data: Partial<JobRow> }) => {
            const now = new Date();
            const row: JobRow = {
              id: nextId('job'),
              organizationId: data.organizationId as string,
              status: data.status ?? ImportJobStatus.UPLOADED,
              originalFilename: data.originalFilename as string,
              uploadedById: data.uploadedById ?? null,
              rowCount: data.rowCount ?? 0,
              errorCount: data.errorCount ?? 0,
              createdAt: now,
              updatedAt: now,
            };
            stagedJobs.push(row);
            return Promise.resolve(row);
          },
          update: ({
            where,
            data,
          }: {
            where: { id: string };
            data: { status: ImportJobStatus };
          }) => {
            const row =
              jobs.find((j) => j.id === where.id) ??
              stagedJobs.find((j) => j.id === where.id);
            if (!row) throw new Error('job not found');
            jobUpdates.push({ id: where.id, status: data.status });
            return Promise.resolve({ ...row, status: data.status });
          },
        },
        employeeImportRow: {
          createMany: ({ data }: { data: Partial<ImportRowRow>[] }) => {
            for (const d of data) {
              stagedRows.push({
                id: nextId('row'),
                importJobId: d.importJobId as string,
                rowNumber: d.rowNumber as number,
                employeeCode: d.employeeCode ?? null,
                fullName: d.fullName ?? null,
                email: d.email ?? null,
                factoryCode: d.factoryCode ?? null,
                departmentCode: d.departmentCode ?? null,
                teamCode: d.teamCode ?? null,
                hasPersonalDevice: d.hasPersonalDevice ?? null,
                status: d.status ?? ImportRowStatus.PENDING,
                errors:
                  d.errors === Prisma.JsonNull ? null : (d.errors ?? null),
              });
            }
            return Promise.resolve({ count: data.length });
          },
        },
        employee: {
          findUnique: ({
            where,
          }: {
            where: {
              organizationId_employeeCode: {
                organizationId: string;
                employeeCode: string;
              };
            };
          }) => {
            const key = where.organizationId_employeeCode;
            const live = findEmployee(key.organizationId, key.employeeCode);
            const staged = stagedEmployees.find(
              (e) =>
                e.organizationId === key.organizationId &&
                e.employeeCode === key.employeeCode,
            );
            return Promise.resolve(live ?? staged ?? null);
          },
          upsert: ({
            where,
            create,
            update,
          }: {
            where: {
              organizationId_employeeCode: {
                organizationId: string;
                employeeCode: string;
              };
            };
            create: Omit<EmployeeRow, 'id' | 'userAccountId'>;
            update: Partial<EmployeeRow>;
          }) => {
            const key = where.organizationId_employeeCode;
            const existing = findEmployee(key.organizationId, key.employeeCode);
            if (existing) {
              Object.assign(existing, update);
              return Promise.resolve(existing);
            }
            const row: EmployeeRow = {
              id: nextId('emp'),
              userAccountId: null,
              ...create,
            };
            stagedEmployees.push(row);
            return Promise.resolve(row);
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
      employees.push(...stagedEmployees);
      jobs.push(...stagedJobs);
      importRows.push(...stagedRows);
      audit.push(...stagedAudit);
      for (const update of jobUpdates) {
        const row = jobs.find((j) => j.id === update.id);
        if (row) row.status = update.status;
      }
      return result;
    },
  } as unknown as PrismaService;

  return { prisma, employees, jobs, importRows, audit };
}

/**
 * ScopeAuthorizer stub. By default every scope is allowed; pass an allowed
 * factory id to simulate a factory-scoped principal that may import only into
 * that factory.
 */
function authorizer(allowedFactoryId?: string): ScopeAuthorizer {
  return {
    assertPermission: () => Promise.resolve(),
    assertScope: ({ scope }: { scope: ResourceScope }) => {
      if (!allowedFactoryId || scope.factoryId === allowedFactoryId) {
        return Promise.resolve();
      }
      return Promise.reject(new Error('out of scope'));
    },
    scopeFilter: () => Promise.resolve({ organizationId: ORG }),
  } as unknown as ScopeAuthorizer;
}

const principal: RequestPrincipal = {
  userAccountId: 'actor-1',
  organizationId: ORG,
  tokenId: 'tok-1',
};

async function makeWorkbook(
  rows: (string | null)[][],
): Promise<{ originalname: string; buffer: Buffer }> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('employees');
  sheet.addRow([...TEMPLATE_COLUMNS]);
  for (const row of rows) {
    sheet.addRow(row);
  }
  const out = await workbook.xlsx.writeBuffer();
  return { originalname: 'import.xlsx', buffer: Buffer.from(out) };
}

function makeService(allowedFactoryId?: string) {
  const db = createPrisma();
  const service = new EmployeeImportService(
    db.prisma,
    authorizer(allowedFactoryId),
    new AuditService(db.prisma),
    new EmployeeImportWorkbookService(),
  );
  return { service, ...db };
}

describe('EmployeeImportService', () => {
  it('marks a containment-violating row INVALID and the job FAILED', async () => {
    const { service, importRows } = makeService();
    // Team T1 is under department D1/factory F1; naming D2 breaks containment.
    const file = await makeWorkbook([
      ['E-1', 'Alice', '', 'F1', 'D2', 'T1', 'true'],
    ]);

    const job = await service.uploadAndValidate(principal, file);
    expect(job.status).toBe(ImportJobStatus.FAILED);
    expect(job.errorCount).toBe(1);
    const row = importRows.find((r) => r.rowNumber === 1)!;
    expect(row.status).toBe(ImportRowStatus.INVALID);
  });

  it('flags rows sharing an employeeCode within one file and fails the job', async () => {
    const { service, importRows } = makeService();
    // Two rows share E-DUP; without the intra-file check the apply loop would
    // upsert both and silently keep only the last. Both rows must be INVALID.
    const file = await makeWorkbook([
      ['E-DUP', 'Alice', '', 'F1', 'D1', 'T1', 'true'],
      ['E-DUP', 'Bob', '', 'F1', 'D1', 'T1', 'false'],
      ['E-OK', 'Carol', '', 'F1', 'D1', 'T1', 'true'],
    ]);

    const job = await service.uploadAndValidate(principal, file);
    expect(job.status).toBe(ImportJobStatus.FAILED);
    expect(job.errorCount).toBe(2);

    const dupRows = importRows.filter((r) => r.employeeCode === 'E-DUP');
    expect(dupRows).toHaveLength(2);
    for (const row of dupRows) {
      expect(row.status).toBe(ImportRowStatus.INVALID);
      const errors = row.errors as Array<{ field: string; message: string }>;
      expect(
        errors.some(
          (e) =>
            e.field === 'employeeCode' && /more than one row/.test(e.message),
        ),
      ).toBe(true);
    }
    // The unique, valid row stays VALID.
    const okRow = importRows.find((r) => r.employeeCode === 'E-OK')!;
    expect(okRow.status).toBe(ImportRowStatus.VALID);
  });

  it('does not write any employee when applying a job with an invalid row', async () => {
    const { service, employees, jobs } = makeService();
    const file = await makeWorkbook([
      ['E-1', 'Alice', '', 'F1', 'D1', 'T1', 'true'],
      // Second row references an unknown team: whole file is invalid.
      ['E-2', 'Bob', '', 'F1', 'D1', 'T-UNKNOWN', 'false'],
    ]);
    const job = await service.uploadAndValidate(principal, file);
    expect(job.status).toBe(ImportJobStatus.FAILED);

    await expect(service.apply(principal, job.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    // Atomic: nothing partial. No employee rows at all.
    expect(employees).toHaveLength(0);
    expect(jobs.find((j) => j.id === job.id)!.status).toBe(
      ImportJobStatus.FAILED,
    );
  });

  it('creates employees on a valid apply and audits the import', async () => {
    const { service, employees, audit } = makeService();
    const file = await makeWorkbook([
      ['E-1', 'Alice', 'alice@example.com', 'F1', 'D1', 'T1', 'true'],
      ['E-2', 'Bob', '', 'F1', 'D1', 'T1', 'false'],
    ]);
    const job = await service.uploadAndValidate(principal, file);
    expect(job.status).toBe(ImportJobStatus.VALIDATED);

    const result = await service.apply(principal, job.id);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.status).toBe(ImportJobStatus.COMMITTED);
    expect(employees).toHaveLength(2);
    // Email is kept verbatim and never derived from the name.
    expect(employees.find((e) => e.employeeCode === 'E-1')!.email).toBe(
      'alice@example.com',
    );
    expect(employees.find((e) => e.employeeCode === 'E-2')!.email).toBeNull();

    const entry = audit.find((a) => a.action === 'employee-import.apply');
    expect(entry).toBeDefined();
    expect(entry).toMatchObject({
      entityType: 'EmployeeImportJob',
      entityId: job.id,
      actorId: 'actor-1',
    });
    expect(entry!.details).toMatchObject({ created: 2, updated: 0 });
  });

  it('re-applying the same file updates in place and creates no duplicates', async () => {
    const { service, employees } = makeService();
    const file = await makeWorkbook([
      ['E-1', 'Alice', 'alice@example.com', 'F1', 'D1', 'T1', 'true'],
    ]);

    const firstJob = await service.uploadAndValidate(principal, file);
    const first = await service.apply(principal, firstJob.id);
    expect(first.created).toBe(1);
    expect(employees).toHaveLength(1);

    // Upload and apply the same file again as a fresh job.
    const secondJob = await service.uploadAndValidate(principal, file);
    const second = await service.apply(principal, secondJob.id);
    expect(second.created).toBe(0);
    expect(second.updated).toBe(1);
    // Idempotent: still a single employee row.
    expect(employees).toHaveLength(1);
  });

  it('marks a row INVALID when a factory-scoped principal imports into another factory', async () => {
    // Principal may only act in FACTORY (fac-1); target team T2 is in fac-2.
    const { service, importRows } = makeService(FACTORY);
    const file = await makeWorkbook([
      ['E-9', 'Outsider', '', 'F2', 'D2', 'T2', 'true'],
    ]);

    const job = await service.uploadAndValidate(principal, file);
    expect(job.status).toBe(ImportJobStatus.FAILED);
    const row = importRows.find((r) => r.rowNumber === 1)!;
    expect(row.status).toBe(ImportRowStatus.INVALID);
    const errors = row.errors as Array<{ field: string; message: string }>;
    expect(errors.some((e) => /scope/i.test(e.message))).toBe(true);
  });

  it('rejects apply when the job is not in a VALIDATED state', async () => {
    const { service } = makeService();
    const file = await makeWorkbook([
      ['E-1', 'Alice', '', 'F1', 'D1', 'T-UNKNOWN', 'true'],
    ]);
    const job = await service.uploadAndValidate(principal, file);
    expect(job.status).toBe(ImportJobStatus.FAILED);

    await expect(service.apply(principal, job.id)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
