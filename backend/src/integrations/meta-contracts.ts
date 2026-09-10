/**
 * Provider-neutral hand-off objects produced by the Meta adapters.
 *
 * They deliberately contain no access token and no raw webhook envelope. The
 * integration boundary keeps provider bytes for diagnosis, then hands the CRM
 * only the fields it can act on. Keeping the sink as a registered callback
 * avoids an Integrations -> CRM -> Integrations module cycle.
 */

export interface MetaLeadField {
  name: string;
  values: string[];
}

export interface MetaLeadRecord {
  organisationId: string;
  integrationId: string;
  leadgenId: string;
  pageId: string;
  formId: string | null;
  createdAt: Date | null;
  adId: string | null;
  adSetId: string | null;
  campaignId: string | null;
  adName: string | null;
  adSetName: string | null;
  campaignName: string | null;
  /** Common fields are conveniences; `fields` remains the lossless source. */
  fullName: string | null;
  phone: string | null;
  email: string | null;
  fields: MetaLeadField[];
}

export interface MetaLeadSinkResult {
  accepted: boolean;
  duplicate?: boolean;
  leadId?: string | null;
  conversationId?: string | null;
  reason?: string;
}

export interface MetaLeadSink {
  acceptMetaLead(lead: MetaLeadRecord): Promise<MetaLeadSinkResult>;
}

export interface MetaDeliveryReceipt {
  provider: 'whatsapp_cloud';
  externalMessageId: string;
  recipientId: string | null;
  status: 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';
  occurredAt: Date | null;
  conversationId: string | null;
  pricingCategory: string | null;
  providerErrorCodes: string[];
}

/**
 * Which tenant a receipt belongs to, resolved from an asset WE own.
 *
 * Deliberately a second argument rather than a field on the receipt: the
 * receipt is parsed from the provider's payload, and the tenant must never come
 * from there. Keeping them apart in the type makes it impossible to satisfy
 * this interface by reading an organisation id out of Meta's JSON.
 */
export interface MetaReceiptOwner {
  organisationId: string;
  integrationId: string | null;
}

export interface MetaDeliveryReceiptSink {
  acceptMetaDeliveryReceipt(receipt: MetaDeliveryReceipt, owner: MetaReceiptOwner): Promise<void>;
}

