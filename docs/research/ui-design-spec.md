# Vireo UI: the design spec

*Generated with Gemini on 2026-09-15 from a written brief, then read back off the produced
image. Conversation: `gemini.google.com/app/409b9ea558f96879`. This is the visual direction for
the new interface — **not** the Claude-Code-style UI that OmniAgent and Vireo 1.2.x share.*

⚠️ **Image models garble small text.** The mockup renders one card title as *"champion aeview"*
and clips the search placeholder. Copy comes from this document and from
[cobi-source-of-truth.md](cobi-source-of-truth.md), never from reading the picture.

---

## Shell

A three-column desktop layout, no top chrome bar.

| Region | Width | Notes |
|---|---|---|
| Sidebar | ~200px fixed | wordmark, nav, pin toggle |
| Main | fluid | page heading, then content |
| Evidence rail | ~260px | context for the selected row |

## Colour

| Token | Value | Used for |
|---|---|---|
| `--bg` | `#0E0F11` | page ground |
| `--panel` | `#16181C` | cards, rails, sidebar active row |
| `--border` | 1px, `#24262B` | every edge; no drop shadows anywhere |
| `--text` | `#F2F3F5` | titles |
| `--muted` | `#8A8F98` | labels, column headers, secondary copy |
| `--accent` | green | severity bar, logo, primary button, *nothing else* |
| `--warn` | amber | "Waiting" pill |
| `--danger` | red/orange | negative numbers inside chips only |

Radius 10px. Type is Inter-like. Whitespace is generous; density comes from small type, not from
tight packing.

## Sidebar

Green `V` wordmark, "Vireo", and a pin icon at the far right. Then icon+label rows:

**Today · Decisions · Customers · Ask · Segments · Data · Settings**

The active row is a filled `--panel` rounded rectangle spanning the sidebar width. Inactive rows
are transparent with `--muted` text.

## Main column

Heading `Today` (~28px, semibold) with the subtitle *"6 decisions need you this week"* in
`--muted` directly beneath.

Above the list sits a **column header row** in small caps `--muted`:
`DECISION CARDS` on the left, then `Owner`, `Due-date`, `Status` right-aligned over their
columns. This is the detail that makes the list read as a table of records rather than a feed of
notifications — worth keeping.

### The decision card

The core object. Left to right:

1. A **severity bar** — 3px, full card height, rounded, `--accent`.
2. **Title**, bold white, one line: `Northwind: churn risk`.
3. **Evidence chips** beneath the title — small bordered pills, e.g. `usage -38%`
   (with `-38%` in `--danger`), `champion inactive 21d`, `2 open tickets`.
4. **Owner** — a small round avatar.
5. **Due-date pill** — bordered, muted, e.g. `Due-date 20`.
6. **Status pill** — filled. Green `Accepted`, amber `Waiting`. (Also needed: `New`,
   `In progress`, `Overdue`, `Snoozed`, `Resolved`, `Dismissed` — the engine's real states.)

## Evidence rail

Labelled `EVIDENCE`. Contains, top to bottom:

1. **The dot-grid unit chart** — the single best idea taken from Cobi, captioned
   *"one dot, one person"*. Filled dots for the affected group, hollow outlined dots for the
   rest. The mockup shows roughly 36 filled against 84 hollow.
2. A **sparkline** — thin, unfilled, no axes.
3. **"why this matters"** — a short paragraph.

## What the mockup does not settle

Honest gaps, to be designed rather than invented from the picture:

- Light theme. Only dark was generated.
- Empty, loading and error states.
- Every screen other than Today.
- Focus rings, hover states, keyboard navigation.
- Responsive behaviour below ~1100px.
