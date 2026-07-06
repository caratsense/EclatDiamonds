# Eclat / CaratSense — Agent Team

Role-specialized subagents in `.claude/agents/`. These are **reusable specialists the orchestrator (main Claude thread) dispatches per task** — not background daemons. The main thread + `tech-lead` act as PM.

| Agent | Role | Use it for |
|-------|------|-----------|
| **tech-lead** | Planner / PM | Start of a module: decompose into an ordered plan + assign the specialists below. |
| **db-migrator** | Legacy DB | Reading/restoring the SJEP SQL Server DB, schema extraction, backfill ETL. |
| **database-architect** | Target DB | Eclat Postgres schema, RLS, indexing, pgvector, migrations. |
| **backend-engineer** | Server | NestJS APIs, module business logic, services. |
| **frontend-engineer** | Client | Next.js/React PWA, dashboards, terminals, geo-attendance UI. |
| **integrations-engineer** | Channels + sync | WhatsApp, Razorpay, email/SMS, and `sync_sjep.py` (live legacy sync). |
| **jewelry-domain-expert** | Domain SME | Pricing/making-charge formulas, weights, GST, schemes; decode legacy values. |
| **security-auditor** | Cybersecurity | Store/role isolation, discount-limit bypass, secrets, OWASP — review before merge. |
| **qa-engineer** | QA | Tests + verification against the spec, incl. the multi-store/role matrix. |
| **devops-engineer** | Infra/CI | Railway/Vercel deploys, object storage, secrets, on-site sync-agent scheduling. |

## Built-ins also used
- **Explore** — cheap read-only codebase/file sweeps.
- **Plan** — generic architecture planning (or use `tech-lead` for Eclat-aware planning).
- **/code-review** skill — diff review for correctness + cleanups (use instead of a custom reviewer agent).

## How a module gets built (standard flow)
1. `tech-lead` → plan + agent assignments + DoD (expands `docs/modules/NN-slug.md`).
2. `jewelry-domain-expert` → confirms domain rules (e.g. pricing) where relevant.
3. `database-architect` → target schema/migration.
4. `backend-engineer` + `frontend-engineer` → build (parallel where independent; worktree isolation if editing concurrently).
5. `integrations-engineer` → channels/sync if the module needs them.
6. `security-auditor` + `qa-engineer` → review + test before done.
7. `devops-engineer` → deploy.

## Orchestration notes
- Run independent specialists **in parallel** (one message, multiple agent calls). Use git-worktree isolation when several write files at once.
- Every agent reads `CLAUDE.md` + relevant `docs/` first; decisions go back into `docs/DECISIONS.md`.
- Heavy multi-agent fan-out (whole-module builds) can be scripted as a **Workflow** — but only when the user explicitly opts in (it spends a lot of tokens).
