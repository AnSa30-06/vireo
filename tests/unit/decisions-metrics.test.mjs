// Saved metrics, saved charts and dashboards: the migration, the allowlist, the
// arithmetic, the store and the wiring.
//
// 🔴 THE TESTS THAT MATTER MOST ARE THE TWO HONESTY ONES.
//
//   1. INJECTION. A metric definition is typed by a user, stored, and then
//      re-run every time somebody opens a board. If a field name or a value
//      could reach SQL as text rather than as a bound parameter, a saved metric
//      would be a stored injection that fires on every visit. "We use
//      placeholders" is a claim; `account` still standing after a definition
//      that asks for it to be dropped is evidence.
//   2. NUMBERS THAT ARE NOT THERE. An average over no rows, a sum over rows
//      whose amount is missing, and a window that silently excludes undated
//      rows are three different ways to put a plausible wrong number on a
//      screen. Each has a test, because each was a real choice in the code and
//      the wrong choice would have looked fine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.LEDGERLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerline-metrics-test-"));

const { pkg } = await import("../../src/util/paths.mjs");
const { openMemory, migrate, MIGRATIONS, getMeta, setMeta, setSettings } = await import("../../src/decisions/db.mjs");
const M = await import("../../src/decisions/metrics.mjs");

const AS_OF = "2026-09-15"; // a Tuesday; the Monday of its week is 2026-09-14
const opts = { asOf: AS_OF, currency: "USD" };

/**
 * A workspace with something of every awkward shape in it: a decision with no
 * impact amount, a customer with no created_at, rows inside and outside every
 * window the tests use.
 */
function seed() {
  const db = openMemory();
  // Applied only if MIGRATIONS does not carry it yet. Written this way so the
  // file passes both before the migration is wired in and after: once it is
  // appended, openMemory() has already created these tables and running the
  // SQL a second time fails with "table saved_metric already exists".
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'saved_metric'").get()) {
    db.exec(M.METRICS_MIGRATION);
  }

  const acc = db.prepare(
    "INSERT INTO account (id, name, arr, plan, owner, segment, renewal_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  acc.run("a1", "Northwind", 120000, "Enterprise", "Dana", "Mid-market", "2026-10-01", "2026-09-10");
  acc.run("a2", "Contoso", 40000, "Growth", "Dana", "SMB", "2026-12-20", "2026-08-01");
  acc.run("a3", "Fabrikam", 90000, "Enterprise", "Ravi", null, null, null); // no created_at

  const dec = db.prepare(
    "INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, impact_amount, currency, reasoning_source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  // d1 Monday 2026-09-14, d2 Sunday 2026-09-13, d3 Thursday 2026-09-10, d4 June.
  dec.run("d1", "a1", "f1", "churn_risk", "Northwind usage fell", "critical", "new", 120000, "USD", "model", "2026-09-14T10:00:00Z", "2026-09-14T10:00:00Z");
  dec.run("d2", "a2", "f2", "renewal", "Contoso renewal", "high", "new", 40000, "USD", "rule_only", "2026-09-13T10:00:00Z", "2026-09-13T10:00:00Z");
  dec.run("d3", "a2", "f3", "ticket_spike", "Contoso tickets", "medium", "accepted", null, "USD", "model", "2026-09-10T10:00:00Z", "2026-09-10T10:00:00Z");
  dec.run("d4", "a3", "f4", "churn_risk", "Fabrikam quiet", "low", "resolved", 90000, "USD", "model", "2026-06-01T10:00:00Z", "2026-06-01T10:00:00Z");
  return db;
}

const count = (db, filters = [], window = "all") =>
  M.computeMetric(db, { source: "decisions", measure: "count", window, filters }, opts);

/* ── the migration ──────────────────────────────────────────────────────── */

test("the new tables arrive as an APPENDED migration, leaving the shipped ones untouched", () => {
  // An entry that has shipped is never edited: installed databases already ran
  // it and would never re-run it, so an edit changes only what a fresh install
  // gets and the two diverge permanently.
  //
  // The check is "these tables are created in exactly ONE entry, and it is this
  // module's own appended entry" rather than "no entry mentions them" - the
  // latter was true only while the migration was unwired, and started failing
  // the moment it was appended, which is the correct state.
  for (const table of ["saved_metric", "saved_chart", "dashboard_chart"]) {
    const carrying = MIGRATIONS.filter((sql) => sql.includes(`CREATE TABLE ${table}`));
    assert.equal(carrying.length, 1, `${table} must be created by exactly one migration, found ${carrying.length}`);
    assert.equal(carrying[0], M.METRICS_MIGRATION, `${table} must come from this module's own appended migration`);
  }
  // And it must be at the END: an entry inserted before one that has already
  // run would renumber the rest and never be applied to an installed database.
  const at = MIGRATIONS.indexOf(M.METRICS_MIGRATION);
  assert.ok(at >= MIGRATIONS.length - 3, `the metrics migration must be appended, found at index ${at} of ${MIGRATIONS.length}`);
  for (const table of ["saved_metric", "saved_chart", "dashboard", "dashboard_chart"]) {
    assert.match(M.METRICS_MIGRATION, new RegExp(`CREATE TABLE ${table}\\b`));
  }
  // It adds, it never alters. An ALTER or a DROP against a shipped table here
  // would rewrite what existing installs already hold.
  assert.ok(!/\b(ALTER|DROP)\b/i.test(M.METRICS_MIGRATION), "the migration must only create new tables");
});

test("a database already at the shipped version takes the new tables without losing data", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // Everything that shipped BEFORE this feature, which is what an installed
  // database is already carrying. Slicing at this migration is what makes the
  // test a real upgrade rather than a fresh install - once it was appended to
  // MIGRATIONS, running the whole array and then the migration again failed
  // with "table saved_metric already exists".
  const priorTo = MIGRATIONS.indexOf(M.METRICS_MIGRATION);
  const shipped = priorTo === -1 ? MIGRATIONS : MIGRATIONS.slice(0, priorTo);
  for (const sql of shipped) db.exec(sql);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(String(shipped.length));
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('a1', 'Northwind', 1)").run();

  db.exec(M.METRICS_MIGRATION);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM saved_metric").get().n, 0);
  assert.equal(db.prepare("SELECT name FROM account WHERE id = 'a1'").get().name, "Northwind");
  assert.equal(getMeta(db, "schema_version"), String(shipped.length));
  db.close();
});

/* ── the allowlist ──────────────────────────────────────────────────────── */

test("a source, a measure, a window or a field that is not on the allowlist is REFUSED", () => {
  const db = seed();
  const cases = [
    [{ source: "sqlite_master", measure: "count", window: "all", filters: [] }, /is not something this workspace can count/],
    [{ source: "decisions", measure: "median", window: "all", filters: [] }, /is not a measure/],
    [{ source: "decisions", measure: "count", window: "last week", filters: [] }, /is not a window/],
    [{ source: "decisions", measure: "count", window: "all", filters: [{ field: "industry", op: "is", value: "x" }] }, /is not a field/],
    [{ source: "decisions", measure: "count", window: "all", filters: [{ field: "status", op: "regexp", value: "x" }] }, /cannot be compared with/],
  ];
  for (const [definition, pattern] of cases) {
    const r = M.computeMetric(db, definition, opts);
    assert.equal(r.ok, false, `${JSON.stringify(definition)} should have been refused`);
    assert.match(r.error, pattern);
  }
  db.close();
});

test("a measure a source cannot carry is refused rather than returning zero", () => {
  // Tickets have no amount column. Summing them could have returned 0, which
  // reads as "there is nothing", not as "that question has no answer here".
  const db = seed();
  const r = M.computeMetric(db, { source: "tickets", measure: "sum", window: "all", filters: [] }, opts);
  assert.equal(r.ok, false);
  assert.match(r.error, /carry no amount/);
  db.close();
});

test("a grouping that is not on the allowlist is refused, including a non-text field", () => {
  const db = seed();
  const definition = { source: "decisions", measure: "count", window: "all", filters: [] };
  for (const groupBy of ["field:impact", "field:nope", "quarter", "d.status", "field:status; DROP TABLE account"]) {
    const r = M.computeMetric(db, definition, { ...opts, groupBy });
    assert.equal(r.ok, false, `${groupBy} should have been refused`);
    assert.match(r.error, /is not a way/);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 3);
  db.close();
});

test("a value carrying SQL is bound, not executed", () => {
  const db = seed();
  const nasty = "new'; DROP TABLE account; --";
  const r = count(db, [{ field: "status", op: "is", value: nasty }]);
  assert.equal(r.ok, true);
  assert.equal(r.value, 0, "nothing has that literal status, so the count is zero");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 3, "account must still be standing");

  // And through the store, where it is written to disk and read back.
  const created = M.createMetric(
    db,
    { name: "Nasty", definition: { source: "decisions", measure: "count", window: "all", filters: [{ field: "status", op: "contains", value: nasty }] } },
    opts,
  );
  assert.equal(created.ok, true);
  const listed = M.listMetrics(db, opts);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].value, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 3, "re-running a stored definition must not execute it");
  db.close();
});

test("only the allowlisted parts of a definition reach the database", () => {
  // An incoming filter carrying extra keys must not be stored and trusted later.
  const db = seed();
  const created = M.createMetric(
    db,
    {
      name: "Clean",
      definition: {
        source: "decisions",
        measure: "count",
        window: "all",
        extra: "ignored",
        filters: [{ field: "status", op: "is", value: "new", col: "d.status", sql: "1=1" }],
      },
    },
    opts,
  );
  assert.equal(created.ok, true);
  const stored = JSON.parse(db.prepare("SELECT definition_json j FROM saved_metric").get().j);
  assert.deepEqual(stored, {
    source: "decisions",
    measure: "count",
    window: "all",
    filters: [{ field: "status", op: "is", value: "new" }],
  });
  db.close();
});

/* ── the arithmetic ─────────────────────────────────────────────────────── */

test("count, sum and average each read what they say they read", () => {
  const db = seed();
  assert.equal(count(db).value, 4);
  assert.equal(count(db, [{ field: "status", op: "is", value: "new" }]).value, 2);
  assert.equal(count(db, [{ field: "customer", op: "is", value: "Contoso" }]).value, 2);

  const sum = M.computeMetric(db, { source: "decisions", measure: "sum", window: "all", filters: [] }, opts);
  assert.equal(sum.value, 250000, "120000 + 40000 + 90000; the NULL adds nothing");
  assert.equal(sum.valueLabel, "$250,000");
  assert.equal(sum.missingAmount, 1, "the row with no impact amount must be reported, not hidden");

  const avg = M.computeMetric(db, { source: "decisions", measure: "avg", window: "all", filters: [] }, opts);
  assert.equal(Math.round(avg.value), 83333, "the average is over the three rows that carry an amount");
  db.close();
});

test("an average over no measured row is null, never zero", () => {
  // Zero is a claim: "the average impact is nothing". Null is the truth: there
  // is no average, because nothing was measured.
  const db = seed();
  const r = M.computeMetric(
    db,
    { source: "decisions", measure: "avg", window: "all", filters: [{ field: "status", op: "is", value: "accepted" }] },
    opts,
  );
  assert.equal(r.ok, true);
  assert.equal(r.count, 1, "one decision is accepted");
  assert.equal(r.value, null, "and it carries no impact amount, so there is no average");
  assert.equal(r.valueLabel, null);
  db.close();
});

test("a window counts the days it names, inclusive of as-of", () => {
  const db = seed();
  const seven = count(db, [], "7");
  assert.equal(seven.windowFrom, "2026-09-09", "seven days ending 15 Sep starts on 9 Sep, not 8 Sep");
  assert.equal(seven.windowTo, AS_OF);
  assert.equal(seven.value, 3, "d1, d2 and d3 are inside; d4 in June is not");
  assert.equal(count(db, [], "all").value, 4);
  db.close();
});

test("rows the window cannot place are reported, not silently dropped", () => {
  // Fabrikam has no created_at. A customer count over "the last 30 days" that
  // quietly ignored it would be a number that gets believed.
  const db = seed();
  const r = M.computeMetric(db, { source: "customers", measure: "count", window: "30", filters: [] }, opts);
  assert.equal(r.value, 1, "only Northwind was added inside the window");
  assert.equal(r.undated, 1, "Fabrikam has no date and must be counted as excluded");
  assert.equal(M.computeMetric(db, { source: "customers", measure: "count", window: "all", filters: [] }, opts).value, 3);
  db.close();
});

test("the denominator is the window with the filters taken off", () => {
  // "3 of 4" only means something if the 4 is the same window as the 3.
  const db = seed();
  const r = count(db, [{ field: "status", op: "is", value: "new" }], "7");
  assert.equal(r.value, 2);
  assert.equal(r.total, 3, "three decisions fall in the window; two of them are new");
  db.close();
});

test("a date filter does not sweep in every row that has no date", () => {
  // COALESCE(x,'') < '2026-01-01' is TRUE for every NULL, because '' sorts
  // before every date. "Due before X" would then include everything undated.
  const db = seed();
  const r = count(db, [{ field: "dueAt", op: "before", value: "2027-01-01" }]);
  assert.equal(r.value, 0, "no decision has a due date at all, so none is due before anything");
  db.close();
});

/* ── grouping ───────────────────────────────────────────────────────────── */

test("grouping by a field counts each group and names the blank one", () => {
  const db = seed();
  const r = M.computeMetric(db, { source: "customers", measure: "count", window: "all", filters: [] }, { ...opts, groupBy: "field:segment" });
  assert.equal(r.ok, true);
  const byLabel = Object.fromEntries(r.series.map((p) => [p.label, p.value]));
  assert.deepEqual(byLabel, { "Mid-market": 1, SMB: 1, "Not set": 1 });
  db.close();
});

test("time buckets are filled, so a quiet week draws as a gap and not as a jump", () => {
  const db = seed();
  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "30", filters: [] }, { ...opts, groupBy: "week" });
  assert.equal(r.ok, true);
  assert.deepEqual(
    r.series.map((p) => `${p.key}=${p.value}`),
    ["2026-08-17=0", "2026-08-24=0", "2026-08-31=0", "2026-09-07=2", "2026-09-14=1"],
    "every week in the window appears, including the empty ones",
  );
  db.close();
});

test("a week bucket is the Monday on or before the row, in SQL and in JavaScript alike", () => {
  // The SQL bucket and the filled bucket list are written in two languages. If
  // they disagreed, a row would land on a key the list does not hold. The code
  // appends such a key rather than dropping it, so this test can see it.
  const db = seed();
  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "30", filters: [] }, { ...opts, groupBy: "week" });
  for (const point of r.series) {
    const day = new Date(`${point.key}T00:00:00Z`).getUTCDay();
    assert.equal(day, 1, `${point.key} should be a Monday`);
  }
  // d2 is Sunday 13 Sep and belongs to the week starting Monday 7 Sep; d1 is
  // Monday 14 Sep and starts its own.
  const byKey = Object.fromEntries(r.series.map((p) => [p.key, p.value]));
  assert.equal(byKey["2026-09-07"], 2);
  assert.equal(byKey["2026-09-14"], 1);
  db.close();
});

test("an empty bucket has a count of zero but no average", () => {
  const db = seed();
  const r = M.computeMetric(db, { source: "decisions", measure: "avg", window: "30", filters: [] }, { ...opts, groupBy: "week" });
  const empty = r.series.find((p) => p.key === "2026-08-24");
  assert.equal(empty.count, 0);
  assert.equal(empty.value, null, "no rows means no average — zero would be a number nobody computed");
  const counted = M.computeMetric(db, { source: "decisions", measure: "count", window: "30", filters: [] }, { ...opts, groupBy: "week" });
  assert.equal(counted.series.find((p) => p.key === "2026-08-24").value, 0, "a count of no rows really is zero");
  db.close();
});

test("a grouping past the drawing limit folds into one Other that carries its rows", () => {
  const db = seed();
  const ins = db.prepare(
    "INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, 'low', 'new', 'model', ?, ?)",
  );
  for (let i = 0; i < 20; i++) ins.run(`x${i}`, `fx${i}`, `kind_${i}`, `t${i}`, "2026-09-12T10:00:00Z", "2026-09-12T10:00:00Z");

  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "all", filters: [] }, { ...opts, groupBy: "field:kind" });
  const other = r.series.find((p) => p.key === "__other__");
  assert.ok(other, "the tail must be folded, not dropped");
  assert.ok(r.otherGroups > 0);
  const drawn = r.series.reduce((t, p) => t + p.count, 0);
  assert.equal(drawn, r.count, "every matched row is still accounted for after folding");
  db.close();
});

/* ── evidence ───────────────────────────────────────────────────────────── */

test("a number comes back with the rows it was counted from", () => {
  const db = seed();
  const r = count(db, [{ field: "status", op: "is", value: "new" }]);
  assert.equal(r.value, 2);
  assert.equal(r.rows.length, 2, "the evidence must be the same set as the number");
  assert.deepEqual(r.rows.map((x) => x.id).sort(), ["d1", "d2"]);
  assert.equal(r.rows[0].link, "decisions", "a decision row links to the decision");
  assert.equal(r.rowsTruncated, false);
  db.close();
});

test("the evidence list is capped and says so", () => {
  const db = seed();
  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "all", filters: [] }, { ...opts, limit: 2 });
  assert.equal(r.value, 4);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rowsTruncated, true, "a truncated list must never look complete");
  assert.equal(M.computeMetric(db, { source: "decisions", measure: "count", window: "all", filters: [] }, { ...opts, limit: 0 }).rows.length, 0);
  db.close();
});

/* ── the sentence ───────────────────────────────────────────────────────── */

test("every number carries its definition in English, written in one place", () => {
  const db = seed();
  const definition = { source: "decisions", measure: "count", window: "7", filters: [{ field: "status", op: "is", value: "new" }] };
  const computed = M.computeMetric(db, definition, opts);
  assert.equal(
    computed.definitionText,
    "Count of decisions, where Status is new, raised in the last 7 days (2026-09-09 to 2026-09-15).",
  );

  // The saved list must say exactly the same thing, or the tile and the editor
  // could describe the same metric differently.
  const created = M.createMetric(db, { name: "New this week", definition }, opts);
  assert.equal(created.ok, true);
  assert.equal(created.metric.definitionText, computed.definitionText);
  assert.equal(M.listMetrics(db, opts)[0].definitionText, computed.definitionText);
  db.close();
});

test("a money filter is described in the workspace's currency", () => {
  const db = seed();
  const r = M.computeMetric(
    db,
    { source: "customers", measure: "sum", window: "all", filters: [{ field: "arr", op: "gte", value: "50000" }] },
    { asOf: AS_OF, currency: "GBP" },
  );
  assert.match(r.definitionText, /ARR is at least £50,000/);
  db.close();
});

/* ── the store ──────────────────────────────────────────────────────────── */

test("a metric needs a name, and two metrics cannot share one", () => {
  const db = seed();
  const definition = { source: "decisions", measure: "count", window: "all", filters: [] };
  assert.match(M.createMetric(db, { name: "  ", definition }, opts).error, /name/);
  assert.equal(M.createMetric(db, { name: "Total", definition }, opts).ok, true);
  const dup = M.createMetric(db, { name: "  totAL ", definition }, opts);
  assert.equal(dup.ok, false);
  assert.match(dup.error, /already one called "Total"/, "the clash must name the metric that already exists");
  db.close();
});

test("a filter with no value can be previewed but never saved", () => {
  const db = seed();
  const definition = { source: "decisions", measure: "count", window: "all", filters: [{ field: "status", op: "is", value: "" }] };
  const preview = M.computeMetric(db, definition, opts);
  assert.equal(preview.ok, true, "a half-typed rule must still preview");
  assert.equal(preview.incomplete, 1);
  assert.equal(preview.value, 4, "and it must not silently count as a rule");

  const saved = M.createMetric(db, { name: "Half", definition }, opts);
  assert.equal(saved.ok, false);
  assert.match(saved.error, /still need a value/);
  db.close();
});

test("every write is stamped with the workspace clock, not the wall clock", () => {
  // In demo mode the workspace is pinned to a date. A metric stamped with the
  // real date would sort and read wrongly against everything else in the file.
  const db = seed();
  setSettings(db, { demoMode: true });
  setMeta(db, "as_of", "2026-01-02");
  const created = M.createMetric(
    db,
    { name: "Pinned", definition: { source: "decisions", measure: "count", window: "all", filters: [] } },
    opts,
  );
  assert.equal(created.ok, true);
  assert.match(created.metric.createdAt, /^2026-01-02T/);
  db.close();
});

test("a metric in use cannot be deleted, and the refusal names the charts", () => {
  const db = seed();
  const metric = M.createMetric(db, { name: "Open", definition: { source: "decisions", measure: "count", window: "all", filters: [] } }, opts).metric;
  const chart = M.createChart(db, { name: "Open by severity", metricId: metric.id, shape: "bar", groupBy: "field:severity" });
  assert.equal(chart.ok, true);

  const refused = M.deleteMetric(db, metric.id);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Open by severity/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM saved_metric").get().n, 1, "and nothing was deleted");

  assert.equal(M.deleteChart(db, chart.chart.id).ok, true);
  assert.equal(M.deleteMetric(db, metric.id).ok, true);
  db.close();
});

test("changing a metric's source cannot strand a chart's grouping", () => {
  // "By Priority" means nothing once the metric counts invoices. Left alone it
  // would come back as an error tile on somebody's board days later.
  const db = seed();
  const metric = M.createMetric(db, { name: "Tickets", definition: { source: "tickets", measure: "count", window: "all", filters: [] } }, opts).metric;
  assert.equal(M.createChart(db, { name: "By priority", metricId: metric.id, shape: "bar", groupBy: "field:priority" }).ok, true);

  const refused = M.updateMetric(db, metric.id, { definition: { source: "invoices", measure: "count", window: "all", filters: [] } }, opts);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /By priority/);
  assert.equal(M.getMetric(db, metric.id).definition.source, "tickets", "the metric is unchanged");

  // A grouping both sources share is allowed through.
  const ok = M.updateMetric(db, metric.id, { definition: { source: "invoices", measure: "count", window: "all", filters: [] }, name: "Invoices" }, opts);
  assert.equal(ok.ok, false, "By priority is still stranded, so this is still refused");
  db.close();
});

test("a shape and a grouping that would draw a lie are refused", () => {
  const db = seed();
  const metric = M.createMetric(db, { name: "All", definition: { source: "decisions", measure: "count", window: "all", filters: [] } }, opts).metric;

  const grouped = M.createChart(db, { name: "Dots by month", metricId: metric.id, shape: "unit-dot", groupBy: "month" });
  assert.equal(grouped.ok, false);
  assert.match(grouped.error, /cannot be grouped/);

  const flat = M.createChart(db, { name: "Line of one", metricId: metric.id, shape: "line", groupBy: "none" });
  assert.equal(flat.ok, false);
  assert.match(flat.error, /needs a grouping/);

  assert.equal(M.createChart(db, { name: "Dots", metricId: metric.id, shape: "unit-dot", groupBy: "none" }).ok, true);
  assert.equal(M.createChart(db, { name: "Line", metricId: metric.id, shape: "line", groupBy: "month" }).ok, true);
  assert.equal(M.createChart(db, { name: "Blob", metricId: metric.id, shape: "pie", groupBy: "month" }).ok, false);
  db.close();
});

test("a dashboard is an ORDER, and the order is what comes back", () => {
  const db = seed();
  const metric = M.createMetric(db, { name: "All", definition: { source: "decisions", measure: "count", window: "all", filters: [] } }, opts).metric;
  const a = M.createChart(db, { name: "A", metricId: metric.id, shape: "bar", groupBy: "field:status" }).chart;
  const b = M.createChart(db, { name: "B", metricId: metric.id, shape: "bar", groupBy: "field:severity" }).chart;

  const board = M.createDashboard(db, { name: "Board" }).dashboard;
  assert.deepEqual(M.updateDashboard(db, board.id, { chartIds: [b.id, a.id] }).dashboard.chartIds, [b.id, a.id]);
  assert.deepEqual(M.updateDashboard(db, board.id, { chartIds: [a.id, b.id] }).dashboard.chartIds, [a.id, b.id]);

  assert.match(M.updateDashboard(db, board.id, { chartIds: [a.id, a.id] }).error, /only appear once/);
  assert.match(M.updateDashboard(db, board.id, { chartIds: ["cht_nope"] }).error, /does not exist/);
  assert.deepEqual(M.getDashboard(db, board.id).chartIds, [a.id, b.id], "a refused reorder changes nothing");

  // Deleting a chart takes it off every board rather than leaving a hole.
  assert.equal(M.deleteChart(db, a.id).ok, true);
  assert.deepEqual(M.getDashboard(db, board.id).chartIds, [b.id]);
  db.close();
});

test("a computed dashboard carries each chart's number, series and definition", () => {
  const db = seed();
  const metric = M.createMetric(
    db,
    { name: "New decisions", definition: { source: "decisions", measure: "count", window: "all", filters: [{ field: "status", op: "is", value: "new" }] } },
    opts,
  ).metric;
  const chart = M.createChart(db, { name: "New by severity", metricId: metric.id, shape: "bar", groupBy: "field:severity" }).chart;
  const board = M.createDashboard(db, { name: "Board", chartIds: [chart.id] }).dashboard;

  const computed = M.computeDashboard(db, board.id, opts);
  assert.equal(computed.ok, true);
  assert.equal(computed.charts.length, 1);
  const tile = computed.charts[0];
  assert.equal(tile.error, null);
  assert.equal(tile.chart.metricName, "New decisions");
  assert.equal(tile.result.value, 2);
  assert.match(tile.result.definitionText, /^Count of decisions, where Status is new/);
  assert.deepEqual(tile.result.series.map((p) => p.label).sort(), ["critical", "high"]);
  db.close();
});

test("one broken chart does not take a whole dashboard down", () => {
  const db = seed();
  const metric = M.createMetric(db, { name: "All", definition: { source: "decisions", measure: "count", window: "all", filters: [] } }, opts).metric;
  const good = M.createChart(db, { name: "Good", metricId: metric.id, shape: "bar", groupBy: "field:status" }).chart;
  const broken = M.createChart(db, { name: "Broken", metricId: metric.id, shape: "bar", groupBy: "field:kind" }).chart;
  const board = M.createDashboard(db, { name: "Board", chartIds: [good.id, broken.id] }).dashboard;

  // Corrupt one chart's stored grouping the way a hand-edited row would.
  db.prepare("UPDATE saved_chart SET group_by = 'field:gone' WHERE id = ?").run(broken.id);

  const computed = M.computeDashboard(db, board.id, opts);
  assert.equal(computed.ok, true);
  assert.equal(computed.charts[0].result.value, 4, "the good tile still answers");
  assert.equal(computed.charts[1].result, null);
  assert.match(computed.charts[1].error, /is not a way/, "and the broken one says what is wrong with it");
  db.close();
});

test("a stored definition that cannot be read keeps its place in the list", () => {
  const db = seed();
  M.createMetric(db, { name: "Fine", definition: { source: "decisions", measure: "count", window: "all", filters: [] } }, opts);
  db.prepare("UPDATE saved_metric SET definition_json = 'not json at all'").run();
  const listed = M.listMetrics(db, opts);
  assert.equal(listed.length, 1, "a broken metric must not take the list down");
  assert.equal(listed[0].value, null);
  assert.ok(listed[0].error, "and it must say why its number is missing");
  db.close();
});

/* ── the wiring ─────────────────────────────────────────────────────────── */

const { decisionRoutes } = await import("../../src/decisions/routes.mjs");
const { routes } = await import("../../src/ui/api.mjs");
const PAGE = pkg("src", "ui", "public", "v2", "pages", "dashboards.js");
const pageSrc = fs.readFileSync(PAGE, "utf8");

test("every metrics route is namespaced and collides with nothing already served", () => {
  const names = Object.keys(M.metricsRoutes);
  assert.ok(names.length >= 10, `expected the whole surface, saw ${names.length}`);
  for (const name of names) {
    assert.match(name, /^decisions[A-Z]/, `${name} should start with "decisions"`);
    // Merged in, and pointing at THIS module's function rather than something
    // that shadows it. The original assertion was that the name was ABSENT from
    // decisionRoutes, which was only true while the module was unwired.
    assert.ok(Object.hasOwn(decisionRoutes, name), `${name} is not merged into src/decisions/routes.mjs`);
    assert.equal(decisionRoutes[name], M.metricsRoutes[name], `${name} is shadowed by another definition`);
    assert.ok(!Object.hasOwn(routes, name), `${name} is already defined in src/ui/api.mjs`);
    assert.equal(typeof M.metricsRoutes[name], "function", `${name} must be callable`);
  }
});

test("every route the Dashboards page calls exists once the table is merged", () => {
  // The page is dead surface if it calls a name nothing answers: a 404 renders
  // as an empty tile, which reads as "there is nothing to show" and not as a bug.
  const merged = { ...routes, ...decisionRoutes, ...M.metricsRoutes };
  const called = new Set([...pageSrc.matchAll(/\bapi\(\s*["']([A-Za-z][A-Za-z0-9]*)["']/g)].map((m) => m[1]));
  assert.ok(called.size >= 8, `expected the page to call many routes, saw ${called.size}`);
  for (const name of called) {
    assert.ok(Object.hasOwn(merged, name), `dashboards.js calls /x/${name}, which nothing defines`);
  }
});

test("the Dashboards page never writes a value as HTML", () => {
  // Decision titles, customer names and ticket subjects all pass through this
  // page. A literal string would survive; innerHTML = someVariable is a hole.
  const code = pageSrc
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    assert.ok(!code.includes(bad), `${bad} must never appear in dashboards.js`);
  }
});

test("the Dashboards page exports the contract the shell calls", () => {
  assert.match(pageSrc, /export\s+const\s+title\s*=/, "the shell reads the page title");
  assert.match(pageSrc, /export\s+async\s+function\s+render\b/, "the shell calls render(root, ctx) by name");
});
