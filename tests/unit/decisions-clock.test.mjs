// One clock for the whole decisions engine.
//
// 🔴 THE BUG THIS PINS DOWN. `setStatus` and the action helpers stamped
// `updated_at` from the WALL clock while `asOfFor()` returned demo mode's
// pinned `as_of`. Follow-ups measure `daysBetween(record, asOf)`, so advancing
// the demo clock nine days moved the question and not the record: the gap stayed
// near zero and no reminder, nudge or overdue flag ever fired. Demo mode exists
// precisely to demonstrate those, so the one feature it sells was the one that
// did not work.
//
// ⚠️ IT HID BEHIND A TIMEZONE, WHICH IS WHY IT SURVIVED A GREEN SUITE. The
// existing engine test compares a 7-day threshold against a fixed 2026-09-09
// scenario. That arithmetic passes while the real UTC date is on or before
// 2026-09-11 and fails from the 12th. A run at 05:12 India time on 2026-09-12
// was 23:42 UTC on the 11th and passed; the same code failed three days later.
// **A test whose result depends on the day it runs is not evidence.** Every test
// below fixes both ends of the comparison.

import { test } from "node:test";
import assert from "node:assert/strict";
import { openMemory, setSettings, setMeta, nowIso } from "../../src/decisions/db.mjs";
import { asOfFor } from "../../src/decisions/run.mjs";
import * as D from "../../src/decisions/decisions.mjs";
import { tick } from "../../src/decisions/followup.mjs";
import { daysBetween } from "../../src/decisions/format.mjs";

const PINNED = "2026-03-04"; // deliberately nowhere near any real run date

function withDecision(fn) {
  const db = openMemory();
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('A1', 'Acme', 50000)").run();
  db.prepare(
    "INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, created_at, updated_at) VALUES ('d1','A1','A1:churn_risk','churn_risk','Acme: churn risk','high','new','model', ?, ?)",
  ).run(PINNED, PINNED);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test("in demo mode the engine stamps the pinned day, not the wall clock", () => {
  withDecision((db) => {
    setSettings(db, { demoMode: true });
    setMeta(db, "as_of", PINNED);
    assert.equal(nowIso(db).slice(0, 10), PINNED);
    // And the real date is genuinely different, or this test proves nothing.
    assert.notEqual(PINNED, new Date().toISOString().slice(0, 10));
  });
});

test("outside demo mode the engine stamps the real clock", () => {
  withDecision((db) => {
    setSettings(db, { demoMode: false });
    setMeta(db, "as_of", PINNED); // present but must be ignored
    assert.equal(nowIso(db).slice(0, 10), new Date().toISOString().slice(0, 10));
  });
});

test("a status change is dated by the same clock the follow-up reads", () => {
  withDecision((db) => {
    setSettings(db, { demoMode: true, waitingNudgeDays: 7 });
    setMeta(db, "as_of", PINNED);
    D.setStatus(db, "d1", "accepted");
    D.setStatus(db, "d1", "waiting");
    const row = db.prepare("SELECT updated_at FROM decision WHERE id = 'd1'").get();
    // The exact equality that was broken: the record and the question must agree.
    assert.equal(row.updated_at.slice(0, 10), asOfFor(db));
    assert.equal(daysBetween(row.updated_at, asOfFor(db)), 0);
  });
});

test("advancing the demo clock actually fires the waiting nudge", () => {
  withDecision((db) => {
    setSettings(db, { demoMode: true, waitingNudgeDays: 7 });
    setMeta(db, "as_of", PINNED);
    D.setStatus(db, "d1", "accepted");
    D.setStatus(db, "d1", "waiting");
    assert.equal(tick(db).waiting, 0, "nothing is waiting long enough on day zero");

    setMeta(db, "as_of", "2026-03-13"); // PINNED + 9 days, written out so it cannot drift
    assert.equal(tick(db).waiting, 1, "nine days past a seven-day threshold must nudge");
  });
});

test("two changes on the same pinned day stay orderable", () => {
  // The fix keeps the real time of day. If it stamped a constant instead,
  // ORDER BY updated_at DESC would become arbitrary and the history would
  // shuffle itself.
  withDecision((db) => {
    setSettings(db, { demoMode: true });
    setMeta(db, "as_of", PINNED);
    const a = nowIso(db);
    const b = nowIso(db);
    assert.equal(a.slice(0, 10), PINNED);
    assert.equal(b.slice(0, 10), PINNED);
    assert.ok(b >= a, "later calls must not sort before earlier ones");
    assert.notEqual(a.slice(11), "00:00:00.000Z", "the time of day must be kept, not zeroed");
  });
});
