// The demo company: does the dataset still plant exactly what it claims to?
//
// 🔴 WHAT THIS FILE IS FOR. The demo is the argument. Twelve of its 144
// customers each cross exactly ONE threshold while being otherwise well, and
// the product must raise nothing about any of them - that is the difference
// between a decision system and a threshold-flagger with a language model on
// top. The scenarios that MUST fire matter for the same reason: a dataset that
// quietly plants nothing proves nothing, and that has already happened once
// here (see the RATIO comment in synthetic.mjs).
//
// So this file checks three separate things:
//   1. the dataset, before any engine touches it - no accidental signals;
//   2. the arithmetic the signal will do, for every possible as-of weekday;
//   3. a full run at demo size - traps silent, planted situations found.
//
// Hermetic: an in-memory database, no gateway, no network, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "omni-demo-test-"));

const { openMemory, setSettings, setMeta } = await import("../../src/decisions/db.mjs");
const { generate, writeDataset, variant, seedHistory, VARIANTS } = await import("../../src/decisions/synthetic.mjs");
const { importFolder } = await import("../../src/decisions/ingest.mjs");
const { runAnalysis } = await import("../../src/decisions/run.mjs");
const { logEvent, OPEN_STATUSES } = await import("../../src/decisions/decisions.mjs");
const { rules } = await import("../../src/decisions/rules.mjs");
const { addDays, daysBetween } = await import("../../src/decisions/format.mjs");
const workspace = await import("../../src/decisions/workspace.mjs");
const { decisionRoutes } = await import("../../src/decisions/routes.mjs");

const AS_OF = "2026-09-09";
const DROP = rules().signals.usage_drop_30d.bands; // [-25, -40, -60]
const RISE = rules().signals.usage_rise_30d.bands[0]; // 30

const tmpdir = () => fs.mkdtempSync(path.join(process.env.VIREO_HOME, "ds-"));

/** The demo dataset, built once: generating it twice costs a second for nothing. */
let _demo = null;
function demoData() {
  if (!_demo) _demo = variant("demo", AS_OF);
  return _demo;
}

/**
 * The dismissed decisions that decisionsSeedDemo writes after importing. Two
 * scenarios are about what happens when a decision ALREADY exists, so without
 * these the demo dataset is testing nothing on those accounts.
 *
 * Seeded at HIGH deliberately, exactly as the route does: suppression compares
 * the new severity with the dismissed one.
 */
function seedDismissed(db, data, asOf) {
  for (const s of data.scenarios.filter((x) => x.scenario.startsWith("dismissed_"))) {
    const id = `dec_seed${s.account_id.replace(/\W/g, "")}`;
    const when = addDays(asOf, -10) + "T09:00:00.000Z";
    db.prepare(
      `INSERT OR REPLACE INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source,
         impact_basis, currency, created_at, updated_at, dismissed_reason)
       VALUES (?, ?, ?, 'churn_risk', ?, 'high', 'dismissed', 'rule_only', 'annual contract value at risk', 'USD', ?, ?, ?)`,
    ).run(id, s.account_id, `${s.account_id}:churn_risk`, `${s.name}: churn risk`, when, when, "Seasonal dip, confirmed with the customer");
    logEvent(db, id, "user", "dismissed", { reason: "seeded for the test" });
  }
}

/** Import the demo into a fresh in-memory workspace. ~0.8s, so it is shared. */
function demoWorkspace({ dismissed = true } = {}) {
  const data = demoData();
  const dir = tmpdir();
  writeDataset(dir, data);
  const db = openMemory();
  const r = importFolder(db, dir);
  assert.equal(r.ok, true, r.error);
  setSettings(db, { demoMode: true, seatPriceMonthly: 25 });
  setMeta(db, "as_of", AS_OF);
  if (dismissed) seedDismissed(db, data, AS_OF);
  fs.rmSync(dir, { recursive: true, force: true });
  return { db, data };
}

const byScenario = (data, name) => data.scenarios.filter((s) => s.scenario === name);
const rowsBy = (records, key) => {
  const m = new Map();
  for (const r of records) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};

/* ── the dataset itself ─────────────────────────────────────────────────── */

test("the demo is a business, not a fixture: size, spread and texture", () => {
  const data = demoData();
  const accounts = data.files["accounts.csv"];

  assert.ok(accounts.length >= 120 && accounts.length <= 200, `expected 120-200 customers, got ${accounts.length}`);
  assert.equal(accounts.length, data.scenarios.length);
  assert.match(VARIANTS.demo, new RegExp(`^${accounts.length} customers`), "the description must state the real count");

  // A repeated customer name reads as a bug to anyone watching.
  assert.equal(new Set(accounts.map((a) => a.name)).size, accounts.length, "every customer name is different");

  assert.ok(new Set(accounts.map((a) => a.industry)).size >= 6, "a spread of industries");
  assert.equal(new Set(accounts.map((a) => a.segment)).size, 3, "all three segments are used");
  assert.equal(new Set(accounts.map((a) => a.plan)).size, 3, "all three plans are used");
  assert.ok(new Set(accounts.map((a) => a.owner).filter(Boolean)).size >= 4, "a book of business, not one owner");
  assert.ok(accounts.some((a) => !a.owner), "and some accounts nobody owns, so that filter has rows");

  const arrs = accounts.map((a) => a.arr);
  assert.ok(Math.max(...arrs) / Math.min(...arrs) >= 4, "a real contract-value spread");

  // Twelve months of DAILY usage for an established customer.
  const usage = rowsBy(data.files["usage_daily.csv"], "account_id");
  const established = data.scenarios.find((s) => s.scenario === "healthy" && usage.get(s.account_id)?.length > 300);
  assert.ok(established, "some customer has a full year of daily usage");
  const span = usage.get(established.account_id);
  assert.ok(daysBetween(span[0].day, span[span.length - 1].day) >= 360, "and it spans a year");

  // Texture that has to exist for the screens to have anything to show.
  const contacts = rowsBy(data.files["contacts.csv"], "account_id");
  assert.ok([...contacts.values()].every((c) => c.length >= 2), "every customer has contacts");
  assert.ok(new Set(data.files["contacts.csv"].map((c) => c.role)).size >= 8, "real job titles, more than a couple");
  assert.ok(new Set(data.files["tickets.csv"].map((t) => t.subject)).size >= 10, "tickets say what they are about");
  assert.ok(data.files["tickets.csv"].every((t) => String(t.subject).trim().length > 0));
  assert.ok(new Set(data.files["events.csv"].map((e) => e.kind)).size >= 6, "events tell a story");
  assert.ok(data.files["invoices.csv"].length >= accounts.length * 3, "a billing history, not one invoice each");
  assert.ok(
    data.files["invoices.csv"].some((i) => i.attempts > 0 && i.status === "paid"),
    "including payments that took more than one attempt and then came good",
  );
});

test("the same seed builds the same company, exactly", () => {
  const a = generate({ asOf: AS_OF, seed: 7, scale: 2, days: 200 });
  const b = generate({ asOf: AS_OF, seed: 7, scale: 2, days: 200 });
  for (const file of Object.keys(a.files)) assert.deepEqual(a.files[file], b.files[file], file);
  assert.deepEqual(a.scenarios, b.scenarios);
  const c = generate({ asOf: AS_OF, seed: 8, scale: 2, days: 200 });
  assert.notDeepEqual(a.files["accounts.csv"], c.files["accounts.csv"], "a different seed is a different company");
});

test("nothing in the texture plants a signal by accident", () => {
  const data = demoData();
  const scenarioOf = new Map(data.scenarios.map((s) => [s.account_id, s.scenario]));
  const windowStart = addDays(AS_OF, -29);

  // 🔴 A failed invoice inside the payment window stands ALONE as a decision
  // (minBandForAlone), so one on a trap account is one raised decision.
  for (const i of data.files["invoices.csv"]) {
    if (String(i.status) !== "failed") continue;
    assert.ok(i.due_at >= windowStart, `a failed invoice outside the window would never be seen: ${i.invoice_id}`);
    assert.equal(scenarioOf.get(i.account_id), "payment", `${i.account_id} is not the payment scenario`);
  }

  // The champion signal fires on the QUIETEST champion, so two champions is a
  // second chance to trip every trap.
  for (const [account, list] of rowsBy(data.files["contacts.csv"], "account_id")) {
    const champions = list.filter((c) => /^(1|true|yes)$/i.test(String(c.is_champion)));
    assert.equal(champions.length, 1, `${account} must have exactly one champion`);
  }

  // An OPEN urgent ticket raises a band-2 ticket rise to band 3.
  for (const t of data.files["tickets.csv"]) {
    if (t.closed_at || String(t.priority) !== "urgent") continue;
    assert.equal(scenarioOf.get(t.account_id), "churn_clear", `an open urgent ticket on ${t.account_id}`);
  }

  // The engine reads exactly three event kinds. Everything else is colour.
  const PLANTED = { pricing_page_view: ["expansion"], seat_limit_hit: ["expansion"], champion_left: ["dismissed_worse"] };
  for (const e of data.files["events.csv"]) {
    const allowed = PLANTED[e.kind];
    if (!allowed) continue;
    assert.ok(allowed.includes(scenarioOf.get(e.account_id)), `${e.kind} on a ${scenarioOf.get(e.account_id)} account`);
  }

  // The stale customer is stale, and only that one.
  const usage = rowsBy(data.files["usage_daily.csv"], "account_id");
  for (const s of data.scenarios) {
    const last = (usage.get(s.account_id) ?? []).at(-1)?.day ?? null;
    const gap = last ? daysBetween(last, AS_OF) : null;
    if (s.scenario === "stale_data") assert.ok(gap >= 14, `${s.account_id} should have stopped reporting, gap ${gap}`);
    else assert.ok(gap <= 1, `${s.account_id} reports up to today, gap ${gap}`);
  }
});

test("the planted usage change measures what RATIO says, on every as-of weekday", () => {
  // The weekly pattern moves a 30-day mean, and a 30-day window is four weeks
  // plus two days - so the bias depends on which weekday `asOf` falls on. Seven
  // consecutive dates cover every case.
  for (let k = 0; k < 7; k++) {
    const asOf = addDays(AS_OF, k);
    const data = variant("demo", asOf);
    const usage = rowsBy(data.files["usage_daily.csv"], "account_id");
    const mean = (rows, from, to) => {
      const v = rows.filter((r) => r.day >= from && r.day <= to).map((r) => Number(r.active_users));
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };

    for (const s of data.scenarios) {
      if (s.scenario === "stale_data") continue; // no recent window to measure
      const rows = usage.get(s.account_id) ?? [];
      const cur = mean(rows, addDays(asOf, -29), asOf);
      const base = mean(rows, addDays(asOf, -59), addDays(asOf, -30));
      if (cur == null || base == null || base === 0) continue; // a customer too new to compare
      const pct = Math.round(((cur - base) / base) * 100);
      const where = `${s.account_id} (${s.scenario}) on ${asOf}: ${pct}%`;

      if (s.scenario === "churn_clear") assert.ok(pct <= DROP[1], `${where} must reach band 2`);
      else if (s.scenario === "dismissed_worse") assert.ok(pct <= DROP[2], `${where} must reach band 3`);
      else if (s.scenario === "churn_subtle" || s.scenario === "dismissed_unchanged") {
        assert.ok(pct <= DROP[0] && pct > DROP[1], `${where} must be band 1, neither missed nor severe`);
      } else if (s.scenario === "expansion") assert.ok(pct >= RISE, `${where} must reach the rise threshold`);
      else assert.ok(pct > DROP[0] && pct < RISE, `${where} must move NO usage signal at all`);
    }
  }
});

/* ── a full run at demo size ────────────────────────────────────────────── */

test("a run at demo size: every trap stays silent and every planted situation is found", async () => {
  const { db, data } = demoWorkspace();
  const started = Date.now();
  const r = await runAnalysis({ db, noModel: true });
  const runMs = Date.now() - started;
  assert.equal(r.ok, true, r.error);
  assert.equal(r.summary.accounts, data.scenarios.length);

  const raised = rowsBy(db.prepare("SELECT account_id, kind, severity, status FROM decision WHERE status != 'dismissed'").all(), "account_id");
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };

  // 🔴 THE TRAPS. One warning sign each, and nothing may be raised about any of
  // them - including the customer whose usage data simply stopped arriving.
  const traps = data.scenarios.filter((s) => s.scenario.startsWith("fp_") || s.scenario === "stale_data");
  assert.ok(traps.length >= 12, `expected the traps to scale with the dataset, got ${traps.length}`);
  for (const s of traps) {
    assert.equal(raised.get(s.account_id), undefined, `${s.account_id} (${s.scenario}) raised ${JSON.stringify(raised.get(s.account_id))}`);
  }

  // And the planted situations, every one of them, at the severity promised.
  for (const s of data.scenarios) {
    const want = s.expect.kind;
    if (!want || s.expect.suppressed) continue;
    const got = raised.get(s.account_id) ?? [];
    const match = got.find((d) => d.kind === want);
    assert.ok(match, `${s.account_id} (${s.scenario}) should have raised ${want}, raised ${JSON.stringify(got)}`);
    if (s.expect.minSeverity) {
      assert.ok(
        rank[match.severity] >= rank[s.expect.minSeverity],
        `${s.account_id} (${s.scenario}) raised ${match.severity}, expected at least ${s.expect.minSeverity}`,
      );
    }
  }

  // The healthy majority is the other half of the claim: a system that raises
  // something about everybody is no better than one that raises nothing.
  const healthyRaised = byScenario(data, "healthy").filter((s) => raised.has(s.account_id));
  assert.equal(healthyRaised.length, 0, `healthy customers raised: ${healthyRaised.map((s) => s.account_id).join(", ")}`);

  assert.ok(runMs < 8000, `a run at demo size took ${runMs}ms, which is too slow to do in front of anyone`);
  db.close();
});

test("the two customers with a dismissed decision behave differently from each other", async () => {
  const { db, data } = demoWorkspace();
  await runAnalysis({ db, noModel: true });
  const open = rowsBy(
    db.prepare(`SELECT account_id, kind, severity FROM decision WHERE status IN (${OPEN_STATUSES.map(() => "?").join(",")})`).all(...OPEN_STATUSES),
    "account_id",
  );

  for (const s of byScenario(data, "dismissed_unchanged")) {
    assert.equal(open.get(s.account_id), undefined, `${s.account_id} was dismissed and nothing got worse; it must stay quiet`);
  }
  for (const s of byScenario(data, "dismissed_worse")) {
    const got = open.get(s.account_id) ?? [];
    assert.ok(got.some((d) => d.kind === "churn_risk"), `${s.account_id} got worse after being dismissed; it must come back`);
  }
  db.close();
});

test("the company-wide variant blames the company, not thirty customers", async () => {
  const data = variant("demo-cohort", AS_OF);
  const dir = tmpdir();
  writeDataset(dir, data);
  const db = openMemory();
  assert.equal(importFolder(db, dir).ok, true);
  setSettings(db, { demoMode: true, seatPriceMonthly: 25 });
  setMeta(db, "as_of", AS_OF);
  fs.rmSync(dir, { recursive: true, force: true });

  const r = await runAnalysis({ db, noModel: true });
  assert.equal(r.ok, true, r.error);
  assert.ok(r.summary.cohort, "a company-wide change must be detected");
  assert.equal(r.summary.cohort.direction, "down");

  const raised = new Set(db.prepare("SELECT account_id FROM decision").all().map((x) => x.account_id));
  const healthyRaised = byScenario(data, "healthy").filter((s) => raised.has(s.account_id));
  assert.equal(healthyRaised.length, 0, `${healthyRaised.length} healthy customers were blamed for a company-wide change`);
  db.close();
});
/* ── the history a chat window cannot keep ──────────────────────────────── */
//
// 🔴 WHY THIS SECTION IS LONGER THAN THE CODE IT COVERS.
//
// The old test here asked only whether evidence EXISTED. It did, so it passed -
// while the evidence said "38 of 40 seats are in use" about a customer who had
// bought 24, named a VP Operations who was in fact a Director of Engineering,
// quoted a payment due six months AFTER the decision was closed, and put two
// decisions on a customer created three months later. Twenty-five decisions,
// forty-six evidence rows, seven distinct sentences. Every one of those defects
// was on screen, next to the record it contradicted, and the suite was green.
//
// So the tests below do not ask whether a sentence is there. They read the
// NUMBERS AND NAMES OUT OF THE SENTENCE and check each one against the row it
// claims to describe. A statement the customer's own rows cannot produce is the
// failure this file exists to catch.

/** The demo, with its history seeded. Built once: it costs about a second. */
let _history = null;
function historyWorkspace() {
  if (!_history) {
    const { db, data } = demoWorkspace();
    const written = seedHistory(db, data, AS_OF);
    const decisions = db.prepare("SELECT * FROM decision WHERE id LIKE 'dec_hist%' ORDER BY id").all();
    _history = { db, data, written, decisions };
  }
  return _history;
}

const dayOf = (iso) => String(iso ?? "").slice(0, 10);
const accountOf = (db, id) => db.prepare("SELECT * FROM account WHERE id = ?").get(id);
const evidenceOf = (db, id) => db.prepare("SELECT * FROM decision_evidence WHERE decision_id = ? ORDER BY rank").all(id);

/** The mean of one metric over the `days` days ending on `end`, as signals.mjs measures it. */
function meanOver(db, accountId, metric, end, days) {
  const rows = db
    .prepare("SELECT value FROM metric_daily WHERE account_id = ? AND metric = ? AND day >= ? AND day <= ?")
    .all(accountId, metric, addDays(end, -(days - 1)), end);
  return rows.length ? rows.reduce((a, r) => a + Number(r.value), 0) / rows.length : null;
}

/** format.mjs num(): at most one decimal, no trailing zero. The statements print this. */
const num = (n) => {
  if (n == null || !Number.isFinite(n)) return "—";
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
};
const pct = (cur, base) => (base === 0 ? null : Math.round(((cur - base) / Math.abs(base)) * 100));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "12 May 2026" -> "2026-05-12". The inverse of format.mjs humanDate(). */
function parseHumanDate(text) {
  const m = /^(\d{1,2}) (\w{3}) (\d{4})$/.exec(String(text).trim());
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`;
}

test("a few customers carry a worked, resolved history with the outcome recorded", async () => {
  const { db, data } = demoWorkspace();
  const written = seedHistory(db, data, AS_OF);
  assert.ok(written >= 10, `expected a real history, got ${written} decisions`);

  const history = db.prepare("SELECT * FROM decision WHERE id LIKE 'dec_hist%'").all();
  assert.equal(history.length, written);
  const accountsWithHistory = new Set(history.map((d) => d.account_id));
  assert.ok(accountsWithHistory.size >= 3, "more than one customer remembers something");
  assert.ok(accountsWithHistory.size < history.length, "and at least one has more than one past decision");

  const scenarioOf = new Map(data.scenarios.map((s) => [s.account_id, s.scenario]));
  for (const d of history) {
    // 🔴 A decision row of ANY status on a trap account reads as a raised
    // decision to everything that counts rows per customer.
    const sc = scenarioOf.get(d.account_id);
    assert.ok(!sc.startsWith("fp_") && !sc.startsWith("dismissed_") && sc !== "stale_data", `history landed on a ${sc} account`);
    // 🔴 Resolved, never dismissed: a dismissed decision suppresses the next one.
    assert.equal(d.status, "resolved");
    assert.ok(d.resolved_at && d.resolved_at < AS_OF, "it was closed in the past");
    assert.ok(d.owner, "somebody owned it");

    const outcome = db.prepare("SELECT * FROM outcome WHERE decision_id = ?").get(d.id);
    assert.ok(outcome, `${d.id} was resolved with no recorded outcome, which is the hole this product exists to close`);
    assert.ok(outcome.result && outcome.arr_after != null);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM decision_evidence WHERE decision_id = ?").get(d.id).n > 0, "with the evidence kept");

    const events = db.prepare("SELECT * FROM decision_event WHERE decision_id = ? ORDER BY at").all(d.id);
    assert.ok(events.length >= 5, `${d.id} has a timeline`);
    assert.ok(events.some((e) => e.kind === "resolved") && events.some((e) => e.kind === "outcome"));
    assert.deepEqual([...events].sort((a, b) => a.at.localeCompare(b.at)).map((e) => e.at), events.map((e) => e.at), "in order");

    // ⚠️ A seeded email inside the outreach cooldown would make the demo's own
    // "Draft an email" button refuse to work on that customer.
    for (const a of db.prepare("SELECT * FROM action WHERE decision_id = ?").all(d.id)) {
      assert.equal(a.status, "done");
      assert.ok(daysBetween(a.created_at, AS_OF) > rules().limits.outreachCooldownDays, `${a.id} is inside the outreach cooldown`);
    }
  }

  // And the history must not change what the engine does next - for ANY of the
  // planted scenarios, not only the two that used to be checked here.
  const r = await runAnalysis({ db, noModel: true });
  assert.equal(r.ok, true, r.error);
  const raised = rowsBy(db.prepare("SELECT account_id, kind, severity FROM decision WHERE id NOT LIKE 'dec_hist%' AND status != 'dismissed'").all(), "account_id");
  const rank = { low: 1, medium: 2, high: 3, critical: 4 };
  for (const s of data.scenarios) {
    if (s.scenario.startsWith("fp_") || s.scenario === "stale_data") {
      assert.equal(raised.get(s.account_id), undefined, `${s.account_id} (${s.scenario}) raised something once it had a history`);
      continue;
    }
    if (!s.expect.kind || s.expect.suppressed) continue;
    const match = (raised.get(s.account_id) ?? []).find((d) => d.kind === s.expect.kind);
    assert.ok(match, `${s.account_id} (${s.scenario}) lost its ${s.expect.kind} once it had a history`);
    if (s.expect.minSeverity) {
      assert.ok(rank[match.severity] >= rank[s.expect.minSeverity], `${s.account_id} dropped to ${match.severity}`);
    }
  }
  db.close();
});

test("every figure in a history statement is a figure from that customer's own rows", () => {
  const { db, decisions } = historyWorkspace();
  assert.ok(decisions.length > 0, "there is a history to check");
  let checked = 0;

  for (const d of decisions) {
    const a = accountOf(db, d.account_id);
    const at = dayOf(d.created_at); // the day the decision opened: its own as-of
    assert.ok(a, `${d.id} points at a customer that does not exist`);
    assert.ok(d.title.startsWith(a.name), `${d.id} is titled "${d.title}" on ${a.name}`);

    for (const e of evidenceOf(db, d.id)) {
      const where = `${d.id} (${a.id}, ${a.name}): "${e.statement}"`;

      // 🔴 SEATS. Eight old rows said "38 of 40 seats are in use (95%)" on
      // accounts that had bought 18, 24, 28 or 31.
      const seat = /^([\d.]+) of (\d+) seats (?:are in use|were used in the last 7 days) \((\d+)%\)\.$/.exec(e.statement);
      if (seat) {
        const [, used, purchased, share] = seat;
        assert.equal(Number(purchased), Number(a.seats_purchased), `${where} - the account bought ${a.seats_purchased} seats`);
        assert.ok(Number(used) <= Number(purchased), `${where} - more seats used than bought`);
        const mean = meanOver(db, a.id, "seats_used", at, 7);
        assert.equal(num(mean), used, `${where} - the rows average ${num(mean)} seats over the 7 days to ${at}`);
        // ⚠️ AGAINST THE MEAN, NOT AGAINST THE PRINTED FIGURE. The engine
        // divides the unrounded mean; the sentence prints it to one decimal.
        // 7.14 of 25 is 29%, and "7.1 of 25" is 28% - so a test that recomputed
        // from the printed number would fail on data that is perfectly correct.
        assert.equal(Number(share), Math.round((mean / Number(purchased)) * 100), `${where} - the percentage does not follow`);
        checked++;
        continue;
      }

      // 🔴 USAGE. The percentage and both means are recomputed from
      // metric_daily over the two windows ending on the day it was raised.
      const usage = /^Average daily active users (fell|rose) (\d+)% over the last 30 days \(([\d.]+) vs ([\d.]+)\)\.$/.exec(e.statement);
      if (usage) {
        const [, direction, moved, current, baseline] = usage;
        const cur = meanOver(db, a.id, "active_users", at, 30);
        const base = meanOver(db, a.id, "active_users", addDays(at, -30), 30);
        assert.ok(cur != null && base != null, `${where} - there are no rows in those windows`);
        assert.equal(num(cur), current, `${where} - the last 30 days average ${num(cur)}`);
        assert.equal(num(base), baseline, `${where} - the 30 before them average ${num(base)}`);
        const change = pct(cur, base);
        assert.equal(Math.abs(change), Number(moved), `${where} - the rows moved ${change}%`);
        assert.equal(direction, change < 0 ? "fell" : "rose", `${where} - the direction is wrong`);
        checked++;
        continue;
      }

      // 🔴 TICKETS. Recounted from the ticket table in the same two windows.
      const tickets = /^Support tickets rose from (\d+) to (\d+) in the last 30 days/.exec(e.statement);
      if (tickets) {
        const [, before, after] = tickets;
        const count = (from, to) =>
          db.prepare("SELECT COUNT(*) n FROM ticket WHERE account_id = ? AND opened_at >= ? AND opened_at <= ?").get(a.id, from, to).n;
        assert.equal(count(addDays(at, -29), at), Number(after), `${where} - the account opened a different number of tickets`);
        assert.equal(count(addDays(at, -59), addDays(at, -30)), Number(before), `${where} - the prior window does not hold ${before}`);
        checked++;
        continue;
      }

      // 🔴 PAYMENTS. Four old rows quoted "due 12 May 2026" on decisions that
      // had been RESOLVED in November 2025 and January 2026 - evidence dated
      // after the decision it justified was closed. This finds the invoice.
      const payment = /^A payment of \$([\d,]+) due (.+?) has failed (\d+) time\(s\)\.$/.exec(e.statement);
      if (payment) {
        const [, amount, dueText, attempts] = payment;
        const due = parseHumanDate(dueText);
        assert.ok(due, `${where} - "${dueText}" is not a date`);
        const inv = db
          .prepare("SELECT * FROM invoice WHERE account_id = ? AND due_at = ? AND status = 'failed'")
          .get(a.id, due);
        assert.ok(inv, `${where} - no failed invoice on ${a.id} is due ${due}`);
        assert.equal(Math.round(Number(inv.amount)).toLocaleString("en-US"), amount, `${where} - the invoice is ${inv.amount}`);
        assert.equal(Number(inv.attempts), Number(attempts), `${where} - the invoice records ${inv.attempts} attempts`);
        assert.ok(due <= dayOf(d.resolved_at), `${where} - the invoice is due AFTER the decision was closed on ${dayOf(d.resolved_at)}`);
        checked++;
        continue;
      }

      assert.fail(`${where} - no check covers this statement shape, so nothing is verifying its numbers`);
    }
  }
  assert.ok(checked >= 15, `only ${checked} statements were checked; the history is too thin to prove anything`);
});

test("a history statement never names a person or a job title from another customer", () => {
  const { db, data, decisions } = historyWorkspace();
  const allContacts = data.files["contacts.csv"];
  const roles = [...new Set(allContacts.map((c) => c.role))];
  const names = [...new Set(allContacts.map((c) => c.name))];

  for (const d of decisions) {
    const mine = db.prepare("SELECT * FROM contact WHERE account_id = ?").all(d.account_id);
    const myRoles = new Set(mine.map((c) => c.role));
    const myNames = new Set(mine.map((c) => c.name));
    const champion = mine.find((c) => Number(c.is_champion) === 1);

    // Everything a reader can see about this decision, in one string.
    const text = [
      d.title,
      d.why_it_matters,
      d.rationale,
      d.recommended_action_text,
      ...evidenceOf(db, d.id).map((e) => e.statement),
      ...db.prepare("SELECT payload_json FROM action WHERE decision_id = ?").all(d.id).map((r) => r.payload_json),
      db.prepare("SELECT note FROM outcome WHERE decision_id = ?").get(d.id)?.note ?? "",
      ...db.prepare("SELECT data_json FROM decision_event WHERE decision_id = ?").all(d.id).map((r) => r.data_json ?? ""),
    ].join("  ");

    // 🔴 SEVEN OLD ROWS SAID "The champion (VP Operations) has not been active"
    // on customers whose champion is a Director of Engineering or a Chief of
    // Staff - and decisionsGet returns account.contacts onto the same page, so
    // the claim and its contradiction were on screen together.
    for (const role of roles) {
      if (!text.includes(role)) continue;
      assert.ok(myRoles.has(role), `${d.id} (${d.account_id}) mentions "${role}", which nobody on that account holds`);
    }
    for (const name of names) {
      if (!text.includes(name)) continue;
      assert.ok(myNames.has(name), `${d.id} (${d.account_id}) mentions "${name}", who is not a contact on that account`);
    }
    // And where a champion is named at all, it is THE champion.
    if (champion && text.includes(champion.role)) {
      assert.ok(myRoles.has(champion.role));
    }
  }
});

/**
 * ⭐ MEASURED WHILE BREAKING THIS ON PURPOSE, 2026-09-17: removing the
 * created_at check from the seeder ENTIRELY no longer produces the defect. The
 * engine refuses to measure a window holding fewer than `minDays` rows, and a
 * customer who did not exist has no rows, so no situation is raised and no
 * decision is written. Deriving the evidence from the rows turned a date bug
 * into an impossibility. The test stays because the property is worth stating,
 * and because it DOES fire the moment a decision's own row is dated away from
 * the evidence underneath it.
 */
test("a history decision never opens before its customer existed", () => {
  const { db, decisions } = historyWorkspace();
  for (const d of decisions) {
    const a = accountOf(db, d.account_id);
    const opened = dayOf(d.created_at);
    // 🔴 dec_histACC001_0 opened 2025-12-15 and dec_histACC001_1 opened
    // 2026-01-29 on a customer whose created_at is 2026-06-26 - and ACC-001 is
    // the FIRST row in the customer list, the one a viewer clicks first.
    assert.ok(opened >= a.created_at, `${d.id} opened ${opened} on a customer created ${a.created_at}`);
    // Stronger: the whole 60-day window its evidence measures must sit inside
    // the customer's life, or the percentages are computed over a gap.
    assert.ok(
      addDays(opened, -59) >= a.created_at,
      `${d.id} measures back to ${addDays(opened, -59)} on a customer created ${a.created_at}`,
    );
    assert.ok(dayOf(d.resolved_at) >= opened, `${d.id} was resolved before it was raised`);

    const events = db.prepare("SELECT at FROM decision_event WHERE decision_id = ?").all(d.id).map((e) => dayOf(e.at));
    for (const at of events) {
      assert.ok(at >= addDays(opened, -1) && at <= dayOf(d.resolved_at), `${d.id} has an event on ${at}, outside its own life`);
    }
    for (const act of db.prepare("SELECT * FROM action WHERE decision_id = ?").all(d.id)) {
      assert.ok(dayOf(act.created_at) >= addDays(opened, -1), `${act.id} was prepared before the decision existed`);
      assert.ok(dayOf(act.done_at) <= dayOf(d.resolved_at), `${act.id} was finished after the decision closed`);
    }
  }
});

test("two decisions on one customer never carry the same sentence twice", () => {
  const { db, decisions } = historyWorkspace();
  const byAccount = new Map();
  for (const d of decisions) {
    for (const e of evidenceOf(db, d.id)) {
      if (!byAccount.has(d.account_id)) byAccount.set(d.account_id, new Map());
      const seen = byAccount.get(d.account_id);
      // 🔴 ACC-111 carried three churn decisions in three different months and
      // all three read "fell 41%" and "champion inactive 22 days". Eight pairs
      // of byte-identical evidence sat on the same customer.
      assert.ok(
        !seen.has(e.statement),
        `${d.account_id}: ${d.id} and ${seen.get(e.statement)} both say "${e.statement}"`,
      );
      seen.set(e.statement, d.id);
    }
  }
  assert.ok([...byAccount.values()].some((m) => m.size >= 3), "some customer carries several different statements");
});

test("impact_basis explains impact_amount, and the two agree arithmetically", () => {
  const { db, decisions } = historyWorkspace();
  for (const d of decisions) {
    const a = accountOf(db, d.account_id);
    const where = `${d.id}: ${d.impact_amount} described as "${d.impact_basis}"`;
    assert.ok(d.impact_basis, `${d.id} has an amount with no basis`);

    if (d.kind === "churn_risk") {
      assert.equal(d.impact_basis, "annual contract value at risk");
      assert.equal(Number(d.impact_amount), Number(a.arr), `${where} - the account's ARR is ${a.arr}`);
      continue;
    }
    if (d.kind === "expansion") {
      // 🔴 THE OLD ROW SAID "5 more seats at USD 25 a month" ($1,500 a year)
      // NEXT TO AN AMOUNT THAT WAS 18% OF ARR ($4,320 on ACC-001). The basis
      // contradicted the number it was there to explain, on the same card.
      const m = /^(\d+) more seats at ([A-Z]{3}) ([\d.]+) a month$/.exec(d.impact_basis);
      assert.ok(m, `${where} - the basis does not say what the number is made of`);
      const [, seats, currency, price] = m;
      assert.equal(Number(d.impact_amount), Number(seats) * Number(price) * 12, `${where} - ${seats} x ${price} x 12`);
      assert.equal(currency, d.currency);
      continue;
    }
    if (d.kind === "payment_risk") {
      assert.equal(d.impact_basis, "unpaid invoice");
      const inv = db.prepare("SELECT * FROM invoice WHERE account_id = ? AND status = 'failed'").all(a.id);
      assert.ok(
        inv.some((i) => Math.round(Number(i.amount)) === Math.round(Number(d.impact_amount))),
        `${where} - no failed invoice on ${a.id} is for that amount`,
      );
      continue;
    }
    assert.fail(`${d.id} is a ${d.kind}, which nothing here checks`);
  }
});

test("nothing the history writes can reach the live engine", async () => {
  const { db, data } = demoWorkspace();
  const key = (r) => JSON.stringify(r);

  const beforeMetrics = new Map(
    db.prepare("SELECT account_id, day, metric, value FROM metric_daily").all().map((r) => [`${r.account_id}|${r.day}|${r.metric}`, r.value]),
  );
  const beforeTickets = new Map(db.prepare("SELECT * FROM ticket").all().map((r) => [r.id, key(r)]));
  const beforeInvoices = new Map(db.prepare("SELECT * FROM invoice").all().map((r) => [r.id, key(r)]));

  // A run with NO history at all, to compare against.
  const before = await runAnalysis({ db, noModel: true });
  assert.equal(before.ok, true, before.error);
  const raisedBefore = db
    .prepare("SELECT account_id, kind, severity FROM decision WHERE status != 'dismissed' ORDER BY account_id, kind")
    .all()
    .map(key);
  db.close();

  const fresh = demoWorkspace();
  seedHistory(fresh.db, fresh.data, AS_OF);

  // 🔴 THE GUARD. Every raw row the history touched must sit at least 90 days
  // back, because the furthest the engine ever looks is 60. A planted drop
  // inside those 60 days would move the RATIO table and wake a trap.
  const guard = addDays(AS_OF, -90);
  let moved = 0;
  for (const r of fresh.db.prepare("SELECT account_id, day, metric, value FROM metric_daily").all()) {
    const k = `${r.account_id}|${r.day}|${r.metric}`;
    if (beforeMetrics.get(k) === r.value) continue;
    moved++;
    assert.ok(r.day <= guard, `the history moved usage on ${r.account_id} for ${r.day}, inside the engine's own windows`);
  }
  assert.ok(moved > 0, "the history planted nothing at all, so its evidence rests on nothing");

  for (const r of fresh.db.prepare("SELECT * FROM ticket").all()) {
    if (beforeTickets.get(r.id) === key(r)) continue;
    assert.ok(r.opened_at <= guard, `the history added ticket ${r.id} on ${r.opened_at}, inside the engine's windows`);
    assert.ok(r.closed_at, `the history left ticket ${r.id} open; an open urgent ticket is a planted signal`);
  }
  for (const r of fresh.db.prepare("SELECT * FROM invoice").all()) {
    if (beforeInvoices.get(r.id) === key(r)) continue;
    assert.ok(r.due_at <= guard, `the history changed invoice ${r.id} due ${r.due_at}, inside the payment window`);
  }

  // And the proof that matters: the run reaches exactly the same verdicts.
  const after = await runAnalysis({ db: fresh.db, noModel: true });
  assert.equal(after.ok, true, after.error);
  const raisedAfter = fresh.db
    .prepare("SELECT account_id, kind, severity FROM decision WHERE status != 'dismissed' AND id NOT LIKE 'dec_hist%' ORDER BY account_id, kind")
    .all()
    .map(key);
  assert.deepEqual(raisedAfter, raisedBefore, "seeding the history changed what the engine raised");
  fresh.db.close();
});

test("after the history is seeded, the database still plants no signal by accident", () => {
  const { db, data } = historyWorkspace();
  const scenarioOf = new Map(data.scenarios.map((s) => [s.account_id, s.scenario]));
  const windowStart = addDays(AS_OF, -29);

  // The same four invariants the CSV test checks, re-checked against the
  // WORKSPACE - because the history writes rows the CSV files never saw.
  for (const i of db.prepare("SELECT * FROM invoice WHERE status = 'failed'").all()) {
    if (i.due_at >= windowStart) {
      assert.equal(scenarioOf.get(i.account_id), "payment", `a live failed invoice on ${i.account_id}`);
    } else {
      assert.ok(daysBetween(i.due_at, AS_OF) >= 90, `failed invoice ${i.id} is ${daysBetween(i.due_at, AS_OF)} days old`);
    }
  }
  for (const row of db.prepare("SELECT account_id, COUNT(*) n FROM contact WHERE is_champion = 1 GROUP BY account_id").all()) {
    assert.equal(row.n, 1, `${row.account_id} has ${row.n} champions`);
  }
  for (const t of db.prepare("SELECT * FROM ticket WHERE (closed_at IS NULL OR closed_at = '') AND priority = 'urgent'").all()) {
    assert.equal(scenarioOf.get(t.account_id), "churn_clear", `an open urgent ticket on ${t.account_id}`);
  }
  // Seats above the cap are a PLANTED signal, not an accident: the expansion
  // scenario deliberately oversubscribes by 5% so `seat_limit_hit` has
  // something behind it, and `impactFor` reads the overflow to size the deal.
  // Anywhere else it is a bug, and the history must never create one - the two
  // seat signals divide by seats_purchased, so a row over the cap reports more
  // than 100% of the seats somebody bought.
  const over = db
    .prepare(
      `SELECT DISTINCT m.account_id FROM metric_daily m JOIN account a ON a.id = m.account_id
       WHERE m.metric = 'seats_used' AND m.value > a.seats_purchased`,
    )
    .all();
  for (const row of over) {
    assert.equal(scenarioOf.get(row.account_id), "expansion", `${row.account_id} uses more seats than it bought`);
  }
});

test("the same seed seeds the same history, byte for byte", () => {
  const dump = () => {
    const { db, data } = demoWorkspace();
    seedHistory(db, data, AS_OF);
    const out = {
      decisions: db.prepare("SELECT * FROM decision WHERE id LIKE 'dec_hist%' ORDER BY id").all(),
      evidence: db.prepare("SELECT * FROM decision_evidence WHERE decision_id LIKE 'dec_hist%' ORDER BY decision_id, rank").all(),
      signals: db.prepare("SELECT * FROM signal WHERE run_id LIKE 'run_hist%' ORDER BY id").all(),
      actions: db.prepare("SELECT * FROM action WHERE id LIKE 'act_hist%' ORDER BY id").all(),
      outcomes: db.prepare("SELECT * FROM outcome WHERE decision_id LIKE 'dec_hist%' ORDER BY decision_id").all(),
      events: db.prepare("SELECT * FROM decision_event WHERE id LIKE 'evt_hist%' ORDER BY id").all(),
      usage: db.prepare("SELECT account_id, day, metric, value FROM metric_daily ORDER BY account_id, day, metric").all(),
    };
    db.close();
    return out;
  };
  const a = dump();
  const b = dump();
  for (const k of Object.keys(a)) assert.deepEqual(a[k], b[k], `${k} differs between two seeds of the same company`);
  assert.ok(a.decisions.length > 0 && a.signals.length > 0);
});

/* ── the history has to reach the screen ────────────────────────────────── */

/**
 * A REAL workspace on disk, driven through the REAL routes.
 *
 * 🔴 WHY NOT REPLICATE THE ROUTE'S QUERY HERE. Two of the nine defects this
 * file now covers were invisible to an in-memory test because they live in
 * routes.mjs, not in the seeder: `decisionsOverview` counts `resolvedThisMonth`
 * over the last 30 days only, and `decisionsGet` falls back to the LATEST run
 * when `last_run_id` is null. A test that re-implements those two rules would
 * have agreed with itself and proved nothing.
 */
async function realWorkspace() {
  const created = workspace.create(`history-${Date.now()}`);
  assert.equal(created.ok, true, created.error);
  const id = created.workspace.id;
  workspace.select(id);
  const seeded = await decisionRoutes.decisionsSeedDemo({ body: { variant: "demo" } });
  assert.equal(seeded.ok, true, seeded.error);
  return id;
}

/** How many history decisions a workspace holds. */
function historyCount(id) {
  const sel = workspace.openWorkspace(id);
  try {
    return { n: sel.prepare("SELECT COUNT(*) n FROM decision WHERE id LIKE 'dec_hist%'").get().n, asOf: sel.prepare("SELECT value FROM meta WHERE key = 'as_of'").get()?.value };
  } finally {
    sel.close();
  }
}

test("Load the demo company produces the history it is meant to demonstrate", async () => {
  // 🔴 THIS IS THE SHIPPED PATH, NOT A HAND-ASSEMBLED ONE. seedHistory existed,
  // was exported, was tested, and was called by NOTHING - so a fresh install had
  // no worked history at all and Beat 7 of docs/demo/investor-demo.md showed an
  // empty screen. The route now calls it; this asserts that it still does.
  //
  // ⚠️ Do not weaken this into a test of seedHistory itself. Its own behaviour is
  // covered above. The only thing this test is for is the WIRE.
  const id = await realWorkspace();
  const { n } = historyCount(id);
  assert.ok(
    n > 0,
    "decisionsSeedDemo no longer seeds any worked history, so a fresh demo cannot show that the product remembers",
  );
});

test("both counters on the decision page agree, and the month's resolved work is on the Today screen", async () => {
  const id = await realWorkspace();
  const { asOf } = historyCount(id);
  assert.ok(asOf, "the demo pins its own as-of date");

  // The one line decisionsSeedDemo is missing, done by hand so the rest of the
  // shipped path can still be measured. `variant` is deterministic, so this is
  // the same dataset the route just imported.
  const sel = workspace.openWorkspace(id);
  const written = seedHistory(sel, variant("demo", asOf), asOf);
  sel.close();
  assert.ok(written > 0, "the seeder wrote nothing into a real workspace");

  const run = await decisionRoutes.decisionsRun({ body: { noModel: true } });
  assert.equal(run.ok, true, run.error);

  // 🔴 THE TWO COUNTERS. The page header prints `cited.length of
  // allSignals.length` and the coverage grid under it prints how many of
  // allSignals are cited. On dec_histACC011_0 they read "2 of 1" and "0 of 1",
  // because the cited ids belonged to no signal row at all.
  const list = await decisionRoutes.decisionsList({ query: { status: "resolved" } });
  assert.equal(list.ok, true, list.error);
  const history = list.decisions.filter((d) => d.id.startsWith("dec_hist"));
  assert.ok(history.length >= 3, `expected resolved history in the list, got ${history.length}`);

  for (const card of history) {
    const got = await decisionRoutes.decisionsGet({ query: { id: card.id } });
    assert.equal(got.ok, true, got.error);
    const cited = got.evidence.length;
    const total = got.allSignals.length;
    const filled = got.allSignals.filter((s) => s.cited).length;
    assert.equal(filled, cited, `${card.id}: the header says ${cited} cited, the coverage grid says ${filled}`);
    assert.ok(cited <= total, `${card.id}: the header says "${cited} of ${total} signals"`);
    for (const e of got.evidence) {
      assert.ok(got.allSignals.some((s) => s.id === e.signal_id), `${card.id} cites ${e.signal_id}, which is in no run`);
    }
    // The uncited panel must not offer TODAY's signals under a decision that
    // was closed months ago.
    assert.ok(
      got.allSignals.every((s) => s.run_id === got.decision.id.replace("dec_hist", "run_hist")),
      `${card.id} is showing signals from another run`,
    );
  }

  // 🔴 THE TILE THE DEMO SCRIPT POINTS AT. Every seeded decision used to be
  // 229-326 days old, and this counts the last 30 days only - so wiring the
  // seeder in would still have left the tile on zero and the section empty.
  const overview = await decisionRoutes.decisionsOverview();
  assert.equal(overview.ok, true, overview.error);
  assert.ok(overview.tiles.resolvedThisMonth > 0, "nothing was resolved in the last 30 days, so the Resolved tile reads zero");
  assert.ok(overview.sections.resolved.length > 0, "the Resolved section on the Today screen is empty");
  assert.ok(
    overview.sections.resolved.some((d) => d.id.startsWith("dec_hist")),
    "the resolved work on screen is not the seeded history",
  );
});

test("seeding the demo and analysing it is fast enough to do live", async () => {
  const t0 = Date.now();
  const data = variant("demo", AS_OF);
  const dir = tmpdir();
  writeDataset(dir, data);
  const db = openMemory();
  assert.equal(importFolder(db, dir).ok, true);
  setSettings(db, { demoMode: true, seatPriceMonthly: 25 });
  setMeta(db, "as_of", AS_OF);
  seedDismissed(db, data, AS_OF);
  seedHistory(db, data, AS_OF);
  const seedMs = Date.now() - t0;
  fs.rmSync(dir, { recursive: true, force: true });

  const t1 = Date.now();
  const r = await runAnalysis({ db, noModel: true });
  const runMs = Date.now() - t1;
  assert.equal(r.ok, true, r.error);

  // Generous ceilings: this is a guard against a change that makes the demo
  // stall, not a benchmark. Measured 2026-09-17: seed ~1.0s, run ~0.7s.
  assert.ok(seedMs < 10000, `seeding the demo took ${seedMs}ms`);
  assert.ok(runMs < 8000, `the analysis took ${runMs}ms`);
  db.close();
});
