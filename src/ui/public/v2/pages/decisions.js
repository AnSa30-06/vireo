// Every decision, filtered — the screen Today's summary line opens into.
//
// Today answers "what needs me this week" and deliberately shows a short list.
// This page is the other question: "show me everything, and let me slice it."
// Those are different jobs, which is why this is not Today with a longer limit.
//
// The card is imported from today.js rather than rebuilt here. A decision that
// looks like one thing on Today and another thing here is a decision the reader
// has to re-learn, and the two screens would drift the first time either was
// touched. Exporting the renderer was a three-word change to today.js; copying
// it would have been ninety lines that rot apart.
//
// Every filter below maps to a real query parameter on decisionsList
// (status, severity, kind, owner, sort). None of them filter client-side: the
// route already does it in SQL, and filtering a page of rows in the browser
// would silently disagree with the count the server reports.
import {
  el,
  button,
  decisionCard,
  columnHeader,
  emptyPanel,
  errorPanel,
  loading,
  styles,
} from "./today.js";

export const title = "Decisions";

/** Guards against a slow response from an abandoned render painting over a new one. */
let epoch = 0;

const STATUSES = [
  ["open", "Open"],
  ["all", "Everything"],
  ["new", "New"],
  ["accepted", "Accepted"],
  ["in_progress", "In progress"],
  ["waiting", "Waiting"],
  ["snoozed", "Snoozed"],
  ["resolved", "Resolved"],
  ["dismissed", "Dismissed"],
];

const SEVERITIES = [
  ["all", "Any severity"],
  ["critical", "Critical"],
  ["high", "High"],
  ["medium", "Medium"],
  ["low", "Low"],
];

const SORTS = [
  ["priority", "Most serious first"],
  ["due", "Due soonest"],
  ["newest", "Newest"],
];

/** The filter state lives on ctx.state so it survives leaving and coming back. */
function filtersOf(ctx) {
  if (!ctx.state.decisionsFilter) {
    ctx.state.decisionsFilter = { status: "open", severity: "all", kind: "all", owner: "all", sort: "priority" };
  }
  return ctx.state.decisionsFilter;
}

function select(label, options, value, onChange) {
  const wrap = el("label", "d2-field");
  wrap.append(el("span", "col-head", label));
  const sel = el("select", "d2-select");
  for (const [v, text] of options) {
    const o = el("option", null, text);
    o.value = v;
    if (v === value) o.selected = true;
    sel.append(o);
  }
  sel.onchange = () => onChange(sel.value);
  wrap.append(sel);
  return wrap;
}

/**
 * The kind and owner lists are built from what came back, not hard-coded.
 *
 * A fixed list of decision kinds would go stale the moment a signal is added,
 * and an owner list has to come from the data because owners are free text.
 */
function optionsFrom(values, anyLabel) {
  const seen = [...new Set(values.filter(Boolean))].sort();
  return [["all", anyLabel], ...seen.map((v) => [v, v])];
}

function summaryLine(total, shown, filtered) {
  if (!total) return filtered ? "Nothing matches these filters." : "No decisions yet.";
  const plural = total === 1 ? "decision" : "decisions";
  return filtered ? `${total} ${plural} match.` : `${total} ${plural}.`;
}

export async function render(root, ctx) {
  const mine = ++epoch;
  const isStale = () => mine !== epoch;
  const again = () => render(root, ctx);
  const f = filtersOf(ctx);

  root.replaceChildren(styles(), loading());

  let res;
  try {
    res = await ctx.api("decisionsList", {
      query: { status: f.status, severity: f.severity, kind: f.kind, owner: f.owner, sort: f.sort },
    });
  } catch (err) {
    if (isStale()) return;
    const w = el("div", "t2-wrap");
    w.append(head(), errorPanel("The decisions could not be loaded.", err?.message ?? err, again));
    root.replaceChildren(styles(), extraStyles(), w);
    return;
  }
  if (isStale()) return;

  const wrap = el("div", "t2-wrap");
  wrap.append(head());

  if (!res?.ok) {
    // needsWorkspace is not a failure - the shell handles it - but any other
    // not-ok is, and the reader is told which.
    wrap.append(
      res?.needsWorkspace
        ? emptyPanel("No workspace is open.", "Open or create one from the sidebar, then come back.")
        : errorPanel("The decisions could not be loaded.", res?.error ?? "The app gave no reason.", again),
    );
    root.replaceChildren(styles(), extraStyles(), wrap);
    return;
  }

  const rows = res.decisions ?? [];
  const filtered = f.status !== "open" || f.severity !== "all" || f.kind !== "all" || f.owner !== "all";

  // --- the filter bar ---
  const bar = el("div", "d2-bar panel");
  const set = (key) => (v) => {
    f[key] = v;
    render(root, ctx);
  };
  bar.append(
    select("Status", STATUSES, f.status, set("status")),
    select("Severity", SEVERITIES, f.severity, set("severity")),
    select("Kind", optionsFrom(rows.map((d) => d.kind), "Any kind"), f.kind, set("kind")),
    select(
      "Owner",
      [["all", "Anyone"], ["unassigned", "Nobody yet"], ...(res.owners ?? []).map((o) => [o, o])],
      f.owner,
      set("owner"),
    ),
    select("Sort", SORTS, f.sort, set("sort")),
  );
  if (filtered) {
    bar.append(
      button("Clear filters", "btn", () => {
        ctx.state.decisionsFilter = { status: "open", severity: "all", kind: "all", owner: "all", sort: "priority" };
        render(root, ctx);
      }),
    );
  }
  wrap.append(bar);

  wrap.append(el("p", "d2-count", summaryLine(res.total ?? rows.length, rows.length, filtered)));

  if (!rows.length) {
    wrap.append(
      filtered
        ? emptyPanel("Nothing matches these filters.", "Widen them, or clear them to see every open decision.")
        : emptyPanel("No decisions yet.", "Import your customer data and run the analysis, and they appear here."),
    );
    root.replaceChildren(styles(), extraStyles(), wrap);
    return;
  }

  const list = el("div", "d2-list");
  list.append(columnHeader());
  for (const d of rows) list.append(decisionCard(ctx, d));
  wrap.append(list);

  root.replaceChildren(styles(), extraStyles(), wrap);

  function head() {
    const h = el("header", "t2-head");
    h.append(el("h1", null, "Decisions"));
    h.append(el("p", "t2-sub", "Every decision in this workspace, however you want to slice it."));
    return h;
  }
}

/** Only what today.js's sheet does not already provide. */
function extraStyles() {
  return el(
    "style",
    null,
    `
.d2-bar { display:flex; flex-wrap:wrap; gap:var(--s3); align-items:flex-end; padding:var(--s3); }
.d2-field { display:flex; flex-direction:column; gap:4px; }
.d2-select {
  background:var(--bg); color:var(--text); border:1px solid var(--border);
  border-radius:var(--radius-sm); padding:6px 8px; font:inherit; min-width:9rem;
}
.d2-select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.d2-count { color:var(--muted); margin:0; }
.d2-list { display:flex; flex-direction:column; gap:var(--s2); }
`,
  );
}
