/**
 * Flatten the client's customer workbook into the rows the importer expects.
 *
 *   cd frontend && SHEET_PATH=<xlsx> OUT_PATH=<json> \
 *     node ../backend/scripts/sheet-to-json.mjs
 *
 * Run from the frontend, which is where SheetJS is a dependency; the importer
 * runs from the backend, which is where Prisma is. One step per package beats
 * teaching either to reach into the other's node_modules.
 *
 * Deliberately dumb: it renames columns and nothing else. Phone normalisation,
 * branch resolution, de-duplication and the decision about what already exists
 * all belong to the importer, so there is exactly one place where those rules
 * live and one place to correct them.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import XLSX from 'xlsx';

const SHEET = process.env.SHEET_PATH;
const OUT = process.env.OUT_PATH;
if (!SHEET || !OUT) throw new Error('SHEET_PATH and OUT_PATH are required');

const wb = XLSX.read(readFileSync(SHEET), { type: 'buffer', cellDates: true });
const sheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: null });

const iso = (v) => (v instanceof Date ? v.toISOString() : null);

const rows = [
  ...sheet('From Master sheet').map((r) => ({
    sheet: 'master',
    name: String(r['Customer Name'] ?? '').trim(),
    rawPhone: r['Contact No (Lead)'],
    storeLabel: String(r['Store Name'] ?? '').trim() || null,
    sourceLabel: String(r['Lead Source 1'] ?? '').trim() || null,
    city: null,
    at: iso(r['Date']),
  })),
  ...sheet('From website').map((r) => ({
    sheet: 'website',
    name: [r['First Name'], r['Last Name']].filter(Boolean).join(' ').trim(),
    rawPhone: r['Phone'],
    storeLabel: null,
    sourceLabel: 'Website',
    city: r['City'] ? String(r['City']).trim() : null,
    at: iso(r['Registered On']),
  })),
];

writeFileSync(OUT, JSON.stringify(rows, null, 1));
console.log(`${rows.length} rows written to ${OUT}`);
