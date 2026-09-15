// v2 / Customers — the list, and one customer.
//
// Both views live in one module because they share the state chips, the signal
// rows and the decision cards, and the router hands this file whichever of the
// two the route asks for (see customerIdFrom below).
//
// 🔴 NOTHING HERE USES innerHTML. Customer names and model-written text are
// untrusted; every string goes in through textContent. Same rule as app.js and
// decisions.js, and it is not negotiable.
//
// On the competitor's chip set: only four of their eight states exist in this
// product — At risk, Dormant, New, Expansion ready (their "Upsell ready") —
// plus three of ours they do not have (Payment issue, Watching, Healthy). The
// chip text is whatever decisionsCustomers returns in `labels`, so the row
// stays empty rather than being filled with a state nobody computed. "High
// value", "Activated", "Retained" and "Power user" are NOT derived from ARR or
// tenure here: inventing a state is worse than an empty cell.

export const title = "Customers";

// --- tiny DOM helpers --------------------------------------------------------

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
};

function button(text, cls, onClick) {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * ctx.fmt is written by a sibling agent in this same build, so every call is
 * guarded: a missing or throwing helper degrades to a readable fallback rather
 * than taking the page down.
 */
function fmt(ctx, name, value, fallback) {
  const fn = ctx?.fmt?.[name];
  if (typeof fn !== "function") return fallback;
  try {
    const out = fn(value);
    return out == null || out === "" ? fallback : out;
  } catch {
    return fallback;
  }
}

/** ISO timestamp -> short local string. Invalid input is shown as-is, never as "Invalid Date". */
function whenText(ctx, iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const nice = `${d.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" })}, ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  return fmt(ctx, "date", iso, nice);
}

// --- fixed vocabulary from the API ------------------------------------------

// signal.band is an integer; these are the words the existing UI uses for it.
const BAND_WORDS = ["", "notable", "significant", "severe"];

// decision.status values that count as open, copied from OPEN_STATUSES in
// src/decisions/decisions.mjs so the split here matches what the server counts.
const OPEN_STATUSES = new Set(["new", "accepted", "in_progress", "waiting", "snoozed"]);

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

// --- styles ------------------------------------------------------------------
//
// This page ships no .css file of its own, so it injects one stylesheet, once.
// CSP allows this (style-src 'self' 'unsafe-inline'). Everything is scoped under
// .cx so it cannot reach the shell or the other v2 pages. Colours come only from
// tokens.css; the tints are color-mix over those same tokens, so a browser that
// cannot mix simply drops the background and the border still reads.
const STYLE_ID = "v2-customers-style";
const CSS = `
.cx { display: flex; flex-direction: column; gap: 16px; max-width: 1180px; }
.cx-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.cx-head h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
.cx-head h2 { margin: 0; font-size: 18px; font-weight: 600; }
.cx-muted { color: var(--muted); font-size: 12px; }
.cx-back { background: none; border: 0; color: var(--muted); font: inherit; font-size: 12px;
  padding: 0; cursor: pointer; text-align: left; }
.cx-back:hover { color: var(--text); }

.cx-panel { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.cx-panel > h3 { margin: 0; padding: 12px 14px; font-size: 13px; font-weight: 600;
  border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 8px; }
.cx-panel > h3 .cx-muted { font-weight: 400; margin-left: auto; }
.cx-body { padding: 12px 14px; }
.cx-note { margin: 0; padding: 14px; color: var(--muted); font-size: 13px; line-height: 1.5; }

.cx-bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cx-bar input[type="search"], .cx-bar input[type="text"] {
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text); font: inherit; font-size: 13px; padding: 7px 10px; min-width: 220px; }
.cx-bar input:focus { outline: none; border-color: var(--muted); }
.cx-grow { flex: 1 1 auto; }

.cx-chipbar { display: flex; gap: 6px; flex-wrap: wrap; }
.cx-fchip { background: none; border: 1px solid var(--border); border-radius: 999px;
  color: var(--muted); font: inherit; font-size: 12px; padding: 4px 11px; cursor: pointer; }
.cx-fchip:hover { color: var(--text); }
.cx-fchip[aria-pressed="true"] { color: var(--text); border-color: var(--muted); }

.cx-chip { display: inline-flex; align-items: center; border: 1px solid var(--border);
  border-radius: 999px; padding: 2px 9px; font-size: 11px; line-height: 1.6; white-space: nowrap; }
.cx-chip.at_risk, .cx-chip.payment_issue { color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
  background: color-mix(in srgb, var(--danger) 12%, transparent); }
.cx-chip.watching { color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 45%, var(--border));
  background: color-mix(in srgb, var(--warn) 12%, transparent); }
.cx-chip.expansion_ready, .cx-chip.healthy { color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  background: color-mix(in srgb, var(--accent) 12%, transparent); }
.cx-chip.dormant, .cx-chip.new { color: var(--muted); }
.cx-chip.sev-critical, .cx-chip.sev-high { color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); }
.cx-chip.sev-medium { color: var(--warn);
  border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); }
.cx-chip.sev-low, .cx-chip.plain { color: var(--muted); }

.cx-tablewrap { border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--panel); overflow-x: auto; }
table.cx-tbl { border-collapse: collapse; width: 100%; font-size: 13px; }
table.cx-tbl th { text-align: left; font-weight: 500; color: var(--muted); font-size: 11px;
  letter-spacing: 0.04em; text-transform: uppercase; border-bottom: 1px solid var(--border);
  padding: 0; position: sticky; top: 0; background: var(--panel); }
table.cx-tbl th button { width: 100%; background: none; border: 0; color: inherit; font: inherit;
  letter-spacing: inherit; text-transform: inherit; padding: 9px 12px; cursor: pointer;
  text-align: inherit; display: flex; align-items: center; gap: 5px; }
table.cx-tbl th.num button { justify-content: flex-end; }
table.cx-tbl th button:hover { color: var(--text); }
table.cx-tbl th[aria-sort] button { color: var(--text); }
table.cx-tbl td { padding: 9px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
table.cx-tbl tr:last-child td { border-bottom: 0; }
table.cx-tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }
table.cx-tbl tbody tr:hover td { background: color-mix(in srgb, var(--text) 4%, transparent); }
table.cx-tbl .cx-name { background: none; border: 0; color: var(--text); font: inherit;
  padding: 0; cursor: pointer; text-align: left; }
table.cx-tbl .cx-name:hover { text-decoration: underline; }
.cx-dim { color: var(--muted); }

.cx-tiles { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); }
.cx-tile { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 11px 13px; }
.cx-tile .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.cx-tile .v { font-size: 18px; margin-top: 4px; font-variant-numeric: tabular-nums; }
.cx-tile .s { color: var(--muted); font-size: 11px; margin-top: 2px; }

.cx-kv { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; font-size: 13px; }
.cx-kv dt { color: var(--muted); }
.cx-kv dd { margin: 0; }

.cx-row { display: flex; gap: 10px; align-items: baseline; padding: 9px 14px;
  border-bottom: 1px solid var(--border); font-size: 13px; }
.cx-row:last-child { border-bottom: 0; }
.cx-row .s { flex: 1 1 auto; }
.cx-row .t { color: var(--muted); font-size: 12px; }
.cx-row .when { color: var(--muted); font-size: 11px; white-space: nowrap; }

.cx-dec { display: block; width: 100%; text-align: left; background: none; border: 0;
  border-bottom: 1px solid var(--border); padding: 11px 14px; color: inherit; font: inherit;
  cursor: pointer; }
.cx-dec:last-child { border-bottom: 0; }
.cx-dec:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.cx-dec .top { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cx-dec .ttl { font-size: 13px; font-weight: 500; }
.cx-dec .sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
.cx-dec ul { margin: 6px 0 0; padding-left: 16px; color: var(--muted); font-size: 12px; line-height: 1.6; }

.cx-err { border: 1px solid color-mix(in srgb, var(--danger) 50%, var(--border));
  border-radius: var(--radius); padding: 12px 14px; font-size: 13px; line-height: 1.55; }
.cx-err b { display: block; margin-bottom: 4px; font-weight: 600; }
.cx-err code { color: var(--muted); font-size: 12px; word-break: break-word; }
.cx-err button { margin-top: 10px; background: none; border: 1px solid var(--border);
  border-radius: var(--radius); color: var(--text); font: inherit; font-size: 12px;
  padding: 5px 12px; cursor: pointer; }

.cx-skel { height: 34px; border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--text) 5%, transparent); }
.cx-skel:last-child { border-bottom: 0; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = el("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

// --- shared bits -------------------------------------------------------------

function chip(text, cls) {
  return el("span", cls ? `cx-chip ${cls}` : "cx-chip", text);
}

function panel(heading, meta) {
  const p = el("section", "cx-panel");
  if (heading) {
    const h = el("h3", null, heading);
    if (meta) h.append(el("span", "cx-muted", meta));
    p.append(h);
  }
  return p;
}

function skeleton(rows) {
  const box = el("div", "cx-tablewrap");
  for (let i = 0; i < rows; i++) box.append(el("div", "cx-skel"));
  return box;
}

/**
 * Errors say what failed and what the server said, because "something went
 * wrong" cannot be acted on. needsWorkspace is not an error: the server uses it
 * to mean "no workspace is selected yet", and it arrives on both ok:true and
 * ok:false responses.
 */
function errorBox(what, result, retry) {
  const box = el("div", "cx-err");
  if (result?.needsWorkspace) {
    box.append(el("b", null, "No workspace yet"));
    box.append(el("div", null, "Create or choose a workspace before customers can be listed."));
  } else {
    box.append(el("b", null, what));
    box.append(el("code", null, result?.error ? String(result.error) : "The server sent no reason."));
  }
  if (retry) box.append(button("Try again", null, retry));
  return box;
}

/**
 * The module contract is render(root, ctx) with no route parameters, so a detail
 * view has to find its own id. shell.js fills two carriers for exactly this:
 * ctx.params.id, and ctx.route whose toString() gives "/customers/acc_1". Both
 * are read, plus location.hash, because only one of them has to survive a change
 * to the shell for the detail view to keep opening.
 *
 * No id at all means "show the list", which is the right default anyway. There
 * is deliberately no `?id=` fallback: that is a generic name on the same URL the
 * shell carries its token on, and a stray one would silently hide the list.
 */
function customerIdFrom(ctx) {
  const direct = ctx?.params?.id ?? ctx?.id ?? ctx?.state?.customerId;
  if (direct) return String(direct);

  const route = ctx?.route ?? ctx?.state?.route ?? location.hash;
  const m = /customers\/([^/?#]+)/.exec(String(route ?? ""));
  return m ? decodeURIComponent(m[1]) : null;
}

// A newer render() must win over an older one's in-flight fetch. Each call takes
// a number and checks it still owns the page before touching the DOM.
let seq = 0;

export async function render(root, ctx) {
  ensureStyles();
  root.replaceChildren();
  const id = customerIdFrom(ctx);
  return id ? renderDetail(root, ctx, id) : renderList(root, ctx);
}

// --- the list ----------------------------------------------------------------

const COLUMNS = [
  { key: "label", head: "State", get: (c) => c.labelText ?? "" },
  { key: "name", head: "Customer", get: (c) => c.name ?? "" },
  { key: "arr", head: "ARR", num: true, get: (c) => c.arr },
  { key: "plan", head: "Plan", get: (c) => c.plan ?? "" },
  { key: "renewal", head: "Renewal", num: true, get: (c) => c.daysToRenewal },
  { key: "owner", head: "Owner", get: (c) => c.owner ?? "" },
  { key: "open", head: "Open", num: true, get: (c) => c.openDecisions ?? 0 },
  { key: "watching", head: "Watching", num: true, get: (c) => c.watching ?? 0 },
];

/**
 * Unknown always sorts last, in both directions. A customer with no renewal date
 * is not "renewing furthest away" and a customer with no state is not "least at
 * risk" — pretending otherwise puts made-up rows at the top of the table.
 */
function compare(col, dir) {
  const sign = dir === "asc" ? 1 : -1;
  return (a, b) => {
    const x = col.get(a);
    const y = col.get(b);
    const xEmpty = x == null || x === "";
    const yEmpty = y == null || y === "";
    if (xEmpty || yEmpty) return xEmpty && yEmpty ? 0 : xEmpty ? 1 : -1;
    if (col.num) return (Number(x) - Number(y)) * sign;
    return String(x).localeCompare(String(y), undefined, { sensitivity: "base" }) * sign;
  };
}

async function renderList(root, ctx) {
  const mine = ++seq;
  const wrap = el("div", "cx");
  root.append(wrap);

  const head = el("div", "cx-head");
  head.append(el("h1", null, "Customers"));
  const headMeta = el("span", "cx-muted");
  head.append(headMeta);
  wrap.append(head, skeleton(6));

  let r;
  try {
    // One fetch, unfiltered. decisionsCustomers has no pagination (total is just
    // the array length), so every account is already here — filtering and
    // sorting in the browser is instant and costs no round-trip per keystroke.
    r = await ctx.api("decisionsCustomers", { query: { sort: "arr" } });
  } catch (e) {
    r = { ok: false, error: e?.message ?? "the request could not be sent" };
  }
  if (mine !== seq) return;

  wrap.replaceChildren(head);
  if (!r?.ok) {
    wrap.append(errorBox("The customer list could not be loaded.", r, () => render(root, ctx)));
    return;
  }

  const all = Array.isArray(r.customers) ? r.customers : [];
  const labels = r.labels && typeof r.labels === "object" ? r.labels : {};
  headMeta.textContent = `${all.length} in this workspace`;

  // The view's filter and sort live in the shared state object, so coming back
  // from a customer page lands on the same table you left. The local fallback is
  // there because a missing ctx.state would otherwise throw on the ??= below.
  const store = ctx.state && typeof ctx.state === "object" ? ctx.state : {};
  const view = (store.customersView ??= { q: "", label: "all", sort: "arr", dir: "desc" });

  if (!r.hasRun) {
    const b = el("div", "cx-err");
    b.append(el("b", null, "The analysis has not run yet"));
    b.append(
      el("div", null, "No customer has a state, a signal or a watch until it does. Everything else below is the imported data."),
    );
    wrap.append(b);
  }

  if (!all.length) {
    const p = panel();
    p.append(el("p", "cx-note", "No customers. Import a data folder, or load the demo company, and they will appear here."));
    wrap.append(p);
    return;
  }

  // --- toolbar
  const bar = el("div", "cx-bar");
  const search = el("input");
  search.type = "search";
  search.placeholder = "Filter by name or id";
  search.value = view.q;
  search.setAttribute("aria-label", "Filter customers");
  bar.append(search);
  bar.append(el("span", "cx-grow"));
  const shown = el("span", "cx-muted");
  bar.append(shown);
  wrap.append(bar);

  // State chips double as the filter. Only the states this API returns are
  // offered; there is no chip for a state nothing computes.
  const chips = el("div", "cx-chipbar");
  const chipFor = (key, text) => {
    const b = button(text, "cx-fchip", () => {
      view.label = key;
      for (const node of chips.children) node.setAttribute("aria-pressed", String(node.dataset.key === key));
      paint();
    });
    b.dataset.key = key;
    b.setAttribute("aria-pressed", String(view.label === key));
    return b;
  };
  chips.append(chipFor("all", "Any state"));
  for (const [key, text] of Object.entries(labels)) chips.append(chipFor(key, text));
  wrap.append(chips);

  // --- table
  const tableWrap = el("div", "cx-tablewrap");
  const table = el("table", "cx-tbl");
  const headRow = el("tr");
  for (const col of COLUMNS) {
    const th = el("th", col.num ? "num" : null);
    const arrow = el("span", "cx-dim");
    const b = button(col.head, null, () => {
      // Same column toggles direction; a new column starts on the sensible side
      // (biggest number first, A-Z for text).
      if (view.sort === col.key) view.dir = view.dir === "asc" ? "desc" : "asc";
      else {
        view.sort = col.key;
        view.dir = col.num ? "desc" : "asc";
      }
      markSort();
      paint();
    });
    b.append(arrow);
    th.append(b);
    th.dataset.key = col.key;
    th._arrow = arrow;
    headRow.append(th);
  }
  // NOT `table.append(el("thead")).lastChild` — Node.append() returns undefined,
  // so that chain throws and takes the whole page with it. Build both explicitly.
  const thead = el("thead");
  thead.append(headRow);
  const tbody = el("tbody");
  table.append(thead);
  table.append(tbody);
  tableWrap.append(table);
  wrap.append(tableWrap);

  function markSort() {
    for (const th of headRow.children) {
      const active = th.dataset.key === view.sort;
      if (active) th.setAttribute("aria-sort", view.dir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
      th._arrow.textContent = active ? (view.dir === "asc" ? "↑" : "↓") : "";
    }
  }

  function rowFor(c) {
    const tr = el("tr");

    const stateTd = el("td");
    if (c.label && c.labelText) stateTd.append(chip(c.labelText, c.label));
    else {
      // Honest blank: the analysis gives a state, and without one there is none.
      const dash = el("span", "cx-dim", "—");
      dash.title = "The analysis has not given this customer a state.";
      stateTd.append(dash);
    }
    tr.append(stateTd);

    const nameTd = el("td");
    nameTd.append(button(c.name ?? c.id, "cx-name", () => ctx.go(`customers/${c.id}`)));
    if (c.staleData) nameTd.append(document.createTextNode(" "), chip("stale data", "watching"));
    tr.append(nameTd);

    tr.append(el("td", "num", c.arrLabel ?? (c.arr == null ? "—" : String(c.arr))));
    tr.append(el("td", c.plan ? null : "cx-dim", c.plan || "—"));

    const renewTd = el("td", c.renewalDate ? null : "cx-dim");
    if (c.renewalDate) {
      renewTd.append(document.createTextNode(c.renewalDate));
      if (c.daysToRenewal != null) {
        renewTd.append(
          el("span", "cx-dim", ` · ${fmt(ctx, "days", c.daysToRenewal, `${c.daysToRenewal}d`)}`),
        );
      }
    } else renewTd.textContent = "—";
    tr.append(renewTd);

    tr.append(el("td", c.owner ? null : "cx-dim", c.owner || "—"));
    tr.append(el("td", "num", String(c.openDecisions ?? 0)));
    tr.append(el("td", "num", String(c.watching ?? 0)));
    return tr;
  }

  // Rows go in 60 at a time so a few thousand customers cannot freeze the tab.
  // Each paint cancels the one before it, which is what makes typing in the
  // filter box stay responsive.
  let job = null;
  function paint() {
    const q = view.q.trim().toLowerCase();
    let rows = all;
    if (q) rows = rows.filter((c) => `${c.name ?? ""} ${c.id ?? ""}`.toLowerCase().includes(q));
    if (view.label !== "all") rows = rows.filter((c) => c.label === view.label);
    const col = COLUMNS.find((c) => c.key === view.sort) ?? COLUMNS[2];
    rows = rows.slice().sort(compare(col, view.dir));

    shown.textContent = rows.length === all.length ? `${all.length} customers` : `${rows.length} of ${all.length}`;

    // Cancel BEFORE clearing, and before any early return: a chunk loop left
    // running would happily append its stale rows into the table we just emptied.
    if (job) job.cancelled = true;
    tbody.replaceChildren();
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "cx-dim", "No customer matches this filter.");
      td.colSpan = COLUMNS.length;
      tr.append(td);
      tbody.append(tr);
      return;
    }

    const me = (job = { cancelled: false });
    let i = 0;
    const step = () => {
      if (me.cancelled || mine !== seq || !tbody.isConnected) return;
      const frag = document.createDocumentFragment();
      const end = Math.min(i + 60, rows.length);
      for (; i < end; i++) frag.append(rowFor(rows[i]));
      tbody.append(frag);
      if (i < rows.length) requestAnimationFrame(step);
    };
    step();
  }

  search.addEventListener("input", () => {
    view.q = search.value;
    paint();
  });

  markSort();
  paint();
}

// --- one customer ------------------------------------------------------------

async function renderDetail(root, ctx, id) {
  const mine = ++seq;
  const wrap = el("div", "cx");
  root.append(wrap);

  const back = button("← All customers", "cx-back", () => ctx.go("customers"));
  const head = el("div", "cx-head");
  head.append(el("h1", null, id));
  wrap.append(back, head, skeleton(4));

  let r;
  try {
    r = await ctx.api("decisionsCustomer", { query: { id } });
  } catch (e) {
    r = { ok: false, error: e?.message ?? "the request could not be sent" };
  }
  if (mine !== seq) return;

  wrap.replaceChildren(back);
  if (!r?.ok) {
    wrap.append(errorBox("This customer could not be loaded.", r, () => render(root, ctx)));
    return;
  }

  // NOTE the raw account columns stay snake_case (seats_purchased, renewal_date,
  // created_at, segment, industry); only arrLabel, tenureDays, daysToRenewal,
  // label and labelText are camelCase additions. Reading a.renewalDate here
  // would render undefined.
  const a = r.account ?? {};
  const signals = Array.isArray(r.signals) ? r.signals : [];
  const decisions = Array.isArray(r.decisions) ? r.decisions : [];
  const contacts = Array.isArray(r.contacts) ? r.contacts : [];
  const data = r.data ?? {};

  head.replaceChildren();
  head.append(el("h1", null, a.name ?? id));
  if (a.label && a.labelText) head.append(chip(a.labelText, a.label));
  if (r.asOf) head.append(el("span", "cx-muted", `as of ${r.asOf}`));
  wrap.append(head);

  const open = decisions.filter((d) => OPEN_STATUSES.has(d.status));
  const past = decisions.filter((d) => !OPEN_STATUSES.has(d.status));
  const watching = signals.filter((s) => s.isWatch);

  // --- metric tiles
  const tiles = el("div", "cx-tiles");
  const tile = (k, v, sub) => {
    const t = el("div", "cx-tile");
    t.append(el("div", "k", k));
    t.append(el("div", "v", v));
    if (sub) t.append(el("div", "s", sub));
    tiles.append(t);
  };
  tile("ARR", a.arrLabel ?? (a.arr == null ? "—" : String(a.arr)), a.plan ? `${a.plan} plan` : null);
  tile(
    "Renewal",
    a.daysToRenewal == null ? "—" : fmt(ctx, "days", a.daysToRenewal, `${a.daysToRenewal} days`),
    a.renewal_date || "no renewal date",
  );
  tile(
    "Customer for",
    a.tenureDays == null ? "—" : fmt(ctx, "days", a.tenureDays, `${a.tenureDays} days`),
    a.created_at ? `since ${a.created_at}` : null,
  );
  tile("Open decisions", String(open.length), past.length ? `${past.length} closed` : null);
  tile("Signals", String(signals.length), watching.length ? `${watching.length} watched only` : null);
  tile("Seats bought", a.seats_purchased == null ? "—" : String(a.seats_purchased));
  wrap.append(tiles);

  // --- the facts
  const facts = panel("Account");
  const kv = el("dl", "cx-kv");
  const pair = (k, v) => {
    kv.append(el("dt", null, k));
    kv.append(el("dd", v ? null : "cx-dim", v || "—"));
  };
  pair("Owner", a.owner);
  pair("Segment", a.segment);
  pair("Industry", a.industry);
  pair("Account id", a.id);
  const factBody = el("div", "cx-body");
  factBody.append(kv);
  facts.append(factBody);
  wrap.append(facts);

  // --- people
  if (contacts.length) {
    const p = panel("People", `${contacts.length}`);
    for (const c of contacts) {
      const row = el("div", "cx-row");
      const who = el("div", "s");
      who.append(document.createTextNode(c.name || "Unnamed"));
      if (c.role) who.append(el("span", "cx-dim", ` · ${c.role}`));
      row.append(who);
      // is_champion is a raw SQLite column, so it arrives as 1/0, not true/false.
      if (Number(c.is_champion) === 1) row.append(chip("main contact", "plain"));
      row.append(
        el("div", "when", c.quietDays == null ? "" : c.quietDays === 0 ? "active today" : `quiet ${c.quietDays}d`),
      );
      p.append(row);
    }
    wrap.append(p);
  }

  // --- signals
  const sig = panel("Signals in the last analysis", signals.length ? `${signals.length}` : null);
  if (!signals.length) {
    sig.append(
      el("p", "cx-note", "No signals. Either nothing has changed for this customer, or the analysis has not run yet."),
    );
  } else {
    for (const s of signals) {
      const row = el("div", "cx-row");
      const body = el("div", "s");
      body.append(el("div", null, s.statement || s.label || s.kind));
      const bits = [];
      if (s.label && s.statement) bits.push(s.label);
      // The null check is load-bearing: Number(null) is 0, and 0 is finite, so
      // isFinite alone turns "no change was measured" into "change 0%".
      if (s.change_pct != null && Number.isFinite(Number(s.change_pct))) bits.push(`change ${Number(s.change_pct)}%`);
      if (s.window_days != null) bits.push(`over ${s.window_days} days`);
      if (s.threshold != null) bits.push(`threshold ${s.threshold}`);
      if (bits.length) body.append(el("div", "t", bits.join(" · ")));
      if (s.isWatch) body.append(el("div", "t", "Watching only — one signal on its own is never a decision."));
      if (s.detail?.unreliable) body.append(el("div", "t", "The usage data is out of date, so this is not being acted on."));
      row.append(body);
      const band = BAND_WORDS[s.band];
      if (band) row.append(chip(band, s.band >= 3 ? "sev-high" : s.band === 2 ? "sev-medium" : "sev-low"));
      sig.append(row);
    }
  }
  wrap.append(sig);

  // --- decisions
  wrap.append(decisionPanel(ctx, "Open decisions", open, "Nothing open for this customer."));
  if (past.length) wrap.append(decisionPanel(ctx, "Closed decisions", past, null));

  // --- the data behind it
  const dp = panel("The data behind this");
  const kv2 = el("dl", "cx-kv");
  const pair2 = (k, v) => {
    kv2.append(el("dt", null, k));
    kv2.append(el("dd", null, v));
  };
  pair2("Usage runs to", data.lastUsageDay ?? "no usage data");
  pair2("Usage rows", String(data.usageRows ?? 0));
  pair2("Tickets", String(data.tickets ?? 0));
  pair2("Invoices", String(data.invoices ?? 0));
  pair2("Events", String(data.events ?? 0));
  const dpBody = el("div", "cx-body");
  dpBody.append(kv2);
  dp.append(dpBody);
  wrap.append(dp);

  // --- activity, appended once it arrives so a slow or failed second fetch
  // never blocks the customer page itself.
  const act = panel("Activity");
  act.append(el("div", "cx-skel"), el("div", "cx-skel"));
  wrap.append(act);
  fillActivity(act, ctx, decisions, mine).catch((e) => {
    if (act.isConnected) act.append(el("p", "cx-note", `The activity could not be shown: ${e?.message ?? e}`));
  });
}

function decisionPanel(ctx, heading, list, emptyText) {
  const p = panel(heading, list.length ? `${list.length}` : null);
  if (!list.length) {
    p.append(el("p", "cx-note", emptyText ?? "None."));
    return p;
  }
  const ordered = list
    .slice()
    .sort((x, y) => (SEVERITY_ORDER[x.severity] ?? 9) - (SEVERITY_ORDER[y.severity] ?? 9));
  for (const d of ordered) p.append(decisionCard(ctx, d));
  return p;
}

function decisionCard(ctx, d) {
  // A div, not a <button>: the card holds a <ul> of evidence, and block content
  // inside a button is invalid HTML that browsers lay out unpredictably.
  const card = el("div", "cx-dec");
  const open = () => ctx.go(`decisions/${d.id}`);
  card.setAttribute("role", "button");
  card.tabIndex = 0;
  card.addEventListener("click", open);
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  });

  const top = el("div", "top");
  top.append(el("span", "ttl", d.title ?? d.id));
  if (d.severity) top.append(chip(d.severity, `sev-${d.severity}`));
  if (d.statusLabel) top.append(chip(d.statusLabel, "plain"));
  if (d.impactLabel) top.append(chip(d.impactLabel, "plain"));
  // ruleOnly means the model never reasoned about this one. Saying so is the
  // difference between a recommendation and a threshold being crossed.
  if (d.ruleOnly) top.append(chip("rules only", "plain"));
  if (d.signalsEased) top.append(chip("signals eased", "plain"));
  card.append(top);

  const sub = [];
  if (d.owner) sub.push(d.owner);
  if (d.overdueDays != null) sub.push(`${d.overdueDays} days overdue`);
  else if (d.dueAt) sub.push(`due ${d.dueAt}`);
  if (d.snoozedUntil) sub.push(`back on ${d.snoozedUntil}`);
  if (d.ageDays != null) sub.push(`raised ${d.ageDays}d ago`);
  if (d.confidence) sub.push(`${d.confidence} confidence`);
  if (sub.length) card.append(el("div", "sub", sub.join(" · ")));

  if (d.recommendation) card.append(el("div", "sub", `Recommended: ${d.recommendation}`));

  if (Array.isArray(d.evidence) && d.evidence.length) {
    const ul = el("ul");
    for (const line of d.evidence) ul.append(el("li", null, line));
    card.append(ul);
  }
  return card;
}

/**
 * There is no per-customer activity route: decisionsActivity is global, and its
 * decision entries carry decisionId but never accountId (the SQL selects it and
 * drops it). So the only honest filter is "events on decisions that belong to
 * this customer" — which also drops run entries, since those have no decisionId.
 * The limit is capped at 400 server-side, so older activity can be missing, and
 * the panel says so when the cap was hit.
 */
async function fillActivity(p, ctx, decisions, mine) {
  const ids = new Set(decisions.map((d) => d.id));
  let r;
  try {
    r = await ctx.api("decisionsActivity", { query: { filter: "all", limit: "400" } });
  } catch (e) {
    r = { ok: false, error: e?.message ?? "the request could not be sent" };
  }
  if (mine !== seq || !p.isConnected) return;

  const heading = p.querySelector("h3");
  p.replaceChildren(...(heading ? [heading] : []));

  if (!r?.ok) {
    const box = errorBox("The activity could not be loaded.", r, null);
    box.style.margin = "12px 14px";
    p.append(box);
    return;
  }

  const all = Array.isArray(r.entries) ? r.entries : [];
  const mineOnly = all.filter((e) => e.decisionId && ids.has(e.decisionId));

  if (!ids.size) {
    p.append(el("p", "cx-note", "This customer has no decisions yet, so there is nothing to show."));
    return;
  }
  if (!mineOnly.length) {
    p.append(el("p", "cx-note", "Nothing has happened on this customer's decisions yet."));
    return;
  }

  for (const e of mineOnly) {
    const row = el("div", "cx-row");
    const body = el("div", "s");
    body.append(el("div", null, describeEvent(e)));
    if (e.title) body.append(el("div", "t", e.title));
    row.append(body);
    row.append(el("div", "when", `${e.actor === "user" ? "you" : "system"} · ${whenText(ctx, e.at)}`));
    p.append(row);
  }

  if (all.length >= 400) {
    p.append(
      el("p", "cx-note", "This is the newest 400 entries across every customer, so older activity on this one is not shown."),
    );
  }
}

/**
 * Event kinds are not in the route contract — the route returns kind:string and
 * data:object|null. These strings come from describeEvent in the shipped
 * decisions page, so they are the real kinds this database writes; anything
 * unknown falls through to the raw kind rather than being guessed at.
 */
function describeEvent(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case "created":
      return `Raised as ${d.severity}${d.source === "rule_only" ? " (from the rules; the AI was not available)" : ""}`;
    case "updated":
      return `Updated — severity ${d.from} to ${d.to}`;
    case "escalated":
      return `Got worse — severity ${d.from} to ${d.to}`;
    case "status":
      return `Status: ${d.from} to ${d.to}${d.because ? ` (${d.because})` : ""}`;
    case "owner":
      return `Owner set to ${d.to ?? "nobody"}`;
    case "due":
      return `Due date set to ${d.to ?? "none"}`;
    case "snoozed":
      return `Snoozed until ${d.until}`;
    case "unsnoozed":
      return `Came back — ${d.reason}`;
    case "dismissed":
      return `Dismissed: ${d.reason}`;
    case "resolved":
      return `Resolved: ${d.result}`;
    case "outcome":
      return `Outcome recorded: ${d.result}`;
    case "reminder":
      return d.daysOverdue != null ? `Reminder — ${d.daysOverdue} days overdue` : `Reminder — waiting ${d.waitingDays} days`;
    case "action_prepared":
      return `${d.kind === "task" ? "Task created" : "Email drafted"}${d.source === "template" ? " (standard wording; the AI was not available)" : ""}`;
    case "action_done":
      return `${d.kind === "task" ? "Task" : "Email"} marked done`;
    case "action_cancelled":
      return `${d.kind === "task" ? "Task" : "Email"} cancelled`;
    case "note":
      return d.text ?? "Note";
    default:
      return String(e.kind ?? "").replace(/_/g, " ") || "Activity";
  }
}
