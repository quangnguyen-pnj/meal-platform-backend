import { ImportJobStatus, ImportRowStatus } from '../../generated/prisma/enums';

/**
 * The authoritative column order of the employee import template. The template
 * generator writes these as the header row and the parser reads them back by
 * position, so both sides stay in sync from one definition.
 */
export const TEMPLATE_COLUMNS = [
  'employeeCode',
  'fullName',
  'email',
  'factoryCode',
  'departmentCode',
  'teamCode',
  'hasPersonalDevice',
] as const;

export type TemplateColumn = (typeof TEMPLATE_COLUMNS)[number];

/**
 * One spreadsheet row as parsed from the workbook, before validation. All
 * values are kept as strings exactly as the sheet carried them (email is never
 * derived from the name); `hasPersonalDevice` is interpreted later. `rowNumber`
 * is the 1-based data row (header excluded) used for the preview and the
 * `[importJobId, rowNumber]` unique key.
 */
export interface ParsedImportRow {
  rowNumber: number;
  employeeCode: string | null;
  fullName: string | null;
  email: string | null;
  factoryCode: string | null;
  departmentCode: string | null;
  teamCode: string | null;
  hasPersonalDevice: string | null;
}

/** A single structured validation problem on a row. */
export interface RowError {
  field: string;
  message: string;
}

/**
 * The outcome of validating one parsed row: its status, the structured errors
 * (empty when valid), the resolved team id and normalized values the apply
 * step reuses so it never re-resolves the tenant tree.
 */
export interface ValidatedRow {
  rowNumber: number;
  status: ImportRowStatus;
  errors: RowError[];
  resolved: ResolvedRow | null;
}

/** The normalized, tenant-resolved shape an apply uses to upsert an employee. */
export interface ResolvedRow {
  employeeCode: string;
  fullName: string;
  email: string | null;
  factoryId: string;
  departmentId: string;
  teamId: string;
  hasPersonalDevice: boolean;
}

/** Preview/response view of an import job. */
export interface ImportJobView {
  id: string;
  organizationId: string;
  status: ImportJobStatus;
  originalFilename: string;
  rowCount: number;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Preview/response view of a single parsed row with its validation outcome. */
export interface ImportRowView {
  id: string;
  rowNumber: number;
  employeeCode: string | null;
  fullName: string | null;
  email: string | null;
  factoryCode: string | null;
  departmentCode: string | null;
  teamCode: string | null;
  hasPersonalDevice: boolean | null;
  status: ImportRowStatus;
  errors: RowError[];
}

/** Result returned by an apply: counts of what the upsert created vs updated. */
export interface ImportApplyResult {
  jobId: string;
  status: ImportJobStatus;
  created: number;
  updated: number;
}
