import JSZip from 'jszip';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(
  process.cwd(),
  '..',
  'docs',
  'handovers',
  'CaratOS-System-Design-and-Flow-Simple-Guide.docx',
);

const esc = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;');

function run(text, options = {}) {
  const props = [
    options.bold ? '<w:b/>' : '',
    options.italic ? '<w:i/>' : '',
    options.color ? `<w:color w:val="${options.color}"/>` : '',
    options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : '',
  ].join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function para(text = '', style = 'Normal', options = {}) {
  const alignment = options.center ? '<w:jc w:val="center"/>' : '';
  const border = options.border
    ? '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="2563EB"/></w:pBdr>'
    : '';
  const shade = options.shade
    ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>`
    : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${border}${shade}${alignment}<w:spacing w:after="${options.after ?? 90}"/></w:pPr>${run(text, options)}</w:p>`;
}

function bullet(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="400" w:hanging="240"/><w:spacing w:after="55"/></w:pPr>${run(`•  ${text}`)}</w:p>`;
}

function numbered(number, title, detail) {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="400" w:hanging="300"/><w:spacing w:after="85"/></w:pPr>${run(`${number}.  `, { bold: true, color: '2563EB' })}${run(`${title}: `, { bold: true })}${run(detail)}</w:p>`;
}

function cell(text, { width = 3000, fill = 'FFFFFF', color = '0F172A', bold = false, center = false } = {}) {
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:tcMar><w:top w:w="120" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="120" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr>${center ? '<w:jc w:val="center"/>' : ''}<w:spacing w:after="0"/></w:pPr>${run(text, { bold, color, size: 20 })}</w:p></w:tc>`;
}

function table(headers, rows, widths) {
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="5" w:color="CBD5E1"/><w:left w:val="single" w:sz="5" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="5" w:color="CBD5E1"/><w:right w:val="single" w:sz="5" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders>';
  const header = `<w:tr>${headers.map((h, i) => cell(h, { width: widths[i], fill: '172554', color: 'FFFFFF', bold: true })).join('')}</w:tr>`;
  const body = rows.map((row, rowIndex) => `<w:tr>${row.map((value, i) => cell(value, { width: widths[i], fill: rowIndex % 2 ? 'F8FAFC' : 'FFFFFF' })).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header}${body}</w:tbl>`;
}

function flowRow(items, colors = []) {
  const widths = items.map(() => Math.floor(9300 / items.length));
  return `<w:tbl><w:tblPr><w:tblW w:w="9300" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid><w:tr>${items.map((item, i) => cell(item, { width: widths[i], fill: colors[i] ?? 'EFF6FF', bold: true, center: true, color: '172554' })).join('')}</w:tr></w:tbl>`;
}

function arrow(label = '↓') {
  return para(label, 'Normal', { center: true, bold: true, color: '2563EB', size: 28, after: 20 });
}

const content = [
  para('CaratOS', 'Title', { color: '172554', size: 48, bold: true, center: true, after: 20 }),
  para('System Design and Flow — Simple Guide', 'Subtitle', { color: '2563EB', size: 30, bold: true, center: true, after: 160 }),
  para('For business owners, sales teams, interns and non-technical reviewers', 'Normal', { italic: true, color: '64748B', center: true, after: 220 }),

  para('CaratOS in one sentence', 'Heading1'),
  para('CaratOS is one central system that collects customer enquiries from many places, keeps each company’s data separate, helps staff and AI work on the enquiry, sends approved replies, connects existing business software, and shows what produced a sale.', 'Normal', { bold: true, shade: 'EFF6FF', border: true, after: 170 }),

  para('The complete picture', 'Heading1'),
  flowRow(['Meta Lead Ads', 'WhatsApp', 'Website / Walk-in', 'Tally / BUSY / Gati / Excel'], ['DBEAFE', 'DCFCE7', 'F3E8FF', 'FEF3C7']),
  arrow(),
  flowRow(['Secure entry gate\nChecks signature, tenant and duplicates'], ['E0F2FE']),
  arrow(),
  flowRow(['Universal CRM\nCustomer • Lead • Conversation • Activity'], ['DBEAFE']),
  arrow(),
  flowRow(['AI + Knowledge\nDraft and score', 'Human Team\nReview and decide', 'Rules\nRoute to branch/person'], ['EDE9FE', 'DCFCE7', 'FEF3C7']),
  arrow(),
  flowRow(['Consent + Outbox\nPolicy check • Queue • Retry'], ['FCE7F3']),
  arrow(),
  flowRow(['WhatsApp / future channels', 'Delivery receipts', 'Spend + Sales → ROAS'], ['DCFCE7', 'E0F2FE', 'FEF3C7']),
  para('Important: data does not jump directly from Meta or an ERP into business records. It first passes through security, ownership, duplicate and mapping checks.', 'Normal', { italic: true, color: '475569', after: 170 }),

  para('The main building blocks', 'Heading1'),
  table(
    ['Part', 'Simple meaning', 'What it does'],
    [
      ['Frontend', 'The screens staff use.', 'Login, CRM inbox, customer records, integrations, reports and settings.'],
      ['Backend', 'The control room.', 'Checks permissions, applies business rules and connects all services.'],
      ['PostgreSQL database', 'The permanent filing cabinet.', 'Stores tenants, users, customers, leads, messages, jobs, consent, spend and audit records.'],
      ['Integration registry', 'The connection register.', 'Records which company connected which provider and keeps credentials encrypted.'],
      ['Webhook intake', 'The secure receiving desk.', 'Checks provider signatures, stores events first and rejects duplicates.'],
      ['CRM', 'The shared customer workspace.', 'Combines identity, lead, conversation, ownership, tasks and activity.'],
      ['Knowledge library', 'The company reference shelf.', 'Extracts approved PDF/DOC text so AI drafts can use company-specific facts.'],
      ['AI drafting', 'A writing assistant, not an automatic salesperson.', 'Creates a grounded draft; a human can approve or reject it.'],
      ['Outbox and jobs', 'The reliable delivery queue.', 'Sends approved work, retries temporary failures and shows permanent failures.'],
      ['Connect agent', 'A small bridge inside the client’s office.', 'Reads Tally/BUSY/Gati/ODBC data and sends it outward securely to CaratOS.'],
      ['Attribution and ROAS', 'The measurement layer.', 'Joins ad source, measured spend and sales without inventing missing values.'],
    ],
    [2100, 2900, 4300],
  ),

  para('Flow 1 — A new lead comes from Meta', 'Heading1'),
  numbered(1, 'Customer submits a form', 'The person fills a Facebook or Instagram Lead Ad form.'),
  numbered(2, 'Meta sends a webhook', 'Meta sends only a notification that a lead exists.'),
  numbered(3, 'CaratOS verifies it', 'The system checks the Meta signature and stores the event before doing anything else.'),
  numbered(4, 'CaratOS finds the correct company', 'The Page ID is matched to exactly one tenant-owned asset. The webhook cannot choose the tenant itself.'),
  numbered(5, 'A background job fetches the lead', 'The encrypted tenant token is used server-side. A temporary Meta error is retried.'),
  numbered(6, 'Identity is resolved', 'Phone/email is matched to an existing customer or a new customer is created safely.'),
  numbered(7, 'Lead and source are saved', 'The lead is marked meta_ads and available campaign/ad-set/ad evidence is attached. Missing evidence stays blank.'),
  numbered(8, 'Routing rules run', 'The enquiry goes to the right branch, manager, salesperson or AI queue.'),
  para('Result: one real enquiry appears in the CRM. Replaying the same Meta event must not create another lead.', 'Normal', { bold: true, shade: 'F0FDF4', border: true }),

  para('Flow 2 — A WhatsApp conversation', 'Heading1'),
  flowRow(['Customer message', 'Signed webhook', 'Correct tenant conversation', 'Human / AI draft'], ['DCFCE7', 'E0F2FE', 'DBEAFE', 'EDE9FE']),
  arrow('↓ policy and consent check ↓'),
  flowRow(['Explicit delivery instruction', 'Durable outbox job', 'WhatsApp accepts', 'sent → delivered → read'], ['FCE7F3', 'FEF3C7', 'DCFCE7', 'E0F2FE']),
  bullet('A normal text reply is allowed only inside the recorded 24-hour customer-care window.'),
  bullet('Outside that window, an approved WhatsApp template is required.'),
  bullet('Marketing also requires recorded consent.'),
  bullet('STOP/unsubscribe must be recorded before AI or marketing automation runs.'),
  bullet('The screen says sent only after WhatsApp accepts the message and returns an ID.'),
  bullet('Delivery receipts move the status forward; an old receipt cannot move it backwards.'),

  para('Flow 3 — How AI helps without taking control', 'Heading1'),
  numbered(1, 'Screen the message', 'Complaints, legal issues, opt-outs and unsafe cases go directly to a person.'),
  numbered(2, 'Search tenant knowledge', 'The system looks only in that company’s ready knowledge documents.'),
  numbered(3, 'Ask the configured model', 'The customer message and small relevant reference are sent to the AI provider.'),
  numbered(4, 'Check confidence and policy', 'Low-confidence or “needs human” output is discarded.'),
  numbered(5, 'Save a draft', 'The draft records provider, model, confidence and knowledge document IDs.'),
  numbered(6, 'Human reviews', 'Approval queues it; rejection records a rejection. Approval never means automatic delivery unless an explicit omnichannel instruction exists.'),
  para('The AI is an assistant. It cannot approve its own answer, bypass consent or pretend a message was delivered.', 'Normal', { bold: true, shade: 'F5F3FF', border: true }),

  para('Flow 4 — Existing data from Tally, BUSY, Gati or another database', 'Heading1'),
  flowRow(['Client’s software\nRead-only access'], ['FEF3C7']),
  arrow(),
  flowRow(['CaratOS Connect Agent\nRuns inside client network'], ['E0F2FE']),
  arrow(),
  flowRow(['Outbound encrypted HTTPS\nNo incoming database port'], ['DBEAFE']),
  arrow(),
  flowRow(['Preview + mapping + duplicate checks'], ['EDE9FE']),
  arrow(),
  flowRow(['Approved sync into neutral CaratOS records'], ['DCFCE7']),
  bullet('CaratOS does not directly open the client’s database to the internet.'),
  bullet('The agent reads through a client-approved, preferably read-only account.'),
  bullet('Every client can have its own mapping profile without changing the universal CRM.'),
  bullet('Tally/BUSY starter profiles currently focus on customers and products; more entities are enabled only after real-client mapping.'),
  bullet('If no supported software exists, CSV/Excel upload is the fallback.'),
  bullet('Preview and reconciliation happen before automatic schedules are enabled.'),

  para('Flow 5 — How ROAS is calculated', 'Heading1'),
  flowRow(['Meta Ads Insights\nMeasured spend', 'CRM attribution\nWhich ad brought the lead', 'Sales\nMeasured revenue'], ['FEF3C7', 'DBEAFE', 'DCFCE7']),
  arrow(),
  flowRow(['Coverage and currency checks'], ['FCE7F3']),
  arrow(),
  flowRow(['Spend • Revenue • Cost per lead • ROAS'], ['E0F2FE']),
  bullet('Declared campaign budget is not the same as measured provider spend.'),
  bullet('If any date is missing, the report must say incomplete instead of showing a confident ROAS.'),
  bullet('If spend and revenue use different currencies, the report must say unavailable unless a dated exchange-rate source exists.'),
  bullet('First-touch and last-touch are different views; the selected method must be visible.'),

  para('Flow 6 — PDF/DOC company knowledge', 'Heading1'),
  numbered(1, 'Upload', 'An authorised manager uploads a private company PDF or Word document.'),
  numbered(2, 'Store privately', 'The original file is kept in private storage, not a public uploads folder.'),
  numbered(3, 'Extract and split', 'Readable text is extracted and divided into small searchable sections.'),
  numbered(4, 'Search', 'When a customer asks something, CaratOS retrieves only relevant sections for that tenant.'),
  numbered(5, 'Draft', 'AI uses those sections to propose an answer and stores document IDs for traceability.'),
  numbered(6, 'Human review', 'A person approves or rejects the answer before any delivery instruction is created.'),

  para('How the same system works for many industries', 'Heading1'),
  table(
    ['Universal part', 'Changes by industry', 'Example'],
    [
      ['CRM, leads, conversations, AI, knowledge, attendance, catalogue and integrations', 'Labels, navigation, custom fields, funnel stages and optional modules', 'Healthcare shows Patient/Service/Branch; manufacturing shows Account/Item/Plant.'],
      ['Neutral product/customer data', 'Industry-specific attributes', 'A jewellery product may have karat; a textile item may have GSM; a clinic service may have duration.'],
      ['Same integration framework', 'Client connector and mapping profile', 'One client uses BUSY, another Tally, another CSV or ODBC.'],
      ['Éclat vertical pack', 'Keeps jewellery operations and branding', 'Existing jewellery screens continue while universal modules remain reusable.'],
    ],
    [2600, 3200, 3500],
  ),
  para('Navigation hiding is not security. The backend also checks whether the tenant is entitled to a module and whether the user can access the organisation/store.', 'Normal', { bold: true, shade: 'FFFBEB', border: true }),

  para('How company data stays separate', 'Heading1'),
  bullet('Every important record carries an organisation (tenant) ID.'),
  bullet('The signed-in user’s organisation comes from the database, not from a request field.'),
  bullet('Store-level users see only their assigned branches; central unassigned work is restricted.'),
  bullet('Provider assets such as Page ID and Phone Number ID can have only one active owner.'),
  bullet('Integration secrets are encrypted and never returned by an API.'),
  bullet('Machine/connector accounts can reach only explicitly allowed ingestion routes.'),
  bullet('Sensitive decisions and automated assignments leave audit/activity evidence.'),

  para('What happens when something fails', 'Heading1'),
  table(
    ['Problem', 'System behaviour', 'What staff sees'],
    [
      ['Meta or WhatsApp is temporarily unavailable', 'Durable job retries with bounded backoff.', 'Queued/retrying; not falsely sent.'],
      ['Retries are exhausted', 'Job becomes dead/failed and needs attention.', 'Failure reason and manual retry option.'],
      ['Webhook is repeated', 'Idempotency key finds the existing event/work.', 'No duplicate customer, lead or message.'],
      ['Webhook signature is invalid', 'Request is rejected and cannot write business data.', 'Security/operations event only.'],
      ['Provider asset owner is missing or ambiguous', 'Processing fails closed; no tenant is guessed.', 'Needs integration setup review.'],
      ['Knowledge is missing or AI is uncertain', 'No AI draft; conversation goes to a person.', 'Visible human queue and reason.'],
      ['Consent is missing/revoked', 'Marketing send is blocked before provider call.', 'Clear policy reason.'],
      ['Spend coverage/currency is unsafe', 'ROAS is unavailable rather than estimated.', 'Incomplete/currency-mismatch explanation.'],
    ],
    [2500, 4100, 2700],
  ),

  para('Automatic versus manual work', 'Heading1'),
  table(
    ['Automatic', 'Human-controlled'],
    [
      ['Signature checks, duplicate checks, event storage and job retries.', 'Connecting a provider and entering its credential.'],
      ['Identity matching and configured routing rules.', 'Approving risky merges and resolving conflicts.'],
      ['Knowledge retrieval and AI draft proposal.', 'Approving/rejecting AI drafts.'],
      ['Delivery receipt updates.', 'Granting/revoking consent when evidence exists.'],
      ['Scheduled Insights pulls after setup.', 'Approving templates in Meta and production go-live.'],
      ['Connector incremental sync after an approved profile.', 'First preview, mapping and reconciliation for each client.'],
    ],
    [4650, 4650],
  ),

  para('Current project position', 'Heading1'),
  para('The local backend and database regression baseline is green, and the main architecture is present. Meta-facing code is still fixture-tested rather than live-provider verified. Engineering must finish the remaining connection seams and safety gates; the intern must then complete staging account/webhook setup and evidence before production.', 'Normal', { shade: 'EFF6FF', border: true }),
  bullet('Code complete: internal handlers, migrations, policies, UI and tests are finished.'),
  bullet('Locally verified: fixture and database tests pass without real provider calls.'),
  bullet('Staging connected: test credentials/assets and signed test traffic work on a deployed staging system.'),
  bullet('Live verified: reviewed permissions, real tenant credentials and real signed provider traffic have been observed.'),
  para('These four statuses must always be reported separately.', 'Normal', { bold: true, color: '991B1B' }),

  para('Short glossary', 'Heading1'),
  table(
    ['Term', 'Plain meaning'],
    [
      ['Tenant', 'One client company and its separated data.'],
      ['Webhook', 'A provider calling CaratOS when something happens.'],
      ['API', 'A controlled way for two software systems to exchange data.'],
      ['Asset', 'A provider object owned by a tenant: Page, form, ad account or phone number.'],
      ['Integration credential', 'An encrypted token that lets CaratOS act for one tenant.'],
      ['Idempotent', 'Repeating the same event produces one result, not duplicates.'],
      ['Outbox', 'The list of messages waiting for or reporting delivery.'],
      ['Dead-letter', 'Work that failed all automatic retries and needs a person.'],
      ['Attribution', 'Evidence connecting an enquiry or sale to its source.'],
      ['ROAS', 'Attributed revenue divided by measured advertising spend.'],
      ['Industry pack', 'Configuration that changes labels, fields and enabled modules for an industry.'],
    ],
    [2600, 6700],
  ),

  para('Related handover files', 'Heading1'),
  bullet('Intern integration checklist: C:\\Users\\Shrey\\Eclat\\docs\\handovers\\CaratOS-Meta-WhatsApp-Manual-Integration-Handover.xlsx'),
  bullet('Simple integration setup brief: C:\\Users\\Shrey\\Eclat\\docs\\handovers\\CaratOS-Meta-WhatsApp-Integration-Intern-Brief.docx'),
  bullet('Engineering completion prompt: C:\\Users\\Shrey\\Eclat\\docs\\work-requests\\CLAUDE-FINAL-INTEGRATION-COMPLETION-PROMPT.txt'),
].join('');

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${content}<w:sectPr><w:footerReference w:type="default" r:id="rIdFooter1"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="900" w:right="850" w:bottom="900" w:left="850" w:header="400" w:footer="400" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="21"/><w:color w:val="0F172A"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="270" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:keepNext/><w:keepLines/><w:pPr><w:spacing w:before="260" w:after="110"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="172554"/><w:sz w:val="30"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:keepNext/><w:pPr><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2563EB"/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;

const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('CaratOS — simple system design and flow', { color: '64748B', size: 16 })}</w:p></w:ftr>`;

const zip = new JSZip();
zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`);
zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`);
zip.folder('word').file('document.xml', documentXml);
zip.folder('word').file('styles.xml', stylesXml);
zip.folder('word').file('footer1.xml', footerXml);
zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>
</Relationships>`);
zip.folder('docProps').file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>CaratOS System Design and Flow — Simple Guide</dc:title><dc:creator>CaratOS Engineering</dc:creator><dc:subject>Layman system architecture guide</dc:subject><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`);
zip.folder('docProps').file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>CaratOS</Application></Properties>`);

await mkdir(resolve(output, '..'), { recursive: true });
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(output, bytes);

const reopened = await JSZip.loadAsync(await readFile(output));
for (const required of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/footer1.xml']) {
  if (!reopened.file(required)) throw new Error(`Generated document is missing ${required}`);
}
const xml = await reopened.file('word/document.xml').async('string');
for (const marker of ['The complete picture', 'A new lead comes from Meta', 'A WhatsApp conversation', 'Tally, BUSY, Gati', 'How ROAS is calculated', 'How company data stays separate']) {
  if (!xml.includes(marker)) throw new Error(`Generated document is missing: ${marker}`);
}
console.log(`${output}\nverified: ${bytes.length} bytes; package and architecture sections present`);

