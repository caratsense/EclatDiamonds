# Eclat / CaratSense — "Assay" Design System

> The single source of truth for how the product looks and behaves.
> Implemented in `frontend/src/app/globals.css` (tokens + signature), `layout.tsx` (fonts),
> and the shared primitives under `frontend/src/components/ui/*`.
> Rule: **derive every choice from fine jewellery + the shop-floor job. Never decorate.**

---

## Aesthetic direction (one line)

**Warm metal on linen.** A porcelain canvas, warm graphite ink, and *one* fine-gold accent
that behaves like light catching a polished bevel. Quiet and disciplined everywhere; the
gold appears only on the thing you should touch or read first.

What we deliberately rejected (the generic-admin tells the brief forbids):
- **Indigo/violet primary (`#4f46e5`)** — the default shadcn/SaaS "AI dashboard" colour. **Removed.**
- **Cool blue-black text** — replaced with warm graphite.
- **Single typeface for everything** — replaced with three faces, three jobs.
- No purple gradients, no cream + high-contrast-serif + terracotta cliché, no emoji.

---

## STEP 1 — Tokens

### Palette (the brand palette is 6; status adds 3 jewel tones)

| Token | Hex (light) | Hex (dark) | Where it's used |
|---|---|---|---|
| `--background` Porcelain | `#F6F4F0` | `#14120E` | App canvas. Carries a faint single-gold radial wash — never flat white. |
| `--foreground` Graphite | `#1A1816` | `#ECE7DD` | All primary text; ink primary-button fill. Warm, not blue-black. |
| `--card` Surface | `#FFFFFF` | `#1C1914` | Elevated cards — the "polished surface" that catches light. |
| `--primary` Ink | `#211E1A` | `#EBE6DC` | Primary action **fill**. Quiet — the gold light-catch marks it, not colour. |
| `--gold` Fine Gold | `#B08D3B` | `#C9A96A` | **THE accent.** Hero figure marker, gold CTA, selected/active, focus ring. |
| `--muted-foreground` Stone | `#6B655C` | `#A39A88` | Secondary text, labels, meta. |

Gold support tones (so gold is legible everywhere): `--gold-strong` `#8A6D2A` (text/links on
white, AA), `--gold-soft` `#EAD9B0` (hairlines/tints). Lines: `--border` `#E6E1D8` (linen).

**Status = real jewel tones, never generic:** `--destructive` Garnet `#B23B3B` ·
`--success` Emerald `#2F7D5B` · `--warning` Amber `#C8872B`. Rendered as soft tinted pills,
not heavy fills.

**Charts** are a jewel sequence — gold, graphite, emerald, garnet, sapphire `#3E5C76`, amber.
No indigo anywhere.

**Brand emerald (`--brand` `#0F2A1E`)** — Éclat Diamonds' signature deep forest green, lifted
from their site (eclatdiamonds.in). It dresses the *brand surfaces only*: the sidebar rail, the
sign-in panel, and the landing hero / stats band / footer (`.emerald-panel` = emerald + a gold
"sparkle" wash). Emerald + gold + cream is the house pairing; operational content stays porcelain
so data legibility never competes with the brand. The public landing page lives at `/` and the
split-screen sign-in at `/login`.

### Typography — three faces, three jobs

| Role | Face | Used for | Notes |
|---|---|---|---|
| Display | **Fraunces** (high-contrast serif, `wght` axis only) | Page titles — **words only, never digits** | The jewellery-house register. Rendered at **700 (bold)**. Its figures can be oldstyle (hanging) and bounce off the baseline, so **numeric heroes wear the mono readout (`.num`), not the serif** (a `.font-display` CSS rule forces `lining-nums` as a safety net). **History:** Fraunces → Cormorant Garamond (2026-07, "Fraunces's soft *wonk* read playful/AI-default") → Fraunces again (2026-07-29). Two reasons for the reversal: (1) headings were asked to be genuinely **bold**, and Cormorant is delicate by design — it stays wispy even at 700, which is the opposite of a bold heading; (2) the original objection was to Fraunces's `WONK` axis, and `next/font` loads only the `wght` axis by default, so `WONK` sits at 0 and the playful letterforms never appear. If the serif is revisited, judge it in the browser — **neither face was actually loading** when the earlier call was made (see below). |
| UI | **Hanken Grotesk** | All dense operational data, chrome, forms, body | Premium grotesk workhorse. Replaced Inter (2026-07): Inter is the generic-AI-dashboard tell. |
| Tabular | **IBM Plex Mono** (`.num`) | Weights, carats, prices, every numeric column | The "assay readout" — `tabular-nums lining-nums` so columns align like a scale. Replaced Geist Mono (Vercel default). |

**Scale** (line-height in parens): Hero figure 28 (1.0) Plex Mono 600 (`.num`) · H1 30 (1.1) Fraunces **700** ·
H2 22 (1.2) Fraunces **700** · Card title 18 (1.2) Hanken 600 · Body 14 (1.43) Hanken 400 ·
Body-strong 14 Hanken 600 · Meta 12.5 Hanken 500 stone · Overline 11 Hanken 600 uppercase +0.1em stone ·
Numeric 13 Plex Mono 500 tnum.

Only the display-face headings went to 700 (2026-07-29). Card titles stay at Hanken 600 and
every body/meta size is unchanged — the hierarchy is carried by the face change, not by
thickening everything.

> ### ⚠ The faces were not loading at all until 2026-07-29
> `app/layout.tsx` declared `const sans = { variable: "font-sans" }` — plain objects holding
> literal Tailwind class names. The three `next/font/google` imports were never called, so no
> `@font-face` was ever emitted. `globals.css` then defined the theme token as
> `--font-sans: var(--font-sans), …`, a **self-reference** that resolves to nothing and falls
> through to `ui-sans-serif, system-ui`. Net effect: the whole app rendered in the OS default
> (Segoe UI on Windows, San Francisco on macOS) and the serif fell back to Georgia — for every
> screenshot and every design judgement made in that window. Fixed by calling the loaders
> properly and giving them their own `--font-*-face` variable names, distinct from the theme
> tokens so the self-reference cannot recur. **Verify a font change in the browser**
> (`getComputedStyle(document.body).fontFamily` + `document.fonts`), never by reading the code.

### Spacing / radius / elevation

- **Spacing:** 4px base — `4 · 8 · 12 · 16 · 20 · 24 · 32 · 40 · 48 · 64`.
- **Radius:** restrained. `--radius: 10px`; sm 6 / md 8 / lg 10 / xl 14. Cards lg, inputs/buttons md, chips/pills full.
- **Elevation:** soft, warm, layered — shadow colour is warm ink `rgba(26,24,22,…)`, low alpha, wide
  negative spread. Two real steps: **rest** (`shadow-sm`) and **float/hover** (`shadow-md`). No heavy drops.

### Signature element — the "light-catch" (`.facet-top`)

**One** brand-defining detail: a 1px gold gradient hairline along the **top edge** of an element —
`transparent → champagne → transparent` — like light hitting the bevel of a polished gold surface.
It brightens on hover and stays lit when active/selected (`data-active` / `aria-selected`).

It marks — and *only* it marks — these, so there is never ambiguity about what's primary:
- the **primary (ink) button**,
- the **hero KPI tile** (always lit) and any focused/selected card,
- the **active nav item** (rendered as the vertical sibling: a gold left edge),
- **focus** (the ring is gold).

This is the only place we spend boldness. Everything else stays graphite + porcelain.

---

## STEP 2 — Self-critique (what I changed after re-reading)

1. **It still had two accents.** The old system kept indigo *and* gold — indigo is the exact
   generic-admin tell the brief bans. **Fixed:** indigo deleted from primary, accent, ring and
   charts. Now exactly one accent (gold); the primary button is ink and is identified by the
   signature, not a colour.
2. **It was Inter-only** (the old `--font-serif` even pointed back at Inter). That's what any
   admin app ships. **Fixed:** added a restrained serif display face (Fraunces) for titles +
   hero figures, and committed Geist Mono as the tabular face for weights/carats/prices — a
   jewellery-native "scale readout" no generic dashboard has.
3. **Cool neutrals read like software, not jewellery.** **Fixed:** warmed ink (`#1A1816`),
   canvas (porcelain), and shadow colour (warm). Feels like metal on linen.
4. **There was no named signature.** **Fixed:** the `.facet-top` light-catch is now the single
   memorable, reusable detail.

**Obvious to a non-technical shop-floor user?** Yes: the most important number is the biggest
thing on screen (display face) and wears the gold edge; the one action you take next is the one
gold button; status is plain-word jewel-tone chips. Distinctive *and* unmistakable.

---

## STEP 3 — Component library (all derived from the tokens)

- **Button** (`ui/button.tsx`): `default` = ink + `.facet-top` glint (most buttons) · `gold` =
  polished gold bar w/ ink engraving (the **one hero action per screen**) · `outline` · `secondary`
  · `ghost` · `link` (gold-strong) · `destructive` (garnet). Sizes sm/default/lg/icon; gold focus ring.
- **Badge / status chip** (`ui/badge.tsx`): full-radius soft tinted pills — `gold`, `success`,
  `warning`, `destructive`, `secondary`, `outline`.
- **Card** (`ui/card.tsx`): white surface, lg radius, `shadow-sm` at rest. Add `.facet-top` +
  `data-active` to promote a card to "selected/hero".
- **Stat tile** (`dashboards/kpi-card.tsx`): hero tile (index 0) = gold chip + always-lit
  light-catch + gold sheen; others quiet stone. Hero figure in display face; deltas = jewel pills.
- **Navigation:** web sidebar (deep ink rail, gold active edge) + (to add) mobile bottom nav,
  ≥44px targets, gold active.
- **Also in system / to standardise next:** inputs, selects, tabs, modals (Radix Dialog),
  toasts (sonner), filters, search, date/time pickers, ECharts theme (jewel sequence), tables
  (Geist Mono numeric columns, right-aligned).

### Roles — same system, different density & emphasis

| Role | Emphasis | Density |
|---|---|---|
| **Owner** | DSR / MIS / budget-vs-actual; the day's net number is the hero | Comfortable, chart-led |
| **Manager** | Store funnel, approvals, footfall→sale | Medium, table+chart |
| **Sales staff** | One action at a time (new lead, share quote, check-in); big tap targets | High-speed, mobile-first |
| **Customer view-only** | Read-only quote/scheme status, no chrome | Sparse, calm *(internal-only per OP-1; not a login today)* |

---

## STEP 4 — Apply to real screens

Proof screen applied now: **Owner Dashboard** (DSR KPIs → hero tile, jewel charts, display titles).
Remaining (to roll out on approval, with all states — empty / skeleton / error / success):
CRM pipeline, quotation builder + WhatsApp share, catalogue + AI image search, inventory
(dead-stock + reorder), mobile attendance + check-in + photo intake, finance, tickets.

### Quality floor (non-negotiable, baked into the system)
Hierarchy (hero figure + one gold action) · fast keyboard-friendly entry · ≥44px mobile targets ·
empty/loading/error/success states · WCAG AA contrast + visible gold focus · `prefers-reduced-motion`
honoured (global) · subtle purposeful motion only · plain-word microcopy ("Share quote", not "Submit").

---

## The one real risk I took, and why

**A serif display face (Fraunces) + gold in a jewellery product can drift toward
"wedding invitation."** I took it anyway because an all-sans, all-grey system is exactly the
generic look the brief forbids, and a restrained serif is what actually signals *fine jewellery*
(it's the register of the houses themselves). **Mitigation:** the serif is rationed to titles and
the single hero figure only; gold never becomes a fill or a background — it lives almost entirely
in the 1px light-catch and one button; all operational density stays sans + mono. If it ever reads
"invitation" instead of "instrument", the lever is one line in `globals.css` (`--font-display`).
