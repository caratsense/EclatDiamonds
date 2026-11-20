# Production data write — 20 November 2026

**Production DATA was changed, and a code change shipped with this receipt.**
Owner's instruction in chat: cancel the "Re-embed everything" pressed by
mistake and remove the button ("Re-embed everything ive pressed it galti se usko
cancel kro and remove this uselsess"). Operator: Claude Code. Times are UTC
(IST = UTC + 5:30).

## What the mistaken press did

At 08:04:19 UTC "Re-embed everything" on Catalogue Integration queued 4,452
`catalogue.embed_image` jobs, one for every active catalogue picture, although
every one was already indexed at the current model version. It also set those
pictures' `embeddingStatus` to `queued`, so every design card showed the
hourglass "Not searchable by photo yet". Left alone it was about five hours of
inference work, with every picture uploaded to the inference service again.
The existing vectors were never deleted, so photo search kept working.

## What was changed

One database transaction at 08:08:48 UTC:

| Table | Rows | Change |
|---|---|---|
| JobTask (`catalogue.embed_image`) | 4,445 | `pending` → `succeeded`, with `result.skipped` naming the reason |
| ProductImage | 4,445 | `embeddingStatus` `queued` → `indexed` |
| AuditLog | 1 | `catalogue.reindex_cancelled`, id `cmwop6j9m0001rmk88do3tqxn`, attributed to the organisation's head-office account, counts and reason in `metadata` |

**How the rows were chosen.** A dry run at 08:07:49 pinned the 4,452 pending
jobs whose picture was active, already had vectors, and carried the same model
version as the job. None of the pending jobs needed real work. The write ran
against those exact ids and would have rolled back if the worker had taken one
mid-way. Seven had already been taken before the write; they ran to the end and
re-made identical vectors.

Settling the jobs as `succeeded` was chosen over a new `cancelled` status
because `CatalogueIndexService.enqueue` revives only `succeeded` or `dead`
jobs. A `cancelled` row would block that picture's job key for good.

## Checked after

- 4,475 active pictures, all `indexed`.
- No design card shows the hourglass: 1,328 designs are searchable by photo,
  and the other 87 have no photo at all.
- No embed jobs pending or running.

## Code shipped with it

The "Re-embed everything" button is removed from Catalogue Integration. New
pictures are still indexed on their own, and "Retry failed" still re-queues
failed pictures. The API's `force` option remains for a deliberate re-index
after a model change.

## How to reverse

Not needed. The pinned job and picture ids are in
`C:\Users\Shrey\Eclat-backups\reembed-cancel-dryrun-2026-11-20T08-07-49-217Z.json`
on the operator's machine (ids and the head-office account's name only).
Setting those jobs back to `pending` and the pictures to `queued` would re-run
the re-embed.
