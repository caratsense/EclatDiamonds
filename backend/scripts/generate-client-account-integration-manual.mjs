import JSZip from 'jszip';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = resolve(process.cwd(), '..', 'docs', 'handovers', 'CaratOS-Individual-Client-Account-and-Integration-Setup-Manual.docx');

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
  const shade = options.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.shade}"/>` : '';
  const border = options.border ? '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="2563EB"/></w:pBdr>' : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/><w:spacing w:after="${spacing}"/>${shade}${border}</w:pPr>${run(text, options)}</w:p>`;
}

function bullet(text, level = 0) {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="${360 + level * 360}" w:hanging="240"/><w:spacing w:after="50"/></w:pPr>${run('•  ' + text)}</w:p>`;
}

function step(number, text) {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:ind w:left="360" w:hanging="280"/><w:spacing w:after="70"/></w:pPr>${run(`${number}.  `, { bold: true, color: '2563EB' })}${run(text)}</w:p>`;
}

function cell(text, options = {}) {
  const fill = options.header ? '172554' : options.fill ?? 'FFFFFF';
  const color = options.header ? 'FFFFFF' : '0F172A';
  const width = options.width ?? 3000;
  return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="${fill}"/><w:tcMar><w:top w:w="80" w:type="dxa"/><w:left w:w="90" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="90" w:type="dxa"/></w:tcMar></w:tcPr><w:p><w:pPr><w:spacing w:after="0"/></w:pPr>${run(text, { bold: options.header, color, size: options.header ? 19 : 18 })}</w:p></w:tc>`;
}

function table(headers, rows, widths) {
  const borders = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="CBD5E1"/><w:left w:val="single" w:sz="4" w:color="CBD5E1"/><w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/><w:right w:val="single" w:sz="4" w:color="CBD5E1"/><w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/><w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/></w:tblBorders>';
  const header = `<w:tr>${headers.map((h, i) => cell(h, { header: true, width: widths[i] })).join('')}</w:tr>`;
  const body = rows.map((row, rowIndex) => `<w:tr>${row.map((value, i) => cell(value, { width: widths[i], fill: rowIndex % 2 ? 'F8FAFC' : 'FFFFFF' })).join('')}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${header}${body}</w:tbl>`;
}

const body = [
  para('CaratOS Individual Client Account and Integration Setup Manual', 'Title', { bold: true, color: '172554', size: 38, after: 120 }),
  para('Practical onboarding guide for a jeweller, textile company and fashion brand', 'Subtitle', { color: '475569', size: 23, after: 220 }),
  para('Version: 1.0  |  Prepared: 10 September 2026  |  Audience: CaratOS owner, onboarding team, client administrator and client IT/accounting team', 'Normal', { italic: true, color: '64748B' }),
  para('Purpose', 'Heading1'),
  para('This manual explains how to create separate client organisations inside one CaratOS platform, create individual staff accounts, connect each client’s Meta, WhatsApp, Instagram, Google Business Profile, email and business software, and verify that one client can never see another client’s data.', 'Normal', { shade: 'EFF6FF', border: true }),
  para('The short answer', 'Heading1'),
  table(['Question', 'Answer'], [
    ['Does every client need a separate AWS account?', 'No. Standard customers use the shared CaratOS SaaS. A separate deployment is an optional enterprise product.'],
    ['Does every staff member need Gmail?', 'No. CaratOS supports its own login handle and password. A real contact email is recommended but need not be Gmail.'],
    ['Is an identity provider (IdP/SSO) required?', 'No for the MVP. Local CaratOS accounts work. Google Sign-In is optional. Enterprise SAML/OIDC should be sold only after it is implemented and verified.'],
    ['Is SMTP required?', 'Only if CaratOS must send real email notifications, reports or campaigns. Without SMTP the current service is a dry-run and sends nothing.'],
    ['Does every client need a new Meta developer app?', 'Normally no. CaratOS owns one reviewed platform app; each client authorises its own Page, ad account, WABA, phone and Instagram assets.'],
    ['Does every client need a separate AI account?', 'No. CaratOS may use one centrally billed provider with tenant limits. Enterprise clients may bring their own key after BYOK is verified.'],
  ], [3300, 6100]),

  para('1. How three companies live inside one CaratOS platform', 'Heading1'),
  para('Create one Organisation record for each customer. Organisation is the security boundary. Every user, branch, customer, lead, message, task, catalogue item and integration must carry that organisation’s identity.'),
  table(['Example client', 'CaratOS industry pack', 'Typical locations', 'Main connections'], [
    ['Aurum Jewels', 'Jewellery retail', 'Showrooms and head office', 'Meta Ads, WhatsApp, Instagram, Google reviews per showroom, Tally/BUSY/Gati or CSV, AI catalogue'],
    ['Shakti Textiles', 'Textile & apparel', 'Showroom, warehouse, mill/office', 'WhatsApp, Meta where used, BUSY/Tally, product/article import, email, attendance'],
    ['Northstar Fashion', 'Textile & apparel if apparel-led; Retail & e-commerce if broader retail-led', 'Stores, warehouse and e-commerce office', 'Instagram, Meta Ads, WhatsApp, website leads, e-commerce/CSV, email, Google reviews, AI catalogue'],
  ], [2300, 3000, 2200, 3500]),
  para('Important: never use one client organisation for unrelated companies. Never reuse one company’s Meta token, WhatsApp sender, Google location, SMTP identity or connector login for another company.'),

  para('2. Who must participate', 'Heading1'),
  table(['Owner', 'Responsibilities'], [
    ['CaratOS platform owner / DevOps', 'Runs hosting, database, encryption keys, backups, domains, global provider applications, deployments and monitoring.'],
    ['CaratOS onboarding administrator', 'Creates the tenant, configures pack, branches, roles, fields, pipeline, integrations and acceptance tests.'],
    ['Client business owner', 'Approves data use, messaging, AI policy, users, branches, billing and go-live.'],
    ['Client Meta administrator', 'Controls Business Portfolio, Page, ad account, Instagram account, WABA, phone and permissions.'],
    ['Client Google Business Profile owner/manager', 'Controls verified business locations and grants OAuth/location access.'],
    ['Client IT/accounting contact', 'Provides read-only access/export details for Tally, BUSY, Gati or other systems and approves mappings.'],
    ['Client branch manager', 'Approves staff, branch assignment, routing, attendance location and local operating rules.'],
  ], [3000, 6400]),

  para('3. Information to collect before creating the client', 'Heading1'),
  bullet('Legal business name, trading name, logo and website.'),
  bullet('Industry and primary workflow: retail, wholesale, manufacturing, appointments, projects or mixed.'),
  bullet('Head-office address, timezone, base currency, tax/GST information and billing contact.'),
  bullet('Complete branch/location list with codes, addresses, managers and phone numbers.'),
  bullet('Staff list: name, contact email, phone, requested role and assigned branches.'),
  bullet('CRM vocabulary, pipeline stages, lead sources, qualification questions and required custom fields.'),
  bullet('Customer and product/service data samples with sensitive fields removed where possible.'),
  bullet('Which channels are actually required: WhatsApp, Meta Lead Ads, CTWA, Instagram, email, Google reviews, website forms, IVR.'),
  bullet('Which source system is authoritative for customers, products, inventory, sales, invoices and payments.'),
  bullet('Named owners for passwords, Meta, Google, domain/DNS, accounting software and final acceptance.'),

  para('4. One-time CaratOS platform setup', 'Heading1'),
  para('Complete these once for the whole SaaS, not separately for every client.'),
  bullet('Production and staging frontend/API domains over HTTPS.'),
  bullet('Separate production and staging databases; automated backups and a tested restore procedure.'),
  bullet('CREDENTIAL_ENCRYPTION_KEY and version in the deployment secret manager before any tenant secret is stored.'),
  bullet('One CaratOS Meta developer/business app, webhook endpoints, privacy policy and data-deletion instructions.'),
  bullet('One central AI provider account if CaratOS-managed AI is offered.'),
  bullet('One email delivery provider or SMTP service if email sending is offered.'),
  bullet('One Google Cloud project/OAuth application for CaratOS integrations, subject to the exact Google API being used.'),
  bullet('Monitoring, audit, job/dead-letter alerts, rate limits and restrictive staging recipient allowlists.'),
  para('Do not put platform secrets in a tenant notes field. Platform secrets stay in Railway/Vercel or another approved secret manager. Tenant provider credentials must use CaratOS encrypted credential storage.', 'Normal', { bold: true, color: '991B1B' }),

  para('5. Create each client organisation', 'Heading1'),
  step(1, 'Open the CaratOS login page and choose Create organisation.'),
  step(2, 'Enter the business name and choose the correct industry. Do not choose Jewellery merely because Eclat was the original tenant.'),
  step(3, 'For Aurum choose Jewellery retail. For Shakti choose Textile & apparel. For Northstar choose Textile & apparel when apparel terminology is primary, or Retail & e-commerce when general retail/e-commerce terminology is primary.'),
  step(4, 'Create the organisation owner/head-office administrator. Save the generated CaratOS login handle in the approved password manager or onboarding record.'),
  step(5, 'Sign in and verify the organisation name, industry vocabulary, navigation and branding.'),
  step(6, 'Create real branches/locations. Do not create an “all branches” row as a physical branch.'),
  step(7, 'Set timezone, currency, fiscal/tax settings, business hours and branch-specific contact details.'),
  step(8, 'Review the generated CRM pipeline, lead sources, qualification fields and drop-off reasons. Preserve client edits.'),
  step(9, 'Enable only the modules included in the client contract.'),
  step(10, 'Create a tenant acceptance record containing organisation ID/slug, industry pack/version and owner names—but no secrets.'),

  para('6. Create individual staff accounts', 'Heading1'),
  para('Use one account per human. Shared “store1” or “sales” passwords remove accountability and should not be used.'),
  table(['Role', 'Use', 'Typical scope'], [
    ['Head office / organisation administrator', 'Tenant settings, all branches, integrations, senior approvals', 'All authorised branches'],
    ['Area/region manager', 'Several branches and regional reporting', 'Assigned branch group'],
    ['Branch/store manager', 'Local staff approval, assignment and branch operations', 'One or selected branches'],
    ['Salesperson/agent', 'Leads, conversations, tasks, visits and permitted customer actions', 'Assigned branch'],
    ['Connector/service account', 'On-site sync agent only; no interactive business use', 'Least privilege for approved import profile'],
  ], [2600, 4000, 2800]),
  step(1, 'Administrator opens staff/user management and adds the person, or the person submits a self-registration request for a specific branch and role.'),
  step(2, 'Enter the person’s real contact email and phone. CaratOS generates a separate tenant-scoped login handle.'),
  step(3, 'A self-registered account remains inactive and powerless until an authorised manager approves it.'),
  step(4, 'Head office approves manager requests. A branch/area manager may approve only lower-ranked users inside their own scope.'),
  step(5, 'Assign branches explicitly and choose one primary branch where required.'),
  step(6, 'Give the user their generated login handle and a temporary password through an approved secure channel.'),
  step(7, 'Test login and verify the user cannot access another branch or tenant.'),
  step(8, 'Disable leavers immediately. Do not delete their audit history.'),
  para('Current account behavior', 'Heading2'),
  bullet('The generated login handle is the actual sign-in identifier. The person’s contact email is for communication.'),
  bullet('New non-Eclat handles are tenant scoped, for example priya.andheri@aurum-jewels.accounts.caratos.invalid.'),
  bullet('Eclat legacy handles remain unchanged to avoid locking out existing users.'),
  bullet('A contact email may be Gmail, Outlook or a company-domain address. Gmail is not mandatory.'),

  para('7. Gmail, Google Sign-In, IdP and SMTP decision', 'Heading1'),
  table(['Capability', 'Required?', 'What to do now'], [
    ['CaratOS username/password', 'Yes for normal MVP access', 'Use the generated CaratOS login handle and password.'],
    ['Personal Gmail account', 'No', 'Use any valid contact email. Prefer a company-domain email for administrators.'],
    ['Google Sign-In button', 'Optional', 'Configure one platform Google OAuth web client. It signs in existing CaratOS users; it does not automatically create/provision them.'],
    ['Google Workspace', 'Optional', 'Useful for corporate email and managed identities, but not required by CaratOS.'],
    ['External IdP/SSO such as Entra, Okta or SAML', 'Not required; not currently a verified standard onboarding path', 'Offer only as a separately implemented and tested enterprise feature.'],
    ['SMTP/email provider', 'Required only for real outgoing email', 'Configure for reports, notifications or campaigns. Without it, the current email service is dry-run.'],
    ['Google Business Profile OAuth', 'Required only for API-based review/location sync', 'Separate from Google Sign-In. Client must authorise access to its verified locations.'],
  ], [2700, 2200, 4500]),
  para('Google Sign-In setup', 'Heading2'),
  bullet('Create/select the CaratOS Google Cloud project and configure OAuth branding/consent.'),
  bullet('Create a Web application OAuth client and add the exact HTTPS frontend origins.'),
  bullet('Set the same client ID as GOOGLE_CLIENT_ID in the backend and NEXT_PUBLIC_GOOGLE_CLIENT_ID in the frontend.'),
  bullet('Google Sign-In matches an existing user by email and then binds Google subject identity; do not promise automatic employee provisioning.'),
  bullet('GOOGLE_ALLOWED_DOMAINS is currently a platform-wide list. For three unrelated customer domains, leave it blank unless the desired multi-domain policy is reviewed. It is not a per-tenant IdP policy.'),
  para('Email/SMTP setup', 'Heading2'),
  bullet('Preferred: use a transactional sender such as Amazon SES, Postmark, SendGrid, Resend or another approved provider rather than a personal Gmail mailbox.'),
  bullet('Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and SMTP_FROM in the backend secret manager.'),
  bullet('For branded client email, verify the client’s sending domain and configure SPF, DKIM and DMARC in DNS.'),
  bullet('Configure bounce, complaint and unsubscribe handling before bulk campaigns.'),
  bullet('The current EmailService reads one platform-level SMTP configuration. Do not promise independent per-tenant SMTP senders until tenant-level email credentials/routing are implemented and tested.'),
  bullet('If Google Workspace SMTP relay is used, configure it in the Google Admin console and use supported OAuth/relay authentication; do not use an ordinary Gmail password or “less secure apps.”'),

  para('8. Connect Meta Ads and Lead Forms for each client', 'Heading1'),
  para('CaratOS owns the platform app. Each customer owns and authorises its business assets.'),
  para('Client-side requirements', 'Heading2'),
  bullet('Meta Business Portfolio controlled by the client.'),
  bullet('Facebook Page and Page administrator.'),
  bullet('Ad account and advertiser/admin access.'),
  bullet('Lead Forms and test access.'),
  bullet('Business verification and permissions required by Meta for the chosen production flow.'),
  bullet('Privacy policy and lawful customer-contact process.'),
  para('Connection procedure', 'Heading2'),
  step(1, 'Client Meta administrator signs into Meta from CaratOS Connect Meta/Embedded Signup or the approved onboarding procedure.'),
  step(2, 'Select the correct Business Portfolio, Page and ad account. Never select an agency’s unrelated assets.'),
  step(3, 'Grant only the permissions actually required for Page/webhook subscription, lead retrieval and Ads Insights.'),
  step(4, 'CaratOS stores the token through the encrypted write-only credential field.'),
  step(5, 'Register Page, form, ad account and other asset IDs under the correct CaratOS organisation.'),
  step(6, 'Run ownership/health checks. Manually entered IDs are not enough; CaratOS must read the assets back from Meta.'),
  step(7, 'Subscribe the Page to the CaratOS Lead Ads webhook at https://<api-domain>/integrations/meta/webhook.'),
  step(8, 'Submit a Meta test lead, then confirm exactly one customer and lead appear in the correct tenant with form/campaign/ad attribution.'),
  step(9, 'Replay the event and confirm no duplicate is created.'),
  step(10, 'Map ad/ad-set/location rules to branches and verify fair assignment and audit history.'),
  para('Store the Meta app secret and webhook verify token only in the platform secret manager. Store client access tokens only in encrypted tenant credential storage. Never paste them into this manual.', 'Normal', { bold: true, color: '991B1B' }),

  para('9. Connect WhatsApp for each client', 'Heading1'),
  para('Client-side requirements', 'Heading2'),
  bullet('A WhatsApp Business Account (WABA) owned or properly shared by the client.'),
  bullet('A business phone number that can complete Meta verification/registration.'),
  bullet('Approved display name and payment method where required.'),
  bullet('Approved message templates in every language the client will use.'),
  bullet('A staff owner responsible for consent, opt-outs and content approval.'),
  para('Connection procedure', 'Heading2'),
  step(1, 'Use Meta Embedded Signup or the approved manual procedure to select/create the client WABA and verify the client phone number.'),
  step(2, 'Record WABA ID and numeric Phone Number ID; do not confuse the visible telephone number with Phone Number ID.'),
  step(3, 'Save the access token using CaratOS encrypted integration credentials and register the phone_number asset under the tenant.'),
  step(4, 'Subscribe the WABA to the CaratOS app and configure https://<api-domain>/integrations/whatsapp/webhook.'),
  step(5, 'Sync templates and confirm name, language and Meta approval state.'),
  step(6, 'Run the health/asset ownership check.'),
  step(7, 'Send an inbound test message from an allowlisted test number and verify conversation, customer identity and delivery receipts.'),
  step(8, 'Test STOP, consent revocation, 24-hour window enforcement and an approved template outside the window.'),
  step(9, 'Test a CTWA ad click and verify referral, campaign/ad attribution, branch routing, lead creation and follow-up.'),
  step(10, 'Remove the restrictive staging allowlist only through the approved production change process.'),

  para('10. Connect Instagram for each client', 'Heading1'),
  para('Instagram integration and WhatsApp are separate even though both are administered through Meta.'),
  bullet('Client needs an Instagram professional/business account, not an ordinary unconnected personal account.'),
  bullet('Connect the Instagram account to the correct Facebook Page/business portfolio.'),
  bullet('The client Meta administrator authorises the Page and Instagram assets to CaratOS.'),
  bullet('Register the Instagram account ID as a tenant-owned asset.'),
  bullet('Subscribe the exact supported webhook events and send a real test DM.'),
  bullet('Verify the event creates a conversation only inside that tenant and that reply/delivery behavior matches the supported API.'),
  para('Current truth: do not sell Instagram DM as live merely because an adapter or fixture exists. It becomes live only after Meta permissions, real asset ownership, a real signed inbound DM and an allowed outbound reply are verified.', 'Normal', { shade: 'FEF3C7', border: true }),

  para('11. Connect Google Reviews / Business Profile', 'Heading1'),
  para('There are two levels. A simple review link can work without API access. Review aggregation, replies and location synchronization require Google Business Profile API access and OAuth.'),
  para('Client-side requirements', 'Heading2'),
  bullet('A verified Google Business Profile for every public branch/location.'),
  bullet('A client Google account that is an owner or authorised manager of those profiles.'),
  bullet('Correct location names, addresses, phone numbers and website links.'),
  bullet('Approval to send feedback/review requests to customers.'),
  para('Simple review-link setup', 'Heading2'),
  step(1, 'Client opens the relevant Google Business Profile and obtains the “Ask for reviews” link for each branch.'),
  step(2, 'CaratOS stores each link against the matching branch.'),
  step(3, 'Send private feedback first. Route negative feedback internally and show the public review link according to the approved business policy.'),
  step(4, 'Test each link manually; do not reuse one branch’s link for all branches.'),
  para('API-based review setup', 'Heading2'),
  step(1, 'CaratOS applies for Google Business Profile API access using the CaratOS Google Cloud project and legitimate business use case.'),
  step(2, 'Enable the approved Business Profile APIs and create OAuth credentials/consent configuration.'),
  step(3, 'Client profile owner signs in and grants the business.manage scope to CaratOS.'),
  step(4, 'CaratOS lists only locations the user granted, then maps each Google location ID to the correct tenant branch.'),
  step(5, 'Run a live read test and verify no other client’s locations are visible.'),
  para('Google Business Profile access is project-approved and there is no general sandbox. Keep the integration marked unconfigured or fixture-tested until a real authorised profile answers successfully.', 'Normal', { shade: 'FEF3C7', border: true }),

  para('12. Configure AI for each client', 'Heading1'),
  para('CaratOS-managed AI is the simplest initial product. One provider account serves tenants while CaratOS records and limits usage separately.'),
  table(['Setting', 'Jeweller example', 'Textile example', 'Fashion example'], [
    ['Knowledge', 'Policies, product guides, appointments, certifications, offers', 'Fabric catalogue, MOQ, lead time, sampling and dispatch policies', 'Size guide, returns, materials, availability policy and store information'],
    ['Human-only topics', 'Final price/discount commitment, certification dispute, complaint', 'Credit terms, contractual MOQ changes, quality dispute', 'Refund dispute, payment issue, legal complaint'],
    ['Possible AI-first campaigns', 'Collection enquiry and store-visit booking', 'Catalogue/sample enquiry', 'Product discovery, sizing and store availability policy'],
    ['Likely human-first campaigns', 'Franchise, wholesale and high-value negotiation', 'Large institutional orders and credit negotiation', 'Influencer/commercial partnership and escalated complaint'],
  ], [2000, 2450, 2450, 2450]),
  bullet('Platform environment: CRM_AI_PROVIDER, CRM_AI_MODEL, CRM_AI_API_KEY and optional CRM_AI_BASE_URL.'),
  bullet('Never expose the provider key to the browser or client staff.'),
  bullet('Upload only approved tenant knowledge. Test retrieval and citations.'),
  bullet('Automatic replies remain off by default. Enable per tenant/ad only after consent, STOP, knowledge, confidence and human-escalation tests pass.'),
  bullet('Set a monthly tenant budget/usage limit and an emergency kill switch.'),
  bullet('If the AI provider is absent or unhealthy, CaratOS must continue as a human CRM.'),
  bullet('If an enterprise client supplies its own key, use encrypted BYOK storage only after that path is verified; never store it in ordinary settings or chat.'),

  para('13. Connect Tally, BUSY, Gati or another client system', 'Heading1'),
  para('The client does not need to expose its database to the internet. Prefer a small CaratOS Connect agent installed on a controlled Windows computer/server that makes an outbound encrypted connection.'),
  para('Client-side requirements', 'Heading2'),
  bullet('Exact software name, edition and version.'),
  bullet('Company/database name and location.'),
  bullet('Named IT/accounting owner.'),
  bullet('Read-only database/API/export access wherever possible.'),
  bullet('An always-on or scheduled Windows machine with internet access for the connector.'),
  bullet('Approved entities: customers, items, stock, orders, invoices, payments and/or ledgers.'),
  bullet('Sample export or sanitized database schema.'),
  bullet('Branch/company mapping and source-of-truth decision.'),
  bullet('Initial reconciliation totals and sign-off.'),
  para('Setup procedure', 'Heading2'),
  step(1, 'Create a dedicated least-privilege CaratOS connector/service account inside the correct tenant.'),
  step(2, 'Install the signed/reviewed CaratOS Connect agent on the approved client machine.'),
  step(3, 'Create a client-specific profile containing source version, safe connection descriptor, approved entities and field mappings.'),
  step(4, 'Do not send raw database passwords to CaratOS cloud logs or documentation.'),
  step(5, 'Run capability/schema discovery, then perform a read-only preview.'),
  step(6, 'Review mapping, duplicate behavior, invalid rows and branch resolution with the client.'),
  step(7, 'Run a limited pilot import and compare counts/totals against the source.'),
  step(8, 'Enable incremental synchronization with cursor/checkpoint only after sign-off.'),
  step(9, 'Verify idempotency by repeating the same batch and confirming no duplicates.'),
  step(10, 'Monitor receipts, last-success time and failures. Keep unsupported entities disabled rather than guessing mappings.'),
  para('Current product boundary', 'Heading2'),
  bullet('BUSY has starter support for customer and item masters; transaction mappings remain installation-specific.'),
  bullet('Tally file/import paths and connector foundations exist, but direct client Tally behavior must be mapped and accepted against the real installation.'),
  bullet('Gati mappings are profile/installation specific. Confirm whether “Gati” means the current legacy database or a logistics provider before configuration.'),
  bullet('When direct integration is unavailable, use CSV/XLS/XLSX preview and import receipts.'),
  bullet('PDF/DOC/DOCX/TXT files belong in the knowledge-document flow; do not pretend they are structured accounting transactions.'),

  para('14. Website, catalogue and attendance setup', 'Heading1'),
  para('Website leads', 'Heading2'),
  bullet('Create a tenant-specific public lead form and publish only its public key/URL.'),
  bullet('Choose required fields, consent wording, branch/routing rules and spam protection.'),
  bullet('Submit a test enquiry and verify one Party and one Lead with source website.'),
  para('Catalogue', 'Heading2'),
  bullet('Import or create neutral products/items/services. Jewellery fields appear only for jewellery tenants.'),
  bullet('Configure object/image storage and tenant-safe object paths.'),
  bullet('For AI visual matching, deploy the inference service and configure ML_INFERENCE_URL/ML_INFERENCE_KEY.'),
  bullet('Without inference, manual catalogue management must remain available and the UI must say AI is unavailable.'),
  para('Attendance', 'Heading2'),
  bullet('Create employees, shifts, holidays and leave policies.'),
  bullet('Record accurate branch latitude/longitude and approved radius where location verification is used.'),
  bullet('Test check-in, check-out, missed checkout and manager correction.'),
  bullet('Attendance does not require an AI API, Gmail, Meta or SMTP.'),

  para('15. Three-client practical checklist', 'Heading1'),
  table(['Area', 'Aurum Jewels', 'Shakti Textiles', 'Northstar Fashion'], [
    ['Organisation', 'Jewellery retail pack', 'Textile & apparel pack', 'Textile & apparel or Retail & e-commerce after workflow decision'],
    ['Locations', 'Every showroom + HO', 'Office, warehouse, showroom/mill as operationally needed', 'Stores, warehouse, e-commerce office'],
    ['Users', 'HO, area/store managers, sales staff, calling team', 'Owner, sales, accounts, warehouse and managers', 'E-commerce, store, support, marketing and managers'],
    ['Meta', 'Page, ad account, lead forms, CTWA campaigns', 'Only if Meta campaigns are used', 'High priority: Page, ad account and campaigns'],
    ['WhatsApp', 'Separate approved sender or client WABA number', 'Sales/support number', 'Commerce/support number'],
    ['Instagram', 'Professional account linked to Page if used', 'Optional', 'High priority professional account linked to Page'],
    ['Google reviews', 'Map every public showroom', 'Optional for public outlets', 'Map every public store'],
    ['Email', 'Reports/appointments/campaigns if contracted', 'B2B reports/quotes/campaigns if contracted', 'Transactional and marketing email likely required'],
    ['Business system', 'Tally/BUSY/Gati/POS mapping', 'BUSY/Tally/ERP mapping', 'E-commerce/POS/ERP API or CSV mapping'],
    ['Catalogue', 'Jewellery categories/metals plus visual catalogue', 'Article/fabric/material attributes', 'Styles, variants, sizes, colours, materials'],
    ['Special acceptance', 'Online ad → showroom visit → sale attribution', 'Buyer enquiry → quote/order and stock/account sync', 'Instagram/ad → conversation/order/store visit and return policy'],
  ], [1600, 2600, 2600, 2600]),

  para('16. Go-live acceptance test for every client', 'Heading1'),
  bullet('Login: administrator and salesperson can log in; unapproved user cannot.'),
  bullet('Isolation: client A cannot access client B by URL, search, export, API or asset ID.'),
  bullet('Roles: salesperson cannot perform manager/head-office actions.'),
  bullet('Branch: local user sees only assigned locations.'),
  bullet('Website: test submission becomes exactly one customer and lead.'),
  bullet('Meta: real or approved test lead arrives exactly once with correct attribution.'),
  bullet('WhatsApp: inbound, reply, template, delivery receipt, STOP and 24-hour rules pass.'),
  bullet('Instagram: mark live only after a real authorised inbound and supported reply pass.'),
  bullet('Google: every review link opens the intended branch; API status is truthful.'),
  bullet('Email: SPF/DKIM/DMARC and delivery/bounce behavior checked if email is enabled.'),
  bullet('AI: uses only tenant knowledge; risky/unknown requests reach a human.'),
  bullet('Connector: preview, pilot, reconciliation, replay and failure receipt pass.'),
  bullet('Mobile/in-store: partial phone search, visit, item scan/manual fallback and follow-up work.'),
  bullet('Attendance: location/shift behavior and correction audit pass if enabled.'),
  bullet('Backup: production backup and restore procedure have an owner.'),
  bullet('Owner signs a go-live sheet listing live, fixture-only, disabled and later integrations.'),

  para('17. What must never be collected in an onboarding document', 'Heading1'),
  bullet('Meta access tokens or app secrets.'),
  bullet('WhatsApp access tokens, OTPs or webhook verify tokens.'),
  bullet('AI API keys.'),
  bullet('SMTP passwords.'),
  bullet('Database passwords or full connection strings.'),
  bullet('CaratOS encryption keys or JWT secrets.'),
  bullet('Unredacted customer exports, WhatsApp messages, lead-form answers or call recordings.'),
  bullet('Password-recovery codes or administrator personal passwords.'),
  para('Use a password/secret manager and record only the secret name, owner, environment, creation date and last rotation date in the handover.', 'Normal', { bold: true, color: '991B1B' }),

  para('18. Offboarding or changing a client integration', 'Heading1'),
  step(1, 'Disable sending and scheduled campaigns.'),
  step(2, 'Revoke provider authorisation/token and unsubscribe webhooks where required.'),
  step(3, 'Disable connector service accounts and local agents.'),
  step(4, 'Export client data only under the agreed contract and permissions.'),
  step(5, 'Apply retention/deletion policy and preserve required audit evidence.'),
  step(6, 'Remove access for former staff and update asset owners.'),
  step(7, 'Record the date, approver and verification evidence.'),

  para('19. Setup record template — complete once per client', 'Heading1'),
  table(['Field', 'Value'], [
    ['Client legal/trading name', '____________________________________________'],
    ['CaratOS organisation ID/slug', '____________________________________________'],
    ['Industry pack/version', '____________________________________________'],
    ['Business owner', '____________________________________________'],
    ['CaratOS onboarding owner', '____________________________________________'],
    ['Meta administrator', '____________________________________________'],
    ['Google Profile owner', '____________________________________________'],
    ['IT/accounting owner', '____________________________________________'],
    ['Branches configured and verified', '____________________________________________'],
    ['Live integrations', '____________________________________________'],
    ['Fixture-only integrations', '____________________________________________'],
    ['Disabled/not purchased', '____________________________________________'],
    ['Outstanding approvals', '____________________________________________'],
    ['Acceptance-test date', '____________________________________________'],
    ['Go-live approver/date', '____________________________________________'],
  ], [3700, 5700]),

  para('20. Official references and internal source of truth', 'Heading1'),
  bullet('Google Sign-In setup: https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid'),
  bullet('Google Business Profile API setup: https://developers.google.com/my-business/content/basic-setup'),
  bullet('Google Business Profile OAuth: https://developers.google.com/my-business/content/implement-oauth'),
  bullet('Google Workspace SMTP relay: https://support.google.com/a/answer/2956491'),
  bullet('Google SPF guidance: https://support.google.com/a/answer/33786'),
  bullet('WhatsApp Business Platform partner/onboarding overview: https://whatsappbusiness.com/partners/become-a-partner/'),
  bullet('Meta Embedded Signup reference: https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup'),
  bullet('CaratOS environment template: C:\\Users\\Shrey\\Eclat\\backend\\.env.example'),
  bullet('CaratOS Meta/WhatsApp manual: C:\\Users\\Shrey\\Eclat\\docs\\handovers\\META-WHATSAPP-MANUAL-SETUP.docx'),
  bullet('CaratOS connector manual: C:\\Users\\Shrey\\Eclat\\docs\\handovers\\CLIENT-CONNECTOR-ONBOARDING.docx'),
  bullet('CaratOS AI manual: C:\\Users\\Shrey\\Eclat\\docs\\handovers\\AI-PROVIDER-SETUP.docx'),
  para('Provider rules and permission names change. Confirm them in the provider’s current official console/documentation at onboarding time.', 'Normal', { italic: true, color: '475569' }),
].join('');

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="950" w:right="850" w:bottom="950" w:left="850" w:header="400" w:footer="400" w:gutter="0"/><w:footerReference w:type="default" r:id="rIdFooter1"/></w:sectPr></w:body>
</w:document>`;

const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos"/><w:sz w:val="20"/><w:color w:val="0F172A"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:line="260" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Subtitle"/></w:style>
  <w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:keepNext/><w:keepLines/><w:rPr><w:b/><w:color w:val="172554"/><w:sz w:val="29"/></w:rPr><w:pPr><w:spacing w:before="250" w:after="100"/><w:outlineLvl w:val="0"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:keepNext/><w:rPr><w:b/><w:color w:val="2563EB"/><w:sz w:val="23"/></w:rPr><w:pPr><w:spacing w:before="170" w:after="75"/><w:outlineLvl w:val="1"/></w:pPr></w:style>
</w:styles>`;

const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr>${run('CaratOS confidential • client onboarding manual • never include secrets', { color: '64748B', size: 15 })}</w:p></w:ftr>`;

const zip = new JSZip();
zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`);
zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`);
zip.folder('word').file('document.xml', documentXml);
zip.folder('word').file('styles.xml', stylesXml);
zip.folder('word').file('footer1.xml', footerXml);
zip.folder('word').folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`);
zip.folder('docProps').file('core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>CaratOS Individual Client Account and Integration Setup Manual</dc:title><dc:creator>CaratOS Engineering</dc:creator><dc:subject>Multi-tenant client onboarding, accounts and integrations</dc:subject><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`);
zip.folder('docProps').file('app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>CaratOS</Application></Properties>`);

await mkdir(resolve(output, '..'), { recursive: true });
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await writeFile(output, bytes);

const reopened = await JSZip.loadAsync(await readFile(output));
for (const required of ['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/footer1.xml']) {
  if (!reopened.file(required)) throw new Error(`Generated document is missing ${required}`);
}
const reopenedDocument = await reopened.file('word/document.xml').async('string');
for (const marker of ['Aurum Jewels', 'Shakti Textiles', 'Northstar Fashion', 'Google Sign-In', 'SMTP', 'Connect WhatsApp', 'Go-live acceptance test']) {
  if (!reopenedDocument.includes(marker)) throw new Error(`Generated document is missing: ${marker}`);
}

console.log(`${output}\nverified: ${bytes.length} bytes; Word package and required content present`);
