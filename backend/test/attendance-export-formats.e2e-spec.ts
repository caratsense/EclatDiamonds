import { Workbook } from 'exceljs';
import { PDFDocument } from 'pdf-lib';

import {
  type Report,
  toCsv,
  toPdf,
  toXlsx,
} from '../src/hrms/attendance-analytics.service';

const report: Report = {
  kind: 'monthly-summary',
  period: { from: '2026-09-01', to: '2026-09-30' },
  columns: [
    { key: 'employeeCode', label: 'Code' },
    { key: 'name', label: 'Name' },
    { key: 'present', label: 'Present' },
    { key: 'payableDays', label: 'Payable days' },
  ],
  rows: [
    { employeeCode: 'ED001', name: 'Test Person', present: 24, payableDays: 26 },
    { employeeCode: '=2+2', name: 'Formula safety', present: 1, payableDays: 1 },
  ],
  totals: { employeeCode: '', name: 'Total', present: 25, payableDays: 27 },
};

describe('attendance report export formats', () => {
  it('keeps the existing UTF-8, formula-safe CSV contract', () => {
    const csv = toCsv(report);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('Code,Name,Present,Payable days');
    expect(csv).toContain("'=2+2,Formula safety,1,1");
  });

  it('builds a real XLSX workbook with typed values and totals', async () => {
    const bytes = await toXlsx(report);
    expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');

    const workbook = new Workbook();
    const workbookBytes = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    await workbook.xlsx.load(workbookBytes);
    const sheet = workbook.getWorksheet('Attendance');
    expect(sheet).toBeTruthy();
    expect(sheet!.getCell('A1').value).toBe('Code');
    expect(sheet!.getCell('B1').value).toBe('Name');
    expect(sheet!.getCell('C1').value).toBe('Present');
    expect(sheet!.getCell('D1').value).toBe('Payable days');
    expect(sheet!.getCell('A2').value).toBe('ED001');
    expect(sheet!.getCell('C2').value).toBe(24);
    expect(sheet!.getCell('B4').value).toBe('Total');
  });

  it('builds a printable PDF with a truthful title and at least one page', async () => {
    const bytes = await toPdf(report);
    expect(bytes.subarray(0, 5).toString('ascii')).toBe('%PDF-');

    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThan(0);
    expect(pdf.getTitle()).toBe(
      'Attendance monthly-summary: 2026-09-01 to 2026-09-30',
    );
  });

  it('flows a long report onto more than one PDF page', async () => {
    const long: Report = {
      ...report,
      rows: Array.from({ length: 300 }, (_, i) => ({
        employeeCode: `ED${String(i).padStart(3, '0')}`,
        name: `Test Person ${i}`,
        present: 20,
        payableDays: 26,
      })),
    };
    const pdf = await PDFDocument.load(await toPdf(long));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
    expect(pdf.getTitle()).toBe('Attendance monthly-summary: 2026-09-01 to 2026-09-30');
  });
});
