import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

/** Everything printed on a detailed quote, already resolved and in scope. */
export interface QuotePdfData {
  business: {
    name: string;
    branch: string;
    address: string[];
    phone: string | null;
    gstin: string | null;
  };
  ref: string;
  revision: number;
  createdAt: string;
  validUntil: string | null;
  customer: { name: string; phone: string };
  kind: 'sale' | 'repair';
  isKaccha: boolean;
  remarks: string;
  lines: {
    description: string;
    karat: number;
    weightGrams: number;
    goldRatePerGram: number;
    makingCharges: number;
    stoneCharges: number;
    caratWeight: number;
    perCaratRate: number | null;
  }[];
  discountPercent: number;
  totals: {
    metalValue: number;
    makingCharges: number;
    stoneCharges: number;
    discount: number;
    taxable: number;
    gst: number;
    grandTotal: number;
  };
  /** Present when a manager approved this revision. */
  approval: { approvedTotal: number; decidedAt: string | null } | null;
  generatedAt: Date;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 40;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.82, 0.82, 0.85);

/** Money as printed: `Rs. 1,23,456.00`. The standard PDF fonts have no rupee glyph. */
function rs(amount: number): string {
  return `Rs. ${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)}`;
}

function num(value: number, digits: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * A server-rendered, itemised quote.
 *
 * Built with the 14 standard PDF fonts, so nothing has to be embedded and the
 * file stays small enough for WhatsApp. Their encoding is WinAnsi: a character
 * outside it (a Devanagari customer name, the rupee sign) would make pdf-lib
 * throw, so text is filtered to what the font can draw and money is written
 * as "Rs.". A name printed with a "?" beats a quote that cannot be produced.
 */
export async function renderQuotePdf(data: QuotePdfData): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Quotation ${data.ref}`);
  pdf.setAuthor(data.business.name);
  pdf.setCreator('CaratOS');
  pdf.setCreationDate(data.generatedAt);

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const drawable = new Set(regular.getCharacterSet());
  const clean = (text: string) =>
    [...text.replace(/[\r\n\t]+/g, ' ')]
      .map((ch) => (drawable.has(ch.codePointAt(0)!) ? ch : '?'))
      .join('');

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - MARGIN;
  const right = A4[0] - MARGIN;

  const text = (
    value: string,
    x: number,
    opts: { size?: number; font?: PDFFont; color?: typeof INK; align?: 'left' | 'right'; width?: number } = {},
  ) => {
    const size = opts.size ?? 9;
    const font = opts.font ?? regular;
    let s = clean(value);
    if (opts.width) {
      while (s.length > 1 && font.widthOfTextAtSize(s, size) > opts.width) s = `${s.slice(0, -2)}…`;
    }
    const w = font.widthOfTextAtSize(s, size);
    page.drawText(s, { x: opts.align === 'right' ? x - w : x, y, size, font, color: opts.color ?? INK });
  };
  const rule = (gap = 6) => {
    page.drawLine({ start: { x: MARGIN, y }, end: { x: right, y }, thickness: 0.6, color: RULE });
    y -= gap;
  };
  const ensure = (height: number) => {
    if (y - height >= MARGIN + 30) return;
    page = pdf.addPage(A4);
    y = A4[1] - MARGIN;
  };

  /* ---------------------------------------------------------- letterhead */
  text(data.business.name, MARGIN, { size: 16, font: bold });
  text('QUOTATION', right, { size: 16, font: bold, align: 'right' });
  y -= 16;
  text(data.business.branch, MARGIN, { size: 10 });
  text(data.ref, right, { size: 11, font: bold, align: 'right' });
  y -= 12;
  for (const line of data.business.address) {
    text(line, MARGIN, { color: MUTED });
    y -= 11;
  }
  if (data.business.phone) {
    text(`Phone: ${data.business.phone}`, MARGIN, { color: MUTED });
    y -= 11;
  }
  if (data.business.gstin) {
    text(`GSTIN: ${data.business.gstin}`, MARGIN, { color: MUTED });
    y -= 11;
  }
  y -= 4;
  rule(16);

  /* ------------------------------------------------------- quote details */
  const detailTop = y;
  text('Prepared for', MARGIN, { color: MUTED, size: 8 });
  y -= 12;
  text(data.customer.name, MARGIN, { size: 11, font: bold, width: 260 });
  y -= 12;
  text(data.customer.phone, MARGIN);

  y = detailTop;
  const details: [string, string][] = [
    ['Quote date', data.createdAt],
    ['Valid until', data.validUntil || 'Not specified'],
    ['Type', data.kind === 'repair' ? 'Repair (making only)' : data.isKaccha ? 'Estimate (excl. GST)' : 'Sale'],
    ['Revision', String(data.revision)],
  ];
  for (const [label, value] of details) {
    text(label, right - 150, { color: MUTED, size: 8 });
    text(value, right, { align: 'right' });
    y -= 12;
  }
  y = Math.min(y, detailTop - 36) - 8;
  rule(14);

  /* --------------------------------------------------------- itemisation */
  // `x` is the left edge of a left-aligned column and the right edge of a
  // right-aligned one, so figures line up on their last digit.
  const cols = [
    { title: '#', x: MARGIN, align: 'left' as const },
    { title: 'Description', x: MARGIN + 16, align: 'left' as const },
    { title: 'Purity', x: MARGIN + 185, align: 'right' as const },
    { title: 'Wt (g)', x: MARGIN + 235, align: 'right' as const },
    { title: 'Gold rate/g', x: MARGIN + 300, align: 'right' as const },
    { title: 'Metal', x: MARGIN + 370, align: 'right' as const },
    { title: 'Making', x: MARGIN + 440, align: 'right' as const },
    { title: 'Diamond', x: right, align: 'right' as const },
  ];
  const header = () => {
    for (const c of cols) text(c.title, c.x, { font: bold, size: 8, align: c.align });
    y -= 6;
    rule(12);
  };
  header();

  data.lines.forEach((line, i) => {
    const hasStone = line.caratWeight > 0 || line.perCaratRate != null;
    ensure(hasStone ? 34 : 24);
    if (y > A4[1] - MARGIN - 1) header();
    const metal = data.kind === 'repair' ? 0 : line.weightGrams * line.goldRatePerGram;
    const stone = data.kind === 'repair' ? 0 : line.stoneCharges;
    const cells = [
      String(i + 1),
      line.description,
      line.karat > 0 ? `${line.karat}K` : '-',
      num(line.weightGrams, 3),
      data.kind === 'repair' ? '-' : num(line.goldRatePerGram, 2),
      num(metal, 2),
      num(line.makingCharges, 2),
      num(stone, 2),
    ];
    cols.forEach((c, idx) =>
      text(cells[idx], c.x, { size: 8, align: c.align, width: idx === 1 ? 128 : undefined }),
    );
    y -= 10;
    if (hasStone && data.kind !== 'repair') {
      const rate = line.perCaratRate != null ? ` @ ${rs(line.perCaratRate)}/ct` : '';
      text(`${num(line.caratWeight, 3)} ct${rate}`, cols[1].x, { size: 7, color: MUTED, width: 250 });
      y -= 10;
    }
    y -= 4;
  });
  rule(14);

  /* ------------------------------------------------------- rate snapshot */
  const goldRates = new Map<string, number>();
  for (const l of data.lines) {
    if (data.kind !== 'repair' && l.weightGrams > 0) goldRates.set(`${l.karat}K`, l.goldRatePerGram);
  }
  if (goldRates.size) {
    ensure(24);
    const rates = [...goldRates].map(([k, r]) => `${k} gold ${rs(r)}/g`).join('   ');
    text(`Rates used on ${data.createdAt}: ${rates}`, MARGIN, { size: 8, color: MUTED, width: right - MARGIN });
    y -= 16;
  }

  /* -------------------------------------------------------------- totals */
  ensure(150);
  const labelX = right - 250;
  const row = (label: string, value: string, strong = false) => {
    text(label, labelX, { font: strong ? bold : regular, size: strong ? 10 : 9, width: 165 });
    text(value, right, { font: strong ? bold : regular, size: strong ? 10 : 9, align: 'right' });
    y -= strong ? 15 : 12;
  };
  if (data.kind !== 'repair') row('Metal value', rs(data.totals.metalValue));
  row(data.kind === 'repair' ? 'Making / labour' : 'Making charges', rs(data.totals.makingCharges));
  if (data.kind !== 'repair') row('Diamond / stones', rs(data.totals.stoneCharges));
  if (data.totals.discount > 0) {
    row(`Discount ${data.discountPercent}% on making & stones`, `- ${rs(data.totals.discount)}`);
  }
  row('Taxable value', rs(data.totals.taxable));
  row(data.isKaccha ? 'GST (estimate, not charged)' : 'GST @ 3%', rs(data.totals.gst));
  y -= 2;
  page.drawLine({ start: { x: labelX, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 0.6, color: RULE });
  row('Grand total', rs(data.totals.grandTotal), true);
  if (data.approval) {
    row('Approved total', rs(data.approval.approvedTotal), true);
    text(
      `Approved by a manager${data.approval.decidedAt ? ` on ${data.approval.decidedAt}` : ''} for revision ${data.revision}.`,
      right,
      { size: 7, color: MUTED, align: 'right' },
    );
    y -= 12;
  }

  if (data.remarks.trim()) {
    ensure(30);
    y -= 6;
    text('Remarks', MARGIN, { size: 8, color: MUTED });
    y -= 11;
    text(data.remarks, MARGIN, { size: 9, width: right - MARGIN });
    y -= 12;
  }

  /* -------------------------------------------------------------- footer */
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    y = MARGIN;
    const terms = data.validUntil
      ? `Prices are valid until ${data.validUntil}. Gold rates are as on the quote date.`
      : 'Gold rates are as on the quote date and may change.';
    text(terms, MARGIN, { size: 7, color: MUTED, width: right - MARGIN - 60 });
    text(`Page ${i + 1} of ${pages.length}`, right, { size: 7, color: MUTED, align: 'right' });
    y = MARGIN - 10;
    text(
      `${data.ref} revision ${data.revision} - generated ${data.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      MARGIN,
      { size: 7, color: MUTED },
    );
  });

  // Classic cross-reference table rather than object streams: older PDF
  // readers (and some phone previewers) still cannot open the latter.
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
