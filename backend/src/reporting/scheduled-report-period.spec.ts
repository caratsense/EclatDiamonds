import { CheckinsService } from '../checkins/checkins.service';
import { PrismaService } from '../prisma/prisma.service';
import { StoreScopeService } from '../common/store-scope.service';
import { ScheduledReportsService } from './scheduled-reports.service';

/**
 * A scheduled workbook says which period it covers.
 *
 * The About tab exists to answer the one question a spreadsheet on a desk
 * cannot otherwise answer — is this a quiet month or a narrow filter? Every
 * scheduled walk-ins workbook answered "All time" on rows that were bounded to
 * one month, because the scheduler handed the exporter two instants and no
 * words, and the exporter's fallback for "no range given" is "All time".
 *
 * Pinned through the file that actually leaves the building — the attachment on
 * the email — rather than through the call the scheduler makes, because the
 * claim that was wrong was the one printed in the workbook.
 */

const IST = 'Asia/Kolkata';
/** A November morning: the completed month is October 2026. */
const NOW = new Date('2026-11-02T04:00:00Z');

function harness() {
  const sent: Array<{ subject: string; buffer: Buffer }> = [];

  const checkinPrisma = {
    checkIn: {
      findMany: async () => [
        {
          id: 'ci_1',
          timeIn: new Date('2026-10-14T05:30:00Z'),
          customerName: 'Priya Shah',
          phone: '+919876500000',
          purpose: 'bridal',
          outcome: 'purchased',
          repName: 'Rekha',
          managerName: null,
          recommendedAction: null,
          referralName: null,
          referralPhone: null,
          deliveryDate: null,
          npsMessageSentAt: null,
          npsResponseReceivedAt: null,
          googleReviewTaken: true,
          remark: null,
          metadata: {},
          store: { name: 'Bandra', timezone: IST },
        },
      ],
    },
  } as unknown as PrismaService;

  // Everything the walk-ins export never reaches: it reads rows and writes a
  // workbook, and touches none of the collaborators below.
  const unused = null as never;
  const checkins = new CheckinsService(
    checkinPrisma,
    { storeFilter: () => ({ storeId: 'store_bandra' }) } as unknown as StoreScopeService,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
  );

  const report = {
    id: 'rep_walkins',
    organisationId: 'org_nibhana',
    storeId: 'store_bandra',
    name: 'Monthly walk-ins',
    kind: 'walkins',
    cadence: 'monthly',
    columns: [] as string[],
    recipients: ['owner@nibhana.example'],
    phoneRecipients: [] as string[],
    store: { id: 'store_bandra', name: 'Bandra', timezone: IST },
  };

  const prisma = {
    scheduledReport: {
      findUnique: async () => report,
      update: async () => report,
    },
    scheduledReportRun: {
      create: async () => ({ id: 'run_1' }),
      update: async () => ({ id: 'run_1' }),
    },
  } as unknown as PrismaService;

  const service = new ScheduledReportsService(
    prisma,
    {} as unknown as StoreScopeService,
    {} as never,
    {
      send: async (
        _to: string,
        subject: string,
        _body: string,
        attachments?: Array<{ content: Buffer }>,
      ) => {
        sent.push({ subject, buffer: attachments![0].content });
        return { sent: true, dryRun: false, to: _to };
      },
    } as never,
    {} as never,
    {} as never,
    {} as never,
    checkins,
  );

  return { service, sent };
}

/** What the About tab states under "Covers". */
async function coversOf(buffer: Buffer): Promise<string> {
  const { Workbook } = await import('exceljs');
  const wb = new Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.getWorksheet('About');
  if (!ws) throw new Error('the workbook has no About tab');
  let covers = '';
  ws.eachRow((row) => {
    if (String(row.getCell(1).value) === 'Covers') covers = String(row.getCell(2).value);
  });
  return covers;
}

describe('the workbook a scheduled walk-ins report sends', () => {
  it('states the period it covers, not "All time"', async () => {
    const { service, sent } = harness();
    const period = service.monthEnding(NOW, IST);

    await service.runFor('rep_walkins', period);

    expect(sent).toHaveLength(1);
    const covers = await coversOf(sent[0].buffer);
    // The same words the email subject already uses: a reader comparing the
    // mail and the attachment must not be told two different things.
    expect(covers).toBe(period.label);
    expect(sent[0].subject).toContain(period.label);
    expect(covers).not.toBe('All time');
  });
});
