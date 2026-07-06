# Eclat / CaratSense — Backend

NestJS (TypeScript) API over Prisma + PostgreSQL. The `src/` app is layered on top of
the data layer in `prisma/`. Runs on **port 4000** (the frontend's `NEXT_PUBLIC_API_URL`).

## Run the API
```bash
cd backend
npm install
npm run prisma:generate
npm run db:seed        # idempotent demo data across the 3 stores
npm run build          # compile to dist/
npm run start          # http://localhost:4000   (start:dev for watch mode)
```
CORS is open for `http://localhost:3000`. All routes require `Authorization: Bearer <jwt>`
except `POST /auth/login`. Broad roles narrow the active store with the `X-Store-Id`
header (store id, or `all`); it must be within the caller's scope.

## Demo logins (password for all: `password123`)
| Email | Role | Scope |
|---|---|---|
| `priya.rep@caratsense.in` | salesperson | Surat — Main only |
| `rina.rep@caratsense.in` | salesperson | Ahmedabad — C.G. Road only |
| `aarav.mehta@caratsense.in` | store_manager | Surat — Main |
| `karan.malhotra@caratsense.in` | store_manager | Mumbai — Bandra |
| `neelam.area@caratsense.in` | area_manager | West India region (all 3 stores) |
| `head.office@caratsense.in` | head_office | All stores |

## Endpoints (flagship modules, all store-scoped)
| Method + path | Module |
|---|---|
| `POST /auth/login`, `GET /auth/me` | Auth / session |
| `GET /stores` | Multi-store |
| `GET /leads`, `GET /leads/:id`, `POST /leads`, `PATCH /leads/:id` | M1 CRM |
| `GET /products`, `GET /products/:id` | M5 Catalogue |
| `GET /quotes`, `GET /quotes/:id`, `POST /quotes` | M2 Quotation |
| `GET /stock` | M9 Inventory |
| `GET /dashboard/kpis`, `GET /dashboard/charts` | M3/M10 Dashboard |
| `GET /discounts`, `POST /discounts` | M15 Discount approval |

## Store-scoping + RBAC (CLAUDE.md rules #1, #2)
- `JwtAuthGuard` (global) verifies the JWT and resolves the caller's full allowed-store
  set into `req.user` via `StoreScopeService.resolveScope()`: salesperson/store_manager →
  own `UserStore` rows; area_manager → all stores in their region(s); head_office → all.
- `StoreScopeService.storeFilter()` returns the Prisma `where` fragment every list query
  uses; `assertStoreAllowed()` gates writes (cross-store write → 403).
- `RolesGuard` + `@Roles()` enforce the role hierarchy (higher rank inherits).
- Discount rule (M15): requested `percent` vs the role's `DiscountLimit.maxPercent` →
  auto `approved` if within limit, else `escalated`.

---

## Data layer

This folder is also the **database / ORM layer** — Prisma schema, migrations, dev seed.

- ORM: **Prisma 6** → **PostgreSQL** (local dev: Postgres 18, service `postgresql-x64-18`).
- Full schema: [`prisma/schema.prisma`](prisma/schema.prisma)
- ER overview + legacy mapping: [`../docs/eclat-schema.md`](../docs/eclat-schema.md)

## Status on this machine
- Dev DB **`eclat_dev` created** on `localhost:5432` (creds `postgres:postgres`).
- Initial migration **`prisma/migrations/<ts>_init` applied** — 45 application tables.
- Dev seed applied (1 region, 3 stores matching the frontend mocks, 4 discount limits, 1 user).

## Setup (fresh machine)
```bash
cd backend
cp .env.example .env          # set DATABASE_URL
npm install
npx prisma migrate dev        # creates DB schema (or `migrate deploy` in prod/CI)
npm run db:seed               # optional dev seed
```

If Postgres credentials differ, edit `DATABASE_URL` in `.env` first. The exact local
connection string that works on this machine is:
```
postgresql://postgres:postgres@localhost:5432/eclat_dev?schema=public
```

## Scripts
| Script | What |
|---|---|
| `npm run migrate:dev` | create + apply a migration in dev |
| `npm run migrate:deploy` | apply pending migrations (prod/CI) |
| `npm run migrate:reset` | drop + recreate + reseed (DESTRUCTIVE, dev only) |
| `npm run prisma:generate` | regenerate the Prisma client |
| `npm run db:studio` | open Prisma Studio |
| `npm run db:seed` | run `prisma/seed.mjs` |

## AI image search (Module 5) — pgvector
`pgvector` is **not installed** on the local Postgres, so `Product.embedding` is modelled
as `Float[]` (portable, applies everywhere). Once the `vector` extension is available in
the target environment, upgrade to a real ANN-indexed column:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
ALTER TABLE "Product" ADD COLUMN embedding_v vector(512);
-- backfill embedding_v from embedding (or re-embed), then drop the Float[] column
CREATE INDEX product_embedding_hnsw ON "Product"
  USING hnsw (embedding_v vector_cosine_ops);
```
In Prisma, represent the vector column with `Unsupported("vector(512)")` and run image
search via `$queryRaw` (`ORDER BY embedding_v <=> $1 LIMIT k`). See `docs/eclat-schema.md`.

## Conventions baked into the schema
- **Multi-store:** `Region → Store`; every business row carries `storeId`. Aggregate
  ("All Stores") views are computed in the app for `area_manager` / `head_office`.
- **RBAC:** `User.role` + `UserStore` assignments. Store-scoping and role rank are
  **enforced in the NestJS app/guards**, not in the DB (no RLS yet — see eclat-schema.md
  for the optional RLS upgrade path).
- **Exact numerics:** all money / weights / making / tax are `Decimal` — never float.
- **Sync provenance:** legacy-mirrored tables carry `legacyId` + `legacyUpdatedAt`; the
  sync agent upserts by watermark and tracks progress in `SyncState`.
