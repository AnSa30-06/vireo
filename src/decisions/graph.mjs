// The knowledge graph: a linked model of the business, derived from the tables.
//
// ⭐ WHY THIS EXISTS — the answer to "why not just paste the spreadsheet into
// ChatGPT". A spreadsheet in a chat window is a flat block of characters. The
// model has to infer the structure back out of it, and measured cell-lookup
// accuracy for that is 44-73%. Worse, the relationships between the sheets —
// this contact belongs to that customer, that invoice failed before this ticket
// was raised, these nine customers all report to the same owner — exist only in
// the reader's head. Here they are edges, computed exactly in code, so a
// relationship question is an ordinary traversal and not an inference.
//
// 🔴 NOTHING IS STORED. There is no migration in this file and there is no
// graph table. Every node and every edge is derived from rows that already
// exist, on demand, and cached in memory against a fingerprint of those rows.
// That is the whole safety argument: a stored graph is a second copy of the
// truth, and a second copy drifts. This one cannot disagree with the data
// because it has no independent existence — change a row, the fingerprint
// changes, the graph is rebuilt.
//
// 🔴 THE HONESTY RULE, same as metrics.mjs. Nothing on this screen is a sample
// row or a placeholder. Every count comes from the tables. Where a list is cut
// to a budget, the cut is REPORTED — `hidden`, `omitted` and `truncated` are
// returned next to the numbers, because a graph that quietly draws 160 of 900
// nodes and says nothing is a picture that lies about the size of the business.
//
// PEER RELATIONS ARE NOT MATERIALISED, and that is deliberate. "Shares an
// owner" over 1,000 customers split between five owners is 100,000 pairs — a
// true count, a ruinous array. They are computed from grouped indexes at query
// time, counted exactly with n(n-1)/2, and traversed through internal hub keys
// so a path search is exact and still linear. See `bfsNeighbours`.
import crypto from "node:crypto";
import { getSettings } from "./db.mjs";
import { asOfFor } from "./run.mjs";
import { rules } from "./rules.mjs";
import { money, humanDate, daysBetween } from "./format.mjs";
import * as workspace from "./workspace.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/graph");

/* ══ THE VOCABULARY ════════════════════════════════════════════════════════
 *
 * Node and edge types are data, and they are sent to the page with the graph,
 * for the same reason the segments page gets its fields from the server: a
 * legend written separately from the builder is a legend that goes stale the
 * first time a type is added.
 */

/** The nine node types, in the order the legend lists them. */
export const NODE_TYPES = Object.freeze([
  { id: "customer", label: "Customer", plural: "Customers", from: "account" },
  { id: "decision", label: "Decision", plural: "Decisions", from: "decision" },
  { id: "signal", label: "Signal", plural: "Signals", from: "signal" },
  { id: "contact", label: "Contact", plural: "Contacts", from: "contact" },
  { id: "ticket", label: "Ticket", plural: "Tickets", from: "ticket" },
  { id: "invoice", label: "Invoice", plural: "Invoices", from: "invoice" },
  { id: "event", label: "Event", plural: "Events", from: "event" },
  { id: "outcome", label: "Outcome", plural: "Outcomes", from: "outcome" },
  { id: "segment", label: "Segment", plural: "Segments", from: "account.segment" },
]);

/**
 * The edge types. `derived: true` marks the four that are never materialised —
 * they are counted and traversed from the grouped indexes instead. The page
 * prints that distinction, because "we computed 264 of these" and "we are
 * holding 264 of these" are different claims.
 */
export const EDGE_TYPES = Object.freeze([
  { id: "employs", label: "employs", from: "customer", to: "contact", derived: false },
  { id: "raised", label: "raised", from: "customer", to: "ticket", derived: false },
  { id: "owes", label: "owes", from: "customer", to: "invoice", derived: false },
  { id: "logged", label: "logged", from: "customer", to: "event", derived: false },
  { id: "triggered", label: "triggered", from: "customer", to: "signal", derived: false },
  { id: "about", label: "is about", from: "decision", to: "customer", derived: false },
  { id: "cites", label: "cites", from: "decision", to: "signal", derived: false },
  { id: "resolved_by", label: "was resolved by", from: "decision", to: "outcome", derived: false },
  { id: "in_segment", label: "is in", from: "customer", to: "segment", derived: false },
  { id: "shares_owner", label: "shares an owner with", from: "customer", to: "customer", derived: true },
  { id: "same_segment", label: "is in the same segment as", from: "customer", to: "customer", derived: true },
  { id: "shares_plan", label: "is on the same plan as", from: "customer", to: "customer", derived: true },
  { id: "shares_champion", label: "shares a champion with", from: "customer", to: "customer", derived: true },
]);

const EDGE_BY_ID = new Map(EDGE_TYPES.map((e) => [e.id, e]));

/**
 * The four customer-to-customer relations, each with the account column it is
 * grouped on. `champion` is not a column — it is the name of the contact whose
 * is_champion flag is set — so it carries its own reader instead.
 */
const PEER_ATTRS = Object.freeze([
  { id: "owner", edge: "shares_owner", label: "owner", column: "owner" },
  { id: "segment", edge: "same_segment", label: "segment", column: "segment" },
  { id: "plan", edge: "shares_plan", label: "plan", column: "plan" },
  { id: "champion", edge: "shares_champion", label: "champion", column: null },
]);

/**
 * `industry` is not a peer relation on screen — nobody acts on "also in
 * Logistics" — but it IS one of the things a cohort can turn out to share, so
 * cohortCause looks at it too.
 */
const COHORT_ATTRS = Object.freeze([...PEER_ATTRS, { id: "industry", edge: null, label: "industry", column: "industry" }]);

/* ══ BUDGETS ═══════════════════════════════════════════════════════════════
 *
 * Every one of these is a cut that gets REPORTED rather than a cut that gets
 * hidden. The numbers are chosen so the demo workspace (48 customers, ~700
 * nodes) is never cut at all, and a workspace ten times that size still builds
 * in well under the two seconds this has to answer in.
 */
const CAPS = Object.freeze({
  customer: 4000,
  contact: 8000,
  ticket: 8000,
  invoice: 8000,
  event: 8000,
  signal: 8000,
  decision: 4000,
});

/** How many nodes the drawn picture may carry before it stops being readable. */
const DRAW_BUDGET = 170;
/** How many neighbours one `neighbours()` answer may return. */
const NEIGHBOUR_CAP = 160;
/** How many peers of one relation a neighbour answer lists before saying "and N more". */
const PEER_SHOW = 8;
/** How many rows a timeline returns. */
const TIMELINE_CAP = 300;

/* ══ THE FINGERPRINT ═══════════════════════════════════════════════════════ */

/**
 * A short hash of the source rows. Two databases with the same fingerprint
 * produce the same graph, so the cache can be trusted without a timestamp.
 *
 * ⚠️ COUNT alone is not enough. A decision that moves from `new` to `resolved`
 * changes no count, and the graph would have gone on drawing the old status
 * until something else happened to be inserted. Every table that carries a
 * mutable column contributes its MAX of that column as well.
 */
export function fingerprint(db) {
  const parts = [];
  const add = (label, sql) => {
    try {
      const row = db.prepare(sql).get();
      parts.push(`${label}=${Object.values(row ?? {}).map((v) => (v == null ? "" : String(v))).join("/")}`);
    } catch (err) {
      // A table that is not there yet is a fact about the schema, not a failure.
      parts.push(`${label}=?`);
      log.debug?.(`fingerprint could not read ${label}: ${err?.message ?? err}`);
    }
  };
  add("account", "SELECT COUNT(*) c, MAX(id) a, MAX(arr) b, MAX(renewal_date) d FROM account");
  add("contact", "SELECT COUNT(*) c, MAX(id) a, MAX(last_active_at) b FROM contact");
  add("ticket", "SELECT COUNT(*) c, MAX(id) a, MAX(opened_at) b, MAX(closed_at) d FROM ticket");
  add("invoice", "SELECT COUNT(*) c, MAX(id) a, MAX(status) b, MAX(paid_at) d FROM invoice");
  add("event", "SELECT COUNT(*) c, MAX(id) a, MAX(at) b FROM event");
  add("signal", "SELECT COUNT(*) c, MAX(id) a FROM signal");
  add("decision", "SELECT COUNT(*) c, MAX(id) a, MAX(updated_at) b, MAX(status) d FROM decision");
  add("evidence", "SELECT COUNT(*) c, MAX(decision_id) a FROM decision_evidence");
  add("outcome", "SELECT COUNT(*) c, MAX(recorded_at) a FROM outcome");
  add("run", "SELECT COUNT(*) c, MAX(started_at) a FROM run");
  add("meta", "SELECT value a FROM meta WHERE key = 'as_of'");
  return crypto.createHash("sha1").update(parts.join(";")).digest("hex").slice(0, 16);
}

/* ══ THE CACHE ═════════════════════════════════════════════════════════════
 *
 * Per workspace, keyed by the fingerprint. Three entries is enough for someone
 * flipping between workspaces and small enough that a graph of a big workspace
 * cannot sit in memory in triplicate.
 */
const CACHE = new Map();
const CACHE_MAX = 3;

/** Build the graph for this workspace, or hand back the cached one. */
export function graphFor(db, workspaceId = "default") {
  const fp = fingerprint(db);
  const hit = CACHE.get(workspaceId);
  if (hit && hit.fp === fp) return hit.graph;
  const graph = buildGraph(db);
  CACHE.set(workspaceId, { fp, graph });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
  return graph;
}

/** Test seam, and what a workspace delete should call. */
export function clearCache(workspaceId) {
  if (workspaceId === undefined) CACHE.clear();
  else CACHE.delete(workspaceId);
}

/* ══ BUILDING ══════════════════════════════════════════════════════════════ */

const PREFIX = Object.freeze({
  customer: "cus",
  contact: "con",
  ticket: "tkt",
  invoice: "inv",
  event: "evt",
  signal: "sig",
  decision: "dec",
  outcome: "out",
  segment: "seg",
});

/** A node id carries its type, so a log line or an error names the kind of thing. */
export const nodeId = (type, key) => `${PREFIX[type]}:${key}`;

const txt = (v) => (v == null ? "" : String(v));

/**
 * Build the whole graph from the tables. Read-only: it opens no transaction and
 * writes nothing.
 *
 * Signals come from the LAST RUN only. A signal is a statement about a moment
 * ("usage down 38% over 30 days"), so every run writes a fresh set; drawing all
 * of them would connect a customer to the same observation five times over and
 * make an old, cleared risk look current.
 */
export function buildGraph(db, opts = {}) {
  const started = Date.now();
  const asOf = opts.asOf ?? asOfFor(db);
  const nodes = new Map();
  const edges = [];
  const adj = new Map();
  const omitted = {};

  const addNode = (node) => {
    nodes.set(node.id, node);
    adj.set(node.id, []);
    return node;
  };
  const addEdge = (type, from, to) => {
    if (!nodes.has(from) || !nodes.has(to)) return null;
    const edge = { id: `${type}|${from}|${to}`, type, from, to };
    edges.push(edge);
    adj.get(from).push({ to, edge, out: true });
    adj.get(to).push({ to: from, edge, out: false });
    return edge;
  };

  /**
   * Read at most `cap` rows and record how many were left out.
   *
   * The count is its own query rather than something derived from the select
   * by string surgery: a regex that rewrites a SELECT into a COUNT is a second,
   * silent definition of what is being read, and the two drift the first time a
   * column list changes.
   */
  const read = (type, table, sql, cap) => {
    const total = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get()?.c ?? 0;
    const rows = db.prepare(`${sql} LIMIT ?`).all(cap);
    if (total > rows.length) omitted[type] = total - rows.length;
    return { rows, total };
  };

  /* ── customers ───────────────────────────────────────────────────────── */
  const accounts = read(
    "customer",
    "account",
    "SELECT id, name, arr, plan, seats_purchased, renewal_date, owner, segment, industry, created_at FROM account ORDER BY arr DESC, id",
    CAPS.customer,
  );
  for (const a of accounts.rows) {
    addNode({
      id: nodeId("customer", a.id),
      type: "customer",
      key: a.id,
      label: txt(a.name) || a.id,
      sub: [a.plan, a.segment].filter(Boolean).join(" · "),
      at: a.created_at ?? null,
      accountId: a.id,
      data: {
        arr: a.arr ?? 0,
        plan: a.plan ?? null,
        owner: a.owner ?? null,
        segment: a.segment ?? null,
        industry: a.industry ?? null,
        seats: a.seats_purchased ?? null,
        renewalDate: a.renewal_date ?? null,
        createdAt: a.created_at ?? null,
      },
    });
  }
  const isCustomer = (accountId) => nodes.has(nodeId("customer", accountId));

  /* ── segments, as real nodes ─────────────────────────────────────────── */
  const segmentMembers = new Map();
  for (const a of accounts.rows) {
    if (!a.segment) continue;
    if (!segmentMembers.has(a.segment)) segmentMembers.set(a.segment, []);
    segmentMembers.get(a.segment).push(a.id);
  }
  for (const [name, members] of segmentMembers) {
    addNode({
      id: nodeId("segment", name),
      type: "segment",
      key: name,
      label: name,
      sub: `${members.length} customer${members.length === 1 ? "" : "s"}`,
      at: null,
      accountId: null,
      data: { members: members.length },
    });
  }
  for (const a of accounts.rows) {
    if (a.segment) addEdge("in_segment", nodeId("customer", a.id), nodeId("segment", a.segment));
  }

  /* ── contacts ────────────────────────────────────────────────────────── */
  const champions = new Map(); // account id -> champion name
  const contacts = read(
    "contact",
    "contact",
    "SELECT id, account_id, name, role, is_champion, last_active_at FROM contact ORDER BY is_champion DESC, id",
    CAPS.contact,
  );
  for (const c of contacts.rows) {
    if (!isCustomer(c.account_id)) continue;
    addNode({
      id: nodeId("contact", c.id),
      type: "contact",
      key: c.id,
      label: txt(c.name) || "Contact",
      sub: [c.role, c.is_champion ? "champion" : null].filter(Boolean).join(" · "),
      at: c.last_active_at ?? null,
      accountId: c.account_id,
      data: { role: c.role ?? null, champion: !!c.is_champion, lastActiveAt: c.last_active_at ?? null },
    });
    addEdge("employs", nodeId("customer", c.account_id), nodeId("contact", c.id));
    if (c.is_champion && c.name && !champions.has(c.account_id)) champions.set(c.account_id, String(c.name));
  }

  /* ── tickets ─────────────────────────────────────────────────────────── */
  const tickets = read(
    "ticket",
    "ticket",
    "SELECT id, account_id, opened_at, closed_at, priority, subject FROM ticket ORDER BY opened_at DESC, id",
    CAPS.ticket,
  );
  for (const t of tickets.rows) {
    if (!isCustomer(t.account_id)) continue;
    addNode({
      id: nodeId("ticket", t.id),
      type: "ticket",
      key: t.id,
      label: txt(t.subject) || "Support ticket",
      sub: [t.priority, t.closed_at ? "closed" : "open"].filter(Boolean).join(" · "),
      at: t.opened_at ?? null,
      accountId: t.account_id,
      data: { priority: t.priority ?? null, openedAt: t.opened_at ?? null, closedAt: t.closed_at ?? null, open: !t.closed_at },
    });
    addEdge("raised", nodeId("customer", t.account_id), nodeId("ticket", t.id));
  }

  /* ── invoices ────────────────────────────────────────────────────────── */
  const invoices = read(
    "invoice",
    "invoice",
    "SELECT id, account_id, due_at, amount, status, attempts, paid_at FROM invoice ORDER BY due_at DESC, id",
    CAPS.invoice,
  );
  for (const v of invoices.rows) {
    if (!isCustomer(v.account_id)) continue;
    addNode({
      id: nodeId("invoice", v.id),
      type: "invoice",
      key: v.id,
      label: `Invoice ${txt(v.status) || "—"}`,
      sub: v.due_at ? `due ${humanDate(v.due_at)}` : "",
      at: v.due_at ?? null,
      accountId: v.account_id,
      data: {
        status: v.status ?? null,
        amount: v.amount ?? null,
        attempts: v.attempts ?? null,
        dueAt: v.due_at ?? null,
        paidAt: v.paid_at ?? null,
        failed: String(v.status ?? "").toLowerCase() === "failed",
      },
    });
    addEdge("owes", nodeId("customer", v.account_id), nodeId("invoice", v.id));
  }

  /* ── events ──────────────────────────────────────────────────────────── */
  const events = read("event", "event", "SELECT id, account_id, at, kind, detail FROM event ORDER BY at DESC, id", CAPS.event);
  for (const e of events.rows) {
    if (!isCustomer(e.account_id)) continue;
    addNode({
      id: nodeId("event", e.id),
      type: "event",
      key: e.id,
      label: txt(e.kind).replace(/_/g, " ") || "Event",
      sub: txt(e.detail),
      at: e.at ?? null,
      accountId: e.account_id,
      data: { kind: e.kind ?? null, detail: e.detail ?? null, at: e.at ?? null },
    });
    addEdge("logged", nodeId("customer", e.account_id), nodeId("event", e.id));
  }

  /* ── signals, from the last run only ─────────────────────────────────── */
  const lastRun = db.prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 1").get() ?? null;
  const signalKindCounts = new Map();
  const signalsByCustomer = new Map();
  const customersBySignal = new Map();
  if (lastRun) {
    const total = db.prepare("SELECT COUNT(*) c FROM signal WHERE run_id = ?").get(lastRun.id).c;
    const rows = db
      .prepare(`SELECT id, account_id, kind, band, direction, value, baseline, change_pct, window_days, statement FROM signal WHERE run_id = ? ORDER BY band DESC, id LIMIT ${CAPS.signal}`)
      .all(lastRun.id);
    if (total > rows.length) omitted.signal = total - rows.length;
    for (const s of rows) {
      if (!isCustomer(s.account_id)) continue;
      addNode({
        id: nodeId("signal", s.id),
        type: "signal",
        key: s.id,
        label: txt(s.statement) || txt(s.kind),
        sub: signalLabel(s.kind),
        at: lastRun.as_of ?? null,
        accountId: s.account_id,
        data: {
          kind: s.kind,
          band: s.band,
          direction: s.direction ?? null,
          changePct: s.change_pct ?? null,
          windowDays: s.window_days ?? null,
          statement: s.statement,
        },
      });
      addEdge("triggered", nodeId("customer", s.account_id), nodeId("signal", s.id));
      signalKindCounts.set(s.kind, (signalKindCounts.get(s.kind) ?? 0) + 1);
      if (!signalsByCustomer.has(s.account_id)) signalsByCustomer.set(s.account_id, new Set());
      signalsByCustomer.get(s.account_id).add(s.kind);
      if (!customersBySignal.has(s.kind)) customersBySignal.set(s.kind, new Set());
      customersBySignal.get(s.kind).add(s.account_id);
    }
  }

  /* ── decisions, their evidence and their outcomes ────────────────────── */
  const decisions = read(
    "decision",
    "decision",
    "SELECT id, account_id, kind, title, severity, status, owner, due_at, impact_amount, currency, created_at, updated_at, resolved_at FROM decision ORDER BY updated_at DESC, id",
    CAPS.decision,
  );
  for (const d of decisions.rows) {
    addNode({
      id: nodeId("decision", d.id),
      type: "decision",
      key: d.id,
      label: txt(d.title) || "Decision",
      sub: [d.severity, d.status].filter(Boolean).join(" · "),
      at: d.created_at ?? null,
      accountId: d.account_id ?? null,
      data: {
        kind: d.kind,
        severity: d.severity,
        status: d.status,
        owner: d.owner ?? null,
        dueAt: d.due_at ?? null,
        impact: d.impact_amount ?? null,
        currency: d.currency ?? null,
        createdAt: d.created_at ?? null,
        updatedAt: d.updated_at ?? null,
        resolvedAt: d.resolved_at ?? null,
        companyWide: d.account_id == null,
      },
    });
    // A company-wide decision has no account_id. That is not missing data — it
    // is a decision about everybody — so it simply has no `about` edge.
    if (d.account_id && isCustomer(d.account_id)) addEdge("about", nodeId("decision", d.id), nodeId("customer", d.account_id));
  }
  for (const ev of db.prepare("SELECT decision_id, signal_id FROM decision_evidence").all()) {
    addEdge("cites", nodeId("decision", ev.decision_id), nodeId("signal", ev.signal_id));
  }
  for (const o of db.prepare("SELECT decision_id, result, note, recorded_at, arr_after FROM outcome").all()) {
    if (!nodes.has(nodeId("decision", o.decision_id))) continue;
    addNode({
      id: nodeId("outcome", o.decision_id),
      type: "outcome",
      key: o.decision_id,
      label: `Outcome: ${txt(o.result)}`,
      sub: txt(o.note),
      at: o.recorded_at ?? null,
      accountId: nodes.get(nodeId("decision", o.decision_id))?.accountId ?? null,
      data: { result: o.result, note: o.note ?? null, recordedAt: o.recorded_at ?? null, arrAfter: o.arr_after ?? null },
    });
    addEdge("resolved_by", nodeId("decision", o.decision_id), nodeId("outcome", o.decision_id));
  }

  /* ── the peer indexes ────────────────────────────────────────────────── */
  const index = {};
  const member = new Map();
  for (const attr of PEER_ATTRS) index[attr.id] = new Map();
  for (const a of accounts.rows) {
    const values = {
      owner: a.owner ?? null,
      segment: a.segment ?? null,
      plan: a.plan ?? null,
      champion: champions.get(a.id) ?? null,
      industry: a.industry ?? null,
    };
    member.set(a.id, values);
    for (const attr of PEER_ATTRS) {
      const v = values[attr.id];
      if (!v) continue; // a missing value is not a shared value
      if (!index[attr.id].has(v)) index[attr.id].set(v, []);
      index[attr.id].get(v).push(a.id);
    }
  }
  // industry is not a peer relation, but cohortCause needs the same grouping.
  index.industry = new Map();
  for (const a of accounts.rows) {
    const v = a.industry;
    if (!v) continue;
    if (!index.industry.has(v)) index.industry.set(v, []);
    index.industry.get(v).push(a.id);
  }

  const graph = {
    asOf,
    runId: lastRun?.id ?? null,
    runAt: lastRun?.finished_at ?? lastRun?.started_at ?? null,
    currency: getSettings(db).currency ?? "USD",
    nodes,
    edges,
    adj,
    index,
    member,
    signalsByCustomer,
    customersBySignal,
    signalKindCounts,
    customers: accounts.rows.map((a) => a.id),
    omitted,
    builtMs: Date.now() - started,
  };
  log.debug?.(`graph built: ${nodes.size} nodes, ${edges.length} edges, ${graph.builtMs}ms`);
  return graph;
}

/** The human label for a signal kind, from the shipped rules file. */
function signalLabel(kind) {
  try {
    return rules().signals?.[kind]?.label ?? String(kind ?? "").replace(/_/g, " ");
  } catch {
    return String(kind ?? "").replace(/_/g, " ");
  }
}

/* ══ STATS ═════════════════════════════════════════════════════════════════ */

/**
 * Node counts by type, edge counts by type, and density.
 *
 * Density is computed on the STRUCTURAL edges only and says so. Including the
 * derived peer relations would push it to nearly 1 for any workspace with a
 * handful of owners, which is true and useless — it would mean "everybody is
 * related to everybody", which is exactly the flat answer this screen exists to
 * improve on.
 */
export function graphStats(g) {
  const byType = {};
  for (const t of NODE_TYPES) byType[t.id] = 0;
  for (const n of g.nodes.values()) byType[n.type] = (byType[n.type] ?? 0) + 1;

  const edgeByType = {};
  for (const e of EDGE_TYPES) edgeByType[e.id] = 0;
  for (const e of g.edges) edgeByType[e.type] = (edgeByType[e.type] ?? 0) + 1;

  // The peer relations, counted exactly without being built: a group of k
  // customers contributes k(k-1)/2 pairs.
  let derivedTotal = 0;
  for (const attr of PEER_ATTRS) {
    let pairs = 0;
    for (const members of g.index[attr.id].values()) pairs += (members.length * (members.length - 1)) / 2;
    edgeByType[attr.edge] = pairs;
    derivedTotal += pairs;
  }

  const n = g.nodes.size;
  const structural = g.edges.length;
  const density = n > 1 ? (2 * structural) / (n * (n - 1)) : 0;

  return {
    nodes: n,
    edges: structural,
    derivedEdges: derivedTotal,
    nodesByType: NODE_TYPES.map((t) => ({ id: t.id, label: t.label, plural: t.plural, count: byType[t.id] ?? 0 })),
    edgesByType: EDGE_TYPES.map((t) => ({ id: t.id, label: t.label, derived: t.derived, count: edgeByType[t.id] ?? 0 })),
    density: Math.round(density * 100000) / 100000,
    avgDegree: n ? Math.round(((2 * structural) / n) * 100) / 100 : 0,
    densityNote: "Density counts the stored relationships only. The four customer-to-customer relations are computed on demand, so they are counted but never held.",
    omitted: g.omitted,
    asOf: g.asOf,
    runId: g.runId,
    builtMs: g.builtMs,
  };
}

/* ══ TRAVERSAL ═════════════════════════════════════════════════════════════ */

/** The peers of one customer for one relation, not counting itself. */
function peersFor(g, accountId, attrId) {
  const value = g.member.get(accountId)?.[attrId];
  if (!value) return { value: null, peers: [] };
  const members = g.index[attrId]?.get(value) ?? [];
  return { value, peers: members.filter((id) => id !== accountId) };
}

/**
 * Everything one step away, as the answer format the page draws: one group per
 * edge type, each carrying the nodes and how many were left out.
 */
function firstStep(g, id, peerShow = PEER_SHOW) {
  const node = g.nodes.get(id);
  const groups = new Map();
  const push = (edgeType, targetId, direction) => {
    if (!groups.has(edgeType)) groups.set(edgeType, { edge: edgeType, label: EDGE_BY_ID.get(edgeType)?.label ?? edgeType, items: [], more: 0 });
    groups.get(edgeType).items.push({ id: targetId, direction });
  };
  for (const link of g.adj.get(id) ?? []) push(link.edge.type, link.to, link.out ? "out" : "in");

  if (node?.type === "customer") {
    for (const attr of PEER_ATTRS) {
      const { value, peers } = peersFor(g, node.accountId, attr.id);
      if (!peers.length) continue;
      const group = {
        edge: attr.edge,
        label: `${EDGE_BY_ID.get(attr.edge).label} ${value}`,
        items: peers.slice(0, peerShow).map((a) => ({ id: nodeId("customer", a), direction: "peer" })),
        more: Math.max(0, peers.length - peerShow),
        value,
        total: peers.length,
      };
      groups.set(attr.edge, group);
    }
  }
  return [...groups.values()];
}

/**
 * How many DISTINCT things are one step from this node.
 *
 * 🔴 NOT the sum of the group counts, and the difference is not small. The four
 * customer-to-customer relations overlap heavily - two accounts with the same
 * owner very often share a segment and a plan as well - so the same customer is
 * counted in up to four groups. Measured across all 144 demo customers: every
 * single one over-counted when summed, by a median of 7.
 *
 * ⚠️ It cannot be computed on the page. A group ships at most PEER_SHOW items
 * plus an "and N more", so the page never holds the full peer list and any
 * count it does itself is either the sum (wrong) or the visible items (also
 * wrong). The exact number has to come from here, where the whole set exists.
 */
function distinctFirstStep(g, id) {
  const node = g.nodes.get(id);
  const seen = new Set();
  for (const link of g.adj.get(id) ?? []) seen.add(link.to);
  if (node?.type === "customer") {
    for (const attr of PEER_ATTRS) {
      for (const a of peersFor(g, node.accountId, attr.id).peers) seen.add(nodeId("customer", a));
    }
  }
  seen.delete(id);
  return seen.size;
}

/**
 * What is connected to this, and how.
 *
 * Returns one entry per reached node with the depth it was found at and the
 * edge that reached it. Depth is clamped to 1-3: the graph is small-world
 * enough that depth 4 from any customer reaches most of the business, which is
 * a true answer nobody can read.
 */
export function neighbours(g, id, depth = 1) {
  const start = g.nodes.get(id);
  if (!start) return { ok: false, error: `there is no node called "${id}" in the graph` };
  const want = Math.min(3, Math.max(1, Math.round(Number(depth) || 1)));

  const seen = new Set([id]);
  const found = [];
  let frontier = [id];
  let truncated = false;

  for (let d = 1; d <= want && !truncated; d++) {
    const next = [];
    for (const from of frontier) {
      for (const group of firstStep(g, from)) {
        for (const item of group.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const node = g.nodes.get(item.id);
          if (!node) continue;
          found.push({ node: publicNode(g, node), depth: d, via: group.edge, viaLabel: group.label, from });
          next.push(item.id);
          if (found.length >= NEIGHBOUR_CAP) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    frontier = next;
  }

  return {
    ok: true,
    node: publicNode(g, start),
    depth: want,
    groups: firstStep(g, id).map((gr) => ({
      edge: gr.edge,
      label: gr.label,
      count: gr.total ?? gr.items.length,
      more: gr.more ?? 0,
      items: gr.items.map((i) => publicNode(g, g.nodes.get(i.id))).filter(Boolean),
    })),
    reached: found,
    // The honest headline count. See distinctFirstStep: summing the groups
    // double-counts every customer that shares more than one attribute.
    distinct: distinctFirstStep(g, id),
    truncated,
    // `groups` is exact — it carries the real total and the "and N more" count
    // for every relation. `reached` is the walk, and past the first step it
    // follows at most PEER_SHOW peers per relation, so it is a sample and says
    // so rather than letting the reader count it as the answer.
    note: [
      truncated ? `Only the first ${NEIGHBOUR_CAP} connected things are listed.` : null,
      want > 1 && start.type === "customer"
        ? `Past the first step, at most ${PEER_SHOW} customers per shared owner, segment, plan or champion are followed.`
        : null,
    ]
      .filter(Boolean)
      .join(" ") || null,
  };
}

/**
 * The adjacency a path search walks. Structural edges as they are, plus HUB
 * KEYS for the three peer relations that have no node of their own.
 *
 * ⭐ THIS IS WHY THE SEARCH IS EXACT. Expanding "every customer that shares an
 * owner" at every step would be quadratic and would have to be capped, and a
 * capped search reports "no relationship" for a relationship it simply stopped
 * looking for. Going through a hub costs one visit to the group, so the search
 * stays linear and never has to lie.
 */
function bfsNeighbours(g, id) {
  const out = [];
  if (id.startsWith("#")) {
    const [, attrId, value] = id.match(/^#([a-z]+):([\s\S]*)$/) ?? [];
    for (const a of g.index[attrId]?.get(value) ?? []) out.push({ to: nodeId("customer", a), type: "hub", attrId, value });
    return out;
  }
  for (const link of g.adj.get(id) ?? []) out.push({ to: link.to, type: link.edge.type, forward: link.out });
  const node = g.nodes.get(id);
  if (node?.type === "customer") {
    for (const attr of PEER_ATTRS) {
      if (attr.id === "segment") continue; // segment already has a real node to pass through
      const value = g.member.get(node.accountId)?.[attr.id];
      if (!value) continue;
      if ((g.index[attr.id].get(value) ?? []).length < 2) continue;
      out.push({ to: `#${attr.id}:${value}`, type: "hub", attrId: attr.id, value });
    }
  }
  return out;
}

/**
 * How are these two things related?
 *
 * Shortest path, breadth-first. A pair of hops through a hub (or through a
 * segment node) collapses into the single peer relation it stands for, so
 * "Contoso and Northwind both report to Dana" is one step and not two.
 */
export function pathBetween(g, aId, bId) {
  const a = g.nodes.get(aId);
  const b = g.nodes.get(bId);
  if (!a) return { ok: false, error: `there is no node called "${aId}" in the graph` };
  if (!b) return { ok: false, error: `there is no node called "${bId}" in the graph` };
  if (aId === bId) {
    return { ok: true, found: true, hops: 0, from: publicNode(g, a), to: publicNode(g, b), steps: [], sentence: `${a.label} is the same thing as ${b.label}.` };
  }

  const parent = new Map([[aId, null]]);
  const queue = [aId];
  let visited = 0;
  let head = 0;
  let hit = false;
  while (head < queue.length) {
    const cur = queue[head++];
    visited++;
    if (cur === bId) {
      hit = true;
      break;
    }
    for (const link of bfsNeighbours(g, cur)) {
      if (parent.has(link.to)) continue;
      parent.set(link.to, { from: cur, link });
      queue.push(link.to);
    }
  }

  if (!hit) {
    return {
      ok: true,
      found: false,
      from: publicNode(g, a),
      to: publicNode(g, b),
      visited,
      checked: [
        ["Search", "every relationship in the graph, breadth first"],
        ["Things reached from " + a.label, String(visited)],
        ["Result", "no chain of relationships joins these two"],
      ],
      sentence: `Nothing in the data connects ${a.label} to ${b.label}.`,
    };
  }

  // Walk back to the start, then forward.
  const raw = [];
  for (let cur = bId; parent.get(cur); cur = parent.get(cur).from) {
    const { from, link } = parent.get(cur);
    raw.unshift({ from, to: cur, link });
  }

  const steps = [];
  for (let i = 0; i < raw.length; i++) {
    const step = raw[i];
    const next = raw[i + 1];
    // hub -> customer, or customer -> segment -> customer: one relation.
    const isHubPair = step.link.type === "hub" && next;
    const isSegmentPair =
      step.link.type === "in_segment" &&
      next?.link.type === "in_segment" &&
      g.nodes.get(step.to)?.type === "segment" &&
      g.nodes.get(next.to)?.type === "customer";
    if (isHubPair) {
      steps.push(peerStep(g, step.from, next.to, step.link.attrId, step.link.value));
      i++;
      continue;
    }
    if (isSegmentPair) {
      steps.push(peerStep(g, step.from, next.to, "segment", g.nodes.get(step.to).key));
      i++;
      continue;
    }
    if (step.link.type === "hub") {
      // A hub as the final destination cannot happen — hubs are not requestable
      // — but if the search ever ends on one, say so rather than print "#own:".
      steps.push({ from: publicNode(g, g.nodes.get(step.from)), to: null, edge: "hub", sentence: "shares a group" });
      continue;
    }
    const fromNode = g.nodes.get(step.from);
    const toNode = g.nodes.get(step.to);
    // The adjacency already knows which way the edge was written; re-deriving
    // it by scanning g.edges was O(E) per step for an answer already in hand.
    const forward = step.link.forward === true;
    const spec = EDGE_BY_ID.get(step.link.type);
    steps.push({
      from: publicNode(g, fromNode),
      to: publicNode(g, toNode),
      edge: step.link.type,
      direction: forward ? "out" : "in",
      sentence: forward
        ? `${fromNode.label} ${spec?.label ?? step.link.type} ${toNode.label}`
        : `${toNode.label} ${spec?.label ?? step.link.type} ${fromNode.label}`,
    });
  }

  return {
    ok: true,
    found: true,
    hops: steps.length,
    from: publicNode(g, a),
    to: publicNode(g, b),
    visited,
    steps,
    sentence: `${a.label} and ${b.label} are ${steps.length} step${steps.length === 1 ? "" : "s"} apart.`,
  };
}

function peerStep(g, fromId, toId, attrId, value) {
  const spec = PEER_ATTRS.find((p) => p.id === attrId);
  const fromNode = g.nodes.get(fromId);
  const toNode = g.nodes.get(toId);
  return {
    from: publicNode(g, fromNode),
    to: publicNode(g, toNode),
    edge: spec?.edge ?? attrId,
    direction: "peer",
    value,
    sentence: `${fromNode?.label} and ${toNode?.label} share the same ${spec?.label ?? attrId}: ${value}`,
  };
}

/**
 * Other customers that share an owner, a segment, a plan or a champion with
 * this one AND carry the same signal.
 *
 * ⭐ THE ORDER OF THE TWO TESTS IS THE WHOLE TRICK. Starting from "who shares an
 * attribute" means walking every customer under the same owner, which is the
 * quadratic version. Starting from "who carries one of my signals" is bounded
 * by the signal, which is almost always a handful of customers, and gives the
 * identical answer.
 */
export function sharedRisk(g, accountId) {
  const meId = nodeId("customer", accountId);
  const me = g.nodes.get(meId);
  if (!me) return { ok: false, error: `there is no customer called "${accountId}"` };

  const mySignals = [...(g.signalsByCustomer.get(accountId) ?? [])];
  const myAttrs = g.member.get(accountId) ?? {};

  if (!mySignals.length) {
    return {
      ok: true,
      customer: publicNode(g, me),
      found: false,
      signals: [],
      peers: [],
      checked: [
        ["Customer", me.label],
        ["Signals on this customer in the last analysis", "none"],
        ["Result", g.runId ? "there is nothing to share" : "no analysis has finished yet, so no signals exist"],
      ],
      sentence: g.runId
        ? `${me.label} carries no signals in the last analysis, so no other customer can be moving with it.`
        : "No analysis has finished yet, so there are no signals to compare.",
    };
  }

  const candidates = new Map(); // account id -> Set(kind)
  for (const kind of mySignals) {
    for (const other of g.customersBySignal.get(kind) ?? []) {
      if (other === accountId) continue;
      if (!candidates.has(other)) candidates.set(other, new Set());
      candidates.get(other).add(kind);
    }
  }

  const peers = [];
  for (const [other, kinds] of candidates) {
    const otherAttrs = g.member.get(other) ?? {};
    const shared = [];
    for (const attr of PEER_ATTRS) {
      const v = myAttrs[attr.id];
      if (v && otherAttrs[attr.id] === v) shared.push({ attr: attr.id, label: attr.label, value: v, edge: attr.edge });
    }
    if (!shared.length) continue;
    const node = g.nodes.get(nodeId("customer", other));
    if (!node) continue;
    peers.push({
      node: publicNode(g, node),
      shared,
      signals: [...kinds].map((k) => ({ kind: k, label: signalLabel(k) })),
      arr: node.data.arr ?? 0,
      score: shared.length * 10 + kinds.size,
    });
  }
  peers.sort((x, y) => y.score - x.score || y.arr - x.arr || x.node.label.localeCompare(y.node.label));

  const atRisk = peers.reduce((sum, p) => sum + (p.arr ?? 0), 0);
  return {
    ok: true,
    customer: publicNode(g, me),
    found: peers.length > 0,
    signals: mySignals.map((k) => ({ kind: k, label: signalLabel(k) })),
    peers,
    arrAtRisk: atRisk,
    arrAtRiskLabel: money(atRisk, g.currency),
    checked: [
      ["Customer", me.label],
      ["Signals on this customer", mySignals.map(signalLabel).join(", ")],
      ["Customers carrying at least one of those signals", String(candidates.size)],
      ["Of those, sharing an owner, segment, plan or champion", String(peers.length)],
    ],
    sentence: peers.length
      ? `${peers.length} other customer${peers.length === 1 ? "" : "s"} carry the same signal and share an owner, segment, plan or champion with ${me.label} — ${money(atRisk, g.currency)} of ARR.`
      : `${candidates.size} other customer${candidates.size === 1 ? "" : "s"} carry the same signals, but none of them shares an owner, segment, plan or champion with ${me.label}.`,
  };
}

/**
 * Everything that happened to one customer, in order, across every source
 * table at once.
 *
 * 🔴 THIS IS THE ONE A CHAT WINDOW CANNOT DO AT ALL. The dates live in six
 * different sheets with six different column names — opened_at, due_at,
 * paid_at, last_active_at, at, created_at — and interleaving them is a join,
 * not a summary.
 */
export function timeline(g, accountId) {
  const meId = nodeId("customer", accountId);
  const me = g.nodes.get(meId);
  if (!me) return { ok: false, error: `there is no customer called "${accountId}"` };

  const rows = [];
  const push = (at, type, label, detail, node) => {
    if (!at) return; // an undated row is not placeable; it is left out and counted
    rows.push({ at: String(at), day: String(at).slice(0, 10), type, label, detail: detail ?? "", nodeId: node ?? null });
  };

  push(me.data.createdAt, "customer", "Became a customer", `${money(me.data.arr, g.currency)} of ARR`, meId);

  let undated = 0;
  const attached = [];
  for (const link of g.adj.get(meId) ?? []) attached.push(g.nodes.get(link.to));
  // Decisions point AT the customer, so they arrive on the same adjacency list.
  for (const n of attached) {
    if (!n) continue;
    switch (n.type) {
      case "contact":
        if (n.data.lastActiveAt) push(n.data.lastActiveAt, "contact", `${n.label} was last active`, n.data.champion ? "champion" : n.data.role ?? "", n.id);
        else undated++;
        break;
      case "ticket":
        if (n.data.openedAt) push(n.data.openedAt, "ticket", `Ticket opened: ${n.label}`, n.data.priority ?? "", n.id);
        else undated++;
        if (n.data.closedAt) push(n.data.closedAt, "ticket", `Ticket closed: ${n.label}`, "", n.id);
        break;
      case "invoice":
        if (n.data.dueAt) push(n.data.dueAt, "invoice", `Invoice due — ${n.data.status}`, money(n.data.amount, g.currency), n.id);
        else undated++;
        if (n.data.paidAt) push(n.data.paidAt, "invoice", "Invoice paid", money(n.data.amount, g.currency), n.id);
        break;
      case "event":
        push(n.data.at, "event", n.label, n.data.detail ?? "", n.id);
        break;
      case "signal":
        push(n.at, "signal", n.data.statement, signalLabel(n.data.kind), n.id);
        break;
      case "decision":
        push(n.data.createdAt, "decision", `Decision raised: ${n.label}`, `${n.data.severity} · ${n.data.status}`, n.id);
        if (n.data.resolvedAt) push(n.data.resolvedAt, "decision", `Decision resolved: ${n.label}`, "", n.id);
        break;
      default:
        break;
    }
  }
  // An outcome hangs off the decision, one hop further out.
  for (const link of g.adj.get(meId) ?? []) {
    const d = g.nodes.get(link.to);
    if (d?.type !== "decision") continue;
    for (const l2 of g.adj.get(d.id) ?? []) {
      const o = g.nodes.get(l2.to);
      if (o?.type === "outcome") push(o.data.recordedAt, "outcome", o.label, o.data.note ?? "", o.id);
    }
  }

  rows.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.label.localeCompare(y.label)));
  const shown = rows.slice(0, TIMELINE_CAP);
  const renewal = me.data.renewalDate ? daysBetween(g.asOf, me.data.renewalDate) : null;

  return {
    ok: true,
    customer: publicNode(g, me),
    order: "newest-first",
    entries: shown,
    total: rows.length,
    shown: shown.length,
    hidden: rows.length - shown.length,
    undated,
    asOf: g.asOf,
    renewalInDays: renewal,
    sources: ["account", "contact", "ticket", "invoice", "event", "signal", "decision", "outcome"],
    note:
      rows.length > shown.length
        ? `${rows.length - shown.length} older entries are not listed.`
        : undated
          ? `${undated} rows carry no date and cannot be placed in order.`
          : null,
  };
}

/**
 * Customers that moved together, and what they share.
 *
 * For every customer carrying this signal, the attributes are counted and the
 * commonest value of each is reported WITH THE SHARE — "9 of 12" — and with the
 * share the same value has across the whole customer base. The second number is
 * what stops the first one from being meaningless: if 75% of the movers are on
 * the Team plan and 74% of everybody is on the Team plan, the plan explains
 * nothing.
 */
export function cohortCause(g, kind) {
  const carriers = [...(g.customersBySignal.get(kind) ?? [])];
  const label = signalLabel(kind);
  if (!carriers.length) {
    return {
      ok: true,
      kind,
      label,
      found: false,
      carriers: [],
      factors: [],
      checked: [
        ["Signal", label],
        ["Analysis the signals come from", g.runId ?? "none has finished"],
        ["Customers carrying it", "0"],
      ],
      sentence: g.runId
        ? `No customer carries "${label}" in the last analysis.`
        : "No analysis has finished yet, so no customer carries any signal.",
    };
  }

  const total = g.customers.length;
  const factors = [];
  for (const attr of COHORT_ATTRS) {
    const counts = new Map();
    let known = 0;
    for (const a of carriers) {
      const v = g.member.get(a)?.[attr.id];
      if (!v) continue;
      known++;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    if (!known) continue;
    let bestValue = null;
    let bestCount = 0;
    for (const [v, c] of counts) {
      if (c > bestCount || (c === bestCount && bestValue != null && String(v) < String(bestValue))) {
        bestValue = v;
        bestCount = c;
      }
    }
    const baseCount = (g.index[attr.id]?.get(bestValue) ?? []).length;
    const share = bestCount / carriers.length;
    const baseShare = total ? baseCount / total : 0;
    factors.push({
      attr: attr.id,
      label: attr.label,
      value: bestValue,
      count: bestCount,
      of: carriers.length,
      share: Math.round(share * 1000) / 1000,
      sharePct: Math.round(share * 100),
      baseCount,
      baseOf: total,
      baseSharePct: Math.round(baseShare * 100),
      lift: baseShare > 0 ? Math.round((share / baseShare) * 100) / 100 : null,
      edge: attr.edge,
      sentence: `${bestCount} of ${carriers.length} share the ${attr.label} ${bestValue} — ${Math.round(share * 100)}%, against ${Math.round(baseShare * 100)}% of all ${total} customers.`,
    });
  }
  // The most explanatory first: a high share that is ALSO higher than the
  // background rate. A factor every customer has explains nothing.
  factors.sort((x, y) => (y.share * (y.lift ?? 1)) - (x.share * (x.lift ?? 1)) || y.count - x.count);

  const members = carriers
    .map((a) => g.nodes.get(nodeId("customer", a)))
    .filter(Boolean)
    .sort((x, y) => (y.data.arr ?? 0) - (x.data.arr ?? 0))
    .map((n) => publicNode(g, n));
  const arr = members.reduce((sum, m) => sum + (m.arr ?? 0), 0);
  const top = factors[0] ?? null;

  return {
    ok: true,
    kind,
    label,
    found: true,
    carriers: members,
    count: members.length,
    of: total,
    arr,
    arrLabel: money(arr, g.currency),
    factors,
    checked: [
      ["Signal", label],
      ["Analysis the signals come from", g.runId ?? "none"],
      ["Customers carrying it", `${members.length} of ${total}`],
      ["Attributes compared", COHORT_ATTRS.map((a) => a.label).join(", ")],
    ],
    sentence: top
      ? `${members.length} of ${total} customers carry "${label}" — ${money(arr, g.currency)} of ARR. ${top.sentence}`
      : `${members.length} of ${total} customers carry "${label}" — ${money(arr, g.currency)} of ARR.`,
  };
}

/* ══ WHAT THE PAGE DRAWS ═══════════════════════════════════════════════════ */

/** One node, flattened for the page. Never the raw row. */
function publicNode(g, n) {
  if (!n) return null;
  const out = {
    id: n.id,
    type: n.type,
    key: n.key,
    label: n.label,
    sub: n.sub ?? "",
    at: n.at ?? null,
    accountId: n.accountId ?? null,
  };
  if (n.type === "customer") {
    out.arr = n.data.arr ?? 0;
    out.arrLabel = money(n.data.arr, g.currency);
    out.owner = n.data.owner;
    out.segment = n.data.segment;
    out.plan = n.data.plan;
    out.industry = n.data.industry;
    out.renewalDate = n.data.renewalDate;
  }
  if (n.type === "decision") {
    out.severity = n.data.severity;
    out.status = n.data.status;
    out.decisionId = n.key;
    out.impactLabel = n.data.impact != null ? money(n.data.impact, n.data.currency ?? g.currency) : null;
  }
  if (n.type === "signal") {
    out.kind = n.data.kind;
    out.kindLabel = signalLabel(n.data.kind);
    out.band = n.data.band;
  }
  if (n.type === "invoice") out.failed = n.data.failed;
  if (n.type === "ticket") out.open = n.data.open;
  if (n.type === "contact") out.champion = n.data.champion;
  return out;
}

/**
 * The subgraph the picture is drawn from.
 *
 * ⭐ THE SELECTION IS THE ARGUMENT, so it is made here and not in the page. The
 * interesting customers come first — the ones carrying a decision or a signal —
 * then the largest by ARR, and each keeps the satellites that explain it. A
 * random 170 nodes would look like a network and mean nothing.
 *
 * Everything left out is counted and returned.
 */
export function subgraph(g, opts = {}) {
  const budget = Math.min(400, Math.max(30, Math.round(Number(opts.budget) || DRAW_BUDGET)));
  const focus = opts.focus && g.nodes.has(opts.focus) ? opts.focus : null;

  const picked = new Set();
  const take = (id) => {
    if (!id || !g.nodes.has(id) || picked.has(id)) return false;
    if (picked.size >= budget) return false;
    picked.add(id);
    return true;
  };

  // 1. Rank the customers. A decision beats a signal beats money.
  const decisionCount = new Map();
  for (const e of g.edges) {
    if (e.type !== "about") continue;
    const cus = g.nodes.get(e.to);
    if (cus) decisionCount.set(cus.accountId, (decisionCount.get(cus.accountId) ?? 0) + 1);
  }
  const ranked = g.customers
    .map((a) => ({
      a,
      node: g.nodes.get(nodeId("customer", a)),
      decisions: decisionCount.get(a) ?? 0,
      signals: (g.signalsByCustomer.get(a) ?? new Set()).size,
    }))
    .filter((r) => r.node)
    .sort(
      (x, y) =>
        y.decisions - x.decisions ||
        y.signals - x.signals ||
        (y.node.data.arr ?? 0) - (x.node.data.arr ?? 0) ||
        x.a.localeCompare(y.a),
    );

  if (focus) {
    take(focus);
    const fn = g.nodes.get(focus);
    if (fn?.accountId) take(nodeId("customer", fn.accountId));
  }

  // 2. Customers first, so the ring is drawn from the whole interesting set
  //    before any satellite competes for the budget.
  const customerBudget = Math.min(ranked.length, Math.max(12, Math.floor(budget * 0.42)));
  const chosen = [];
  for (const r of ranked) {
    if (chosen.length >= customerBudget) break;
    if (take(r.node.id)) chosen.push(r);
  }

  // 3. Their segments.
  for (const r of chosen) {
    if (r.node.data.segment) take(nodeId("segment", r.node.data.segment));
  }

  // 4. Satellites, in the order that carries the most meaning, one pass per
  //    kind so an early customer with forty tickets cannot eat the budget.
  const satellitesOf = (accountId, type, limit) => {
    const out = [];
    for (const link of g.adj.get(nodeId("customer", accountId)) ?? []) {
      const n = g.nodes.get(link.to);
      if (n?.type === type) out.push(n);
    }
    if (type === "invoice") out.sort((x, y) => Number(y.data.failed) - Number(x.data.failed) || String(y.at).localeCompare(String(x.at)));
    else if (type === "ticket") out.sort((x, y) => Number(y.data.open) - Number(x.data.open) || String(y.at).localeCompare(String(x.at)));
    else if (type === "contact") out.sort((x, y) => Number(y.data.champion) - Number(x.data.champion));
    else if (type === "signal") out.sort((x, y) => (y.data.band ?? 0) - (x.data.band ?? 0));
    else out.sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return out.slice(0, limit);
  };
  for (const [type, limit] of [
    ["decision", 3],
    ["signal", 3],
    ["invoice", 2],
    ["contact", 1],
    ["ticket", 2],
    ["event", 1],
  ]) {
    for (const r of chosen) {
      for (const n of type === "decision" ? decisionsOf(g, r.a).slice(0, limit) : satellitesOf(r.a, type, limit)) take(n.id);
    }
  }
  // 5. Outcomes of the decisions that made it in.
  for (const id of [...picked]) {
    const n = g.nodes.get(id);
    if (n?.type === "decision") take(nodeId("outcome", n.key));
  }

  const nodes = [...picked].map((id) => publicNode(g, g.nodes.get(id)));
  const edges = g.edges
    .filter((e) => picked.has(e.from) && picked.has(e.to))
    .map((e) => ({ id: e.id, type: e.type, from: e.from, to: e.to }));

  const shownByType = {};
  const totalByType = {};
  for (const t of NODE_TYPES) {
    shownByType[t.id] = 0;
    totalByType[t.id] = 0;
  }
  for (const n of g.nodes.values()) totalByType[n.type] = (totalByType[n.type] ?? 0) + 1;
  for (const n of nodes) shownByType[n.type] = (shownByType[n.type] ?? 0) + 1;

  const hidden = g.nodes.size - nodes.length;
  return {
    nodes,
    edges,
    shown: nodes.length,
    total: g.nodes.size,
    hidden,
    budget,
    byType: NODE_TYPES.map((t) => ({ id: t.id, label: t.label, plural: t.plural, shown: shownByType[t.id] ?? 0, total: totalByType[t.id] ?? 0 })),
    note:
      hidden > 0
        ? `Showing ${nodes.length} of ${g.nodes.size} nodes — the customers carrying decisions and signals first, then the largest by ARR. ${hidden} are not drawn.`
        : `Showing all ${nodes.length} nodes.`,
  };
}

function decisionsOf(g, accountId) {
  const out = [];
  for (const link of g.adj.get(nodeId("customer", accountId)) ?? []) {
    const n = g.nodes.get(link.to);
    if (n?.type === "decision") out.push(n);
  }
  return out.sort((x, y) => String(y.data.updatedAt).localeCompare(String(x.data.updatedAt)));
}

/* ══ THE ROUTES ════════════════════════════════════════════════════════════
 *
 * Thin. Each one resolves the workspace, gets the cached graph, calls one
 * function above and returns what it said. The dispatcher in src/ui/server.mjs
 * turns `{ok:false}` into HTTP 400, so nothing here touches a response.
 */

const ok = (d = {}) => ({ ok: true, ...d });
const bad = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Open the selected workspace, run `fn`, close it whatever happens. */
function withDb(fn) {
  const sel = workspace.openSelected();
  if (!sel) return bad("no workspace yet", { needsWorkspace: true });
  try {
    return fn(sel.db, sel.id);
  } finally {
    try {
      sel.db.close();
    } catch {}
  }
}

/** A customer id may arrive as "ACC-001" or as the node id "cus:ACC-001". */
function asCustomerId(value) {
  const s = String(value ?? "").trim();
  return s.startsWith(`${PREFIX.customer}:`) ? s.slice(PREFIX.customer.length + 1) : s;
}

export const graphRoutes = {
  /**
   * Everything the page needs for its first paint: the stats, the legend, the
   * drawable subgraph and the signal kinds the cohort picker offers.
   */
  async decisionsGraph({ query } = {}) {
    return withDb((db, wsId) => {
      const g = graphFor(db, wsId);
      const stats = graphStats(g);
      return ok({
        asOf: g.asOf,
        currency: g.currency,
        runId: g.runId,
        runAt: g.runAt,
        stats,
        legend: { nodeTypes: NODE_TYPES, edgeTypes: EDGE_TYPES },
        signalKinds: [...g.signalKindCounts.entries()]
          .map(([kind, count]) => ({
            kind,
            label: signalLabel(kind),
            signals: count,
            customers: (g.customersBySignal.get(kind) ?? new Set()).size,
          }))
          .sort((a, b) => b.customers - a.customers || a.label.localeCompare(b.label)),
        customers: g.customers
          .map((a) => publicNode(g, g.nodes.get(nodeId("customer", a))))
          .filter(Boolean)
          .sort((a, b) => (b.arr ?? 0) - (a.arr ?? 0)),
        subgraph: subgraph(g, { budget: query?.budget, focus: query?.focus }),
        empty: g.nodes.size === 0,
      });
    });
  },

  /** One node: what it is, and what is connected to it. */
  async decisionsGraphNode({ query, body } = {}) {
    const id = String(body?.id ?? query?.id ?? "").trim();
    if (!id) return bad("which node?");
    return withDb((db, wsId) => {
      const g = graphFor(db, wsId);
      const r = neighbours(g, id, body?.depth ?? query?.depth ?? 1);
      if (!r.ok) return bad(r.error);
      return ok({ ...r, asOf: g.asOf, currency: g.currency });
    });
  },

  /** How are these two things related? */
  async decisionsGraphPath({ query, body } = {}) {
    const from = String(body?.from ?? query?.from ?? "").trim();
    const to = String(body?.to ?? query?.to ?? "").trim();
    if (!from || !to) return bad("two things are needed to find a path between them");
    return withDb((db, wsId) => {
      const g = graphFor(db, wsId);
      const r = pathBetween(g, from, to);
      if (!r.ok) return bad(r.error);
      return ok({ ...r, asOf: g.asOf });
    });
  },

  /** Everything that happened to one customer, in order. */
  async decisionsGraphTimeline({ query, body } = {}) {
    const id = asCustomerId(body?.id ?? query?.id);
    if (!id) return bad("which customer?");
    return withDb((db, wsId) => {
      const g = graphFor(db, wsId);
      const r = timeline(g, id);
      if (!r.ok) return bad(r.error);
      return ok({ ...r, currency: g.currency });
    });
  },

  /** Who else is moving with this customer, and what they have in common. */
  async decisionsGraphShared({ query, body } = {}) {
    const id = asCustomerId(body?.id ?? query?.id);
    if (!id) return bad("which customer?");
    return withDb((db, wsId) => {
      const g = graphFor(db, wsId);
      const r = sharedRisk(g, id);
      if (!r.ok) return bad(r.error);
      return ok({ ...r, asOf: g.asOf, currency: g.currency });
    });
  },

  /** Customers that moved together on one signal, and what they share. */
  async decisionsGraphCohort({ query, body } = {}) {
    const kind = String(body?.kind ?? query?.kind ?? "").trim();
    if (!kind) return bad("which signal?");
    return withDb((db, wsId) => {
      const g = graphFor(db, wsId);
      return ok({ ...cohortCause(g, kind), asOf: g.asOf, currency: g.currency });
    });
  },
};

export default graphRoutes;
