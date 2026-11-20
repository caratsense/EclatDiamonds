# Production data writes — 12 November 2026

**No code was deployed by this action — but production DATA was deleted.**
Owner's instruction in chat: remove the test data named Sneha, Shreyansh and
Kavya, keep everything that came from Gati or the website ("SNEHA SHREYANSH AND
KAVYA HATA DO BAAKI BAAD ME DEKHENGE"). Operator: Claude Code. Times are UTC
(IST = UTC + 5:30). No phone numbers or message text are recorded here; ids are
internal.

## What was removed

One database transaction, 16:49:48 – 16:50:09 UTC, with one `AuditLog` row per
record in the shape `AuditService.record` writes, attributed to the
organisation's head-office account. Every audit row carries the reason and the
backup file's name in `metadata`.

| Table | Rows | Audit action | Ids |
|---|---|---|---|
| Quote (with its lines) | 1 | `quotes.deleted` | `cmv97yp6p8493mz01dficy4bi` (QT-2011, draft, Delhi) |
| Lead | 3 | `lead.deleted` | `cmuuwzy5obbjkma01cw6g7fhj`, `cmsn1ii7h004qqs016bfwun0o`, `cmu2dn69s000bnv01xljknc9w` |
| Conversation (WhatsApp, 0 messages) | 1 | `conversation.deleted` | `cmv6dtqnh5l40uq01hrdgguic` |
| Party (customer) | 2 | `crm.contact_deleted` | `cmuuwzy4tbbjgma01fknso9m5`, `cmuy18rbb13tfny01fth1o94r` |
| CheckIn | 0 | — | — |

**How the rows were chosen.** A record qualified only if its name's first word
is exactly Sneha, Shreyansh or Kavya, and (for customers) it has no `legacyId`
and no `importBatchId`, so nothing from Gati, a file import or the website was
eligible. A customer still holding sales, payments, ledger, loyalty, orders,
schemes or returns would have stopped the run. The deletion ran against the
exact ids above, pinned from a dry run; had production held anything more or
different, nothing would have been deleted.

## What was kept

- Gati customers **SNEHAL** and **KAVYA**, one bill each (`legacyId` set).
- The staff login "Sneha Chouksey Demo" (store manager, already inactive). Staff
  logins were outside this instruction.

## Checked after

- A re-scan of customers, leads, quotes, check-ins and staff for the three names
  finds only the two Gati customers and the inactive staff login.
- `AuditLog` holds the 7 rows, 16:50:04 – 16:50:08 UTC, actor role head_office.

## How to reverse

Every deleted row, including the quote's lines, was written to
`C:\Users\Shrey\Eclat-backups\removed-test-records-2026-11-12T16-49-50-497Z.json`
on the operator's machine before the transaction. Re-create the rows from it in
the order customers, conversation, leads, quote and lines. Not kept in the
repository because it holds names and phone numbers.
