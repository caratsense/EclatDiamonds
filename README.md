# Eclat / CaratSense — Working Project

This is the **clean, self-contained working copy** of the Eclat project, kept on the internal C: drive so it does **not** depend on the large `E:\` archive.

## What's here (everything needed to build & run)
- `frontend/` — Next.js 16 app (run: `cd frontend && npm run dev` → http://localhost:3000)
- `backend/`  — NestJS API + Prisma (run: `cd backend && npm run start:dev` → http://localhost:4000)
- `docs/`     — all project docs. **Start with `docs/HANDOFF.md`.**
- `data_sync/`— the on-site SJEP→Eclat sync agent (`EclatSync/sync_sjep.py`)
- `.claude/`  — agent definitions
- `CLAUDE.md` — agent context (read first)

## Database
The app uses **PostgreSQL `eclat_dev`** on this machine's local Postgres (not stored in this folder). It already holds the seeded demo data **plus the real legacy backfill** (564 parties, 753 products, 2,690 stock pieces, 239 sales…). Connection is in `backend/.env` (`DATABASE_URL`).

## What is NOT here (intentionally — lives on E:\ "CARATSENSE" drive)
The legacy reference archive stays on `E:\Eclat Project\`:
- `SJEP BACKUP/` (~525 GB of dated `.bak` files) — **reference only**
- `SJEP DATA/` (live `.mdf`), `SJEP REPORT/` (DevExpress `.repx` + requirements PDF)
- planning spreadsheets/PDFs

**Why it's safe to leave them behind:** everything we needed from the backups was already extracted — the schema is mapped (`docs/legacy-schema.md`) and the real data was backfilled into Postgres. In production the app syncs from the **client's live SQL Server**, not these backups. Keep the E:\ archive only for re-restore / audit if ever needed.

## First-time setup on a fresh machine
1. `cd backend && npm install` then `cd ../frontend && npm install`
2. Ensure local PostgreSQL is running; set `backend/.env` `DATABASE_URL`; `cd backend && npx prisma migrate deploy && node prisma/seed.mjs`
3. Start backend (`npm run start:dev`) and frontend (`npm run dev`). Log in at /login (see `backend/README.md` for demo accounts).
