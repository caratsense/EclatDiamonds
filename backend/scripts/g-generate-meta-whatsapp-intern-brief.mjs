import JSZip from 'jszip';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(
  process.cwd(),
  '..',
  'docs',
  'handovers',
  'CaratOS-Meta-WhatsApp-Integration-Intern-Brief.docx',
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
  const spacing = options.after ?? (style.startsWith('Heading') ? 100 : 80);
  const shade = options.shade
    ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>`
    : '';
  const border = options.border
    ? '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="2563EB"/></w:pBdr>'
    : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:spacing w:after="${spacing}"/>${shade}${border}</w:pPr>${run(text, options)}</w:p>`;
}

function bullet(text, level = 0) {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="${360 + level * 360}" w:hanging="240"/><w:spacing w:after="50"/></w:pPr>${run('•  ' + text)}</w:p>`;
}

function numbered(number, text) {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="360" w:hanging="280"/><w:spacing w:after="70"/></w:pPr>${run(`${number}.  `, { bold: true, color: '2563EB' })}${run(text)}</w:p>`;
}

function cell(text, options = {}) {
  const fill = options.header ? '172554' : options.fill ?? 'FFFFFF';
  const color = options.header ? 'FFFFFF' : '0F172A';
  const width = options.width ?? 3000;
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:fill="${fill}"/><w:tcMar><w:top w:w="90" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="90" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(text, { bold: options.header, color, size: options.header ? 20 : 19 })}</w:p></w:tc>`;
}

function table(headers, rows, widths) {
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders>';
  const header = `<w:tr>${headers.map((h, i) => cell(h, { header: true, width: widths[i] })).join('')}</w:tr>`;
  const body = rows.map((row, rowIndex) => `<w:tr>${row.map((value, i) => cell(value, { width: widths[i], fill: rowIndex % 2 ? 'F8FAFC' : 'FFFFFF' })).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header}${body}</w:tbl>`;
}

const body = [
  para('CaratOS', 'Title', { color: '172554', size: 48, bold: true, after: 20 }),
  para('Meta, WhatsApp, Lead Ads & ROAS — Intern Setup Brief', 'Subtitle', { color: '2563EB', size: 28, bold: true, after: 180 }),
  para('Purpose', 'Heading1'),
  para('Connect each client’s Meta and WhatsApp accounts to CaratOS safely, first on staging and then on production after approval. The intern’s work is account setup, asset collection, webhook configuration, testing and evidence. Engineering owns code, migrations and defect fixes.'),
  para('Current status: the integration code is locally fixture-tested, but it is not yet live-provider verified. Do not connect production customer assets until Engineering marks the integration build “staging ready”.', 'Normal', { bold: true, color: '991B1B', shade: 'FEF2F2', border: true, after: 160 }),

  para('What the project needs', 'Heading1'),
  bullet('WhatsApp Cloud API for inbound messages, approved templates, outbound replies and sent/delivered/read/failed receipts.'),
  bullet('Meta Lead Ads for signed leadgen webhooks and automatic creation of a tenant-scoped CRM lead.'),
  bullet('Meta Ads Insights for measured campaign spend, coverage and currency-safe ROAS.'),
  bullet('Per-client encrypted access tokens and uniquely owned Page, Form, Ad Account and WhatsApp Phone Number assets.'),
  bullet('Consent enforcement: STOP/unsubscribe must be recorded before AI or marketing automation runs.'),
  bullet('Staging evidence before production: valid and invalid signatures, duplicate events, lead creation, message receipts, opt-out and ROAS reconciliation.'),

  para('Who does what', 'Heading1'),
  table(
    ['Owner', 'Responsibility', 'Must not do'],
    [
      ['Engineering / Claude', 'Finish the Lead Ads CRM sink, meta_ads migration, STOP seam, spend model, currency gate, health checks, template sync, UI and automated tests.', 'Must not call fixtures “live verified”.'],
      ['Intern', 'Collect approved IDs, configure Meta dashboards/webhooks, enter tokens through CaratOS encrypted UI, run staging tests and attach redacted evidence.', 'Must not change application code or place secrets in documents/chat.'],
      ['Meta / Business Admin', 'Business verification, Page/WABA/ad-account access, system-user token, permissions and app review.', 'Must not share personal passwords or OTPs.'],
      ['Product Owner', 'Approve customer test contacts, production change window and go-live.', 'Must not approve go-live without staging evidence.'],
    ],
    [1900, 5100, 2400],
  ),

  para('Details to collect and where to find them', 'Heading1'),
  table(
    ['Detail required', 'Where to find it', 'What to record'],
    [
      ['Meta App ID', 'Meta for Developers → My Apps → selected app → App Settings → Basic', 'Numeric App ID.'],
      ['Meta App Secret', 'Meta App Settings → Basic → App Secret', 'Do not record the value. Enter directly into the approved secret manager.'],
      ['Business Portfolio ID', 'Meta Business Settings → Business Info', 'Business name and numeric ID.'],
      ['Facebook Page ID', 'Meta Business Settings → Accounts → Pages, or Page settings/about', 'Page name and numeric ID.'],
      ['Lead Form ID', 'Meta Ads Manager → Instant Forms / Lead Ads testing tool', 'Form name and numeric ID.'],
      ['Ad Account ID', 'Meta Business Settings → Accounts → Ad Accounts', 'Account name, numeric ID, currency and timezone.'],
      ['WABA ID', 'WhatsApp Manager → Account tools / API setup', 'WhatsApp Business Account name and numeric ID.'],
      ['Phone Number ID', 'WhatsApp Manager → API Setup / Phone numbers', 'Numeric Phone Number ID, not the visible phone number.'],
      ['WhatsApp access token', 'Meta Business Settings → System Users or the approved API setup flow', 'Never record it. Enter directly in CaratOS Settings → Integrations.'],
      ['Meta Page/ad token', 'Approved Meta system-user/business authorization flow', 'Never record it. Enter directly in the encrypted CaratOS credential field.'],
      ['Permission status', 'Meta App Dashboard → App Review → Permissions and Features', 'Permission name, status, approval date and screenshot.'],
      ['Template status', 'WhatsApp Manager → Message Templates', 'Template name, language, category, provider status and last checked time.'],
    ],
    [2600, 4400, 2400],
  ),

  para('Setup order', 'Heading1'),
  numbered(1, 'Get business-admin approval and access to the Meta Business Portfolio, Page, Ad Account, Lead Form and WhatsApp Business Account.'),
  numbered(2, 'Ask Engineering for the stable staging backend URL and written “staging ready” confirmation.'),
  numbered(3, 'Configure app-level secrets in the staging secret manager. Never put tenant access tokens in environment variables.'),
  numbered(4, 'Create the tenant’s WhatsApp and Meta Ads integrations in CaratOS Settings → Integrations.'),
  numbered(5, 'Enter each tenant access token in the encrypted credential field. Confirm CaratOS never displays it again.'),
  numbered(6, 'Register the tenant’s Phone Number ID, Page ID, Form ID and Ad Account ID.'),
  numbered(7, 'Configure both public webhook callbacks in the Meta dashboard and complete the verification challenge.'),
  numbered(8, 'Run health checks. “Credential stored” is not the same as “connected”. All selected assets must be readable by the token.'),
  numbered(9, 'Run the staging tests in this document and update the workbook’s Status and Evidence Log.'),
  numbered(10, 'Ask the Product Owner for a production change window only after every critical staging row is Done.'),

  para('Webhook details', 'Heading1'),
  table(
    ['Purpose', 'Callback URL', 'Verify token location'],
    [
      ['WhatsApp inbound messages and delivery receipts', 'https://<BACKEND-DOMAIN>/integrations/whatsapp/webhook', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN in the secret manager.'],
      ['Meta Lead Ads leadgen notifications', 'https://<BACKEND-DOMAIN>/integrations/meta/webhook', 'META_WEBHOOK_VERIFY_TOKEN in the secret manager.'],
    ],
    [3000, 4100, 2300],
  ),
  para('Both URLs must be public HTTPS staging URLs. Copy the verify token directly from the approved password/secret manager. Do not paste it into this document or the Excel sheet.', 'Normal', { bold: true, color: '92400E', shade: 'FFFBEB', border: true }),

  para('Environment details Engineering/DevOps must configure', 'Heading1'),
  table(
    ['Variable', 'Purpose', 'Where value comes from'],
    [
      ['CREDENTIAL_ENCRYPTION_KEY', 'Encrypt tenant integration credentials.', 'Generated by DevOps: 32 random bytes encoded base64.'],
      ['CREDENTIAL_ENCRYPTION_KEY_VERSION', 'Tracks encryption-key rotation.', 'Engineering; starts at 1.'],
      ['META_GRAPH_API_VERSION', 'Explicit Graph API version for lead and Insights calls.', 'Current supported version confirmed in Meta dashboard/documentation.'],
      ['META_APP_SECRET', 'Lead Ads webhook HMAC verification.', 'Meta App Settings → Basic.'],
      ['META_WEBHOOK_VERIFY_TOKEN', 'Lead Ads webhook subscription challenge.', 'High-entropy token generated by DevOps.'],
      ['WHATSAPP_APP_SECRET', 'WhatsApp webhook HMAC verification.', 'Meta App Settings → Basic.'],
      ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WhatsApp webhook subscription challenge.', 'Separate high-entropy token generated by DevOps.'],
      ['CRM_QR_SECRET', 'Signs CRM QR payloads independently from user sessions.', 'High-entropy token generated by DevOps.'],
    ],
    [3000, 3900, 2500],
  ),

  para('CaratOS tenant setup', 'Heading1'),
  para('WhatsApp connection', 'Heading2'),
  bullet('Open CaratOS → Settings → Integrations.'),
  bullet('Create “WhatsApp Business Cloud API”.'),
  bullet('Save credential type access_token in the password field.'),
  bullet('Save the numeric Phone Number ID as the phone_number asset.'),
  bullet('Run the connection health check and confirm the tenant owns the selected sender.'),
  para('Meta Ads connection', 'Heading2'),
  bullet('Create “Meta Ads” only after Engineering confirms the provider is enabled.'),
  bullet('Save credential type access_token through the encrypted CaratOS field.'),
  bullet('Register Page, Form and Ad Account assets using their numeric IDs.'),
  bullet('Run health checks and confirm every asset shows provider-verified ownership.'),
  bullet('Do not treat manually entered asset IDs as verified.'),

  para('Permissions to check', 'Heading1'),
  para('Confirm the current requirements in Meta App Review because permission names and review requirements can change. Expected areas include Lead retrieval, Page webhook subscription/metadata, Ads Insights read access, and WhatsApp Business management/messaging. Request only the permissions the approved integration uses.', 'Normal', { shade: 'EFF6FF', border: true }),

  para('Staging test checklist', 'Heading1'),
  bullet('Valid webhook verification challenge succeeds; incorrect verify token fails.'),
  bullet('Valid signed payload is accepted; invalid/missing signature is rejected.'),
  bullet('A Meta test lead creates exactly one Party/ContactPoint/Lead with source meta_ads.'),
  bullet('Replaying the same lead event does not create a duplicate.'),
  bullet('Ad-set routing assigns the expected store/user and records audit evidence.'),
  bullet('Inbound WhatsApp creates/updates the correct tenant conversation.'),
  bullet('Service reply inside 24 hours reaches sent, delivered and read where available.'),
  bullet('Free text outside 24 hours is blocked; an approved template is allowed.'),
  bullet('STOP is recorded before AI drafting and blocks later marketing.'),
  bullet('“Where is the nearest bus stop?” does not revoke consent.'),
  bullet('Insights sync has complete date coverage and matches Meta Ads Manager.'),
  bullet('ROAS is unavailable for incomplete coverage or currency mismatch.'),
  bullet('Provider failures appear in Jobs/Outbox and can be safely retried.'),

  para('Evidence to hand back', 'Heading1'),
  bullet('Object IDs and names: App, Business Portfolio, Page, Form, Ad Account, WABA and Phone Number ID.'),
  bullet('Permission/app-review statuses and dates.'),
  bullet('Webhook challenge success and subscribed event fields.'),
  bullet('CaratOS integration health and per-asset verification result.'),
  bullet('Test lead ID, job ID and resulting CRM record IDs—customer fields redacted.'),
  bullet('Test WhatsApp message IDs and state timestamps—recipient redacted.'),
  bullet('Spend/ROAS comparison for the same account, timezone, dates and currency.'),
  bullet('Any blocker with the exact screen/error code, not a secret-bearing raw response.'),

  para('Never put these in the document, workbook, screenshots or chat', 'Heading1'),
  bullet('Access tokens, app secrets, verify tokens, encryption keys, passwords, OTPs or recovery codes.'),
  bullet('Real customer phone numbers, email addresses, message content or Lead Form answers.'),
  bullet('DATABASE_URL or any connection string.'),
  bullet('Unredacted webhook bodies or Authorization headers.'),

  para('Definition of done', 'Heading1'),
  para('The intern’s handover is complete when every applicable critical row in the workbook is Done, evidence is redacted, both staging webhooks are verified, a test Lead reaches CRM exactly once, a test WhatsApp conversation reaches receipt states, STOP blocks marketing, Insights reconcile for a complete same-currency window, and the Product Owner approves the production change window.', 'Normal', { bold: true, shade: 'F0FDF4', border: true }),
  para('Fixture-tested, staging-connected and live-verified are separate states. The integration may be called live-verified only after approved permissions, real tenant credentials and real signed provider traffic have been observed.', 'Normal', { bold: true, color: '991B1B' }),

  para('Reference files', 'Heading1'),
  bullet('Detailed intern workbook: C:\\Users\\Shrey\\Eclat\\docs\\handovers\\CaratOS-Meta-WhatsApp-Manual-Integration-Handover.xlsx'),
  bullet('Engineering completion prompt: C:\\Users\\Shrey\\Eclat\\docs\\work-requests\\CLAUDE-FINAL-INTEGRATION-COMPLETION-PROMPT.txt'),
  bullet('Environment template: C:\\Users\\Shrey\\Eclat\\backend\\.env.example'),
  bullet('Official Meta developer documentation: https://developers.facebook.com/docs/'),
  para('Internal owner: ____________________    Meta admin: ____________________    Intern: ____________________    Target date: ____________________', 'Normal', { after: 0 }),
].join('');

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${body}
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1000" w:right="900" w:bottom="1000" w:left="900" w:header="400" w:footer="400" w:gutter="0"/>
      <w:footerReference w:type="default" r:id="rIdFooter1"/>
    </w:sectPr>
  </w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="21"/><w:color w:val="0F172A"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="270" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:keepNext/><w:keepLines/><w:rPr><w:b/><w:color w:val="172554"/><w:sz w:val="30"/></w:rPr><w:pPr><w:spacing w:before="260" w:after="110"/><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:keepNext/><w:rPr><w:b/><w:color w:val="2563EB"/><w:sz w:val="24"/></w:rPr><w:pPr><w:spacing w:before="180" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr></w:style>
</w:styles>`;

const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('CaratOS confidential — no secrets or customer PII  |  Intern setup brief', { color: '64748B', size: 16 })}</w:p></w:ftr>`;

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
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>CaratOS Meta and WhatsApp Integration Intern Brief</dc:title>
  <dc:creator>CaratOS Engineering</dc:creator>
  <dc:subject>Manual integration setup and evidence guide</dc:subject>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`);
zip.folder('docProps').file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>CaratOS</Application></Properties>`);

await mkdir(resolve(output, '..'), { recursive: true });
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await import('node:fs/promises').then(({ writeFile }) => writeFile(output, bytes));

const reopened = await JSZip.loadAsync(await readFile(output));
for (const required of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/footer1.xml']) {
  if (!reopened.file(required)) throw new Error(`Generated document is missing ${required}`);
}
const reopenedDocument = await reopened.file('word/document.xml').async('string');
for (const marker of ['What the project needs', '/integrations/whatsapp/webhook', '/integrations/meta/webhook', 'Never put these']) {
  if (!reopenedDocument.includes(marker)) throw new Error(`Generated document is missing: ${marker}`);
}

console.log(`${output}\nverified: ${bytes.length} bytes; Word package and required content present`);

