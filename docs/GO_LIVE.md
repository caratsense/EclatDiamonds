# Eclat / CaratSense — Go-Live Runbook ("kaise kare")

> All 17 modules are code-complete and verified locally (40/40 e2e, 17/17 pages render). What remains is **non-code**: decisions to confirm, client credentials to obtain, and the on-site sync to deploy. This file is the step-by-step for each. Detail lives in `DEPLOYMENT.md` (hosting) and `DATA_PIPELINE.md` (sync); this is the checklist that ties them together.

---

## 0. Status of the "open points"

| Item | Status | Where |
|---|---|---|
| OP-1 timeline visibility | ✅ DECIDED — internal-only (no customer view) | DECISIONS.md + built |
| OP-2 pricing source | ✅ DECIDED — `MetalRate` table is the gold-rate source of truth (feed/sync/manual); making charges per-line + category default | DECISIONS.md + `GoldRateService` |
| OP-4 area-mgr new-store scope | ✅ DECIDED + IMPLEMENTED — region-scoped | `new-store.service.ts` |
| OP-5 HRMS commission/leaderboard | ✅ DECIDED + IMPLEMENTED — salesperson sees only own | `hrms.service.ts` |
| Twenty CRM adopt? | ⬜ Open — **recommendation below** | this doc |
| OP-6 legacy code decodes | ⬜ Needs live DB — **SQL + how-to below** | §3 |

**You only need the business owner to confirm OP-1/2/4/5 if they want something different from the above** — they're already coded that way. To change one, edit the noted file (small change) and re-run `npm run test:e2e`.

### Twenty CRM — recommendation: **do NOT adopt; keep the custom Eclat CRM.**
- The custom CRM (M1) is already built, wired to the backend, multi-store + role-aware, and integrated with Quotation/Discounts/Loyalty/Timelines. Adopting Twenty now means re-platforming a working module.
- **Twenty is AGPL-3.0.** For a proprietary, client-hosted SaaS, AGPL's network-copyleft can force you to release your modifications/source. That's a legal liability for a commercial deliverable.
- **Verdict:** stay custom. Revisit only if the client explicitly wants Twenty's specific features and accepts the AGPL terms. No code change needed to "decide" this — it's already custom.

---

## 1. Hosting / deploy (Railway + Vercel + storage)

Everything is packaged (`backend/Dockerfile`, `railway.json`, `frontend/Dockerfile`, `vercel.json`, CI). Full detail in `DEPLOYMENT.md`. Order:

1. **Backend → Railway**
   - New project → add **PostgreSQL** plugin → deploy the `backend/` Dockerfile.
   - Set service variables: `DATABASE_URL=${{ Postgres.DATABASE_URL }}` (add `?schema=public&sslmode=require`), `JWT_SECRET` (long random — `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`), `CORS_ORIGINS=https://<your-vercel-domain>`, `PORT` (Railway injects it).
   - First boot runs `prisma migrate deploy`. Then run the seed + legacy backfill once (Railway shell): `npm run db:seed` then `node scripts/backfill-legacy.mjs` (only if you have the legacy data loaded; otherwise sync feeds it).
2. **Image storage** — pick one:
   - **Simplest:** add a Railway **persistent volume**, mount it (e.g. `/data/uploads`), set `UPLOAD_DIR=/data/uploads`. Local-disk provider already serves `/uploads`. Works for a single instance.
   - **CDN (scale):** create a Cloudflare **R2** bucket; later swap `StorageService` to the R2/S3 provider and set `R2_*` vars (provider stub documented in `.env.example`).
3. **Frontend → Vercel**
   - Import `frontend/`, set `NEXT_PUBLIC_API_URL=https://<railway-backend-domain>` (build-time), deploy.
   - After deploy, set the backend's `CORS_ORIGINS` to the final Vercel domain and redeploy backend.
4. **Smoke test:** open the Vercel URL, log in (`head.office@caratsense.in` / the seeded password), confirm dashboards load.

---

## 2. Flip integrations live (credentials)

All four degrade to a logged `dryRun` until their keys are set — so the app already runs. To activate, fill the env vars (Railway service variables) and redeploy. Check status anytime: `GET /integrations/status`.

### 2a. WhatsApp Business (Cloud API)
1. Meta **Business Manager** → create/confirm a Business → **WhatsApp** product.
2. Add a phone number; note the **Phone number ID** and **WhatsApp Business Account ID**.
3. App **Settings → Basic**: copy the **App Secret**. Create a **permanent System-User access token** with `whatsapp_business_messaging` + `whatsapp_business_management`.
4. **Message templates:** in WhatsApp Manager, create + submit templates for quotes / reminders / DSR; wait for "Approved". (Template name + language go into `sendTemplate`.)
5. **Webhook:** point it at `https://<backend>/integrations/whatsapp/webhook`, set the **Verify Token** to any string you choose, subscribe to `messages`.
6. Set env: `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` (same string as step 5), `WHATSAPP_APP_SECRET`.

### 2b. Razorpay
1. Razorpay Dashboard → **Settings → API Keys** → generate **Key ID + Key Secret** (use Live keys for production).
2. **Settings → Webhooks** → add `https://<backend>/integrations/razorpay/webhook`, select events `payment.captured` and `payment_link.paid`, set a **webhook secret**.
3. Set env: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`.
4. Captured payments auto-record as `Payment` rows (attributed via the `notes` set at link creation).

### 2c. Gold-rate feed
1. Subscribe to **goldapi.io** or **metals.dev** (or any JSON endpoint returning INR/gram or per-ounce gold).
2. Set env: `GOLD_RATE_API_URL` (+ `GOLD_RATE_API_KEY` if required — sent as `x-access-token`, goldapi.io style).
3. Pull a rate: `POST /integrations/gold-rate/refresh` (manager+). Schedule it daily (Railway cron / the routine scheduler) — it upserts `MetalRate` per purity.

### 2d. AI image search (Claude)
1. console.anthropic.com → create an **API key**.
2. Set env: `ANTHROPIC_API_KEY`. Image search flips from rule-based fallback to Claude-vision tagging automatically.

---

## 3. On-site live sync (the client's office PC)

Goal: the Python agent (`data_sync/EclatSync/sync_sjep.py`) reads the live `APRSSJEP` SQL Server read-only and pushes changes to `POST /sync/*` every 15 min. Detail in `DATA_PIPELINE.md` + `data_sync/EclatSync/README.md`.

### Step A — Eclat side (you, once)
Create a **head_office service account** in the Eclat DB for the agent (the `/sync/*` routes are head_office-gated). E.g. add a user with role `head_office`, a strong password, scoped to all stores. The agent logs in with these via `/auth/login`.

### Step B — Client's SQL Server (their IT, once)
1. **SQL Server Configuration Manager** → SQL Server Network Configuration → Protocols for `<instance>` → enable **TCP/IP** → restart the SQL Server service.
2. (If named instance) start the **SQL Server Browser** service, or use a fixed `host,port`.
3. Create a **read-only login** on `APRSSJEP`:
   ```sql
   CREATE LOGIN eclat_sync WITH PASSWORD = 'STRONG-PASSWORD';
   USE APRSSJEP;
   CREATE USER eclat_sync FOR LOGIN eclat_sync;
   ALTER ROLE db_datareader ADD MEMBER eclat_sync;   -- read-only, no writes
   ```
4. Allow the agent's machine through the firewall to the SQL port (1433 default).

### Step C — Install + configure the agent (their PC)
1. Install **Python 3.11+** and the **ODBC Driver 17 for SQL Server**.
2. Copy `data_sync/EclatSync/` to the PC. `pip install -r requirements.txt`.
3. Copy `eclat_config.example.bat` → `eclat_config.bat` and fill:
   - `ECLAT_BASE_URL` = the deployed backend URL
   - `ECLAT_EMAIL` / `ECLAT_PASSWORD` = the head_office service account (Step A)
   - `SJEP_SQL_SERVER` = `HOST\INSTANCE` (or `HOST,1433`), `SJEP_SQL_DB=APRSSJEP`
   - `SJEP_SQL_USER=eclat_sync`, `SJEP_SQL_PASS=...` (or leave blank for Windows auth)
4. **Test connectivity:** `python sync_sjep.py --test` → expects `[OK] Eclat backend login` + `[OK] SQL Server connected`.
5. **Schedule:** run `setup.bat` (registers a Windows Task Scheduler job: every 15 min + at logon). First run does a full backfill, then incremental by watermark.

---

## 4. Validate legacy data + OP-6 code decodes (against the LIVE DB)

The local restore is small (~239 sales, Mar–Jun 2026). Run these on the **client's live `APRSSJEP`** to confirm the mappings before trusting synced data. Update the mapping in **`backend/src/sync/sync.util.ts`** (the live-sync path) — and mirror in `scripts/backfill-legacy.mjs` for the one-time backfill — then redeploy.

### 4a. Is this the full history?
```sql
SELECT MIN(JewelTransDate) AS first_sale, MAX(JewelTransDate) AS last_sale,
       COUNT(*) AS total_sales FROM JewelTrans;
```
→ Ask the client: "Is this your complete sales history, or a fresh/test install?" Affects backfill expectations.

### 4b. OP-6: `JewelTrans.TranType` → sale / purchase / branch-transfer / proforma
```sql
SELECT TranType, COUNT(*) AS n FROM JewelTrans GROUP BY TranType ORDER BY n DESC;
```
→ Compare against `docTypeFromTranType()` in `sync.util.ts` (currently: `JWSL/BJWSL`=sale, `JWPH/BJWPH`=purchase, `JWPRM`=proforma, `*BA*`=branch transfer). Add any TranType codes you see that aren't handled.

### 4c. OP-6: `Spm_MfgOrder.OrderStatus` → custom-order stage
```sql
SELECT OrderStatus, COUNT(*) AS n FROM Spm_MfgOrder GROUP BY OrderStatus ORDER BY OrderStatus;
-- look for a status master:
SELECT name FROM sys.tables WHERE name LIKE '%Status%' OR name LIKE '%Stage%';
```
→ Today all orders map to `booked` (`syncOrders`). Once you know the integer→stage decode, map them to Eclat `OrderStatus` (booked → melting → designing → setting → polishing → ready) in `sync.util.ts`/`syncOrders`.

### 4d. OP-6: payments in `VoucherEntry` vs `Journal`?
```sql
SELECT COUNT(*) AS journal_rows FROM Journal;
SELECT COUNT(*) AS voucher_rows FROM VoucherEntry;
-- which one carries a payment MODE (cash/card/upi)?
SELECT TOP 20 * FROM VoucherEntry ORDER BY 1 DESC;
```
→ If the client books receipts in `VoucherEntry` (with a mode), add a `VoucherEntry` extractor in `sync_sjep.py` + a `/sync/payments` mapping. Currently the day-book = `Journal`.

### 4e. Metal purity / true karat
```sql
-- tone master + rate chart drive real karat; current code defaults gold → 22k
SELECT * FROM ToneMst;
SELECT TOP 50 * FROM RateChart;   -- (confirm exact table name in the live schema)
```
→ Replace the `metalFromTone()` default (22k) with a join to the rate chart / tone purity so 18k/24k/etc. are accurate. Edit `metalFromTone()`/`karatFromMetal()` in `sync.util.ts`.

---

## What I (the agent) can do next vs what needs you/the client

| Needs the client / external | I can do now |
|---|---|
| Obtain WhatsApp / Razorpay / gold-rate / Anthropic credentials | Wire anything once you paste keys into `.env` |
| Create Railway / Vercel / R2 accounts + deploy | Adjust deploy config, fix any deploy error you hit |
| Enable TCP/IP + read-only login on their SQL Server | — |
| Run the §4 SQL on the live DB | Turn the results into the exact `sync.util.ts` mapping edits |
| Confirm OP-1/2/4/5 with the business owner | Change the implementation if they want different |

Paste any credentials, deploy errors, or the §4 query results back here and I'll take it from there.
