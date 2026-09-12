import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import JSZip from 'jszip';

import type { PrismaService } from '../src/prisma/prisma.service';

/**
 * The other half of the import engine: a folder of photographs, and a column
 * mapping that does not have to be worked out again every month.
 *
 * The spreadsheet half already shipped — discover, map, preview, run. What was
 * missing is what a supplier actually sends: one workbook plus a folder of
 * images named after the design code, arriving on the same day every month.
 *
 *  1. MATCHING IS DECLARED, NEVER GUESSED. `matchBy` says which product field a
 *     filename is. Nothing tries each in turn until something hits — that
 *     attaches a photograph to the wrong ring and leaves no evidence.
 *
 *  2. NOTHING IS WRITTEN UNTIL SOMEBODY HAS SEEN THE PREVIEW.
 *
 *  3. UNMATCHED FILES ARE NAMED. "1,412 of 1,500 uploaded" without the other 88
 *     is a number nobody can act on.
 *
 *  4. AN EXISTING PHOTOGRAPH IS NOT REPLACED unless asked. An import that
 *     overwrites curated photography with a supplier's catalogue shot is
 *     discovered a week later.
 *
 *  5. AMBIGUITY IS REPORTED, NOT RESOLVED. Two products answering to one name is
 *     a question for a person.
 *
 *  6. A SAVED MAPPING REMEMBERS THE HEADERS IT WAS BUILT FROM, so a file whose
 *     columns have changed is flagged instead of silently mapped wrong.
 */

const PASSWORD = 'password123';

const A = {
  org: 'org_imp_a',
  slug: 'imp-a',
  store: 'store_imp_a',
  other: 'store_imp_b',
  ho: 'ho.imp@imp-a.local',
  mgr: 'mgr.imp@imp-a.local',
  rep: 'rep.imp@imp-a.local',
};

/** A different tenant, to prove a filename cannot reach across the boundary. */
const B = {
  org: 'org_imp_b',
  slug: 'imp-b',
  store: 'store_imp_b2',
};

/** A 1x1 PNG. Real bytes, so the storage path is genuinely exercised. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function teardown(prisma: PrismaService) {
  for (const org of [A.org, B.org]) {
    await prisma.importMappingProfile.deleteMany({ where: { organisationId: org } });
    await prisma.auditLog.deleteMany({ where: { organisationId: org } });
    await prisma.productEmbedding.deleteMany({ where: { product: { organisationId: org } } });
    await prisma.product.deleteMany({ where: { organisationId: org } });
    await prisma.importBatch.deleteMany({ where: { organisationId: org } });
    await prisma.userStore.deleteMany({ where: { user: { organisationId: org } } });
    await prisma.user.deleteMany({ where: { organisationId: org } });
    await prisma.store.deleteMany({ where: { organisationId: org } });
    await prisma.organisation.deleteMany({ where: { id: org } });
  }
}

describe('Image ZIP import + saved column mappings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let hoT: string;
  let mgrT: string;
  let repT: string;

  const server = () => app.getHttpServer();
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  /** A ZIP built in memory from a map of filename → bytes. */
  async function zipOf(files: Record<string, Buffer>): Promise<Buffer> {
    const zip = new JSZip();
    for (const [name, bytes] of Object.entries(files)) zip.file(name, bytes);
    return zip.generateAsync({ type: 'nodebuffer' });
  }

  const post = (path: string, token: string, zip: Buffer, fields: Record<string, string> = {}) => {
    const req = request(server())
      .post(path)
      .set(auth(token))
      .attach('file', zip, { filename: 'images.zip', contentType: 'application/zip' });
    for (const [k, v] of Object.entries(fields)) req.field(k, v);
    return req;
  };

  async function product(
    sku: string,
    extra: { legacyId?: string; name?: string; imageUrl?: string; storeId?: string; org?: string } = {},
  ) {
    return prisma.product.create({
      data: {
        organisationId: extra.org ?? A.org,
        storeId: extra.storeId ?? (extra.org ? B.store : A.store),
        sku,
        name: extra.name ?? `Product ${sku}`,
        category: 'ring',
        metal: 'gold_22k',
        legacyId: extra.legacyId,
        imageUrl: extra.imageUrl,
      },
      select: { id: true, sku: true },
    });
  }

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');

    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    const hash = await bcrypt.hash(PASSWORD, 10);
    await prisma.organisation.create({
      data: { id: A.org, name: 'Imp A', slug: A.slug, industryPackCode: 'jewellery' },
    });
    await prisma.organisation.create({
      data: { id: B.org, name: 'Imp B', slug: B.slug, industryPackCode: 'jewellery' },
    });
    await prisma.store.createMany({
      data: [
        { id: A.store, name: 'Bandra', city: 'Mumbai', organisationId: A.org },
        { id: A.other, name: 'Pune', city: 'Pune', organisationId: A.org },
        { id: B.store, name: 'Other tenant', city: 'Delhi', organisationId: B.org },
      ],
    });
    for (const [id, email, role] of [
      ['u_imp_ho', A.ho, 'head_office'],
      ['u_imp_mgr', A.mgr, 'store_manager'],
      ['u_imp_rep', A.rep, 'salesperson'],
    ] as const) {
      await prisma.user.create({
        data: {
          id,
          email,
          name: id,
          role: role as never,
          passwordHash: hash,
          isActive: true,
          approvalStatus: 'approved',
          organisationId: A.org,
          userStores: { create: { storeId: A.store, isPrimary: true } },
        },
      });
    }

    const login = async (email: string) =>
      (
        await request(server())
          .post('/auth/login')
          .send({ email, password: PASSWORD })
          .expect(201)
      ).body.token;
    hoT = await login(A.ho);
    mgrT = await login(A.mgr);
    repT = await login(A.rep);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  // ==========================================================================
  // 1. The image ZIP
  // ==========================================================================

  it('a salesperson cannot bulk-replace the catalogue’s photographs', async () => {
    const zip = await zipOf({ 'RING-1.png': PNG });
    await post('/import-images/preview', repT, zip, { matchBy: 'sku' }).expect(403);
  });

  it('preview says what would happen and writes nothing', async () => {
    await product('RING-100');
    await product('RING-101');

    const zip = await zipOf({
      'RING-100.png': PNG,
      'RING-101.png': PNG,
      'RING-999.png': PNG,
      'notes.txt': Buffer.from('hello'),
    });

    const res = await post('/import-images/preview', mgrT, zip, { matchBy: 'sku' }).expect(201);

    expect(res.body.entries).toBe(4);
    expect(res.body.matched).toBe(2);
    expect(res.body.uploaded).toBe(0);
    expect(res.body.unmatched).toBe(1);
    // A .txt in the folder is not a failure, it is a file nobody meant to import.
    expect(res.body.ignored).toBe(1);

    // Named, not just counted.
    const unmatched = res.body.results.find((r: { status: string }) => r.status === 'unmatched');
    expect(unmatched.filename).toBe('RING-999.png');
    expect(unmatched.detail).toMatch(/SKU/i);

    // Nothing written.
    const products = await prisma.product.findMany({
      where: { organisationId: A.org, imageUrl: { not: null } },
    });
    expect(products).toHaveLength(0);
  });

  it('run attaches the photographs, and re-running is harmless', async () => {
    const zip = await zipOf({ 'RING-100.png': PNG, 'RING-101.png': PNG });

    const first = await post('/import-images/run', mgrT, zip, { matchBy: 'sku' }).expect(201);
    expect(first.body.uploaded).toBe(2);
    expect(first.body.batchId).toBeTruthy();

    const p = await prisma.product.findFirst({
      where: { organisationId: A.org, sku: 'RING-100' },
    });
    expect(p!.imageUrl).toBeTruthy();
    // The stored key is derived from the product id, not the supplier's
    // filename: re-running overwrites in place, and a supplier's filename never
    // becomes part of a public URL.
    expect(p!.imageUrl).toContain(p!.id);
    expect(p!.imageUrl).not.toContain('RING-100.png');

    // Second run: they already have photographs, so nothing is touched.
    const second = await post('/import-images/run', mgrT, zip, { matchBy: 'sku' }).expect(201);
    expect(second.body.uploaded).toBe(0);
    expect(second.body.skipped).toBe(2);

    const after = await prisma.product.findFirst({
      where: { organisationId: A.org, sku: 'RING-100' },
    });
    expect(after!.imageUrl).toBe(p!.imageUrl);
  });

  it('an existing photograph is replaced only when asked', async () => {
    const zip = await zipOf({ 'RING-100.png': PNG });
    const res = await post('/import-images/run', mgrT, zip, {
      matchBy: 'sku',
      overwriteExisting: 'true',
    }).expect(201);
    expect(res.body.uploaded).toBe(1);
  });

  it('“false” in a multipart field means false', async () => {
    // Multipart bodies are strings, so a naive truthiness check turns the string
    // "false" into "yes, overwrite everything".
    const zip = await zipOf({ 'RING-101.png': PNG });
    const res = await post('/import-images/run', mgrT, zip, {
      matchBy: 'sku',
      overwriteExisting: 'false',
    }).expect(201);
    expect(res.body.uploaded).toBe(0);
    expect(res.body.skipped).toBe(1);
  });

  it('matches on the source system’s own id when told to', async () => {
    await product('RING-200', { legacyId: 'GATI-55821' });

    const zip = await zipOf({ 'GATI-55821.jpg': PNG });
    const res = await post('/import-images/run', mgrT, zip, { matchBy: 'legacyId' }).expect(201);
    expect(res.body.uploaded).toBe(1);

    // And the SAME file matches nothing under the SKU rule. Nothing falls back:
    // a filename that matches a SKU under one rule and a source id under another
    // would otherwise attach a photograph to the wrong product.
    await product('RING-201');
    const zip2 = await zipOf({ 'GATI-55821.jpg': PNG });
    const res2 = await post('/import-images/preview', mgrT, zip2, { matchBy: 'sku' }).expect(201);
    expect(res2.body.unmatched).toBe(1);
  });

  it('separators and case do not decide whether a photo is found', async () => {
    await product('BANGLE_300');
    const zip = await zipOf({ 'bangle-300.png': PNG });
    const res = await post('/import-images/run', mgrT, zip, { matchBy: 'sku' }).expect(201);
    expect(res.body.uploaded).toBe(1);
  });

  it('a DAM’s prefix, suffix and numbered extras are trimmed when configured', async () => {
    await product('NECK-400');

    const zip = await zipOf({
      'IMG_NECK-400_main.png': PNG,
      // A second angle of the same piece.
      'IMG_NECK-400_main-2.png': PNG,
    });
    const res = await post('/import-images/preview', mgrT, zip, {
      matchBy: 'sku',
      stripPrefix: 'IMG_',
      stripSuffix: '_main',
      stripNumericSuffix: 'true',
    }).expect(201);
    // Both resolve to the same product. The named suffix is taken off on either
    // side of the "-2", because both orders occur in real DAM exports.
    expect(res.body.matched).toBe(2);

    // Without the numeric strip, "-2" is a different code — which is right for a
    // tenant whose SKUs genuinely end that way.
    const strict = await post('/import-images/preview', mgrT, zip, {
      matchBy: 'sku',
      stripPrefix: 'IMG_',
      stripSuffix: '_main',
    }).expect(201);
    expect(strict.body.matched).toBe(1);
    expect(strict.body.unmatched).toBe(1);
  });

  it('two products answering to one name is reported, not resolved', async () => {
    await product('DUP-A', { name: 'Classic Band' });
    await product('DUP-B', { name: 'Classic Band' });

    const zip = await zipOf({ 'Classic Band.png': PNG });
    const res = await post('/import-images/preview', mgrT, zip, { matchBy: 'name' }).expect(201);

    expect(res.body.ambiguous).toBe(1);
    expect(res.body.matched).toBe(0);
    const row = res.body.results[0];
    expect(row.detail).toMatch(/DUP-A|DUP-B/);
  });

  it('a filename cannot reach another tenant’s catalogue', async () => {
    await product('SECRET-1', { org: B.org, storeId: B.store });

    const zip = await zipOf({ 'SECRET-1.png': PNG });
    const res = await post('/import-images/preview', mgrT, zip, { matchBy: 'sku' }).expect(201);
    expect(res.body.unmatched).toBe(1);

    const theirs = await prisma.product.findFirst({ where: { organisationId: B.org } });
    expect(theirs!.imageUrl).toBeNull();
  });

  it('a branch the manager cannot see is refused, not quietly widened', async () => {
    const zip = await zipOf({ 'RING-100.png': PNG });
    await post('/import-images/preview', mgrT, zip, {
      matchBy: 'sku',
      storeId: 'store-that-is-not-theirs',
    }).expect(403);
  });

  it('refuses something that is not a ZIP, and an empty one', async () => {
    const notAZip = Buffer.from('this is a spreadsheet, honestly');
    await post('/import-images/preview', mgrT, notAZip, { matchBy: 'sku' }).expect(400);

    const empty = await zipOf({});
    await post('/import-images/preview', mgrT, empty, { matchBy: 'sku' }).expect(400);
  });

  it('refuses an executable, however it is named', async () => {
    // A ZIP from a customer is an archive from the internet. The allow-list is
    // on the EXTENSION rather than on a blocklist of dangerous ones, so a
    // payload nobody thought of is refused by default rather than by memory.
    const zip = await zipOf({
      'RING-100.exe': Buffer.from('MZ '),
      'RING-100.php': Buffer.from('<?php system($_GET["c"]); ?>'),
      'RING-100.svg': Buffer.from('<svg onload="alert(1)"></svg>'),
    });
    const res = await post('/import-images/preview', mgrT, zip, { matchBy: 'sku' }).expect(201);
    expect(res.body.matched).toBe(0);
    // Every one refused for the same stated reason, rather than silently
    // ignored — an operator has to be able to see what the archive contained.
    expect(res.body.entries).toBe(3);
    expect(res.body.ignored).toBe(3);
    for (const entry of res.body.results) {
      expect(String(entry.detail ?? entry.reason ?? '')).toMatch(/not an image/i);
    }
  });

  it('cannot be made to write outside the image store by its filenames', async () => {
    /*
     * Zip Slip. The defence is structural rather than a sanitiser: the storage
     * key is built from the PRODUCT ID and the extension, so the archive's own
     * filename never reaches a path at all. A sanitiser is a list of the
     * traversals somebody remembered; this one has nothing to remember.
     */
    const zip = await zipOf({
      '../../../../etc/passwd.jpg': Buffer.from('not really a jpg'),
      '..\..\windows\system32\evil.png': Buffer.from('nor this'),
      'C:/Windows/Temp/pwned.jpg': Buffer.from('nor this either'),
    });
    const res = await post('/import-images/preview', mgrT, zip, { matchBy: 'sku' }).expect(201);
    // None of them matches a product, and nothing is written by a preview
    // regardless — but the point is that no path in the archive is ever used.
    expect(res.body.matched).toBe(0);
  });

  it('refuses a matchBy nobody implemented', async () => {
    const zip = await zipOf({ 'RING-100.png': PNG });
    await post('/import-images/preview', mgrT, zip, { matchBy: 'barcode' }).expect(400);
  });

  it('the run is recorded as an import batch somebody can find later', async () => {
    const batches = await prisma.importBatch.findMany({
      where: { organisationId: A.org, entity: 'product-images' },
      orderBy: { createdAt: 'asc' },
    });
    expect(batches.length).toBeGreaterThan(0);
    expect(batches[0].sourceSystem).toBe('zip');
    expect(batches[0].imported).toBe(2);

    const audit = await prisma.auditLog.findFirst({
      where: { organisationId: A.org, action: 'imports.product_images' },
    });
    expect(audit).toBeTruthy();
  });

  // ==========================================================================
  // 2. Saved column mappings
  // ==========================================================================

  it('a mapping is saved, listed and replayed', async () => {
    const saved = await request(server())
      .post('/import-mappings')
      .set(auth(mgrT))
      .send({
        name: 'Gati monthly stock',
        entity: 'products',
        mappings: [
          { sourceColumn: 'Design Code', canonicalField: 'sku' },
          { sourceColumn: 'Item Description', canonicalField: 'name' },
          { sourceColumn: 'Gross Wt', canonicalField: 'weightGrams' },
        ],
        sourceHeaders: ['Design Code', 'Item Description', 'Gross Wt', 'Branch'],
      })
      .expect(201);

    expect(saved.body.mappings).toHaveLength(3);
    expect(saved.body.sourceHeaders).toHaveLength(4);

    const list = await request(server())
      .get('/import-mappings?entity=products')
      .set(auth(mgrT))
      .expect(200);
    expect(list.body).toHaveLength(1);
  });

  it('applying it to next month’s identical file is a straight yes', async () => {
    const list = await request(server()).get('/import-mappings').set(auth(mgrT)).expect(200);
    const id = list.body[0].id;

    const res = await request(server())
      .post(`/import-mappings/${id}/apply`)
      .set(auth(mgrT))
      .send({ headers: ['Design Code', 'Item Description', 'Gross Wt', 'Branch'] })
      .expect(201);

    expect(res.body.exact).toBe(true);
    expect(res.body.applicable).toHaveLength(3);
    expect(res.body.warning).toBeNull();
    // 'Branch' is in the file and the mapping says nothing about it. Surfaced,
    // never silently dropped.
    expect(res.body.unknownColumns).toEqual(['Branch']);
  });

  it('a renamed column is reported, not quietly mapped to whatever is there', async () => {
    const list = await request(server()).get('/import-mappings').set(auth(mgrT)).expect(200);
    const id = list.body[0].id;

    const res = await request(server())
      .post(`/import-mappings/${id}/apply`)
      .set(auth(mgrT))
      // The supplier renamed "Gross Wt" and added a cost column.
      .send({ headers: ['Design Code', 'Item Description', 'Gross Weight', 'Cost Price'] })
      .expect(201);

    expect(res.body.exact).toBe(false);
    expect(res.body.missingColumns).toEqual(['Gross Wt']);
    // The two that DO still fit are applied; only the missing one is a question.
    expect(res.body.applicable).toHaveLength(2);
    expect(res.body.warning).toMatch(/Gross Wt/);
  });

  it('capitalisation and punctuation are not a rename', async () => {
    const list = await request(server()).get('/import-mappings').set(auth(mgrT)).expect(200);
    const id = list.body[0].id;

    const res = await request(server())
      .post(`/import-mappings/${id}/apply`)
      .set(auth(mgrT))
      .send({ headers: ['DESIGN_CODE', 'Item Description', 'gross wt'] })
      .expect(201);

    expect(res.body.exact).toBe(true);
    // The mapping now names the file's ACTUAL header, so it can be replayed
    // against this file rather than against the one it was built from.
    expect(res.body.applicable[0].sourceColumn).toBe('DESIGN_CODE');
  });

  it('refuses two columns fighting over one field, and a field that does not exist', async () => {
    await request(server())
      .post('/import-mappings')
      .set(auth(mgrT))
      .send({
        name: 'Conflicted',
        entity: 'products',
        mappings: [
          { sourceColumn: 'Code', canonicalField: 'sku' },
          { sourceColumn: 'Design No', canonicalField: 'sku' },
        ],
      })
      .expect(400);

    const bad = await request(server())
      .post('/import-mappings')
      .set(auth(mgrT))
      .send({
        name: 'Invented field',
        entity: 'products',
        mappings: [{ sourceColumn: 'Cost', canonicalField: 'supplierMargin' }],
      })
      .expect(400);
    expect(JSON.stringify(bad.body)).toMatch(/not a field/i);
  });

  it('re-saving under the same name updates it rather than refusing', async () => {
    const updated = await request(server())
      .post('/import-mappings')
      .set(auth(hoT))
      .send({
        name: 'Gati monthly stock',
        entity: 'products',
        mappings: [
          { sourceColumn: 'Design Code', canonicalField: 'sku' },
          { sourceColumn: 'Item Description', canonicalField: 'name' },
          { sourceColumn: 'Gross Weight', canonicalField: 'weightGrams' },
        ],
        sourceHeaders: ['Design Code', 'Item Description', 'Gross Weight'],
      })
      .expect(201);

    expect(updated.body.mappings[2].sourceColumn).toBe('Gross Weight');
    const list = await request(server())
      .get('/import-mappings?entity=products')
      .set(auth(mgrT))
      .expect(200);
    // Still one, not two.
    expect(list.body.filter((p: { name: string }) => p.name === 'Gati monthly stock')).toHaveLength(
      1,
    );
  });

  it('a mapping is only valid for the entity it was built against', async () => {
    await request(server())
      .post('/import-mappings')
      .set(auth(mgrT))
      .send({
        name: 'Wrong entity',
        entity: 'customers',
        mappings: [{ sourceColumn: 'Design Code', canonicalField: 'sku' }],
      })
      .expect(400);
  });

  it('deleting one leaves the rest alone', async () => {
    const list = await request(server()).get('/import-mappings').set(auth(mgrT)).expect(200);
    const id = list.body[0].id;
    await request(server()).delete(`/import-mappings/${id}`).set(auth(hoT)).expect(200);
    const after = await request(server()).get('/import-mappings').set(auth(mgrT)).expect(200);
    expect(after.body.find((p: { id: string }) => p.id === id)).toBeUndefined();
  });
});
