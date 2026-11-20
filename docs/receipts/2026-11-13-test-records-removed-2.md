# Production data writes — 13 November 2026 (second batch)

**No code was deployed by this action — but production DATA was deleted.**
Owner's instruction in chat: "shreyansh sneha not snehal and kavya kaunta naam se
jo bhi hai sb hata do". Follows `2026-11-12-test-records-removed.md`. Operator:
Claude Code. Times are UTC (IST = UTC + 5:30). No phone numbers or message text
are recorded here; ids are internal.

## How the rows were found

A read-only scan of every text column in every table for "Sneha" as a whole word
(so Snehal never matches), "Shreyansh" and "Kavya Kauntia", then a detail read of
each hit. Three customers named "shrey", "kp55" and "4545" did not match by name;
they were included because two carry Shreyansh's email and all three share one
phone number with the "shreyansh kashyap" lead removed on 12 Nov. The script
checked the full numbers were identical before deleting anything.

## What was removed

One database transaction, 04:39:18 – 04:39:55 UTC, pinned to the ids below; one
`AuditLog` row per record (18), attributed to the organisation's head-office
account, each carrying the reason and the backup file's name.

| Table | Rows | Audit action | What |
|---|---|---|---|
| Quote (with lines) | 1 | `quotes.deleted` | QT-2003, approved, never an order, customer "shrey" |
| ActivityEvent | 3 | `activity.deleted` | timeline lines for QT-2004 and QT-2011 and the demo login's reply |
| Party | 3 | `crm.contact_deleted` | "shrey", "kp55", "4545", no other history |
| Payment | 1 | `payment.deleted` | ₹20,000 against the sale below |
| Sale | 1 | `sale.deleted` | "Kavya Kauntia", doc `dgfggtggh`, ₹40,000, Surat, app-created 10 Aug |
| ReturnRecord | 1 | `return.deleted` | "kavya kauntia", Surat, 11 Aug |
| DailyReport | 1 | `report.deleted` | MUMBAI BANDRA, 2026-10-04, filed by Sneha over WhatsApp, all zeros |
| Message | 1 | `message.deleted` | the demo login's reply in the "Aarti chouksey" thread |
| Notification | 5 | `notification.deleted` | four about Sneha's DSR filing, one about the Kavya Kauntia return |
| WhatsAppIdentity | 1 | `whatsapp.identity_deleted` | Sneha's phone linked to the demo staff login |

## What was kept

- The staff login "Sneha Chouksey Demo" (store manager, inactive since 5 Oct). It
  is the actor on 3 audit rows, and `AuditLog.actor` is RESTRICT by design, so it
  cannot be deleted without erasing history. It cannot sign in.
- Every `AuditLog` row, including those naming these people.
- Gati customers SNEHAL and KAVYA, and the "Aarti chouksey" customer and thread
  (not named in the instruction; only the demo login's one message was removed).
- Bandra now has no DSR for 2026-10-04; the deleted one was a test filing of zeros.

## Checked after

The full-table scan finds only the inactive staff login and audit history.
`AuditLog` holds the 18 rows of this batch.

## How to reverse

Every deleted row was written before the transaction to
`C:\Users\Shrey\Eclat-backups\removed-test-records-2-2026-11-13T04-39-20-361Z.json`
on the operator's machine. Not kept in the repository because it holds names,
phone numbers and message text.
