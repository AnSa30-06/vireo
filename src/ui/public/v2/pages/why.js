// Why this exists — the product explained to somebody who has never seen it.
//
// 🔴 THIS IS A SCREEN AND NOT A SLIDE FOR ONE REASON: the paragraph that says what the
// product does is followed by the REAL numbers of the workspace that is open. A slide
// claims; this quotes. Every figure in the live strip comes from decisionsStatus and
// decisionsOverview, and when there is nothing loaded the strip says exactly that and
// points at Data. A zero is never dressed up as a result, and a count that could not be
// read says "Unknown" rather than borrowing the look of one — see liveTiles below.
//
// The static half of the page is the argument from docs/pitch/why-not-chatgpt.md. The
// benchmark percentages are quoted from that file and nowhere else — do not round them,
// do not add one that is not in it, and do not delete the limits section. An investor
// trusts a page that admits its edges more than one that sweeps.
//
// ⚠️ The numbers are SECOND-HAND at the decimal place (the pitch file says so in its own
// warning). The page therefore names the paper beside every figure, so a reader who wants
// to check can. Never print a percentage here without its source next to it.
//
// Nothing is built with innerHTML. Colour comes only from tokens.css classes — the bars
// are .sev-bar, which already carries --accent and --danger; the rules at the bottom of
// this file set geometry and type only.

export const title = "Why this exists";

/* ── tiny DOM helpers ───────────────────────────────────────────────────── */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function button(label, cls, onClick) {
  const b = el("button", `btn ${cls ?? ""}`, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

function para(parent, text) {
  parent.append(el("p", "wy-p", text));
}

/* ── the measured case ──────────────────────────────────────────────────────
 *
 * Quoted from docs/pitch/why-not-chatgpt.md. `tone` picks a tokens.css severity
 * class, so the colour is the design system's and not this file's: "accent" is
 * the score a business could work with, "high" is the score that collapses.
 */

// ⚠️ TWO CORRECTIONS THE PITCH FILE MADE ON 17 SEP 2026, both of which an investor
// could have caught, and both of which are encoded below rather than left to memory:
//   · The TableBench figures are OVERALL SCORES from the Direct Prompting column of
//     Table 4. They are not "accuracy" and they do not carry a % sign. `unit` is "".
//   · The 2026 benchmark leads. "ChatGPT is right 42% of the time" is a 2024 model and
//     is easy to knock down; 82% from a 2026 frontier model is the frightening number,
//     because it is high enough to trust and wrong often enough to hurt.
export const BENCHMARKS = [
  {
    id: "sheets",
    heading: "2026 models on real financial spreadsheets",
    source: "FinSheet-Bench — ten configurations including GPT-5.2, Gemini 3.1 Pro and Claude Opus 4.6, on private-equity fund templates · arXiv:2603.07316, March 2026",
    unit: "%",
    scale: "accuracy",
    lead: "The best model overall, Gemini 3.1 Pro, scores 82.4% — about one error in every six questions. Then it comes apart by task.",
    rows: [
      { label: "Simple lookup", pct: 89.1, tone: "accent" },
      { label: "Lookup, best three models", pct: 93.6, tone: "accent" },
      { label: "Complex aggregation", pct: 19.6, tone: "high" },
      { label: "Aggregation, best three models", pct: 33.3, tone: "high" },
      { label: "Smallest file", pct: 86.2, tone: "accent" },
      { label: "Largest file, 152 companies", pct: 48.6, tone: "high" },
    ],
    note: "Aggregation is the operation a business runs on — totals by segment, revenue at risk, how a cohort moved. Even the three strongest models available get it right one time in three. The same collapse happens as the file grows: the largest workbook in the set scores 48.6% averaged across every model tested.",
    quote: "no standalone model achieves error rates low enough for unsupervised use in professional finance applications",
    quoteFrom: "the paper's own conclusion",
  },
  {
    id: "tables",
    heading: "2024 models on realistic tables",
    source: "TableBench — 886 questions across 18 fields, Direct Prompting, Table 4 · arXiv:2408.09174",
    unit: "",
    scale: "overall score, out of 100",
    rows: [
      { label: "A person", pct: 85.91, tone: "accent" },
      { label: "GPT-4o (2024)", pct: 42.73, tone: "high" },
      { label: "GPT-4-Turbo (2024)", pct: 40.38, tone: "high" },
    ],
    note: "Newer models score better than these, which is why the 2026 result above is the one to argue from. The shape of the gap has not changed.",
  },
];

function bar(row, unit) {
  const line = el("div", "wy-bar-row");
  line.append(el("div", "wy-bar-label", row.label));

  const track = el("div", "wy-track");
  track.setAttribute("aria-hidden", "true");
  const fill = el("div", `sev-bar ${row.tone}`);
  // Geometry from a real number. The figure is the width, so the eye compares the
  // lengths before it has read a single digit. Both scales run 0-100.
  fill.style.width = `${row.pct}%`;
  track.append(fill);
  line.append(track);

  line.append(el("div", "wy-bar-value", `${row.pct}${unit}`));
  return line;
}

function benchmarkPanel(b) {
  const p = el("section", "panel wy-bench");
  p.append(el("h3", "wy-h3", b.heading));
  p.append(el("div", "wy-source", b.source));
  if (b.lead) p.append(el("p", "wy-lead-stat", b.lead));
  const chart = el("div", "wy-chart");
  for (const r of b.rows) chart.append(bar(r, b.unit ?? ""));
  p.append(chart);
  p.append(el("div", "wy-scale col-head", b.scale));
  p.append(el("p", "wy-note", b.note));
  if (b.quote) {
    const q = el("blockquote", "wy-cite");
    q.append(el("span", "wy-cite-text", `“${b.quote}”`));
    q.append(el("span", "wy-cite-from", ` — ${b.quoteFrom}`));
    p.append(q);
  }
  return p;
}

/* ── what we do instead ─────────────────────────────────────────────────── */

const APPROACH = [
  [
    "The numbers are computed, not generated",
    "Usage down 38%, renewal in 21 days, three failed payments, the champion quiet for a month — each one is worked out by code against your database. Same data in, same number out, every time.",
  ],
  [
    "The model only explains",
    "It is handed the finished facts and asked to write the sentence. It never sees the table, so it cannot misread it.",
  ],
  [
    "A fixed catalogue of questions",
    "When you type a question, the model's only job is to say which known question you asked and fill in the parameters. It never writes a query. An answer that is not in the catalogue is rejected before anything runs.",
  ],
  [
    "Refusal is a feature",
    "If nothing fits, it says so and lists what it checked. We would rather return nothing than a plausible wrong number.",
  ],
  [
    "Every number carries its evidence",
    "Each figure opens onto the rows it was counted from and the definition it was counted by. You can check any answer in one click.",
  ],
  [
    "The data is a graph, not a dump",
    "Customers joined to their contacts, tickets, invoices, usage history, events and past decisions. That lets you ask which accounts moved together, and what you decided last time this happened. A bigger context window cannot replicate it.",
  ],
];

/* ── the honest limits ──────────────────────────────────────────────────── */

const LIMITS = [
  [
    "A general model is better at open-ended questions",
    "Ask what your pricing strategy should be and ChatGPT is more useful. We answer a fixed catalogue about your own customers, exactly, and refuse the rest.",
  ],
  [
    "We need your data in a known shape",
    "Six files with named columns. ChatGPT will take anything, and be confidently wrong about it.",
  ],
  [
    "Those benchmarks are not a measurement of us",
    "They are about general models reading raw tables. They are the reason this product is built the way it is, not evidence that it works.",
  ],
  [
    "We have not published our own benchmark",
    "The demo company plants situations with known right answers, including four traps that must produce nothing. That is the beginning of one, not the end.",
  ],
];

/* ── the live strip ─────────────────────────────────────────────────────── */

/**
 * `words` marks a value that is a date or a phrase rather than a figure. It is set a
 * size down: "17 Sep 2026" at the size of "48" wraps onto two lines and makes the tile
 * taller than the three beside it.
 */
function tile(label, value, note, words = false) {
  const t = el("div", "wy-tile");
  t.append(el("div", "wy-tile-label col-head", label));
  t.append(el("div", `wy-tile-value${words ? " wy-tile-words" : ""}`, value));
  if (note) t.append(el("div", "wy-tile-note", note));
  return t;
}

/**
 * 🔴 THE THIRD STATE, and the defect it exists to close.
 *
 * A tile can be in one of three conditions and the screen used to have words for only
 * two of them:
 *
 *   · KNOWN      — the route answered and the figure is real. Print the figure.
 *   · NOT YET    — no analysis has finished, so there is nothing to count. Print "—"
 *                  and say no analysis has run.
 *   · UNREADABLE — a run DID finish, but the reply that carries the count did not
 *                  arrive, or arrived without the count in it. Print this.
 *
 * Measured on a real workspace of 39 open decisions and $1,194,000 under review: the
 * overview read failed, the old code fell back to `counts = {}`, `open` became 0 and the
 * screen said "Open decisions / None / nothing crossed the line". A footnote underneath
 * admitted the counts were missing, but the tile had already made a positive claim, and
 * the tile is what a reader in the room actually reads.
 *
 * So the unreadable state gets a WORD, never "None" and never a dash. A dash reads as a
 * settled result at projector distance; "Unknown" cannot be misread as zero.
 */
const UNKNOWN = "Unknown";

/** A tile that admits it could not read its own number. */
function unknownTile(label, why) {
  const t = tile(label, UNKNOWN, why, true);
  t.className = "wy-tile wy-tile-unknown";
  return t;
}

/**
 * A finite number, or null when the reply did not carry one.
 *
 * ⚠️ `?? 0` is the bug this replaces. Both routes always send these fields when they
 * succeed, so an absent or non-numeric field is a FAULT and not a zero. null is the
 * third state; it is never coerced.
 */
function count(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Why a count is missing, said in the tile itself rather than only in a footnote. */
const NO_COUNTS = "the decision counts could not be read";

/**
 * The four numbers. Each one is read off a route reply and nothing is inferred.
 *
 * `overview` is null when the caller judged the reply unusable. Treat that, and a reply
 * that is "ok" but carries no counts/tiles object, as the same unreadable state.
 *
 * 🔴 The rule the whole strip is built around: a count of zero is only printed when a
 * run has actually finished and found nothing. A number above zero is a fact from the
 * decision table and is printed whatever the run is doing; a zero is only a result once
 * something has looked.
 */
export function liveTiles(status, overview, fmt) {
  // No `?? {}` fallback, and none is needed: every read below goes through count(), which
  // returns null for a field that is absent for ANY reason — a null overview, an overview
  // with no counts object, or a counts object with the key missing. One guard, one state.
  const tiles = overview?.tiles;
  const counts = overview?.counts;
  const run = status?.lastRun ?? null;
  // run.status is written by run.mjs as 'running', 'done' or 'failed'. Only 'done'
  // means a zero below describes a finished piece of work.
  const ran = !!run && run.status === "done";
  const out = [];

  /* 1 — customers loaded. Known unless the workspace reply had no count in it. */
  const accounts = count(status?.workspace?.accounts);
  out.push(
    accounts == null
      ? unknownTile("Customers loaded", "the workspace did not report a customer count")
      : tile("Customers loaded", String(accounts), status?.workspace?.name ?? null),
  );

  /* 2 — open decisions */
  const open = count(counts?.open);
  if (open == null) {
    // Two reasons the count is absent, and the more specific one wins. If a run finished
    // then the number should have been in the reply, so its absence is a read failure and
    // the tile says so. If no run has finished, "no analysis has run yet" is both true and
    // more useful than "unknown", so that is what the reader gets.
    out.push(ran ? unknownTile("Open decisions", NO_COUNTS) : tile("Open decisions", "—", runNote(run)));
  } else if (open > 0) {
    const overdue = count(tiles?.overdue);
    out.push(
      tile(
        "Open decisions",
        String(open),
        overdue == null ? "the overdue count could not be read" : `${overdue} past the date they were given`,
      ),
    );
  } else {
    // A real zero, and only printed as one because a run finished and found nothing.
    out.push(ran ? tile("Open decisions", "None", "nothing crossed the line") : tile("Open decisions", "—", runNote(run)));
  }

  /* 3 — revenue under review */
  const arr = count(tiles?.arrUnderReview);
  if (arr == null) {
    out.push(ran ? unknownTile("Revenue under review", NO_COUNTS) : tile("Revenue under review", "—", runNote(run)));
  } else if (arr > 0) {
    const label = typeof tiles?.arrUnderReviewLabel === "string" && tiles.arrUnderReviewLabel
      ? tiles.arrUnderReviewLabel
      : fmt.money(arr);
    out.push(tile("Revenue under review", String(label), "the ARR of the accounts at risk"));
  } else {
    out.push(
      ran
        ? tile("Revenue under review", "None", "no revenue is flagged")
        : tile("Revenue under review", "—", runNote(run)),
    );
  }

  /* 4 — last analysis */
  if (!run) {
    out.push(tile("Last analysis", "Never", "run it from Today", true));
  } else if (!run.at) {
    // The row exists but has neither a finish nor a start time. Do not invent one.
    out.push(unknownTile("Last analysis", "the run did not record when it happened"));
  } else if (!ran) {
    out.push(tile("Last analysis", fmt.date(run.at), runNote(run), true));
  } else {
    // run.accounts is a nullable column. "0 customers checked" would be a fabrication.
    const checked = count(run.accounts);
    out.push(
      tile(
        "Last analysis",
        fmt.date(run.at),
        checked == null ? "how many customers it checked was not recorded" : `${checked} customers checked`,
        true,
      ),
    );
  }

  return out;
}

/** What to say about a run that is not a finished one. Never the bare status word. */
function runNote(run) {
  if (!run) return "no analysis has run yet";
  if (run.status === "running") return "an analysis is running now";
  if (run.status === "failed") return "the last analysis failed";
  return `the last analysis is ${run.status}`;
}

/* ── the page ───────────────────────────────────────────────────────────── */

// render() can be called again while the two reads are in flight. The later render
// wins: every await checks it still owns the screen before touching the DOM.
let epoch = 0;

export async function render(root, ctx) {
  const mine = ++epoch;
  const isStale = () => mine !== epoch;

  const wrap = el("div", "wy-wrap");

  /* 1 — what this does, in one sentence */
  const hero = el("header", "wy-hero");
  hero.append(el("h1", "wy-h1", "Ledgerline tells you which of your customers need you this week, and why."));
  hero.append(
    el(
      "p",
      "wy-lede",
      "It reads the customer data you already have — usage, tickets, invoices, contacts — works out what changed, and hands you a short list of decisions with the evidence attached.",
    ),
  );
  wrap.append(hero);

  // The live slot. Filled after the two reads; it holds the loading, empty and error
  // states so the argument below it never goes blank while a fetch is in flight.
  const live = el("section", "wy-live");
  const liveHead = el("div", "wy-live-head");
  liveHead.append(el("h2", "wy-h2", "This workspace, right now"));
  const asOf = el("span", "wy-asof");
  liveHead.append(asOf);
  live.append(liveHead);
  const liveBody = el("div", "wy-live-body");
  for (let i = 0; i < 4; i++) liveBody.append(el("div", "skeleton block"));
  live.append(liveBody);
  wrap.append(live);

  /* 2 — the problem */
  const problem = el("section", "panel wy-sec");
  problem.append(el("h2", "wy-h2", "The answer is already in your data. Nobody reads it."));
  para(
    problem,
    "Every customer leaves a trail across six places: what they bought, how much they use it, who their champion is, what they complained about, whether they paid, and what happened last time.",
  );
  para(
    problem,
    "Checking all six for every customer, every week, is work nobody has time for. So the account that went quiet in March is noticed in June, when it does not renew.",
  );
  // Filled from the live read — the multiplication is the reader's own book, not a
  // made-up one, so it stays empty until there is a real number to put in it.
  const problemLive = el("p", "wy-p wy-live-line");
  problem.append(problemLive);
  wrap.append(problem);

  /* 3 — why not just ask ChatGPT */
  const bench = el("section", "wy-sec");
  bench.append(el("h2", "wy-h2", "“Why not just upload the spreadsheet to ChatGPT?”"));
  bench.append(
    el(
      "p",
      "wy-p wy-wide",
      "Because the current models were tested on exactly this, this year, and they come apart on the operation a business runs on. These are published benchmarks, read off the papers themselves, not our opinion.",
    ),
  );
  const charts = el("div", "wy-charts");
  for (const b of BENCHMARKS) charts.append(benchmarkPanel(b));
  bench.append(charts);
  bench.append(
    el(
      "p",
      "wy-punch",
      "The failure is not that it says “I do not know.” It gives you a number, in a confident sentence, and the number is wrong. 82% is high enough to trust and wrong often enough to hurt you — and you cannot tell which answers are which without redoing the work yourself.",
    ),
  );
  wrap.append(bench);

  /* 4 — what we do instead */
  const how = el("section", "wy-sec");
  how.append(el("h2", "wy-h2", "So we never let a model near the arithmetic."));
  const grid = el("div", "wy-grid");
  for (const [head, body] of APPROACH) {
    const card = el("article", "panel wy-card");
    card.append(el("div", "sev-bar accent wy-edge"));
    const text = el("div", "wy-card-text");
    text.append(el("h3", "wy-h3", head));
    text.append(el("p", "wy-p", body));
    card.append(text);
    grid.append(card);
  }
  how.append(grid);
  wrap.append(how);

  /* 5 — what it will not do */
  const limits = el("section", "panel wy-sec wy-limits");
  limits.append(el("h2", "wy-h2", "What it will not do"));
  const list = el("ul", "wy-limit-list");
  for (const [head, body] of LIMITS) {
    const li = el("li");
    li.append(el("strong", null, head));
    li.append(el("span", null, ` — ${body}`));
    list.append(li);
  }
  limits.append(list);
  wrap.append(limits);

  /* the closing line, the one to say out loud */
  const close = el("section", "wy-quote");
  close.append(el("div", "sev-bar accent wy-edge"));
  close.append(
    el(
      "blockquote",
      "wy-quote-text",
      "A benchmark published this March tested GPT-5.2, Gemini 3.1 and Claude Opus on real financial spreadsheets. The best model got 82%. On the aggregations a business actually runs on, the best three got 33%. The authors' own conclusion is that no model is accurate enough to use unsupervised. So we do not let a model near the arithmetic. We compute every number in code, keep the relationships between your customers as a graph, and use the model only to explain what was found — with the evidence attached, so you can check it in one click.",
    ),
  );
  wrap.append(close);

  root.replaceChildren(styles(), wrap);

  /* the two reads */
  let status, overview;
  try {
    [status, overview] = await Promise.all([ctx.api("decisionsStatus"), ctx.api("decisionsOverview")]);
  } catch (err) {
    if (isStale()) return;
    fillError(liveBody, "The live numbers could not be read.", err?.message ?? err, () => render(root, ctx));
    return;
  }
  if (isStale()) return;

  if (status?.asOf) asOf.textContent = `as of ${ctx.fmt.date(status.asOf)}`;
  if (status?.demoMode) {
    // Said out loud on purpose. Quoting demo numbers to an investor without the label
    // is the one way this screen could mislead.
    liveHead.append(el("span", "chip warn", "Demo data"));
  }

  if (status?.needsWorkspace || (status?.ok && !status.hasData)) {
    fillEmpty(liveBody, ctx);
    return;
  }
  if (!status?.ok) {
    fillError(liveBody, "The live numbers could not be read.", status?.error, () => render(root, ctx));
    return;
  }

  const tiles = [];
  for (const t of liveTiles(status, overview?.ok ? overview : null, ctx.fmt)) tiles.push(t);
  liveBody.replaceChildren(...tiles);

  if (!overview?.ok) {
    liveBody.append(el("p", "wy-note", `Decision counts are unavailable: ${overview?.error ?? "unknown error"}`));
  }

  const n = status.workspace?.accounts ?? 0;
  if (n > 0) {
    problemLive.textContent = `This workspace holds ${n} customer${n === 1 ? "" : "s"}. That is ${n * 6} checks a week, by hand, to be sure nothing was missed.`;
  }

  const actions = el("div", "wy-actions");
  actions.append(button("See the decisions", "primary", () => ctx.go("today")));
  actions.append(button("Ask it a question", "", () => ctx.go("ask")));
  live.append(actions);
}

/**
 * Nothing loaded. This is the one branch where the screen has no numbers to quote, and
 * it says so in full rather than printing four zeros.
 */
function fillEmpty(liveBody, ctx) {
  const box = el("div", "empty");
  box.append(el("h3", null, "No customer data is loaded yet"));
  box.append(
    el(
      "p",
      null,
      "Everything above is what this product does. Nothing below it is measured until a workspace has customers in it — load the demo company or your own CSV folder on the Data screen.",
    ),
  );
  box.append(button("Open Data", "primary", () => ctx.go("data")));
  liveBody.replaceChildren(box);
}

function fillError(liveBody, prose, raw, onRetry) {
  const box = el("div", "err");
  box.append(el("strong", null, prose));
  if (raw) box.append(el("code", null, String(raw)));
  box.append(button("Try again", "", onRetry));
  liveBody.replaceChildren(box);
}

/* ── layout ─────────────────────────────────────────────────────────────── */

// Geometry and type only. Every colour on this page comes from a tokens.css class —
// .panel, .sev-bar.accent, .sev-bar.high, .chip.warn, .empty, .err, .col-head — and the
// two bare colour properties below are `var(--muted)` and `var(--text)`, which are the
// tokens themselves rather than a value this file invented.
function styles() {
  return el(
    "style",
    null,
    `
.wy-wrap { display:flex; flex-direction:column; gap:var(--s5); padding-bottom:var(--s6); max-width:104ch; }
.wy-sec { display:flex; flex-direction:column; gap:var(--s3); }

.wy-hero { display:flex; flex-direction:column; gap:var(--s3); padding-top:var(--s2); }
.wy-h1 { font-size:clamp(26px, 3.4vw, 40px); font-weight:700; letter-spacing:-.022em;
  line-height:1.16; max-width:22ch; }
.wy-lede { font-size:clamp(15px, 1.3vw, 18px); line-height:var(--lh-body); color:var(--muted);
  max-width:62ch; margin:0; }

.wy-h2 { font-size:clamp(18px, 1.8vw, 23px); font-weight:650; letter-spacing:-.014em;
  line-height:var(--lh-tight); margin:0; }
.wy-h3 { font-size:var(--fs-md); font-weight:650; margin:0; }
.wy-p { margin:0; font-size:var(--fs-md); line-height:var(--lh-body); color:var(--muted); max-width:70ch; }
.wy-wide { max-width:78ch; }
.wy-p strong, .wy-limit-list strong { color:var(--text); font-weight:650; }

/* the live strip */
.wy-live { display:flex; flex-direction:column; gap:var(--s3); }
.wy-live-head { display:flex; align-items:center; gap:var(--s2); flex-wrap:wrap; }
.wy-asof { font-size:var(--fs-sm); color:var(--muted); }
.wy-asof:empty { display:none; }
.wy-live-body { display:grid; grid-template-columns:repeat(4, minmax(0,1fr)); gap:var(--s3); }
.wy-live-body > .empty, .wy-live-body > .err, .wy-live-body > .wy-note { grid-column:1 / -1; }
.wy-tile { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius);
  padding:var(--s4); display:flex; flex-direction:column; gap:6px; min-width:0; }
.wy-tile-label { margin:0; }
.wy-tile-value { font-size:clamp(24px, 2.6vw, 34px); font-weight:700; letter-spacing:-.02em;
  line-height:1.1; font-variant-numeric:tabular-nums; overflow-wrap:anywhere; }
.wy-tile-words { font-size:clamp(18px, 1.7vw, 23px); letter-spacing:-.012em; }
.wy-tile-note { font-size:var(--fs-sm); color:var(--muted); line-height:var(--lh-tight); }
/* The third state, dressed as what it is. The word sits in --muted and the border goes
   dashed, so from the back of a room an unreadable tile cannot be mistaken for a
   confident figure. Both are tokens; no colour is invented here. */
.wy-tile-unknown { border-style:dashed; }
.wy-tile-unknown .wy-tile-value { color:var(--muted); font-weight:650; }
.wy-live-line:empty { display:none; }
.wy-actions { display:flex; flex-wrap:wrap; gap:var(--s2); }

/* 🔴 tokens.css sets \`.panel + .panel { margin-top: var(--s3) }\`, which is right for
   stacked panels and WRONG inside a grid: every cell after the first would be pushed
   down and the two charts would no longer start on the same line. The gap already does
   that job here, so the margin is taken back. */
.wy-charts > .panel + .panel, .wy-grid > .panel + .panel { margin-top:0; }
.wy-bench > h3, .wy-limits > h2 { margin-bottom:0; }

/* the benchmark charts */
.wy-charts { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:var(--s3); }
.wy-bench { display:flex; flex-direction:column; gap:var(--s2); }
.wy-source { font-size:var(--fs-xs); color:var(--muted); }
.wy-chart { display:flex; flex-direction:column; gap:var(--s2); margin:var(--s2) 0; }
.wy-bar-row { display:grid; grid-template-columns:minmax(0,9.5em) minmax(0,1fr) auto;
  align-items:center; gap:var(--s3); }
.wy-bar-label { font-size:var(--fs-sm); color:var(--muted); overflow-wrap:anywhere; }
.wy-track { height:14px; border-radius:var(--radius-pill); background:var(--panel-2);
  display:flex; align-items:stretch; overflow:hidden; }
/* .sev-bar is a 3px stripe by default; here it is the bar itself, so the geometry is
   overridden and only its colour is kept. */
.wy-track .sev-bar { flex:0 0 auto; width:0; min-height:0; height:100%; }
.wy-bar-value { font-size:var(--fs-md); font-weight:650; font-variant-numeric:tabular-nums;
  min-width:4.2em; text-align:right; }
.wy-lead-stat { margin:var(--s2) 0 0; font-size:var(--fs-md); line-height:var(--lh-body); }
.wy-scale { margin:calc(var(--s2) * -1) 0 var(--s1); }
.wy-cite { margin:var(--s2) 0 0; padding-left:var(--s3); border-left:1px solid var(--border);
  font-size:var(--fs-sm); line-height:var(--lh-body); }
.wy-cite-text { color:var(--text); }
.wy-cite-from { color:var(--muted); }
.wy-note { margin:0; font-size:var(--fs-sm); line-height:var(--lh-body); color:var(--muted); }
.wy-punch { margin:0; font-size:clamp(15px, 1.4vw, 18px); line-height:var(--lh-body);
  max-width:74ch; }

/* what we do instead */
.wy-grid { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:var(--s3); }
.wy-card { display:flex; gap:var(--s3); align-items:stretch; }
.wy-edge { flex:0 0 3px; }
.wy-card-text { display:flex; flex-direction:column; gap:6px; min-width:0; }

/* limits */
.wy-limit-list { margin:0; padding-left:1.15em; display:flex; flex-direction:column; gap:var(--s2); }
.wy-limit-list li { font-size:var(--fs-md); line-height:var(--lh-body); color:var(--muted); max-width:78ch; }

/* the closing line */
.wy-quote { display:flex; gap:var(--s4); align-items:stretch; padding:var(--s2) 0; }
.wy-quote-text { margin:0; font-size:clamp(16px, 1.6vw, 21px); line-height:1.5;
  letter-spacing:-.01em; max-width:72ch; }

@media (max-width: 1040px) {
  .wy-live-body { grid-template-columns:repeat(2, minmax(0,1fr)); }
  .wy-grid { grid-template-columns:repeat(2, minmax(0,1fr)); }
}
@media (max-width: 760px) {
  .wy-live-body { grid-template-columns:minmax(0,1fr); }
  .wy-charts { grid-template-columns:minmax(0,1fr); }
  .wy-grid { grid-template-columns:minmax(0,1fr); }
  .wy-bar-row { grid-template-columns:minmax(0,7em) minmax(0,1fr) auto; }
}
`,
  );
}
