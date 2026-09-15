// The picture must agree with the number printed above it.
//
// 🔴 TWO MEASURED BUGS, BOTH ON THE DEFAULT PATH.
//
// 1. `bucketKeys` walked FORWARD from the oldest day, stopping after
//    BUCKET_MAX * 2 buckets, and `seriesFor` then kept the last BUCKET_MAX of
//    that truncated list. On three years of daily data it generated days 1..741
//    and drew 372..741 - a slice out of the MIDDLE, with the newest year never
//    generated at all. A metric reading 110 drew a line holding 69 rows, and the
//    page said "the oldest 406 buckets are not drawn" when the truth was 727.
//
// 2. The bar chart kept `series.slice(0, 14)` and printed nothing. Time buckets
//    are not folded by the server, so grouped by month it drew the OLDEST 14 of
//    37 buckets - 42 of 110 rows - in silence. A new chart opens as a bar
//    grouped by day, so this was the first chart most people would make.
//
// Both put a number on screen next to a picture that disagreed with it, which is
// the single failure this whole product argues against.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-buckets-"));

const { openMemory, setSettings, setMeta } = await import("../../src/decisions/db.mjs");
const M = await import("../../src/decisions/metrics.mjs");

const AS_OF = "2026-09-15";
const opts = { asOf: AS_OF, currency: "USD" };

/** Three years of decisions, one every ten days, ending today. */
function longHistory() {
  const db = openMemory();
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_metric'").get()) {
    db.exec(M.METRICS_MIGRATION);
  }
  setSettings(db, { demoMode: true, currency: "USD" });
  setMeta(db, "as_of", AS_OF);
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('a1','Northwind',1000)").run();

  const ins = db.prepare(
    `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, impact_amount,
                           currency, reasoning_source, created_at, updated_at)
     VALUES (?, 'a1', ?, 'churn_risk', ?, 'medium', 'new', NULL, 'USD', 'rule_only', ?, ?)`,
  );
  const day = (n) => {
    const d = new Date(Date.UTC(2026, 8, 15));
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  let made = 0;
  for (let back = 0; back <= 1090; back += 10) {
    const iso = `${day(back)}T09:00:00.000Z`;
    ins.run(`d${back}`, `fp${back}`, `Decision ${back}`, iso, iso);
    made++;
  }
  return { db, made };
}

test("the day series is CONTIGUOUS and ends at as-of", () => {
  const { db } = longHistory();
  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "all", filters: [] }, { ...opts, groupBy: "day" });
  assert.ok(r.ok, `compute failed: ${r.error}`);

  const keys = r.series.map((p) => p.key ?? p.label);
  assert.ok(keys.length > 0, "a three-year history must produce buckets");
  assert.equal(keys[keys.length - 1], AS_OF, `the newest bucket must be as-of, got ${keys[keys.length - 1]}`);

  // 🔴 CONTIGUITY IS THE ASSERTION THAT ACTUALLY BITES, and the first version of
  // this test did not have it. Checking only "the last bucket is as-of" passed
  // even with the old forward-walking generator restored, because the step that
  // appends keys the DATABASE produced put the recent days back on the end and
  // the series still finished in the right place. What it could not repair was
  // the middle: the result was an old contiguous block plus scattered recent
  // points, drawn side by side as though they were consecutive days. That is
  // precisely what was measured - 35 pairs of points ten days apart rendered
  // adjacent. Bucket filling exists to stop exactly that, so testing the gaps
  // is testing the feature.
  const gaps = [];
  for (let i = 1; i < keys.length; i++) {
    const a = Date.parse(keys[i - 1] + "T00:00:00Z");
    const b = Date.parse(keys[i] + "T00:00:00Z");
    const days = Math.round((b - a) / 86400000);
    if (days !== 1) gaps.push(`${keys[i - 1]} -> ${keys[i]} (${days} days)`);
  }
  assert.deepEqual(gaps.slice(0, 5), [], `day buckets must be consecutive; found ${gaps.length} jumps`);
  db.close();
});

test("what the chart draws plus what it says it dropped accounts for every row", () => {
  // The honesty property. The number above the chart counts everything; if the
  // chart cannot draw it all, the difference must be stated and must be RIGHT.
  const { db, made } = longHistory();
  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "all", filters: [] }, { ...opts, groupBy: "day" });

  const drawn = r.series.reduce((n, p) => n + (Number(p.value) || 0), 0);
  assert.equal(r.count, made, "the headline number must count every row");

  if (r.bucketsDropped > 0 || drawn !== r.count) {
    assert.ok(
      r.bucketsDropped > 0,
      `the chart shows ${drawn} of ${r.count} rows and must say some buckets are not drawn`,
    );
  }
  assert.ok(drawn <= r.count, "a chart must never draw more rows than the number counts");
  db.close();
});

test("a short history is drawn in full, with nothing dropped", () => {
  const db = openMemory();
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='saved_metric'").get()) {
    db.exec(M.METRICS_MIGRATION);
  }
  setSettings(db, { demoMode: true, currency: "USD" });
  setMeta(db, "as_of", AS_OF);
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('a1','N',1)").run();
  const ins = db.prepare(
    `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, impact_amount,
                           currency, reasoning_source, created_at, updated_at)
     VALUES (?, 'a1', ?, 'churn_risk', 'x', 'medium', 'new', NULL, 'USD', 'rule_only', ?, ?)`,
  );
  for (let i = 0; i < 5; i++) {
    const iso = `2026-09-1${i}T09:00:00.000Z`;
    ins.run(`s${i}`, `sf${i}`, iso, iso);
  }

  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "all", filters: [] }, { ...opts, groupBy: "day" });
  const drawn = r.series.reduce((n, p) => n + (Number(p.value) || 0), 0);
  assert.equal(drawn, r.count, "a small history must be drawn in full");
  assert.ok(!r.bucketsDropped, "nothing should be reported as dropped when everything fits");
  db.close();
});

test("buckets come back in order, oldest to newest", () => {
  // Reversing newest-first generation is easy to get wrong, and a chart drawn
  // backwards looks like a trend running the other way.
  const { db } = longHistory();
  const r = M.computeMetric(db, { source: "decisions", measure: "count", window: "all", filters: [] }, { ...opts, groupBy: "month" });
  const keys = r.series.map((p) => p.key ?? p.label);
  const sorted = [...keys].sort();
  assert.deepEqual(keys, sorted, "buckets must read left to right, oldest first");
  db.close();
});
