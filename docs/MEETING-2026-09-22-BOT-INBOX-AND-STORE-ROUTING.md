# Éclat — one bot, one number, and who sees which lead

> Meeting note, 22 September 2026. Ayushi described how she wants the WhatsApp
> bot and the CRM inbox to work. This is that conversation written down, checked
> against what the system actually does today, and turned into a short list of
> decisions we need back from her.
>
> **Headline: the biggest thing she asked for is already built and can be shown
> on a screen today.** Two smaller things need building, and one needs a button.

---

## What Ayushi asked for

In her words, tidied:

1. **One bot on one number.** A single assistant talks to customers. Store staff
   work through that same number rather than their own phones.
2. **Each store sees only its own leads.** A lead that came from the Bandra
   campaign reaches the Bandra manager. It does not appear in Udaipur's inbox.
3. **A person can correct the intent score.** If the assistant scores a lead and
   the manager disagrees, the manager's judgement should count.
4. **Notes on a customer**, so what the branch thinks about them is recorded
   rather than remembered.
5. **Close a chat.** A finished conversation — converted or not — leaves the
   active list and stays in history, so agents know what still needs attention.

---

## Where each one stands

| # | Ask | Status |
|---|---|---|
| 1 | One number, bot and staff together | **Works today** |
| 2 | Each store sees only its own leads | **Works today** |
| 3 | Editable intent score | **New work** — about a day |
| 4 | Notes on a customer | **Half there** — notes exist, but only on leads |
| 5 | Close a chat | **Needs a button** — the rest is built |

Nothing she asked for cuts against how the system is designed. One point (#5)
needs a decision from her before we build it.

---

## 1 · One number, bot and staff together — works today

Every thread records the number it arrived on, and a reply is always sent back
out from that same number. This matters more than it sounds: answering from a
different number starts a second chat on the customer's phone, throws away the
24-hour window WhatsApp opened on the first, and reads to the customer as a
different business.

Each thread is marked as handled by **the assistant**, **a person**, or
**nobody yet**. A person taking over is an explicit act, not something guessed
from whether someone happened to reply. When the assistant hands over, it
records *why* — including when it hands over because it failed, so a silent
breakdown cannot hide.

Rules can also give the assistant **different instructions per campaign**, so
one bot on one number can still talk about engagement rings differently from how
it talks about a wedding-collection ad.

---

## 2 · Each store sees only its own leads — works today

This is the ask that matters most, and it is the one already finished.

**The chain, end to end:**

```
Customer taps a WhatsApp ad
    ↓  Meta sends us the ad id
A routing rule matches that ad id      ← Ayushi maps ad → store
    ↓
The thread is stamped with that store
    ↓
Who can open it is decided by that stamp
```

**Who sees what:**

| Role | Sees |
|---|---|
| Salesperson | only threads assigned to them personally |
| Store manager | their own store's threads |
| Area manager | the stores in their area |
| Head office | everything |

**Proof, run against the live system on 22 Sep** — the same five logins, the
same inbox, at the same moment:

| Login | Role | Threads visible |
|---|---|---|
| Head Office | head office | **14** |
| Karan Malhotra | Mumbai — Bandra | **2** |
| Aarav Mehta | Surat Main | **2** |
| Neelam | area manager, 3 stores | **5** |
| Priya | salesperson, Surat | **0** |

Worth saying plainly: **this is enforced on the server, not hidden in the
screen.** A Bandra manager cannot reach a Udaipur conversation by editing the
web address, guessing an id, or exporting a list. The count in each tab is
calculated under the same rule as the list itself, so nobody is even told how
many conversations exist in a queue they are not allowed to read.

**Two things follow from this that Ayushi should know:**

- **It only routes as well as the ad list we are given.** The rules match on ad
  id. Until each city's campaign ids are mapped to its store, ad leads arrive
  unrouted and land in the head-office queue. This is the single dependency —
  see "What we need back", item 1.
- **A salesperson currently sees nothing until a lead is given to them** — which
  is why Priya shows 0 above. That is deliberate (it is also how AiSensy
  behaves), but if Éclat expects counter staff to work the queue themselves,
  someone has to assign, or we widen the rule to "everything at my branch". Her
  call — item 3 below.

---

## 3 · Editing the intent score — new work, and how we propose to do it

The assistant scores a lead out of 100 and shows what moved the score. Ayushi
wants an authorised person to be able to correct it.

**We will not overwrite the assistant's number.** The manager's score is
recorded as a new assessment, stamped with who made it and why, and the earlier
one stays. The panel shows the manager's score as the current one, with the
assistant's underneath.

This costs nothing extra to build and buys three things:

- Someone disputing a score can see who set it and when.
- A manager cannot quietly erase an inconvenient assessment.
- Over a few months it becomes measurable whether the assistant or the branch
  reads customers better — which is impossible to know if corrections overwrite
  the evidence.

The system already keeps assessments this way and already has a slot for a
human-authored one; nothing has ever written to it. So this is filling in a gap
that was designed for, not bending the design.

---

## 4 · Notes on a customer — half there

Notes already exist, with author and timestamp, and already carry a kind —
note, call, visit, WhatsApp.

**The gap:** a note can only be attached to a *lead*. A WhatsApp conversation
that never became a lead — someone who messaged organically, or a number not yet
matched to a customer — has nowhere to put one. Since Ayushi wants the note
attached to *the customer*, we will attach it to the customer record and show it
in the conversation, so it holds whether or not a lead exists.

---

## 5 · Closing a chat — needs a button, and one decision

More of this is built than expected:

- Closing a conversation is already supported by the system.
- The inbox already shows only open threads.
- A **Closed** tab already exists and already counts correctly.

**What is missing is the control itself** — no screen offers a way to close a
chat. That is a small piece of work.

**The decision we need first: what happens when a closed customer messages
again?** Two reasonable answers:

- **It reopens** into the active list as a fresh conversation. Nobody is missed;
  the list is noisier.
- **It stays closed** until someone reopens it. The list stays clean; a
  returning customer can go unnoticed.

AiSensy effectively chose the first. We would recommend the same — a returning
customer is exactly the person you least want to miss — but it is Ayushi's call
because it shapes what her managers look at every morning.

---

## How AiSensy does it — since Ayushi asked

Worth reading, because two of her asks come straight from it.

**Agent Rules.** An agent is given an attribute or tag and sees only chats
carrying it. Managers see everything. Their own example: of 100 chats, tag 20 as
`Demo`, give an agent that tag, and those 20 are all they can see or resolve.

**Chat lifecycle.** `Active` (bot is handling it) → `Requesting` (needs a human)
→ `Intervened` (an agent stepped in) → agent presses **Resolve** → back to
`Active`. There is also an auto-resolve that clears chats after 24 hours of
silence.

**Where we already match them:** our three handling states line up almost
exactly — assistant, person, nobody yet — and our open/closed tabs match
theirs.

**Where we deliberately differ, and why it is better for a jewellery chain:**

- **They route by tag. We route by store.** A tag is typed by a person and
  drifts — mis-spelled, forgotten, inconsistent between branches. A store is a
  fact about where the lead came from, derived from the ad itself. It cannot be
  forgotten, and it cannot be got wrong by a busy agent at 7pm.
- **Their "Resolve" hands the chat back to the bot; it does not archive the
  customer.** What Ayushi described is a genuine close — out of active, into
  history. Ours does that. This is the difference behind the decision in §5.
- **Their agent sees only what is assigned.** Same as ours today — which is the
  point raised at the end of §2.

Sources: [Agent Rules](https://wiki.aisensy.com/en/articles/11502721-how-to-assign-agent-rules) ·
[Agents & Managers](https://wiki.aisensy.com/en/articles/11502730-how-to-add-agents-managers-to-aisensy-app) ·
[Live Chat panel](https://medium.com/aisensy/aisensy-live-chat-page-251e119f0388) ·
[Live Chat settings](https://wiki.aisensy.com/en/articles/11502609-live-chat-settings-feature)

---

## What we need back from Ayushi

1. **The campaign list: which ad belongs to which store.** Bandra, Bandra
   Broadway, Delhi Rohini, Delhi Paschim Vihar, Udaipur. Without this, ad leads
   cannot be routed to a branch — it is the one thing blocking §2 in practice.
2. **The reopen decision** in §5 — does a closed customer messaging again come
   back into the active list?
3. **Who may correct an intent score?** Store managers only, or counter staff
   too? And should a salesperson see their whole branch's queue, or only what is
   handed to them?
4. **Still outstanding from the previous round:** the seven ring URLs, the
   per-city store links, and showroom hours. The bot's wording cannot be
   finalised without them.

---

## For the dev side

Verified by reading the code on `fix/photos-intent-score-and-store-label`, and
by the live role comparison above.

| Ask | Where it lives | Work |
|---|---|---|
| 1 | `Conversation.senderAssetId`, `handling`, `handoffReason`; per-rule `aiContext`/`aiGuardrails` | none |
| 2 | `ConversationsService.visibility()` + `StoreScopeService.storeFilter()`; `AdSetAutomationRule` matches `ad_id` → `storeId` | none |
| 3 | `LeadQualification.method` already documents `'human'` and has `createdById`; **no code path writes it**, no endpoint | new endpoint + panel control; append a row, never mutate |
| 4 | `LeadNote` is keyed to `leadId` only | re-key to the customer; surface in the thread |
| 5 | `PATCH /crm/conversations/:id {status:'closed'}` exists; inbox already filters `status:'open'`; `closed` queue counts | UI control + mutation only |

Two notes while in there:

- **Starred and Snoozed are browser-local.** They live in component state, not
  in the database, so they are per-machine and vanish on a different laptop. Not
  one of Ayushi's asks, but do not demo them as if they persist.
- `docs/handovers/ECLAT-GO-LIVE-CHECKLIST.md` still says the bot does not exist
  and every reply was typed by hand. That is stale against this branch, where the
  qualification bot's menu is live. Worth correcting before anyone reads it as
  current.
