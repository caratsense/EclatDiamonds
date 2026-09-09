import ExcelJS from 'exceljs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(
  process.cwd(),
  '..',
  'docs',
  'handovers',
  'CaratOS-Meta-WhatsApp-Manual-Integration-Handover.xlsx',
);

const tasks = [
  ['PRE-01', 'Prerequisites', 'Platform', 'Confirm integration completion build is deployed to staging', 'CaratOS deployment', 'Release SHA and staging URL', 'All INT-01…INT-11 code gates green', 'Engineering', 'Release SHA; deployment URL; timestamp', 'Critical', 'Not started', 'Never configure Meta against a developer laptop URL.'],
  ['PRE-02', 'Prerequisites', 'Platform', 'Confirm staging API has public HTTPS and stable hostname', 'DNS / hosting console', 'https://api-staging.<domain>', 'PRE-01', 'DevOps', 'HTTPS request and certificate screenshot', 'Critical', 'Not started', 'Meta must reach both webhook callbacks.'],
  ['PRE-03', 'Prerequisites', 'Platform', 'Run zero-to-current database migrations on disposable staging database', 'Backend migration runner', 'DATABASE_URL reference only', 'PRE-01', 'Engineering', 'Migration output with secrets redacted', 'Critical', 'Not started', 'Do not paste DATABASE_URL into this workbook.'],
  ['PRE-04', 'Prerequisites', 'Business', 'Confirm Meta Business Portfolio admin access', 'Meta Business Settings', 'Business portfolio name and numeric ID', 'None', 'Business admin', 'Admin/member screenshot', 'High', 'Not started', 'Record IDs only; never passwords or recovery codes.'],
  ['PRE-05', 'Prerequisites', 'Business', 'Confirm Facebook Page, ad account, lead form and WhatsApp Business Account ownership', 'Meta Business Settings', 'Object names and numeric IDs', 'PRE-04', 'Business admin', 'Asset ownership screenshots', 'Critical', 'Not started', 'The same business must authorize every selected asset.'],
  ['PRE-06', 'Prerequisites', 'Legal', 'Publish Privacy Policy and Data Deletion instructions', 'Public website + Meta App Settings', 'Public HTTPS URLs', 'PRE-04', 'Legal / product owner', 'URLs open without authentication', 'Critical', 'Not started', 'Required before app review/live use.'],

  ['ENV-01', 'Environment', 'Security', 'Generate active credential encryption key', 'Staging secret manager', 'CREDENTIAL_ENCRYPTION_KEY = 32 random bytes encoded base64', 'PRE-01', 'DevOps', 'Variable exists; value never shown', 'Critical', 'Not started', 'Do not reuse JWT_SECRET.'],
  ['ENV-02', 'Environment', 'Security', 'Set encryption key version', 'Staging secret manager', 'CREDENTIAL_ENCRYPTION_KEY_VERSION=1', 'ENV-01', 'DevOps', 'Variable name and version screenshot', 'High', 'Not started', 'Previous key remains blank on first setup.'],
  ['ENV-03', 'Environment', 'Meta', 'Set explicit supported Graph API version', 'Staging secret manager', 'META_GRAPH_API_VERSION=v<current-supported-version>', 'PRE-01', 'DevOps', 'Variable exists; current version confirmed in Meta dashboard/docs', 'Critical', 'Not started', 'Do not blindly copy the example version.'],
  ['ENV-04', 'Environment', 'Meta', 'Store Meta App secret', 'Staging secret manager', 'META_APP_SECRET', 'APP-02', 'DevOps', 'Variable exists; value redacted', 'Critical', 'Not started', 'Never store in Integration.config or this workbook.'],
  ['ENV-05', 'Environment', 'Meta', 'Generate Meta Lead Ads webhook verify token', 'Password manager + staging secret manager', 'META_WEBHOOK_VERIFY_TOKEN', 'APP-02', 'DevOps', 'Reference/owner and last-rotated date', 'Critical', 'Not started', 'High entropy; distinct from WhatsApp verify token.'],
  ['ENV-06', 'Environment', 'WhatsApp', 'Store WhatsApp app secret', 'Staging secret manager', 'WHATSAPP_APP_SECRET', 'WA-01', 'DevOps', 'Variable exists; value redacted', 'Critical', 'Not started', 'May belong to same Meta app, but keep the application variable explicit.'],
  ['ENV-07', 'Environment', 'WhatsApp', 'Generate WhatsApp webhook verify token', 'Password manager + staging secret manager', 'WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WA-01', 'DevOps', 'Reference/owner and last-rotated date', 'Critical', 'Not started', 'Must exactly match the webhook dashboard entry.'],
  ['ENV-08', 'Environment', 'CRM', 'Generate independent QR signing secret', 'Staging secret manager', 'CRM_QR_SECRET', 'PRE-01', 'DevOps', 'Variable exists; value redacted', 'High', 'Not started', 'Do not fall back to JWT_SECRET in staging/production.'],
  ['ENV-09', 'Environment', 'Platform', 'Set allowed frontend origins', 'Staging secret manager', 'CORS_ORIGINS=https://<staging-frontend>', 'PRE-02', 'DevOps', 'Browser request succeeds only from approved origin', 'High', 'Not started', 'No wildcard in production.'],
  ['ENV-10', 'Environment', 'Platform', 'Restart staging and run health/build smoke check', 'Hosting console', 'No secret values', 'ENV-01…ENV-09', 'DevOps', 'Health response and clean startup logs', 'Critical', 'Not started', 'Check no environment value is printed in logs.'],

  ['APP-01', 'Meta App', 'Meta', 'Create/select a Business app for CaratOS staging', 'Meta for Developers', 'App name and App ID', 'PRE-04', 'Meta admin', 'App dashboard screenshot', 'High', 'Not started', 'Use staging/test assets until approval.'],
  ['APP-02', 'Meta App', 'Meta', 'Add required Meta products/use cases', 'Meta App Dashboard', 'Webhooks; Marketing API/Lead Ads; WhatsApp as applicable', 'APP-01', 'Meta admin', 'Products/use cases screenshot', 'High', 'Not started', 'Available product names vary; choose only required capabilities.'],
  ['APP-03', 'Meta App', 'Meta', 'Add developers/testers with least privilege', 'App Roles', 'Named business accounts', 'APP-01', 'Meta admin', 'Roles screenshot', 'Medium', 'Not started', 'Do not share one personal login.'],
  ['APP-04', 'Meta App', 'Meta', 'Configure app domains, privacy policy and data-deletion URL', 'App Settings → Basic', 'Approved HTTPS domains/URLs', 'PRE-06', 'Meta admin', 'Completed settings screenshot', 'Critical', 'Not started', 'URLs must be externally reachable.'],
  ['APP-05', 'Meta App', 'Meta', 'Request/confirm Lead Ads permissions', 'App Review / Permissions', 'leads retrieval and current Page webhook permissions', 'APP-02', 'Meta admin', 'Permission status screenshot', 'Critical', 'Not started', 'Confirm current permission names in Meta dashboard; do not rely on an old checklist.'],
  ['APP-06', 'Meta App', 'Meta', 'Request/confirm Insights read permission', 'App Review / Permissions', 'ads_read or current equivalent', 'APP-02', 'Meta admin', 'Permission status screenshot', 'Critical', 'Not started', 'No ads write permission unless separately required.'],
  ['APP-07', 'Meta App', 'WhatsApp', 'Request/confirm WhatsApp management and messaging permissions', 'App Review / Permissions', 'Current WhatsApp Business management/messaging permissions', 'APP-02', 'Meta admin', 'Permission status screenshot', 'Critical', 'Not started', 'Confirm current names in Meta dashboard.'],
  ['APP-08', 'Meta App', 'Meta', 'Move app to Live only after staging acceptance', 'App Dashboard', 'Live-mode approval', 'All staging E2E rows done', 'Product owner', 'Approval and mode screenshot', 'Critical', 'Blocked', 'External app review may take longer than engineering.'],

  ['TEN-01', 'Tenant Setup', 'CaratOS', 'Create WhatsApp Cloud integration for tenant', 'Settings → Integrations or POST /integrations-registry', '{"providerCode":"whatsapp_cloud","name":"Client WhatsApp"}', 'ENV-01; WA-03', 'Tenant head office', 'Integration ID and configured state', 'Critical', 'Not started', 'Do not mark connected until health verified.'],
  ['TEN-02', 'Tenant Setup', 'CaratOS', 'Store tenant WhatsApp access token encrypted', 'POST /integrations-registry/{id}/credentials', '{"kind":"access_token","secret":"<ENTER IN UI, NOT SHEET>"}', 'TEN-01', 'Tenant head office', 'Credential kind shown as stored; secret not returned', 'Critical', 'Not started', 'Never paste the secret into evidence.'],
  ['TEN-03', 'Tenant Setup', 'CaratOS', 'Register tenant WhatsApp Phone Number ID', 'Settings → Integrations or POST /integrations-registry/{id}/assets', '{"kind":"phone_number","externalId":"<numeric Phone Number ID>","name":"Primary WhatsApp"}', 'TEN-01', 'Tenant head office', 'Asset row and ownership check', 'Critical', 'Not started', 'Use Phone Number ID, not visible phone number.'],
  ['TEN-04', 'Tenant Setup', 'CaratOS', 'Create Meta Ads integration for tenant', 'Settings → Integrations or POST /integrations-registry', '{"providerCode":"meta_ads","name":"Client Meta Ads"}', 'INT-02/03/04 complete', 'Tenant head office', 'Integration ID and configured state', 'Critical', 'Blocked', 'Provider currently remains unavailable until code gates close.'],
  ['TEN-05', 'Tenant Setup', 'CaratOS', 'Store tenant Meta access token encrypted', 'POST /integrations-registry/{id}/credentials', '{"kind":"access_token","secret":"<ENTER IN UI, NOT SHEET>"}', 'TEN-04', 'Tenant head office', 'Credential kind shown as stored; secret not returned', 'Critical', 'Blocked', 'Tenant token must never be a platform environment variable.'],
  ['TEN-06', 'Tenant Setup', 'CaratOS', 'Register Facebook Page asset', 'POST /integrations/meta/assets', '{"integrationId":"<id>","kind":"page","externalId":"<PAGE_ID>","name":"<Page>"}', 'TEN-04', 'Tenant head office', 'Asset ID; providerOwnershipVerified result', 'Critical', 'Blocked', 'Webhook tenant routing depends on unique Page ownership.'],
  ['TEN-07', 'Tenant Setup', 'CaratOS', 'Register Lead Form asset', 'POST /integrations/meta/assets', '{"integrationId":"<id>","kind":"form","externalId":"<FORM_ID>","name":"<Form>"}', 'TEN-04', 'Tenant head office', 'Asset ID; health result', 'High', 'Blocked', 'Register every production form used.'],
  ['TEN-08', 'Tenant Setup', 'CaratOS', 'Register Meta ad-account asset', 'POST /integrations/meta/assets', '{"integrationId":"<id>","kind":"ad_account","externalId":"<numeric AD_ACCOUNT_ID>","name":"<Account>"}', 'TEN-04', 'Tenant head office', 'Asset row ID; currency; timezone; health result', 'Critical', 'Blocked', 'Record numeric id without act_ prefix unless UI instructs otherwise.'],
  ['TEN-09', 'Tenant Setup', 'CaratOS', 'Run tenant Meta health check', 'CaratOS integration health action', 'No token in request/response', 'TEN-05…TEN-08', 'Tenant head office', 'connected/needs_attention; checkedAt; per-asset results', 'Critical', 'Blocked', 'Manual asset entry is not verification.'],

  ['WA-01', 'WhatsApp', 'Meta', 'Create/select WhatsApp Business Account and add phone number', 'WhatsApp Manager', 'WABA ID; phone number; Phone Number ID', 'PRE-05', 'WhatsApp admin', 'WABA/number status screenshot', 'Critical', 'Not started', 'Use test number until business verification is complete.'],
  ['WA-02', 'WhatsApp', 'Meta', 'Complete display-name/business/phone verification', 'WhatsApp Manager', 'Business verification inputs', 'WA-01', 'Business admin', 'Approved status screenshot', 'Critical', 'Not started', 'External review may block live sending.'],
  ['WA-03', 'WhatsApp', 'Meta', 'Create least-privilege long-lived/system-user token', 'Meta Business Settings', 'Token entered directly into CaratOS', 'APP-07; WA-01', 'Meta admin', 'Token owner; issued date; expiry/rotation date only', 'Critical', 'Not started', 'Never place token in this workbook or chat.'],
  ['WA-04', 'WhatsApp', 'Meta', 'Configure WhatsApp webhook callback', 'WhatsApp → Configuration', 'https://<api>/integrations/whatsapp/webhook', 'ENV-06; ENV-07; PRE-02', 'Meta admin', 'Webhook challenge verified screenshot', 'Critical', 'Not started', 'Verify token is WHATSAPP_WEBHOOK_VERIFY_TOKEN.'],
  ['WA-05', 'WhatsApp', 'Meta', 'Subscribe WhatsApp message/status webhook fields', 'WhatsApp → Webhooks', 'messages and delivery status events exposed by dashboard', 'WA-04', 'Meta admin', 'Subscribed fields screenshot', 'Critical', 'Not started', 'Exact field names must follow the current Meta dashboard.'],
  ['WA-06', 'WhatsApp', 'Meta', 'Create and submit utility/marketing templates', 'WhatsApp Manager → Message Templates', 'Template name; language; category; variables', 'WA-02', 'Marketing admin', 'Template IDs/status screenshots', 'High', 'Not started', 'Approval is provider-owned; do not manually fake approved.'],
  ['WA-07', 'WhatsApp', 'CaratOS', 'Synchronise template statuses into tenant assets', 'CaratOS template sync action/job', 'Integration ID', 'WA-06; TEN-01…TEN-03', 'Tenant head office', 'Last synced time and matching status', 'Critical', 'Blocked', 'Requires INT-08 implementation.'],
  ['WA-08', 'WhatsApp', 'Test', 'Send service reply inside recorded 24-hour window', 'CaratOS CRM conversation', 'Test recipient only', 'WA-04; TEN-03', 'QA / intern', 'queued→sent→delivered/read timestamps', 'High', 'Not started', 'Do not test against a real customer without approval.'],
  ['WA-09', 'WhatsApp', 'Test', 'Verify free text is blocked outside 24-hour window', 'CaratOS CRM conversation', 'Expired-window fixture/test contact', 'WA-08', 'QA / intern', 'Blocked reason=template_required', 'Critical', 'Not started', 'No provider request should be made.'],
  ['WA-10', 'WhatsApp', 'Test', 'Send approved template outside 24-hour window', 'CaratOS CRM conversation', 'Approved test template', 'WA-06; WA-07', 'QA / intern', 'Provider message id and delivery receipts', 'High', 'Blocked', 'Marketing template additionally requires consent.'],
  ['WA-11', 'WhatsApp', 'Test', 'Send STOP and verify immediate consent revocation', 'Test WhatsApp handset + CaratOS consent view', 'STOP', 'INT-01; WA-04', 'QA / intern', 'Consent revoked event precedes AI/automation; later marketing blocked', 'Critical', 'Blocked', 'Also test “nearest bus stop” does not revoke.'],
  ['WA-12', 'WhatsApp', 'Operations', 'Verify failed delivery retry and dead-letter handling', 'CaratOS Outbox / Jobs', 'Controlled fake/invalid test destination', 'WA-08', 'QA / intern', 'Retry attempts; final failed state; manual retry action', 'High', 'Not started', 'Alert/evidence must not include message content.'],

  ['LEAD-01', 'Lead Ads', 'Meta', 'Configure Lead Ads webhook callback', 'Meta App → Webhooks → Page', 'https://<api>/integrations/meta/webhook', 'ENV-04; ENV-05; PRE-02', 'Meta admin', 'Webhook challenge verified screenshot', 'Critical', 'Not started', 'Verify token is META_WEBHOOK_VERIFY_TOKEN.'],
  ['LEAD-02', 'Lead Ads', 'Meta', 'Subscribe selected Page to leadgen events', 'Meta Webhooks / Page subscription', 'PAGE_ID and leadgen subscription', 'APP-05; LEAD-01; TEN-06', 'Meta admin', 'Subscription status screenshot', 'Critical', 'Blocked', 'Use only a Page uniquely registered to this tenant.'],
  ['LEAD-03', 'Lead Ads', 'Meta', 'Map and publish staging lead form', 'Meta Ads Manager / Instant Forms', 'FORM_ID; field list; privacy URL', 'PRE-06; TEN-07', 'Marketing admin', 'Published form and field mapping', 'High', 'Blocked', 'Avoid collecting unnecessary sensitive data.'],
  ['LEAD-04', 'Lead Ads', 'Test', 'Submit Meta test lead', 'Meta Lead Ads testing tool', 'Test identity/contact only', 'LEAD-02; LEAD-03; INT-02/03', 'QA / intern', 'Provider test lead id and submission time', 'Critical', 'Blocked', 'Never use an employee’s real sensitive data without approval.'],
  ['LEAD-05', 'Lead Ads', 'CaratOS', 'Verify persist-first webhook event', 'Database/admin diagnostics', 'Provider event id', 'LEAD-04', 'Engineering', 'Signature verified; WebhookEvent stored before job', 'Critical', 'Blocked', 'No raw contact values in logs/screenshots.'],
  ['LEAD-06', 'Lead Ads', 'CaratOS', 'Verify durable Graph lead-fetch job succeeds', 'Jobs dashboard', 'meta.lead_ads.fetch job id', 'LEAD-05', 'Engineering', 'succeeded; attempts; bounded result', 'Critical', 'Blocked', 'No “CRM sink is not registered” error.'],
  ['LEAD-07', 'Lead Ads', 'CaratOS', 'Verify CRM identity, lead and provenance', 'CRM + attribution view', 'Expected Meta test lead', 'LEAD-06', 'QA / intern', 'Party/ContactPoint/Lead; source=meta_ads; asset ids', 'Critical', 'Blocked', 'Missing provider fields remain null, never invented.'],
  ['LEAD-08', 'Lead Ads', 'CaratOS', 'Verify ad-set routing and duplicate replay', 'CRM routing + webhook replay', 'Same signed fixture/event twice', 'LEAD-07', 'QA / intern', 'Correct store/owner; one logical lead only', 'Critical', 'Blocked', 'Ambiguous Page ownership must fail closed.'],

  ['ROAS-01', 'ROAS', 'Meta', 'Confirm ad-account currency and timezone', 'Meta Ads Manager', 'Currency code; timezone; AD_ACCOUNT_ID', 'TEN-08', 'Marketing admin', 'Account settings screenshot', 'Critical', 'Blocked', 'Currency is required for an honest ROAS result.'],
  ['ROAS-02', 'ROAS', 'CaratOS', 'Queue bounded Insights sync', 'POST /attribution/meta-ads/sync', '{"integrationId":"<id>","adAccountAssetId":"<asset-row-id>","dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD"}', 'INT-05/06; TEN-09', 'Tenant head office', 'Job id and requested date range', 'High', 'Blocked', 'Use CaratOS asset row id, not provider account id.'],
  ['ROAS-03', 'ROAS', 'CaratOS', 'Verify daily measured-spend coverage', 'Spend coverage/admin view', 'Requested account/date range', 'ROAS-02', 'Engineering', 'Every day complete or explicitly incomplete', 'Critical', 'Blocked', 'No partial coverage may produce complete ROAS.'],
  ['ROAS-04', 'ROAS', 'CaratOS', 'Verify revenue/spend currency gate', 'GET /attribution/meta-ads/performance', 'Same-currency and mismatch fixtures', 'ROAS-03', 'QA / intern', 'Matching computes; mismatch returns unavailable', 'Critical', 'Blocked', 'Never divide unlike currencies.'],
  ['ROAS-05', 'ROAS', 'Test', 'Reconcile spend to Meta Ads Manager', 'Ads Manager vs CaratOS', 'Same account, timezone and dates', 'ROAS-03', 'Marketing admin + QA', 'Variance sheet and explanation', 'High', 'Blocked', 'Compare net of timezone/date boundary differences.'],
  ['ROAS-06', 'ROAS', 'Test', 'Validate attribution model outputs', 'GET /attribution/meta-ads/performance', 'first_touch and last_touch', 'ROAS-04', 'QA / intern', 'Measured revenue, spend, CPL and ROAS evidence', 'High', 'Blocked', 'Do not silently change existing model meaning.'],

  ['GO-01', 'Go Live', 'Security', 'Rotate all staging tokens before production', 'Meta + secret manager + CaratOS credential UI', 'Owner/date/reference only', 'All staging tests done', 'Security / DevOps', 'Rotation timestamps and health recheck', 'Critical', 'Blocked', 'Do not reuse test tokens.'],
  ['GO-02', 'Go Live', 'Operations', 'Configure dead-job and webhook-failure alerts', 'Monitoring / Jobs dashboard', 'Metadata-only alerts', 'Integration code complete', 'DevOps', 'Controlled alert test', 'Critical', 'Blocked', 'No tokens, message bodies, phone or email in alerts.'],
  ['GO-03', 'Go Live', 'Database', 'Complete backup/PITR restore drill', 'Database provider', 'Backup reference only', 'PRE-03', 'DevOps', 'Restore timestamp and validation result', 'Critical', 'Blocked', 'Test restore, not just backup existence.'],
  ['GO-04', 'Go Live', 'Release', 'Run final full regression from zero', 'CI/staging', 'Release SHA', 'All prior rows done', 'Engineering', 'Exact suites/tests/build/lint totals', 'Critical', 'Blocked', 'Any skip must be named and accepted.'],
  ['GO-05', 'Go Live', 'Product', 'Approve go-live and customer test window', 'Change record', 'Tenant; window; rollback owner', 'GO-01…GO-04', 'Product owner', 'Signed approval/change ticket', 'Critical', 'Blocked', 'No unscheduled customer messaging.'],
  ['GO-06', 'Go Live', 'Meta', 'Record app-review/live-provider evidence', 'Meta App Dashboard + CaratOS', 'No secrets', 'APP-08; GO-05', 'Meta admin', 'Approved permissions; real signed event timestamps', 'Critical', 'Blocked', 'Only now may the integration be called live-verified.'],
];

const credentials = [
  ['CREDENTIAL_ENCRYPTION_KEY', 'CaratOS platform', 'DevOps', 'Staging/production secret manager', 'No', '90 days or incident', '', '', '32 random bytes, base64.'],
  ['META_APP_SECRET', 'Meta App', 'Meta admin', 'Staging/production secret manager', 'No', 'On compromise/app rotation', '', '', 'Used for Lead Ads webhook signature verification.'],
  ['META_WEBHOOK_VERIFY_TOKEN', 'Meta Lead Ads webhook', 'Meta admin', 'Password manager + secret manager', 'No', '90 days or incident', '', '', 'Must match Meta dashboard.'],
  ['WHATSAPP_APP_SECRET', 'WhatsApp Meta App', 'WhatsApp admin', 'Staging/production secret manager', 'No', 'On compromise/app rotation', '', '', 'Used for WhatsApp webhook signature verification.'],
  ['WHATSAPP_WEBHOOK_VERIFY_TOKEN', 'WhatsApp webhook', 'WhatsApp admin', 'Password manager + secret manager', 'No', '90 days or incident', '', '', 'Distinct from Lead Ads verify token.'],
  ['Tenant WhatsApp access_token', 'Tenant WABA', 'Tenant head office', 'Encrypted IntegrationCredential', 'No', 'Before expiry/permission change', '', '', 'One tenant token per integration.'],
  ['Tenant Meta access_token', 'Tenant Page/ad account', 'Tenant head office', 'Encrypted IntegrationCredential', 'No', 'Before expiry/permission change', '', '', 'Never a platform env variable.'],
  ['CRM_QR_SECRET', 'CaratOS platform', 'DevOps', 'Staging/production secret manager', 'No', 'Planned poster/token rotation', '', '', 'Independent from JWT_SECRET.'],
];

const workbook = new ExcelJS.Workbook();
workbook.creator = 'CaratOS Engineering';
workbook.company = 'CaratOS';
workbook.subject = 'Manual Meta, WhatsApp, Lead Ads and ROAS integration handover';
workbook.title = 'CaratOS Meta & WhatsApp Integration Handover';
workbook.created = new Date();
workbook.modified = new Date();

const navy = 'FF172554';
const blue = 'FF2563EB';
const paleBlue = 'FFEFF6FF';
const paleAmber = 'FFFFFBEB';
const paleRed = 'FFFEF2F2';
const paleGreen = 'FFF0FDF4';
const grey = 'FFF3F4F6';
const white = 'FFFFFFFF';

function title(ws, text, subtitle) {
  ws.mergeCells('A1:K1');
  ws.getCell('A1').value = text;
  ws.getCell('A1').font = { size: 18, bold: true, color: { argb: white } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
  ws.getCell('A1').alignment = { vertical: 'middle' };
  ws.getRow(1).height = 30;
  ws.mergeCells('A2:K2');
  ws.getCell('A2').value = subtitle;
  ws.getCell('A2').font = { italic: true, color: { argb: 'FF475569' } };
  ws.getCell('A2').alignment = { wrapText: true, vertical: 'middle' };
  ws.getRow(2).height = 34;
}

function styleTable(ws, headerRow, lastRow, widths) {
  const header = ws.getRow(headerRow);
  header.font = { bold: true, color: { argb: white } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: blue } };
  header.alignment = { vertical: 'middle', wrapText: true };
  header.height = 30;
  for (let i = headerRow + 1; i <= lastRow; i += 1) {
    const row = ws.getRow(i);
    row.alignment = { vertical: 'top', wrapText: true };
    if (i % 2 === 0) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    row.height = 45;
    const status = row.getCell(11);
    status.dataValidation = {
      type: 'list',
      allowBlank: false,
      formulae: ['"Not started,Blocked,In progress,Ready for review,Done,N/A"'],
    };
    const statusFill = status.value === 'Done'
      ? paleGreen
      : status.value === 'Blocked'
        ? paleRed
        : status.value === 'In progress'
          ? paleAmber
          : grey;
    status.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: statusFill } };
  }
  widths.forEach((width, index) => { ws.getColumn(index + 1).width = width; });
  ws.views = [{ state: 'frozen', ySplit: headerRow, xSplit: 3 }];
  ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: lastRow, column: widths.length } };
}

const readme = workbook.addWorksheet('READ ME', { properties: { tabColor: { argb: navy } } });
title(readme, 'CaratOS — Meta & WhatsApp Manual Integration', 'Intern handover workbook. Never paste access tokens, app secrets, passwords, OTPs, recovery codes or customer contact data into this file.');
readme.getColumn(1).width = 31;
readme.getColumn(2).width = 72;
readme.getColumn(3).width = 25;
const summary = [
  ['Rule', 'Meaning', 'Current value'],
  ['Total checklist tasks', 'All manual setup, verification and go-live tasks', { formula: "COUNTA('Master Checklist'!A:A)-1" }],
  ['Completed', 'Rows whose Status is Done', { formula: "COUNTIF('Master Checklist'!K:K,\"Done\")" }],
  ['Blocked', 'Rows whose Status is Blocked', { formula: "COUNTIF('Master Checklist'!K:K,\"Blocked\")" }],
  ['Completion', 'Done / actionable rows', { formula: "IFERROR(COUNTIF('Master Checklist'!K:K,\"Done\")/(COUNTA('Master Checklist'!A:A)-1-COUNTIF('Master Checklist'!K:K,\"N/A\")),0)" }],
  ['Webhook base', 'Replace <api> with the stable public HTTPS backend domain', 'https://<api>'],
  ['WhatsApp callback', 'Inbound messages and delivery receipts', 'https://<api>/integrations/whatsapp/webhook'],
  ['Lead Ads callback', 'Leadgen notifications', 'https://<api>/integrations/meta/webhook'],
  ['Current truth', 'Code is fixture-tested; it is not live-provider verified', 'DO NOT MARKET AS LIVE'],
];
readme.addRows(summary);
readme.getRow(3).font = { bold: true, color: { argb: white } };
readme.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: blue } };
readme.getCell('C7').numFmt = '0%';
for (let row = 4; row <= 11; row += 1) {
  readme.getRow(row).alignment = { vertical: 'top', wrapText: true };
  readme.getRow(row).height = 34;
}
readme.mergeCells('A13:C13');
readme.getCell('A13').value = 'Operating rules';
readme.getCell('A13').font = { bold: true, color: { argb: white } };
readme.getCell('A13').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: navy } };
[
  '1. Complete staging first. Do not connect a production Page, form, ad account or phone number to an unverified build.',
  '2. Store tenant access tokens only through CaratOS encrypted IntegrationCredential. Environment variables are for app-level secrets only.',
  '3. A credential being stored is not the same as connected. Require a successful health/asset check.',
  '4. Capture screenshots with tokens, phone numbers, emails and customer lead fields redacted.',
  '5. Mark Live verified only after a real signed webhook and real provider result have been observed.',
  '6. If an instruction conflicts with the current Meta dashboard, stop and ask Engineering/Meta admin. Provider requirements change.',
].forEach((value) => {
  const row = readme.addRow([value]);
  readme.mergeCells(`A${row.number}:C${row.number}`);
  row.alignment = { wrapText: true, vertical: 'top' };
  row.height = 32;
});
readme.views = [{ state: 'frozen', ySplit: 2 }];

const headers = ['ID', 'Phase', 'System', 'Manual task', 'Console / API location', 'Exact input (never a secret)', 'Dependency', 'Owner', 'Evidence required', 'Risk', 'Status', 'Notes'];
const widths = [12, 18, 15, 43, 35, 52, 24, 22, 45, 12, 18, 48];

function addChecklistSheet(name, predicate, tabColor) {
  const ws = workbook.addWorksheet(name, { properties: { tabColor: { argb: tabColor } } });
  const rows = tasks.filter(predicate);
  ws.addRow(headers);
  rows.forEach((row) => ws.addRow(row));
  styleTable(ws, 1, rows.length + 1, widths);
  return ws;
}

addChecklistSheet('Master Checklist', () => true, navy);
addChecklistSheet('Environment', (r) => r[1] === 'Environment', 'FF7C3AED');
addChecklistSheet('Meta App', (r) => r[1] === 'Meta App' || r[1] === 'Prerequisites', 'FF1877F2');
addChecklistSheet('Tenant Setup', (r) => r[1] === 'Tenant Setup', 'FF0891B2');
addChecklistSheet('WhatsApp', (r) => r[1] === 'WhatsApp', 'FF16A34A');
addChecklistSheet('Lead Ads', (r) => r[1] === 'Lead Ads', 'FF2563EB');
addChecklistSheet('ROAS', (r) => r[1] === 'ROAS', 'FFF59E0B');
addChecklistSheet('Go Live', (r) => r[1] === 'Go Live', 'FFDC2626');

const credentialSheet = workbook.addWorksheet('Credential Register', { properties: { tabColor: { argb: 'FF9333EA' } } });
title(credentialSheet, 'Credential Register — References Only', 'Never enter a credential value. Record ownership, storage location, issuance and rotation dates only.');
credentialSheet.addRow(['Credential', 'Scope', 'Owner', 'Approved storage', 'Value recorded here?', 'Rotation policy', 'Issued/rotated date', 'Next review', 'Notes']);
credentials.forEach((row) => credentialSheet.addRow(row));
const credentialHeader = credentialSheet.getRow(3);
credentialHeader.font = { bold: true, color: { argb: white } };
credentialHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: blue } };
credentialHeader.alignment = { wrapText: true };
[32, 24, 22, 38, 20, 28, 20, 20, 48].forEach((width, i) => { credentialSheet.getColumn(i + 1).width = width; });
for (let i = 4; i <= credentials.length + 3; i += 1) {
  credentialSheet.getRow(i).alignment = { vertical: 'top', wrapText: true };
  credentialSheet.getRow(i).height = 40;
  credentialSheet.getCell(i, 5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: paleRed } };
}
credentialSheet.views = [{ state: 'frozen', ySplit: 3 }];
credentialSheet.autoFilter = `A3:I${credentials.length + 3}`;

const evidence = workbook.addWorksheet('Evidence Log', { properties: { tabColor: { argb: 'FF64748B' } } });
title(evidence, 'Evidence Log', 'Use references/links to approved redacted evidence. Never paste tokens, raw webhook bodies, phone numbers, emails or real lead fields.');
evidence.addRow(['Task ID', 'Date/time (IST)', 'Environment', 'Tester', 'Result', 'Evidence link/reference', 'Redaction checked by', 'Issue/ticket', 'Notes']);
for (let i = 0; i < 100; i += 1) evidence.addRow(['', '', '', '', '', '', '', '', '']);
const eHeader = evidence.getRow(3);
eHeader.font = { bold: true, color: { argb: white } };
eHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: blue } };
[14, 23, 18, 22, 18, 45, 24, 20, 48].forEach((width, i) => { evidence.getColumn(i + 1).width = width; });
for (let i = 4; i <= 103; i += 1) {
  evidence.getCell(i, 3).dataValidation = { type: 'list', formulae: ['"Local,Staging,Production"'] };
  evidence.getCell(i, 5).dataValidation = { type: 'list', formulae: ['"Pass,Fail,Blocked,Not run"'] };
  evidence.getRow(i).height = 28;
  evidence.getRow(i).alignment = { vertical: 'top', wrapText: true };
}
evidence.views = [{ state: 'frozen', ySplit: 3 }];
evidence.autoFilter = 'A3:I103';

for (const ws of workbook.worksheets) {
  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  ws.headerFooter.oddFooter = 'CaratOS confidential — no secrets or customer PII | Page &P of &N';
  ws.properties.defaultRowHeight = 20;
  ws.eachRow((row) => {
    row.eachCell((cell) => {
      cell.border = {
        top: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        left: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        bottom: { style: 'thin', color: { argb: 'FFE2E8F0' } },
        right: { style: 'thin', color: { argb: 'FFE2E8F0' } },
      };
    });
  });
}

await mkdir(resolve(output, '..'), { recursive: true });
await workbook.xlsx.writeFile(output);

// Re-open the binary artifact so a successful run proves more than “writeFile
// returned”: the workbook must be readable and retain the master checklist.
const verification = new ExcelJS.Workbook();
await verification.xlsx.readFile(output);
const master = verification.getWorksheet('Master Checklist');
const requiredSheets = [
  'READ ME',
  'Master Checklist',
  'Environment',
  'Meta App',
  'Tenant Setup',
  'WhatsApp',
  'Lead Ads',
  'ROAS',
  'Go Live',
  'Credential Register',
  'Evidence Log',
];
if (!master || master.rowCount !== tasks.length + 1) {
  throw new Error('Generated workbook failed master-checklist verification.');
}
for (const name of requiredSheets) {
  if (!verification.getWorksheet(name)) throw new Error(`Generated workbook is missing ${name}.`);
}
console.log(`${output}\nverified: ${tasks.length} tasks, ${requiredSheets.length} sheets`);
