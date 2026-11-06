# Éclat WhatsApp bot — script draft v1

> **For Ayushi's approval.** This turns the flow you described into the actual
> words the customer will see, written to WhatsApp's formatting limits. Nothing
> is built until you've signed this off.
>
> **What changed from your notes, and why.** WhatsApp caps how many tappable
> options a message can carry — 3 for buttons, 10 for a scrolling list — and
> caps each option's label at about 24 characters. So the wording of the choices
> is tighter than plain prose would be. The *meaning* is yours; only the length
> is ours.
>
> Anything in `{{double braces}}` is filled in automatically — the customer's
> name, their city, the branch, and so on.
>
> Draft 1, 2026-09-16.

---

## How the conversation starts

The customer clicks an ad, fills the form, and taps **Chat on WhatsApp**. By the
time they reach us we already know their **name** and **phone number**, and —
depending on the form — their occasion, budget and whether they want to visit.

**The bot never asks again for anything the form already captured.** It greets
them, skips what it knows, and asks only what's missing. Being asked the same
question twice in two minutes is the fastest way to lose someone who was
interested.

---

## Flow 2 — the customer wants to talk to someone

This is the main flow and the one to build first.

### Opening

> Hi {{first_name}} 👋
>
> Thanks for reaching out to **Éclat Diamonds**.
>
> I'll ask you two or three quick questions so I can show you the right pieces —
> it takes under a minute.

### Q1 · What they're looking for

*Sent as a list. Only asked if the form didn't already capture it.*

> **What are you looking for today?**

| Option | Sub-text |
|---|---|
| `Engagement ring` | Solitaires and proposal rings |
| `Wedding jewellery` | Bridal sets, necklaces, bangles |
| `Daily wear` | Everyday diamonds and gold |
| `Other jewellery` | Tell me what you have in mind |

*Button label:* `Choose one`

### Q2 · Who it's for

> **Lovely. Is this for you, or for someone special?**

| Option | Sub-text |
|---|---|
| `Myself` | — |
| `My partner` | — |
| `Family` | Parent, sibling or child |
| `A gift` | For someone else |

### Q3 · Budget

> **Roughly what budget did you have in mind?**
>
> *This just helps me show you the right pieces — nothing is fixed.*

| Option |
|---|
| `Under ₹50,000` |
| `₹50,000 – ₹1 lakh` |
| `₹1 lakh – ₹2 lakh` |
| `Above ₹2 lakh` |
| `I'd rather discuss it` |

> ⚠️ **Needs your decision.** Your 7-slide ad form uses different bands —
> ₹1,00,000–₹2,50,000 and ₹2,50,000+. These use ₹1–2 lakh and above ₹2 lakh.
> They should match, or the same customer will be recorded in two different
> brackets. **Which set should we use?**

### Q4 · Timing

> **And when are you hoping to buy?**

| Option |
|---|
| `Within 7 days` |
| `This month` |
| `1 – 3 months` |
| `Just exploring` |

---

## The rings branch

*Only if Q1 = Engagement ring.*

> You can see our engagement rings here → {{rings_url}}
>
> **Do you have a diamond shape in mind?** I'll send you a link to just those.

| Option |
|---|
| `Round` |
| `Oval` |
| `Emerald` |
| `Princess` |
| `Pear` |
| `Not sure yet` |

**If they pick a shape:**

> Lovely choice. Here are our **{{shape}}** rings → {{shape_url}}

**If they pick "Not sure yet":**

> No problem at all — that's the part our team is best at helping with.
> Here's the full collection meanwhile → {{rings_url}}

> ⚠️ **We need seven live URLs from you:** one per shape, plus the full
> collection. They must be real filtered pages — a link that opens an empty
> result is worse than sending no link at all.

---

## Asking for the call

> {{first_name}}, our **{{branch}}** team can talk you through designs, pricing
> and customisation.
>
> **Would a quick call work?**

*Three buttons:*

| Button |
|---|
| `Yes, call me now` |
| `Call me later` |
| `Not right now` |

### If "Yes, call me now"

> Perfect — I'm connecting you with **{{manager_name}}** from our {{branch}}
> showroom now. They'll take it from here. 💎

*The conversation is handed to that branch's manager in CaratOS. The customer
sees no change — same chat, same number, a person instead of the bot.*

### If "Call me later"

> Of course. **When suits you best?**

| Option |
|---|
| `Later today` |
| `Tomorrow morning` |
| `Tomorrow evening` |
| `This weekend` |
| `I'll message you` |

> Noted — **{{slot}}** it is. {{manager_name}} from our {{branch}} showroom will
> call you then.

### If "Not right now"

> No problem at all, {{first_name}} — no pressure from us.
>
> Two things you can do whenever you like:
>
> 📷 Send me a **photo or screenshot** of any design you like and I'll get you a
> price for it.
>
> 📍 Or visit us — here's our **{{city}}** showroom → {{store_url}}
>
> Just message me here whenever you're ready.

> ⚠️ **We need your showroom links** — one per city, and confirmation of which
> cities to offer. Your ad-form list includes **Hyderabad**, which doesn't appear
> in the store list we have from your system. Is it a live showroom?

---

## Flow 1 — the customer just wants a price

*Triggered when someone sends a photo, a screenshot, or asks "what's the price".
Can happen at any point, including in the middle of Flow 2.*

> Let me price that for you.
>
> **{{product_name}}**
> Gold — {{gold_weight}}g, {{karat}} {{gold_colour}} · ₹{{gold_value}}
> Diamonds — {{diamond_carat}}ct, {{clarity}} · ₹{{diamond_value}}
> Making — ₹{{making}}
> GST — ₹{{gst}}
> **Total — ₹{{total}}**
>
> *Priced as 14kt yellow gold with VVS–EF diamonds. We can make this in 9kt or
> 18kt, in a different gold colour, or with different diamond specifications.*
>
> **What would help most?**

| Button |
|---|
| `Revised quote` |
| `Speak to someone` |
| `See more designs` |

> ⚠️ **Build this second.** A real breakup needs a live gold rate, the product's
> actual weights, and identifying the piece from a photo. Those exist in CaratOS
> but none of them is connected to WhatsApp yet. Flow 2 is a conversation; Flow 1
> is a pricing feature.
>
> **A decision we need from you:** should the bot send a **firm price**
> automatically, or an **indicative range** with a person confirming? An
> automatic wrong price is a commercial problem, not a technical one.

---

## Follow-ups

These are different from everything above. WhatsApp only allows a business to
**start** a conversation using a message template approved by Meta in advance —
and approval takes a few days. Once approved, the wording is frozen; changing a
word means resubmitting.

So these two need to be right before they go in, and they should be submitted
early.

### After one week

> Hi {{1}}, it's been a week since you were looking at **{{2}}** with us.
>
> If you're still deciding, we're happy to help whenever you're ready — no
> pressure.
>
> Every Éclat piece comes with certified diamonds, and a lifetime exchange and
> buyback promise.

| Button |
|---|
| `Book a visit` |
| `Talk to an expert` |
| `See new designs` |

*Footer:* `Reply STOP to stop these messages.`

### After one month

> Hi {{1}}, still thinking about that **{{2}}**?
>
> Whenever you're ready, we'll pick up right where we left off.
>
> **What would help most?**

| Button |
|---|
| `Find me a piece` |
| `Book a visit` |
| `Talk to an expert` |

*Footer:* `Reply STOP to stop these messages.`

> **Why only three options when you asked for five.** A template can carry at
> most three buttons. But the moment the customer taps one, the conversation
> opens and we can immediately send the full list — *Find a ring · Choose a
> diamond · Pricing · Showroom appointment · Expert consultation*. So nothing is
> lost; it just arrives one tap later.
>
> ⚠️ **Worth knowing before you approve these.** Both read as marketing rather
> than service messages, which means Meta charges for each one and reviews them
> more strictly. At your current volume — around 2,400 leads a month — two
> follow-ups each works out to roughly **4,800 paid messages a month**. Worth
> deciding whether both go to everyone, or only to people who showed real intent.

---

## Small things that matter

**If the customer types something unexpected** instead of tapping an option:

> Sorry, I didn't quite catch that. You can tap one of the options above — or if
> you'd rather just talk to someone, say **"call me"** and I'll connect you.

After two of those in a row, hand to a person rather than asking a third time.

**If they say stop, unsubscribe, or don't message me:**

> Understood — I won't message you again. If you ever change your mind, just
> message us here. 💎

Nothing further is sent, including follow-ups.

**Outside showroom hours,** the call-booking replies say *"first thing tomorrow"*
rather than promising a call at 11pm.

> ⚠️ **We need your showroom opening hours** to write that correctly.

---

## What we need from you to finish this

| # | Needed | Blocks |
|---|---|---|
| 1 | Which budget bands — the form's or these? | Q3 |
| 2 | Seven ring URLs — six shapes plus the full collection | rings branch |
| 3 | Showroom links per city, and which cities to list | decline path, follow-ups |
| 4 | Is **Hyderabad** a live showroom? | showroom list |
| 5 | Showroom opening hours | call booking |
| 6 | Flow 1 — firm price or indicative range? | flow 1 |
| 7 | Do follow-ups go to everyone, or only qualified leads? | cost |
| 8 | Your sign-off on the wording above | everything |
