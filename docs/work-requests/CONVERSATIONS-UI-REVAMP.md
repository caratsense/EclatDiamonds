# Conversations tab — UI revamp

> Scope for the redesign agreed 30 September, against the mockup Ayushi supplied.
> Everything here is **frontend only**: no schema change, no new endpoint, no
> change to routing, delivery or permissions.

## The rule that governs this work

**Every chip, count and label must be backed by a real field.**

PR #17 removed three fabrications from this exact screen — tags chosen by the
row's position in the list, a hardcoded message preview, and unread counts of
3 and 5 pinned to the first two rows. They survived months of demos because
they *looked* right.

The mockup shows chips reading "Happy Users", "New Enquiry", "Existing
Customer", "Follow Up". Those are legitimate **only** if they come from
`LeadTag`. If a tag is not assigned, the row shows no chip. An empty row is
honest; an invented one is the defect that was just removed.

The same applies to the "82 / High Intent" dial: that renders only when a
`LeadQualification` exists. Nothing scored means the panel says so, which is
what `intent-analysis-panel.tsx` already does.

## What the backend already supports — use it, do not rebuild it

| Mockup element | Existing support |
|---|---|
| Channel selector (WhatsApp ▾) | `ChannelAdaptersService` knows whatsapp / instagram / email / voice; `list()` takes `channel` |
| Tag chips | `LeadTag` + `LeadTagAssignment`, per-tenant slug, colour held as a **token name** not a hex |
| Branch under each name | `Conversation.storeId`, already rendered |
| Inbox / Unread / Assigned to me | `queueCounts()` + `list()` filters |
| Branch filter | `list({ storeId })`, shipped in PR #21 |
| Intent dial | `LeadQualification`, bot and human scores both retained |

Only the last row of the nav bar in the mockup has no backing: it is a
navigation change, out of scope for this screen.

## Build order

1. **Header + filter bar.** Title, subtitle, pill row, settings and Invite
   Members. The branch filter from PR #21 moves into "More filters" rather than
   sitting loose beside the tabs.
2. **Channel selector.** Offer only channels the tenant can actually receive on
   — a dropdown listing Instagram when no Instagram is connected teaches people
   the product is lying. `deliverability()` answers this per channel.
3. **Tag chips.** Read assigned tags; render the tag's own colour token. No
   fallback chip when a row has no tags.
4. **Light/dark parity.** The mockup is light; the current build is dark-first
   (`89826c6` "obsidian and indigo"). Both must hold. Every colour goes through
   a token — no raw hex in the component, which is also why `LeadTag.colour`
   stores a token name.

## Explicitly not in this work

- Bottom navigation bar — a shell change, not a conversations change
- Message scheduling, conversational bot replies — separate features from the
  same meeting, both unbuilt
- Head office's unassigned-conversation view — the open question from 29 Sep,
  noted on PR #21

## Definition of done

- `tsc` and lint clean
- Every chip traced to a field; screenshot in both themes
- No backend diff in the PR
