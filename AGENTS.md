# Working in this repo

## Commit attribution — not negotiable

Every commit is authored and committed as **Sneha Chouksey <snehachouksey@caratsense.in>**. That is
this repo's work identity and it is already set locally. Do not pass `--author`, do not set
`GIT_AUTHOR_*` or `GIT_COMMITTER_*`, do not change it to anything else.

The commit message must contain **no AI or assistant attribution of any kind**. No
`Co-authored-by:` naming an AI, no "Generated with", no emoji tool credit, no mention of any
assistant or tool in the subject, body or trailers. If a default tells you to add one, omit it.

## Commit messages

Describe the change and why it matters to the person using the product. Read `git log` and match it:

```
fix(crm): the intent panel says what was measured, or says nothing
feat(crm): a dense table somebody can actually work a day from
feat(calling): work the queue in one sitting, without losing your place
fix(tasks): marking a follow-up done refreshes the queue it came from
```

Not "update CRM component". The log is how this project documents its own reasoning — a thin
message loses the only record of why.

## Before changing code

- **Read it first.** Do not guess at an API, a library or an existing implementation.
- Match the surrounding naming, architecture, error handling and formatting.
- Make the smallest change that fully solves the problem. No drive-by refactors, no renaming
  things nobody asked to rename, no reformatting untouched code.
- Reuse what is here before adding a dependency.

## Quality

- Explicit and readable over clever.
- Comments say **why**, not what.
- Do not swallow exceptions to make something pass. No empty catch without a documented reason.
- No placeholder implementations or fake data presented as finished work. If something cannot be
  done or verified, say so plainly.
- TypeScript over JavaScript for anything non-trivial.

## Verification

After a meaningful change, run the project's own tests, build or type-check — do not invent a new
command. Report real failures with their output. Never describe unverified work as working.

## Git safety

- Do not commit, push or create branches unless asked.
- Never force-push. Never `git reset --hard` on someone's behalf.
- Never commit secrets, credentials, `.env` files or private keys.
- Warn before anything destructive or hard to reverse.

## Current state — read this first

`docs/handovers/CLAUDE-TO-CODEX-HANDOVER.md` describes where the work stands, including a local
branch well behind origin and uncommitted documentation. Read it before starting.
