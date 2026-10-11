/**
 * Generate the sample employee-import workbook used in the local demo.
 *
 * The rows match the seeded PNJP tenant codes (factory `PNJP-F1`, department
 * `SAN-XUAT`, teams `CAT`, `LAP-RAP`, `QC`), so a reviewer can upload the file
 * and see every row validate, then apply it to create the employees. The
 * header order mirrors `TEMPLATE_COLUMNS` in the import module, which is the
 * single source of truth for the template layout.
 *
 * All data is fictional. Re-run after changing the seed codes:
 *   npx tsx prisma/samples/build-sample-import.ts
 */
import * as path from 'node:path';
import * as ExcelJS from 'exceljs';

const HEADER = [
  'employeeCode',
  'fullName',
  'email',
  'factoryCode',
  'departmentCode',
  'teamCode',
  'hasPersonalDevice',
] as const;

// Each row sits in the San xuat department, the only department the seeded
// teams belong to, so the team/department containment check passes.
const ROWS: ReadonlyArray<ReadonlyArray<string>> = [
  ['PNJP-1001', 'Ngo Van Khoa', 'khoa.nv11@pnj.com.vn', 'PNJP-F1', 'SAN-XUAT', 'CAT', 'true'],
  ['PNJP-1002', 'Ly Thi Thu', '', 'PNJP-F1', 'SAN-XUAT', 'LAP-RAP', 'false'],
  ['PNJP-1003', 'Tran Van Binh', 'binh.tv13@pnj.com.vn', 'PNJP-F1', 'SAN-XUAT', 'QC', 'true'],
];

async function main(): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('employees');
  sheet.addRow([...HEADER]);
  sheet.getRow(1).font = { bold: true };
  for (const row of ROWS) {
    sheet.addRow([...row]);
  }
  const outPath = path.join(__dirname, 'employee-import-sample.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log(`Wrote ${outPath} with ${ROWS.length} data rows.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
