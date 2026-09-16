// Knowledge graph — the screen that answers "why not just use ChatGPT".
//
// ⭐ THE ARGUMENT THIS SCREEN HAS TO MAKE, and every choice below serves it: a
// spreadsheet pasted into a chat window is a flat block of characters, and the
// model has to infer the structure back out of it. Here the structure is held,
// not inferred. So the screen shows the linked model itself — every customer,
// contact, ticket, invoice, event, signal, decision and outcome as a node, and
// the relationships between them as edges — and then does three things a flat
// table cannot do at all: walk from one thing to another, merge six differently
// named date columns into one timeline, and show which customers moved together
// and what they have in common.
//
// 🔴 NOTHING HERE IS INVENTED. There is no sample node, no placeholder count and
// no decorative edge. Every dot on the canvas is a row, every number under it
// comes from src/decisions/graph.mjs, and when the picture is smaller than the
// graph it says so in words, with the two figures.
//
// LAYOUT IS DETERMINISTIC AND IS NOT A SIMULATION. Customers are ordered by
// segment then ARR and placed on a ring; each customer's own contacts, tickets,
// invoices, signals and decisions fan out into the slots immediately outside it;
// segments sit in the middle where their members average out. Same data, same
// picture, every time, drawn in one pass — a force layout would settle to a
// different arrangement on every visit and jitter while an investor watched.
//
// Nothing is written with innerHTML, and nothing is fetched from the network.

export const title = "Knowledge graph";

const SVG_NS = "http://www.w3.org/2000/svg";

/* ── tiny DOM helpers ───────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function svg(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null) continue;
    n.setAttribute(k, String(v));
  }
  return n;
}

function button(label, cls, onClick) {
  const b = el("button", `btn ${cls ?? ""}`, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

/** .empty is the settled kind of nothing: heading, sentence, and a way out. */
function emptyPanel(heading, body, action) {
  const p = el("div", "empty");
  p.append(el("h3", null, heading));
  if (body) p.append(el("p", null, body));
  if (action) p.append(action);
  return p;
}

/**
 * .err holds two things and keeps them apart: a sentence saying what failed,
 * and the server's exact words underneath. Paraphrasing the second into the
 * first is how a report of a real fault turns into a shrug.
 */
function errorPanel(prose, raw, onRetry) {
  const p = el("div", "err");
  p.append(el("strong", null, prose));
  if (raw) p.append(el("code", null, String(raw)));
  if (onRetry) p.append(button("Try again", "", onRetry));
  return p;
}

function skeleton(n = 3) {
  const w = el("div", "kg-skeleton");
  for (let i = 0; i < n; i++) w.append(el("div", "skeleton block"));
  return w;
}

/* ── the picture ────────────────────────────────────────────────────────── */

// The canvas is a fixed coordinate space scaled by the browser, so the layout
// arithmetic never has to know how wide the window is.
// The box is sized to what the drawing actually fills — the satellite ring plus
// the widest label — rather than to a comfortable-looking square. An oversized
// viewBox is invisible padding: the browser scales the whole thing down to fit
// the panel, so the picture arrives small for no reason.
const VIEW = { w: 830, h: 590, cx: 415, cy: 292 };
const RING = { customer: 180, satellite: 228, segment: 68, label: 242 };
/** How many customers get a name on the canvas before it turns into a smear. */
const LABEL_CAP = 16;

/**
 * The order satellites are laid out in, and the order the inspector lists their
 * relations in. Decisions and signals first because they are what the customer
 * is on this screen FOR; the rest is the evidence behind them.
 */
const SATELLITE_ORDER = ["decision", "signal", "invoice", "ticket", "contact", "event", "outcome"];

const NODE_SIZE = {
  customer: 6,
  segment: 10,
  decision: 5.5,
  signal: 4.2,
  invoice: 3.6,
  ticket: 3.2,
  contact: 3.2,
  event: 3,
  outcome: 4.2,
};

/**
 * Place every node in the subgraph. Pure arithmetic: same input, same output.
 *
 * ⚠️ The ring is walked in SLOTS, not in equal angles per customer. A customer
 * with nine satellites takes nine slots and one with none takes one, so a fan
 * never overlaps its neighbour's fan however lopsided the data is.
 */
function layout(sub) {
  const pos = new Map();
  const byId = new Map(sub.nodes.map((n) => [n.id, n]));
  const customers = sub.nodes.filter((n) => n.type === "customer");
  const segments = sub.nodes.filter((n) => n.type === "segment");

  // Satellites find their customer through accountId, which every node carries.
  const fans = new Map();
  for (const c of customers) fans.set(c.accountId, []);
  const centrePile = [];
  for (const n of sub.nodes) {
    if (n.type === "customer" || n.type === "segment") continue;
    if (n.accountId && fans.has(n.accountId)) fans.get(n.accountId).push(n);
    // A company-wide decision belongs to nobody, which is not missing data.
    else centrePile.push(n);
  }
  for (const list of fans.values()) {
    list.sort(
      (a, b) =>
        SATELLITE_ORDER.indexOf(a.type) - SATELLITE_ORDER.indexOf(b.type) || String(a.label).localeCompare(String(b.label)),
    );
  }

  // Customers in segment order, biggest first inside each segment, so the ring
  // is grouped rather than shuffled and the segment spokes do not cross.
  const ordered = [...customers].sort(
    (a, b) =>
      String(a.segment ?? "~").localeCompare(String(b.segment ?? "~")) ||
      (b.arr ?? 0) - (a.arr ?? 0) ||
      String(a.label).localeCompare(String(b.label)),
  );

  const totalSlots = ordered.reduce((sum, c) => sum + Math.max(1, fans.get(c.accountId).length), 0) || 1;
  const step = (Math.PI * 2) / totalSlots;
  const at = (angle, r) => ({ x: VIEW.cx + Math.cos(angle) * r, y: VIEW.cy + Math.sin(angle) * r, angle });

  const maxArr = Math.max(1, ...customers.map((c) => c.arr ?? 0));
  const segmentAngles = new Map();

  let slot = 0;
  for (const c of ordered) {
    const fan = fans.get(c.accountId);
    const width = Math.max(1, fan.length);
    const start = slot;
    const mid = (start + width / 2) * step - Math.PI / 2;
    pos.set(c.id, { ...at(mid, RING.customer), r: NODE_SIZE.customer * (0.7 + 0.5 * Math.sqrt((c.arr ?? 0) / maxArr)) + 1.6 });
    fan.forEach((s, j) => {
      const a = (start + j + 0.5) * step - Math.PI / 2;
      pos.set(s.id, { ...at(a, RING.satellite), r: NODE_SIZE[s.type] ?? 3 });
    });
    if (c.segment) {
      if (!segmentAngles.has(c.segment)) segmentAngles.set(c.segment, []);
      segmentAngles.get(c.segment).push(mid);
    }
    slot += width;
  }

  // A segment sits at the average direction of its own members, so its spokes
  // fan out instead of crossing the middle.
  for (const s of segments) {
    const angles = segmentAngles.get(s.key) ?? [];
    const x = angles.reduce((sum, a) => sum + Math.cos(a), 0);
    const y = angles.reduce((sum, a) => sum + Math.sin(a), 0);
    const angle = angles.length ? Math.atan2(y, x) : -Math.PI / 2;
    pos.set(s.id, { ...at(angle, segments.length > 1 ? RING.segment : 0), r: NODE_SIZE.segment });
  }

  // Anything belonging to nobody goes in the middle, in a small spiral.
  centrePile.forEach((n, i) => {
    const angle = i * 2.399;
    const r = 18 + i * 7;
    pos.set(n.id, { ...at(angle, Math.min(r, RING.segment - 18)), r: NODE_SIZE[n.type] ?? 3 });
  });

  return { pos, byId, ordered };
}

/** A straight line for a short hop, a curve through the middle for a long one. */
function edgePath(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 90) return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  // Pull the control point toward the centre in proportion to the span, which
  // is what turns a crowded ring of chords into something readable.
  const pull = Math.min(0.62, len / (RING.satellite * 2.4));
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx = mx + (VIEW.cx - mx) * pull;
  const cy = my + (VIEW.cy - my) * pull;
  return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

/**
 * Draw the subgraph. Returns { svg, select(id), nodeIds } — `select` is called
 * by the page to move the highlight without redrawing anything.
 */
function drawGraph(sub, onPick) {
  const { pos, byId } = layout(sub);
  const root = svg("svg", {
    class: "kg-svg",
    viewBox: `0 0 ${VIEW.w} ${VIEW.h}`,
    preserveAspectRatio: "xMidYMid meet",
    role: "img",
    "aria-label": `Knowledge graph: ${sub.shown} of ${sub.total} nodes and the relationships between them.`,
  });

  // Edges first so nodes sit on top of them.
  const edgeLayer = svg("g", { class: "kg-edges" });
  const edgesByNode = new Map();
  const neighbourOf = new Map();
  for (const e of sub.edges) {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) continue;
    const path = svg("path", { class: `kg-edge kg-e-${e.type}`, d: edgePath(a, b) });
    edgeLayer.append(path);
    for (const [x, y] of [
      [e.from, e.to],
      [e.to, e.from],
    ]) {
      if (!edgesByNode.has(x)) edgesByNode.set(x, []);
      edgesByNode.get(x).push(path);
      if (!neighbourOf.has(x)) neighbourOf.set(x, new Set());
      neighbourOf.get(x).add(y);
    }
  }
  root.append(edgeLayer);

  const nodeLayer = svg("g", { class: "kg-nodes" });
  const groups = new Map();
  // Draw satellites first and the big nodes last, so a customer is never hidden
  // under one of its own tickets.
  const order = [...sub.nodes].sort(
    (a, b) => (NODE_SIZE[a.type] ?? 3) - (NODE_SIZE[b.type] ?? 3) || String(a.id).localeCompare(String(b.id)),
  );
  for (const n of order) {
    const p = pos.get(n.id);
    if (!p) continue;
    const g = svg("g", { class: `kg-node kg-t-${n.type}`, "data-id": n.id });
    const shape =
      n.type === "segment"
        ? svg("rect", { x: p.x - p.r, y: p.y - p.r, width: p.r * 2, height: p.r * 2, rx: 3, class: "kg-dot" })
        : svg("circle", { cx: p.x, cy: p.y, r: p.r, class: "kg-dot" });
    g.append(shape);
    // A native <title> is the tooltip, and it is read out by a screen reader.
    const tip = svg("title", {});
    tip.textContent = `${n.label}${n.sub ? ` — ${n.sub}` : ""}`;
    g.append(tip);
    g.addEventListener("click", () => onPick(n.id));
    nodeLayer.append(g);
    groups.set(n.id, g);
  }
  root.append(nodeLayer);

  // Labels only for the nodes that carry the story: every segment, and the
  // biggest handful of customers with a decision against them. 170 names round
  // a ring is a grey smear, and a smear says less than nothing.
  const named = sub.nodes.filter((n) => n.type === "segment").map((n) => n.id);
  const withDecision = new Set();
  for (const e of sub.edges) {
    if (e.type === "about") withDecision.add(e.to);
  }
  const worth = sub.nodes
    .filter((n) => withDecision.has(n.id))
    .sort((a, b) => (b.arr ?? 0) - (a.arr ?? 0) || String(a.label).localeCompare(String(b.label)))
    .slice(0, LABEL_CAP)
    .map((n) => n.id);

  const labelLayer = svg("g", { class: "kg-labels" });
  for (const id of [...named, ...worth]) {
    const n = byId.get(id);
    const p = pos.get(id);
    if (!n || !p) continue;
    if (n.type === "segment") {
      const t = svg("text", { class: "kg-label kg-label-hub", x: p.x, y: p.y - p.r - 6, "text-anchor": "middle" });
      t.textContent = n.label;
      labelLayer.append(t);
      continue;
    }
    // A customer's name sits outside its own fan, on its own angle, so it never
    // lands on top of the tickets and invoices that belong to it.
    const x = VIEW.cx + Math.cos(p.angle) * RING.label;
    const y = VIEW.cy + Math.sin(p.angle) * RING.label;
    const right = Math.cos(p.angle) >= 0;
    const t = svg("text", { class: "kg-label", x: x + (right ? 5 : -5), y: y + 3, "text-anchor": right ? "start" : "end" });
    t.textContent = n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label;
    labelLayer.append(t);
  }
  root.append(labelLayer);

  let current = null;
  const select = (id) => {
    if (current) {
      groups.get(current)?.classList.remove("kg-on");
      for (const path of edgesByNode.get(current) ?? []) path.classList.remove("kg-lit");
      for (const other of neighbourOf.get(current) ?? []) groups.get(other)?.classList.remove("kg-near");
    }
    current = id && groups.has(id) ? id : null;
    root.classList.toggle("kg-dim", !!current);
    if (!current) return;
    groups.get(current).classList.add("kg-on");
    for (const path of edgesByNode.get(current) ?? []) path.classList.add("kg-lit");
    for (const other of neighbourOf.get(current) ?? []) groups.get(other)?.classList.add("kg-near");
  };

  return { svg: root, select, has: (id) => groups.has(id) };
}

/* ── panels ─────────────────────────────────────────────────────────────── */

function statStrip(stats, asOf, ctx) {
  const strip = el("div", "kg-stats");
  const tile = (label, value, note) => {
    const t = el("div", "kg-stat");
    t.append(el("div", "kg-stat-v", value));
    t.append(el("div", "kg-stat-l", label));
    if (note) t.append(el("div", "kg-stat-n", note));
    return t;
  };
  strip.append(tile("Nodes", String(stats.nodes), "things in the model"));
  strip.append(tile("Relationships", String(stats.edges), "held, not inferred"));
  strip.append(tile("Computed pairs", String(stats.derivedEdges), "customer to customer"));
  strip.append(tile("Density", stats.density.toFixed(4), `${stats.avgDegree} links per node`));
  strip.append(tile("As of", ctx.fmt?.date ? ctx.fmt.date(asOf) : String(asOf), stats.builtMs != null ? `built in ${stats.builtMs} ms` : null));
  return strip;
}

function legendPanel(stats) {
  const p = el("div", "panel kg-legend");
  p.append(el("h3", null, "What is in the model"));
  // A label and a number run together read as prose — "shares an owner with
  // 1179" looks like a sentence that lost its subject. The count is a value, so
  // it is separated and right-aligned like one.
  const n = (v) => Number(v ?? 0).toLocaleString("en-US");
  const row = el("div", "kg-legend-row");
  for (const t of stats.nodesByType) {
    const chip = el("span", `chip kg-key kg-t-${t.id}`);
    chip.append(el("i", "kg-swatch"));
    chip.append(document.createTextNode(t.plural));
    chip.append(el("b", "kg-key-n", n(t.count)));
    row.append(chip);
  }
  p.append(row);

  const edges = el("div", "kg-legend-row kg-legend-edges");
  for (const t of stats.edgesByType) {
    if (!t.count) continue;
    const chip = el("span", "chip kg-key");
    chip.append(document.createTextNode(t.derived ? `${t.label} (computed)` : t.label));
    chip.append(el("b", "kg-key-n", n(t.count)));
    edges.append(chip);
  }
  p.append(edges);
  p.append(el("p", "kg-note", stats.densityNote));
  const left = Object.entries(stats.omitted ?? {});
  if (left.length) {
    p.append(
      el(
        "p",
        "kg-note",
        `Rows not loaded into the model because the workspace is larger than the build budget: ${left
          .map(([k, v]) => `${v} ${k}`)
          .join(", ")}.`,
      ),
    );
  }
  return p;
}

/** The sentence that says how much of the graph the picture is showing. */
function coveragePanel(sub) {
  const p = el("p", "kg-note kg-coverage");
  p.textContent = sub.note;
  return p;
}

function nodeChip(n) {
  const chip = el("span", `chip kg-key kg-t-${n.type}`);
  chip.append(el("i", "kg-swatch"));
  chip.append(document.createTextNode(n.label));
  return chip;
}

function factRow(label, value) {
  const r = el("div", "kg-fact");
  r.append(el("span", "kg-fact-l", label));
  r.append(el("span", "kg-fact-v", value));
  return r;
}

/* ── the page ───────────────────────────────────────────────────────────── */

// A later render always wins. Every await checks that it still owns the screen
// before touching the DOM, so a slow first response cannot paint over a newer one.
let epoch = 0;

export async function render(root, ctx) {
  const mine = ++epoch;
  const isStale = () => mine !== epoch;
  const again = () => render(root, ctx);

  root.replaceChildren(styles(), loadingView());

  let data;
  try {
    data = await ctx.api("decisionsGraph");
  } catch (err) {
    if (isStale()) return;
    root.replaceChildren(styles(), shell(head(), errorPanel("The knowledge graph could not reach the app's backend.", err?.message ?? err, again)));
    return;
  }
  if (isStale()) return;

  if (data?.needsWorkspace) {
    root.replaceChildren(
      styles(),
      shell(head(), emptyPanel("No workspace yet", "Create a workspace and import or seed some data, and the model is built from it.", button("Go to Data", "primary", () => ctx.go("data")))),
    );
    return;
  }
  if (!data?.ok) {
    root.replaceChildren(styles(), shell(head(), errorPanel("The knowledge graph could not be built.", data?.error, again)));
    return;
  }
  if (data.empty) {
    root.replaceChildren(
      styles(),
      shell(head(), emptyPanel("Nothing to link yet", "The model is built from the customers, contacts, tickets, invoices and events in this workspace. There are none.", button("Import or seed data", "primary", () => ctx.go("data")))),
    );
    return;
  }

  /* ── the frame ─────────────────────────────────────────────────────── */
  const wrap = el("div", "kg-wrap");
  wrap.append(head(data));
  wrap.append(statStrip(data.stats, data.asOf, ctx));

  const main = el("div", "kg-main");
  const canvas = el("div", "panel kg-canvas");
  const inspector = el("div", "kg-inspector");
  main.append(canvas);
  main.append(inspector);
  wrap.append(main);
  wrap.append(legendPanel(data.stats));
  root.replaceChildren(styles(), wrap);

  /* ── the picture ───────────────────────────────────────────────────── */
  let picture = drawGraph(data.subgraph, (id) => selectNode(id));
  canvas.append(picture.svg);
  canvas.append(coveragePanel(data.subgraph));

  /* ── the inspector ─────────────────────────────────────────────────── */
  const detail = el("div", "panel kg-detail");
  inspector.append(detail);
  inspector.append(relatePanel(ctx, data, (id) => selectNode(id)));
  inspector.append(cohortPanel(ctx, data, (id) => selectNode(id)));
  inspector.append(browsePanel(data, (id) => selectNode(id)));

  let selected = null;
  let pick = 0;

  showIntro();

  function showIntro() {
    detail.replaceChildren();
    detail.append(el("h3", null, "Pick anything on the canvas"));
    detail.append(
      el(
        "p",
        "kg-note",
        "Every dot is a row from this workspace and every line is a relationship between two of them. Selecting one shows what it is joined to and everything that has happened to it, in order.",
      ),
    );
    const list = el("div", "kg-fact-list");
    list.append(factRow("Built from", "account, contact, ticket, invoice, event, signal, decision, outcome"));
    list.append(factRow("Stored", "nothing — the model is derived from the tables on demand"));
    list.append(factRow("Signals from", data.runId ? `analysis ${data.runId}` : "no analysis has finished yet"));
    detail.append(list);
    if (!data.runId) {
      detail.append(
        el("p", "kg-note", "Signals and decisions appear here once an analysis has run. The customers and their records are already linked."),
      );
    }
  }

  async function selectNode(id) {
    const turn = ++pick;
    selected = id;
    picture.select(picture.has(id) ? id : null);
    detail.replaceChildren(el("h3", null, "Loading…"), skeleton(2));

    let node;
    try {
      node = await ctx.api("decisionsGraphNode", { query: { id, depth: "1" } });
    } catch (err) {
      if (turn !== pick || isStale()) return;
      detail.replaceChildren(errorPanel("That node could not be read.", err?.message ?? err, () => selectNode(id)));
      return;
    }
    if (turn !== pick || isStale()) return;
    if (!node?.ok) {
      detail.replaceChildren(errorPanel("That node could not be read.", node?.error, () => selectNode(id)));
      return;
    }

    detail.replaceChildren();
    const n = node.node;
    const header = el("div", "kg-detail-head");
    header.append(nodeChip(n));
    if (!picture.has(id)) header.append(el("span", "chip warn", "not drawn"));
    detail.append(header);
    detail.append(el("h3", "kg-detail-title", n.label));
    if (n.sub) detail.append(el("p", "kg-note", n.sub));

    const facts = el("div", "kg-fact-list");
    if (n.type === "customer") {
      facts.append(factRow("ARR", n.arrLabel ?? "—"));
      if (n.owner) facts.append(factRow("Owner", n.owner));
      if (n.segment) facts.append(factRow("Segment", n.segment));
      if (n.plan) facts.append(factRow("Plan", n.plan));
      if (n.industry) facts.append(factRow("Industry", n.industry));
      if (n.renewalDate) facts.append(factRow("Renews", ctx.fmt?.date ? ctx.fmt.date(n.renewalDate) : n.renewalDate));
    }
    if (n.type === "decision") {
      facts.append(factRow("Severity", n.severity ?? "—"));
      facts.append(factRow("Status", n.status ?? "—"));
      if (n.impactLabel) facts.append(factRow("Impact", n.impactLabel));
    }
    if (n.type === "signal") {
      facts.append(factRow("Signal", n.kindLabel ?? n.kind ?? "—"));
      if (n.band != null) facts.append(factRow("Band", String(n.band)));
    }
    if (n.at) facts.append(factRow("Dated", ctx.fmt?.date ? ctx.fmt.date(n.at) : n.at));
    if (facts.childElementCount) detail.append(facts);

    if (n.type === "decision" && n.decisionId) {
      detail.append(button("Open this decision", "ghost tiny", () => ctx.go(`decisions/${n.decisionId}`)));
    }

    /* connections */
    // node.distinct is counted on the server across the whole peer set. Do NOT
    // sum node.groups here: a customer that shares an owner AND a segment AND a
    // plan appears in three groups, so the sum over-counts every customer in the
    // demo workspace by a median of 7.
    const reach = typeof node.distinct === "number" ? node.distinct : null;
    detail.append(el("h4", null, reach === null ? "Connected to" : `Connected to ${reach} things`));
    if (!node.groups.length) detail.append(el("p", "kg-note", "Nothing in the data joins to this."));
    for (const group of node.groups) {
      const block = el("div", "kg-group");
      const head = el("div", "kg-group-head");
      head.append(el("span", "kg-group-name", group.label));
      head.append(el("span", "kg-count", String(group.count)));
      block.append(head);
      const items = el("div", "kg-group-items");
      for (const item of group.items) {
        const b = el("button", `chip kg-key kg-pick kg-t-${item.type}`);
        b.type = "button";
        b.append(el("i", "kg-swatch"));
        b.append(document.createTextNode(item.label));
        b.onclick = () => selectNode(item.id);
        items.append(b);
      }
      if (group.more) items.append(el("span", "chip kg-more", `and ${group.more} more`));
      block.append(items);
      detail.append(block);
    }
    if (node.note) detail.append(el("p", "kg-note", node.note));

    // Every node carries the account it belongs to, and a customer node carries
    // its own. A segment, or a company-wide decision, belongs to nobody — there
    // is no timeline to show and inventing one would be a lie.
    const accountId = n.accountId;
    if (!accountId) return;
    detail.append(await sharedBlock(ctx, accountId, turn, () => turn === pick && !isStale(), selectNode));
    if (turn !== pick || isStale()) return;
    detail.append(await timelineBlock(ctx, accountId, turn, () => turn === pick && !isStale(), selectNode));
  }
}

/* ── the blocks that hang off a selected customer ───────────────────────── */

async function sharedBlock(ctx, accountId, turn, alive, onPick) {
  const block = el("div", "kg-block");
  block.append(el("h4", null, "Moving with this customer"));
  let r;
  try {
    r = await ctx.api("decisionsGraphShared", { query: { id: accountId } });
  } catch (err) {
    block.append(errorPanel("The shared-risk answer could not be read.", err?.message ?? err));
    return block;
  }
  if (!alive()) return block;
  if (!r?.ok) {
    block.append(errorPanel("The shared-risk answer could not be read.", r?.error));
    return block;
  }
  block.append(el("p", "kg-sentence", r.sentence));
  for (const peer of r.peers.slice(0, 10)) {
    const row = el("div", "kg-peer");
    const name = el("button", "kg-peer-name");
    name.type = "button";
    name.textContent = peer.node.label;
    name.onclick = () => onPick(peer.node.id);
    row.append(name);
    const tags = el("div", "kg-peer-tags");
    for (const s of peer.shared) tags.append(el("span", "chip", `same ${s.label}: ${s.value}`));
    for (const s of peer.signals) tags.append(el("span", "chip warn", s.label));
    row.append(tags);
    row.append(el("span", "kg-peer-arr", peer.node.arrLabel ?? ""));
    block.append(row);
  }
  if (r.peers.length > 10) block.append(el("p", "kg-note", `${r.peers.length - 10} more are not listed.`));
  const checked = el("details", "kg-checked");
  checked.append(el("summary", null, "What was checked"));
  for (const [label, value] of r.checked ?? []) checked.append(factRow(label, value));
  block.append(checked);
  return block;
}

async function timelineBlock(ctx, accountId, turn, alive, onPick) {
  const block = el("div", "kg-block");
  block.append(el("h4", null, "Everything that happened, in order"));
  let r;
  try {
    r = await ctx.api("decisionsGraphTimeline", { query: { id: accountId } });
  } catch (err) {
    block.append(errorPanel("The timeline could not be read.", err?.message ?? err));
    return block;
  }
  if (!alive()) return block;
  if (!r?.ok) {
    block.append(errorPanel("The timeline could not be read.", r?.error));
    return block;
  }
  block.append(
    el("p", "kg-note", `${r.total} dated records from ${r.sources.length} tables, newest first.${r.note ? ` ${r.note}` : ""}`),
  );
  const list = el("div", "kg-timeline");
  for (const e of r.entries.slice(0, 40)) {
    const row = el("button", `kg-tl kg-t-${e.type}`);
    row.type = "button";
    row.append(el("i", "kg-swatch"));
    const when = el("span", "kg-tl-when", ctx.fmt?.date ? ctx.fmt.date(e.day) : e.day);
    row.append(when);
    const what = el("span", "kg-tl-what", e.label);
    row.append(what);
    if (e.detail) row.append(el("span", "kg-tl-detail", e.detail));
    if (e.nodeId) row.onclick = () => onPick(e.nodeId);
    else row.disabled = true;
    list.append(row);
  }
  block.append(list);
  if (r.entries.length > 40) block.append(el("p", "kg-note", `${r.entries.length - 40} older entries are not shown.`));
  return block;
}

/* ── relate two things ──────────────────────────────────────────────────── */

function relatePanel(ctx, data, onPick) {
  const p = el("div", "panel kg-tool");
  p.append(el("h3", null, "How are these two related?"));
  p.append(el("p", "kg-note", "The shortest chain of relationships between any two customers, found by walking the graph."));

  const mk = (label) => {
    const wrap = el("label", "kg-field");
    wrap.append(el("span", null, label));
    const sel = el("select", "kg-select");
    for (const c of data.customers) {
      const o = el("option", null, `${c.label} — ${c.arrLabel}`);
      o.value = c.id;
      sel.append(o);
    }
    wrap.append(sel);
    return { wrap, sel };
  };
  const a = mk("From");
  const b = mk("To");
  if (data.customers.length > 1) b.sel.selectedIndex = Math.min(data.customers.length - 1, 1);
  p.append(a.wrap);
  p.append(b.wrap);

  const out = el("div", "kg-tool-out");
  const go = button("Find the path", "primary tiny", async () => {
    go.disabled = true;
    go.textContent = "Walking the graph…";
    out.replaceChildren(skeleton(1));
    try {
      const r = await ctx.api("decisionsGraphPath", { query: { from: a.sel.value, to: b.sel.value } });
      out.replaceChildren();
      if (!r?.ok) {
        out.append(errorPanel("That path could not be worked out.", r?.error));
        return;
      }
      out.append(el("p", "kg-sentence", r.sentence));
      if (!r.found) {
        const checked = el("details", "kg-checked");
        checked.append(el("summary", null, "What was checked"));
        for (const [label, value] of r.checked ?? []) checked.append(factRow(label, value));
        out.append(checked);
        return;
      }
      const steps = el("ol", "kg-steps");
      for (const s of r.steps) {
        const li = el("li", null, s.sentence);
        if (s.to?.id) {
          const jump = el("button", "kg-peer-name", "show");
          jump.type = "button";
          jump.onclick = () => onPick(s.to.id);
          li.append(document.createTextNode(" "));
          li.append(jump);
        }
        steps.append(li);
      }
      out.append(steps);
      out.append(el("p", "kg-note", `${r.visited} things were reached while searching.`));
    } catch (err) {
      out.replaceChildren(errorPanel("That path could not be worked out.", err?.message ?? err));
    } finally {
      go.disabled = false;
      go.textContent = "Find the path";
    }
  });
  p.append(go);
  p.append(out);
  return p;
}

/* ── moved together ─────────────────────────────────────────────────────── */

function cohortPanel(ctx, data, onPick) {
  const p = el("div", "panel kg-tool");
  p.append(el("h3", null, "Who moved together, and why"));
  if (!data.signalKinds.length) {
    p.append(
      el(
        "p",
        "kg-note",
        data.runId
          ? "The last analysis raised no signals, so there is no cohort to explain."
          : "No analysis has finished yet, so no signals exist to group customers by.",
      ),
    );
    return p;
  }
  p.append(el("p", "kg-note", "Pick a signal. Every customer carrying it is compared on owner, segment, plan, champion and industry, against the rate across the whole customer base."));

  const field = el("label", "kg-field");
  field.append(el("span", null, "Signal"));
  const sel = el("select", "kg-select");
  for (const k of data.signalKinds) {
    const o = el("option", null, `${k.label} — ${k.customers} customer${k.customers === 1 ? "" : "s"}`);
    o.value = k.kind;
    sel.append(o);
  }
  field.append(sel);
  p.append(field);

  const out = el("div", "kg-tool-out");
  const go = button("Explain the cohort", "primary tiny", async () => {
    go.disabled = true;
    out.replaceChildren(skeleton(1));
    try {
      const r = await ctx.api("decisionsGraphCohort", { query: { kind: sel.value } });
      out.replaceChildren();
      if (!r?.ok) {
        out.append(errorPanel("That cohort could not be worked out.", r?.error));
        return;
      }
      out.append(el("p", "kg-sentence", r.sentence));
      if (!r.found) return;
      for (const f of r.factors) {
        const row = el("div", "kg-factor");
        const bar = el("div", "kg-bar");
        const fill = el("div", "kg-bar-fill");
        fill.style.width = `${Math.max(2, f.sharePct)}%`;
        const base = el("div", "kg-bar-base");
        base.style.width = `${Math.max(1, f.baseSharePct)}%`;
        bar.append(fill);
        bar.append(base);
        row.append(el("div", "kg-factor-l", `${f.label}: ${f.value}`));
        row.append(bar);
        row.append(el("div", "kg-factor-v", `${f.sharePct}% vs ${f.baseSharePct}%`));
        row.append(el("div", "kg-factor-s", f.sentence));
        out.append(row);
      }
      const who = el("div", "kg-group-items");
      for (const c of r.carriers.slice(0, 18)) {
        const b = el("button", "chip kg-key kg-pick kg-t-customer");
        b.type = "button";
        b.append(el("i", "kg-swatch"));
        b.append(document.createTextNode(c.label));
        b.onclick = () => onPick(c.id);
        who.append(b);
      }
      out.append(who);
      if (r.carriers.length > 18) out.append(el("p", "kg-note", `${r.carriers.length - 18} more are not listed.`));
    } catch (err) {
      out.replaceChildren(errorPanel("That cohort could not be worked out.", err?.message ?? err));
    } finally {
      go.disabled = false;
    }
  });
  p.append(go);
  p.append(out);
  return p;
}

/* ── the keyboard route into the canvas ─────────────────────────────────── */

/**
 * A dot on an SVG is reachable with a mouse and nothing else, and 170 tab stops
 * would be worse than none. This list is the same set of customers in the same
 * order, as real buttons, so every node on the canvas has a way in from the
 * keyboard — and it doubles as the fastest way to find one by name.
 */
function browsePanel(data, onPick) {
  const p = el("div", "panel kg-tool");
  p.append(el("h3", null, `All ${data.customers.length} customers`));
  const search = el("input", "v2-input kg-search");
  search.type = "search";
  search.placeholder = "Find a customer";
  search.setAttribute("aria-label", "Find a customer");
  p.append(search);
  const list = el("div", "kg-browse");
  const rows = [];
  for (const c of data.customers) {
    const b = el("button", "kg-browse-row");
    b.type = "button";
    b.append(el("span", "kg-browse-name", c.label));
    b.append(el("span", "kg-browse-arr", c.arrLabel ?? ""));
    b.onclick = () => onPick(c.id);
    list.append(b);
    rows.push({ b, key: `${c.label} ${c.owner ?? ""} ${c.segment ?? ""} ${c.plan ?? ""}`.toLowerCase() });
  }
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    for (const r of rows) r.b.hidden = q ? !r.key.includes(q) : false;
  };
  p.append(list);
  return p;
}

/* ── frames ─────────────────────────────────────────────────────────────── */

function head(data) {
  const h = el("div", "kg-head");
  h.append(el("h1", null, "Knowledge graph"));
  h.append(
    el(
      "p",
      "kg-lead",
      data
        ? "A linked model of this business, computed from the tables. Paste a spreadsheet into a chat window and the structure has to be guessed back out of the characters; here it is held, so a relationship question is a traversal and not a guess."
        : "A linked model of this business, computed from the tables.",
    ),
  );
  return h;
}

function shell(...children) {
  const w = el("div", "kg-wrap");
  for (const c of children) w.append(c);
  return w;
}

function loadingView() {
  const w = el("div", "kg-wrap");
  w.append(head());
  w.append(el("p", "kg-note", "Building the model from the tables…"));
  w.append(skeleton(3));
  return w;
}

/* ── layout and the node palette ────────────────────────────────────────── */

/**
 * ⚠️ WHY THERE ARE COLOURS IN THIS BLOCK, when a page is supposed to add layout
 * only. tokens.css carries a semantic palette — green for "this went well",
 * amber for waiting, red for overdue — and deliberately no categorical one. A
 * graph legend needs nine distinguishable categories, and reusing the semantic
 * three would say "this ticket went well", which is not a thing a ticket does.
 *
 * So the nine are declared here as TOKENS, once, with their light-theme values
 * in the same block, which is the rule tokens.css actually sets: a colour that
 * changes for light is a token and never a second hard-coded rule. Everything
 * else on this page — panels, chips, pills, buttons — uses the shared ones.
 */
function styles() {
  const s = document.createElement("style");
  s.textContent = `
.kg-wrap { --kg-customer:#6EA8FE; --kg-decision:#E5534B; --kg-signal:#E0A33E;
  --kg-contact:#B594F6; --kg-ticket:#4FC3D9; --kg-invoice:#E8795A; --kg-event:#8A8F98;
  --kg-outcome:#3ECF8E; --kg-segment:#F2F3F5; --kg-line:#2E3238;
  display:flex; flex-direction:column; gap:var(--s4); }
@media (prefers-color-scheme: light) {
  .kg-wrap:not([data-theme="dark"]) { --kg-customer:#1F5FBF; --kg-decision:#C0362C;
    --kg-signal:#8A5B0F; --kg-contact:#6B3FC4; --kg-ticket:#10707F; --kg-invoice:#A7472A;
    --kg-event:#666C75; --kg-outcome:#12734B; --kg-segment:#16181C; --kg-line:#D7DAE0; }
}
.kg-head h1 { margin:0 0 var(--s2); font-size:var(--fs-2xl); line-height:var(--lh-tight); }
.kg-lead { margin:0; color:var(--muted); max-width:78ch; line-height:var(--lh-body); }
.kg-note { margin:var(--s2) 0 0; color:var(--muted); font-size:var(--fs-sm); line-height:var(--lh-body); }
.kg-sentence { margin:0 0 var(--s2); line-height:var(--lh-body); }

.kg-stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:var(--s3); }
.kg-stat { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:var(--s3); }
.kg-stat-v { font-size:var(--fs-xl); line-height:var(--lh-tight); font-variant-numeric:tabular-nums; }
.kg-stat-l { font-size:var(--fs-sm); color:var(--muted); margin-top:2px; }
.kg-stat-n { font-size:var(--fs-xs); color:var(--muted); margin-top:var(--s1); }

.kg-main { display:grid; grid-template-columns:minmax(0,1fr) 380px; gap:var(--s3); align-items:start; }
@media (max-width: 1080px) { .kg-main { grid-template-columns:minmax(0,1fr); } }
/* The inspector is much taller than the picture, so without this the canvas
   scrolls away and the tool panels talk about a graph you can no longer see. */
.kg-canvas { padding:var(--s2) var(--s2) var(--s3); position:sticky; top:var(--s3); }
@media (max-width: 1080px) { .kg-canvas { position:static; } }
.kg-svg { display:block; width:100%; height:auto; }
.kg-inspector { display:flex; flex-direction:column; gap:var(--s3); min-width:0; }
.kg-inspector .panel { margin:0; }

.kg-edge { fill:none; stroke:var(--kg-line); stroke-width:1; opacity:.75; }
.kg-e-in_segment { stroke-dasharray:3 4; }
.kg-svg.kg-dim .kg-edge { opacity:.16; }
.kg-svg.kg-dim .kg-edge.kg-lit { opacity:1; stroke:var(--text); stroke-width:1.4; }
.kg-node { cursor:pointer; }
.kg-dot { stroke:var(--bg); stroke-width:.8; }
.kg-svg.kg-dim .kg-node { opacity:.2; }
.kg-svg.kg-dim .kg-node.kg-near { opacity:1; }
.kg-svg.kg-dim .kg-node.kg-on { opacity:1; }
.kg-node.kg-on .kg-dot { stroke:var(--text); stroke-width:2.2; }
.kg-label { fill:var(--muted); font-size:9.5px; font-family:var(--font); pointer-events:none; }
.kg-label-hub { fill:var(--text); font-size:11px; }
.kg-svg.kg-dim .kg-label { opacity:.35; }
.kg-coverage { margin-top:var(--s2); padding:0 var(--s2); }

.kg-t-customer .kg-dot, .kg-t-customer .kg-swatch { fill:var(--kg-customer); background:var(--kg-customer); }
.kg-t-decision .kg-dot, .kg-t-decision .kg-swatch { fill:var(--kg-decision); background:var(--kg-decision); }
.kg-t-signal   .kg-dot, .kg-t-signal   .kg-swatch { fill:var(--kg-signal);   background:var(--kg-signal); }
.kg-t-contact  .kg-dot, .kg-t-contact  .kg-swatch { fill:var(--kg-contact);  background:var(--kg-contact); }
.kg-t-ticket   .kg-dot, .kg-t-ticket   .kg-swatch { fill:var(--kg-ticket);   background:var(--kg-ticket); }
.kg-t-invoice  .kg-dot, .kg-t-invoice  .kg-swatch { fill:var(--kg-invoice);  background:var(--kg-invoice); }
.kg-t-event    .kg-dot, .kg-t-event    .kg-swatch { fill:var(--kg-event);    background:var(--kg-event); }
.kg-t-outcome  .kg-dot, .kg-t-outcome  .kg-swatch { fill:var(--kg-outcome);  background:var(--kg-outcome); }
.kg-t-segment  .kg-dot, .kg-t-segment  .kg-swatch { fill:var(--kg-segment);  background:var(--kg-segment); }

.kg-legend-row { display:flex; flex-wrap:wrap; gap:var(--s2); margin-top:var(--s2); }
.kg-legend-edges .chip i { color:var(--muted); font-style:normal; font-size:var(--fs-xs); }
.kg-key { display:inline-flex; align-items:center; gap:6px; }
.kg-swatch { width:8px; height:8px; border-radius:2px; display:inline-block; flex:0 0 auto; }
.kg-key-n { font-weight:600; font-variant-numeric:tabular-nums; color:var(--text); }
.kg-pick { cursor:pointer; text-align:left; font:inherit; font-size:var(--fs-sm); }
.kg-more { color:var(--muted); }

.kg-detail-head { display:flex; gap:var(--s2); align-items:center; flex-wrap:wrap; }
.kg-detail-title { margin:var(--s2) 0 0; font-size:var(--fs-lg); line-height:var(--lh-tight); }
.kg-fact-list { margin-top:var(--s3); display:flex; flex-direction:column; gap:2px; }
.kg-fact { display:flex; gap:var(--s3); justify-content:space-between; font-size:var(--fs-sm); padding:3px 0; border-bottom:1px solid var(--border-soft); }
.kg-fact-l { color:var(--muted); flex:0 0 auto; }
.kg-fact-v { text-align:right; min-width:0; overflow-wrap:anywhere; }
.kg-detail h4, .kg-block h4 { margin:var(--s4) 0 var(--s2); font-size:var(--fs-md); }
.kg-group { margin-bottom:var(--s3); }
.kg-group-head { display:flex; justify-content:space-between; gap:var(--s2); font-size:var(--fs-sm); color:var(--muted); }
.kg-group-name { overflow-wrap:anywhere; }
.kg-count { font-variant-numeric:tabular-nums; }
.kg-group-items { display:flex; flex-wrap:wrap; gap:var(--s1); margin-top:var(--s1); }
.kg-block { border-top:1px solid var(--border); margin-top:var(--s4); padding-top:var(--s2); }

.kg-peer { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--s1) var(--s2); padding:var(--s2) 0; border-bottom:1px solid var(--border-soft); }
.kg-peer-tags { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:var(--s1); }
.kg-peer-name { background:none; border:0; padding:0; color:var(--text); font:inherit; text-align:left; cursor:pointer; text-decoration:underline; text-underline-offset:2px; }
.kg-peer-arr { color:var(--muted); font-size:var(--fs-sm); font-variant-numeric:tabular-nums; }

.kg-timeline { display:flex; flex-direction:column; gap:1px; margin-top:var(--s2); }
.kg-tl { display:grid; grid-template-columns:10px 84px minmax(0,1fr); gap:var(--s2); align-items:baseline;
  background:none; border:0; border-left:2px solid var(--border); padding:var(--s2); text-align:left;
  font:inherit; font-size:var(--fs-sm); color:var(--text); cursor:pointer; border-radius:var(--radius-sm); }
.kg-tl:hover:not(:disabled) { background:var(--panel-2); }
.kg-tl:disabled { cursor:default; }
.kg-tl .kg-swatch { align-self:center; }
.kg-tl-when { color:var(--muted); font-variant-numeric:tabular-nums; font-size:var(--fs-xs); }
.kg-tl-what { overflow-wrap:anywhere; }
.kg-tl-detail { grid-column:3; color:var(--muted); font-size:var(--fs-xs); }

.kg-field { display:flex; flex-direction:column; gap:var(--s1); margin-top:var(--s3); font-size:var(--fs-sm); color:var(--muted); }
.kg-select, .kg-search { width:100%; background:var(--panel-2); color:var(--text); border:1px solid var(--border);
  border-radius:var(--radius-sm); padding:6px 8px; font:inherit; font-size:var(--fs-sm); }
.kg-tool .btn { margin-top:var(--s3); }
.kg-tool-out { margin-top:var(--s3); }
.kg-steps { margin:0; padding-left:1.1rem; display:flex; flex-direction:column; gap:var(--s2); font-size:var(--fs-sm); line-height:var(--lh-body); }
.kg-checked { margin-top:var(--s3); font-size:var(--fs-sm); }
.kg-checked summary { cursor:pointer; color:var(--muted); }

.kg-factor { display:grid; grid-template-columns:minmax(0,1fr) 110px auto; gap:var(--s2); align-items:center;
  padding:var(--s2) 0; border-bottom:1px solid var(--border-soft); font-size:var(--fs-sm); }
.kg-factor-l { overflow-wrap:anywhere; }
.kg-factor-v { color:var(--muted); font-variant-numeric:tabular-nums; font-size:var(--fs-xs); }
.kg-factor-s { grid-column:1 / -1; color:var(--muted); font-size:var(--fs-xs); line-height:var(--lh-body); }
.kg-bar { position:relative; height:16px; background:var(--panel-2); border-radius:var(--radius-sm); overflow:hidden; }
.kg-bar-fill { position:absolute; inset:0 auto 0 0; background:var(--kg-customer); opacity:.55; }
.kg-bar-base { position:absolute; top:0; bottom:0; left:0; border-right:2px solid var(--text); }

.kg-browse { display:flex; flex-direction:column; max-height:320px; overflow:auto; margin-top:var(--s2); }
.kg-browse-row { display:flex; justify-content:space-between; gap:var(--s2); background:none; border:0;
  border-bottom:1px solid var(--border-soft); padding:6px var(--s1); font:inherit; font-size:var(--fs-sm);
  color:var(--text); text-align:left; cursor:pointer; }
.kg-browse-row:hover { background:var(--panel-2); }
.kg-browse-arr { color:var(--muted); font-variant-numeric:tabular-nums; }
.kg-skeleton { display:flex; flex-direction:column; gap:var(--s3); }
`;
  return s;
}
