# Module 5 — Lossless website + Gati catalogue, and visual search (build spec, 2026-09-18)

Schema is DONE (migration `20260918150000_lossless_catalogue_sources`):
`ExternalProductSnapshot`, `ProductWebsiteListing`, `ProductVariant`,
`ProductOption`, `ProductPrice`, `ProductImageAssociation`, `CatalogueSyncRun`,
`CatalogueConflict`; new columns on `Product` (hsn, gatiSyncedAt,
websiteSyncedAt), `ProductImage` (source, pinnedPrimary, sourceUrl,
sourceImageId, sourceOrder, contentHash, thumbUrl, width, height, status,
tombstonedAt, embedding*), `StockItem` (sizeLabel, itemSizeId, hsn,
productCode, quantity, stonePieces, variantId). Read the model comments.

Hard rules: additive only; never deploy; never call the live website from
tests; never write credentials/OTPs/tokens/cookies anywhere; never log full
payloads; no work outside catalogue/sync/search/inference; preserve concurrent
edits (other agents are editing neighbouring files — touch only what you own).

## Source ownership

| Website owns (writes only these) | Gati owns (writes only these) |
|---|---|
| `ProductWebsiteListing` (marketing name, categories[], subCategories[], features[], tags[], countries[], active/deleted, slug, SEO, description, specifications, sizeGuide) | `Product`: sku, name (Gati item name), styleNumber, legacyId, hsn, category/metal/karat/weights from Gati, `price` (Gati tag/MRP basis), composition (source gati), gatiSyncedAt |
| `ProductVariant` (source website), `ProductOption` kind size, `ProductPrice` kinds indicative/min_variant/natural_diamond/variant/variant_with_margin | `StockItem` (all), `ProductPrice` kind gati_tag |
| `ProductImage` source website + `ProductImageAssociation` | `ProductImage` source gati_cad |
| `Product.websiteCode`, `Product.websiteSyncedAt`; `Product.composition` only when Gati has none | |

A website-only design (no Gati match) gets a Product row created by the website
sync (legacyId `WEB-<code>` as today) so it is browsable; its Product.name is the
marketing name. When Gati later matches it, Gati's writes do not touch the
listing, and the display name remains the listing's marketingName.

Display rules: name = listing.marketingName ?? product.name; filters on karat/
metal use structured variant values; specification text shown verbatim with
provenance; conflicts shown as warnings.

Metal/karat mapping (both syncs, one helper `karatToMetal` in
`backend/src/catalogue/metal.ts`): 9→gold_9k, 10→gold_10k, 14→gold_14k,
18→gold_18k, 22→gold_22k, 24→gold_24k; "rose" colour does NOT change the enum
(colour lives on variant/association); platinum/silver by name; unknown →
gold_unspecified, never guessed as 18k.

Website↔Gati join: normalise both (`upper`, strip spaces, `-`, `_`, `/`, `.`),
match website productCode against Gati `styleNumber`, then `sku`, then
`name`(StyleCode). Exactly one Product → join (set Product.websiteCode, attach
listing/variants/prices/images to it). Zero → website-only product + conflict
`gati_match_none` (info). More than one → website-only product NOT created
twice; conflict `gati_match_ambiguous` with candidates; nothing guessed.

## Image precedence (one function, `backend/src/catalogue/image-order.ts`)

Default order for a product's ACTIVE images:
1. an image with `pinnedPrimary` (admin choice) — only one;
2. `gati_cad` images (source order);
3. `website` images in source order (colour group order, then position);
4. `manual`, then `inventory`, then `other` (createdAt).
A `gati_cad` whose last download/decode failed (`embeddingStatus` dead with a
fetch error, or status tombstoned) falls back: first valid website image
becomes primary. `isPrimary`/`sortOrder` and `Product.imageUrl` are RECOMPUTED
from this function after every sync/upload/pin/tombstone. Manual uploads are
never deleted or overwritten by a sync. Dedup: same `contentHash` within a
product = one ProductImage, extra associations added.

Search: every active indexed image (all sources) is a candidate; retrieve per
image, group per product, keep the best image. Result item adds
`matchedImageId, matchedImageUrl, matchedImageSource, matchedColour,
matchedAngle, heroImageUrl` (hero = precedence #1). The detail opens with the
matched image selected; the hero stays marked "Primary".

## Contracts

### Catalogue sync (integrations agent — `backend/src/catalogue/website/*`, `catalogue-sync.controller.ts`)
- Endpoint contract (2026-09-19): `WebsiteCatalogueClient.productsEndpoint()`
  is the one rule for saving, probing and paging. It accepts the API base
  (`…/v1/api`) or the exact endpoint (`…/v1/api/products`) and returns the exact
  endpoint — `/products` appended once, never `/products/products`; a reviewed
  query (e.g. `country=IN`) kept; `page`/`limit` dropped for the pager to set.
  https only, no credentials, no fragment, allow-listed host, redirects refused.
  Stored as `Integration.config.productsEndpoint`; rows saved earlier as
  `config.baseUrl` are read through the same rule and never written again.
- Connection truth: saving an address runs a read-only probe (page 1, limit 1,
  same client as a sync) and saves nothing unless it passes — a product list, a
  sane total when given, a usable `productCode`. Pass: `status=connected`,
  `lastHealthAt`, `config.lastProbe`. A failed new address keeps a working one
  and is recorded in `config.lastProbe`; a failed re-test (`POST
  /catalogue-integration/website/test`) sets `status=error` + `lastError`.
  Health reports `configured` (an address exists) separately from `verified`
  (last probe passed, `lastHealthAt` set — rows saved before probes existed are
  not verified) and a `connectionState`: not_configured / connected /
  sync_running / needs_attention / failed. Syncs, manual or scheduled, need a
  verified connection. 502 = the website could not be reached; 400 = its answer
  was wrong.
- `WebsiteCatalogueClient`: GET `{productsEndpoint}?page&limit`, endpoint from the
  stored integration config, host must equal the allow-listed
  `apis.eclatdiamonds.in` (config `WEBSITE_CATALOGUE_ALLOWED_HOSTS`), bearer =
  encrypted `IntegrationCredential` kind `service_token` (reuse
  `framework/credential-crypto.ts`) — optional: the Eclat product feed
  (`https://apis.eclatdiamonds.in/v1/api/products`) is public, so a connection
  is just the saved address and no Authorization header is sent without a
  token (verified 2026-09-18: 331 products, 993 variants, 3,196 image
  placements); timeouts, retry with backoff, page size 100,
  loop until `received >= total` and page > totalPages; a short/missing page
  fails the run as `partial` (never tombstones on a partial run).
- `normalizeWebsiteProduct(payload)` PURE → `{ listing, variants[], sizes[],
  prices[], images[] (url, colour, shape, order, variantKey?), bom per variant,
  conflicts[] }`. Keeps everything; spec/BOM mismatches (e.g. spec says 8.07 g
  for 18KT, BOM says 8.70; BOM diamond unit "gram" but spec "ct") become
  conflicts `spec_mismatch` / `unit_mismatch`; values are NOT corrected.
- Persist: snapshot upsert (hash no-op), join, listing/variants/options/prices/
  images/associations upsert; images of the product that the source no longer
  publishes → tombstoned (only on a complete run); product missing from a
  complete run → listing tombstoned + snapshot goneAt; `isDeleted`/inactive →
  listing flags. New/changed images → `CatalogueIndexService.enqueue(imageIds)`.
- `CatalogueSyncRun` receipt for every run; `dryRun` computes the same receipt
  and a preview (`detail.preview`: per product create/update/unchanged + diffs)
  inside a rolled-back transaction or without writes; resume continues at
  `nextPage` of a `partial` run (heartbeat + stale-run takeover).
- Scheduled: a JobTask kind `catalogue.website_sync` enqueued by the scheduler
  weekly (Sunday 03:00 IST) per org that has the integration configured, so
  designs added to the website arrive without anyone starting a sync.
- Routes (head_office): `GET /catalogue-integration/health`, `POST
  /catalogue-integration/website/credential {baseUrl, token?}` (probes first;
  returns `{configured, verified, host, productsEndpoint, sourceTotal,
  checkedAt}` — never the token), `POST /catalogue-integration/website/test`
  (re-probe; no sync, no catalogue write), `POST
  /catalogue-integration/website/sync {mode:'full'|'resume', dryRun}`, `GET
  /catalogue-integration/runs`, `GET /catalogue-integration/conflicts?status`,
  `PATCH /catalogue-integration/conflicts/:id {status, resolution}` (for
  `gati_match_ambiguous`: `{productId}` to link).
- The shop-PC path stays: `POST /sync/website/raw` (machine auth like the
  existing website sync route) accepts `{ products: <raw website payloads> }`
  pages and runs the SAME normalise/persist; `synceclatcaratsense/import_website.py`
  paginates the whole catalogue and sends raw products (no reduction, no image
  cap, no price choice) in batches. Keep the old endpoint working.
- Health: website connection (credential configured? last run status, last
  success, source total vs listings active), Gati (last Gati product/stock sync
  times from existing sync state), products/variants/images counts,
  conflicts open by kind, missing CAD count, embedding counts by status and
  current model/pipeline versions.

### Gati reconciliation (Gati agent — `backend/src/sync/sync.service.ts` Gati methods + `synceclatcaratsense/sync_sjep.py`)
- Map into StockItem: styleNumber (StyleCode), sizeLabel/itemSizeId (SizeNo/
  ItemSizeId), hsn, huid, hallmarkNo/certificateNo actual values, productCode,
  quantity, gross/net/pure, diamond/stone weight + pieces, component amounts,
  tag/store. Product.hsn, Product.gatiSyncedAt; ProductPrice gati_tag (range
  per product from its StockItems: store min & max as two rows `gati_tag_min`/
  `gati_tag_max` kinds are allowed).
- Gati CAD images: whatever the Gati sync writes as the design picture becomes a
  ProductImage `source gati_cad` (upsert by sourceUrl), then image-order recompute
  and `CatalogueIndexService.enqueue`.
- StockItem.variantId: set only when exactly one website variant of the product
  has the same karat (and colour when Gati has it); else null.
- Use `karatToMetal`. Don't touch the website method(s).

### Index + search (search agent — `backend/src/catalogue/catalogue-index.service.ts`, `image-order.ts`, `jewelry-similarity.service.ts`, `ml-inference.service.ts`, `ai-image-search.service.ts`, `jewelry-ranking.service.ts`)
- `CatalogueIndexService.enqueue(imageIds)` → one JobTask per (image,
  contentHash-or-url, pipelineVersion) kind `catalogue.embed_image`
  (idempotencyKey), status on ProductImage. Worker: download (allowed hosts,
  size cap, MIME check), sha256 → contentHash (dedup within product), thumbnail
  (≤400px webp/jpeg stored via StorageService → thumbUrl), `embedBatch`, write
  ProductEmbedding (+ view rows), `indexed`; retries with backoff; `dead` after
  maxAttempts with reason. Restart-safe (JobTask leases). Tombstoned image →
  delete its embedding rows. Model/pipeline version change → re-enqueue.
- Grid thumbnails do not wait for indexing: a `catalogue.thumb_image` job
  (priority -1: behind messages and imports at 0, ahead of indexing at -2) resizes each picture with `sharp` to a
  400 px WebP → `thumbUrl`; queued by `enqueue` and by the 10-minute sweep even
  with no inference service. Website originals are 3000 px PNGs (~10 s each on
  shop wifi). The website's image host
  (`eclat-assets.s3.ap-south-1.amazonaws.com`) is always download-allowed.
- Uploaded photos are judged by their bytes: JPEG/PNG/WebP/GIF stored as is,
  anything else `sharp` reads converted to JPEG, and an unreadable one (HEIC
  outside Safari) refused with how to fix it. The gallery shrinks photos in the
  browser to ≤1600 px JPEG first (CAD sheets excepted).
- Remove fire-and-forget + in-memory progress as source of truth: rebuild =
  enqueue all active images; status = counts from ProductImage.embeddingStatus.
  Remove any 5,000 ceiling. Keep existing endpoints' shapes working
  (`POST /products/embeddings/reindex`, `GET` status) so the current UI works.
- Search: preflight — if the org has zero indexed embeddings, return 200
  `{status:'CATALOGUE_INDEX_BUILD_REQUIRED', coverage:{indexed,total,queued,failed}}`
  WITHOUT calling inference. Otherwise one `embedBatch` for all 1–3 query images;
  bounded concurrency (env `SEARCH_MAX_CONCURRENT`, default 2) → 429 +
  Retry-After when full; LRU (env size 64, TTL 10 min) keyed by sha256 of the
  normalised query bytes → vectors; Server-Timing header with upload/decode/
  detect/dino/siglip/retrieve/rank/hydrate; p50/p95 recorded in the existing
  metrics (fix the batch latency metric); one deadline (env
  `SEARCH_DEADLINE_MS`, default 45000) — no 30s+180s retry chains.
  Candidates only from active images; grouped per product; response items add
  the matched-image fields above. Query photos are not persisted.
- pgvector: add the 768/768 ANN path behind `SEARCH_PGVECTOR=1` ONLY if the
  extension exists (detect at boot); otherwise the in-memory exact ranker. Do NOT
  apply the 1024/1152 drafts. Provide `scripts/similarity-bench.mjs` measuring
  p50/p95 and recall@10 of ANN vs exact on local data.
- Fix model labels: DINOv2 (not v3) wherever the API/UI says v3.

### Product API (catalogue API agent — `backend/src/products/products.service.ts`, `products.controller.ts`, dto)
- List (`GET /products`) stays light; each item adds `displayName, heroImageUrl,
  heroThumbUrl, heroSource, onlinePrice:{min,max,indicative}|null, tagPrice:
  {min,max}|null, onHand, flags:{noImage, noCad, conflicts, indexing:
  'none'|'partial'|'full'}`. Filters: q (existing), category, subCategory
  (listing), size (ProductOption), karat, colour (variant/association), priceMin/
  priceMax (online min or tag), storeId, availability, source, imageCoverage
  (`none|no_cad|unindexed|indexed`). Server-side, paginated.
- Detail (`GET /products/:id/full`, lazy): product master, identifiers (Gati id,
  SKU, style, website code, external id), listing, every variant, sizes, every
  price with {source, kind, variant}, every active image (source, colour, angle,
  shape, isPrimary, pinned, thumbUrl, embeddingStatus), BOM per variant,
  specifications, stock availability per store, every stock piece with all
  fields (tag, hallmark, HUID, certificate, size, HSN, gross/net/pure/diamond/
  stone weights and pieces, component amounts), provenance timestamps, open
  conflicts for the product.
- Cost boundary: for anyone below store_manager (and any public/unauth path)
  strip variant `marginPercentage`, `makingCharge`, `priceWithMargin`? (keep
  price), BOM `rawMaterialId`, `rate`, `lineTotal`/`amount`, StockItem cost/
  metal/diamond/stone/making/cpf amounts; composition via existing forViewer.
  Never return `rawMaterialId` to anyone below head_office. Tests for each.
- Pin primary: `POST /products/:id/images/:imageId/primary` sets pinnedPrimary
  (clears others) then recompute order; `DELETE .../primary` unpins.
- Upload path calls `CatalogueIndexService.enqueue` (replacing fire-and-forget).
- Cross-tenant/store tests for list, detail, images.

### Inference (inference agent — `inference/`)
- `INFERENCE_API_KEY` required when set (header `x-api-key`); `/health` stays
  open but returns no secrets. Request limits: body size, per-image bytes,
  MIME sniffing, `Image.MAX_IMAGE_PIXELS` decompression-bomb guard, max
  images per batch. Per-stage timings in the response (`timings_ms`: decode,
  detect, dino, siglip) and `Server-Timing`. Health contract: make the backend's
  expected shape and the service's actual shape agree (read ml-inference.service.ts).
- `DETECT_MODE=always|auto|off` (auto = whole-image first; run detection only when
  the whole-image embedding confidence heuristic says background dominates —
  implement, benchmark, default stays `always` unless the bench shows equal
  recall). `bench/` script: latency p50/p95 for 1 and 3 images, and recall vs
  current pipeline on the local catalogue sample; record results in
  `inference/BENCHMARK.md`. Optional ONNX/INT8 only with evidence.

### Frontend (frontend agent)
- Similarity results: whole card clickable + "View details" button; nested
  buttons stopPropagation; Enter/Space; focus ring; no overlay intercepts; opens
  the existing product-detail dialog over the preserved search state (query
  images, results, scroll), closes back without re-running; prev/next; safe
  not-found. Matched image selected on open, CAD marked Primary. Show matched
  source/colour/angle on the card.
- Query images resized/oriented client-side to ≤1600px, ≤1 MB (quality ≥0.85
  first), sent in ONE request. `CATALOGUE_INDEX_BUILD_REQUIRED` → coverage +
  progress UI, not a spinner. 429 → friendly retry with Retry-After.
- Catalogue list: marketing name, code, hero thumb (CAD first), online price
  range, tag price range, on hand, indicators; new filters (see Product API).
- Detail: everything in the detail contract; gallery with source badges (CAD /
  Website / Manual / Inventory), colour/angle, thumbnails in the strip, full
  resolution only for the selected image; variants table; sizes; prices list
  with labels; BOM with role-based columns; spec text with provenance; stock
  pieces table; provenance; conflict warnings; HO pin-as-primary.
- `/catalogue/integration` (head office): health, runs, receipts, conflicts
  queue with resolve/ignore/link, credential form (write-only), dry run /
  full / resume / reindex / retry-dead buttons, embedding counts.
- Fix "DINOv3" label. Browser tests in `frontend/e2e/` or
  `backend/scripts/` style (read existing) at 1280, 420 and 390 px.

## Golden product 11871RG
Synthetic fixture `backend/test/fixtures/website/11871RG.json` (sanitised: fake
`_id`s, fake rawMaterialIds, example.com image URLs) built from the facts in the
task brief; the integrations agent owns it and the golden e2e. Totals are never
hard-coded against the live site.

## Appendix — API shapes (Product API, as built)

Money and weights are JSON numbers (from Decimal); dates are ISO strings.
Keys marked † are ABSENT (not null) for salesperson/storeperson; ‡ only for
head office (stripped from source JSON at any depth for everyone else).

### `GET /products` (list)
Query (all optional; unknown values → 400): `q, category (enum value or
website category e.g. "Rings"), subCategory, size, karat, colour, metal,
priceMin, priceMax, storeId, availability, source
(gati|website|gati_website|import|manual), imageCoverage
(none|no_cad|unindexed|indexed), page, pageSize`. With page/pageSize →
`{items, total, page, pageSize}`; without → plain array. Each item = the
existing card (`id, sku, name, styleNumber, gatiId, websiteCode, source,
category, metal, karat, weightGrams, caratWeight, price, availability,
stockClass, storeId, imageUrl, composition, stock{hereCount, elsewhere[],
totalCount, where}, …`) plus:

```json
{
  "displayName": "Catapi Aurora Ring",
  "heroImageUrl": "https://…/cad.jpg", "heroThumbUrl": null, "heroSource": "gati_cad",
  "onlinePrice": { "min": 40000, "max": 55000, "indicative": 45000 },
  "tagPrice": { "min": 52000, "max": 58000 },
  "onHand": 2,
  "flags": { "noImage": false, "noCad": false, "conflicts": 1, "indexing": "none|partial|full" }
}
```
`onlinePrice`/`tagPrice` are `null` when there are no such prices. The same
additions are on `GET /products/:id`.

### `GET /products/:id/full` (detail, lazy)
Everything in `GET /products/:id` (incl. the additions above) plus:

```json
{
  "identifiers": { "gatiId", "sku", "styleNumber", "websiteCode", "externalId", "websiteProductCode", "hsn" },
  "costPrice": 31000,                                   // †
  "listing": { "marketingName", "slug", "categories": [], "subCategories": [], "features": [], "tags": [],
               "countries": [], "isActive", "isDeleted", "description", "sizeGuide", "seo", "tombstonedAt" } | null,
  "specifications": { "text", "source": "website", "syncedAt" } | null,
  "variants": [{ "id", "source", "sourceKey", "label", "sku", "metalType", "karat", "metal", "diamondType",
                 "colour", "weightType", "goldWeight", "diamondWeight", "stoneWeight", "totalWeight", "price",
                 "priceWithMargin"†, "marginPercentage"†, "makingCharge"†, "currency",
                 "bom": [ /* source lines; rate/lineTotal/amount/cost… †, rawMaterialId ‡ */ ] | null,
                 "attributes": {…} | null }],
  "sizes": [{ "value": "IND 12", "source": "website", "sortOrder": 0 }],
  "prices": [{ "id", "source", "kind", "label", "variantId": null, "variantLabel": null, "amount", "currency", "capturedAt" }],
            // kind variant_with_margin is omitted †
  "images": [{ "id", "url", "thumbUrl", "source", "colour", "angle", "shape", "isPrimary", "pinned", "sortOrder",
               "width", "height", "embeddingStatus",
               "associations": [{ "variantId", "colour", "shape", "angle", "sourceOrder" }] }],
             // active only, in display order (index 0 = hero)
  "availabilityByStore": [{ "storeId", "storeName", "count", "here": true }],
  "pieces": [{ "id", "tagNo", "vin", "sku", "styleNumber", "productCode", "storeId", "storeName", "status",
               "stockClass", "variantId", "metal", "karat", "sizeLabel", "itemSizeId", "hsn", "huid", "hallmarkNo",
               "certificateNo", "quantity", "grossWeight", "netWeight", "pureWeight", "metalLossWeight",
               "diamondWeightCt", "diamondPieces", "stoneWeightCt", "stonePieces", "tagPrice", "mrp",
               "metalAmount"†, "diamondAmount"†, "stoneAmount"†, "makingAmount"†, "cpfAmount"†, "cost"†,
               "imageUrl", "inwardDate", "ageDays" }],
             // every status, in the viewer's stores, max 1000
  "provenance": { "source", "createdAt", "updatedAt", "gatiSyncedAt", "gatiUpdatedAt", "websiteSyncedAt",
                  "websiteSourceCreatedAt", "websiteSourceUpdatedAt", "websiteLastSeenAt", "importBatchId" },
  "conflicts": [{ "id", "kind", "summary", "detail" /* cost keys † */, "firstSeenAt", "lastSeenAt" }]
}
```
`composition` follows the existing `forViewer` rule (amounts/labour lines †).

### Photos
- `GET /products/:id/images` → `[{ id, url, thumbUrl, source, angle, isPrimary, pinned, sortOrder, embeddingStatus }]` (active, hero first).
- `POST /products/:id/images` (multipart `files`, optional repeated `angles`) and `POST /products/:id/image` (`file`) add `manual` photos, recompute order, and call `CatalogueIndexService.enqueue`. The first returns the gallery, the second the product card.
- `POST /products/:id/images/:imageId/primary` pins (one per design); `DELETE /products/:id/images/:imageId/primary` unpins → default order. Both return the gallery. Store manager+ (and storeperson via `catalogue.images`).
- `DELETE /products/:id/images/:imageId` deletes a manual photo / tombstones a synced one, drops its vectors, returns the gallery.
- Another org's or an out-of-scope store's design/photo → 404 everywhere.
