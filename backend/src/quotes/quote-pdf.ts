import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

/** Everything printed on a detailed quote, already resolved and in scope. */
export interface QuotePdfData {
  business: {
    name: string;
    branch: string;
    address: string[];
    phone: string | null;
    gstin: string | null;
    /** Printed under the address when the tenant has them on file. */
    email?: string | null;
    pan?: string | null;
    formerName?: string | null;
    bank?: {
      accountName?: string | null;
      bankName?: string | null;
      address?: string | null;
      accountNo?: string | null;
      ifsc?: string | null;
    } | null;
  };
  ref: string;
  revision: number;
  createdAt: string;
  validUntil: string | null;
  customer: { name: string; phone: string; address?: string | null; state?: string | null; gstin?: string | null; pan?: string | null };
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
    /** Only a made piece carries these; a quotation prints the labels empty. */
    huid?: string | null;
    hsn?: string | null;
    certificateNo?: string | null;
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
    sgst?: number;
    cgst?: number;
    roundOff?: number;
    grandTotal: number;
  };
  /** Present when a manager approved this revision. */
  /** What has already been paid against this quotation, by mode. */
  payments?: { mode: string; amount: number }[];
  approval: { approvedTotal: number; decidedAt: string | null } | null;
  generatedAt: Date;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 26;
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const RULE = rgb(0.55, 0.55, 0.6);

/** One carat is 0.2 g: the gross weight of a piece is its metal plus its stones. */
const CARAT_GRAMS = 0.2;

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

/**
 * "INR One Lakh Twenty Three Thousand … and Fifty Paise Only" — the prefix the
 * shop's own bill carries on this line, not "Rupees".
 */
export function rupeesInWords(amount: number): string {
  const paiseTotal = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  return `INR ${words(rupees) || 'Zero'}${paise ? ` and ${words(paise)} Paise` : ''} Only`;
}

/** A material row of the item table: what it is, how much, at what rate. */
interface MaterialRow {
  code: string;
  pieces?: number;
  /** Grams for metal, carats for a stone; blank for making. */
  weight?: string;
  rate?: number;
  discountPercent?: number;
  amount: number;
}

/** The rows one quote line prints: its metal, its stones, then its making. */
function materialRows(
  line: QuotePdfData['lines'][number],
  data: QuotePdfData,
): { rows: MaterialRow[]; grossWeight: number; total: number } {
  const repair = data.kind === 'repair';
  const rows: MaterialRow[] = [];
  if (!repair && line.weightGrams > 0) {
    rows.push({
      code: [line.metalCode, line.karat ? `${line.karat}KT` : ''].filter(Boolean).join('  '),
      weight: `${num(line.weightGrams, 3)} g`,
      rate: line.goldRatePerGram,
      amount: line.weightGrams * line.goldRatePerGram,
    });
  }
  if (!repair) {
    for (const s of line.stones) {
      rows.push({
        code: [s.type, s.code, s.size].filter(Boolean).join(' '),
        pieces: s.pieces,
        weight: `${num(s.carats, 2)} ct`,
        // The multiplier is the shop's lever; the customer's rate has it in.
        rate: s.ratePerCt * s.multiplier,
        discountPercent: data.stoneDiscountPercent || undefined,
        amount: s.amount * (1 - (data.stoneDiscountPercent || 0) / 100),
      });
    }
    if (!line.stones.length && line.stoneCharges > 0) {
      rows.push({
        code: 'Diamonds / stones',
        weight: line.caratWeight > 0 ? `${num(line.caratWeight, 2)} ct` : undefined,
        rate: line.perCaratRate ?? undefined,
        discountPercent: data.stoneDiscountPercent || undefined,
        amount: line.stoneCharges * (1 - (data.stoneDiscountPercent || 0) / 100),
      });
    }
  }
  if (line.makingCharges > 0) {
    rows.push({
      code: repair ? 'Repair / labour' : 'Making',
      weight: line.makingRatePerGram != null ? `${num(line.weightGrams, 3)} g` : undefined,
      rate: line.makingRatePerGram ?? undefined,
      discountPercent: data.makingDiscountPercent || undefined,
      amount: line.makingCharges * (1 - (data.makingDiscountPercent || 0) / 100),
    });
  }
  const stoneCarats = line.stones.reduce((sum, s) => sum + s.carats, 0) || line.caratWeight;
  return {
    rows,
    grossWeight: repair ? 0 : line.weightGrams + stoneCarats * CARAT_GRAMS,
    total: rows.reduce((sum, r) => sum + r.amount, 0),
  };
}

/**
 * The quote on the shop's own bill layout: the same header, the same
 * Billed-To / Shipped-To pair, the same item grid down to Gr Wt, Net Wt, Rate,
 * Dis% and Tot Amt, the same tax split and the same terms. A customer holding a
 * quote and an invoice side by side should be reading one document twice.
 *
 * Built with the 14 standard PDF fonts, so nothing is embedded and the file
 * stays small enough for WhatsApp. Their encoding is WinAnsi, so text is
 * filtered to what the font can draw and money is written as "Rs.".
 *
 * A quotation is NOT a tax invoice: the per-piece facts that only exist once a
 * piece is made (HUID, certificate number) are left out rather than faked, and
 * the document says what it is at the foot.
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
  const right = A4[0] - MARGIN;
  const width = right - MARGIN;
  let y = A4[1] - MARGIN;

  const text = (
    value: string,
    x: number,
    opts: { size?: number; font?: PDFFont; color?: typeof INK; align?: 'left' | 'right' | 'center'; width?: number; at?: number } = {},
  ) => {
    const size = opts.size ?? 7.5;
    const font = opts.font ?? regular;
    let s = clean(value);
    if (opts.width) {
      while (s.length > 1 && font.widthOfTextAtSize(s, size) > opts.width) s = `${s.slice(0, -2)}…`;
    }
    const w = font.widthOfTextAtSize(s, size);
    const at = opts.at ?? y;
    const px = opts.align === 'right' ? x - w : opts.align === 'center' ? x - w / 2 : x;
    page.drawText(s, { x: px, y: at, size, font, color: opts.color ?? INK });
  };
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 0.5, color: RULE });
  const box = (x: number, top: number, w: number, h: number) =>
    page.drawRectangle({ x, y: top - h, width: w, height: h, borderWidth: 0.5, borderColor: RULE });

  /* ----------------------------------------------------------- letterhead */
  const headerTop = y;
  const headerHeight = 54;
  box(MARGIN, headerTop, width, headerHeight);
  y = headerTop - 12;
  text(data.business.name.toUpperCase(), MARGIN + width / 2, { size: 10.5, font: bold, align: 'center' });
  if (data.business.formerName) {
    y -= 9;
    text(`( FORMERLY KNOWN AS ${data.business.formerName.toUpperCase()} )`, MARGIN + width / 2, { size: 6.5, align: 'center' });
  }
  y -= 9;
  text([data.business.branch, ...data.business.address].filter(Boolean).join(', '), MARGIN + width / 2, {
    size: 7,
    align: 'center',
    width: width - 16,
  });
  y -= 9;
  text(
    [data.business.email ? `Email : ${data.business.email}` : '', data.business.phone ? `Tel : ${data.business.phone}` : '']
      .filter(Boolean)
      .join('    '),
    MARGIN + width / 2,
    { size: 7, align: 'center' },
  );
  y -= 9;
  text(
    [data.business.pan ? `Pan No : ${data.business.pan}` : '', data.business.gstin ? `GST No : ${data.business.gstin}` : '']
      .filter(Boolean)
      .join('    '),
    MARGIN + width / 2,
    { size: 7, align: 'center' },
  );

  y = headerTop - headerHeight;
  const titleHeight = 14;
  box(MARGIN, y, width, titleHeight);
  text(data.kind === 'repair' ? 'Repair Quotation' : data.isKaccha ? 'Estimate' : 'Quotation', MARGIN + width / 2, {
    size: 9,
    font: bold,
    align: 'center',
    at: y - 10,
  });
  y -= titleHeight;

  /* --------------------------------------------------- billed to / shipped */
  const partyTop = y;
  const partyHeight = 94;
  const mid = MARGIN + width / 2;
  box(MARGIN, partyTop, width, partyHeight);
  line(mid, partyTop, mid, partyTop - partyHeight);

  const pair = (label: string, value: string, x: number, at: number, labelWidth = 74) => {
    text(label, x + 4, { size: 7, at });
    text(`: ${value}`, x + 4 + labelWidth, { size: 7, at, width: width / 2 - labelWidth - 12 });
  };
  let ly = partyTop - 11;
  pair('BILL NO', data.ref, MARGIN, ly);
  pair('DATE', data.createdAt, mid, ly);
  ly -= 11;
  text('Details of the Receiver (Billed To) :', MARGIN + 4, { size: 7, font: bold, at: ly });
  text('Details of Consignee (Shipped To) :', mid + 4, { size: 7, font: bold, at: ly });
  ly -= 11;
  for (const [label, value] of [
    ['Customer', data.customer.name],
    ['Address', data.customer.address ?? ''],
    ['State', data.customer.state ?? ''],
    ['GSTIN', data.customer.gstin ?? ''],
    ['PAN', data.customer.pan ?? ''],
    ['Mobile No', data.customer.phone],
  ] as const) {
    pair(label, value, MARGIN, ly);
    pair(label, value, mid, ly);
    ly -= 10;
  }
  y = partyTop - partyHeight;

  /* --------------------------------------------------------- item grid */
  // Columns as the bill has them; widths scaled to the page.
  const cols = [
    { key: 'sr', title: 'Sr', w: 16, align: 'center' as const },
    { key: 'product', title: 'Product', w: 62, align: 'left' as const },
    { key: 'item', title: 'Item No', w: 44, align: 'left' as const },
    { key: 'detail', title: '', w: 96, align: 'left' as const },
    { key: 'code', title: 'Code', w: 88, align: 'left' as const },
    { key: 'gr', title: 'Gr Wt', w: 34, align: 'right' as const },
    { key: 'net', title: 'Net Wt', w: 36, align: 'right' as const },
    { key: 'rate', title: 'Rate', w: 42, align: 'right' as const },
    { key: 'dis', title: 'Dis%', w: 28, align: 'right' as const },
    { key: 'amount', title: 'Amount', w: 46, align: 'right' as const },
    { key: 'tot', title: 'Tot Amt', w: 47, align: 'right' as const },
  ];
  const colX: Record<string, { x: number; w: number; align: 'left' | 'right' | 'center' }> = {};
  let cx = MARGIN;
  for (const c of cols) {
    colX[c.key] = { x: cx, w: c.w, align: c.align };
    cx += c.w;
  }
  const cell = (key: string, value: string, at: number, opts: { font?: PDFFont; size?: number } = {}) => {
    const c = colX[key];
    const pad = 3;
    const x = c.align === 'right' ? c.x + c.w - pad : c.align === 'center' ? c.x + c.w / 2 : c.x + pad;
    text(value, x, { ...opts, align: c.align, at, width: c.w - pad * 2 });
  };
  const gridLines = (top: number, bottom: number) => {
    for (const c of cols) line(c === cols[0] ? MARGIN : colX[c.key].x, top, colX[c.key].x, bottom);
    line(right, top, right, bottom);
  };

  const tableTop = y;
  const headHeight = 13;
  line(MARGIN, tableTop, right, tableTop);
  for (const c of cols) cell(c.key, c.title, tableTop - 9, { font: bold, size: 6.8 });
  line(MARGIN, tableTop - headHeight, right, tableTop - headHeight);
  gridLines(tableTop, tableTop - headHeight);
  y = tableTop - headHeight;

  data.lines.forEach((l, i) => {
    const { rows, grossWeight, total } = materialRows(l, data);
    // The bill's own four labels, in its order, then the size the owner asked to
    // see here. HUID and the lab certificate belong to a piece that has been
    // made; on a quotation they print as empty fields, exactly as the blank
    // GSTIN and PAN fields above them do, rather than being dropped from the
    // form and leaving a page that no longer looks like the shop's bill.
    const details = [
      `HUID : ${l.huid ?? ''}`,
      `HSN No : ${l.hsn ?? ''}`,
      `StyleCode : ${l.styleNumber ?? ''}`,
      `J_Certi : ${l.certificateNo ?? ''}`,
      l.size ? `Size : ${l.size}` : '',
    ];
    const blockRows = Math.max(rows.length, details.length, 1);
    const blockHeight = blockRows * 10 + 6;
    const top = y;
    let ry = top - 9;

    cell('sr', String(i + 1), ry, { font: bold });
    cell('product', l.description, ry, { font: bold });
    cell('item', l.styleNumber ?? '', ry);
    cell('gr', grossWeight > 0 ? num(grossWeight, 3) : '', ry);
    cell('tot', num(total, 2), ry, { font: bold });

    details.forEach((d, k) => cell('detail', d, top - 9 - k * 10, { size: 6.6 }));
    rows.forEach((r, k) => {
      const at = top - 9 - k * 10;
      cell('code', r.code, at, { size: 6.8 });
      cell('net', r.weight ?? '', at);
      cell('rate', r.rate != null ? num(r.rate, 2) : '', at);
      cell('dis', r.discountPercent ? `-${pct(r.discountPercent)}` : '', at);
      cell('amount', num(r.amount, 2), at);
    });

    y = top - blockHeight;
    line(MARGIN, y, right, y);
    gridLines(top, y);
    ry = y;
  });

  // Keep the grid a fixed height so the form looks the same however many items
  // it carries, exactly as a printed book of bills does.
  const minBodyBottom = y - 24;
  if (y > minBodyBottom) {
    gridLines(y, minBodyBottom);
    line(MARGIN, minBodyBottom, right, minBodyBottom);
    y = minBodyBottom;
  }

  /* ------------------------------------------------------------- totals */
  const totalsRows: [string, string][] = [];
  const t = data.totals;
  if (t.discount > 0) totalsRows.push(['Less : Discount', `- ${num(t.discount, 2)}`]);
  totalsRows.push(['Taxable', num(t.taxable, 2)]);
  if (!data.isKaccha) {
    totalsRows.push(['1.5% SGST', num(t.sgst ?? t.gst / 2, 2)]);
    totalsRows.push(['1.5% CGST', num(t.cgst ?? t.gst / 2, 2)]);
  } else {
    totalsRows.push(['GST (estimate, not charged)', num(0, 2)]);
  }
  if (t.roundOff) totalsRows.push(['Rounding', num(t.roundOff, 2)]);

  const totalsTop = y;
  const labelX = right - 150;
  totalsRows.forEach((r, i) => {
    const at = totalsTop - 11 - i * 11;
    text(r[0], labelX, { size: 7, at });
    text(r[1], right - 4, { size: 7, align: 'right', at });
  });
  const rowsBottom = totalsTop - 11 - (totalsRows.length - 1) * 11;
  const totalAt = rowsBottom - 16;
  const totalsHeight = totalsTop - (totalAt - 8);
  line(labelX - 6, rowsBottom - 5, right, rowsBottom - 5);
  text('Total', labelX, { size: 8.5, font: bold, at: totalAt });
  text(num(t.grandTotal, 2), right - 4, { size: 8.5, font: bold, align: 'right', at: totalAt });
  box(labelX - 6, totalsTop, right - labelX + 6, totalsHeight);

  // Remarks sit beside the totals, as on the bill.
  box(MARGIN, totalsTop, labelX - 6 - MARGIN, totalsHeight);
  text('Remarks :', MARGIN + 4, { size: 7, font: bold, at: totalsTop - 10 });
  if (data.remarks.trim()) {
    text(data.remarks, MARGIN + 4, { size: 7, at: totalsTop - 21, width: labelX - MARGIN - 16 });
  }
  y = totalsTop - totalsHeight;

  /* ------------------------------------------------------- amount in words */
  const wordsHeight = 14;
  box(MARGIN, y, width, wordsHeight);
  text(rupeesInWords(t.grandTotal).toUpperCase(), MARGIN + 4, { size: 7, font: bold, at: y - 10 });
  y -= wordsHeight;

  /* ------------------------------------------------- bank and payment block */
  const bankTop = y;
  const bankHeight = 70;
  const payX = right - 190;
  const remarkX = MARGIN + 205;
  box(MARGIN, bankTop, width, bankHeight);
  line(payX, bankTop, payX, bankTop - bankHeight);
  const bank = data.business.bank ?? {};
  [
    ['A/C Name', bank.accountName ?? data.business.name],
    ['Bank Name', bank.bankName ?? ''],
    ['Bank Address', bank.address ?? ''],
    ['Bank A/C No', bank.accountNo ?? ''],
    ['Bank IFSC', bank.ifsc ?? ''],
  ].forEach(([label, value], i) => {
    const at = bankTop - 11 - i * 11;
    text(`${label} :`, MARGIN + 4, { size: 7, at });
    text(String(value), MARGIN + 62, { size: 7, at, width: remarkX - MARGIN - 70 });
  });
  // The bill keeps a Remarks column beside the bank details; it stays on the
  // form whether or not anything is written in it.
  line(remarkX, bankTop, remarkX, bankTop - bankHeight);
  text('Remarks', remarkX + 4, { size: 7, at: bankTop - 11 });

  // Payment, laid out as the bill lays it out: each mode that has paid, their
  // Total, then what is still owed. A quotation usually has none of the first,
  // so the line reads Received 0.00 and the balance is the whole amount.
  const received = data.payments ?? [];
  const receivedTotal = received.reduce((sum, p) => sum + p.amount, 0);
  text('Payment', payX + 4, { size: 7, font: bold, at: bankTop - 11 });
  text('Amount', right - 4, { size: 7, font: bold, align: 'right', at: bankTop - 11 });
  line(payX, bankTop - 15, right, bankTop - 15);
  const payRows: [string, number][] = received.length
    ? received.map((p) => [p.mode, p.amount] as [string, number])
    : [['Received', 0]];
  payRows.forEach(([label, amount], i) => {
    const at = bankTop - 26 - i * 11;
    text(label, payX + 4, { size: 7, at });
    text(num(amount, 2), right - 4, { size: 7, align: 'right', at });
  });
  const payTotalAt = bankTop - 26 - payRows.length * 11;
  text('Total', payX + 4, { size: 7, at: payTotalAt });
  text(num(receivedTotal, 2), right - 4, { size: 7, align: 'right', at: payTotalAt });
  line(payX, payTotalAt - 4, right, payTotalAt - 4);
  text('Balance Payment :', payX + 4, { size: 7, font: bold, at: payTotalAt - 15 });
  text(num(t.grandTotal - receivedTotal, 2), right - 4, {
    size: 7,
    font: bold,
    align: 'right',
    at: payTotalAt - 15,
  });
  y = bankTop - bankHeight;

  /* ---------------------------------------------------- declaration + terms */
  const termsTop = y;
  const terms = [
    'The Diamond herein invoiced have been purchased from legitimate sources not involved in funding conflict & in compliance with',
    'nations Resolutions. The Seller hereby guarantees that these diamonds are conflict free, based on personal knowledge',
    'and/ or written guarantees provided by the supplier of these diamonds.',
    '',
    'Invoice Issued Under Section 31 (1) of the GST Act 217r/w 1 of the GST Invoice Rule 2017 AND/OR Invoices Issued under',
    'Section 31 (2) of the GST Act r/w Rule 1 of the GST Invoice Rule 2017',
    '',
    data.validUntil
      ? `This is a quotation and not a tax invoice. Gold is priced at the rate on the quote date; prices hold until ${data.validUntil}.`
      : 'This is a quotation and not a tax invoice. Gold is priced at the rate on the quote date.',
    '',
    'Term and Condition:',
    'Subject to Mumbai Jurisdiction only',
    'For Return Policy',
    'A) Get 100% value of metal at the prevailing market rate. *T&C apply',
    'B) Eclat Diamonds offers 80% value of diamonds at prevailing market price. *T&C apply',
    'C) Making Charged will be deducted while any returns made. *T&C apply',
    'D) Incase of any discount given at the time of original purchase will be deducted from the exchange amount. *T&C apply',
    'E) Products once sold will not be eligible for return or exchange if damaged post-purchase. *T&C apply',
  ];
  const termsHeight = terms.length * 8.5 + 10;
  box(MARGIN, termsTop, width, termsHeight);
  terms.forEach((t2, i) => {
    if (!t2) return;
    text(t2, MARGIN + 4, { size: 6.4, color: i < 3 ? MUTED : INK, at: termsTop - 10 - i * 8.5, width: width - 10 });
  });
  y = termsTop - termsHeight;

  /* --------------------------------------------------------- signatures */
  const signTop = y;
  const signHeight = 54;
  box(MARGIN, signTop, width, signHeight);
  text(`For, ${data.business.name.toUpperCase()}`, right - 6, { size: 7.5, align: 'right', at: signTop - 12 });
  line(MARGIN + 20, signTop - 44, MARGIN + 170, signTop - 44);
  line(right - 170, signTop - 44, right - 20, signTop - 44);
  text('Customer Signature', MARGIN + 95, { size: 7, align: 'center', at: signTop - 52 });
  text('Authorized Signature', right - 95, { size: 7, align: 'center', at: signTop - 52 });
  y = signTop - signHeight;

  if (data.approval) {
    text(
      `Approved by a manager${data.approval.decidedAt ? ` on ${data.approval.decidedAt}` : ''} at Rs. ${num(data.approval.approvedTotal, 2)} for revision ${data.revision}.`,
      MARGIN,
      { size: 6.5, color: MUTED, at: y - 9 },
    );
  }

  /* -------------------------------------------------------------- footer */
  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    page = p;
    text(
      `${data.ref} revision ${data.revision} - generated ${data.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
      MARGIN,
      { size: 6.5, color: MUTED, at: MARGIN - 12 },
    );
    text(`${i + 1}/${pages.length}`, A4[0] / 2, { size: 6.5, color: MUTED, align: 'center', at: MARGIN - 12 });
  });

  // Classic cross-reference table rather than object streams: older PDF
  // readers (and some phone previewers) still cannot open the latter.
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
