# Client Notes — Round 3 (meeting, Sat 11 July 2026)

> Source: meeting notes (Vedant). Mostly a **Gati (APRS-SJEP) usage walkthrough** —
> which parts of the legacy software the business actually uses — plus two
> directives. Refines the Gati-extraction priorities in `docs/DATA_PIPELINE.md`.

## 1. Gati usage map (what the business actually uses)

| Gati area | Used? | Notes / Eclat implication |
|---|---|---|
| **Jewelry / Material / Accounts** (top tabs) | **All used** | Confirms our sync priorities: StyleMst+Inward (jewelry/material) and JewelTrans+Journal (accounts) are the load-bearing tables. |
| **Report** | Partially | Some report features unused, but **data is pulled from there** — reports are a read/export surface, not a workflow. Eclat's Reporting module replaces this cleanly. |
| **Masters → Dust Type** | **In use** | Factory-level dust + **customer returns in dust form**. Domain fact for Returns/old-gold: dust is a real intake form (relevant to M14 old_gold flow later). |
| Masters → Stock-type-wise quality | Not in use | For customized pieces. Skip. |
| Masters → Client-side diamond weight master | Not in use | Client gives diamond, changes made. "Only master, not needed now; if data size increases, might be used — can't predict." Skip; revisit only on client ask. |
| **Utility section** | Not used now | Maybe future. Skip. |
| **Manage section** | Conditional | Software security, backup, configuration (**Email & GST**). "Required by store person, available if activated." Eclat equivalents: role-based access (done), managed cloud backups (Railway), GST config (quote engine). |

## 2. Product packaging directive
Modules for different tools: **1) Manufacturing · 2) Retail · 3) Customer CRM · 4) Accounts** —
"then deliver module according to client requirements." I.e. CaratSense should be
deliverable **module-wise per client** (activate only what a client needs).
→ Recorded as an open point (per-client module toggles); not built yet — needs a
decision on whether this means Ratanlall-only phasing or a multi-client product.

## 3. Directives
- **Manufacturing: HOLD** — "do later." (Matches current state: production timeline
  exists; no deep manufacturing/karigar module built.)
- **Refer Zoho — CRM and HR Attendance. Thoroughly refer & see what others are doing.**
  - HR Attendance: Zoho-informed rebuild already done (see `docs/modules/06-hrms.md`).
  - **CRM: Zoho CRM deep-reference pass → upgrade our CRM** (round-2 already said
    "CRM is thin — needs research; change the MIS-type layout"). Actioned now.
- **"Refer sheet shared on WA group"** — ⚠️ NOT received. Ask the client/Vedant to
  forward that sheet; fold its contents in when available.
