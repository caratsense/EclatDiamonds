# Eclat — Multi-Store Contract

> The single reference for how store scope, assignment, and cross-store access
> work. Every store is independent; **there is no "main store"** and Surat is
> just one store. Backend authorization is authoritative — the frontend store
> selector is a *filter*, never a grant.

## 1. Store identity
A store is a `Store` row (`id`, `name`, `city`, `code`, `legacyId`). `legacyId`
links it to its Gati branch/party row (see [GATI_DATA_CONTRACT.md](GATI_DATA_CONTRACT.md)).
The synthetic **"All Stores" aggregate** (`isAggregate = true`) is a *view* only —
it is never a destination for a write and never resolves to a concrete branch.

## 2. Store assignment
A user is linked to the stores they operate through `UserStore` rows. The
authoritative scope for a request is resolved **server-side, from the DB**, on
every request (`JwtAuthGuard` → `StoreScopeService.resolveScope`) — never from
the JWT payload (which carries only identity) and never from a request parameter.

- `AuthUser.storeIds` — the full set of stores the user may read/write.
- `AuthUser.allStores` — `true` only for `head_office` (`isAllStoreRole` = HO only).

## 3. Primary store
There is **no** persisted "primary store" concept and no implicit default. When a
concrete store is required for a write and none is supplied, the rule is:

- exactly one assigned store → use it;
- more than one (or head office) → **require an explicit store** (400), never
  silently pick `storeIds[0]` / the first / alphabetical / Surat.

This is enforced in `StockService.assertConcreteDestination` (stock create/import),
`ReportingService.createDaily` (DSR), and `DashboardService.createHandoff`.

## 4. Store scope by role
| Role | Scope |
|---|---|
| `salesperson` | own store(s) only; further narrowed to own records (e.g. own leads) |
| `store_manager` | own assigned store(s) only |
| `head_office` | **all stores** (intentional cross-store visibility) |
| `area_manager` | collapsed into `store_manager` (dead role, never reintroduced) |

"All Stores" means the aggregate of every store the caller is scoped to — for HO
that is genuinely all stores; for anyone else it is their assigned set. It must
**never** silently become one store.

## 5. Authorization primitives (`StoreScopeService`)
- `storeFilter(user, requestedStoreId?)` — returns the Prisma `where` store
  constraint. A `requestedStoreId` only **narrows** within the caller's scope; an
  out-of-scope value throws `ForbiddenException`. Broad roles with no request
  store get their full `storeIds` set (HO gets no constraint).
- `effectiveStoreIds(user, requestedStoreId?)` — the concrete store-id list for
  aggregates/dashboards; same narrowing + throw rules.
- `assertStoreAllowed(user, storeId)` — gates a write to one store; throws if out
  of scope. HO passes for any store.

A request `storeId` (header `X-Store-Id`, `?storeId`, body, route param) is thus
**never authorization** — it is validated against the server-derived scope before
use. Guards (`JwtAuthGuard`, `RolesGuard`) are global (`APP_GUARD`).

## 6. Cross-store restrictions
- A store user cannot read or write another store's data by changing any request
  store parameter — every store-scoped query/mutation routes through the
  primitives above (audited 2026-08-13: no cross-store leak found).
- Moving stock between stores is **only** via the Stock Transfer workflow
  (`store A submit → HO approve → dispatch → receive → acknowledge`); the crude
  cross-store `PATCH /stock/:id` path was removed. See stock-transfer source-of-
  truth in [GATI_DATA_CONTRACT.md](GATI_DATA_CONTRACT.md) §Stock.

## 7. Gati branch → Eclat store mapping
Every synced row is attributed to a store **per-row**, resolved from the Gati
branch id against `Store.legacyId`:

- Column priority per entity (`SYNC_BRANCH_COLUMNS`-overridable): `EclatBranchId`
  → `BranchNo` → `LocationId` (stock also `FirstLocationId`). `EclatBranchId` is a
  synthetic column the on-site agent stamps for entities with no location column
  (sales/orders/ledger), resolved from `BookMaster.BookNo → BranchNo`.
- A row that resolves to **no known branch** is never assigned a real shop: on a
  multi-branch install it lands in a dedicated **"Unassigned" holding store**;
  every fallback is counted (`attribution.fellBackToDefault`) and unknown branch
  ids are reported (`attribution.unknownBranchIds`) — never guessed.
- `SYNC_DEFAULT_STORE_ID` must be set **explicitly per install** (no hardcoded
  branch); an unset value is a config error, not a silent Surat default.

## 8. "All Stores" semantics — summary
| Context | "All Stores" resolves to |
|---|---|
| HO reads/aggregates | every store |
| Non-HO reads/aggregates | the caller's full assigned set |
| Any **write** needing a concrete store | **explicit pick required** (never a default branch) |

## 9. Verified modules (2026-08-13 isolation audit — all ENFORCED)
stock · sales · payments · returns · discounts · parties/customers · leads ·
quotes · DSR/reporting · dashboard · targets · finance · HRMS/attendance ·
catalogue/products · stock-transfers · production timelines. Store scope is
derived from the authenticated user in every read and write; no path trusts a
request-supplied store id as authorization.
