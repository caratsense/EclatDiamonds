import { LeadSource } from '@prisma/client';

/**
 * Where a lead or a customer came from, written as a tag.
 *
 * The client's words (16 Nov): "whatever leads or customers came through the
 * Meta should have a tag called Meta leads. The leads which came from walk-in
 * data should be named walk-in lead. Whatever customer came from the demo ad
 * that we ran should be tagged demo ad customers."
 *
 * The provenance was already on the rows — `Lead.source` for the first two, the
 * ad-routing rule on the conversation for the third. What none of it was is
 * reachable from the broadcast audience builder, which selects on tags and on
 * nothing else; so picking a tag there matched nobody. These three are that
 * provenance restated in the one vocabulary the picker reads.
 *
 * ONE VOCABULARY, TWO TARGETS. LeadTag is shared by leads (LeadTagAssignment)
 * and customers (PartyTagAssignment), so "Meta Leads" means the same thing on
 * an open enquiry and on the customer that enquiry became — which is what lets
 * a broadcast, which sends to customers, select on how the lead arrived.
 *
 * scripts/backfill-provenance-tags.mjs is the one caller: it does the reading,
 * the writing and the reporting, and the decisions live here where they are
 * tested without a database.
 */
export interface ProvenanceTag {
  name: string;
  /**
   * `tagSlug(name)` — the tenant-unique key the tag is found by.
   *
   * Spelled out rather than computed: `tagSlug` sits in lead-tags.service.ts
   * beside an @Injectable, and the backfill script cannot import that file
   * (Node strips types, it does not compile decorators). provenance-tags.spec.ts
   * holds the two spellings together.
   */
  slug: string;
  /** A palette token, as the tag editor offers: slate, emerald, amber, rose, sky, violet. */
  colour: string;
}

export const META_LEADS_TAG: ProvenanceTag = {
  name: 'Meta Leads',
  slug: 'meta leads',
  colour: 'sky',
};

export const WALK_IN_LEADS_TAG: ProvenanceTag = {
  name: 'Walk-in Leads',
  slug: 'walk-in leads',
  colour: 'emerald',
};

export const DEMO_AD_CUSTOMERS_TAG: ProvenanceTag = {
  name: 'Demo Ad Customers',
  slug: 'demo ad customers',
  colour: 'violet',
};

/** The vocabulary itself, in the order a fresh tenant should see it. */
export const PROVENANCE_TAGS: ProvenanceTag[] = [
  META_LEADS_TAG,
  WALK_IN_LEADS_TAG,
  DEMO_AD_CUSTOMERS_TAG,
];

/**
 * The tag a lead's recorded source earns it, or null when its source says
 * nothing about provenance worth tagging.
 *
 * Null is the common answer and is deliberate: a tag is a claim about where
 * somebody came from, and most sources do not support one. Tagging on a guess
 * is worse than leaving the tag off, because a broadcast is what reads it.
 */
export function provenanceTagForSource(source: LeadSource): ProvenanceTag | null {
  switch (source) {
    // Instagram is Meta's. The client's "came through the Meta" is one tag over
    // the paid lead forms and the organic Instagram enquiries alike — she buys
    // both through the same Ads Manager and thinks of them as one source.
    case 'meta_ads':
    case 'instagram':
      return META_LEADS_TAG;
    case 'walk_in':
      return WALK_IN_LEADS_TAG;
    // Everything else, and `whatsapp` above all, stays untagged. `whatsapp`
    // names the channel a message arrived on, not who was paid to start it: an
    // ad-opened thread is stamped `meta_ads`, so counting `whatsapp` as Meta
    // would tag every walk-in who later messaged the store as a Meta lead.
    default:
      return null;
  }
}

/**
 * The sources worth reading at all, taken from the rule above rather than
 * listed a second time — so a source added to the mapping is picked up by the
 * backfill's query without anybody remembering to widen it.
 */
export const TAGGED_LEAD_SOURCES: LeadSource[] = Object.values(LeadSource).filter((source) =>
  provenanceTagForSource(source),
);

/** A lead as the backfill reads it. */
export interface TaggableLead {
  id: string;
  /** Null until the lead has a customer record; such a lead is still tagged as a lead. */
  partyId: string | null;
  source: LeadSource;
}

/** A conversation the demo advert opened, as the backfill reads it. */
export interface DemoAdThread {
  /** Null while the sender has not resolved to a customer. */
  partyId: string | null;
}

/** Everything one tag is owed, before anything already on record is taken off. */
export interface TagPlan {
  tag: ProvenanceTag;
  /** Leads that should carry it, each once, in the order they were read. */
  leadIds: string[];
  /** Customers that should carry it, each once — two leads of one customer are one row. */
  partyIds: string[];
  /** Leads that earned it with no customer record to carry it too, counted for the report. */
  leadsWithoutCustomer: number;
  /** Which sources produced it, counted, so the report can be checked against the CRM. */
  sources: Partial<Record<LeadSource, number>>;
}

export interface ProvenancePlan {
  /** One per tag, in PROVENANCE_TAGS order, whether or not it has targets. */
  plans: TagPlan[];
  /** Demo threads whose sender never resolved to a customer, so there is nobody to tag. */
  demoThreadsWithoutCustomer: number;
}

/**
 * Work out who should carry which tag.
 *
 * Deduplicating the customers is the whole reason this is a function: one
 * customer with three walk-in leads is one PartyTagAssignment, and the unique
 * on ([partyId, tagId]) would otherwise reject the batch the second row is in
 * — taking the rest of the batch down with it.
 *
 * It decides nothing about what is already on record: the caller takes the
 * existing assignments off these lists, so "already tagged" is counted
 * separately from "nothing to do".
 */
export function planProvenanceTags(input: {
  leads: TaggableLead[];
  demoThreads: DemoAdThread[];
}): ProvenancePlan {
  const leadIds = new Map<string, Set<string>>();
  const partyIds = new Map<string, Set<string>>();
  const withoutCustomer = new Map<string, number>();
  const sources = new Map<string, Partial<Record<LeadSource, number>>>();
  for (const tag of PROVENANCE_TAGS) {
    leadIds.set(tag.slug, new Set());
    partyIds.set(tag.slug, new Set());
    withoutCustomer.set(tag.slug, 0);
    sources.set(tag.slug, {});
  }

  for (const lead of input.leads) {
    const tag = provenanceTagForSource(lead.source);
    if (!tag) continue;
    leadIds.get(tag.slug)!.add(lead.id);
    const counted = sources.get(tag.slug)!;
    counted[lead.source] = (counted[lead.source] ?? 0) + 1;
    if (lead.partyId) partyIds.get(tag.slug)!.add(lead.partyId);
    else withoutCustomer.set(tag.slug, withoutCustomer.get(tag.slug)! + 1);
  }

  // The demo advert tags customers only. A demo-ad lead is already a Meta lead
  // by its source, and this tag answers a different question: which customers
  // saw THAT advert. There is no lead-side list for it.
  let demoThreadsWithoutCustomer = 0;
  for (const thread of input.demoThreads) {
    if (thread.partyId) partyIds.get(DEMO_AD_CUSTOMERS_TAG.slug)!.add(thread.partyId);
    else demoThreadsWithoutCustomer += 1;
  }

  return {
    plans: PROVENANCE_TAGS.map((tag) => ({
      tag,
      leadIds: [...leadIds.get(tag.slug)!],
      partyIds: [...partyIds.get(tag.slug)!],
      leadsWithoutCustomer: withoutCustomer.get(tag.slug)!,
      sources: sources.get(tag.slug)!,
    })),
    demoThreadsWithoutCustomer,
  };
}
