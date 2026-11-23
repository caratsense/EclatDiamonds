import { BadRequestException } from '@nestjs/common';

import {
  DEFAULT_LEAD_FORMAT,
  DEFAULT_NPS_FORMAT,
  EXPORT_FORMATS_SETTINGS_KEY,
  LEAD_EXPORT_FIELDS,
  NPS_EXPORT_FIELDS,
  defaultExportFormat,
  readExportFormat,
  sanitiseExportFormat,
  withExportFormat,
} from './export-formats';

/**
 * The client's own sheets, and the rules that keep a chooser from offering a
 * column the export cannot fill.
 *
 * Every assertion here has a failure mode that reaches a person as a wrong
 * spreadsheet rather than as an error: a heading with nothing underneath it, a
 * renamed column she has to rename back, or a tenant's whole export failing
 * because one field was retired.
 */
describe('the default formats are the client’s own sheets', () => {
  it('is her twenty Master Leads columns, in her order', () => {
    expect(DEFAULT_LEAD_FORMAT.map((c) => c.header)).toEqual([
      'No.',
      'Date',
      'Customer Name',
      'Contact No (Lead)',
      'Location (City)',
      'Customer Type',
      'Product Catergory',
      'Product Interested in',
      'Store Visited',
      'Status (Purchase / Non purchase)',
      'Value of Purchase Made',
      'Lead Source 1',
      'Lead Source 2',
      'Store Name',
      'Salesperson Name',
      'Sales Rs',
      'Sale Date',
      'Transaction channel (Website, Store)',
      'Remarks',
      'Purchase Ocassion',
    ]);
  });

  it('keeps her spellings', () => {
    /*
     * "Catergory" and "Ocassion" are hers. Correcting them is not a tidy-up: a
     * heading that does not match her workbook is a heading somebody renames by
     * hand on every single download, which is the work this feature removes.
     */
    const headers = DEFAULT_LEAD_FORMAT.map((c) => c.header);
    expect(headers).toContain('Product Catergory');
    expect(headers).toContain('Purchase Ocassion');
    expect(headers).not.toContain('Product Category');
    expect(headers).not.toContain('Purchase Occasion');
  });

  it('keeps the NPS headings as the form’s whole questions', () => {
    // Her NPS tab is the Google Form's output, so the heading IS the question.
    // Shortening them would stop our file lining up with hers.
    expect(DEFAULT_NPS_FORMAT[0].header).toBe('Timestamp');
    expect(DEFAULT_NPS_FORMAT.map((c) => c.header)).toContain(
      'How likely are you to recommend Nibhana to your friends and family?',
    );
  });

  it('offers no default column the export cannot fill', () => {
    // The bug this prevents only shows up in the downloaded file.
    const leadFields = new Set(LEAD_EXPORT_FIELDS.map((f) => f.field));
    for (const c of DEFAULT_LEAD_FORMAT) expect(leadFields.has(c.field)).toBe(true);
    const npsFields = new Set(NPS_EXPORT_FIELDS.map((f) => f.field));
    for (const c of DEFAULT_NPS_FORMAT) expect(npsFields.has(c.field)).toBe(true);
  });

  it('names every column exactly once in each default', () => {
    for (const format of [DEFAULT_LEAD_FORMAT, DEFAULT_NPS_FORMAT]) {
      expect(new Set(format.map((c) => c.field)).size).toBe(format.length);
    }
  });
});

describe('readExportFormat', () => {
  const stored = (columns: unknown) => ({
    [EXPORT_FORMATS_SETTINGS_KEY]: { leads: columns },
  });

  it('gives a tenant who has configured nothing the default', () => {
    expect(readExportFormat(null, 'leads')).toBe(defaultExportFormat('leads'));
    expect(readExportFormat({}, 'leads')).toBe(defaultExportFormat('leads'));
    expect(readExportFormat({ exportFormats: {} }, 'nps')).toBe(defaultExportFormat('nps'));
  });

  it('keeps the tenant’s order and their headings', () => {
    const format = readExportFormat(
      stored([
        { field: 'phone', header: 'Mobile' },
        { field: 'customerName', header: 'Client' },
      ]),
      'leads',
    );
    expect(format).toEqual([
      { field: 'phone', header: 'Mobile' },
      { field: 'customerName', header: 'Client' },
    ]);
  });

  it('DROPS a retired field rather than throwing', () => {
    /*
     * Tolerant on read, strict on write. A field removed in a later release must
     * make one column disappear, not make a tenant's every export 500 — they
     * cannot fix a stored format they can no longer download a file to inspect.
     */
    const format = readExportFormat(
      stored([
        { field: 'customerName', header: 'Client' },
        { field: 'a_field_we_removed', header: 'Gone' },
      ]),
      'leads',
    );
    expect(format).toEqual([{ field: 'customerName', header: 'Client' }]);
  });

  it('falls back to the default when dropping leaves nothing', () => {
    // A workbook with no columns is not a smaller workbook.
    expect(readExportFormat(stored([{ field: 'nope', header: 'x' }]), 'leads')).toBe(
      defaultExportFormat('leads'),
    );
  });

  it('ignores a duplicate field instead of writing the column twice', () => {
    const format = readExportFormat(
      stored([
        { field: 'phone', header: 'Mobile' },
        { field: 'phone', header: 'Phone again' },
      ]),
      'leads',
    );
    expect(format).toHaveLength(1);
  });

  it('uses our own name when a stored heading is blank', () => {
    const format = readExportFormat(stored([{ field: 'phone', header: '   ' }]), 'leads');
    expect(format[0].header).toBe('Phone');
  });
});

describe('sanitiseExportFormat', () => {
  it('refuses a column the export cannot fill, naming it', () => {
    // Refuses rather than repairs: a silently dropped column is discovered in
    // the next download, by which time nobody knows what they changed.
    expect(() => sanitiseExportFormat('leads', [{ field: 'invented', header: 'X' }])).toThrow(
      BadRequestException,
    );
  });

  it('refuses an empty sheet', () => {
    expect(() => sanitiseExportFormat('leads', [])).toThrow(BadRequestException);
  });

  it('refuses the same column twice', () => {
    expect(() =>
      sanitiseExportFormat('leads', [
        { field: 'phone', header: 'A' },
        { field: 'phone', header: 'B' },
      ]),
    ).toThrow(BadRequestException);
  });

  it('accepts the shipped default unchanged', () => {
    // A limit or a check that rejects our own default is a broken check.
    expect(sanitiseExportFormat('leads', [...DEFAULT_LEAD_FORMAT])).toHaveLength(
      DEFAULT_LEAD_FORMAT.length,
    );
    expect(sanitiseExportFormat('nps', [...DEFAULT_NPS_FORMAT])).toHaveLength(
      DEFAULT_NPS_FORMAT.length,
    );
  });

  it('takes a blank heading as "use our name for it"', () => {
    expect(sanitiseExportFormat('leads', [{ field: 'phone', header: '' }])[0].header).toBe(
      'Phone',
    );
  });

  it('refuses a column the OTHER export can fill', () => {
    // `concerns` is an NPS column. Offering it on the leads sheet would produce
    // a heading the lead builder has nothing to put under.
    expect(() => sanitiseExportFormat('leads', [{ field: 'concerns', header: 'X' }])).toThrow(
      BadRequestException,
    );
  });
});

describe('withExportFormat', () => {
  it('leaves every other settings key alone', () => {
    /*
     * `settings` is one JSONB column shared by branding, the assistant switches,
     * the qualification policy and ad-set routing. Writing a whole new object
     * here is what `updateOrgSettings`' row lock exists to make safe — but only
     * if what we hand it still carries the neighbours.
     */
    const next = withExportFormat({ branding: { logo: 'x' } }, 'leads', [
      { field: 'phone', header: 'Mobile' },
    ]);
    expect(next.branding).toEqual({ logo: 'x' });
  });

  it('leaves the other export’s format alone', () => {
    const next = withExportFormat(
      { [EXPORT_FORMATS_SETTINGS_KEY]: { nps: [{ field: 'concerns', header: 'Notes' }] } },
      'leads',
      [{ field: 'phone', header: 'Mobile' }],
    );
    expect((next[EXPORT_FORMATS_SETTINGS_KEY] as Record<string, unknown>).nps).toEqual([
      { field: 'concerns', header: 'Notes' },
    ]);
  });

  it('removes the key for a reset, rather than storing an empty list', () => {
    // An absent key reads as the default. An empty array would need
    // `readExportFormat` to guess whether it meant "default" or "no columns".
    const next = withExportFormat(
      { [EXPORT_FORMATS_SETTINGS_KEY]: { leads: [{ field: 'phone', header: 'M' }] } },
      'leads',
      null,
    );
    expect(next[EXPORT_FORMATS_SETTINGS_KEY]).toEqual({});
    expect(readExportFormat(next, 'leads')).toBe(defaultExportFormat('leads'));
  });
});
