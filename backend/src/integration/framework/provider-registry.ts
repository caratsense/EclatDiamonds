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
