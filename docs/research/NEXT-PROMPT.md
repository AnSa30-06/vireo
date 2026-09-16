# The prompt to paste into /goal or /loop

Everything below the line is one self-contained instruction. It assumes no memory of the
session that produced it.

---

Work in `D:\to-drive\complisutra desktop\ledgerline-build` (a git worktree on branch
`decisions-mvp`). Do not stop until the Definition of done is met.

**Read these three files FIRST. They are the specification and they outrank your own judgement
about what to build:**

1. `docs/research/cobi-source-of-truth.md` — what Cobi actually ships, scraped from all 66 pages
   of their docs. The features to clone, the weaknesses to fix, and an explicit list of what is
   NOT known so you do not invent it.
2. `docs/research/ui-design-spec.md` — the visual direction, generated with Gemini.
3. `docs/sharing.md` — how a build reaches someone else.

## What is already done — do not redo it

- **Ledgerline is self-contained.** The OmniAgent component-sharing was deleted.
  `tests/unit/self-contained.test.mjs` fails if it comes back. The two apps must never interact.
- **The decisions engine has one clock** (`nowIso(db)` in `src/decisions/db.mjs`). Every
  timestamp goes through it. `tests/unit/decisions-clock.test.mjs` pins it.
- **The research and design documents above exist.**
- **A new UI is being built at `src/ui/public/v2/`** — shell, tokens, and page modules, each an
  ES module exporting `render(root, ctx)`. Check what is there before writing anything.

## What is left

1. **Finish the v2 UI.** Every page reachable, every state (loading, empty, error) real, every
   number traceable to the API. Fix whatever the adversarial reviews flagged.
2. **Wire the missing backend routes.** Some pages were built against clearly-marked "not wired
   yet" stubs because the route did not exist — `ask` and `segments` especially. Find every stub,
   write the route in `src/decisions/routes.mjs`, and remove the stub.
3. **New tools, as requested:**
   - **Better drag and drop** — multi-file, folder drop, a real dragover state, keyboard-accessible,
     and a clear message on a wrong file type.
   - **Better spreadsheet reading** — multi-sheet XLSX, merged cells, header detection that
     survives a title row above the headers, type inference, and a readable report of what was
     skipped and why.
4. **Clone Cobi's feature surface** (section 2 of the source-of-truth document): saved metrics,
   saved charts, dashboards, Stories with scheduling and PDF export, segments with AI-assisted
   criteria, an embeddable chat widget with data scopes, and CSV/database connectors.
5. **Make 5 to 10 improvements over Cobi.** Section 6.3 of the source document lists the
   candidates. The strongest are: evidence behind every number, deterministic thresholds computed
   in code rather than by a model, decisions as owned objects with a status and an outcome,
   structured business definitions instead of one prose blob, an explicit "I cannot answer that",
   and one-click correction from a wrong answer.

## Hard constraints — these are not negotiable

- **`AnSa30-06/omni-agent` main must stay untouched, and PR #1 there must stay OPEN and UNMERGED.**
  Push omni-agent work to its own branch only.
- **Ledgerline's repo is PUBLIC.** No API key may ever enter git. A provider key travels only inside a
  build artifact, via `node bin/ledgerline.mjs bundle-key mistral <key>`. `npm run scan:secrets` must
  pass before every push.
- **Never re-introduce component sharing with OmniAgent.** Re-downloading 45 GB is acceptable;
  reading another program's install is not.
- **Builds must run in the FOREGROUND.** Quick Heal kills backgrounded installer builds silently,
  and has previously deleted files out of `node_modules` mid-build. `npm run build:installer`
  takes about 12 minutes; the portable zip about 4.
- **Use PowerShell for release mechanics.** Git Bash dies here with cygwin `Win32 error 299`, and
  `npm version` cannot find its Node install.
- **Do not chain off `Node.append()`** — it returns undefined and has already shipped a broken page.
- **Check remote tags with `git ls-remote --tags fork`**, never local ones. A local tag has already
  pointed at the wrong commit and caused a wrong diagnosis.

## Definition of done — verify each, do not assert it

- `npm test` passes, and the new tests fail when the thing they cover is reverted. **A test that
  has never been seen to fail is not evidence.**
- Every page loads with no console error, on a fresh workspace and on the demo company.
- No page renders `undefined`, a hard-coded count, or fabricated sample data.
- The app starts with no internet and with no model configured.
- A released installer's published SHA-256 matches the local build, checked by downloading it back.
- `docs/` describes what the code now does, including anything removed.

Write a dev-log to `D:\to-drive\complisutra desktop\brain\dev-log\<slug>.md` before finishing.
