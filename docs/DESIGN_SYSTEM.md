# Design system

One system for the extension (popup, dashboard, settings, admin console) and Watch Ledger (the server's web dashboard).

**Source of truth: `lib/theme.css`.** `server/scripts/sync-shared.js` copies it, `lib/icons.js`, `lib/charts.js` and `lib/fonts/*` into `server/web/vendor/`. Edit the `lib/` copy, then run `node server/scripts/sync-shared.js` (a server test fails if the copies drift).

Page frames are separate because they differ: `lib/shell.css` (extension: top bar + tabs) and `server/web/styles.css` (Watch Ledger: sidebar / drawer, lanes, device cards, sign-in). Both only add layout; every colour, size and component comes from `theme.css`.

No inline styles anywhere (the server CSP is `default-src 'self'`). Fonts and icons are local files.

## Direction

A ledger: a private account book for watch time. Figures are set in tabular numerals; lists read like account lines (`name ······ 2h 14m`, dotted leader); the only double rule is under a total. Verdigris accent on cool "mist" neutrals. Restraint: one accent, hairlines instead of shadows, shadow only on toast and drawer.

## Colour

Light and dark are designed separately (dark is not an inversion: its greys are green-tinted ink, the accent is lifted for contrast, soft fills are darkened). Theme is `data-theme="light|dark"` on `<html>`, set before first paint by `lib/theme-init.js`.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#f1f4f3` | `#0b1110` | page |
| `--surface` | `#ffffff` | `#121a19` | cards, inputs, sidebar |
| `--sunken` | `#e8edeb` | `#0e1514` | table header, wells, hover |
| `--line` / `--line-strong` | `#dbe1df` / `#c3ccc9` | `#1f2d2b` / `#2e403d` | hairlines / control borders |
| `--text` / `--text-2` / `--text-3` | `#0e1615` / `#44524f` / `#5c6a67` | `#e6eeec` / `#a9b8b5` / `#82938f` | primary / secondary / captions (all ≥ 4.5:1 on `--surface`) |
| `--accent` (+ `-hover`, `-soft`, `-ink`) | `#0a6b62` | `#4dc2b1` | actions, active nav, lead figure |
| `--danger` `--ok` `--warn` (+ `-soft`) | red / green / amber | lifted equivalents | status, destructive |
| `--dc0`…`--dc5` | teal, vermilion, violet, ochre, magenta, blue | lighter variants | per-device series (also `.dc0`…`.dc5` classes) |

## Type

Two self-hosted variable fonts (OFL, licences in `lib/fonts/`): **Bricolage Grotesque** (display: headings, figures, brand) and **Geist** (text). Metric-matched fallback faces (`Geist Fallback`, `Bricolage Fallback`) avoid layout shift; pages preload both files.

| Role | Token | Size / weight |
|---|---|---|
| Figure | `--fs-figure` | 32 (28 on phones) / 600, display, `.stat .v` |
| H1 | `--fs-headline` | 28 (24 on phones) / 600, display, −0.02em |
| H2 | `--fs-title` | 20 / 600, display |
| H3 (card title) | `--fs-lead` | 16 / 600, display |
| Body | `--fs-body` | 14 / 400, line-height 1.55 |
| Small (tables, kv) | `--fs-small` | 13 |
| Caption (`.caption`, `.small`) | `--fs-caption` | 12 |
| Eyebrow (`.eyebrow`, `.stat .k`, `th`) | — | 11 / 600, uppercase, +0.08em |

Numbers: `.num` (tabular, lining). Codes and IDs: `.mono` / `code`.

## Space, shape, targets

Spacing `--s-1…--s-7` = 4 / 8 / 12 / 16 / 24 / 32 / 48. Radii `--r-sm 6`, `--r-md 8`, `--r-lg 12`, `--r-pill`. Controls are 36px high on pointer devices and **44px** (`--tap`) below 640px or with a coarse pointer. Cards pad 16px, 24px from 768px.

## Components (all in `theme.css`)

- **Buttons** `.btn` (secondary), `.btn-accent` (primary), `.btn-danger`, `.btn-ghost`, `.btn-sm`, `.btn-icon`, `.btn-block`; `:disabled` and `[aria-busy="true"]` are styled.
- **Fields** `.field` (label + control + `.hint`), `.input` (also `select.input`, dates), `.check`, `.switch` (`input` + `.slider`).
- **Card** `.card`, `.card.flush` (for tables), `.card-head`, `.card.danger-zone`.
- **Stats** `.stat` (`.k` label, `.v` figure, `.s` sub) inside `.statbar` (hairline-divided cells that reflow 4 → 2 → 1).
- **Ledger list** `<ul class="ledger"><li><span class="name"> <span class="lead"> <span class="amt">`; `li.total` for the double rule.
- **Table** `.table`; add `.rtable` and `data-label="…"` on each `td` (and `data-primary` on the title cell) so rows become labelled cards under 720px. Never wrap tables in a horizontal scroller.
- **Status** `.pill` (+ `.on .warn .bad .info`, with a `.dot`), `.badge` (count), `.chip` (Watch Ledger device chip).
- **Alert** `.alert` (+ `.warn .bad`); `.sync-note` / `.sync-warn` are aliases. `.note` / `.lock-note` for quiet asides.
- **States** `.empty` (icon + `h3` + text + action; `.bad` for errors), `.skel` skeletons (`h-title h-card h-block`), `.toast` (live region, `role="status"`).
- **Layout** `.stack`, `.stack-sm`, `.row` (`.between`), `.grid` + `.g2` / `.g4` (use `minmax(min(100%, X), 1fr)`, so they never overflow), `.page-head`, `.lede`, `.kv` / `.kv-grid` (two columns, stacked under 560px), `.tabs` (segmented control), `.brand` + `.mark`.
- **Chart** `YTCharts.barChart(el, data, fmt)`: SVG bars stretch; the axis is HTML so labels never shrink. Watch Ledger lanes use the same idea.
- **Icons** `lib/icons.js` (Lucide, ISC): `YTIcons.icon("name")` returns inline SVG; `<span data-icon="name">` is filled automatically. To add one, add its name to the list used to generate the file (copy the inner markup from lucide-static) and keep this the only icon set.

## Breakpoints

| Width | Behaviour |
|---|---|
| < 560 | `.kv` stacks; extension nav shows icons only; lane labels sit above bars |
| < 640 | 44px controls, 24px h1, single-column forms and cards |
| < 720 | `.rtable` rows become cards |
| < 768 | cards pad 16 (≥ 768: 24); tablet nav gets 44px targets |
| < 960 | Watch Ledger sidebar becomes a top bar + slide-over drawer (Esc, scrim and link choice close it; focus is trapped while open) |
| ≥ 960 | fixed 248px sidebar; extension dashboard goes two-column |

## Writing a new page

1. Load `theme.css` (and `shell.css` in the extension), `icons.js`, preload both fonts.
2. Build with `.page-head` → `.statbar` / `.card` / `.grid`; put tables in `.card.flush` with `.table.rtable` + `data-label`s.
3. Give every async region a skeleton, an `.empty` state and an error `.empty.bad`.
4. Check at 320, 375, 768, 1024, 1440 in both themes: no horizontal scroll, 44px targets under 640px.
