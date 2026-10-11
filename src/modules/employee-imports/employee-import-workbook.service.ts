import { Injectable } from '@nestjs/common';
import * as ExcelJS from 'exceljs';
import { AppError } from '../../common/errors/app-error';
import {
  ParsedImportRow,
  TEMPLATE_COLUMNS,
  TemplateColumn,
} from './employee-imports.types';

/**
 * Owns the `.xlsx` format: it both generates the download template and parses
 * an uploaded workbook into plain rows. Keeping both directions here means the
 * column set in `TEMPLATE_COLUMNS` is the single source of truth, so a template
 * download and a later upload always agree on the layout.
 *
 * The parser is deliberately dumb about meaning: it reads cells into strings by
 * header position and leaves all validation to the import service. It only
 * rejects a workbook that is not a readable spreadsheet or lacks the expected
 * header row, which are format problems, not row-level data problems.
 */
@Injectable()
export class EmployeeImportWorkbookService {
  /** Build the empty template workbook with the header row only. */
  async buildTemplate(): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('employees');
    sheet.addRow([...TEMPLATE_COLUMNS]);
    sheet.getRow(1).font = { bold: true };
    const out = await workbook.xlsx.writeBuffer();
    return Buffer.from(out);
  }

  /**
   * Parse an uploaded workbook's first sheet into rows. Throws a
   * VALIDATION_ERROR for a non-workbook or a missing/incorrect header; returns
   * one `ParsedImportRow` per data row, numbered from 1, skipping rows that are
   * entirely empty so trailing blank lines do not become phantom rows.
   */
  async parse(buffer: Buffer): Promise<ParsedImportRow[]> {
    const workbook = new ExcelJS.Workbook();
    try {
      // ExcelJS's typings predate the ArrayBufferLike generic on Node's
      // Buffer; the value is a real Buffer, so the cast is only to satisfy
      // the older signature.
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    } catch {
      throw new AppError(
        'VALIDATION_ERROR',
        'The uploaded file is not a readable .xlsx workbook.',
      );
    }

    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new AppError('VALIDATION_ERROR', 'The workbook has no sheets.');
    }

    const columnIndex = this.resolveHeader(sheet);

    const rows: ParsedImportRow[] = [];
    let dataRowNumber = 0;
    // Row 1 is the header; data starts at sheet row 2.
    for (let r = 2; r <= sheet.rowCount; r++) {
      const sheetRow = sheet.getRow(r);
      const cell = (column: TemplateColumn): string | null =>
        readCell(sheetRow, columnIndex[column]);

      const parsed: ParsedImportRow = {
        rowNumber: 0,
        employeeCode: cell('employeeCode'),
        fullName: cell('fullName'),
        email: cell('email'),
        factoryCode: cell('factoryCode'),
        departmentCode: cell('departmentCode'),
        teamCode: cell('teamCode'),
        hasPersonalDevice: cell('hasPersonalDevice'),
      };

      if (isEmptyRow(parsed)) {
        continue;
      }
      dataRowNumber += 1;
      parsed.rowNumber = dataRowNumber;
      rows.push(parsed);
    }

    if (rows.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'The workbook has no data rows.');
    }
    return rows;
  }

  /**
   * Map each expected template column to its 1-based cell index from the header
   * row. Every template column must be present; a missing one is a format
   * error that stops the whole upload.
   */
  private resolveHeader(
    sheet: ExcelJS.Worksheet,
  ): Record<TemplateColumn, number> {
    const headerRow = sheet.getRow(1);
    const headerByName = new Map<string, number>();
    headerRow.eachCell((cell, colNumber) => {
      const name = cellToString(cell.value)?.trim();
      if (name) {
        headerByName.set(name, colNumber);
      }
    });

    const index = {} as Record<TemplateColumn, number>;
    const missing: string[] = [];
    for (const column of TEMPLATE_COLUMNS) {
      const colNumber = headerByName.get(column);
      if (colNumber === undefined) {
        missing.push(column);
      } else {
        index[column] = colNumber;
      }
    }
    if (missing.length > 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        'The workbook header is missing required columns.',
        { missing },
      );
    }
    return index;
  }
}

function readCell(row: ExcelJS.Row, colNumber: number): string | null {
  const value = cellToString(row.getCell(colNumber).value);
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Flatten an ExcelJS cell value to a string. Handles the shapes ExcelJS uses:
 * primitives, rich text, hyperlinks, and formula results. Returns null for an
 * empty cell so callers can treat blanks uniformly.
 */
function cellToString(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') {
      return value.text;
    }
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('');
    }
    if ('result' in value) {
      return cellToString(value.result as ExcelJS.CellValue);
    }
    if ('hyperlink' in value && typeof value.hyperlink === 'string') {
      return value.hyperlink;
    }
  }
  return null;
}

function isEmptyRow(row: ParsedImportRow): boolean {
  return (
    row.employeeCode === null &&
    row.fullName === null &&
    row.email === null &&
    row.factoryCode === null &&
    row.departmentCode === null &&
    row.teamCode === null &&
    row.hasPersonalDevice === null
  );
}
