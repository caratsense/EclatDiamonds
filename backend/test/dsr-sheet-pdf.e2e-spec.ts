import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request = require('supertest');
import * as bcrypt from 'bcryptjs';
import { inflateSync } from 'node:zlib';
import { Workbook } from 'exceljs';
import { PDFDocument } from 'pdf-lib';

import type { PrismaService } from '../src/prisma/prisma.service';
import { routeForPath } from '../src/auth/access';

/**
 * The DSR as the store's paper sheet (GET /reporting/daily/pdf).
 *
 *  1. Bank transfer and the remark are filed, returned and put in the text.
 *  2. Day, week and month PDFs: portrait for a day, landscape otherwise; a
 *     month runs Week 1… in Mon–Sun weeks clipped to the month (March 2026
 *     starts on a Sunday, so it has six); totals add flows but take the
 *     booking book's opening from the first day and closing from the last.
 *  3. A salesperson gets their own store's sheet and nobody else's.
 *  4. The same sheet as a workbook (format=xlsx): real cells, real numbers,
 *     and a Total column that adds up — and sent as a file, which degrades to
 *     a no-op on a channel this deployment has not configured.
 */

const PASSWORD = 'password123';
const A = { org: 'org_dsp', slug: 'dsp', store: 'store_dsp_a', other: 'store_dsp_b' };

async function teardown(prisma: PrismaService) {
  await prisma.dailyReport.deleteMany({ where: { organisationId: A.org } });
  await prisma.auditLog.deleteMany({ where: { organisationId: A.org } });
  await prisma.employeeProfile.deleteMany({ where: { organisationId: A.org } });
  await prisma.userStore.deleteMany({ where: { user: { organisationId: A.org } } });
  await prisma.user.deleteMany({ where: { organisationId: A.org } });
  await prisma.store.deleteMany({ where: { organisationId: A.org } });
  await prisma.organisation.deleteMany({ where: { id: A.org } });
}

/** The strings drawn on a pdf-lib page: inflate each content stream, decode its hex `Tj`s. */
function pdfText(buf: Buffer): string {
  const out: string[] = [];
  for (const m of buf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let s: string;
    try {
      s = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const h of s.matchAll(/<([0-9A-Fa-f]*)> Tj/g)) out.push(Buffer.from(h[1], 'hex').toString('latin1'));
  }
  return out.join('|');
}

describe('DSR sheet PDF (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const t: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${t[who]}` });
  const file = (who: string, body: Record<string, unknown>) =>
    request(server()).post('/reporting/daily').set(as(who)).send({ storeId: A.store, ...body });
  const sheet = (who: string, qs: string, route = 'daily/pdf') =>
    request(server())
      .get(`/reporting/${route}?${qs}`)
      .set(as(who))
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    const { AppModule } = await import('../src/app.module');
    const { PrismaService: P } = await import('../src/prisma/prisma.service');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    await app.init();
    prisma = app.get(P);
    await teardown(prisma);

    await prisma.organisation.create({ data: { id: A.org, name: 'Dsp Jewels', slug: A.slug, industryPackCode: 'jewellery' } });
    await prisma.store.create({ data: { id: A.store, name: 'Surat Main', city: 'Surat', organisationId: A.org } });
    await prisma.store.create({ data: { id: A.other, name: 'Vapi', city: 'Vapi', organisationId: A.org } });
    const hash = await bcrypt.hash(PASSWORD, 10);
    for (const [who, role, storeId] of [
      ['mgr', 'store_manager', A.store],
      ['rep', 'salesperson', A.store],
      ['rep2', 'salesperson', A.other],
      ['mgr2', 'store_manager', A.other],
    ] as const) {
      await prisma.user.create({
        data: {
          id: `u_dsp_${who}`, email: `${who}@dsp.local`, name: `dsp ${who}`, role, passwordHash: hash,
          isActive: true, approvalStatus: 'approved', organisationId: A.org,
          userStores: { create: { storeId, isPrimary: true } },
        },
      });
      t[who] = (await request(server()).post('/auth/login').send({ email: `${who}@dsp.local`, password: PASSWORD }).expect(201)).body.token;
    }

    // Sun 1 Mar is the month's Week 1 on its own; Mon 9, Tue 10 and Sun 15
    // make one Mon–Sun week with gaps in it.
    await file('mgr', { reportDate: '2026-03-01', walkIns: 5, bookingsOpen: 90000, customBankTransfer: 44444 }).expect(201);
    await file('mgr', {
      reportDate: '2026-03-09', walkIns: 10, bookingsOpen: 100000, bookingsNew: 20000, bookingsClosed: 5000,
      customBankTransfer: 11111,
    }).expect(201);
    await file('rep', {
      reportDate: '2026-03-10', walkIns: 12, bookingsOpen: 115000, bookingsNew: 10000, bookingsClosed: 25000,
      customCash: 1000, customBankTransfer: 22222, remark: '  Hallmark re-check pending  ',
    }).expect(201);
    await file('mgr', { reportDate: '2026-03-15', walkIns: 8, bookingsOpen: 100000, customBankTransfer: 33333 }).expect(201);
  }, 180_000);

  afterAll(async () => {
    if (prisma) await teardown(prisma);
    if (app) await app.close();
  });

  it('bank transfer and the remark round-trip, and a salesperson still cannot overwrite', async () => {
    const [r] = (await request(server()).get(`/reporting/daily?date=2026-03-10&storeId=${A.store}`).set(as('rep')).expect(200)).body;
    expect(r).toMatchObject({ customBankTransfer: 22222, remark: 'Hallmark re-check pending', bookingsClosing: 100000 });
    expect(r.text).toContain('→ Bank transfer ₹22,222');
    expect(r.text).toContain('Remark: Hallmark re-check pending');
    await file('rep', { reportDate: '2026-03-10', walkIns: 1 }).expect(403);
  });

  it('the sheet route is governed like the rest of reporting', () => {
    expect(routeForPath('/reporting/daily/pdf')).toEqual(routeForPath('/reporting/daily'));
    expect(routeForPath('/reporting/daily/pdf')?.module).toBe('reporting');
  });

  it('a day is one portrait column with its remark', async () => {
    const res = await sheet('rep', `storeId=${A.store}&period=day&date=2026-03-10`).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('DSR-Surat-Main-day-2026-03-10.pdf');
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
    expect(res.body.length).toBeGreaterThan(1500);
    const page = (await PDFDocument.load(res.body)).getPage(0);
    expect(page.getWidth()).toBeLessThan(page.getHeight());
    const text = pdfText(res.body);
    expect(text).toContain('Surat Main');
    expect(text).toContain('Tue 10 Mar 2026');
    expect(text).toContain('Bank Transfer|');
    expect(text).toContain('22,222');
    expect(text).toContain('23,222'); // Table B total: cash + bank
    expect(text).toContain('Hallmark re-check pending');
  });

  it('a week runs Monday to Sunday with a Total; the book opens on the first day and closes on the last', async () => {
    const res = await sheet('mgr', `storeId=${A.store}&period=week&date=2026-03-12`).expect(200);
    expect(res.body.subarray(0, 4).toString()).toBe('%PDF');
    const page = (await PDFDocument.load(res.body)).getPage(0);
    expect(page.getWidth()).toBeGreaterThan(page.getHeight());
    const text = pdfText(res.body);
    for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Total', '9 Mar', '15 Mar']) expect(text).toContain(`${d}|`);
    expect(text).toContain('66,666'); // 11,111 + 22,222 + 33,333
    expect(text).toContain('|30|'); // walk-ins 10 + 12 + 8
    // Summing the book instead would print 3,15,000 for both.
    expect(text).not.toContain('3,15,000');
    expect(text).toContain('Mon 9 Mar  Sun 15 Mar 2026');
    expect(text).toContain('Tue 10: Hallmark re-check pending');
    expect(text).not.toContain('44,444'); // 1 Mar is another week
  });

  it('a month runs week by week, clipped to the month', async () => {
    const res = await sheet('mgr', `storeId=${A.store}&period=month&date=2026-03-20`).expect(200);
    const text = pdfText(res.body);
    expect(text).toContain('Mar 2026');
    for (const w of ['Week 1|', 'Week 6|', '1 Mar|', '30–31 Mar|']) expect(text).toContain(w.replace('–', '\x96'));
    expect(text).not.toContain('Week 7');
    expect(text).toContain('1,11,110'); // every bank transfer in March
    expect(text).toContain('|35|'); // walk-ins 5 + 10 + 12 + 8
    expect(res.body.length).toBeGreaterThan(1500);
  });

  it('a salesperson gets their own store only, and the period is checked', async () => {
    await sheet('rep2', `storeId=${A.store}&period=week&date=2026-03-10`).expect(403);
    await sheet('rep', `storeId=${A.other}&period=day&date=2026-03-10`).expect(403);
    await sheet('rep2', `storeId=${A.other}&period=month&date=2026-03-10`).expect(200);
    await sheet('rep', `storeId=${A.store}&period=year&date=2026-03-10`).expect(400);
    await sheet('rep', `storeId=all&period=day`).expect(400);
  });

  it('the same sheet as a workbook: real cells, real numbers, and a Total that adds up', async () => {
    const res = await sheet(
      'mgr',
      `storeId=${A.store}&period=week&date=2026-03-12&format=xlsx`,
      'daily/sheet',
    ).expect(200);
    expect(res.headers['content-type']).toContain(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.headers['content-disposition']).toContain('DSR-Surat-Main-week-2026-03-12.xlsx');
    // A zip, not a CSV with the wrong extension.
    expect(res.body.subarray(0, 2).toString()).toBe('PK');
    expect(res.body.length).toBeGreaterThan(4000);

    const wb = new Workbook();
    await wb.xlsx.load(res.body);
    const ws = wb.getWorksheet('DSR')!;
    const row = (label: string) => {
      for (let i = 1; i <= ws.rowCount; i += 1) {
        if (String(ws.getRow(i).getCell(1).value ?? '').trim() === label) return ws.getRow(i);
      }
      throw new Error(`no "${label}" row in the workbook`);
    };
    // Mon 9 … Sun 15 plus Total: eight value columns after the labels.
    const head = row('');
    expect(head.getCell(2).value).toBe('Mon\n9 Mar');
    expect(head.getCell(9).value).toBe('Total');

    // Figures, not strings — the owner sums this file.
    const bank = row('Bank Transfer');
    expect(bank.getCell(2).value).toBe(11111); // Mon 9
    expect(bank.getCell(3).value).toBe(22222); // Tue 10
    expect(bank.getCell(4).value ?? null).toBeNull(); // Wed 11: nothing filed
    expect(bank.getCell(9).value).toBe(66666);
    expect(bank.getCell(9).numFmt).toBe('#,##,##0');

    // The Total column is the row's own columns added up, every row.
    for (const label of ['Walkins', 'Bank Transfer', 'Amount Received']) {
      const r = row(label);
      const days = [2, 3, 4, 5, 6, 7, 8].map((c) => Number(r.getCell(c).value ?? 0));
      expect(r.getCell(9).value).toBe(days.reduce((a, b) => a + b, 0));
    }
    expect(row('Walkins').getCell(9).value).toBe(30);
    // Gold weight keeps its grams, to three decimals.
    expect(row('Gold Weight (g)').getCell(9).numFmt).toBe('#,##,##0.000');
    // The booking book is a balance: its Total is not the week's sum.
    expect(row('Open Bookings').getCell(9).value).toBe(100000);
    expect(String(ws.getCell(`A${ws.rowCount}`).value)).toContain('Hallmark re-check pending');
  });

  it('the sheet route still serves the PDF, and daily/pdf is the same file', async () => {
    const res = await sheet(
      'rep',
      `storeId=${A.store}&period=day&date=2026-03-10&format=pdf`,
      'daily/sheet',
    ).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('DSR-Surat-Main-day-2026-03-10.pdf');
    expect(pdfText(res.body)).toContain('22,222');
    await sheet('rep', `storeId=${A.store}&period=day&date=2026-03-10&format=xlsx`, 'daily/sheet')
      .expect(200);
    await sheet('rep', `storeId=${A.store}&period=day&date=2026-03-10&format=ods`, 'daily/sheet')
      .expect(400);
  });

  it('sending the sheet is a no-op on a channel this deployment has not configured', async () => {
    for (const [channel, to] of [
      ['email', 'owner@example.com'],
      ['whatsapp', '9876500000'],
    ] as const) {
      const res = await request(server())
        .post('/reporting/daily/sheet/send')
        .set(as('mgr'))
        .send({ storeId: A.store, period: 'week', date: '2026-03-12', format: 'xlsx', channel, to })
        .expect(201);
      expect(res.body).toMatchObject({ sent: false, disabled: true, channel });
      expect(res.body.preview).toContain('Surat Main');
      expect(res.body.filename).toBe('DSR-Surat-Main-week-2026-03-12.xlsx');
    }
    // Masked in the trail, and never the raw recipient.
    const [log] = await prisma.auditLog.findMany({
      where: {
        organisationId: A.org,
        action: 'report.send_dsr_sheet',
        summary: { contains: 'via whatsapp' },
      },
    });
    expect(log.summary).toContain('******0000');
    expect(log.summary).not.toContain('9876500000');
  });

  it('sending is manager+ and stops at the store boundary, and the recipient is checked', async () => {
    const send = (who: string, body: Record<string, unknown>) =>
      request(server()).post('/reporting/daily/sheet/send').set(as(who)).send({
        period: 'day',
        date: '2026-03-10',
        channel: 'whatsapp',
        to: '9876500000',
        ...body,
      });
    await send('mgr2', { storeId: A.store }).expect(403); // another branch's takings
    await send('rep', { storeId: A.store }).expect(403); // a salesperson does not send
    await send('mgr', { storeId: A.store, to: '12345' }).expect(400);
    await send('mgr', { storeId: 'all' }).expect(400);
  });
});
