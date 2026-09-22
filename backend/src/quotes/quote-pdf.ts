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
    styleNumber: string | null;
    size: string | null;
    metalCode: string | null;
    makingRatePerGram: number | null;
    stones: {
      type: 'D' | 'C';
      code: string;
      name?: string;
      size?: string;
      pieces?: number;
      carats: number;
      ratePerCt: number;
      multiplier: number;
      amount: number;
    }[];
  }[];
  makingDiscountPercent: number;
  stoneDiscountPercent: number;
  totals: {
    metalValue: number;
    makingCharges: number;
    stoneCharges: number;
    discount: number;
    makingDiscount: number;
    stoneDiscount: number;
    additionalDiscount: number;
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
const BAND = rgb(0.95, 0.95, 0.96);

/** Money as printed: `Rs. 1,23,456.00`. The standard PDF fonts have no rupee glyph. */
function rs(amount: number): string {
  return `Rs. ${num(amount, 2)}`;
}

function num(value: number, digits: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

const pct = (p: number) => `${num(p, Number.isInteger(p) ? 0 : 2)}%`;

const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function words(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) return [TENS[Math.floor(n / 10)], ONES[n % 10]].filter(Boolean).join(' ');
  if (n < 1000) return [`${ONES[Math.floor(n / 100)]} Hundred`, words(n % 100)].filter(Boolean).join(' ');
  // Indian grouping: thousand, lakh, crore — and crores of crores.
  for (const [size, name] of [[1e7, 'Crore'], [1e5, 'Lakh'], [1e3, 'Thousand']] as const) {
    if (n >= size) return [`${words(Math.floor(n / size))} ${name}`, words(n % size)].filter(Boolean).join(' ');
  }
  return '';
}

/** "Rupees One Lakh Twenty Three Thousand … and Fifty Paise Only", as a bill says it. */
export function rupeesInWords(amount: number): string {
  const paiseTotal = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  return `Rupees ${words(rupees) || 'Zero'}${paise ? ` and ${words(paise)} Paise` : ''} Only`;
}

/**
 * A server-rendered quote, laid out like the shop's bill: each item with its
 * size and style, then what it is made of — metal, making, diamonds and colour
 * stones by item code, with weight, rate, discount and amount.
 *
 * Built with the 14 standard PDF fonts, so nothing has to be embedded and the
 * file stays small enough for WhatsApp. Their encoding is WinAnsi: a character
 * outside it (a Devanagari customer name, the rupee sign) would make pdf-lib
 * throw, so text is filtered to what the font can draw and money is written
 * as "Rs.". A name printed with a "?" beats a quote that cannot be produced.
 *
 * The stone multiplier is the staff's pricing lever and is never printed: the
 * customer's rate per carat is the rate with it already applied.
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
  const repair = data.kind === 'repair';

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
    if (y - height >= MARGIN + 30) return false;
    page = pdf.addPage(A4);
    y = A4[1] - MARGIN;
    return true;
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
    ['Type', repair ? 'Repair (making only)' : data.isKaccha ? 'Estimate (excl. GST)' : 'Sale'],
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
    { title: 'Material', x: MARGIN + 12, align: 'left' as const },
    { title: 'Pcs', x: MARGIN + 262, align: 'right' as const },
    { title: 'Weight', x: MARGIN + 322, align: 'right' as const },
    { title: 'Rate', x: MARGIN + 392, align: 'right' as const },
    { title: 'Disc.', x: MARGIN + 432, align: 'right' as const },
    { title: 'Amount', x: right, align: 'right' as const },
  ];
  const header = () => {
    for (const c of cols) text(c.title, c.x, { font: bold, size: 8, align: c.align });
    y -= 6;
    rule(12);
  };
  const row = (cells: string[], color = INK) => {
    if (ensure(12)) header();
    cols.forEach((c, i) =>
      text(cells[i] ?? '', c.x, { size: 8, align: c.align, color, width: i === 0 ? 240 : undefined }),
    );
    y -= 11;
  };
  header();

  data.lines.forEach((line, i) => {
    if (ensure(40)) header();
    // The item: what it is, its design and its size.
    page.drawRectangle({ x: MARGIN, y: y - 3, width: right - MARGIN, height: 13, color: BAND });
    text(`${i + 1}. ${line.description}`, MARGIN + 2, { size: 9, font: bold, width: 250 });
    const meta = [
      line.styleNumber ? `Style ${line.styleNumber}` : '',
      line.size ? `Size ${line.size}` : '',
    ].filter(Boolean);
    if (meta.length) text(meta.join('   '), right - 2, { size: 8, align: 'right' });
    y -= 15;

    if (!repair && line.weightGrams > 0) {
      const metal = line.metalCode ? `${line.metalCode}  ${line.karat}K gold` : `${line.karat}K gold`;
      row([metal, '', `${num(line.weightGrams, 3)} g`, num(line.goldRatePerGram, 2), '', num(line.weightGrams * line.goldRatePerGram, 2)]);
    }
    if (line.makingCharges > 0) {
      row([
        repair ? 'Making / labour' : 'Making charges',
        '',
        line.makingRatePerGram != null ? `${num(line.weightGrams, 3)} g` : '',
        line.makingRatePerGram != null ? num(line.makingRatePerGram, 2) : '',
        data.makingDiscountPercent > 0 ? pct(data.makingDiscountPercent) : '',
        num(line.makingCharges, 2),
      ]);
    }
    if (!repair) {
      const stoneDisc = data.stoneDiscountPercent > 0 ? pct(data.stoneDiscountPercent) : '';
      for (const s of line.stones) {
        const label = [s.type, s.code, s.size].filter(Boolean).join('  ');
        row([label, s.pieces ? String(s.pieces) : '', `${num(s.carats, 2)} ct`, num(s.ratePerCt * s.multiplier, 2), stoneDisc, num(s.amount, 2)]);
      }
      // A line priced before stones were itemised.
      if (!line.stones.length && line.stoneCharges > 0) {
        row([
          'Diamonds / stones',
          '',
          line.caratWeight > 0 ? `${num(line.caratWeight, 2)} ct` : '',
          line.perCaratRate != null ? num(line.perCaratRate, 2) : '',
          stoneDisc,
          num(line.stoneCharges, 2),
        ]);
      }
    }
    y -= 4;
  });
  rule(14);

  /* ------------------------------------------------------- rate snapshot */
  const goldRates = new Map<string, number>();
  for (const l of data.lines) {
    if (!repair && l.weightGrams > 0) goldRates.set(`${l.karat}K`, l.goldRatePerGram);
  }
  if (goldRates.size) {
    ensure(24);
    const rates = [...goldRates].map(([k, r]) => `${k} gold ${rs(r)}/g`).join('   ');
    text(`Rates used on ${data.createdAt}: ${rates}`, MARGIN, { size: 8, color: MUTED, width: right - MARGIN });
    y -= 16;
  }

  /* -------------------------------------------------------------- totals */
  ensure(200);
  const labelX = right - 250;
  const total = (label: string, value: string, strong = false) => {
    text(label, labelX, { font: strong ? bold : regular, size: strong ? 10 : 9, width: 165 });
    text(value, right, { font: strong ? bold : regular, size: strong ? 10 : 9, align: 'right' });
    y -= strong ? 15 : 12;
  };
  const t = data.totals;
  if (!repair) total('Metal value', rs(t.metalValue));
  total(repair ? 'Making / labour' : 'Making charges', rs(t.makingCharges));
  if (!repair) total('Diamonds & stones', rs(t.stoneCharges));
  if (t.makingDiscount > 0) total(`Less: making discount ${pct(data.makingDiscountPercent)}`, `- ${rs(t.makingDiscount)}`);
  if (t.stoneDiscount > 0) total(`Less: diamond discount ${pct(data.stoneDiscountPercent)}`, `- ${rs(t.stoneDiscount)}`);
  if (t.additionalDiscount > 0) total('Less: additional discount', `- ${rs(t.additionalDiscount)}`);
  total('Taxable value', rs(t.taxable));
  total(data.isKaccha ? 'GST (estimate, not charged)' : 'GST @ 3%', rs(t.gst));
  y -= 2;
  page.drawLine({ start: { x: labelX, y: y + 8 }, end: { x: right, y: y + 8 }, thickness: 0.6, color: RULE });
  total('Grand total', rs(t.grandTotal), true);
  text(rupeesInWords(t.grandTotal), right, { size: 8, color: MUTED, align: 'right', width: right - MARGIN });
  y -= 14;
  if (data.approval) {
    total('Approved total', rs(data.approval.approvedTotal), true);
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

  /* --------------------------------------------------------------- terms */
  ensure(50);
  y -= 8;
  text('Terms', MARGIN, { size: 8, font: bold });
  y -= 11;
  for (const term of [
    data.validUntil
      ? `Prices are valid until ${data.validUntil}. Gold is priced at the rate on the quote date.`
      : 'Gold is priced at the rate on the quote date and may change until the order is confirmed.',
    'The finished piece may differ slightly in weight; the bill follows the actual weight and stones.',
    repair ? 'Repair charges are for the work described.' : 'GST is charged as shown.',
  ]) {
    text(`- ${term}`, MARGIN, { size: 7.5, color: MUTED, width: right - MARGIN });
    y -= 10;
  }

  /* -------------------------------------------------------------- footer */
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    y = MARGIN - 10;
    text(
      `${data.ref} revision ${data.revision} - generated ${data.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      MARGIN,
      { size: 7, color: MUTED },
    );
    text(`Page ${i + 1} of ${pages.length}`, right, { size: 7, color: MUTED, align: 'right' });
  });

  // Classic cross-reference table rather than object streams: older PDF
  // readers (and some phone previewers) still cannot open the latter.
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
