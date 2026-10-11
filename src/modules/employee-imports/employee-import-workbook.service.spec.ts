import * as ExcelJS from 'exceljs';
import { AppError } from '../../common/errors/app-error';
import { EmployeeImportWorkbookService } from './employee-import-workbook.service';
import { TEMPLATE_COLUMNS } from './employee-imports.types';

async function workbookWithRows(
  header: string[],
  rows: (string | number | boolean | null)[][],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('employees');
  sheet.addRow(header);
  for (const row of rows) {
    sheet.addRow(row);
  }
  const out = await workbook.xlsx.writeBuffer();
  return Buffer.from(out);
}

describe('EmployeeImportWorkbookService', () => {
  const service = new EmployeeImportWorkbookService();

  it('generates a template whose header is the authoritative column set', async () => {
    const buffer = await service.buildTemplate();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
    const header = workbook.worksheets[0].getRow(1).values as (
      string | undefined
    )[];
    // ExcelJS row values are 1-based with a leading undefined slot.
    expect(header.slice(1)).toEqual([...TEMPLATE_COLUMNS]);
  });

  it('round-trips: the generated template parses back into its data rows', async () => {
    const buffer = await workbookWithRows(
      [...TEMPLATE_COLUMNS],
      [
        ['E-1', 'Alice', 'alice@example.com', 'F1', 'D1', 'T1', 'true'],
        ['E-2', 'Bob', '', 'F1', 'D1', 'T1', 'false'],
      ],
    );

    const rows = await service.parse(buffer);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      rowNumber: 1,
      employeeCode: 'E-1',
      fullName: 'Alice',
      email: 'alice@example.com',
      teamCode: 'T1',
      hasPersonalDevice: 'true',
    });
    // A blank optional email cell becomes null, not an empty string.
    expect(rows[1].email).toBeNull();
  });

  it('skips entirely blank rows so trailing blanks are not phantom rows', async () => {
    const buffer = await workbookWithRows(
      [...TEMPLATE_COLUMNS],
      [
        ['E-1', 'Alice', '', 'F1', 'D1', 'T1', 'true'],
        [null, null, null, null, null, null, null],
      ],
    );
    const rows = await service.parse(buffer);
    expect(rows).toHaveLength(1);
  });

  it('rejects a workbook missing a required header column', async () => {
    const buffer = await workbookWithRows(
      ['employeeCode', 'fullName'],
      [['E-1', 'Alice']],
    );
    await expect(service.parse(buffer)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  it('rejects a non-workbook buffer', async () => {
    await expect(
      service.parse(Buffer.from('not a spreadsheet')),
    ).rejects.toBeInstanceOf(AppError);
  });
});
