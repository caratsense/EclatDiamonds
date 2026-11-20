# CaratOS — Backup / DR readiness and AWS migration assessment

**Status of this document: an ASSESSMENT, not a record of configured infrastructure.**

Nothing here has been provisioned by this work. Where a control does not exist, it
says so. This distinction matters more than usual for backups: a DR document that
describes a backup nobody configured is worse than no document, because it stops
people asking whether one exists.

---

# B6 — Backup / disaster recovery

## Current state, verified

| Asset | What exists today | Status |
|---|---|---|
| PostgreSQL | Railway managed Postgres. A repository-owned `pg_dump` + checksum command now exists, but its production schedule and off-site destination are not configured. Railway snapshot/PITR frequency and retention remain unverified | **CODE READY / INFRA UNVERIFIED** |
| Object storage (R2) | Cloudflare R2 bucket holding product photos, return photos, quote and order attachments. No bucket versioning, lifecycle rule or replication is configured in this repository | **NOT CONFIGURED** |
| AI knowledge source files | Private local storage for development plus signed server-side R2 PUT/GET/DELETE mode. Production bucket/credentials and versioning are not configured | **CODE READY / INFRA PENDING** |
| Tenant exports | No per-tenant export exists. There is an import pipeline (CSV/XLSX in) with no counterpart out | **NOT IMPLEMENTED** |
| Point-in-time recovery | Not configured or verified | **UNVERIFIED** |
| Restore drill | Local seeded rehearsal completed 2026-09-08; production-shaped staging restore is still required | **LOCAL PASS / STAGING PENDING** |

The repository now contains `backend/scripts/db-backup.mjs`,
`db-restore-verify.mjs`, and a localhost-only end-to-end drill. The backup emits a
PostgreSQL custom-format dump and SHA-256 manifest; restore refuses every target
except an explicitly disposable `_test`/`_rehearsal` database. **This is not a
configured production backup:** no schedule, encrypted off-site destination,
retention policy, Railway PITR setting, or R2 versioning was changed by code.

Local evidence from 2026-09-08: all 66 migrations applied, the current seed ran,
the dump checksum verified, and the restored database retained 1 organisation,
7 users, 4 stores, 22 sales, 8 payments and 8 stock items. Restore took 2.54s for
the small demo dataset. Both disposable databases and temporary dump were removed.

Commands:

```text
cd backend
npm run db:restore:drill

# Scheduled backup job (BACKUP_OUTPUT_DIR must be an absolute encrypted/off-site mount)
BACKUP_DATABASE_URL=... BACKUP_OUTPUT_DIR=... npm run db:backup

# Staging-only restore verification; target name must end _test or _rehearsal
RESTORE_DATABASE_URL=... BACKUP_FILE=/absolute/path/file.dump npm run db:restore:verify
```

## What is required before go-live

### PostgreSQL

- **Frequency** — continuous WAL archiving with a base backup daily. Snapshot-only
  backups give an RPO equal to the snapshot interval, which for a jeweller taking
  payments all day means losing a day of collections.
- **Retention** — 30 days of PITR plus 12 monthly archives. Indian statutory
  retention for financial records is far longer than 30 days; the monthly archives
  serve that, and are a different control from operational recovery.
- **Encryption** — at rest (provider-managed) and in transit (`sslmode=require`,
  already in the connection string).
- **Separate location** — backups must live in a different account/organisation
  from the primary. A backup in the same account as the database is a backup that
  a compromised or mis-billed account takes with it. This is the single most
  commonly skipped control.
- **RPO / RTO targets** — proposed: **RPO 5 minutes**, **RTO 4 hours**. These are
  proposals, not measurements: RTO cannot be claimed until a restore has actually
  been timed.

### Object storage (R2)

- Enable **bucket versioning** so an overwritten or deleted photo is recoverable.
- A **lifecycle rule** moving non-current versions to cheaper storage after 30
  days and expiring them after 180.
- **Replication to a second bucket in a different account.** Product photography
  is expensive to recreate — for many pieces it is impossible, because the item
  has been sold.
- Note: R2 objects are currently served from a **public** base URL. That is a
  security finding (see below), not a durability one, but the same review should
  cover both.

### Tenant exports

A per-tenant export serves two distinct needs that are easy to conflate:

1. **Portability** — a customer leaving must be able to take their data. Absent
   this, "you can export at any time" cannot be truthfully offered in a contract.
2. **Targeted restore** — restoring one tenant's mistake from a whole-database
   backup means restoring everything, which is not usable in a multi-tenant
   system.

The provenance work already done (`legacyId`, `importBatchId`, `ProvenanceService`)
makes a correct per-tenant export tractable, and the RLS policies added in B3 give
a natural mechanism for bounding it. Not implemented.

### Restore procedure (scripted locally; staging drill still required)

1. Provision a new database instance.
2. Restore the base backup, replay WAL to the target timestamp.
3. Verify: row counts per tenant, `Organisation` count, most recent `Sale` and
   `Payment` per store, `_prisma_migrations` matches the deployed release.
4. Repoint `DATABASE_URL`, redeploy, confirm `/health/deep` reports `ok`.
5. Reconcile object storage separately — the database and the bucket are restored
   to two different points in time unless both are versioned.

The local mechanism has been executed. A production-shaped backup must still be
restored into a separate staging project before go-live; record that measured RTO
and verify Railway PITR separately in the provider dashboard.

---

# Credential-encryption key rotation

Tenant integration credentials are AES-GCM encrypted and bound to their tenant,
integration and credential-kind context. Treat the following as an operator
runbook; it has not been executed against production by this repository work.

1. Preserve the existing active key in the deployment secret manager. Set that
   exact value as `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`.
2. Generate a new 32-byte random key, store its base64 value as
   `CREDENTIAL_ENCRYPTION_KEY`, and increment the positive integer
   `CREDENTIAL_ENCRYPTION_KEY_VERSION`.
3. Deploy active key, previous key and version to every backend instance in one
   rollout. Confirm `/health/deep` does not report credential encryption as
   misconfigured.
4. For each tenant with stored integration credentials, authenticate as that
   tenant's head-office administrator and call
   `POST /integrations-registry/credentials/rewrap`. Record its audit event and
   require `complete: true`, `failed: 0`; retry `concurrent` rows after any
   simultaneous credential update finishes.
5. Exercise at least one server-side adapter for each stored credential kind and
   confirm no decrypt failures appear in redacted logs.
6. Only after every tenant and every instance is confirmed current, remove
   `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`. Retain a recoverable secret-manager
   version for the approved rollback window; never copy key material into logs,
   tickets, chat or this document.

A version bump is mandatory operational discipline even though the code also
detects a mistaken same-version key replacement. Losing both the active and
previous keys makes stored credentials irrecoverable; the recovery action is to
ask each tenant to enter new credentials.

---

# B7 — AWS migration readiness

**No migration has been performed and none is recommended yet.** This is an
inventory of what would need to change.

## Provider coupling, by severity

| Area | Current | Coupling | Effort |
|---|---|---|---|
| Object storage | Cloudflare R2 via a hand-rolled SigV4 signer (`storage/sigv4.ts`) | **Very low.** R2 is S3-API-compatible and the signer is already SigV4. Moving to S3 is an endpoint and credential change | Hours |
| Database | Railway managed Postgres, reached by `DATABASE_URL` | **Very low.** Standard Postgres; RDS/Aurora needs only a new URL. Pool sizing already configurable via `DB_POOL_SIZE` | Hours |
| Secrets | Plain environment variables | **Medium.** Secrets Manager needs a fetch-at-boot step. `CREDENTIAL_ENCRYPTION_KEY` is the one that matters — losing it makes every stored tenant credential unreadable | Days |
| Compute | Dockerfile + `railway.json` | **Low.** The Dockerfile ports to ECS/Fargate directly. `preDeployCommand` becomes a one-off migration task | Days |
| Jobs / scheduler | In-process Postgres queue (`SELECT … FOR UPDATE SKIP LOCKED`) + in-process cron | **Medium.** Correct for one container; with several ECS tasks the cron would fire once per task. See below | Days |
| Frontend | Vercel | **Low.** CloudFront + S3, or keep Vercel — it is a static Next build behind an API | Days |
| Logging | Nest `Logger` to stdout | **Very low.** CloudWatch collects stdout from Fargate with no code change | None |

## The genuine blockers

1. **The scheduler assumes exactly one instance.** `SchedulerModule` runs cron
   in-process. On Railway that is true today. Behind an ECS service with two
   tasks, every scheduled job runs twice. `ScheduledJobRun` already carries a
   `runKey`, which is the right idempotency primitive — but it must be verified
   as a real unique constraint before horizontal scaling, not assumed.

2. **Rate limiting is per-instance.** The B4 limiter uses in-memory storage, so
   with N replicas a tenant gets up to N times the configured limit. Stated
   explicitly in `common/rate-limit.ts`. Acceptable at one replica; needs a shared
   store (ElastiCache, or a Postgres table) before scaling out. Deliberately not
   built now — adding Redis for a single-replica deployment is a second thing that
   can be down for no benefit.

3. **RLS requires a non-superuser database role.** Verified experimentally during
   this phase: connecting as a superuser bypasses RLS **silently**, so policies
   appear correct while enforcing nothing. Any RDS/Aurora setup must give the
   application a dedicated non-superuser, non-`BYPASSRLS` role.

4. **Local disk uploads.** With `STORAGE_PROVIDER=local` files land on the
   container filesystem and do not survive a redeploy. `/health/deep` now reports
   this as *degraded* in production. Must be R2/S3 before any container migration.

## Recommended sequence, if it happens

1. Secrets Manager first — it is independent of everything else and reduces risk
   immediately.
2. RDS/Aurora with a dedicated application role (also unblocks RLS).
3. S3 alongside R2, dual-write, verify, then cut over. Never delete from R2 until
   the S3 copy has been read back.
4. ECS/Fargate last, once the scheduler's single-instance assumption is resolved.

## What was changed in this repository for AWS readiness

Nothing structural, deliberately. The storage layer is already provider-neutral
behind `StorageService`, the database is reached only through `DATABASE_URL`, and
logging already goes to stdout. Introducing abstraction layers ahead of a decision
that has not been made would add indirection with no user visible today.

---

# Cross-cutting: known production risks

| Risk | Severity | Status |
|---|---|---|
| No verified production database backup | **Critical** | Scripts + local restore pass; production schedule/off-site copy/PITR remain unresolved infrastructure |
| R2 objects publicly readable by URL | **High** | Identified, not changed (see below) |
| No tenant export | Medium | Not implemented |
| Rate limiting per-instance | Medium | Documented; correct at one replica |
| Scheduler assumes one instance | Medium | Documented |
| RLS not enabled | Medium | Policies written and validated; enabling blocked on per-request context |
| Runtime dependency advisories | High | Patched 2026-09-08; CI now rejects high-severity runtime advisories in both apps |
| Prisma 6 CLI advisory | Build-time | Still reported when optional tooling is included; Prisma 7 is a breaking migration and is intentionally deferred from the MVP release |

## R2 public-read

Object URLs are unguessable (they embed a cuid) but are **bearer capabilities**:
anyone with the link can fetch the object, with no tenant check. Object keys are
already namespaced `org/{organisationId}/…`, so the data is *segregated* but not
*authorised*.

Making the bucket private requires signed URLs on every read path — product
images, return photos, quote attachments, order receipts, and the AI image-search
result set — plus a migration for URLs already stored in the database and already
rendered in the frontend. That is a coordinated change across both applications,
and doing it hastily would break existing media, which is explicitly out of scope
for this phase.

Recorded here rather than partially implemented. A half-migrated media path is
worse than an honest public one, because nobody can tell which objects are
protected.
