# Eclat / CaratSense — Deployment Runbook (Path A)

Step-by-step to take Eclat from this repo to a live system. **Path A** stack
(see `docs/DECISIONS.md`):

- **Backend + future BullMQ workers** → **Railway** (Docker).
- **PostgreSQL** → **Railway managed Postgres**.
- **Frontend** → **Vercel** (Next.js 16). Optional alternative: Railway (a frontend
  `Dockerfile` is included for this).
- **Object storage** for jewellery images / return photos → **Cloudflare R2** (or
  Railway volume / Cloudinary). Postgres stores **URLs only**.
- **On-site sync agent** → Windows Task Scheduler on the client's office PC
  (see `data_sync/EclatSync/README.md`).

> Status: this repo is **deploy-ready (config only)**. No hosting accounts are
> connected yet. Sections below marked **[GO-LIVE]** are the manual steps to run
> once the client's Railway / Vercel / Cloudflare accounts exist.

---

## 0. Prerequisites
- Railway account + `railway` CLI (`npm i -g @railway/cli`), or the Railway dashboard.
- Vercel account + `vercel` CLI (optional; dashboard works too).
- A Cloudflare account (for R2) — or decide on Railway volume / Cloudinary.
- A custom domain (recommended): e.g. `app.caratsense.in` (frontend),
  `api.caratsense.in` (backend), `images.caratsense.in` (R2 public bucket).
- Generate a strong `JWT_SECRET`:
  ```bash
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
  ```

---

## 1. Backend → Railway + managed Postgres  **[GO-LIVE]**

The backend ships as a Docker image (`backend/Dockerfile`) and is described by
`backend/railway.json`. The container runs `prisma migrate deploy` on boot, then
starts the compiled server. Railway injects `PORT`.

1. **Create the project + database.**
   - Railway dashboard → **New Project** → **Deploy from GitHub repo** → pick this
     repo, set the service **root directory** to `backend`.
   - In the same project: **New → Database → Add PostgreSQL**.
2. **Wire `DATABASE_URL`.** In the backend service → **Variables**, set:
   ```
   DATABASE_URL = ${{ Postgres.DATABASE_URL }}
   ```
   Confirm it includes `?schema=public&sslmode=require` (append if missing).
3. **Set the remaining secrets** (Variables tab) — from `backend/.env.example`:
   - `JWT_SECRET` (required), `JWT_EXPIRES_IN` (optional)
   - `CORS_ORIGINS` = your real frontend origin(s) — see step 5 below.
   - Object-storage keys (`R2_*` or `CLOUDINARY_*`) once provisioned (section 4).
   - Integration placeholders (`WHATSAPP_*`, `RAZORPAY_*`, `GOLD_RATE_*`) — leave
     blank until those modules are wired.
   - **Do NOT set `PORT`** — Railway provides it.
4. **Deploy.** Railway builds the Dockerfile. First boot applies all migrations.
   Watch logs for `Eclat backend listening on ...` and that `migrate deploy`
   reported the applied migrations.
5. **Seed (first store / demo data).** Either:
   - Run once from the Railway shell: `npm run db:seed`, **or**
   - locally with the prod `DATABASE_URL` exported: `cd backend && npm run db:seed`.
   `prisma/seed.mjs` is idempotent. For real per-store go-live, prefer the
   migration/backfill pipeline (section 6) over demo seed.
6. **Domain.** Backend service → **Settings → Networking → Generate Domain** (or add
   `api.caratsense.in`). Note the URL — the frontend needs it.

### Health check
`railway.json` points the healthcheck at `/stores` (an authed route → returns 401
when up, which still proves liveness). If a dedicated unauthenticated `/health`
endpoint is added later, update `healthcheckPath` in `backend/railway.json`.

---

## 2. CORS — point the backend at the real frontend  **[GO-LIVE, code change]**

`backend/src/main.ts` currently **hardcodes** `origin: ['http://localhost:3000']`.
Before go-live, change it to read the `CORS_ORIGINS` env var so the deployed Vercel
domain is allowed. Suggested change (have backend-engineer apply):

```ts
const origins = (config.get<string>('CORS_ORIGINS') ?? 'http://localhost:3000')
  .split(',').map((s) => s.trim());
app.enableCors({
  origin: origins,
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Store-Id'],
});
```

Then set `CORS_ORIGINS` on Railway to e.g.
`https://app.caratsense.in,https://eclat.vercel.app`. Until this change lands,
browser calls from the deployed frontend will be CORS-blocked.

---

## 3. Frontend → Vercel  **[GO-LIVE]**

Config: `frontend/vercel.json`. `NEXT_PUBLIC_API_URL` is a **build-time** public var.

1. Vercel dashboard → **Add New → Project** → import this repo, set **Root
   Directory** to `frontend`. Framework auto-detects Next.js.
2. **Environment Variables** (Production + Preview):
   ```
   NEXT_PUBLIC_API_URL = https://api.caratsense.in   (your Railway backend URL)
   ```
3. **Deploy.** Add the custom domain `app.caratsense.in` under Settings → Domains.
4. After the backend domain is known, **redeploy** the frontend if you changed
   `NEXT_PUBLIC_API_URL` (it is inlined at build time, so a rebuild is required).
5. Add the final frontend domain to the backend's `CORS_ORIGINS` (section 2).

### Alternative: frontend on Railway
A `frontend/Dockerfile` (uses Next.js `output: "standalone"`) is included. Deploy it
as another Railway service with root `frontend`, and pass `NEXT_PUBLIC_API_URL` as a
**build arg** (it is baked into the client bundle). Vercel is the default/recommended
host; Railway is the single-platform fallback.

---

## 4. Object storage for jewellery images / return photos  **[GO-LIVE]**

Postgres stores **URLs only**; binaries live in object storage.

### Option A — Cloudflare R2 (recommended, S3-compatible)
1. Cloudflare dashboard → **R2 → Create bucket** → `eclat-jewellery-images`.
2. Create an **R2 API token** (Object Read & Write) → note Access Key ID + Secret.
3. Enable public access via a custom domain (`images.caratsense.in`) or an
   `r2.dev` URL; that base becomes `R2_PUBLIC_BASE_URL`.
4. Set on Railway backend Variables: `STORAGE_PROVIDER=r2`, `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL`.

### Option B — Railway volume
Attach a persistent volume to the backend service and serve images from the app.
Simpler, single-platform, but not CDN-backed — fine for low image volume / MVP.

### Option C — Cloudinary
Set `STORAGE_PROVIDER=cloudinary` + `CLOUDINARY_*` vars. Good if you want built-in
image transforms (thumbnails for the catalogue grid).

---

## 5. On-site sync agent (per store)  **[GO-LIVE]**
Install on the office PC that hosts SJE Plus / APRS SQL Server. Full operator
instructions: `data_sync/EclatSync/README.md`. Summary:
1. Create a **read-only** SQL login on their SQL Server for the agent.
2. Create a dedicated **sync user** in Eclat (login the agent uses).
3. Copy `eclat_config.example.bat` → `eclat_config.bat`, fill in URL + credentials.
4. Right-click `setup.bat` → **Run as administrator** (installs deps + schedules
   every 15 min + at logon).
> Data-extraction SQL is `TODO(schema)` until `docs/legacy-schema.md` exists.

---

## 6. Per-store rollout (cutover)
Multi-store is first-class; stores go live **one at a time**.
1. **Backfill** the store's history once (restore its `APRSSJEP.bak` → ETL into
   Postgres) — see `docs/DATA_PIPELINE.md`.
2. **Install the sync agent** on that store's office PC (section 5).
3. **Verify** dashboards for that store, then enable its users.
4. Repeat per store. Each store is independent — one store's agent failing does not
   affect others (watch `auto_sync.log` + the sync alert in section 8).

---

## 7. Backups & restore (before real data lands)
Railway managed Postgres provides automated backups — **confirm the plan/retention**
and enable them before the first real store goes live.
- **Manual snapshot before any migration/cutover:**
  ```bash
  pg_dump "$DATABASE_URL" -Fc -f eclat_$(date +%F).dump
  ```
- **Test restore** into a throwaway DB to prove the backup is valid:
  ```bash
  pg_restore --clean --if-exists -d "$RESTORE_TARGET_URL" eclat_YYYY-MM-DD.dump
  ```
Never test-restore over production. Document the first successful restore test in
`docs/DECISIONS.md`.

---

## 8. Observability
- **Backend logs:** Railway service logs (boot line + request errors).
- **Sync health:** each agent writes `auto_sync.log`; a stuck sync = stale
  dashboards. Add an alert when no successful sync has occurred in > ~45 min
  (e.g. agent heartbeat → `SyncState`, dashboard banner if stale). Track as a
  follow-up.
- **Frontend:** Vercel deployment + runtime logs.

---

## 9. CI
`.github/workflows/ci.yml` runs on every push/PR: backend `npm ci` →
`prisma generate` → `prisma validate` → `tsc --noEmit` → `build`; frontend
`npm ci` → `tsc --noEmit` → `build`. No secrets required; keeps both apps green.

---

## Go-live checklist (once accounts exist)
- [ ] Railway project + managed Postgres created; `DATABASE_URL` referenced.
- [ ] Backend secrets set (`JWT_SECRET`, `CORS_ORIGINS`, storage keys).
- [ ] Backend deployed; migrations applied; seed/backfill done.
- [ ] CORS change (section 2) merged and `CORS_ORIGINS` set to real domain.
- [ ] Object storage provisioned; keys set.
- [ ] Frontend on Vercel with `NEXT_PUBLIC_API_URL` = backend URL; domain added.
- [ ] Frontend domain added to backend `CORS_ORIGINS`; frontend redeployed.
- [ ] Automated Postgres backups confirmed + one restore test passed.
- [ ] Sync agent installed on store #1 office PC; `--test` passed; first sync seen.
