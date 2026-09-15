// Today — the landing page of the v2 surface.
//
// The claim this screen has to carry is the one the competitor cannot: a decision is a
// RECORD with an owner, a due date and a status, not a notification. So every card sits
// on the same grid as a column header — title on the left, owner / due / status in fixed
// columns on the right. A feed has no columns. A work queue does.
//
// Two calls, not one. decisionsOverview gives the list and the tiles, but an empty list
// from it is ambiguous: no workspace, no imported data, no run yet, and "nothing crossed
// the line" all look identical. decisionsStatus is the only route that separates them,
// and each of those four states needs a different sentence and a different button.
//
// Styling comes from tokens.css — .panel .col-head .sev-bar .btn .pill .chip .avatar
// .empty .err .skeleton are all defined there, including their light theme. The block at
// the bottom of this file adds only the grid this screen is laid out on, and nothing it
// adds is a colour.
//
// Nothing here is written with innerHTML. Every title, evidence statement and customer
// name on this page is either imported customer data or model output.

export const title = "Today";

/* ── tiny DOM helpers ───────────────────────────────────────────────────── */

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function button(label, cls, onClick) {
  const b = el("button", `btn ${cls ?? ""}`, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

/**
 * A button that disables itself for the length of an await. Every action on this page
 * hits a route that can take seconds (the demo seed writes ~48 accounts of CSV) or
 * minutes (the folder picker blocks until the user closes the dialog), and a button that
 * still looks clickable through that gets clicked twice.
 */
function busyButton(label, busyLabel, cls, fn) {
  const b = button(label, cls, async () => {
    b.disabled = true;
    b.textContent = busyLabel;
    try {
      await fn();
    } finally {
      b.disabled = false;
      b.textContent = label;
    }
  });
  return b;
}

/* ── card pieces ────────────────────────────────────────────────────────── */

// Groups, in the order a person should deal with them. The API already excludes an
// overdue decision from attention and waiting, so nothing is listed twice.
// `resolved` is deliberately not shown here — this screen is the open queue.
const GROUPS = [
  ["overdue", "Overdue"],
  ["attention", "Needs a decision"],
  ["waiting", "Being handled"],
  ["snoozed", "Snoozed"],
];

function initials(name) {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const first = parts[0][0];
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return first + last;
}

/**
 * Evidence statements are rule- or model-written prose ("Seats used down -18% in 30
 * days"). Colouring the negative numbers means splitting the string and rebuilding it
 * out of text nodes — the only way to style part of a string without innerHTML.
 * The lookbehind keeps "2026-09-15" from reading as the number -09.
 */
function evidenceInto(parent, text) {
  const s = String(text);
  const re = /(?<![\w\d])[-−]\s?\d[\d,]*(?:\.\d+)?%?/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) parent.append(document.createTextNode(s.slice(last, m.index)));
    parent.append(el("span", "t2-neg", m[0]));
    last = m.index + m[0].length;
  }
  parent.append(document.createTextNode(s.slice(last)));
}

function dateText(ctx, iso) {
  if (!iso) return "";
  // fmt is handed over by the shell. Fall back to the raw value rather than render
  // "undefined" in a pill if it ever arrives without its date helper.
  const f = ctx.fmt?.date;
  if (typeof f === "function") {
    const out = f(iso);
    if (out) return String(out);
  }
  return String(iso);
}

function ownerCell(d) {
  const cell = el("div", "t2-owner");
  if (d.owner) {
    cell.append(el("div", "avatar", initials(d.owner)));
    cell.append(el("span", null, d.owner));
  } else {
    cell.append(el("div", "avatar t2-nobody", "—"));
    cell.append(el("span", null, "Unassigned"));
  }
  return cell;
}

function duePill(ctx, d) {
  // Four facts compete for this column and the most urgent wins: past the date, then
  // the date it comes back from snooze, then the date itself, then never given one.
  if (d.overdueDays != null) {
    const n = d.overdueDays;
    return el("span", "pill overdue", `${n} day${n === 1 ? "" : "s"} overdue`);
  }
  if (d.status === "snoozed" && d.snoozedUntil) return el("span", "pill", `Back ${dateText(ctx, d.snoozedUntil)}`);
  if (d.dueAt) return el("span", "pill", `Due ${dateText(ctx, d.dueAt)}`);
  return el("span", "pill t2-nodate", "No due date");
}

export function decisionCard(ctx, d) {
  const card = el("button", "t2-card");
  card.type = "button";
  // A whole-card <button> gets keyboard focus and Enter for free, and there is nothing
  // interactive inside it to nest.
  card.onclick = () => ctx.go(`decisions/${d.id}`);
  card.setAttribute(
    "aria-label",
    `${d.title}. Severity ${d.severity}. Status ${d.statusLabel}. ${d.owner ? `Owner ${d.owner}` : "No owner"}.`,
  );

  // .sev-bar carries its own colour per severity; an unknown value falls back to the
  // plain border colour rather than to nothing.
  card.append(el("div", `sev-bar ${d.severity ?? ""}`));

  const main = el("div", "t2-main");
  main.append(el("div", "t2-title", d.title));

  const chips = el("div", "t2-chips");
  // The customer and the money are not evidence, but a work item that names neither is
  // not a work item. They lead the row; the API's evidence statements follow.
  if (d.accountName) chips.append(el("span", "chip t2-who", d.accountName));
  if (d.impactLabel) {
    const money = el("span", "chip t2-money");
    money.append(document.createTextNode(d.impactLabel));
    if (d.impactBasis) money.append(el("i", null, ` ${d.impactBasis}`));
    chips.append(money);
  }
  for (const e of d.evidence ?? []) {
    const chip = el("span", "chip");
    evidenceInto(chip, e);
    chips.append(chip);
  }
  if (d.signalsEased) chips.append(el("span", "chip warn", "signals eased"));
  if (chips.childElementCount) main.append(chips);
  card.append(main);

  const side = el("div", "t2-side");
  side.append(ownerCell(d));
  side.append(duePill(ctx, d));
  // tokens.css spells the pill states exactly as the API returns status, so no map.
  side.append(el("span", `pill ${d.status ?? ""}`, d.statusLabel));
  card.append(side);

  return card;
}

export function columnHeader() {
  const h = el("div", "t2-card-grid col-head");
  h.append(el("div", null, ""));
  h.append(el("div", null, "Decision cards"));
  const side = el("div", "t2-side");
  side.append(el("div", null, "Owner"));
  side.append(el("div", null, "Due date"));
  side.append(el("div", null, "Status"));
  h.append(side);
  return h;
}

function groupLabel(text, count) {
  const g = el("div", "t2-group col-head");
  g.append(el("span", "t2-group-name", text));
  g.append(el("span", "t2-count", String(count)));
  return g;
}

/* ── panels ─────────────────────────────────────────────────────────────── */

// .empty is the settled kind of nothing — dashed border, centred, h3 then p then button.
export function emptyPanel(heading, body) {
  const p = el("div", "empty");
  p.append(el("h3", null, heading));
  if (body) p.append(el("p", null, body));
  return p;
}

/**
 * .err is built to hold two things: a line of prose saying what failed, and the server's
 * exact wording underneath in a <code>. Keep them separate — paraphrasing the raw
 * message into the prose is how a report of a real fault turns into a shrug.
 */
export function errorPanel(prose, raw, onRetry) {
  const p = el("div", "err");
  p.append(el("strong", null, prose));
  if (raw) p.append(el("code", null, String(raw)));
  if (onRetry) p.append(button("Try again", "", onRetry));
  return p;
}

// The heading on its own, for the branches that have no counts to put beside it and no
// working analysis to offer. The page should still say where you are.
function plainHead() {
  const h = el("div", "t2-head");
  h.append(el("h1", null, "Today"));
  return h;
}

export function loading() {
  const w = el("div", "t2-wrap");
  w.append(plainHead());
  w.append(el("p", "t2-sub", "Loading…"));
  // Three card-shaped blocks, because cards are what is being waited for.
  for (let i = 0; i < 3; i++) w.append(el("div", "skeleton block"));
  return w;
}

/* ── the run, and saying something true while it happens ────────────────── */

function progressText(p) {
  const phase =
    {
      reading: "Reading the data",
      signals: "Working out what changed",
      situations: "Looking for situations",
      reasoning: "Asking the model about the important ones",
      done: "Finishing",
    }[p.phase] ?? String(p.phase);
  const bits = [`${p.accounts ?? 0} customers`, `${p.signals ?? 0} signals`, `${p.candidates ?? 0} situations`];
  if (p.phase === "reasoning" && p.of) bits.push(`explained ${p.reasoned ?? 0} of ${p.of}`);
  return `${phase} — ${bits.join(" · ")}`;
}

/**
 * decisionsRun does not resolve until the whole run is finished, and a run that makes
 * model calls takes minutes. decisionsRunStatus is the only route that can say anything
 * true in the meantime, so it is polled for the text. Resolves with the finished run row
 * (snake_case: status, error), or null if this render was replaced first.
 */
async function pollProgress(ctx, line, isStale) {
  for (;;) {
    await sleep(1500);
    if (isStale()) return null;
    let s = null;
    try {
      s = await ctx.api("decisionsRunStatus");
    } catch {
      // A dropped poll says nothing about the run; the next tick asks again.
    }
    if (isStale()) return null;
    const run = s?.ok ? s.run : null;
    if (run?.progress) line.textContent = progressText(run.progress);
    if (run && run.status !== "running") return run;
  }
}

/**
 * Start an analysis and keep one line of text honest while it runs. Every Run button on
 * this page goes through here. decisionsRun refuses a second concurrent run with an
 * error rather than an exception, so that message lands in `line` like any other.
 */
async function startRun(ctx, line, isStale, again) {
  line.textContent = "Starting the analysis…";
  const done = ctx
    .api("decisionsRun", { method: "POST" })
    .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  pollProgress(ctx, line, isStale); // paints the phase and the counters meanwhile
  const r = await done;
  if (isStale()) return;
  if (!r.ok) line.textContent = r.error;
  else await again();
}

/* ── the page ───────────────────────────────────────────────────────────── */

// render() can be called again on the same root while a fetch or a poll is in flight.
// The later render wins; every await checks that it is still the current one before it
// touches the DOM, so a slow first response cannot overwrite a newer screen.
let epoch = 0;

export async function render(root, ctx) {
  const mine = ++epoch;
  const isStale = () => mine !== epoch;
  const again = () => render(root, ctx);

  root.replaceChildren(styles(), loading());

  let status, overview;
  try {
    // Both are cheap reads; asking for them in series would show a blank screen twice.
    [status, overview] = await Promise.all([ctx.api("decisionsStatus"), ctx.api("decisionsOverview")]);
  } catch (err) {
    if (isStale()) return;
    const w = el("div", "t2-wrap");
    w.append(
      plainHead(),
      errorPanel("Today could not reach the app's backend.", err?.message ?? err, again),
    );
    root.replaceChildren(styles(), w);
    return;
  }
  if (isStale()) return;

  const wrap = el("div", "t2-wrap");
  root.replaceChildren(styles(), wrap);

  // needsWorkspace is not an error — it is the first-run state, and it arrives on an
  // ok:true from decisionsStatus and an ok:false from everything else.
  if (status?.needsWorkspace) {
    wrap.append(plainHead(), workspacePanel(ctx, again, isStale));
    return;
  }
  if (!status?.ok) {
    wrap.append(plainHead(), errorPanel("Today could not load the workspace.", status?.error, again));
    return;
  }
  if (!overview?.ok) {
    wrap.append(plainHead(), errorPanel("Today could not load its decisions.", overview?.error, again));
    return;
  }

  const tiles = overview.tiles ?? {};
  const counts = overview.counts ?? {};
  const needs = (tiles.attention ?? 0) + (tiles.overdue ?? 0);

  /* heading */
  const head = el("div", "t2-head");
  head.append(el("h1", null, "Today"));
  if (overview.asOf) head.append(el("span", "t2-asof", `as of ${overview.asOf}`));
  if (status.demoMode) head.append(el("span", "chip", "Demo data"));
  head.append(el("div", "t2-grow"));
  const runLine = el("div", "t2-runline");
  head.append(busyButton("Run analysis", "Analysing…", "", () => startRun(ctx, runLine, isStale, again)));
  wrap.append(head);

  /* subtitle — every number in it came from the response above */
  const sub = el("p", "t2-sub");
  if (needs > 0) {
    sub.append(document.createTextNode(`${needs} decision${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you.`));
    if (tiles.overdue) {
      sub.append(document.createTextNode(" "));
      sub.append(el("b", "t2-neg", `${tiles.overdue} ${tiles.overdue === 1 ? "is" : "are"} past the date you set.`));
    }
  } else if ((counts.open ?? 0) > 0) {
    sub.textContent = `Nothing new. ${counts.open} open decision${counts.open === 1 ? " is" : "s are"} being handled.`;
  } else if (status.hasData) {
    sub.textContent = "Nothing is open right now.";
  }
  // With no data imported there is no count worth stating; the panel below says why.
  if (sub.childNodes.length) wrap.append(sub);

  if (tiles.arrUnderReview > 0) {
    wrap.append(el("p", "t2-sub2", `${tiles.arrUnderReviewLabel} of revenue is under review.`));
  }

  /* a failed or running analysis has to be said out loud, or the list below is a lie */
  if (status.lastRun?.status === "failed") {
    wrap.append(
      errorPanel("The last analysis failed, so this list may be out of date.", status.lastRun.error, () =>
        startRun(ctx, runLine, isStale, again),
      ),
    );
  }
  if (status.running) {
    runLine.textContent = "An analysis is running…";
    pollProgress(ctx, runLine, isStale).then((run) => {
      if (run && !isStale()) again();
    });
  }
  wrap.append(runLine);

  /* the list */
  const groups = GROUPS.map(([key, label]) => [label, overview.sections?.[key] ?? []]).filter(([, l]) => l.length);

  if (groups.length) {
    const list = el("div", "t2-list");
    list.append(columnHeader());
    for (const [label, items] of groups) {
      list.append(groupLabel(label, items.length));
      for (const d of items) list.append(decisionCard(ctx, d));
    }
    wrap.append(list);
    return;
  }

  /* three different kinds of nothing, told apart by decisionsStatus */
  if (!status.hasData) {
    wrap.append(noDataPanel(ctx, again, isStale));
  } else if (!status.lastRun) {
    const n = status.workspace?.accounts ?? 0;
    const p = emptyPanel(
      "Nothing has been analysed yet",
      `${n} customer${n === 1 ? " is" : "s are"} imported. The analysis works out what changed for each of them, then asks the model about the ones that matter.`,
    );
    // runLine is already on the page, above this panel: one status line per screen.
    p.append(busyButton("Run the analysis", "Analysing…", "primary", () => startRun(ctx, runLine, isStale, again)));
    wrap.append(p);
  } else {
    const n = status.lastRun.accounts ?? 0;
    const p = emptyPanel(
      "Nothing needs a decision",
      `${n} customer${n === 1 ? " was" : "s were"} checked and nothing crossed the line. Single signals that are only being watched are on the Customers page.`,
    );
    p.append(busyButton("Run it again", "Analysing…", "", () => startRun(ctx, runLine, isStale, again)));
    wrap.append(p);
  }
}

/* ── first-run panels ───────────────────────────────────────────────────── */

function workspacePanel(ctx, again, isStale) {
  const p = emptyPanel(
    "Name your workspace first",
    "A workspace holds one company's data and its decisions. Nothing can be imported or analysed until there is one.",
  );
  const row = el("div", "t2-row");
  const name = el("input", "t2-input");
  name.type = "text";
  name.placeholder = "My company";
  name.setAttribute("aria-label", "Workspace name");
  const note = el("div", "t2-note");

  const create = busyButton("Create workspace", "Creating…", "primary", async () => {
    note.textContent = "";
    const r = await ctx
      .api("decisionsWorkspaceCreate", { method: "POST", body: { name: name.value } })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (isStale()) return;
    if (!r.ok) note.textContent = r.error;
    else await again();
  });
  name.onkeydown = (e) => {
    if (e.key === "Enter") create.click();
  };

  row.append(name, create);
  p.append(row, note);
  return p;
}

function noDataPanel(ctx, again, isStale) {
  const p = emptyPanel(
    "No customer data yet",
    "There is nothing to decide about until some customers are in. Either of these can be done again later, and you can have both.",
  );
  p.append(
    el(
      "p",
      null,
      "The demo company is made-up customers with real-looking problems in them; none of your data is used. Your own data is a folder of CSV files — accounts.csv, usage_daily.csv, contacts.csv, tickets.csv and invoices.csv.",
    ),
  );
  const note = el("div", "t2-note");

  const demo = busyButton("Load the demo company", "Loading…", "primary", async () => {
    note.textContent = "";
    const r = await ctx
      .api("decisionsSeedDemo", { method: "POST", body: { variant: "demo" } })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (isStale()) return;
    if (!r.ok) note.textContent = r.error;
    else await again();
  });

  // decisionsImportPick opens a Windows folder dialog and blocks until it is closed, so
  // the three answers it can give — cancelled, imported, failed — all need saying.
  const own = busyButton("Import my own data", "Waiting for the folder…", "", async () => {
    note.textContent = "";
    const r = await ctx
      .api("decisionsImportPick", { method: "POST" })
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    if (isStale()) return;
    if (r.cancelled) {
      note.textContent = "No folder was chosen.";
      return;
    }
    if (!r.ok) {
      note.textContent = r.error;
      for (const w of r.report?.warnings ?? []) note.append(el("div", null, w));
      return;
    }
    await again();
  });

  const row = el("div", "t2-row");
  row.append(demo, own);
  p.append(row, note);
  return p;
}

/* ── layout ─────────────────────────────────────────────────────────────── */

// Scoped to a t2- prefix and shipped inside the page, because this screen owns no
// stylesheet of its own and must not reach into tokens.css, which another file owns.
// Everything here is geometry: the card grid, and how it collapses. The colours, the
// type scale and the spacing steps are all tokens.
export function styles() {
  return el(
    "style",
    null,
    `
.t2-wrap { --t2-side: 150px 128px 118px; display:flex; flex-direction:column; gap:var(--s3); padding-bottom:var(--s6); }
.t2-grow { flex:1 1 auto; }

.t2-head { display:flex; align-items:baseline; gap:var(--s2); flex-wrap:wrap; }
.t2-head .btn, .t2-head .chip { align-self:center; }
.t2-asof { font-size:var(--fs-sm); color:var(--muted); }
.t2-sub { margin:0; font-size:var(--fs-md); color:var(--muted); }
.t2-sub b { font-weight:600; }
.t2-sub2 { margin:calc(var(--s2) * -1) 0 0; font-size:var(--fs-sm); color:var(--muted); }

.t2-runline:empty { display:none; }
.t2-runline { font-size:var(--fs-sm); color:var(--muted); background:var(--panel);
  border:1px solid var(--border); border-radius:var(--radius); padding:var(--s3) var(--s4); }

.t2-list { display:flex; flex-direction:column; gap:var(--s2); margin-top:var(--s1); }

/* One grid, shared by the header row and every card, so the columns line up. */
.t2-card-grid, .t2-card { display:grid; grid-template-columns:3px minmax(0,1fr) auto;
  gap:0 var(--s4); align-items:center; }
.t2-side { display:grid; grid-template-columns:var(--t2-side); gap:0 var(--s3); align-items:center; }
.t2-card-grid { padding:0 var(--s4) 0 var(--s3); }

.t2-card { width:100%; text-align:left; font:inherit; color:var(--text); background:var(--panel);
  border:1px solid var(--border); border-radius:var(--radius); padding:var(--s3) var(--s4) var(--s3) var(--s3); }
.t2-card:hover { border-color:var(--muted); }
.t2-card .sev-bar { min-height:38px; }

.t2-main { min-width:0; display:flex; flex-direction:column; gap:7px; }
.t2-title { font-size:var(--fs-md); font-weight:600; line-height:var(--lh-tight);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

.t2-chips { display:flex; flex-wrap:wrap; gap:var(--s1) 6px; }
/* A chip is nowrap by default, which is right for a filter and wrong for a sentence:
   these hold whole evidence statements and have to be allowed to wrap. */
.t2-chips .chip { white-space:normal; max-width:100%; }
.t2-chips .t2-who, .t2-chips .t2-money { color:var(--text); }
.t2-money { font-variant-numeric:tabular-nums; }
.t2-money i { font-style:normal; color:var(--muted); }
.t2-neg { color:var(--danger); }

.t2-owner { display:flex; align-items:center; gap:var(--s2); min-width:0; }
.t2-owner span { font-size:var(--fs-sm); color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.t2-nobody { border-style:dashed; }
.pill.t2-nodate { background:transparent; }

.t2-group { display:flex; align-items:center; gap:var(--s2); margin:var(--s3) 0 0 var(--s3); }
.t2-group-name { color:var(--text); }
.t2-count { border:1px solid var(--border); border-radius:var(--radius-pill); padding:0 7px; }

.t2-row { display:flex; flex-wrap:wrap; gap:var(--s2); align-items:center; justify-content:center; margin-top:var(--s4); }
.t2-note:empty { display:none; }
.t2-note { margin-top:var(--s3); font-size:var(--fs-sm); color:var(--danger); }
.t2-input { padding:8px 11px; border-radius:var(--radius-sm); color:var(--text);
  background:var(--bg); border:1px solid var(--border); min-width:220px; }
.t2-input:focus { outline:none; border-color:var(--muted); }

/* Narrow: the three columns drop under the title. Both new placements are written here
   and nowhere else, so the desktop grid keeps auto-placement and cannot be left holding
   a row from the wide layout. */
@media (max-width: 760px) {
  .t2-card-grid.col-head { display:none; }
  .t2-card { grid-template-columns:3px minmax(0,1fr); }
  .t2-card .sev-bar { grid-row:1 / span 2; }
  .t2-side { grid-column:2; grid-template-columns:none; grid-auto-flow:column;
    justify-content:start; gap:var(--s2); margin-top:var(--s2); }
  .t2-owner span { display:none; }
}
`,
  );
}
