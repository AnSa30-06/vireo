// The knowledge graph: what it is made of, what it can answer, and the three
// places it could have quietly lied.
//
// 🔴 THE TESTS THAT MATTER MOST ARE THE FOUR HONESTY ONES.
//
//   1. DERIVED, NOT STORED. The whole claim of this feature is that the graph
//      cannot disagree with the data, and that claim rests entirely on there
//      being no graph table. A test that the module ships no migration and no
//      CREATE TABLE is the only thing standing between "derived" and a second
//      copy of the truth that drifts.
//   2. SHARED RISK NEEDS BOTH HALVES. "Carries the same signal" alone is a
//      coincidence; "shares an owner" alone is an org chart. Only the pair is
//      worth showing someone, and a customer that satisfies exactly one of them
//      has to be left out. A missing value is not a shared value either — two
//      customers with no owner do not share an owner.
//   3. A COHORT SHARE WITHOUT THE BACKGROUND SHARE IS A LIE BY OMISSION. If 67%
//      of the movers are on the Team plan and 67% of everybody is on the Team
//      plan, the plan explains nothing, and a screen printing only the first
//      number reads as though it explains everything.
//   4. THE CUT IS REPORTED. The picture is smaller than the graph. Shown plus
//      hidden has to equal the total, or the screen is understating the size of
//      the business without saying so.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LEDGERLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerline-graph-test-"));

const { pkg } = await import("../../src/util/paths.mjs");
const { openMemory, setMeta, setSettings } = await import("../../src/decisions/db.mjs");
const G = await import("../../src/decisions/graph.mjs");
const workspace = await import("../../src/decisions/workspace.mjs");

const AS_OF = "2026-09-15";

/**
 * A workspace with one of every awkward shape in it:
 *   a1, a2  same owner, segment, plan AND champion, both carrying the same signal
 *   a3, a4  a second cluster that shares nothing with the first
 *   a5, a6  no owner, no segment, no plan — two nulls that must not "match"
 *   d2      a company-wide decision, which has no account and is not a mistake
 *   c2      a contact with no last_active_at, which cannot be placed in time
 */
function seed(db) {
  const acc = db.prepare(
    "INSERT INTO account (id, name, arr, plan, seats_purchased, renewal_date, owner, segment, industry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  acc.run("a1", "Northwind", 120000, "Team", 40, "2026-10-01", "Dana", "Mid-market", "Retail", "2026-01-10");
  acc.run("a2", "Contoso", 40000, "Team", 20, "2026-12-20", "Dana", "Mid-market", "Retail", "2026-02-02");
  acc.run("a3", "Fabrikam", 90000, "Starter", 10, "2027-01-05", "Ravi", "SMB", "Logistics", "2025-11-01");
  acc.run("a4", "Tailspin", 30000, "Starter", 8, null, "Ravi", "SMB", null, "2025-12-01");
  acc.run("a5", "Adrift", 10000, null, null, null, null, null, null, "2026-03-03");
  acc.run("a6", "Solo", 5000, null, null, null, null, null, null, "2026-03-04");

  const con = db.prepare("INSERT INTO contact (id, account_id, name, role, is_champion, last_active_at) VALUES (?, ?, ?, ?, ?, ?)");
  con.run("c1", "a1", "Alex Kim", "Head of Ops", 1, "2026-09-01");
  con.run("c2", "a1", "Jo Patel", "Billing", 0, null); // undated on purpose
  con.run("c3", "a2", "Alex Kim", "Head of Ops", 1, "2026-09-02");
  con.run("c4", "a3", "Priya Rao", "Head of Ops", 1, "2026-09-03");

  const tkt = db.prepare("INSERT INTO ticket (id, account_id, opened_at, closed_at, priority, subject) VALUES (?, ?, ?, ?, ?, ?)");
  tkt.run("t1", "a1", "2026-09-05", "2026-09-08", "urgent", "Exports failing");
  tkt.run("t2", "a1", "2026-09-11", null, "normal", "Slow dashboards");
  tkt.run("t3", "a3", "2026-08-20", null, "normal", "SSO question");

  const inv = db.prepare("INSERT INTO invoice (id, account_id, due_at, amount, status, attempts, paid_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  inv.run("i1", "a1", "2026-09-12", 10000, "failed", 3, null);
  inv.run("i2", "a2", "2026-09-12", 3333, "paid", 1, "2026-09-12");

  db.prepare("INSERT INTO event (id, account_id, at, kind, detail) VALUES (?, ?, ?, ?, ?)").run(
    "e1",
    "a1",
    "2026-09-09",
    "pricing_page_view",
    "viewed the Business plan",
  );

  db.prepare("INSERT INTO run (id, started_at, finished_at, as_of, status) VALUES (?, ?, ?, ?, ?)").run(
    "r1",
    "2026-09-15T08:00:00.000Z",
    "2026-09-15T08:01:00.000Z",
    AS_OF,
    "ok",
  );
  const sig = db.prepare(
    "INSERT INTO signal (id, run_id, account_id, kind, band, direction, value, baseline, change_pct, window_days, statement) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  sig.run("s1", "r1", "a1", "usage_drop_30d", 2, "down", 40, 80, -50, 30, "Active users down 50% in 30 days");
  sig.run("s2", "r1", "a2", "usage_drop_30d", 1, "down", 18, 24, -25, 30, "Active users down 25% in 30 days");
  sig.run("s3", "r1", "a3", "usage_drop_30d", 1, "down", 9, 12, -25, 30, "Active users down 25% in 30 days");
  sig.run("s4", "r1", "a4", "renewal_near", 1, null, null, null, null, null, "Renewal in 30 days");
  sig.run("s5", "r1", "a5", "payment_failed", 1, null, null, null, null, null, "A payment failed");
  sig.run("s6", "r1", "a6", "payment_failed", 1, null, null, null, null, null, "A payment failed");

  const dec = db.prepare(
    "INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, owner, due_at, impact_amount, currency, reasoning_source, created_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  dec.run("d1", "a1", "f1", "churn_risk", "Northwind usage fell by half", "critical", "resolved", "Dana", "2026-09-20", 120000, "USD", "model", "2026-09-13T09:00:00Z", "2026-09-14T09:00:00Z", "2026-09-14T09:00:00Z");
  dec.run("d2", null, "f2", "cohort_shift", "Usage fell across Mid-market", "high", "new", null, null, null, "USD", "model", "2026-09-13T10:00:00Z", "2026-09-13T10:00:00Z", null);

  db.prepare("INSERT INTO decision_evidence (decision_id, signal_id, rank, statement, kind) VALUES (?, ?, ?, ?, ?)").run(
    "d1",
    "s1",
    1,
    "Active users down 50% in 30 days",
    "usage_drop_30d",
  );
  db.prepare("INSERT INTO outcome (decision_id, result, note, recorded_at, arr_after) VALUES (?, ?, ?, ?, ?)").run(
    "d1",
    "saved",
    "Renewed after an exec call",
    "2026-09-14T12:00:00Z",
    120000,
  );

  setMeta(db, "as_of", AS_OF);
  setSettings(db, { demoMode: true, currency: "USD" });
  return db;
}

const fresh = () => seed(openMemory());
const build = () => G.buildGraph(fresh());

/* ── 1. derived, never stored ───────────────────────────────────────────── */

test("the graph module ships no migration and creates no table", async () => {
  // This is the feature's central claim. A graph that is written down is a
  // second copy of the truth, and a second copy drifts the moment one of the
  // source rows changes without the copy being rebuilt.
  const src = fs.readFileSync(pkg("src", "decisions", "graph.mjs"), "utf8");
  const creates = src.match(/CREATE\s+TABLE/gi) ?? [];
  assert.deepEqual(creates, [], "graph.mjs must not create any table — the graph is derived from the ones that exist");
  const migrations = Object.keys(G).filter((k) => /MIGRATION/.test(k));
  assert.deepEqual(migrations, [], `graph.mjs must export no migration, found: ${migrations.join(", ")}`);

  // And nothing in the schema may be carrying a graph table on its behalf.
  const { MIGRATIONS } = await import("../../src/decisions/db.mjs");
  const carrying = MIGRATIONS.filter((sql) => /CREATE TABLE (graph|graph_node|graph_edge)\b/i.test(sql));
  assert.deepEqual(carrying, [], "the schema must not hold a graph table either");
});

test("the graph never writes to the database it reads", () => {
  const db = fresh();
  const before = ["account", "contact", "ticket", "invoice", "event", "signal", "decision", "outcome"].map(
    (t) => `${t}:${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`,
  );
  const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name);
  const g = G.buildGraph(db);
  G.graphStats(g);
  G.timeline(g, "a1");
  G.sharedRisk(g, "a1");
  G.cohortCause(g, "usage_drop_30d");
  G.subgraph(g);
  const after = ["account", "contact", "ticket", "invoice", "event", "signal", "decision", "outcome"].map(
    (t) => `${t}:${db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c}`,
  );
  assert.deepEqual(after, before, "nothing the graph does may change a row");
  assert.deepEqual(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((r) => r.name),
    tablesBefore,
    "nothing the graph does may create a table",
  );
});

test("a changed row changes the fingerprint, so the cache cannot serve a stale graph", () => {
  // ⚠️ A COUNT alone would not catch this. Resolving a decision changes no
  // count anywhere, and the cache would have gone on serving the old status
  // until something unrelated happened to be inserted.
  const db = fresh();
  const before = G.fingerprint(db);
  const g1 = G.graphFor(db, "ws-cache");
  assert.equal(G.graphFor(db, "ws-cache"), g1, "an unchanged database must hand back the very same graph object");

  db.prepare("UPDATE decision SET status = 'dismissed', updated_at = ? WHERE id = 'd1'").run("2026-09-16T09:00:00Z");
  const after = G.fingerprint(db);
  assert.notEqual(after, before, "a status change must change the fingerprint");

  const g2 = G.graphFor(db, "ws-cache");
  assert.notEqual(g2, g1, "a changed fingerprint must rebuild rather than serve the cached graph");
  assert.equal(g2.nodes.get("dec:d1").data.status, "dismissed");
  G.clearCache();
});

/* ── 2. what is in the model ────────────────────────────────────────────── */

test("every source table becomes typed nodes and typed edges", () => {
  const g = build();
  const stats = G.graphStats(g);
  const n = Object.fromEntries(stats.nodesByType.map((t) => [t.id, t.count]));
  assert.deepEqual(
    n,
    { customer: 6, decision: 2, signal: 6, contact: 4, ticket: 3, invoice: 2, event: 1, outcome: 1, segment: 2 },
    "one node per row, and one segment node per distinct segment value",
  );

  const e = Object.fromEntries(stats.edgesByType.map((t) => [t.id, t.count]));
  assert.equal(e.employs, 4);
  assert.equal(e.raised, 3);
  assert.equal(e.owes, 2);
  assert.equal(e.logged, 1);
  assert.equal(e.triggered, 6);
  assert.equal(e.cites, 1);
  assert.equal(e.resolved_by, 1);
  assert.equal(e.in_segment, 4, "a1..a4 are in a segment; a5 and a6 have none");
  assert.equal(e.about, 1, "only the decision that names an account points at one");
});

test("a company-wide decision is kept, and is not given a customer it does not have", () => {
  // account_id NULL means "about everybody", which is a real state and not a
  // gap. Dropping it would silently lose a decision; inventing an edge would
  // blame a customer.
  const g = build();
  const d2 = g.nodes.get("dec:d2");
  assert.ok(d2, "the company-wide decision must still be a node");
  assert.equal(d2.accountId, null);
  assert.equal(d2.data.companyWide, true);
  assert.equal(g.edges.filter((x) => x.type === "about" && x.from === "dec:d2").length, 0);
});

test("the four customer-to-customer relations are counted exactly and never materialised", () => {
  // ⭐ n(n-1)/2 per group. Building them would be quadratic; counting them is
  // arithmetic. Dana owns a1 and a2, Ravi owns a3 and a4 -> one pair each.
  const g = build();
  const stats = G.graphStats(g);
  const e = Object.fromEntries(stats.edgesByType.map((t) => [t.id, t.count]));
  assert.equal(e.shares_owner, 2);
  assert.equal(e.same_segment, 2);
  assert.equal(e.shares_plan, 2);
  assert.equal(e.shares_champion, 1, "Alex Kim is champion at a1 and a2; Priya is champion at one account only");
  assert.equal(stats.derivedEdges, 7);

  const derivedTypes = new Set(stats.edgesByType.filter((t) => t.derived).map((t) => t.id));
  const held = g.edges.filter((x) => derivedTypes.has(x.type));
  assert.deepEqual(held, [], "a derived relation must never be stored in the edge list");
  assert.equal(stats.edges, g.edges.length, "density is reported on the stored edges only");
});

test("a customer name that looks like SQL is data, not SQL", () => {
  const db = openMemory();
  db.prepare("INSERT INTO account (id, name, arr) VALUES (?, ?, ?)").run("x1", "Northwind'); DROP TABLE account;--", 1000);
  const g = G.buildGraph(db);
  assert.equal(g.nodes.get("cus:x1").label, "Northwind'); DROP TABLE account;--");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM account").get().c, 1, "the account table must still be there");
});

/* ── 3. traversals a flat table cannot do ───────────────────────────────── */

test("neighbours reports the exact count of each relation, and says what it left out", () => {
  const g = build();
  const r = G.neighbours(g, "cus:a1", 1);
  assert.equal(r.ok, true);
  const by = Object.fromEntries(r.groups.map((x) => [x.edge, x.count]));
  assert.equal(by.employs, 2);
  assert.equal(by.raised, 2);
  assert.equal(by.owes, 1);
  assert.equal(by.logged, 1);
  assert.equal(by.triggered, 1);
  assert.equal(by.about, 1);
  assert.equal(by.in_segment, 1);
  assert.equal(by.shares_owner, 1, "Contoso is the other account Dana owns");
  assert.equal(by.shares_champion, 1);
});

test("the headline connection count is distinct things, not the sum of the groups", () => {
  // 🔴 THE BUG THIS EXISTS FOR. The page printed
  // `groups.reduce((s, g) => s + g.count, 0)`, which counts a customer once per
  // relation it shares. An audit measured every one of the 144 demo customers
  // over-counting, by a median of 7. It is the kind of wrong number nobody
  // notices on screen and anybody can check.
  const g = build();
  const r = G.neighbours(g, "cus:a1", 1);
  assert.equal(r.ok, true);

  // The true answer, counted independently of the code under test.
  const truth = new Set();
  for (const link of g.adj.get("cus:a1") ?? []) truth.add(link.to);
  for (const [id, node] of g.nodes) {
    if (node.type !== "customer" || id === "cus:a1") continue;
    const mine = g.member.get(g.nodes.get("cus:a1").accountId) ?? {};
    const theirs = g.member.get(node.accountId) ?? {};
    if (["owner", "segment", "plan", "champion"].some((k) => mine[k] && theirs[k] === mine[k])) truth.add(id);
  }
  truth.delete("cus:a1");
  assert.equal(r.distinct, truth.size, "distinct must equal the independently counted set");

  // And the fixture has to contain an overlap, or the assertion above would hold
  // for the buggy sum too and this test would prove nothing. Contoso reaches a1
  // twice here: once by a shared owner, once by a shared champion.
  const summed = r.groups.reduce((s, x) => s + x.count, 0);
  assert.ok(
    truth.size < summed,
    `the fixture must contain an overlapping peer (distinct ${truth.size}, summed ${summed})`,
  );
});

test("an unknown node is an error with the id in it, never an empty answer", () => {
  // An empty answer reads as "nothing is connected to this", which is a claim
  // about the data. A typo is a claim about the question.
  const g = build();
  const r = G.neighbours(g, "cus:nope", 1);
  assert.equal(r.ok, false);
  assert.match(r.error, /cus:nope/);
  assert.equal(G.pathBetween(g, "cus:nope", "cus:a1").ok, false);
  assert.equal(G.timeline(g, "nope").ok, false);
  assert.equal(G.sharedRisk(g, "nope").ok, false);
});

test("pathBetween collapses a pair of hops through a shared attribute into one relation", () => {
  // Two customers under the same owner are ONE relationship, not two. Reporting
  // the hub as a step would make every pair look twice as far apart as it is.
  const g = build();
  const r = G.pathBetween(g, "cus:a1", "cus:a2");
  assert.equal(r.found, true);
  assert.equal(r.hops, 1, `expected one relationship, got: ${JSON.stringify(r.steps)}`);
  const step = r.steps[0];
  assert.ok(["same_segment", "shares_owner", "shares_plan", "shares_champion"].includes(step.edge), step.edge);
  assert.equal(step.direction, "peer");
  assert.match(step.sentence, /Northwind and Contoso share the same/);
});

test("a shared owner alone joins two customers in one step, with no segment to pass through", () => {
  // ⚠️ WRITTEN AFTER THE REVERT PROOF FOUND A HOLE. The test above looked like
  // it covered the collapse, but with segments present the search reaches the
  // second customer through the real segment node, so disabling the HUB collapse
  // changed nothing and the test still passed. Owner, plan and champion have no
  // node of their own and are the only relations that exercise that branch.
  const db = fresh();
  db.prepare("UPDATE account SET segment = NULL, plan = NULL").run();
  db.prepare("UPDATE contact SET is_champion = 0").run();
  const g = G.buildGraph(db);
  assert.equal(g.nodes.get("seg:Mid-market"), undefined, "no segment node may remain");
  const r = G.pathBetween(g, "cus:a1", "cus:a2");
  assert.equal(r.found, true);
  assert.equal(r.hops, 1, JSON.stringify(r.steps));
  assert.equal(r.steps[0].edge, "shares_owner");
  assert.equal(r.steps[0].value, "Dana");
  assert.match(r.steps[0].sentence, /Northwind and Contoso share the same owner: Dana/);
});

test("pathBetween walks from a ticket to another customer through its own account", () => {
  const g = build();
  const r = G.pathBetween(g, "tkt:t1", "cus:a2");
  assert.equal(r.found, true);
  assert.equal(r.hops, 2);
  assert.equal(r.steps[0].edge, "raised");
  assert.match(r.steps[0].sentence, /Northwind raised/);
  assert.ok(["same_segment", "shares_owner", "shares_plan", "shares_champion"].includes(r.steps[1].edge));
});

test("two unrelated customers come back as not found, with what was searched", () => {
  // 🔴 NO MATCH IS A RESULT. "These two are not connected" and "the search gave
  // up" have to be different answers, so the refusal carries the size of the
  // search it actually did.
  const g = build();
  const r = G.pathBetween(g, "cus:a1", "cus:a3");
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
  assert.ok(r.visited > 1, "the answer must say how much was reached");
  assert.ok(r.checked.length >= 2);
  assert.match(r.sentence, /Nothing in the data connects Northwind to Fabrikam/);
});

test("a node is zero steps from itself", () => {
  const g = build();
  const r = G.pathBetween(g, "cus:a1", "cus:a1");
  assert.equal(r.hops, 0);
  assert.deepEqual(r.steps, []);
});

/* ── 4. shared risk needs BOTH halves ───────────────────────────────────── */

test("shared risk requires the same signal AND a shared attribute", () => {
  // a2 shares owner, segment, plan and champion with a1 AND carries the same
  // signal -> in. a3 carries the same signal and shares nothing -> out.
  const g = build();
  const r = G.sharedRisk(g, "a1");
  assert.equal(r.found, true);
  assert.deepEqual(r.peers.map((p) => p.node.key), ["a2"], "only the customer that satisfies both tests may appear");
  const shared = r.peers[0].shared.map((s) => s.attr).sort();
  assert.deepEqual(shared, ["champion", "owner", "plan", "segment"]);
  assert.deepEqual(r.peers[0].signals.map((s) => s.kind), ["usage_drop_30d"]);
  assert.equal(r.arrAtRisk, 40000);
  assert.match(r.checked.map((c) => c.join(": ")).join(" | "), /Customers carrying at least one of those signals: 2/);
});

test("a missing value is not a shared value", () => {
  // a5 and a6 both have NULL owner, NULL segment and NULL plan, and both carry
  // payment_failed. Treating null as a value would pair them up and put a
  // fabricated cohort on the screen.
  const g = build();
  const r = G.sharedRisk(g, "a5");
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
  assert.deepEqual(r.peers, []);
  assert.match(r.sentence, /none of them shares an owner, segment, plan or champion/);
});

test("a customer with no signals says so rather than returning an empty list", () => {
  const db = fresh();
  db.prepare("DELETE FROM signal WHERE account_id = 'a1'").run();
  const g = G.buildGraph(db);
  const r = G.sharedRisk(g, "a1");
  assert.equal(r.found, false);
  assert.match(r.sentence, /carries no signals/);
  assert.ok(r.checked.some((c) => /Signals on this customer/.test(c[0])));
});

/* ── 5. the timeline across every table at once ─────────────────────────── */

test("the timeline merges every source table and orders it newest first", () => {
  const g = build();
  const r = G.timeline(g, "a1");
  assert.equal(r.ok, true);
  const types = new Set(r.entries.map((e) => e.type));
  for (const want of ["customer", "contact", "ticket", "invoice", "event", "signal", "decision", "outcome"]) {
    assert.ok(types.has(want), `the timeline must carry the ${want} rows; it had ${[...types].join(", ")}`);
  }
  for (let i = 1; i < r.entries.length; i++) {
    assert.ok(r.entries[i - 1].at >= r.entries[i].at, `entries must be newest first, ${r.entries[i - 1].at} came before ${r.entries[i].at}`);
  }
  // Both ends of a ticket, both ends of an invoice.
  assert.ok(r.entries.some((e) => /Ticket opened/.test(e.label)));
  assert.ok(r.entries.some((e) => /Ticket closed/.test(e.label)));
  assert.ok(r.entries.some((e) => /Invoice due/.test(e.label)));
  assert.ok(r.entries.some((e) => /Decision resolved/.test(e.label)));
});

test("a row with no date is counted, not placed at the start of time", () => {
  // Jo Patel has never been active. Giving that row a date would invent one,
  // and dropping it silently would make the count on the screen wrong.
  const g = build();
  const r = G.timeline(g, "a1");
  assert.equal(r.undated, 1);
  assert.ok(!r.entries.some((e) => /Jo Patel/.test(e.label)), "an undated row must not appear in the order");
  assert.equal(r.shown, r.entries.length);
  assert.equal(r.total, r.shown + r.hidden);
});

/* ── 6. the cohort, with the background rate ────────────────────────────── */

test("a cohort factor carries the share AND the share across everybody", () => {
  // 🔴 Without the second number the first one means nothing. Two of the three
  // movers are Dana's, and Dana owns two of the six customers.
  const g = build();
  const r = G.cohortCause(g, "usage_drop_30d");
  assert.equal(r.found, true);
  assert.equal(r.count, 3);
  assert.equal(r.of, 6);
  const owner = r.factors.find((f) => f.attr === "owner");
  assert.equal(owner.value, "Dana");
  assert.equal(owner.count, 2);
  assert.equal(owner.of, 3);
  assert.equal(owner.baseCount, 2);
  assert.equal(owner.baseOf, 6);
  assert.equal(owner.sharePct, 67);
  assert.equal(owner.baseSharePct, 33);
  assert.equal(owner.lift, 2);
  assert.match(owner.sentence, /2 of 3 share the owner Dana — 67%, against 33% of all 6 customers/);
  assert.equal(r.arr, 250000);
});

test("a signal nobody carries is a result, not an empty table", () => {
  const g = build();
  const r = G.cohortCause(g, "seat_util_high");
  assert.equal(r.ok, true);
  assert.equal(r.found, false);
  assert.deepEqual(r.carriers, []);
  assert.ok(r.checked.some((c) => /Customers carrying it/.test(c[0])));
  assert.match(r.sentence, /No customer carries/);
});

/* ── 7. the picture reports its own cut ─────────────────────────────────── */

test("the drawn subgraph says how many nodes are not drawn, and the numbers add up", () => {
  const g = build();
  const small = G.subgraph(g, { budget: 30 });
  assert.equal(small.shown + small.hidden, small.total, "shown plus hidden must equal the whole graph");
  assert.equal(small.total, g.nodes.size);
  assert.ok(small.shown <= 30);
  assert.match(small.note, new RegExp(`Showing ${small.shown} of ${small.total} nodes`));
  assert.match(small.note, new RegExp(`${small.hidden} are not drawn`));
  for (const t of small.byType) assert.ok(t.shown <= t.total, `${t.id}: cannot draw more than exist`);
});

test("the customers carrying a decision are drawn before the rest", () => {
  // The selection IS the argument. A random subgraph would look like a network
  // and say nothing, so the ranking is part of the contract.
  const g = build();
  const drawn = new Set(G.subgraph(g, { budget: 12 }).nodes.map((n) => n.id));
  assert.ok(drawn.has("cus:a1"), "the customer with a decision against it must survive the tightest budget");
});

test("every edge in the subgraph joins two nodes that are in it", () => {
  const g = build();
  const sub = G.subgraph(g, { budget: 24 });
  const ids = new Set(sub.nodes.map((n) => n.id));
  for (const e of sub.edges) {
    assert.ok(ids.has(e.from) && ids.has(e.to), `edge ${e.id} points outside the drawn set`);
  }
});

/* ── 8. the routes ──────────────────────────────────────────────────────── */

test("the six routes exist, are functions, and are namespaced", () => {
  const want = [
    "decisionsGraph",
    "decisionsGraphNode",
    "decisionsGraphPath",
    "decisionsGraphTimeline",
    "decisionsGraphShared",
    "decisionsGraphCohort",
  ];
  assert.deepEqual(Object.keys(G.graphRoutes).sort(), [...want].sort());
  for (const name of want) {
    assert.equal(typeof G.graphRoutes[name], "function", `${name} must be a handler`);
    assert.match(name, /^decisions[A-Z]/);
  }
});

test("a route with no workspace says so, and does not read as a failure", () => {
  // The shell draws its own onboarding whenever needsWorkspace comes back, so
  // this has to be that flag and not a generic error.
  const r = G.graphRoutes.decisionsGraph.call(null, { query: {} });
  return r.then((out) => {
    assert.equal(out.ok, false);
    assert.equal(out.needsWorkspace, true);
  });
});

test("every route guards the id it needs before it opens anything", async () => {
  for (const [name, args] of [
    ["decisionsGraphNode", {}],
    ["decisionsGraphPath", { query: { from: "cus:a1" } }],
    ["decisionsGraphTimeline", {}],
    ["decisionsGraphShared", {}],
    ["decisionsGraphCohort", {}],
  ]) {
    const out = await G.graphRoutes[name](args);
    assert.equal(out.ok, false, `${name} must refuse a missing id`);
    assert.ok(!out.needsWorkspace, `${name} must refuse before it asks for a workspace`);
    assert.match(out.error, /which|needed/i);
  }
});

test("the routes answer against a real workspace on disk", async () => {
  const ws = workspace.create("Graph test");
  workspace.select(ws.id);
  const sel = workspace.openSelected();
  seed(sel.db);
  sel.db.close();
  G.clearCache();

  const overview = await G.graphRoutes.decisionsGraph({ query: {} });
  assert.equal(overview.ok, true);
  assert.equal(overview.empty, false);
  assert.equal(overview.stats.nodes, 27);
  assert.equal(overview.asOf, AS_OF);
  assert.equal(overview.customers.length, 6);
  assert.ok(overview.signalKinds.some((k) => k.kind === "usage_drop_30d"));
  assert.equal(overview.legend.nodeTypes.length, 9);

  const node = await G.graphRoutes.decisionsGraphNode({ query: { id: "cus:a1", depth: "1" } });
  assert.equal(node.ok, true);
  assert.equal(node.node.label, "Northwind");

  // A customer id is accepted bare or as its node id: the page holds node ids.
  for (const id of ["a1", "cus:a1"]) {
    const tl = await G.graphRoutes.decisionsGraphTimeline({ query: { id } });
    assert.equal(tl.ok, true, `timeline must accept ${id}`);
    assert.equal(tl.customer.key, "a1");
    const sh = await G.graphRoutes.decisionsGraphShared({ query: { id } });
    assert.equal(sh.ok, true);
    assert.equal(sh.peers[0].node.key, "a2");
  }

  const path = await G.graphRoutes.decisionsGraphPath({ query: { from: "cus:a1", to: "cus:a3" } });
  assert.equal(path.ok, true);
  assert.equal(path.found, false);

  const cohort = await G.graphRoutes.decisionsGraphCohort({ query: { kind: "usage_drop_30d" } });
  assert.equal(cohort.ok, true);
  assert.equal(cohort.count, 3);
});

/* ── 9. the page ────────────────────────────────────────────────────────── */

test("the page calls only routes this module defines", () => {
  // 🔴 A route name that does not exist is a 404, which a page renders as an
  // empty section — indistinguishable from "there is nothing to show".
  const js = fs.readFileSync(pkg("src", "ui", "public", "v2", "pages", "graph.js"), "utf8");
  const called = [...js.matchAll(/\bapi\(\s*["']([A-Za-z][A-Za-z0-9]*)["']/g)].map((m) => m[1]);
  assert.ok(called.length >= 5, `expected the page to call the graph routes, saw ${called.length}`);
  for (const name of called) {
    assert.ok(Object.hasOwn(G.graphRoutes, name), `graph.js calls /x/${name}, which graph.mjs does not define`);
  }
});

test("the page exports the contract the shell calls, and fetches nothing", () => {
  const js = fs.readFileSync(pkg("src", "ui", "public", "v2", "pages", "graph.js"), "utf8");
  assert.match(js, /export\s+async\s+function\s+render\b/, "the shell calls render(root, ctx) by name");
  assert.match(js, /export\s+const\s+title\s*=/);
  for (const m of js.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
    const before = js.slice(Math.max(0, m.index - 80), m.index);
    assert.ok(!/(src|href)\s*=|import\s|fetch\(|url\(/i.test(before), `the page must load nothing from the network: ${m[0]}`);
  }
  // Every value on this page is a customer name or model-written text.
  const bad = js.split("\n").filter((l) => /\.innerHTML\s*=/.test(l) && !/=\s*("" ?|'' ?|``)/.test(l));
  assert.deepEqual(bad, [], "nothing on this page may be written as HTML");
});

/* ── 10. it has to be fast in front of an investor ──────────────────────── */

test("a workspace far larger than the demo still builds and answers in well under a second", () => {
  const db = openMemory();
  const acc = db.prepare("INSERT INTO account (id, name, arr, plan, owner, segment, industry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const con = db.prepare("INSERT INTO contact (id, account_id, name, role, is_champion, last_active_at) VALUES (?, ?, ?, ?, ?, ?)");
  const tkt = db.prepare("INSERT INTO ticket (id, account_id, opened_at, closed_at, priority, subject) VALUES (?, ?, ?, ?, ?, ?)");
  db.prepare("INSERT INTO run (id, started_at, as_of, status) VALUES ('rB', '2026-09-15T08:00:00Z', ?, 'ok')").run(AS_OF);
  const sig = db.prepare("INSERT INTO signal (id, run_id, account_id, kind, band, statement) VALUES (?, 'rB', ?, ?, 1, ?)");
  const N = 500;
  for (let i = 0; i < N; i++) {
    acc.run(`b${i}`, `Account ${i}`, 1000 + i, ["Starter", "Team", "Business"][i % 3], `Owner ${i % 7}`, `Segment ${i % 5}`, `Industry ${i % 9}`, "2026-01-01");
    con.run(`bc${i}`, `b${i}`, `Champion ${i % 40}`, "Head of Ops", 1, "2026-09-01");
    for (let t = 0; t < 4; t++) tkt.run(`bt${i}-${t}`, `b${i}`, "2026-09-01", null, "normal", `Ticket ${t}`);
    if (i % 3 === 0) sig.run(`bs${i}`, `b${i}`, "usage_drop_30d", "Active users down");
  }
  setMeta(db, "as_of", AS_OF);

  const t0 = Date.now();
  const g = G.buildGraph(db);
  const buildMs = Date.now() - t0;
  assert.ok(g.nodes.size > 2500, `expected a big graph, got ${g.nodes.size}`);
  assert.ok(buildMs < 1500, `build took ${buildMs}ms`);

  const timed = (label, fn) => {
    const s = Date.now();
    const out = fn();
    const ms = Date.now() - s;
    assert.ok(ms < 700, `${label} took ${ms}ms`);
    return out;
  };
  timed("stats", () => G.graphStats(g));
  timed("subgraph", () => G.subgraph(g));
  timed("timeline", () => G.timeline(g, "b7"));
  timed("sharedRisk", () => G.sharedRisk(g, "b9"));
  timed("cohortCause", () => G.cohortCause(g, "usage_drop_30d"));
  const p = timed("pathBetween", () => G.pathBetween(g, "cus:b0", `cus:b${N - 1}`));
  assert.equal(p.found, true, "500 customers sharing owners and plans are all reachable from one another");
});
