import { AuditService } from '../src/common/audit.service';
import { AuthUser } from '../src/common/auth-user';
import { StoreScopeService } from '../src/common/store-scope.service';
import {
  ImportService,
  MAX_IMPORT_MAPPING_NAME_CHARACTERS,
} from '../src/integration/import/import.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { ALLOW_MACHINE_KEY } from '../src/auth/machine.decorator';
import {
  IMPORT_UPLOAD_OPTIONS,
  ImportController,
  parseMappings,
} from '../src/integration/import/import.controller';
import { createHash } from 'node:crypto';
import { IMPORTERS } from '../src/integration/import/entity-importers';
import { mapCustomerRow } from '../src/integration/import/customer-mapper';
import { Workbook } from 'exceljs';
import JSZip from 'jszip';
import { INestApplication, Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  MAX_IMPORT_CANONICAL_CHARACTERS,
  MAX_IMPORT_CELL_CHARACTERS,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROW_CHARACTERS,
} from '../src/integration/import/csv.util';
import { MAX_XLSX_SOURCE_CELLS } from '../src/integration/import/xlsx.util';

const TEST_AGENT_TOKEN_HASH = 'd'.repeat(64);
const CONFIG_REVISION = 'server-revision-test';
const USER: AuthUser = {
  id: 'user_test',
  name: 'Test Owner',
  email: 'owner@example.test',
  role: 'head_office',
  organisationId: 'org_test',
  storeIds: [],
  allStores: true,
  // Ignored for human calls; inherited by the machine fixtures below so their
  // request-generation fence represents JwtAuthGuard's real principal.
  agentTokenHash: TEST_AGENT_TOKEN_HASH,
  agentConfigRevision: CONFIG_REVISION,
};

const CSV = Buffer.from('Customer Name,Mobile\nImport Test,9876500010');
const MAPPINGS = [
  { sourceColumn: 'Customer Name', canonicalField: 'name' },
  { sourceColumn: 'Mobile', canonicalField: 'phone' },
];
const SOURCE_INSTANCE_HASH = 'c'.repeat(64);
const MACHINE_SOURCE_NAMESPACE = SOURCE_INSTANCE_HASH.slice(0, 32);
const MACHINE_CSV = Buffer.from(
  `External ID,Customer Name,Mobile\nbusy:${MACHINE_SOURCE_NAMESPACE}:1001,Import Test,9876500010`,
);
const MACHINE_MAPPINGS = [
  { sourceColumn: 'External ID', canonicalField: 'code' },
  ...MAPPINGS,
];
const RUN_KEY = 'a'.repeat(64);
const PROFILE_HASH = 'b'.repeat(64);
const activeReceiptLock = () => ({
  id: 'batch_test',
  leaseExpiresAt: new Date(Date.now() + 60_000),
});

function machinePayloadHash(
  buffer: Buffer,
  mappings = MACHINE_MAPPINGS,
  storeId = '',
): string {
  return createHash('sha256')
    .update(buffer)
    .update('\0')
    .update(JSON.stringify(mappings))
    .update('\0')
    .update(storeId)
    .digest('hex');
}

describe('file import source and boundary validation', () => {
  function setup() {
    const prisma: any = {
      importBatch: {
        create: jest.fn().mockResolvedValue({ id: 'batch_test' }),
        update: jest.fn().mockResolvedValue({ id: 'batch_test' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      party: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({ id: 'party_test' }),
        update: jest.fn(),
      },
      product: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'product_test' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      connectAgent: {
        findFirst: jest.fn().mockResolvedValue({
          config: {
            expectedProfileHash: PROFILE_HASH,
            expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
            configRevision: CONFIG_REVISION,
          },
          sourceInstanceHash: null,
          tokenHash: TEST_AGENT_TOKEN_HASH,
          sourceSystem: 'busy',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    let agentFenceCount = 0;
    const queryRaw = jest.fn(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join('') ?? '';
      if (sql.includes('ConnectAgent')) {
        agentFenceCount += 1;
        return [{
            tokenHash: TEST_AGENT_TOKEN_HASH,
            revokedAt: null as Date | null,
            sourceSystem: 'busy',
            sourceInstanceHash:
              agentFenceCount === 1 ? null : SOURCE_INSTANCE_HASH,
            config: {
              expectedProfileHash: PROFILE_HASH,
              expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
              configRevision: CONFIG_REVISION,
            },
          }];
      }
      return [activeReceiptLock()];
    });
    prisma.$transaction = jest.fn(async (callback: (tx: unknown) => unknown) =>
      callback({ ...prisma, $queryRaw: queryRaw }),
    );
    const scope = { assertStoreAllowed: jest.fn() };
    const audit = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new ImportService(
      prisma as unknown as PrismaService,
      scope as unknown as StoreScopeService,
      audit as unknown as AuditService,
    );
    return { service, prisma, audit, queryRaw };
  }

  it('bounds multipart metadata and rejects mapping arrays wider than the parser', () => {
    expect(IMPORT_UPLOAD_OPTIONS.limits).toEqual(
      expect.objectContaining({
        fileSize: 8 * 1024 * 1024,
        files: 1,
        fields: expect.any(Number),
        parts: expect.any(Number),
        fieldSize: expect.any(Number),
        headerPairs: expect.any(Number),
      }),
    );
    expect(IMPORT_UPLOAD_OPTIONS.limits.fields).toBeLessThanOrEqual(12);
    expect(IMPORT_UPLOAD_OPTIONS.limits.parts).toBeLessThanOrEqual(13);
    expect(() =>
      parseMappings(
        JSON.stringify(
          Array.from({ length: MAX_IMPORT_COLUMNS + 1 }, (_, index) => ({
            sourceColumn: `Source ${index}`,
            canonicalField: 'name',
          })),
        ),
      ),
    ).toThrow(`at most ${MAX_IMPORT_COLUMNS} entries`);
    expect(() =>
      parseMappings(
        JSON.stringify([
          {
            sourceColumn: 'x'.repeat(MAX_IMPORT_MAPPING_NAME_CHARACTERS + 1),
            canonicalField: 'name',
          },
        ]),
      ),
    ).toThrow(`at most ${MAX_IMPORT_MAPPING_NAME_CHARACTERS} characters`);
    expect(() =>
      parseMappings(JSON.stringify([{ sourceColumn: 'Name\0', canonicalField: 'name' }])),
    ).toThrow('no control characters');
  });

  it('enforces multipart limits through the real FileInterceptor', async () => {
    const imports = {
      discover: jest.fn().mockReturnValue({ ok: true }),
      preview: jest.fn().mockReturnValue({ ok: true }),
      run: jest.fn().mockReturnValue({ ok: true }),
      history: jest.fn().mockReturnValue([]),
      template: jest.fn().mockReturnValue('Name\n'),
    };
    const module = await Test.createTestingModule({
      controllers: [ImportController],
      providers: [{ provide: ImportService, useValue: imports }],
    }).compile();
    const app: INestApplication = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer())
        .post('/imports/customers/discover')
        .attach('file', Buffer.alloc(8 * 1024 * 1024 + 1), 'oversized.csv')
        .expect(413);

      let tooManyFields = request(app.getHttpServer())
        .post('/imports/customers/discover')
        .attach('file', Buffer.from('Name\nAlice'), 'customers.csv');
      for (let index = 0; index < 13; index++) {
        tooManyFields = tooManyFields.field(`extra-${index}`, 'x');
      }
      await tooManyFields.expect(400);

      await request(app.getHttpServer())
        .post('/imports/customers/discover')
        .attach('file', Buffer.from('Name\nAlice'), 'one.csv')
        .attach('file', Buffer.from('Name\nBob'), 'two.csv')
        .expect(400);

      await request(app.getHttpServer())
        .post('/imports/customers/discover')
        .set('Content-Type', 'multipart/form-data; boundary=unfinished')
        .send('--unfinished\r\nContent-Disposition: form-data; name="file"; filename="x.csv"\r\n')
        .expect(400);
    } finally {
      await app.close();
    }
  });

  it('rejects PDF and Word documents instead of decoding them as CSV', async () => {
    const { service } = setup();
    await expect(
      service.discover(USER, 'customers', {
        buffer: Buffer.from('%PDF-1.7'),
        originalname: 'customers.pdf',
      }),
    ).rejects.toThrow('reference documents');
  });

  it('rejects malformed, ambiguous and oversized CSV structures', async () => {
    const { service } = setup();
    for (const [body, message] of [
      ['Name,name\nA,B', 'headers must be unique'],
      ['Name,\nA,B', 'non-blank header'],
      ['Name\nA,unexpected', 'data beyond'],
      ['Name\n"unclosed', 'unclosed quoted field'],
      ['Name\nab"cd', 'quote in an unquoted field'],
      ['Name\n"abc"tail', 'characters after a closing quote'],
    ] as const) {
      await expect(
        service.discover(USER, 'customers', {
          buffer: Buffer.from(body),
          originalname: 'bad.csv',
        }),
      ).rejects.toThrow(message);
    }
    const tooManyRows = ['Name', ...Array.from({ length: 20_001 }, (_, i) => `Row ${i}`)].join('\n');
    await expect(
      service.discover(USER, 'customers', {
        buffer: Buffer.from(tooManyRows),
        originalname: 'too-many.csv',
      }),
    ).rejects.toThrow('at most 20000 data rows');
  });

  it('reports physical CSV rows across blanks and quoted newlines', async () => {
    const { service } = setup();
    const result = await service.preview(
      USER,
      'customers',
      {
        buffer: Buffer.from(
          'Customer Name,Mobile\n\n"Multiline\nCustomer",9876500010\n,9876500011',
        ),
        originalname: 'physical-rows.csv',
      },
      MAPPINGS,
    );

    expect(result.sampleRows.map((row) => row.row)).toEqual([3, 5]);
    expect(result.sampleRows.map((row) => row.status)).toEqual(['valid', 'error']);
  });

  it('enforces shared cell, row and canonical-text budgets before mapping CSV', async () => {
    const { service } = setup();
    await expect(
      service.discover(USER, 'customers', {
        buffer: Buffer.from(`Name\n${'x'.repeat(MAX_IMPORT_CELL_CHARACTERS + 1)}`),
        originalname: 'long-cell.csv',
      }),
    ).rejects.toThrow(`cell longer than ${MAX_IMPORT_CELL_CHARACTERS}`);

    const columns = Math.floor(MAX_IMPORT_ROW_CHARACTERS / MAX_IMPORT_CELL_CHARACTERS) + 1;
    const headers = Array.from({ length: columns }, (_, index) => `Column ${index}`);
    const row = Array.from({ length: columns }, () =>
      'x'.repeat(MAX_IMPORT_CELL_CHARACTERS),
    );
    await expect(
      service.discover(USER, 'customers', {
        buffer: Buffer.from(`${headers.join(',')}\n${row.join(',')}`),
        originalname: 'long-row.csv',
      }),
    ).rejects.toThrow(`more than ${MAX_IMPORT_ROW_CHARACTERS} characters`);

    await expect(
      service.discover(USER, 'customers', {
        buffer: Buffer.from([0x4e, 0x61, 0x6d, 0x65, 0x0a, 0xc3, 0x28]),
        originalname: 'invalid-utf8.csv',
      }),
    ).rejects.toThrow('must be valid UTF-8');
    await expect(
      service.discover(USER, 'customers', {
        buffer: Buffer.from('Name\nunsafe\0value'),
        originalname: 'control.csv',
      }),
    ).rejects.toThrow('unsupported control character');
  });

  it('rejects malformed, ambiguous and expansion-heavy XLSX files', async () => {
    const { service } = setup();
    await expect(
      service.discover(USER, 'customers', {
        buffer: Buffer.from('not-a-zip'),
        originalname: 'broken.xlsx',
      }),
    ).rejects.toThrow('not a valid ZIP archive');

    const workbook = new Workbook();
    workbook.addWorksheet('Customers').addRow(['Name', 'name']);
    const duplicateHeaders = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(
      service.discover(USER, 'customers', {
        buffer: duplicateHeaders,
        originalname: 'duplicate-headers.xlsx',
      }),
    ).rejects.toThrow('headers must be unique');

    const archive = new JSZip();
    archive.file('xl/oversized.xml', 'x'.repeat(16 * 1024 * 1024 + 1));
    const expansionHeavy = await archive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    await expect(
      service.discover(USER, 'customers', {
        buffer: expansionHeavy,
        originalname: 'expansion-heavy.xlsx',
      }),
    ).rejects.toThrow('expands beyond the safe 16 MiB limit');
  });

  it('preflights XLSX worksheet cell count before ExcelJS materialises it', async () => {
    const { service } = setup();
    const archive = new JSZip();
    archive.file(
      'xl/worksheets/sheet1.xml',
      `<worksheet><sheetData>${'<c/>'.repeat(MAX_XLSX_SOURCE_CELLS + 1)}</sheetData></worksheet>`,
    );
    const tooManyCells = await archive.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });

    await expect(
      service.discover(USER, 'customers', {
        buffer: tooManyCells,
        originalname: 'too-many-cells.xlsx',
      }),
    ).rejects.toThrow(`at most ${MAX_XLSX_SOURCE_CELLS} source cells`);
  });

  it('rejects XLSX path, directory-entry and coordinate preflight bypasses', async () => {
    const { service } = setup();
    const workbook = new Workbook();
    const sheet = workbook.addWorksheet('Customers');
    sheet.addRow(['Name']);
    sheet.addRow(['Alice']);
    const original = await workbook.xlsx.writeBuffer();

    const source = await JSZip.loadAsync(original);
    const absolute = new JSZip();
    for (const entry of Object.values(source.files)) {
      if (!entry.dir) absolute.file(`/${entry.name}`, await entry.async('nodebuffer'));
    }
    await expect(
      service.discover(USER, 'customers', {
        buffer: await absolute.generateAsync({ type: 'nodebuffer' }),
        originalname: 'absolute-path.xlsx',
      }),
    ).rejects.toThrow('non-canonical entry path');

    const coordinate = await JSZip.loadAsync(original);
    const worksheet = coordinate.file('xl/worksheets/sheet1.xml');
    expect(worksheet).not.toBeNull();
    const worksheetXml = (await worksheet!.async('string')).replace(
      /<dimension ref="[^"]+"\s*\/>/,
      '<dimension ref="A1:XFD1048576"/>',
    );
    coordinate.file('xl/worksheets/sheet1.xml', worksheetXml);
    await expect(
      service.discover(USER, 'customers', {
        buffer: await coordinate.generateAsync({ type: 'nodebuffer' }),
        originalname: 'coordinate-bomb.xlsx',
      }),
    ).rejects.toThrow('beyond the safe import dimensions');

    const directoryHeavy = new JSZip();
    for (let index = 0; index < 1_025; index++) directoryHeavy.folder(`directory-${index}`);
    await expect(
      service.discover(USER, 'customers', {
        buffer: await directoryHeavy.generateAsync({ type: 'nodebuffer' }),
        originalname: 'directory-heavy.xlsx',
      }),
    ).rejects.toThrow('at most 1024 archive entries');
  });

  it('rejects formulas and Excel error values instead of importing stale or opaque text', async () => {
    const { service } = setup();
    for (const [value, message] of [
      [{ formula: '1+1', result: 2 }, 'contains a formula'],
      [{ error: '#N/A' }, 'contains an Excel error value'],
    ] as const) {
      const workbook = new Workbook();
      const sheet = workbook.addWorksheet('Customers');
      sheet.addRow(['Name']);
      sheet.getCell('A2').value = value;
      await expect(
        service.discover(USER, 'customers', {
          buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
          originalname: 'unsafe-cell.xlsx',
        }),
      ).rejects.toThrow(message);
    }
  });

  it('preserves XLSX physical rows and bounds expanded canonical text', async () => {
    const { service } = setup();
    const physicalRows = new Workbook();
    const sheet = physicalRows.addWorksheet('Customers');
    sheet.getRow(1).values = ['Customer Name', 'Mobile'];
    sheet.getRow(3).values = ['Physical row three', '9876500010'];
    sheet.getRow(5).values = ['', '9876500011'];
    const physicalBuffer = Buffer.from(await physicalRows.xlsx.writeBuffer());
    const preview = await service.preview(
      USER,
      'customers',
      { buffer: physicalBuffer, originalname: 'physical-rows.xlsx' },
      MAPPINGS,
    );
    expect(preview.sampleRows.map((row) => row.row)).toEqual([3, 5]);

    const canonicalText = new Workbook();
    const canonicalSheet = canonicalText.addWorksheet('Customers');
    canonicalSheet.addRow(['Name']);
    const repeatedCell = 'x'.repeat(MAX_IMPORT_CELL_CHARACTERS);
    const rowsNeeded = Math.floor(
      MAX_IMPORT_CANONICAL_CHARACTERS / MAX_IMPORT_CELL_CHARACTERS,
    ) + 1;
    for (let index = 0; index < rowsNeeded; index++) {
      canonicalSheet.addRow([repeatedCell]);
    }
    const canonicalBuffer = Buffer.from(await canonicalText.xlsx.writeBuffer());
    await expect(
      service.discover(USER, 'customers', {
        buffer: canonicalBuffer,
        originalname: 'canonical-text.xlsx',
      }),
    ).rejects.toThrow(`at most ${MAX_IMPORT_CANONICAL_CHARACTERS} canonical characters`);
  });

  it('uses deterministic dates and keeps non-jewellery materials neutral', () => {
    const validDate = mapCustomerRow({ name: 'Date test', birthday: '1990-02-01' });
    expect(validDate.value?.birthday).toBe('1990-02-01');
    expect(validDate.warnings).toHaveLength(0);
    for (const ambiguous of ['31/12/1990', '01/02/1990', '1990-02-30', 'not-a-date']) {
      const result = mapCustomerRow({ name: 'Date test', birthday: ambiguous });
      expect(result.value?.birthday).toBeNull();
      expect(result.warnings).toEqual([
        expect.objectContaining({ field: 'birthday', code: 'invalid_date' }),
      ]);
    }

    const product = (metal: string, karat: string, neutralProduct = true) =>
      IMPORTERS.products.mapRow(
        { sku: `sku-${metal}-${karat}`, name: 'Material test', metal, karat },
        { sourceSystem: 'csv', isMachine: false, neutralProduct },
      ).value;
    expect(product('Steel', '18')?.metal).toBe('unspecified');
    expect(product('', '', true)?.metal).toBe('unspecified');
    expect(product('', '', false)?.metal).toBe('gold_unspecified');
    expect(product('Gold', '10')?.metal).toBe('gold_10k');
    expect(product('Rose Gold', '18')?.metal).toBe('rose_gold_18k');

    const priced = (price: string, weightGrams: string) =>
      IMPORTERS.products.mapRow(
        { sku: 'decimal-test', name: 'Decimal test', price, weightGrams },
        { sourceSystem: 'csv', isMachine: false, neutralProduct: true },
      );
    const exactMaximum = priced('999999999999.99', '999999999.999');
    expect(exactMaximum.warnings).toHaveLength(0);
    expect(exactMaximum.value).toMatchObject({
      price: 999999999999.99,
      weight: 999999999.999,
    });
    for (const [price, weight] of [
      ['1000000000000', '1'],
      ['1.001', '1'],
      ['1e3', '1'],
      ['1', '1000000000'],
      ['1', '1.0001'],
      ['1', 'NaN'],
    ]) {
      const invalid = priced(price, weight);
      expect(invalid.warnings).toHaveLength(1);
      expect(invalid.value?.[price === '1' ? 'weight' : 'price']).toBeNull();
    }
  });

  it('rejects duplicate canonical mappings before any rows are written', async () => {
    const { service, prisma } = setup();
    await expect(
      service.preview(
        USER,
        'customers',
        { buffer: CSV, originalname: 'customers.csv' },
        [
          { sourceColumn: 'Customer Name', canonicalField: 'name' },
          { sourceColumn: 'Mobile', canonicalField: 'name' },
        ],
      ),
    ).rejects.toThrow('mapped from more than one column');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });

  it('rejects a source name that is not an approved file-import origin', async () => {
    const { service, prisma } = setup();
    await expect(
      service.run(
        USER,
        'customers',
        { buffer: CSV, originalname: 'customers.csv' },
        MAPPINGS,
        undefined,
        'made-up-erp',
      ),
    ).rejects.toThrow('Unsupported file source');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });

  it('persists Tally as the source of a validated CSV export', async () => {
    const { service, prisma, audit, queryRaw } = setup();
    const result = await service.run(
      USER,
      'customers',
      { buffer: CSV, originalname: 'tally-customers.csv' },
      MAPPINGS,
      undefined,
      'tally',
    );

    expect(result).toMatchObject({
      batchId: 'batch_test',
      entity: 'customers',
      sourceSystem: 'tally',
      counts: { imported: 1, failed: 0 },
    });
    expect(prisma.importBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organisationId: 'org_test',
        sourceSystem: 'tally',
        fileName: 'tally-customers.csv',
        configRevision: null,
      }),
    });
    expect(prisma.party.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organisationId: 'org_test', importBatchId: 'batch_test' }),
    });
    expect(
      queryRaw.mock.calls.some(([query]) =>
        (query?.strings?.join('') ?? '').includes('pg_advisory_xact_lock'),
      ),
    ).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      USER,
      expect.objectContaining({ metadata: expect.objectContaining({ sourceSystem: 'tally' }) }),
    );
  });

  it('marks a partially rejected human import as needing review', async () => {
    const { service, prisma } = setup();
    const mixed = Buffer.from(
      'Customer Name,Mobile\nAccepted,9876500010\n,9876500011',
    );
    const result = await service.run(
      USER,
      'customers',
      { buffer: mixed, originalname: 'mixed.csv' },
      MAPPINGS,
    );
    expect(result.counts).toMatchObject({ imported: 1, failed: 1 });
    expect(prisma.importBatch.update).toHaveBeenLastCalledWith({
      where: { id: 'batch_test' },
      data: expect.objectContaining({ status: 'needs_review', failed: 1 }),
    });
  });

  it('allows only a BUSY-enrolled machine to import BUSY customer masters', async () => {
    const { service, prisma, audit } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const result = await service.run(
      agent,
      'customers',
      { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
      MACHINE_MAPPINGS,
      undefined,
      'busy',
      RUN_KEY,
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
      CONFIG_REVISION,
    );
    expect(result.sourceSystem).toBe('busy');
    expect(prisma.importBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        createdById: 'agent:busy_test',
        sourceSystem: 'busy',
        runKey: RUN_KEY,
        profileId: 'busy-test-profile',
        profileHash: PROFILE_HASH,
        configRevision: CONFIG_REVISION,
      }),
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({
        action: 'import.run',
        entityId: 'batch_test',
        metadata: expect.objectContaining({ sourceSystem: 'busy' }),
      }),
      expect.objectContaining({ importBatch: prisma.importBatch }),
    );
  });

  it('lets the enrolled machine use the exact mapper without business-data writes', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const result = await service.preview(
      agent,
      'customers',
      { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
      MACHINE_MAPPINGS,
      undefined,
      'busy',
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
    );
    expect(result).toMatchObject({ total: 1, error: 0 });
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
    expect(prisma.connectAgent.updateMany).not.toHaveBeenCalled();
  });

  it('does not pin a source instance from an invalid first preview', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const invalid = Buffer.from(
      `External ID,Customer Name\nbusy:${MACHINE_SOURCE_NAMESPACE}:broken,`,
    );
    const result = await service.preview(
      agent,
      'customers',
      { buffer: invalid, originalname: 'invalid.csv' },
      MACHINE_MAPPINGS.slice(0, 2),
      undefined,
      'busy',
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
    );
    expect(result.error).toBe(1);
    expect(prisma.connectAgent.updateMany).not.toHaveBeenCalled();
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });

  it('fails closed when another worker wins the source-descriptor pin race', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    prisma.connectAgent.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.connectAgent.findFirst
      .mockResolvedValueOnce({
        config: {
          expectedProfileHash: PROFILE_HASH,
          expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
          configRevision: CONFIG_REVISION,
        },
        sourceInstanceHash: null,
        tokenHash: TEST_AGENT_TOKEN_HASH,
      })
      .mockResolvedValueOnce({
        config: {
          expectedProfileHash: PROFILE_HASH,
          expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
          configRevision: CONFIG_REVISION,
        },
        sourceInstanceHash: null,
        tokenHash: TEST_AGENT_TOKEN_HASH,
      })
      .mockResolvedValueOnce({
        sourceInstanceHash: 'd'.repeat(64),
        tokenHash: TEST_AGENT_TOKEN_HASH,
        config: { configRevision: CONFIG_REVISION },
      });

    await expect(
      service.run(
        agent,
        'customers',
        { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        RUN_KEY,
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow('different source connection descriptor');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
  });

  it('replays a committed machine receipt without applying rows twice', async () => {
    const { service, prisma } = setup();
    prisma.importBatch.findFirst.mockResolvedValue({
      id: 'batch_committed',
      organisationId: 'org_test',
      sourceSystem: 'busy',
      entity: 'customers',
      status: 'completed',
      discovered: 1,
      imported: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      duplicate: 0,
      payloadHash: machinePayloadHash(MACHINE_CSV),
      profileId: 'busy-test-profile',
      profileHash: PROFILE_HASH,
      sourceInstanceHash: SOURCE_INSTANCE_HASH,
      configRevision: CONFIG_REVISION,
      targetStoreId: null,
      createdById: 'agent:busy_test',
    });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const result = await service.run(
      agent,
      'customers',
      { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
      MACHINE_MAPPINGS,
      undefined,
      'busy',
      RUN_KEY,
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
      CONFIG_REVISION,
    );
    expect(result).toMatchObject({ batchId: 'batch_committed', replayed: true });
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
  });

  it('treats the server config generation as part of the replay receipt', async () => {
    const { service, prisma } = setup();
    prisma.importBatch.findFirst.mockResolvedValue({
      id: 'batch_from_previous_generation',
      organisationId: 'org_test',
      sourceSystem: 'busy',
      entity: 'customers',
      status: 'completed',
      payloadHash: machinePayloadHash(MACHINE_CSV),
      profileId: 'busy-test-profile',
      profileHash: PROFILE_HASH,
      sourceInstanceHash: SOURCE_INSTANCE_HASH,
      configRevision: 'previous-server-revision',
      targetStoreId: null,
      createdById: 'agent:busy_test',
    });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };

    await expect(
      service.run(
        agent,
        'customers',
        { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        RUN_KEY,
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow('runKey was already used');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
  });

  it('refuses a live receipt and reclaims only an expired receipt lease', async () => {
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const receipt = {
      id: 'batch_running',
      organisationId: 'org_test',
      sourceSystem: 'busy',
      entity: 'customers',
      status: 'running',
      payloadHash: machinePayloadHash(MACHINE_CSV),
      profileId: 'busy-test-profile',
      profileHash: PROFILE_HASH,
      sourceInstanceHash: SOURCE_INSTANCE_HASH,
      configRevision: CONFIG_REVISION,
      targetStoreId: null,
      createdById: 'agent:busy_test',
      updatedAt: new Date(),
    };
    const invoke = (service: ImportService) => service.run(
      agent,
      'customers',
      { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
      MACHINE_MAPPINGS,
      undefined,
      'busy',
      RUN_KEY,
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
      CONFIG_REVISION,
    );

    const live = setup();
    live.prisma.importBatch.findFirst.mockResolvedValue({
      ...receipt,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(invoke(live.service)).rejects.toThrow('already running');
    expect(live.prisma.party.create).not.toHaveBeenCalled();

    const stale = setup();
    stale.prisma.importBatch.findFirst.mockResolvedValue({
      ...receipt,
      leaseExpiresAt: new Date(Date.now() - 60_000),
    });
    const result = await invoke(stale.service);
    expect(result.counts).toMatchObject({ imported: 1, failed: 0 });
    expect(stale.prisma.importBatch.create).not.toHaveBeenCalled();
    expect(stale.prisma.importBatch.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'batch_running', status: 'running' }),
      data: expect.objectContaining({
        status: 'running',
        leaseToken: expect.any(String),
        leaseExpiresAt: expect.any(Date),
      }),
    });
    expect(stale.prisma.importBatch.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        id: 'batch_running',
        status: 'running',
        leaseToken: expect.any(String),
      }),
      data: expect.objectContaining({ status: 'completed', leaseToken: null }),
    });
  });

  it('stops a long machine import when its receipt lease is lost', async () => {
    const { service, prisma, audit } = setup();
    prisma.importBatch.updateMany.mockResolvedValue({ count: 0 });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const rows = Array.from(
      { length: 101 },
      (_, index) => `busy:${MACHINE_SOURCE_NAMESPACE}:${index + 1},Customer ${index + 1}`,
    );
    const csv = Buffer.from(['External ID,Customer Name', ...rows].join('\n'));
    await expect(
      service.run(
        agent,
        'customers',
        { buffer: csv, originalname: 'long.csv' },
        MACHINE_MAPPINGS.slice(0, 2),
        undefined,
        'busy',
        'd'.repeat(64),
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow('lost its receipt lease');
    expect(prisma.party.create).toHaveBeenCalledTimes(100);
    expect(prisma.importBatch.updateMany).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled(); // a reclaimed lease belongs to its new worker
  });

  it('cannot mark a receipt complete after losing the lease at finalisation', async () => {
    const { service, prisma, audit } = setup();
    prisma.importBatch.updateMany.mockResolvedValue({ count: 0 });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };

    await expect(
      service.run(
        agent,
        'customers',
        { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        RUN_KEY,
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow('lost its receipt lease before finalisation');
    expect(prisma.party.create).toHaveBeenCalledTimes(1);
    expect(prisma.importBatch.update).not.toHaveBeenCalled();
    expect(prisma.importBatch.updateMany).toHaveBeenCalledTimes(2);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('enforces the server kill switch, approved profile and a value on every machine identity row', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };

    prisma.connectAgent.findFirst.mockResolvedValueOnce({
      config: { enabled: false },
      tokenHash: TEST_AGENT_TOKEN_HASH,
    });
    await expect(
      service.preview(
        agent,
        'customers',
        { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
      ),
    ).rejects.toThrow('disabled by the server');

    prisma.connectAgent.findFirst.mockResolvedValueOnce({
      config: { expectedProfileHash: 'c'.repeat(64) },
      tokenHash: TEST_AGENT_TOKEN_HASH,
    });
    await expect(
      service.preview(
        agent,
        'customers',
        { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
      ),
    ).rejects.toThrow('server-approved profile hash');

    prisma.connectAgent.findFirst.mockResolvedValueOnce({
      config: {},
      tokenHash: TEST_AGENT_TOKEN_HASH,
    });
    const missingCode = Buffer.from('External ID,Customer Name,Mobile\n,No Stable Identity,');
    await expect(
      service.preview(
        agent,
        'customers',
        { buffer: missingCode, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
      ),
    ).rejects.toThrow('no stable source code');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });

  it('inherits a store-bound agent store when the request omits storeId', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
      allStores: false,
      storeIds: ['store_bound'],
    };
    await service.run(
      agent,
      'customers',
      { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
      MACHINE_MAPPINGS,
      undefined,
      'busy',
      RUN_KEY,
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
      CONFIG_REVISION,
    );
    expect(prisma.party.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ storeId: 'store_bound' }),
    });
    expect(prisma.importBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetStoreId: 'store_bound' }),
    });
  });

  it('store-scopes fallback customer matching and import history', async () => {
    const { service, prisma } = setup();
    const storeManager: AuthUser = {
      ...USER,
      role: 'store_manager',
      allStores: false,
      storeIds: ['store_a'],
    };
    await service.run(
      storeManager,
      'customers',
      { buffer: CSV, originalname: 'customers.csv' },
      MAPPINGS,
    );
    expect(prisma.party.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organisationId: 'org_test',
        storeId: 'store_a',
      }),
      select: { id: true, types: true },
      take: 2,
    });
    expect(prisma.importBatch.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ targetStoreId: 'store_a' }),
    });

    await service.history(storeManager);
    expect(prisma.importBatch.findMany).toHaveBeenCalledWith({
      where: { organisationId: 'org_test', targetStoreId: { in: ['store_a'] } },
      select: expect.objectContaining({
        id: true,
        sourceSystem: true,
        entity: true,
        status: true,
        createdAt: true,
      }),
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    const historyQuery = prisma.importBatch.findMany.mock.calls.at(-1)?.[0];
    expect(historyQuery.select).not.toHaveProperty('leaseToken');
    expect(historyQuery.select).not.toHaveProperty('runKey');
    expect(historyQuery.select).not.toHaveProperty('profileHash');
    expect(historyQuery.select).not.toHaveProperty('sourceInstanceHash');
    expect(historyQuery.select).not.toHaveProperty('payloadHash');
  });

  it('rejects a foreign namespace, repeated identity and server batch overflow', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const wrongNamespace = Buffer.from(
      'External ID,Customer Name\ntally:someone-else:1,Wrong namespace',
    );
    const shortMappings = MACHINE_MAPPINGS.slice(0, 2);
    await expect(
      service.preview(
        agent,
        'customers',
        { buffer: wrongNamespace, originalname: 'rows.csv' },
        shortMappings,
        undefined,
        'busy',
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
      ),
    ).rejects.toThrow('authenticated busy:');

    const repeated = Buffer.from(
      `External ID,Customer Name\nbusy:${MACHINE_SOURCE_NAMESPACE}:same,First\nbusy:${MACHINE_SOURCE_NAMESPACE}:same,Second`,
    );
    await expect(
      service.preview(
        agent,
        'customers',
        { buffer: repeated, originalname: 'rows.csv' },
        shortMappings,
        undefined,
        'busy',
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
      ),
    ).rejects.toThrow('repeats the same code');

    prisma.connectAgent.findFirst.mockResolvedValueOnce({
      config: { batchSize: 1 },
      tokenHash: TEST_AGENT_TOKEN_HASH,
    });
    const twoRows = Buffer.from(
      `External ID,Customer Name\nbusy:${MACHINE_SOURCE_NAMESPACE}:one,First\nbusy:${MACHINE_SOURCE_NAMESPACE}:two,Second`,
    );
    await expect(
      service.preview(
        agent,
        'customers',
        { buffer: twoRows, originalname: 'rows.csv' },
        shortMappings,
        undefined,
        'busy',
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
      ),
    ).rejects.toThrow('limited to 1');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });

  it('retries a failed machine receipt and completes it without creating a second batch', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    prisma.importBatch.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'batch_test',
        status: 'failed',
        payloadHash: machinePayloadHash(MACHINE_CSV),
        profileId: 'busy-test-profile',
        profileHash: PROFILE_HASH,
        sourceInstanceHash: SOURCE_INSTANCE_HASH,
        configRevision: CONFIG_REVISION,
        targetStoreId: null,
        createdById: 'agent:busy_test',
      });
    const logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    prisma.party.create.mockRejectedValueOnce(
      new Error('password=do-not-return relation private_customer_table failed'),
    );

    const invoke = () => service.run(
      agent,
      'customers',
      { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
      MACHINE_MAPPINGS,
      undefined,
      'busy',
      RUN_KEY,
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
      CONFIG_REVISION,
    );
    const failed = await invoke();
    expect(failed.counts.failed).toBe(1);
    expect(failed.issues).toEqual([
      {
        row: 2,
        reason: 'Import failed for this row. Contact support with batch ID batch_test.',
      },
    ]);
    expect(JSON.stringify(failed)).not.toContain('do-not-return');
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('do-not-return'),
      expect.any(String),
    );
    logError.mockRestore();
    expect(prisma.importBatch.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: 'batch_test', status: 'running' }),
      data: expect.objectContaining({ status: 'failed', failed: 1 }),
    });

    const retried = await invoke();
    expect(retried.counts).toMatchObject({ imported: 1, failed: 0 });
    expect(prisma.importBatch.create).toHaveBeenCalledTimes(1);
    expect(prisma.importBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'batch_test', status: 'failed' },
      data: expect.objectContaining({ status: 'running' }),
    });
    expect(prisma.importBatch.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: 'batch_test', status: 'running' }),
      data: expect.objectContaining({ status: 'completed', failed: 0 }),
    });
  });

  it('retries a reviewed machine duplicate with the same receipt after it is resolved', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    prisma.party.findMany
      .mockResolvedValueOnce([
        { id: 'candidate_1', types: ['customer'] },
        { id: 'candidate_2', types: ['customer'] },
      ])
      .mockResolvedValue([]);

    const invoke = () => service.run(
      agent,
      'customers',
      { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
      MACHINE_MAPPINGS,
      undefined,
      'busy',
      RUN_KEY,
      'busy-test-profile',
      PROFILE_HASH,
      SOURCE_INSTANCE_HASH,
      CONFIG_REVISION,
    );
    const held = await invoke();
    expect(held.counts).toMatchObject({ duplicate: 1, imported: 0 });

    prisma.importBatch.findFirst.mockResolvedValueOnce({
      id: 'batch_test',
      status: 'needs_review',
      payloadHash: machinePayloadHash(MACHINE_CSV),
      profileId: 'busy-test-profile',
      profileHash: PROFILE_HASH,
      sourceInstanceHash: SOURCE_INSTANCE_HASH,
      configRevision: CONFIG_REVISION,
      targetStoreId: null,
      createdById: 'agent:busy_test',
    });
    const retried = await invoke();
    expect(retried.counts).toMatchObject({ duplicate: 0, imported: 1, failed: 0 });
    expect(prisma.importBatch.create).toHaveBeenCalledTimes(1);
    expect(prisma.importBatch.updateMany).toHaveBeenCalledWith({
      where: { id: 'batch_test', status: 'needs_review' },
      data: expect.objectContaining({ status: 'running', duplicate: 0 }),
    });
  });

  it('refuses a token rotation that wins while the uploaded file is being evaluated', async () => {
    const { service, prisma } = setup();
    const approvedAgent = {
      config: {
        expectedProfileHash: PROFILE_HASH,
        expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
        configRevision: CONFIG_REVISION,
      },
      sourceInstanceHash: null,
      tokenHash: TEST_AGENT_TOKEN_HASH,
    };
    prisma.connectAgent.findFirst
      .mockResolvedValueOnce(approvedAgent)
      .mockResolvedValueOnce({ ...approvedAgent, tokenHash: 'e'.repeat(64) });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };

    await expect(
      service.run(
        agent,
        'customers',
        { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        RUN_KEY,
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow(/token was rotated/i);
    expect(prisma.connectAgent.updateMany).not.toHaveBeenCalled();
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
    expect(prisma.party.create).not.toHaveBeenCalled();
  });

  it('stops before the next row when rotation wins during persistence', async () => {
    const { service, prisma, audit, queryRaw } = setup();
    let agentFence = 0;
    queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join('') ?? '';
      if (!sql.includes('ConnectAgent')) return [activeReceiptLock()];
      agentFence += 1;
      return [{
        tokenHash: agentFence <= 2 ? TEST_AGENT_TOKEN_HASH : 'e'.repeat(64),
        revokedAt: null,
        sourceSystem: 'busy',
        sourceInstanceHash: SOURCE_INSTANCE_HASH,
        config: {
          expectedProfileHash: PROFILE_HASH,
          expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
          configRevision: CONFIG_REVISION,
        },
      }];
    });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const twoRows = Buffer.from(
      `External ID,Customer Name,Mobile\nbusy:${MACHINE_SOURCE_NAMESPACE}:1001,First,9876500010\nbusy:${MACHINE_SOURCE_NAMESPACE}:1002,Second,9876500011`,
    );

    await expect(
      service.run(
        agent,
        'customers',
        { buffer: twoRows, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        RUN_KEY,
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow(/rotated or revoked while the import was running/i);
    expect(prisma.party.create).toHaveBeenCalledTimes(1);
    expect(prisma.importBatch.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: 'batch_test', status: 'running' }),
      data: expect.objectContaining({ status: 'failed', imported: 1, leaseToken: null }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'import.aborted', entityId: 'batch_test' }),
      expect.any(Object),
    );
  });

  it('stops before the first domain row when revocation wins after the receipt opens', async () => {
    const { service, prisma, audit, queryRaw } = setup();
    let agentFence = 0;
    queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join('') ?? '';
      if (!sql.includes('ConnectAgent')) return [activeReceiptLock()];
      agentFence += 1;
      return [{
        tokenHash: TEST_AGENT_TOKEN_HASH,
        revokedAt: agentFence === 1 ? null : new Date(),
        sourceSystem: 'busy',
        sourceInstanceHash: SOURCE_INSTANCE_HASH,
        config: {
          expectedProfileHash: PROFILE_HASH,
          expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
          configRevision: CONFIG_REVISION,
        },
      }];
    });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };

    await expect(
      service.run(
        agent,
        'customers',
        { buffer: MACHINE_CSV, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        RUN_KEY,
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow(/rotated or revoked while the import was running/i);
    expect(prisma.importBatch.create).toHaveBeenCalledTimes(1);
    expect(prisma.party.create).not.toHaveBeenCalled();
    expect(prisma.importBatch.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: 'batch_test', status: 'running' }),
      data: expect.objectContaining({ status: 'failed', imported: 0, leaseToken: null }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'import.aborted', entityId: 'batch_test' }),
      expect.any(Object),
    );
  });

  it('cannot complete even an empty receipt after its config revision changes', async () => {
    const { service, prisma, audit, queryRaw } = setup();
    let agentFence = 0;
    queryRaw.mockImplementation(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join('') ?? '';
      if (sql.includes('ConnectAgent')) {
        agentFence += 1;
        return [{
            tokenHash: TEST_AGENT_TOKEN_HASH,
            revokedAt: null,
            sourceSystem: 'busy',
            sourceInstanceHash: SOURCE_INSTANCE_HASH,
            config: {
              expectedProfileHash: PROFILE_HASH,
              expectedSourceInstanceHash: SOURCE_INSTANCE_HASH,
              configRevision:
                agentFence === 1 ? CONFIG_REVISION : 'replacement-revision',
            },
          }];
      }
      return [activeReceiptLock()];
    });
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      agentId: 'busy_test',
      connectorSourceSystem: 'busy',
    };
    const empty = Buffer.from('External ID,Customer Name,Mobile\n');

    await expect(
      service.run(
        agent,
        'customers',
        { buffer: empty, originalname: 'busy-customers.csv' },
        MACHINE_MAPPINGS,
        undefined,
        'busy',
        RUN_KEY,
        'busy-test-profile',
        PROFILE_HASH,
        SOURCE_INSTANCE_HASH,
        CONFIG_REVISION,
      ),
    ).rejects.toThrow(/configuration changed while the import was running/i);
    expect(prisma.party.create).not.toHaveBeenCalled();
    expect(prisma.importBatch.updateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({ id: 'batch_test', status: 'running' }),
      data: expect.objectContaining({ status: 'failed', imported: 0, leaseToken: null }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ action: 'import.aborted', entityId: 'batch_test' }),
      expect.any(Object),
    );
  });

  it('does not let a store-bound importer update an organisation-global product', async () => {
    const { prisma } = setup();
    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'global-product',
      storeId: null,
    });
    const mapped = IMPORTERS.products.mapRow(
      { sku: 'busy:source:item-1', name: 'Universal item' },
      { sourceSystem: 'busy', isMachine: true, neutralProduct: true },
    );

    await expect(
      IMPORTERS.products.persist(
        prisma,
        'org_test',
        'store_bound',
        mapped.value!,
        'batch_test',
      ),
    ).resolves.toBe('duplicate');
    expect(prisma.product.updateMany).not.toHaveBeenCalled();
    expect(prisma.product.create).not.toHaveBeenCalled();
  });

  it('refuses source spoofing and entities outside a BUSY profile agent allowlist', async () => {
    const { service, prisma } = setup();
    const agent: AuthUser = {
      ...USER,
      id: 'agent:busy_test',
      email: '',
      isMachine: true,
      connectorSourceSystem: 'busy',
    };
    await expect(
      service.run(agent, 'customers', { buffer: CSV, originalname: 'rows.csv' }, MAPPINGS, undefined, 'tally'),
    ).rejects.toThrow('cannot submit tally');
    await expect(
      service.run(agent, 'stores', { buffer: CSV, originalname: 'rows.csv' }, [], undefined, 'busy'),
    ).rejects.toThrow('may submit only: customers, products');
    expect(prisma.importBatch.create).not.toHaveBeenCalled();
  });

  it('allows machines only on exact validation and committing import routes', () => {
    expect(Reflect.getMetadata(ALLOW_MACHINE_KEY, ImportController.prototype.run)).toBe(true);
    expect(Reflect.getMetadata(ALLOW_MACHINE_KEY, ImportController.prototype.preview)).toBe(true);
    expect(Reflect.getMetadata(ALLOW_MACHINE_KEY, ImportController.prototype.history)).toBeUndefined();
  });
});
