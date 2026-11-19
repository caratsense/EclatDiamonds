import { LeadSource } from '@prisma/client';

import { tagSlug } from './lead-tags.service';
import {
  DEMO_AD_CUSTOMERS_TAG,
  META_LEADS_TAG,
  planProvenanceTags,
  PROVENANCE_TAGS,
  provenanceTagForSource,
  TAGGED_LEAD_SOURCES,
  WALK_IN_LEADS_TAG,
} from './provenance-tags';

/**
 * The tags the client asked for, in her own words: "whatever leads or customers
 * came through the Meta should have a tag called Meta leads. The leads which
 * came from walk-in data should be named walk-in lead. Whatever customer came
 * from the demo ad that we ran should be tagged demo ad customers."
 *
 * What is pinned here is the part a broadcast depends on. A tag found by the
 * wrong slug is created a second time, and then half the people are on one
 * copy and half on the other — so the slug agreement with `tagSlug` is
 * asserted as hard as the mapping itself.
 */

describe('the tag a lead source earns', () => {
  it('tags a Meta lead form as a Meta lead', () => {
    expect(provenanceTagForSource(LeadSource.meta_ads)).toBe(META_LEADS_TAG);
  });

  it('counts Instagram as Meta, because the client buys both as one source', () => {
    expect(provenanceTagForSource(LeadSource.instagram)).toBe(META_LEADS_TAG);
  });

  it('puts the paid form and the organic enquiry on ONE tag, not two', () => {
    // Same object, so the backfill finds one row for both and a broadcast
    // selecting "Meta Leads" reaches everybody who came through Meta.
    expect(provenanceTagForSource(LeadSource.meta_ads)).toBe(
      provenanceTagForSource(LeadSource.instagram),
    );
  });

  it('tags somebody who walked in as a walk-in lead', () => {
    expect(provenanceTagForSource(LeadSource.walk_in)).toBe(WALK_IN_LEADS_TAG);
  });

  it('leaves a WhatsApp lead untagged, as the channel is not the source', () => {
    // The worst available mistake: an ad-opened thread is stamped meta_ads, so
    // reading `whatsapp` as Meta would put every walk-in who later messaged the
    // store into the Meta audience.
    expect(provenanceTagForSource(LeadSource.whatsapp)).toBeNull();
  });

  it.each([LeadSource.website, LeadSource.phone, LeadSource.referral, LeadSource.imported])(
    'leaves %s untagged rather than guessing at a channel',
    (source) => {
      expect(provenanceTagForSource(source)).toBeNull();
    },
  );

  it('answers for every source the enum has, so a new one cannot throw', () => {
    for (const source of Object.values(LeadSource)) {
      const tag = provenanceTagForSource(source);
      if (tag) expect(PROVENANCE_TAGS).toContain(tag);
    }
  });

  it('never earns the demo-ad tag from a source: that one comes from the ad', () => {
    // Demo-ad customers are identified by the routing rule on their
    // conversation, which is evidence of the advert they actually tapped. No
    // Lead.source value is that evidence.
    const earned = Object.values(LeadSource).map((source) => provenanceTagForSource(source));
    expect(earned).not.toContain(DEMO_AD_CUSTOMERS_TAG);
  });
});

describe('the vocabulary itself', () => {
  it('is spelled the way the tag editor spells it', () => {
    // The backfill finds a tag by slug and the API creates one with
    // `tagSlug(name)`. Disagree, and the backfill tags nobody the picker lists.
    for (const tag of PROVENANCE_TAGS) {
      expect(tag.slug).toBe(tagSlug(tag.name));
    }
  });

  it('names the three tags the client asked for and no others', () => {
    expect(PROVENANCE_TAGS.map((t) => t.name)).toEqual([
      'Meta Leads',
      'Walk-in Leads',
      'Demo Ad Customers',
    ]);
  });

  it('carries a palette token, never a raw colour', () => {
    // LeadTag.colour is a token name so a tag stays legible when the theme
    // changes underneath it; a hex value here would survive the backfill and
    // then read as a broken swatch.
    for (const tag of PROVENANCE_TAGS) {
      expect(tag.colour).toMatch(/^[a-z]+$/);
    }
  });

  it('gives each tag its own slug, so none of them collide', () => {
    expect(new Set(PROVENANCE_TAGS.map((t) => t.slug)).size).toBe(PROVENANCE_TAGS.length);
  });

  it('reads exactly the sources that earn a tag, and no others', () => {
    // The backfill queries on this list. Were it wider than the rule, it would
    // read leads it then silently drops; narrower, and it would miss people.
    expect([...TAGGED_LEAD_SOURCES].sort()).toEqual(['instagram', 'meta_ads', 'walk_in']);
  });
});

describe('planning the backfill', () => {
  const plan = (leads: Parameters<typeof planProvenanceTags>[0]['leads'], demoThreads = []) =>
    planProvenanceTags({ leads, demoThreads });
  const forTag = (result: ReturnType<typeof planProvenanceTags>, slug: string) =>
    result.plans.find((p) => p.tag.slug === slug)!;

  it('tags the lead and the customer behind it, which is what the client asked for', () => {
    const result = plan([{ id: 'lead-1', partyId: 'party-1', source: LeadSource.meta_ads }]);
    const meta = forTag(result, META_LEADS_TAG.slug);
    expect(meta.leadIds).toEqual(['lead-1']);
    expect(meta.partyIds).toEqual(['party-1']);
  });

  it('counts one customer once however many leads they have', () => {
    // Three walk-ins by the same person is one PartyTagAssignment. The unique
    // on ([partyId, tagId]) would reject the second, taking its batch with it.
    const result = plan([
      { id: 'lead-1', partyId: 'party-1', source: LeadSource.walk_in },
      { id: 'lead-2', partyId: 'party-1', source: LeadSource.walk_in },
      { id: 'lead-3', partyId: 'party-1', source: LeadSource.walk_in },
    ]);
    const walkIn = forTag(result, WALK_IN_LEADS_TAG.slug);
    expect(walkIn.leadIds).toEqual(['lead-1', 'lead-2', 'lead-3']);
    expect(walkIn.partyIds).toEqual(['party-1']);
  });

  it('gives a customer both tags when both are true of them', () => {
    // She walked in, and she also came back through a Meta lead form. Both
    // facts are on the record, so both tags are.
    const result = plan([
      { id: 'lead-1', partyId: 'party-1', source: LeadSource.walk_in },
      { id: 'lead-2', partyId: 'party-1', source: LeadSource.meta_ads },
    ]);
    expect(forTag(result, WALK_IN_LEADS_TAG.slug).partyIds).toEqual(['party-1']);
    expect(forTag(result, META_LEADS_TAG.slug).partyIds).toEqual(['party-1']);
  });

  it('still tags a lead with no customer record, and says how many there were', () => {
    const result = plan([{ id: 'lead-1', partyId: null, source: LeadSource.instagram }]);
    const meta = forTag(result, META_LEADS_TAG.slug);
    expect(meta.leadIds).toEqual(['lead-1']);
    expect(meta.partyIds).toEqual([]);
    // A broadcast sends to customers, so this is a person the tag cannot reach
    // yet — reported rather than passed over in silence.
    expect(meta.leadsWithoutCustomer).toBe(1);
  });

  it('ignores a lead whose source earns nothing', () => {
    const result = plan([
      { id: 'lead-1', partyId: 'party-1', source: LeadSource.whatsapp },
      { id: 'lead-2', partyId: 'party-2', source: LeadSource.referral },
    ]);
    expect(result.plans.flatMap((p) => p.leadIds)).toEqual([]);
    expect(result.plans.flatMap((p) => p.partyIds)).toEqual([]);
  });

  it('counts the sources behind a tag, so the report can be checked in the CRM', () => {
    const result = plan([
      { id: 'lead-1', partyId: 'party-1', source: LeadSource.meta_ads },
      { id: 'lead-2', partyId: 'party-2', source: LeadSource.meta_ads },
      { id: 'lead-3', partyId: 'party-3', source: LeadSource.instagram },
    ]);
    expect(forTag(result, META_LEADS_TAG.slug).sources).toEqual({ meta_ads: 2, instagram: 1 });
  });

  it('tags the customers behind the demo-ad conversations', () => {
    const result = planProvenanceTags({
      leads: [],
      demoThreads: [{ partyId: 'party-1' }, { partyId: 'party-2' }],
    });
    expect(forTag(result, DEMO_AD_CUSTOMERS_TAG.slug).partyIds).toEqual(['party-1', 'party-2']);
  });

  it('tags a customer once when the demo advert opened two of their threads', () => {
    const result = planProvenanceTags({
      leads: [],
      demoThreads: [{ partyId: 'party-1' }, { partyId: 'party-1' }],
    });
    expect(forTag(result, DEMO_AD_CUSTOMERS_TAG.slug).partyIds).toEqual(['party-1']);
  });

  it('reports a demo thread that resolved to nobody instead of inventing a customer', () => {
    const result = planProvenanceTags({
      leads: [],
      demoThreads: [{ partyId: 'party-1' }, { partyId: null }],
    });
    expect(forTag(result, DEMO_AD_CUSTOMERS_TAG.slug).partyIds).toEqual(['party-1']);
    expect(result.demoThreadsWithoutCustomer).toBe(1);
  });

  it('puts no lead on the demo-ad tag: that tag is about customers', () => {
    const result = planProvenanceTags({
      leads: [{ id: 'lead-1', partyId: 'party-1', source: LeadSource.meta_ads }],
      demoThreads: [{ partyId: 'party-1' }],
    });
    expect(forTag(result, DEMO_AD_CUSTOMERS_TAG.slug).leadIds).toEqual([]);
  });

  it('plans every tag even when nothing earns it, so the report lists all three', () => {
    const result = plan([]);
    expect(result.plans.map((p) => p.tag)).toEqual(PROVENANCE_TAGS);
    expect(result.plans.every((p) => !p.leadIds.length && !p.partyIds.length)).toBe(true);
  });
});
