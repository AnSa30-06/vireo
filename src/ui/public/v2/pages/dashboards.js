// v2 / Dashboards — saved metrics, saved charts, and the boards they sit on.
//
// WHY THIS SCREEN IS BUILT THE WAY IT IS
//
// The competitor meters saved metrics, saved charts, saved dashboards and charts
// per dashboard on every pricing tier, so this is core surface. It is also where
// a BI tool quietly goes wrong: a number on a board, a definition in a settings
// blob somewhere else, and months of people trusting a figure nobody can restate.
//
// So on this screen the definition is part of the number, not documentation:
//
//   1. EVERY NUMBER CARRIES ITS DEFINITION, in English, directly under it. Not
//      in a tooltip, not behind an info icon. "Count of decisions, where Status
//      is new, raised in the last 30 days (17 Aug to 15 Sep 2026)."
//   2. THAT SENTENCE IS A BUTTON. One click from the number opens the editor on
//      the metric that produced it. Fixing a wrong number never means leaving
//      the answer and going to look for a settings page.
//   3. NO NUMBER WITHOUT ITS EVIDENCE. Every tile can show the records it was
//      counted from, and each one links to the decision or the customer.
//   4. WHAT WAS LEFT OUT IS PRINTED TOO — rows the window could not place, rows
//      that carry no amount, groups folded into Other. A number that quietly
//      dropped forty rows is the kind of number that gets believed.
//
// 🔴 WHERE THE COUNTING HAPPENS, AND WHY IT IS NOT HERE. Every value, every
// series and every row on this page is computed by src/decisions/metrics.mjs.
// This file does no arithmetic over the data at all — not even the preview under
// the editor, which calls the same route the dashboard does. Two implementations
// of one metric can only drift, and a preview that disagrees with the saved tile
// is the exact failure this screen exists to prevent.
//
// ALSO OWNED BY THE SERVER, so this file cannot contradict it: the source list,
// the measures each source allows, the operators per field type, the windows,
// the shapes and the groupings. All of it arrives from decisionsMetrics. A menu
// offering something the server would refuse is a dead end found by walking into
// it.
//
// Every string reaches the DOM through textContent. Customer names, decision
// titles and ticket subjects all pass through this page; innerHTML is never used.

export const title = "Dashboards";

// The charts belong to another module in this surface. A static import would
// read better, but a missing module — or a missing named export — is a LINK-time
// failure in ESM: the whole page would fail to load. So they are pulled in
// lazily and every drawing degrades to the numbers printed beside it.
let charts = null;
const chartsReady = import("../components/charts.js")
  .then((m) => {
    charts = m;
  })
  .catch(() => {
    charts = null;
  });

/* ══ THE BACKEND ═══════════════════════════════════════════════════════════
 *
 * The single seam between this screen and the server.
 *
 * 🔴 EVERY ROUTE NAME IS A LITERAL INSIDE ITS OWN ctx.api(...) CALL, never a
 * variable handed to a helper. tests/unit/v2-ui.test.mjs checks the routes this
 * page calls by reading this source for quoted names in api() calls, and a name
 * routed through a variable slips past that check — the first sign of a typo
 * would then be an empty tile rather than a failing test.
 *
 * The server parses a request body only for POST, so everything that carries
 * arguments goes out as POST. The one argument-free read stays a GET.
 */
function backend(ctx) {
  const post = (body) => ({ method: "POST", body });
  return {
    load: () => ctx.api("decisionsMetrics"),
    board: (id) => ctx.api("decisionsDashboard", post({ id, limit: 0 })),
    compute: (definition, groupBy, limit) => ctx.api("decisionsMetricCompute", post({ definition, groupBy, limit })),
    chartRows: (id, limit) => ctx.api("decisionsChartCompute", post({ id, limit })),
    metricCreate: (m) => ctx.api("decisionsMetricCreate", post(m)),
    metricUpdate: (m) => ctx.api("decisionsMetricUpdate", post(m)),
    metricDelete: (id) => ctx.api("decisionsMetricDelete", post({ id })),
    chartCreate: (c) => ctx.api("decisionsChartCreate", post(c)),
    chartUpdate: (c) => ctx.api("decisionsChartUpdate", post(c)),
    chartDelete: (id) => ctx.api("decisionsChartDelete", post({ id })),
    boardCreate: (name) => ctx.api("decisionsDashboardCreate", post({ name })),
    boardUpdate: (b) => ctx.api("decisionsDashboardUpdate", post(b)),
    boardDelete: (id) => ctx.api("decisionsDashboardDelete", post({ id })),
  };
}

/** A route that answered ok:false, or threw, said one of these. Never invent a third. */
const reasonFrom = (res, err) =>
  err ? String(err?.message ?? err) : String(res?.error ?? "the server did not say what went wrong");

/* ══ tiny DOM helpers ══════════════════════════════════════════════════════ */

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

function select(options, value, onChange) {
  const s = el("select", "md-sel");
  for (const [v, label] of options) {
    const o = el("option", null, label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function input(value, placeholder, onInput, cls) {
  const i = el("input", `md-in ${cls ?? ""}`);
  i.type = "text";
  i.value = value ?? "";
  if (placeholder) i.placeholder = placeholder;
  i.addEventListener("input", () => onInput(i.value));
  return i;
}

function labelled(text, node) {
  const wrap = el("label", "md-field");
  wrap.append(el("span", "md-field-l", text));
  wrap.append(node);
  return wrap;
}

/**
 * ctx.fmt is written by a sibling agent in this same build, so every call is
 * guarded: a missing or throwing helper degrades to a readable fallback rather
 * than taking the page down.
 */
function dateText(ctx, iso) {
  if (!iso) return "";
  const fn = ctx?.fmt?.date;
  if (typeof fn === "function") {
    try {
      const out = fn(String(iso).slice(0, 10));
      if (out != null && out !== "") return String(out);
    } catch {
      /* fall through to the raw value */
    }
  }
  return String(iso).slice(0, 10);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Wait for typing to stop, then run.
 *
 * ⚠️ THE SEQUENCE NUMBER IS NOT DECORATION. Two previews can be in flight at
 * once and the slower can land last, settling the screen on the number for a
 * definition the user has already edited away — the one thing a live preview
 * must never do.
 */
function debounced(ms, fn) {
  let timer = null;
  let issued = 0;
  return (...args) => {
    clearTimeout(timer);
    const mine = ++issued;
    timer = setTimeout(() => fn(() => mine === issued, ...args), ms);
  };
}

/* ══ STYLES ════════════════════════════════════════════════════════════════
 *
 * One stylesheet, injected once, every selector scoped under .md so it cannot
 * reach the shell or a sibling page. CSP allows this (style-src 'self'
 * 'unsafe-inline'). Colours are tokens from tokens.css or a color-mix over one,
 * never a literal, so both themes follow with no branch here.
 */
const STYLE_ID = "v2-dashboards-style";
const CSS = `
.md { display: flex; flex-direction: column; gap: var(--s4); max-width: 1180px; }
.md-head { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.md-head h2 { margin: 0; }
.md-muted { color: var(--muted); font-size: var(--fs-sm); }
.md-grow { flex: 1 1 auto; }
.md-row { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }

.md-boards { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }

.md-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.md-card > header { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap;
  padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
.md-card > header h3 { font-size: var(--fs-md); margin: 0; }
.md-body { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.md-body.flush { padding: 0; }

/* The tiles. Two across on a wide screen, one on a narrow one. */
.md-tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: var(--s3); }
.md-tile { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  display: flex; flex-direction: column; }
.md-tile > header { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap;
  padding: var(--s3) var(--s4) 0; }
.md-tile > header h4 { font-size: var(--fs-md); margin: 0; }
.md-tile-body { padding: var(--s3) var(--s4) var(--s4); display: flex; flex-direction: column; gap: var(--s3); }

.md-big { font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -0.02em; line-height: 1.1;
  font-variant-numeric: tabular-nums; }
.md-of { color: var(--muted); font-size: var(--fs-sm); margin-left: var(--s2); }

/* ⭐ THE DEFINITION, UNDER THE NUMBER AND CLICKABLE. The whole point of the
   screen, so it is a real target and not small print. */
.md-def { display: block; width: 100%; text-align: left; background: var(--panel-2);
  border: 1px solid var(--border-soft); border-radius: var(--radius-sm);
  padding: 7px 10px; color: var(--text); font: inherit; font-size: var(--fs-sm); line-height: var(--lh-body); }
.md-def:hover { border-color: var(--accent); }
.md-def .md-pen { color: var(--accent); font-size: var(--fs-xs); margin-left: 6px; white-space: nowrap; }

.md-note { color: var(--muted); font-size: var(--fs-xs); line-height: 1.5; }
.md-note b { color: var(--warn); font-weight: 650; }

/* Bars are DOM, not SVG: a horizontal bar list is layout, and the two real
   visuals (the line and the unit grid) come from components/charts.js. */
.md-bars { display: flex; flex-direction: column; gap: 5px; }
.md-bar { display: grid; grid-template-columns: minmax(70px, 30%) 1fr auto; gap: var(--s2);
  align-items: center; font-size: var(--fs-sm); }
.md-bar-l { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-bar-track { background: var(--panel-2); border-radius: var(--radius-pill); height: 10px; overflow: hidden; }
.md-bar-fill { background: var(--accent); height: 100%; border-radius: var(--radius-pill); }
.md-bar-v { font-variant-numeric: tabular-nums; }

.md-spark { display: flex; flex-direction: column; gap: 4px; }
.md-spark-ends { display: flex; justify-content: space-between; color: var(--muted); font-size: var(--fs-xs); }

.md-rows { display: flex; flex-direction: column; border-top: 1px solid var(--border-soft); }
.md-rowitem { display: flex; align-items: center; gap: var(--s3); padding: 7px var(--s4);
  border-top: 1px solid var(--border-soft); font-size: var(--fs-sm); text-align: left; width: 100%;
  background: transparent; border-left: 0; border-right: 0; border-bottom: 0; color: inherit; }
.md-rowitem:first-child { border-top: 0; }
.md-rowitem.link:hover { background: var(--panel-2); }
.md-rowitem .md-rl { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.md-rowitem .md-rm { color: var(--muted); font-size: var(--fs-xs); }
.md-rowitem .md-ra { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }

.md-sel, .md-in { background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 6px 9px; font-size: var(--fs-sm); font-family: inherit; }
.md-sel:focus, .md-in:focus { border-color: var(--muted); }
.md-in { min-width: 150px; }
.md-in.wide { flex: 1 1 240px; }
.md-field { display: flex; flex-direction: column; gap: 4px; }
.md-field-l { font-size: var(--fs-xs); color: var(--muted); font-variant-caps: all-small-caps;
  letter-spacing: .07em; font-weight: 650; }
.md-form { display: flex; gap: var(--s3); flex-wrap: wrap; align-items: flex-end; }

.md-filter { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.md-x { background: transparent; border: 0; color: var(--muted); font-size: var(--fs-md);
  line-height: 1; padding: 4px 7px; border-radius: var(--radius-sm); }
.md-x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

.md-preview { border: 1px dashed color-mix(in srgb, var(--accent) 50%, var(--border));
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  border-radius: var(--radius); padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.md-preview.pending { opacity: .45; }

.md-item { display: flex; align-items: center; gap: var(--s3); padding: var(--s3) var(--s4);
  border-top: 1px solid var(--border-soft); flex-wrap: wrap; }
.md-item:first-child { border-top: 0; }
.md-item h4 { font-size: var(--fs-md); margin: 0; }
.md-item .md-col { display: flex; flex-direction: column; gap: 3px; min-width: 200px; flex: 1 1 260px; }

.md-inline-err { color: var(--danger); font-size: var(--fs-sm); }
.md-tile-err { border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
  background: color-mix(in srgb, var(--danger) 8%, transparent);
  border-radius: var(--radius-sm); padding: var(--s3); font-size: var(--fs-sm); }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

/* ══ THE VOCABULARY, AS THE SERVER DESCRIBES IT ════════════════════════════
 *
 * Nothing below hardcodes a source, a measure, an operator or a grouping: a
 * source added on the server appears here with no change to this file, and one
 * removed stops being offered.
 */

const sourceById = (view, id) => view.sources.find((s) => s.id === id) ?? null;
const fieldById = (source, id) => source?.fields.find((f) => f.id === id) ?? null;
const opsFor = (view, field) => view.ops[field?.type] ?? view.ops.text ?? [];
const opEntry = (view, field, op) => opsFor(view, field).find(([v]) => v === op) ?? null;
/** The server says which operators take a value; blank/notblank do not. */
const needsValue = (view, field, op) => opEntry(view, field, op)?.[2] === true;

const MEASURE_WORDS = { count: "Count of rows", sum: "Sum", avg: "Average" };

function measureOptions(source) {
  return (source?.measures ?? []).map((m) => [
    m,
    m === "count"
      ? "Count of rows"
      : `${MEASURE_WORDS[m] ?? m} of ${source.amountLabel ?? "amount"}`,
  ]);
}

const blankDefinition = (view) => {
  const source = view.sources[0];
  return { source: source?.id ?? "", measure: "count", window: "all", filters: [] };
};

const cloneMetric = (m) => ({
  id: m?.id ?? null,
  name: m?.name ?? "",
  description: m?.description ?? "",
  definition: {
    source: m?.definition?.source ?? "",
    measure: m?.definition?.measure ?? "count",
    window: m?.definition?.window ?? "all",
    filters: (m?.definition?.filters ?? []).map((f) => ({ ...f })),
  },
});

/* ══ RENDER ════════════════════════════════════════════════════════════════ */

export async function render(root, ctx) {
  ensureStyles();
  root.replaceChildren();

  const page = el("div", "md");
  root.append(page);

  const loading = el("div");
  for (let i = 0; i < 3; i++) loading.append(el("div", "skeleton block"));
  page.append(loading);

  // One call for everything the editor needs: the saved metrics with their
  // current numbers, the charts, the boards, and the vocabulary. Its failure
  // ends the page, because without the vocabulary there is no editor to show.
  const api = backend(ctx);
  let data;
  try {
    data = await api.load();
  } catch (err) {
    loading.remove();
    page.append(errorBox("Dashboards could not be read", reasonFrom(null, err)));
    return;
  }
  await chartsReady;
  loading.remove();

  if (!data?.ok) {
    // needsWorkspace is normally caught by the shell, but a direct #/dashboards
    // hit can land here before status has been read.
    page.append(
      errorBox(data?.needsWorkspace ? "No workspace is open" : "Dashboards could not be read", reasonFrom(data)),
    );
    return;
  }

  // Everything the sub-renderers need, in one bag, so no function reaches for a
  // closure two levels up.
  const view = {
    ctx,
    api,
    sources: Array.isArray(data.sources) ? data.sources : [],
    ops: data.ops && typeof data.ops === "object" ? data.ops : {},
    windows: Array.isArray(data.windows) ? data.windows : [],
    shapes: Array.isArray(data.shapes) ? data.shapes : [],
    metrics: Array.isArray(data.metrics) ? data.metrics : [],
    charts: Array.isArray(data.charts) ? data.charts : [],
    dashboards: Array.isArray(data.dashboards) ? data.dashboards : [],
    currency: data.currency ?? "USD",
    accounts: Number(data.accounts) || 0,
    decisions: Number(data.decisions) || 0,
    asOf: data.asOf ?? null,
  };

  if (!view.sources.length) {
    page.append(errorBox("Dashboards could not be read", "the server returned nothing this workspace can count"));
    return;
  }

  page.append(headerBar(view));

  if (!view.accounts && !view.decisions) {
    const box = el("div", "empty");
    box.append(el("h3", null, "Nothing to measure yet"));
    box.append(
      el(
        "p",
        null,
        "A metric counts what is in this workspace, and this one has no customers and no decisions in it. Load a folder of CSVs or seed the demo data, then come back.",
      ),
    );
    box.append(button("Go to Data", "btn", () => ctx.go("data")));
    page.append(box);
    return;
  }

  if (!ctx.state.dashboardsView) ctx.state.dashboardsView = { boardId: null, metricDraft: null, chartDraft: null };
  const ui = ctx.state.dashboardsView;
  if (!view.dashboards.some((d) => d.id === ui.boardId)) ui.boardId = view.dashboards[0]?.id ?? null;

  const boardMount = el("div");
  const metricMount = el("div");
  const chartMount = el("div");
  page.append(boardMount, metricMount, chartMount);

  /** Re-read everything from the server. The server is the only copy. */
  async function reload() {
    try {
      const fresh = await api.load();
      if (fresh?.ok) {
        view.metrics = Array.isArray(fresh.metrics) ? fresh.metrics : [];
        view.charts = Array.isArray(fresh.charts) ? fresh.charts : [];
        view.dashboards = Array.isArray(fresh.dashboards) ? fresh.dashboards : [];
        view.notice = null;
      } else {
        view.notice = reasonFrom(fresh);
      }
    } catch (err) {
      view.notice = reasonFrom(null, err);
    }
    if (!view.dashboards.some((d) => d.id === ui.boardId)) ui.boardId = view.dashboards[0]?.id ?? null;
    paintAll();
  }

  /** Open the metric editor on one metric — the one-click path from a number. */
  function editMetric(metric) {
    ui.metricDraft = cloneMetric(metric ?? { definition: blankDefinition(view) });
    paintMetrics(metricMount, view, ui, reload, editMetric);
    metricMount.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function paintAll() {
    paintBoard(boardMount, view, ui, reload, editMetric);
    paintMetrics(metricMount, view, ui, reload, editMetric);
    paintCharts(chartMount, view, ui, reload);
  }

  paintAll();
}

/* ── header ─────────────────────────────────────────────────────────────── */

function headerBar(view) {
  const h = el("div", "md-head");
  h.append(el("h2", null, "Dashboards"));
  const bits = [];
  if (view.accounts) bits.push(plural(view.accounts, "customer", "customers"));
  if (view.decisions) bits.push(plural(view.decisions, "decision", "decisions"));
  if (view.asOf) bits.push(`as of ${dateText(view.ctx, view.asOf)}`);
  h.append(el("span", "md-muted", bits.join(" · ")));
  return h;
}

/** Always says WHAT failed, in the server's own words. .err styles its own <code>. */
function errorBox(heading, detail) {
  const box = el("div", "err");
  box.append(el("strong", null, heading));
  box.append(el("code", null, detail));
  return box;
}

/* ══ THE BOARD ═════════════════════════════════════════════════════════════ */

function paintBoard(mount, view, ui, reload, editMetric) {
  mount.replaceChildren();

  const card = el("div", "md-card");
  const head = el("header");
  head.append(el("h3", null, "Boards"));

  const chips = el("div", "md-boards");
  for (const board of view.dashboards) {
    chips.append(
      button(board.name, `chip ${board.id === ui.boardId ? "on" : ""}`, () => {
        ui.boardId = board.id;
        paintBoard(mount, view, ui, reload, editMetric);
      }),
    );
  }
  head.append(chips);
  head.append(el("div", "md-grow"));

  const newName = input("", "New board name", () => {}, "");
  head.append(newName);
  head.append(
    button("Add board", "btn", async () => {
      const res = await call(() => view.api.boardCreate(newName.value));
      if (!res.ok) return say(head, res.error);
      ui.boardId = res.dashboard?.id ?? ui.boardId;
      await reload();
    }),
  );
  card.append(head);

  const body = el("div", "md-body");
  card.append(body);
  mount.append(card);

  if (view.notice) body.append(el("div", "md-inline-err", view.notice));

  if (!view.dashboards.length) {
    const box = el("div", "empty");
    box.append(el("h3", null, "No boards yet"));
    box.append(el("p", null, "A board is an ordered set of charts. Name one above, then build a metric and a chart below and add it here."));
    body.append(box);
    return;
  }

  const board = view.dashboards.find((d) => d.id === ui.boardId);
  if (!board) return;

  const bar = el("div", "md-row");
  const rename = input(board.name, "Board name", () => {}, "");
  bar.append(rename);
  bar.append(
    button("Rename", "btn", async () => {
      const res = await call(() => view.api.boardUpdate({ id: board.id, name: rename.value }));
      if (!res.ok) return say(bar, res.error);
      await reload();
    }),
  );
  bar.append(el("div", "md-grow"));

  const spare = view.charts.filter((c) => !board.chartIds.includes(c.id));
  if (spare.length) {
    const pick = select(spare.map((c) => [c.id, c.name]), spare[0].id, () => {});
    bar.append(pick);
    bar.append(
      button("Add chart", "btn", async () => {
        const res = await call(() => view.api.boardUpdate({ id: board.id, chartIds: [...board.chartIds, pick.value] }));
        if (!res.ok) return say(bar, res.error);
        await reload();
      }),
    );
  }
  bar.append(
    button("Delete board", "btn danger", async () => {
      const res = await call(() => view.api.boardDelete(board.id));
      if (!res.ok) return say(bar, res.error);
      ui.boardId = null;
      await reload();
    }),
  );
  body.append(bar);

  if (!board.chartIds.length) {
    const box = el("div", "empty");
    box.append(el("h3", null, `"${board.name}" has no charts on it`));
    box.append(
      el(
        "p",
        null,
        view.charts.length
          ? "Pick one from the list above and add it."
          : "Build a metric below, then save a chart from it, then add the chart here.",
      ),
    );
    body.append(box);
    return;
  }

  const tiles = el("div", "md-tiles");
  body.append(tiles);
  for (let i = 0; i < board.chartIds.length; i++) {
    tiles.append(placeholderTile(board.chartIds[i], view));
  }
  loadBoard(tiles, board, view, ui, reload, editMetric);
}

function placeholderTile(chartId, view) {
  const tile = el("div", "md-tile");
  const head = el("header");
  head.append(el("h4", null, view.charts.find((c) => c.id === chartId)?.name ?? "Chart"));
  tile.append(head);
  const body = el("div", "md-tile-body");
  body.append(el("div", "skeleton line"));
  body.append(el("div", "skeleton block"));
  tile.append(body);
  return tile;
}

/**
 * The tiles are computed in ONE call, not one per tile. The dashboard route
 * returns each chart's number and series with no evidence rows; a tile that is
 * asked for its rows fetches them on its own.
 */
async function loadBoard(tiles, board, view, ui, reload, editMetric) {
  const res = await call(() => view.api.board(board.id));
  tiles.replaceChildren();
  if (!res.ok) {
    tiles.append(errorBox("This board could not be computed", res.error));
    return;
  }
  const list = Array.isArray(res.charts) ? res.charts : [];
  if (!list.length) {
    tiles.append(el("p", "md-muted", "This board has no charts on it."));
    return;
  }
  list.forEach((entry, index) => {
    tiles.append(chartTile(entry, index, board, view, ui, reload, editMetric));
  });
}

/* ── one tile ───────────────────────────────────────────────────────────── */

function chartTile(entry, index, board, view, ui, reload, editMetric) {
  const tile = el("div", "md-tile");
  const chart = entry.chart ?? {};
  const result = entry.result ?? null;

  const head = el("header");
  head.append(el("h4", null, chart.name ?? "Chart"));
  if (result?.groupLabel && result.groupBy !== "none") head.append(el("span", "chip", result.groupLabel));
  head.append(el("div", "md-grow"));

  const move = async (to) => {
    const ids = [...board.chartIds];
    const from = ids.indexOf(chart.id);
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    const res = await call(() => view.api.boardUpdate({ id: board.id, chartIds: ids }));
    if (!res.ok) return say(head, res.error);
    await reload();
  };
  const up = button("↑", "btn tiny", () => move(index - 1));
  up.disabled = index === 0;
  up.title = "Move earlier";
  const down = button("↓", "btn tiny", () => move(index + 1));
  down.disabled = index === board.chartIds.length - 1;
  down.title = "Move later";
  head.append(up, down);
  head.append(
    button("Remove", "btn tiny ghost", async () => {
      const res = await call(() =>
        view.api.boardUpdate({ id: board.id, chartIds: board.chartIds.filter((c) => c !== chart.id) }),
      );
      if (!res.ok) return say(head, res.error);
      await reload();
    }),
  );
  tile.append(head);

  const body = el("div", "md-tile-body");
  tile.append(body);

  if (!result) {
    body.append(el("div", "md-tile-err", entry.error ?? "this chart could not be computed"));
    return tile;
  }

  // The number, then the definition, then the drawing. That order is the claim
  // this screen makes: you read what was counted before you read the picture.
  const bigRow = el("div", "md-row");
  bigRow.append(el("span", "md-big", result.valueLabel ?? "—"));
  if (result.measure === "count" && Number.isFinite(Number(result.total))) {
    bigRow.append(el("span", "md-of", `of ${Number(result.total).toLocaleString("en-US")} ${result.nounPlural}`));
  }
  body.append(bigRow);
  body.append(definitionButton(result.definitionText, view, chart.metricId, editMetric));

  const drawing = drawChart(chart.shape, result, view);
  if (drawing) body.append(drawing);

  const notes = noteLines(result);
  if (notes.length) {
    const box = el("div", "md-note");
    notes.forEach((line, i) => {
      if (i) box.append(document.createElement("br"));
      box.append(document.createTextNode(line));
    });
    body.append(box);
  }

  const rowsMount = el("div");
  const toggle = button(`Show the ${plural(result.count, "row", "rows")} behind this`, "btn tiny", async () => {
    if (rowsMount.firstChild) {
      rowsMount.replaceChildren();
      toggle.textContent = `Show the ${plural(result.count, "row", "rows")} behind this`;
      return;
    }
    toggle.disabled = true;
    const res = await call(() => view.api.chartRows(chart.id, 50));
    toggle.disabled = false;
    if (!res.ok) {
      rowsMount.append(el("div", "md-inline-err", res.error));
      return;
    }
    toggle.textContent = "Hide the rows";
    rowsMount.append(rowList(res.result, view));
  });
  toggle.disabled = !result.count;
  body.append(toggle, rowsMount);
  return tile;
}

/**
 * ⭐ THE DEFINITION IS THE BUTTON. Clicking the sentence opens the editor on the
 * metric that produced the number above it — the one click this feature exists
 * for. The sentence itself comes from the server; this page never writes one.
 */
function definitionButton(text, view, metricId, editMetric) {
  const metric = view.metrics.find((m) => m.id === metricId) ?? null;
  const b = button("", "md-def", () => editMetric(metric));
  b.append(document.createTextNode(text ?? "this metric's definition could not be read"));
  b.append(el("span", "md-pen", metric ? "edit" : "metric missing"));
  b.disabled = !metric;
  b.title = metric ? "Edit this definition" : "The metric behind this number is gone";
  return b;
}

/** What the number left out. Silence here would be the dishonest option. */
function noteLines(result) {
  const notes = [];
  if (result.undated > 0) {
    notes.push(
      `${plural(result.undated, "row is", "rows are")} outside this window because they carry no date.`,
    );
  }
  if (result.missingAmount > 0) {
    notes.push(`${plural(result.missingAmount, "row", "rows")} of ${result.count} carry no amount and add nothing.`);
  }
  if (result.otherGroups > 0) {
    notes.push(`The smallest ${plural(result.otherGroups, "group is", "groups are")} folded into Other.`);
  }
  if (result.bucketsDropped > 0) {
    notes.push(`The oldest ${plural(result.bucketsDropped, "bucket is", "buckets are")} not drawn.`);
  }
  return notes;
}

/* ── the drawings ───────────────────────────────────────────────────────── */

/**
 * Every drawing degrades to nothing rather than throwing: the numbers and the
 * definition above it are the answer, and the picture is how it reads faster.
 */
function drawChart(shape, result, view) {
  try {
    if (shape === "unit-dot") return dotChart(result);
    if (shape === "line") return lineChart(result, view);
    return barChart(result);
  } catch {
    return null;
  }
}

function dotChart(result) {
  if (!charts || typeof charts.dotGrid !== "function") return null;
  const wrap = el("div");
  wrap.append(
    charts.dotGrid({
      filled: result.count,
      total: result.total,
      caption: `${result.count} of ${result.total} ${result.nounPlural}`,
      noun: result.noun,
      nounPlural: result.nounPlural,
    }),
  );
  return wrap;
}

function lineChart(result, view) {
  const series = Array.isArray(result.series) ? result.series : [];
  if (!series.length) return el("p", "md-muted", "No rows fell inside this window, so there is no line to draw.");
  if (!charts || typeof charts.sparkline !== "function") return barChart(result);

  const wrap = el("div", "md-spark");
  wrap.append(charts.sparkline({ values: series.map((p) => p.value), width: 300, height: 56 }));
  const ends = el("div", "md-spark-ends");
  ends.append(el("span", null, series[0].label));
  ends.append(el("span", null, series[series.length - 1].label));
  wrap.append(ends);
  return wrap;
}

/**
 * Bars are DOM boxes, not SVG. A width in percent is layout; the two real
 * visuals in this surface live in components/charts.js and are reused above.
 */
function barChart(result) {
  const series = Array.isArray(result.series) ? result.series : [];
  if (!series.length) return el("p", "md-muted", "Nothing matched, so there are no bars to draw.");
  const max = series.reduce((m, p) => (Number.isFinite(Number(p.value)) ? Math.max(m, Number(p.value)) : m), 0);

  // 🔴 THE MOST RECENT BARS, AND THE COUNT SAID OUT LOUD.
  //
  // This used to be series.slice(0, 14) with nothing printed. A field grouping
  // is folded by the server at twelve groups plus an honest "Other", so it was
  // safe; a TIME grouping is not folded and can return up to 370 buckets, so the
  // page silently kept the OLDEST fourteen. Measured on three years of data:
  // grouped by month, 37 buckets existed, 14 bars were drawn carrying 42 of 110
  // rows, and nothing on screen said so. Grouped by week it was 10 rows of 110.
  //
  // It is the DEFAULT path, not an edge case - a new chart opens as a bar and
  // the grouping defaults to "By day" - so the first chart most people make was
  // the worst case, showing the oldest days and hiding every recent one.
  //
  // Time reads left to right and the interesting end is the right one, so the
  // newest are kept. A field grouping arrives sorted biggest-first, where the
  // interesting end is the start, so those are kept from the front.
  const isTime = series.length > 1 && /^\d{4}-\d{2}/.test(String(series[0].key ?? series[0].label ?? ""));
  const MAX_BARS = 14;
  const shown = series.length <= MAX_BARS ? series : isTime ? series.slice(-MAX_BARS) : series.slice(0, MAX_BARS);
  const hidden = series.length - shown.length;

  const box = el("div", "md-bars");
  if (hidden > 0) {
    box.append(
      el(
        "p",
        "md-muted",
        isTime
          ? `Showing the most recent ${shown.length} of ${series.length}. The earlier ${hidden} are counted in the number above but not drawn.`
          : `Showing the largest ${shown.length} of ${series.length}. The other ${hidden} are counted in the number above but not drawn.`,
      ),
    );
  }
  for (const point of shown) {
    const row = el("div", "md-bar");
    const name = el("div", "md-bar-l", point.label);
    name.title = String(point.label);
    row.append(name);
    const track = el("div", "md-bar-track");
    const fill = el("div", "md-bar-fill");
    const value = Number(point.value);
    // A null value is a measurement nobody made — an empty track, not a zero bar.
    fill.style.width = max > 0 && Number.isFinite(value) && value > 0 ? `${(value / max) * 100}%` : "0";
    track.append(fill);
    row.append(track);
    row.append(el("div", "md-bar-v", point.valueLabel ?? "—"));
    box.append(row);
  }
  return box;
}

/** The records the number was counted from, each linking where it came from. */
function rowList(result, view) {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const box = el("div", "md-rows");
  if (!rows.length) {
    box.append(el("p", "md-muted", "No rows matched."));
    return box;
  }
  for (const row of rows) {
    const clickable = !!(row.link && row.linkId);
    const item = el("button", `md-rowitem ${clickable ? "link" : ""}`);
    item.type = "button";
    const col = el("div");
    col.append(el("div", "md-rl", row.label ?? row.id ?? "—"));
    const meta = [row.meta, row.at ? dateText(view.ctx, row.at) : ""].filter(Boolean).join(" · ");
    if (meta) col.append(el("div", "md-rm", meta));
    item.append(col);
    if (row.amountLabel) item.append(el("div", "md-ra", row.amountLabel));
    if (clickable) item.addEventListener("click", () => view.ctx.go(`${row.link}/${row.linkId}`));
    else item.disabled = true;
    box.append(item);
  }
  if (result.rowsTruncated) {
    box.append(el("p", "md-note", `Showing ${rows.length} of ${result.count}. The rest are not listed.`));
  }
  return box;
}

/* ══ METRICS ═══════════════════════════════════════════════════════════════ */

function paintMetrics(mount, view, ui, reload, editMetric) {
  mount.replaceChildren();

  const card = el("div", "md-card");
  const head = el("header");
  head.append(el("h3", null, "Metrics"));
  head.append(el("span", "md-muted", plural(view.metrics.length, "saved metric", "saved metrics")));
  head.append(el("div", "md-grow"));
  head.append(button("New metric", "btn primary", () => editMetric(null)));
  card.append(head);

  const body = el("div", "md-body flush");
  card.append(body);
  mount.append(card);

  if (!view.metrics.length) {
    const box = el("div", "empty");
    box.append(el("h3", null, "No saved metrics"));
    box.append(el("p", null, "A metric is a named definition: what it counts, over what window, filtered how. Save one and every chart built from it carries that definition on screen."));
    body.append(box);
  }

  for (const metric of view.metrics) {
    const item = el("div", "md-item");
    const col = el("div", "md-col");
    col.append(el("h4", null, metric.name));
    col.append(el("div", "md-muted", metric.definitionText ?? metric.error ?? "this definition could not be read"));
    if (metric.description) col.append(el("div", "md-note", metric.description));
    item.append(col);
    item.append(el("div", "md-big", metric.valueLabel ?? "—"));
    item.append(el("div", "md-grow"));
    item.append(button("Edit", "btn tiny", () => editMetric(metric)));
    item.append(
      button("Delete", "btn tiny danger", async () => {
        const res = await call(() => view.api.metricDelete(metric.id));
        if (!res.ok) return say(item, res.error);
        await reload();
      }),
    );
    body.append(item);
  }

  if (ui.metricDraft) {
    const editor = el("div", "md-body");
    card.append(editor);
    paintMetricEditor(editor, view, ui, reload);
  }
}

/**
 * The editor. Every change re-previews through the SAME route the dashboard
 * uses, so the number under the form and the number on the tile cannot differ.
 */
function paintMetricEditor(mount, view, ui, reload) {
  mount.replaceChildren();
  const draft = ui.metricDraft;
  if (!draft.definition.source) draft.definition = blankDefinition(view);

  const previewBox = el("div", "md-preview");
  const errorLine = el("div", "md-inline-err");
  errorLine.hidden = true;

  const refresh = debounced(220, async (isCurrent) => {
    previewBox.classList.add("pending");
    const res = await call(() => view.api.compute(draft.definition, "none", 8));
    if (!isCurrent()) return;
    previewBox.classList.remove("pending");
    paintPreview(previewBox, res, view);
  });

  /** Redraw the whole form: a source change rewrites the measure and field menus. */
  const redraw = () => {
    paintMetricEditor(mount, view, ui, reload);
  };

  const head = el("div", "md-row");
  head.append(el("h4", null, draft.id ? "Edit metric" : "New metric"));
  mount.append(head);

  const form = el("div", "md-form");
  form.append(
    labelled(
      "Name",
      input(draft.name, "Open decisions", (v) => {
        draft.name = v;
      }, "wide"),
    ),
  );

  const source = sourceById(view, draft.definition.source) ?? view.sources[0];
  form.append(
    labelled(
      "Counts",
      select(view.sources.map((s) => [s.id, s.label]), source.id, (v) => {
        draft.definition.source = v;
        // A field, a measure or a grouping from the old source means nothing
        // under the new one, so the definition resets to what the new source
        // can actually answer rather than carrying a rule that would be refused.
        draft.definition.measure = "count";
        draft.definition.filters = [];
        redraw();
      }),
    ),
  );
  form.append(
    labelled(
      "Measure",
      select(measureOptions(source), draft.definition.measure, (v) => {
        draft.definition.measure = v;
        redraw();
      }),
    ),
  );
  form.append(
    labelled(
      "Window",
      select(view.windows.map((w) => [w.id, w.label]), draft.definition.window, (v) => {
        draft.definition.window = v;
        refresh();
      }),
    ),
  );
  form.append(
    labelled(
      "Description",
      input(draft.description, "why this number matters", (v) => {
        draft.description = v;
      }, "wide"),
    ),
  );
  mount.append(form);

  const filters = el("div", "md-body flush");
  mount.append(filters);
  draft.definition.filters.forEach((rule, i) => {
    filters.append(filterRow(view, source, draft, rule, i, redraw, refresh));
  });
  mount.append(
    button("Add a filter", "btn tiny", () => {
      const first = source.fields[0];
      draft.definition.filters.push({ field: first?.id ?? "", op: (opsFor(view, first)[0] ?? ["is"])[0], value: "" });
      redraw();
    }),
  );

  mount.append(previewBox);
  mount.append(errorLine);

  const actions = el("div", "md-row");
  actions.append(
    button(draft.id ? "Save changes" : "Save metric", "btn primary", async () => {
      const payload = { name: draft.name, description: draft.description, definition: draft.definition };
      const res = await call(() =>
        draft.id ? view.api.metricUpdate({ id: draft.id, ...payload }) : view.api.metricCreate(payload),
      );
      if (!res.ok) {
        errorLine.hidden = false;
        errorLine.textContent = res.error;
        return;
      }
      ui.metricDraft = null;
      await reload();
    }),
  );
  actions.append(
    button("Cancel", "btn ghost", () => {
      ui.metricDraft = null;
      reload();
    }),
  );
  mount.append(actions);

  paintPreview(previewBox, null, view);
  refresh();
}

function filterRow(view, source, draft, rule, index, redraw, refresh) {
  const row = el("div", "md-item md-filter");
  row.append(el("span", "md-field-l", index === 0 ? "where" : "and"));

  const field = fieldById(source, rule.field) ?? source.fields[0];
  row.append(
    select(source.fields.map((f) => [f.id, f.label]), field.id, (v) => {
      rule.field = v;
      const next = fieldById(source, v);
      // The operator menu belongs to the field's TYPE, so a field change can
      // orphan the operator. Reset it rather than leave one the server refuses.
      rule.op = (opsFor(view, next)[0] ?? ["is"])[0];
      redraw();
    }),
  );
  row.append(
    select(opsFor(view, field).map(([id, label]) => [id, label]), rule.op, (v) => {
      rule.op = v;
      redraw();
    }),
  );
  if (needsValue(view, field, rule.op)) {
    row.append(
      input(rule.value ?? "", field.type === "date" ? "YYYY-MM-DD" : "value", (v) => {
        rule.value = v;
        refresh();
      }),
    );
  }
  row.append(el("div", "md-grow"));
  row.append(
    button("×", "md-x", () => {
      draft.definition.filters.splice(index, 1);
      redraw();
    }),
  );
  return row;
}

/** The live number, with the same sentence the saved tile will carry. */
function paintPreview(box, res, view) {
  box.replaceChildren();
  if (!res) {
    box.append(el("div", "skeleton line"));
    return;
  }
  if (!res.ok) {
    box.append(el("div", "md-inline-err", res.error));
    return;
  }
  const row = el("div", "md-row");
  row.append(el("span", "md-big", res.valueLabel ?? "—"));
  if (res.measure === "count" && Number.isFinite(Number(res.total))) {
    row.append(el("span", "md-of", `of ${Number(res.total).toLocaleString("en-US")} ${res.nounPlural}`));
  }
  box.append(row);
  box.append(el("div", "md-muted", res.definitionText ?? ""));
  if (res.incomplete > 0) {
    box.append(el("div", "md-note", `${plural(res.incomplete, "filter", "filters")} still need a value and ${res.incomplete === 1 ? "is" : "are"} not counted yet.`));
  }
  const notes = noteLines(res);
  for (const line of notes) box.append(el("div", "md-note", line));
  if (res.rows?.length) box.append(rowList(res, view));
}

/* ══ CHARTS ════════════════════════════════════════════════════════════════ */

function paintCharts(mount, view, ui, reload) {
  mount.replaceChildren();

  const card = el("div", "md-card");
  const head = el("header");
  head.append(el("h3", null, "Charts"));
  head.append(el("span", "md-muted", plural(view.charts.length, "saved chart", "saved charts")));
  head.append(el("div", "md-grow"));
  const newBtn = button("New chart", "btn", () => {
    ui.chartDraft = { id: null, name: "", metricId: view.metrics[0]?.id ?? "", shape: "bar", groupBy: "" };
    paintCharts(mount, view, ui, reload);
  });
  newBtn.disabled = !view.metrics.length;
  newBtn.title = view.metrics.length ? "" : "Save a metric first — a chart is a metric plus a shape";
  head.append(newBtn);
  card.append(head);

  const body = el("div", "md-body flush");
  card.append(body);
  mount.append(card);

  if (!view.charts.length) {
    const box = el("div", "empty");
    box.append(el("h3", null, "No saved charts"));
    box.append(el("p", null, "A chart is a saved metric plus a shape and a grouping. Save one, then add it to a board."));
    body.append(box);
  }

  for (const chart of view.charts) {
    const item = el("div", "md-item");
    const col = el("div", "md-col");
    col.append(el("h4", null, chart.name));
    col.append(el("div", "md-muted", `${chart.metricName} · ${shapeLabel(view, chart.shape)} · ${groupLabel(view, chart)}`));
    item.append(col);
    item.append(el("div", "md-grow"));
    item.append(
      button("Edit", "btn tiny", () => {
        ui.chartDraft = { ...chart };
        paintCharts(mount, view, ui, reload);
      }),
    );
    item.append(
      button("Delete", "btn tiny danger", async () => {
        const res = await call(() => view.api.chartDelete(chart.id));
        if (!res.ok) return say(item, res.error);
        await reload();
      }),
    );
    body.append(item);
  }

  if (ui.chartDraft) {
    const editor = el("div", "md-body");
    card.append(editor);
    paintChartEditor(editor, view, ui, reload, () => paintCharts(mount, view, ui, reload));
  }
}

const shapeLabel = (view, id) => view.shapes.find((s) => s.id === id)?.label ?? id;

function groupingsForChart(view, metricId) {
  const metric = view.metrics.find((m) => m.id === metricId);
  const source = sourceById(view, metric?.definition?.source);
  return source?.groupings ?? [];
}

function groupLabel(view, chart) {
  const found = groupingsForChart(view, chart.metricId).find((g) => g.id === chart.groupBy);
  return found?.label ?? chart.groupBy;
}

function paintChartEditor(mount, view, ui, reload, redraw) {
  mount.replaceChildren();
  const draft = ui.chartDraft;

  const groupings = groupingsForChart(view, draft.metricId);
  // A unit-dot chart is a share of a whole and cannot be cut; a line or a bar
  // with no grouping is one point. The server refuses both, so the menu here
  // offers neither — the same rule, stated once on each side.
  const allowed =
    draft.shape === "unit-dot" ? groupings.filter((g) => g.id === "none") : groupings.filter((g) => g.id !== "none");
  if (!allowed.some((g) => g.id === draft.groupBy)) draft.groupBy = allowed[0]?.id ?? "none";

  mount.append(el("h4", null, draft.id ? "Edit chart" : "New chart"));

  const form = el("div", "md-form");
  form.append(
    labelled(
      "Name",
      input(draft.name, "Open decisions by severity", (v) => {
        draft.name = v;
      }, "wide"),
    ),
  );
  form.append(
    labelled(
      "Metric",
      select(view.metrics.map((m) => [m.id, m.name]), draft.metricId, (v) => {
        draft.metricId = v;
        draft.groupBy = "";
        redraw();
      }),
    ),
  );
  form.append(
    labelled(
      "Shape",
      select(view.shapes.map((s) => [s.id, s.label]), draft.shape, (v) => {
        draft.shape = v;
        draft.groupBy = "";
        redraw();
      }),
    ),
  );
  form.append(
    labelled(
      "Grouping",
      select(allowed.map((g) => [g.id, g.label]), draft.groupBy, (v) => {
        draft.groupBy = v;
      }),
    ),
  );
  mount.append(form);

  const errorLine = el("div", "md-inline-err");
  errorLine.hidden = true;
  mount.append(errorLine);

  const actions = el("div", "md-row");
  actions.append(
    button(draft.id ? "Save changes" : "Save chart", "btn primary", async () => {
      const payload = { name: draft.name, metricId: draft.metricId, shape: draft.shape, groupBy: draft.groupBy };
      const res = await call(() =>
        draft.id ? view.api.chartUpdate({ id: draft.id, ...payload }) : view.api.chartCreate(payload),
      );
      if (!res.ok) {
        errorLine.hidden = false;
        errorLine.textContent = res.error;
        return;
      }
      ui.chartDraft = null;
      await reload();
    }),
  );
  actions.append(
    button("Cancel", "btn ghost", () => {
      ui.chartDraft = null;
      reload();
    }),
  );
  mount.append(actions);
}

/* ══ CALLING THE SERVER ════════════════════════════════════════════════════ */

/**
 * Every call goes through here, so a thrown fetch and an ok:false answer arrive
 * in the same shape and no caller has to remember that ctx.api does not throw.
 */
async function call(fn) {
  try {
    const res = await fn();
    if (!res?.ok) return { ok: false, error: reasonFrom(res) };
    return res;
  } catch (err) {
    return { ok: false, error: reasonFrom(null, err) };
  }
}

/** Put a failure next to the control that caused it, in the server's own words. */
function say(near, message) {
  const existing = near.querySelector(".md-inline-err");
  if (existing) existing.remove();
  near.append(el("div", "md-inline-err", message));
}
