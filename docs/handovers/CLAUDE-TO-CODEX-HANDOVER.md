# Handover — Claude session to Codex

Written 30 September 2026, at the point the Claude account working this repo hit its weekly
limit. Everything below was read off the repo and the session history, not remembered.

---

## Read this before you touch anything

Three facts about the working tree, in the order they will hurt you.

### 1. Local `main` is 195 commits behind `origin/main`, and 0 ahead

Someone or something else has been pushing. Nothing here has been pushed, and nothing here is
missing from origin **except the uncommitted work below**. The top of what you are missing:

```
81ce0e7 feat(sync): remove from CaratOS what Gati deleted
85391bf docs(sync): the every-table mirror, and how to use it without the agent
e08bd08 feat(sync): mirror every Gati table, sending only new and changed rows
e4b4e62 docs(sync): GATI_DB_SYNC.md, and the sync docs brought up to the 29 Sep setup
90c6b52 feat(agent): sync catalogue photos in the same 15-minute cycle
b56eb9e feat(rates): take the metal rate from Gati's Daily Rate master
```

There is a whole Gati database-sync workstream in there that this local checkout knows nothing
about. **Do not start feature work against this tree until it is current** — you would be building
on a codebase three days stale.

### 2. About 3,000 lines of documentation are untracked and have never been committed

```
docs/META-INTEGRATION-AND-CLIENT-MEETING.md    954 lines
docs/META-INTEGRATION-ARCHITECTURE.md          443 lines
docs/META-SETUP-RUNBOOK.md                     493 lines
docs/WHATSAPP-BOT-SCRIPT-DRAFT.md              321 lines
docs/handovers/ECLAT-GO-LIVE-CHECKLIST.md      329 lines
docs/handovers/PER-TENANT-APP-SECRET.md        210 lines
docs/modules/01-crm-omnichannel.md             325 lines
```

Plus `docs/DECISIONS.md` modified (both staged and unstaged) and `frontend/package-lock.json`
modified.

This is real work product sitting on one laptop with no copy anywhere. **Commit it first.** It is
all untracked, so it cannot conflict with anything — it is the safe move and it takes a minute.

### 3. A pull will conflict

A merge preview shows conflict markers. So the order is:

```
git add docs/            # the untracked docs — safe, nothing to conflict with
git commit               # get them off this laptop alone
git push                 # only after the pull below, or push the branch somewhere safe first
git pull --rebase        # then deal with the conflicts deliberately
```

Look at `docs/DECISIONS.md` carefully when it conflicts — it is a decision log, so both sides are
probably wanted, and taking one wholesale loses real reasoning.

---

## What this project is

Eclat Diamonds is a jewellery client. This repo is their CRM and omnichannel system — the recent
history reads:

- **CRM** — a dense table somebody can work a full day from, customer threads, an intent panel that
  says what was measured or says nothing
- **Telephony** — an inbound call becomes a customer, an enquiry and a callback; a calling queue you
  can work in one sitting without losing your place
- **WhatsApp / Meta** — four WhatsApp threads to work locally, a staging gate, per-tenant app secret
- **Gati sync** — mirroring every Gati table, catalogue photos on a 15-minute cycle, metal rate from
  Gati's Daily Rate master *(this is the part only on origin)*
- **Design** — obsidian and indigo, no serif anywhere; one shape for a headline figure, one colour
  for a state

`docs/modules/01-crm-omnichannel.md` and `docs/META-INTEGRATION-ARCHITECTURE.md` are the two to read
first, once committed.

---

## Where the work actually was

The last stretch was **getting the system ready to demo to Ayushi**, not building new features. The
open threads at the point the session stopped:

- **Meta ads had just gone live** and were about to be tested. Note: the ad account is the
  **client's**, not ours — so billing sits with them, and Ads Manager showed
  *"Ad account restricted — we couldn't process your last payment."* Ayushi acknowledged a problem
  in Ads Manager and said she would fix it. Ads cannot be meaningfully tested until that clears.
- **Whether to move everything to production** for a better demo impression — asked, not resolved.
- **The calling feature** — what the calling icon actually does, and whether a human agent can see
  the number and call from their own phone. Asked, answer unclear.
- **WhatsApp sender identity** — the business name does not appear anywhere on outbound messages;
  whether the API can carry it was raised and not settled.
- **A daily tracker / cadence** — there is an expectation of a 2–3 line daily summary of what was
  done. Find where that lives before assuming it does not.

`docs/handovers/ECLAT-GO-LIVE-CHECKLIST.md` (untracked, 329 lines) is almost certainly the live
to-do. Read it early.

---

## Conventions this repo has been held to

These are not in an `AGENTS.md` yet, so nothing will enforce them for you.

- **Commit identity is `Sneha Chouksey <snehachouksey@caratsense.in>`** — the work identity, not the
  personal one. Already set in this repo's local config; do not change it.
- **No AI attribution in commits.** No `Co-authored-by` naming an assistant, no "Generated with"
  footer, no mention of any AI tool anywhere in the message, including trailers.
- **Commit messages say what changed and why**, in the product's own voice, describing the effect on
  the person using it. Look at `git log` — `"the intent panel says what was measured, or says
  nothing"`, `"a dense table somebody can actually work a day from"`. Match that. It is how this
  project documents itself.
- Read before editing. Match surrounding style. Smallest change that solves the problem. No
  drive-by refactors.

---

## Local history, if you need what was said

The Claude transcripts for this project are on this machine at:

```
C:\Users\HP\.claude-caratsense\projects\D--workspace-caratsense-EclatDiamonds\
```

Nine sessions, 109 MB, newest is `f8aa1859-831e-4c1e-9398-8c5a60afd5de.jsonl` (82 MB). They are
JSONL — one message per line. Grep them for a topic rather than opening them.

They are **not** deleted by switching tools, and the Claude account is rate-limited rather than
lost. It resets **30 September, 6:30pm Asia/Calcutta**.
