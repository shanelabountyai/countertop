# Firebird Kitchen — brand assets

## What is here

- **`Firebird Logo Set.dc.html`** — the logo set, imported 2026-09-01 from the
  Claude Design canvas project `1100e5a0-ef3d-4208-80ea-df33bbd8e5e8`. It is a
  Design Component file: plain HTML, so it opens in a browser and reads in an
  editor without any tooling.
- This file — the same spec as **values you can grep**, because a design nobody
  can search is a design somebody re-invents.

`support.js`, which the `.dc.html` references in its `<head>`, is deliberately
**not** committed. It is ~70 KB of generated Design Components runtime
("GENERATED … do not edit"), it is the canvas editor's concern rather than this
product's, and nothing in it is brand information. The `<script src>` line is
left in place because the canvas replaces it at render time; opening the file
locally without it simply shows the unstyled markup.

**Re-fetching:** `DesignSync` with `method: "get_file"`, that project id, and
the path `Firebird Logo Set.dc.html`. It needs design authorization on the
machine — `/design-login` once, from an interactive session.

## The system

**Type.** Two faces, and the split is load-bearing:

| Face | Weights | Used for |
|---|---|---|
| **Zilla Slab** | 500, 600, 700 | the wordmark and display copy |
| **Archivo** | 400–900 | everything else — UI, labels, body |

*The wordmark is never set in the UI sans.* That is one of the four explicit
don'ts.

**Colour.** Four colourways and no others.

| Token | Hex | Role |
|---|---|---|
| brand red | `#b91c1c` | the mark, the negation chip, accents |
| ink | `#14100e` | body text, the mark's base bar |
| border black | `#0a0a0a` | the 3px rules the whole sheet is built from |
| paper | `#FAF7F2` | warm off-white surface |
| canvas | `#E9E5DF` | the sheet's own background |
| stone | `#57534e` `#44403c` `#78716c` `#a8a29e` `#d6d3d1` | secondary text, hairlines |

The four permitted colourways: **full colour**, **one-colour black** (this is
the ticket-printer version), **reversed** (white on ink), and **on danger red**.

**The mark.** A square, a white flame triangle, a dark bar across the base. Not
an illustration — the sheet's own words: *"a counter stamp … it has to survive a
32px favicon and a thermal ticket printer."* Drawn with CSS borders in the
source; **redraw it as inline SVG** when implementing, so it scales and
recolours.

**Lockups.** Horizontal primary (menu boards, site header, receipts) · stacked
(bags, cups, signage) · monogram, **square only, never in a circle** · a round
counter stamp for sealing a bag.

**Sizing rules that change what you build:**

- **Below 48px the flame drops out and only the F survives.** So 128 and 64 are
  the full mark; 32 and 16 — every favicon — are the monogram F on red.
- Clear space on every side equals the height of the mark.
- Minimum width of the horizontal lockup is 120px. Below that, use the monogram.

**The four don'ts:** no circle · never the wordmark in the UI sans · no
recolouring outside the four colourways · no stretch, skew or shadow.

## What implements this (C-087)

The spec above is no longer only a spec. Where each rule now lives:

| Rule | Where it is enforced |
|---|---|
| The two faces, and the wordmark never in the UI sans | `apps/web/app/layout.tsx` loads both; `apps/web/app/globals.css` wires `--font-sans` (Archivo) and `--font-display` (Zilla Slab) |
| The palette | `@theme` tokens in `globals.css`. The stone ramp is Tailwind's own and is **not** redefined |
| The mark, the four colourways, the 48px flame floor | `apps/web/lib/brand.tsx` — `Mark`, `COLOURWAYS`, `FLAME_MIN_PX` |
| The horizontal lockup | `Lockup` in the same file; used by `/menu`'s `<h1>` |
| The monogram at favicon sizes | `apps/web/app/icon.svg` |
| That any of it still renders | `apps/web/e2e/brand.spec.ts` |

**Not built:** the stacked lockup, the counter stamp, and anything on the staff
screens — including the sheet's own kitchen-header example. C-087 was scoped to
assets rather than a redesign; see `docs/PROGRESS.md`.

## Two things worth noticing before implementing

**The brand and the founding invariant already agree.** The sheet's own
"printed ticket" example renders `NO ONIONS` as white-on-red — which is what
`apps/web/app/kitchen/page.tsx` already does, and what all three second-pass
evaluators named as the best thing in the product. The brand does not ask for
that to be softened, and `CLAUDE.md` forbids softening it. Nothing to
reconcile; worth stating so nobody "harmonises" it later.

**This is not a design system.** It is a logo set — marks, colourways and
usage rules. The type ramp, spacing scale, component anatomy and the rest live
in [`../DESIGN_BRIEF.md`](../DESIGN_BRIEF.md), which is unbuilt. The two
overlap only in the palette and the two faces, and this file is the authority
for those.
