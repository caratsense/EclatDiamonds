/**
 * Provider registry (CaratOS Phase A5).
 *
 * The catalogue of things a tenant can connect. Code, not a table: a provider is
 * defined by an adapter that ships in a release, so a row describing one that has
 * no adapter would be a promise the software cannot keep.
 *
 * TWO RULES, both about honesty:
 *
 *   1. `credentialScope` states the truth about where a provider's secrets live
 *      TODAY. Several existing integrations read process-wide environment
 *      variables, which means they belong to the deployment and not to a tenant —
 *      so a second tenant would silently transmit through the first tenant's
 *      account. That is recorded here as 'platform_env' rather than glossed over,
 *      and it is the concrete migration list for making this multi-tenant.
 *
 *   2. A provider with no working adapter is `available: false` with a stated
 *      `blockedReason`. It is never listed as connectable. Inventing a Tally or
 *      BUSY field mapping to make a screen look complete would produce an
 *      integration that silently imports wrong data, which is far worse than an
 *      integration that openly does not exist yet. ERP starters therefore expose
 *      only entities backed by an explicit profile and require preview before sync.
 */

import { METAL_RATES_CAPABILITY } from '../../config/entitlements';

export type CredentialScope =
  /** Secrets are per-tenant, in IntegrationCredential. The target for everything. */
  | 'tenant'
  /**
   * Secrets are process-wide environment variables today. Works for the single
   * existing tenant; MUST move to 'tenant' before a second tenant uses it.
   */
  | 'platform_env'
  /** No secret needed (a file upload, a public feed). */
  | 'none'
  /** Secrets live on the customer's own machine, in the CaratOS Connect agent. */
  | 'on_premise';

export interface ProviderDefinition {
  code: string;
  name: string;
  /** 'messaging' | 'erp' | 'file' | 'payments' | 'market_data' | 'ads' */
  category: string;
  description: string;
  /** False when nothing in this repository can actually talk to it. */
  available: boolean;
  /** Why it is unavailable. Required when `available` is false. */
  blockedReason?: string;
  credentialScope: CredentialScope;
  /** Credential kinds this provider expects, when tenant-scoped. */
  credentialKinds?: string[];
  /** Entities it can move, for the connector contract. */
  entities?: string[];
  /** True when it receives webhooks and therefore needs signature verification. */
  webhooks?: boolean;
  /**
   * The tenant capability this provider only makes sense alongside.
   *
   * Almost every provider is universal — a clinic, a mill and a jeweller all
   * message customers, take payments and import spreadsheets — so this is
   * normally absent. It exists for the handful that are meaningless without a
   * specific module: a clinic offered a "Gold rate feed" can connect something
   * that will never do anything for them, and a catalogue that lists it is
   * quietly wrong about what the product is.
   *
   * It filters the LISTING only. It is not an authorisation check: the
   * entitlement guard already refuses the routes behind the module, and this
   * would be a poor second gate.
   */
  requiresCapability?: string;
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    code: 'csv',
    name: 'Spreadsheet upload (CSV / XLSX)',
    category: 'file',
    description:
      'Import customers, products and stores from a file. The universal onboarding path — ' +
      'it needs nothing from the customer except their existing spreadsheet.',
    available: true,
    credentialScope: 'none',
    entities: ['customers', 'products', 'stores'],
  },
  {
    code: 'gati',
    name: 'Gati / APRS-SJEP (on-premise SQL Server)',
    category: 'erp',
    description:
      'Reads the customer\'s existing jewellery ERP through the CaratOS Connect agent ' +
      'running on their own network. Outbound-only: CaratOS never connects inward.',
    available: true,
    // The agent holds the SQL Server connection string on the customer's machine
    // and authenticates to CaratOS with its own service credential.
    credentialScope: 'on_premise',
    // Keep this platform catalogue aligned with ConnectorRegistry. The deep
    // Gati adapter exposes ledger rows, not a generic payment-receipt feed.
    entities: [
      'customers',
      'products',
      'stock',
      'sales',
      'ledger',
      'staff',
      'manufacturing',
      'images',
      'orders',
    ],
  },
  {
    code: 'whatsapp_cloud',
    name: 'WhatsApp Business Cloud API',
    category: 'messaging',
    description:
      'Send and receive WhatsApp messages. Implemented against the Cloud API and ' +
      'signature-verifies inbound webhooks. Each tenant stores its own outbound access token; ' +
      'the shared Meta app secret and webhook verify token remain deployment configuration.',
    available: true,
    // Outbound tenant tokens are consumed from IntegrationCredential by
    // WhatsAppCredentialsService. Meta app-level webhook verification remains
    // process configuration and is not falsely offered as a tenant secret.
    credentialScope: 'tenant',
    credentialKinds: ['access_token'],
    webhooks: true,
  },
  {
    code: 'razorpay',
    name: 'Razorpay',
    category: 'payments',
    description: 'Payment links and collection for scheme installments.',
    available: true,
    credentialScope: 'platform_env',
    credentialKinds: ['api_key', 'api_secret', 'webhook_secret'],
    webhooks: true,
  },
  {
    code: 'gold_rate_feed',
    name: 'Gold rate feed',
    category: 'market_data',
    description: 'Automatic daily metal rate. Keyless public source.',
    available: true,
    credentialScope: 'none',
    // Meaningless without the metal-rate module, which only a pack that
    // maintains rates includes. Named here rather than special-cased in the
    // catalogue, so the next vertical provider declares the same thing.
    requiresCapability: METAL_RATES_CAPABILITY,
  },
  {
    code: 'tally',
    name: 'TallyPrime',
    category: 'erp',
    description:
      'Outbound TallyPrime XML agent with preview-first customer and stock-item master profiles. Live company verification remains part of client onboarding.',
    available: true,
    credentialScope: 'on_premise',
    entities: ['customers', 'products'],
  },
  {
    code: 'busy',
    name: 'BUSY Accounting',
    category: 'erp',
    description:
      'Outbound Windows Connect agent with BUSY customer and item-master starter profiles. ' +
      'Stock and vouchers stay disabled until the client installation is mapped.',
    available: true,
    credentialScope: 'on_premise',
    entities: ['customers', 'products'],
  },
  {
    code: 'odbc',
    name: 'Generic database (ODBC)',
    category: 'erp',
    description:
      'Profile-driven outbound reader for SQL Server, Access, MySQL, PostgreSQL and other ODBC databases. No source is written to.',
    available: true,
    credentialScope: 'on_premise',
    entities: ['customers', 'products', 'stores'],
  },
  {
    code: 'instagram',
    name: 'Instagram Direct',
    category: 'messaging',
    description: 'Receive and reply to Instagram messages as a CRM channel.',
    available: false,
    blockedReason:
      'Requires a reviewed Meta app with messaging permissions and an Instagram ' +
      'professional account linked to a Facebook Page. None of that is provisioned, ' +
      'and no code here calls Instagram. The Conversation model already supports the ' +
      "channel, so this needs an adapter and app review — not a redesign.",
    credentialScope: 'tenant',
    credentialKinds: ['access_token'],
    webhooks: true,
  },
  {
    code: 'meta_ads',
    name: 'Meta Ads',
    category: 'ads',
    description:
      'Lead Ads submissions, ad-account spend and campaign metadata. Inbound Lead Ads ' +
      'webhooks are signature-verified and become CRM leads; registered Pages, forms and ' +
      'ad accounts are ownership-verified against the tenant’s own token before this ' +
      'connection reports itself connected. The tenant brings a long-lived access token ' +
      'from their own reviewed Meta app, with leads_retrieval and ads_read.',
    available: true,
    // Every part of this ships here: MetaWebhookService verifies the payload,
    // MetaLeadAdapter files the lead, MetaAdsInsightsService pulls measured spend
    // and MetaHealthService proves the stored token can read what was registered.
    // What a tenant still has to bring is a reviewed app and its own token — that
    // is provisioning, and it belongs in the description a customer reads, not in
    // a blockedReason that hides a working adapter behind an unconnectable row.
    credentialScope: 'tenant',
    credentialKinds: ['access_token'],
    entities: ['leads', 'ad_insights'],
    webhooks: true,
  },

  /*
   * The remaining channels.
   *
   * Every one below is `available: false` with a blockedReason naming exactly
   * what is missing. That is deliberate and is the whole point of this registry:
   * an entry marked available whose adapter has never spoken to the provider
   * makes an admin screen report "connected" because environment variables
   * exist, which is the specific lie this state machine was built to prevent.
   *
   * Their contracts and fixture adapters DO ship — a campaign can be authored
   * against them and the tests drive them — but a tenant cannot connect one, and
   * the campaign service refuses to create a campaign on a channel that cannot
   * deliver rather than scheduling silence.
   */
  {
    code: 'facebook_messenger',
    name: 'Facebook Messenger',
    category: 'messaging',
    description: 'Receive and reply to Page messages as a CRM channel.',
    available: false,
    blockedReason:
      'Needs a reviewed Meta app with pages_messaging and a Page access token. ' +
      'The Conversation model already carries the channel and the inbound webhook ' +
      'shape is shared with WhatsApp, so this needs an adapter and app review, ' +
      'not a redesign.',
    credentialScope: 'tenant',
    credentialKinds: ['access_token'],
    webhooks: true,
  },
  {
    code: 'email',
    name: 'Email',
    category: 'messaging',
    description: 'Send campaign and transactional email, and receive replies as conversations.',
    available: false,
    blockedReason:
      'No sending domain is verified and no ESP account exists. Sending from an ' +
      'unverified domain is delivered to spam at best, so this stays unavailable ' +
      'until a tenant completes SPF, DKIM and DMARC.',
    credentialScope: 'tenant',
    credentialKinds: ['api_key'],
    webhooks: true,
  },
  {
    code: 'sms',
    name: 'SMS',
    category: 'messaging',
    description: 'Transactional and campaign SMS.',
    available: false,
    blockedReason:
      'In India this needs a DLT-registered sender id and pre-approved templates ' +
      'with the operator, plus an aggregator account. None of that is registered, ' +
      'and sending without it is rejected by the operator rather than merely ' +
      'undelivered.',
    credentialScope: 'tenant',
    credentialKinds: ['api_key', 'sender_id'],
    webhooks: true,
  },
  {
    code: 'rcs',
    name: 'RCS Business Messaging',
    category: 'messaging',
    description: 'Rich cards and carousels on Android, with SMS fallback.',
    available: false,
    blockedReason:
      'Needs a verified RCS agent approved by Google and the carrier, which is a ' +
      'brand-verification process measured in weeks. No agent has been submitted.',
    credentialScope: 'tenant',
    credentialKinds: ['service_account'],
    webhooks: true,
  },
  {
    /*
     * INBOUND ONLY, and available because the inbound half is real.
     *
     * `available` gates `IntegrationsRegistryService.create`, so a provider
     * marked false cannot be connected at all — and a webhook nobody can
     * connect is a webhook that returns 404 to everyone. This flipped to true
     * when the inbound door was built and tested end to end against the
     * application's own container: a tenant connects this, issues a webhook
     * token, points their provider at it, and a missed call becomes a customer,
     * an enquiry, a call log and a follow-up task due today.
     *
     * The description says what is NOT here, because "Telephony" as a word
     * promises more than this delivers. There is no outbound dialling, no
     * click-to-call, and no adapter for any particular vendor — the payload is
     * normalised and the tenant's provider has to be mapped onto it. Nothing in
     * this system has yet spoken to a real telephony network.
     */
    code: 'telephony',
    name: 'Telephony / IVR (inbound)',
    category: 'messaging',
    description:
      'Inbound calls become CRM records: the caller is matched to a customer, an ' +
      'enquiry is opened against the branch that owns the dialled number, the call ' +
      'is logged with its disposition and a link to the provider\u2019s recording, and a ' +
      'follow-up task falls due the same day. A call to an unmapped number is logged ' +
      'and reported as unrouted rather than filed against a guessed branch. ' +
      'OUTBOUND IS NOT BUILT: no dialling and no click-to-call. No vendor-specific ' +
      'adapter exists either \u2014 point your provider at the webhook and map its ' +
      'payload onto the normalised one. A manual call log still needs no provider ' +
      'at all, and is labelled as manual so it is never confused with a call the ' +
      'network confirmed.',
    available: true,
    credentialScope: 'tenant',
    credentialKinds: ['api_key', 'api_secret'],
    webhooks: true,
  },
  {
    /*
     * AVAILABLE, and the reason is the direction of the call.
     *
     * Every other entry in this registry describes software we have to talk TO,
     * and is unavailable when nobody has provisioned an account at the far end.
     * This one is the opposite: the tenant's website calls US. The whole of it —
     * the key, the ledger, the idempotency guarantee, the signed announcement —
     * ships here, so there is no far end to provision and nothing to wait for.
     * What the tenant brings is a website and an earn rate.
     *
     * The signed OUTBOUND announcement is the one part that depends on somebody
     * else being reachable, and it reports its own state per movement rather
     * than letting this row claim delivery.
     */
    code: 'loyalty_website',
    name: 'Loyalty website API',
    category: 'loyalty',
    description:
      'Lets your own website read a customer’s points balance and statement, enrol ' +
      'new members, award points on a purchase, redeem them at checkout and reverse a ' +
      'cancelled sale. The website authenticates with its own key — never a staff ' +
      'login — and every movement is replay-safe, so a retry over a flaky network ' +
      'cannot debit a customer twice. Points movements made at the counter are ' +
      'announced back to your site, signed, so the balance it shows does not go stale. ' +
      'CaratOS computes what a purchase earns from the rate you set: the website ' +
      'reports the spend, not the points.',
    available: true,
    credentialScope: 'tenant',
    credentialKinds: ['api_key', 'shared_secret'],
    entities: ['loyalty_members', 'loyalty_ledger'],
    // Inbound requests are key-authenticated rather than signature-verified; the
    // signing in this integration is on what we SEND.
    webhooks: false,
  },
  {
    code: 'google_business',
    name: 'Google Business Profile',
    category: 'reviews',
    description:
      'Send review invitations to a location’s Google review link, and read back ' +
      'the reviews that arrive.',
    available: false,
    blockedReason:
      'Reading reviews needs the Google Business Profile API, which requires an ' +
      'approved quota request against a verified business. The INVITATION half ' +
      'needs none of that: a tenant can paste its own review link today and ' +
      'CaratOS will send customers to it. Only the read-back is blocked.',
    credentialScope: 'tenant',
    credentialKinds: ['oauth_refresh_token'],
    webhooks: false,
  },
];

const BY_CODE = new Map(PROVIDERS.map((p) => [p.code, p]));

export function getProvider(code: string): ProviderDefinition | undefined {
  return BY_CODE.get(code);
}

export function listProviders(): ProviderDefinition[] {
  return PROVIDERS;
}

/**
 * Providers whose secrets are still process-wide. This is the multi-tenancy
 * blocker list, exposed through the API so it is visible in the product rather
 * than buried in a document nobody re-reads.
 */
export function platformScopedProviders(): ProviderDefinition[] {
  return PROVIDERS.filter((p) => p.available && p.credentialScope === 'platform_env');
}
