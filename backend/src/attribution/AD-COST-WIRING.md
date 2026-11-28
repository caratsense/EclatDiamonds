# Wiring the cost-per-enquiry layer

Written 28 Nov, for whoever lands the adverts-ranking screen. The module, the
controller and the frontend were being edited by other people while this was
built, so nothing below is wired in — these are the four steps.

## What exists

| File | What it is |
|---|---|
| `ad-cost-per-enquiry.ts` | **Pure.** `joinAdCostPerEnquiry(spend, enquiries)` → the joined view. No Prisma, no HTTP. |
| `ad-cost-per-enquiry.spec.ts` | Every rule in that file, including the 3-leads-vs-167-enquiries one. |
| `meta-ad-spend.service.ts` | `MetaAdSpendService.spendForWindow(orgId, { integrationId, adAccountAssetId, dateFrom, dateTo })` → `AdSpendSnapshot`. One account-level Graph call at `level=ad`, through the existing `MetaGraphClient`. 15-minute cache. |
| `meta-ad-spend.service.spec.ts` | The fetch path against a stubbed Graph client. |

## 1. Register the provider

`attribution.module.ts`: add `MetaAdSpendService` to `providers`. It needs no
`imports` — `PrismaService` and `MetaGraphClient` both come from already-global
modules, the same way `AdEnquiryCountsService` gets its dependencies.

## 2. The endpoint

Recommended shape, beside its neighbours on the same controller:

```ts
@Roles('store_manager')          // store_manager and above, like /performance
@Get('enquiry-cost')
cost(
  @CurrentUser() user: AuthUser,
  @Query() query: AdEnquiryCostDto,   // integrationId, adAccountAssetId, dateFrom, dateTo, storeId?
  @StoreHeader() store?: string,
) { ... }
```

The money is account-wide and cannot be split by branch, but the ENQUIRY half
must stay store-scoped exactly as `/enquiries` is — so pass the branch through
and let `AdEnquiryCountsService` apply `StoreScopeService.effectiveStoreIds`.
Say on the screen that spend is account-wide while the counts are the chosen
branch's; otherwise a single branch's cost per enquiry reads low by a factor of
eleven.

`integrationId` and `adAccountAssetId` are required for the same reason
`/performance` requires them: there is no honest default ad account.

## 3. Building the two snapshots

```ts
const spend = await this.adSpend.spendForWindow(user.organisationId, query);
const enquiries = {
  from: spend.from,              // NOT a rolling window — see below
  to: spend.to,
  adverts: /* one row per advert: adId, campaignId, campaignName, enquiries, replied */,
};
return joinAdCostPerEnquiry(spend, enquiries);
```

**The enquiry half must be counted over `spend.from`..`spend.to`**, which are
the UTC instants the ad account's local days span. `AdEnquiryCountsService`
currently counts a ROLLING window (`now − days`), which is a different period;
feeding it in unchanged makes `window.sameWindow` false and every cost null by
design. Either add a date-bounded variant of that tally, or do the one
`Conversation` group-by here over those bounds. Do not fake the match.

## 4. Payload

`AdCostReport`: `window` (`dateFrom`, `dateTo`, `timezone`, `spendFrom`,
`spendTo`, `enquiryFrom`, `enquiryTo`, `spendBasis`, `enquiryBasis`,
`sameWindow`), `currency`, `spendAvailable`, `spendUnavailableReason`,
`totals`, `campaigns[]`, `note`.

Every campaign and every advert carries `meta` (`spend`, `impressions`,
`leads`, `linkClicks`, `status`), `ours` (`enquiries`, `replied`),
`costPerEnquiry` + `costPerEnquiryStatus`, `costPerReply` +
`costPerReplyStatus`. Money is a decimal STRING to two places; a cost is
`null` whenever its status is not `measured`. Statuses the screen must have
copy for: `window_mismatch`, `spend_unknown`, `incomplete_spend`, `no_spend`
("this advert did not spend in this window"), `no_enquiries` ("no enquiries
yet"), `no_replies`. Campaign `meta.status: 'partial'` means the shown spend is
real but short of at least one advert — label it, never total it as the
campaign's spend.

**`meta.leads` and `ours.enquiries` must appear as two separate labelled
figures.** Meta reported 3 leads for "blue diamond 24/11"; we hold 167
enquiries from it. Do not add them, pick one, or show a ratio between them.

## Two decisions worth a second opinion

1. **The window.** One account-local calendar window read on two clocks: Meta's
   spend by its delivery day, ours by `Conversation.createdAt`. Nothing is
   shifted to close the lag between a tap and a message, and a mismatch between
   the two halves nulls every cost rather than dividing two periods into each
   other. The alternative — lagging the enquiry window by a day or two — invents
   an attribution model nobody specified and makes the count impossible to
   reconcile with the inbox.

2. **`accountTarget` is duplicated.** `MetaAdsInsightsService.accountTarget` is
   private in a file this change could not touch, so the asset lookup is
   repeated in `MetaAdSpendService`. Lifting it into
   `meta-ads-insights.util.ts` and having both call it is the obvious follow-up;
   until then the two copies must stay identical, because they are the only
   thing enforcing that an ad account belongs to the tenant asking about it.
