# Countertop — design system brief

**For:** a Claude Code session (several, actually — see *Sequencing*) building
Countertop a real design system.
**Status:** brief. Nothing here is built yet.
**Read first:** `CLAUDE.md` (the invariants), `docs/WRITEUP.md` → *The Screens*.

---

## 1. What this is

Countertop is pickup-only online ordering for a fast-casual restaurant. It has
thirteen screens across two audiences that could not be less alike, and it has
no design system — every screen writes its own Tailwind utilities from
scratch. The visual language that emerged is more coherent than that has any
right to be (see the census in §3), which means the job is mostly
**extraction and naming**, not invention.

The goal is not "make it pretty." The goal is: **the next screen should be
impossible to build inconsistently, and the accessibility floor should be
structural rather than remembered.** Three separate defects in this project's
history were a `<Link>` that nobody had measured. A design system where the
back-link primitive is 48px by construction is the fix that ends that class.

---

## 2. The two audiences, which need different design

This is the single most important thing in this brief. Do not build one
neutral system and apply it twice.

### The customer — a phone, one hand, deciding whether to order here

`/`, `/menu`, `/menu/[itemId]`, `/cart`, `/checkout`, `/status/[token]`

They are choosing food. The screen has to make food look worth buying and make
the composition step (which is genuinely fiddly — required groups, min/max,
intensity, negations) feel effortless. This surface is currently the **least
designed** in the product and is the only place where someone decides whether
to be a customer at all. Warmth, appetite, generous spacing, real hierarchy.

### The kitchen — a wall-mounted tablet, arm's length, greasy gloves, a rush

`/kitchen`, `/kitchen/availability`, `/kitchen/menu`, `/kitchen/settings`,
`/kitchen/report`, `/kitchen/orders`, `/kitchen/orders/[id]`, `/kitchen/login`

They are not browsing. They are reading a ticket at two feet under bad light
while holding a hot pan, and a misread is a wrong bag going to a customer with
an allergy. This surface should look like **industrial equipment**: high
contrast, heavy borders, big type, no decoration that costs a millimetre of
legibility. It is allowed to be ugly if ugly is faster to read. It is not
allowed to be quiet.

The two share tokens (spacing, radius, the type ramp's underlying scale) and
diverge in density, weight and colour temperature. Design the divergence
deliberately — do not let it be an accident of which screen got written first.

---

## 3. What exists today — measured, not remembered

Run these yourself before designing; the numbers below are from 2026-09-01.

**Stack.** Next.js 16 App Router, React 19, **Tailwind v4 CSS-first** —
`apps/web/app/globals.css` is just `@import "tailwindcss"` plus one keyframe.
There is **no `tailwind.config.*`**, and `apps/web/package.json` has exactly
three runtime dependencies: `next`, `react`, `react-dom`. No shadcn, no Radix,
no CVA, no `clsx`, no icon library, no webfont. Despite CLAUDE.md naming
shadcn in the stack, it was never installed.

**No shared components exist.** Not one. There is no `components/` directory
and no `packages/ui`. `apps/web/lib/` holds formatters and labels only
(`money.ts`, `status-labels.ts`, `menu-labels.ts`, `format-time.ts`). Every
button, card, table and stat tile is inlined at its call site — the report
page alone privately re-declares `Stat`, `Section` and `Table`.

**Colour census** (occurrences across `apps/web/app/**/*.tsx`):

| Family | Use | Counts |
|---|---|---|
| `neutral` | everything structural | `text-700` ×31, `border-300` ×29, `border-400` ×28, `text-600` ×20, `bg-900` ×13 |
| `red` | destructive, refusals, **and the negation badge** | `text-700` ×22, `bg-50` ×8, `bg-700` ×5 |
| `amber` | warnings, staff notes, "needs attention" | `bg-50` ×10, `text-900` ×8, `border-600` ×7 |
| `sky` | "new / unacknowledged" | `border-700` ×6, `text-900` ×5, `bg-50` ×5 |
| `green` | paid, confirmed, healthy | `text-900` ×4, `bg-800` ×4, `bg-50` ×4 |

Five semantic roles already exist and are used consistently. **Name them; do
not re-pick them.**

**Type census:** `text-lg` ×102 (the workhorse — 18px, which is the kitchen
floor), `text-sm` ×52, `text-3xl` ×22, `text-xl` ×16, `text-2xl` ×11,
`text-base` ×8. Weights: `font-semibold` ×78, `font-medium` ×39,
`font-bold` ×37. Only 3 uses of `font-normal` — the product is *bold by
default*, which is correct for the kitchen and probably too heavy for the
customer.

**Shape census:** `rounded-lg` ×76 (with 8 `rounded-xl`, 8 `rounded-md` —
noise to collapse), `min-h-12` ×66, `min-h-14` ×14, `min-w-12` ×6.

**One animation exists** and is deliberate: `.alert-pulse` in `globals.css`,
1.2s per cycle (under the WCAG 2.3.1 three-flashes-a-second threshold), with a
`prefers-reduced-motion` kill switch, and it is explicitly never the sole
carrier of meaning. Treat it as the model for any motion you add.

Regenerate the census:

```bash
grep -rhoE "\b(bg|text|border)-(neutral|red|amber|sky|green)-[0-9]{2,3}\b" apps/web/app --include="*.tsx" | sort | uniq -c | sort -rn
grep -rhoE "\btext-(xs|sm|base|lg|xl|2xl|3xl)\b" apps/web/app --include="*.tsx" | sort | uniq -c | sort -rn
```

---

## 4. Non-negotiables

These are enforced by tests. A redesign that breaks one fails `npm run gate`,
and that is the intended behaviour — do not weaken the test to fit the design.

1. **Every interactive control on a staff screen is ≥48px in BOTH dimensions.**
   Buttons, `summary` elements, inputs, and `<a>`/`<Link>`. The width half is
   not optional: a 48px-tall link 35px wide is a 35px-wide target, and that
   exact miss has shipped three times. `apps/web/e2e/kitchen.spec.ts:57` and
   `:100`.
2. **The advance button is the largest control on a kitchen card.** Strictly
   larger than every sibling, asserted numerically. It is the tap that happens
   a hundred times a shift.
3. **Kitchen item lines render at ≥18px computed.** Asserted via
   `getComputedStyle`. `text-lg` is the floor, not the body default.
4. **The negation is visually unmistakable and never styled like an addition.**
   Today: `bg-red-700 px-1 font-bold uppercase text-white` inline in the
   ticket, from `describeSelection()` which returns `{ text, negated }` —
   flagged, deliberately not pre-styled, because the cart and the ticket
   emphasise it differently. **"NO ONIONS" must not become a grey chip in any
   redesign.** All three independent evaluators named this treatment as the
   best thing in the product. It is the bug the product exists to kill.
5. **Zero axe violations** at `wcag2a, wcag2aa, wcag21a, wcag21aa` on every
   route. There are already ~10 axe assertions in the e2e suite.
6. **No horizontal page scroll at 390px.** Wide content scrolls inside its own
   `overflow-x-auto` container, and that container is focusable and labelled
   (`tabIndex={0} role="region" aria-label=…`) — a region that scrolls only by
   dragging is a region a keyboard cannot reach. This was an axe finding once
   already.
7. **Colour is never the only signal.** The unacknowledged-order alert is
   colour + badge + pulse; the pulse alone disappears under reduced motion.
   Keep that discipline for every state you introduce.
8. **Money is `tabular-nums`, always.** Ragged digit columns in a price list
   are a legibility bug, not a taste question.
9. **Never show a time estimate while ordering is paused**, and show ranges,
   not points. A precise wrong number is worse than an honest range. This is a
   content rule the design must not "improve" into a single number.

---

## 5. What to build

### 5.1 The token layer — `@theme`, not a config file

Tailwind v4 is CSS-first. Tokens go in `apps/web/app/globals.css` inside
`@theme { … }`, which generates the utilities. **Do not add a
`tailwind.config.ts`** to hold tokens; that is the v3 shape and would put the
source of truth in two places.

Two tiers, and keep them separate:

- **Primitives** — the raw ramp (`--color-ink-900`, `--color-surface-50`, …).
  Nobody outside the theme file uses these directly.
- **Semantic** — what screens actually reference (`--color-danger`,
  `--color-attention`, `--color-fresh`, `--color-settled`, `--color-hairline`).
  Map them onto the five roles the census already found.

Starting point, to be argued with rather than pasted:

```css
@theme {
  /* Roles, named for what they MEAN. The census found these five already in
     use and consistent; this names them rather than re-picking them. */
  --color-danger: var(--color-red-700);      /* refusals, destructive, NEGATION */
  --color-attention: var(--color-amber-500); /* warnings, staff notes, unpaid */
  --color-fresh: var(--color-sky-700);       /* new / unacknowledged */
  --color-settled: var(--color-green-800);   /* paid, confirmed, healthy */
  --color-hairline: var(--color-neutral-300);

  /* The kitchen floor is 18px. Name it so nobody has to remember. */
  --text-ticket: 1.125rem;
  --text-ticket--line-height: 1.6;

  /* The tap-target floor, in one place, so a primitive cannot forget it. */
  --spacing-tap: 3rem; /* 48px */
}
```

Also settle, with a written reason each: **one radius** (collapse
`rounded-md`/`lg`/`xl` to a scale of two), **one elevation model** (this
product uses borders, not shadows — say so and stick to it), and a
**typeface**. Today there is no webfont at all. If you add one, use
`next/font` (self-hosted, no layout shift), pick something with true tabular
figures and a tall x-height at 18px, and give it a real fallback stack.

### 5.2 The primitives

Build these as plain React components in `apps/web/components/`. Roughly:

`Button` (variants: advance / primary / secondary / danger / ghost; sizes with
the 48px floor built in, and an `xl` the kitchen advance uses) · `BackLink`
(the 48×48 fix, applied once) · `Card` · `Stat` · `DataTable` (with the
focusable labelled scroll container baked in) · `Badge` (the five semantic
roles, including the negation, which is a badge with a promise attached) ·
`Field` (label + input + error + description, wired for `aria-describedby`) ·
`Callout` (the amber/red/sky notice blocks) · `Money` (tabular-nums + cents
formatting, wrapping `lib/money.ts`).

Extract from the real call sites — start with `kitchen/report/page.tsx`'s
private `Stat`/`Section`/`Table`, which are already the right shape.

### 5.3 A living pattern page

A route (staff-side, e.g. `/kitchen/design`) rendering every token, primitive,
state and the two density modes side by side, built from the real components.
Not Storybook — that is a second build pipeline for a thirteen-screen app.
Include the axe assertion for it in the e2e suite, so the pattern page is also
a test.

---

## 6. Direction, so you are not starting from a blank page

The restaurant is "Firebird Kitchen" — fast-casual, burritos and bowls. The
system should read as **a well-run counter**: confident, warm on the customer
side, unglamorous and legible on the staff side. Reference points worth
looking at: printed kitchen tickets, airport departure boards, and a good
diner menu board. Not: a SaaS dashboard, not a delivery-app marketplace.

**Have an opinion and record it.** Some calls I would make, each reversible:

- **Do not install shadcn/ui.** Thirteen screens, three runtime dependencies,
  and nine primitives. shadcn brings Radix + CVA + `clsx` + `tailwind-merge`
  and a `components/ui/` directory mostly unused. Build the nine.
  *Trigger to revisit:* the first component needing real focus-trapping — a
  modal dialog, a combobox, a date-range picker. Do not hand-roll those.
- **Light mode only, tokens ready for dark.** A wall tablet under kitchen
  lights wants maximum contrast, not a dark theme; and no evaluator asked for
  one. Define every colour as a semantic token so dark is later a token swap,
  not a rewrite. *Trigger:* a real complaint from a real screen.
- **Borders, not shadows.** The census says the product already decided this.
  Making it explicit stops a mixed-metaphor drift.
- **Keep the negation exactly as loud as it is.** If anything, the customer
  side should borrow more of the kitchen's emphasis, not the other way round.

---

## 7. Sequencing

One item per session, the repo's standing rule (`CLAUDE.md` → *How to work in
this repo*). Each ends with `npm run gate`, a PROGRESS entry, a RELEASE_NOTES
entry, and the commit-then-SHA-commit-then-one-push dance. Suggested split:

| Item | Scope |
|---|---|
| **C-0A** | Token layer only. `@theme` primitives + semantics, radius and elevation decided, typeface chosen and wired via `next/font`. **No screen changes** — prove it by shipping with the gate green and zero visual diff. |
| **C-0B** | Primitives: `Button`, `BackLink`, `Card`, `Badge`, `Money`. Migrate the kitchen queue onto them; the 48px and 18px assertions must pass unchanged. |
| **C-0C** | Primitives: `Field`, `Callout`, `DataTable`, `Stat`. Migrate the report and settings screens. |
| **C-0D** | The pattern page at `/kitchen/design`, with its axe test. |
| **C-0E** | The customer surface redesign proper — `/menu`, `/menu/[itemId]`, `/cart`, `/checkout`. This is where actual design work happens rather than extraction, and it overlaps `docs/prds/prd-the-customer-who-is-not-in-the-room.md`; read that PRD first and do not duplicate its requirements. |
| **C-0F** | Regenerate `docs/screenshots/` (14 captures, `SCREENSHOTS=1`) and rebuild the portfolio page. |

**C-0A through C-0D are refactors and should be provably invisible.** If the
gate needs editing to accommodate them, that is a signal the refactor changed
behaviour, not a signal the test is stale.

---

## 8. How to verify

```bash
npm run gate     # lint && typecheck && test && build:test && test:e2e
```

Read the e2e summary, not the tail: `passed + skipped + flaky` must reconcile
against `npx playwright test --list`'s total (134 as of 2026-09-01). Plus:

- Every axe assertion still green, and the pattern page has its own.
- The three numeric assertions in `kitchen.spec.ts` (48px both dimensions,
  advance-is-largest, 18px ticket lines) pass **without modification**.
- Screenshot the running app at 390px and at 1280px and look at it. The suite
  cannot tell you whether the food looks good.

---

## 9. Non-goals

- **No component library dependency** unless the focus-trap trigger in §6 fires.
- **No Storybook.** The pattern page is the artefact.
- **No animation beyond the existing alert pulse** without a reduced-motion
  path and a non-motion carrier for the same meaning.
- **No dark mode** in this pass.
- **No copy rewrites.** The product's wording is load-bearing in several places
  ("NO onions", the range-not-point estimate, the refusal messages naming both
  states). Content changes are a separate item with a separate review.
- **Do not touch `packages/core` or `packages/db`.** This is presentation. If a
  design need seems to require a domain change, stop and write it down instead.
