// Stories: the migration, the section queries, the frozen snapshot, the weekly
// schedule and the HTML export.
//
// 🔴 THE TEST THAT MATTERS MOST IS "a stored run does not change". Everything
// else here could be right and the feature would still be worthless if opening
// last month's report re-derived it from today's tables. So the snapshot test
// does not check the storage mechanism, it checks the BEHAVIOUR: run a story,
// then change the decisions underneath it, then read the run back and require
// the old numbers. That is the only version of this claim that a future change
// cannot quietly break.
//
// The second is the `resolved_at` trap. The obvious column for "closed in this
// period" is `decision.resolved_at`, and it is wrong twice: `dismiss()` never
// writes it and `reopen()` clears it. The tests below dismiss a decision and
// reopen another, and require both to still be counted in the period they
// happened in.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-stories-test-"));

const { openMemory, MIGRATIONS, setMeta, setSettings } = await import("../../src/decisions/db.mjs");
const { pkg, PATHS } = await import("../../src/util/paths.mjs");
const ST = await import("../../src/decisions/stories.mjs");
const { decisionRoutes } = await import("../../src/decisions/routes.mjs");
const { routes } = await import("../../src/ui/api.mjs");

const AS_OF = "2026-09-15";

/**
 * A workspace database with the story tables, and the clock PINNED.
 *
 * ⚠️ The pin is not tidiness. `asOfFor` returns the real date unless demo mode
 * pins one, so an unpinned test would measure a seven-day window ending on
 * whatever day it was run - passing today and failing next week. db.mjs carries
 * the scar from the last time that happened.
 */
function openDb() {
  const db = openMemory();
  // Only when MIGRATIONS does not already carry it, so this file passes both
  // before the migration is wired in and after. Running it twice fails with
  // "table story already exists".
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'story'").get()) {
    db.exec(ST.STORY_MIGRATION);
  }
  setSettings(db, { demoMode: true, currency: "USD" });
  setMeta(db, "as_of", AS_OF);
  setMeta(db, "workspace_name", "Test Co");
  return db;
}

let fp = 0;
function addDecision(db, { id, account, createdDay, severity = "medium", status = "new", impact = null, title = null }) {
  db.prepare(
    `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, impact_amount, currency,
                           reasoning_source, created_at, updated_at)
     VALUES (?, ?, ?, 'churn_risk', ?, ?, ?, ?, 'USD', 'rule_only', ?, ?)`,
  ).run(
    id,
    account,
    `fp-${++fp}`,
    title ?? `Decision ${id}`,
    severity,
    status,
    impact,
    `${createdDay}T09:00:00.000Z`,
    `${createdDay}T09:00:00.000Z`,
  );
}

let ev = 0;
function addEvent(db, decisionId, day, actor, kind) {
  db.prepare("INSERT INTO decision_event (id, decision_id, at, actor, kind) VALUES (?, ?, ?, ?, ?)").run(
    `evt_${++ev}`,
    decisionId,
    `${day}T10:00:00.000Z`,
    actor,
    kind,
  );
}

/**
 * Three customers and four decisions straddling the edge of a seven-day window.
 * A 7-day story on 2026-09-15 covers 2026-09-09 to 2026-09-15 inclusive, so d4
 * on the 8th is one day outside and must never be counted.
 */
function seed() {
  const db = openDb();
  const acc = db.prepare("INSERT INTO account (id, name, arr, plan, owner, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  acc.run("a1", "Northwind", 120000, "Enterprise", "Dana", "2024-01-01");
  acc.run("a2", "Contoso", 40000, "Growth", "Ravi", "2025-02-01");
  acc.run("a3", "Fabrikam", 90000, "Enterprise", null, "2025-06-01");

  addDecision(db, { id: "d1", account: "a1", createdDay: "2026-09-10", severity: "critical", impact: 50000 });
  addDecision(db, { id: "d2", account: "a2", createdDay: "2026-09-11", severity: "high", status: "resolved" });
  addDecision(db, { id: "d3", account: "a1", createdDay: "2026-09-09", severity: "low", status: "dismissed" });
  addDecision(db, { id: "d4", account: "a3", createdDay: "2026-09-08", severity: "high" });

  addEvent(db, "d1", "2026-09-10", "system", "created");
  addEvent(db, "d2", "2026-09-12", "user", "resolved");
  addEvent(db, "d3", "2026-09-11", "user", "dismissed");
  addEvent(db, "d4", "2026-09-08", "system", "created");

  db.prepare("INSERT INTO outcome (decision_id, result, note, recorded_at, arr_after) VALUES (?, ?, ?, ?, ?)").run(
    "d2",
    "renewed",
    "signed for another year",
    "2026-09-12T10:00:00.000Z",
    45000,
  );
  return db;
}

const makeStory = (db, over = {}) =>
  ST.createStory(db, { name: "Weekly review", sections: ["opened", "closed", "changed", "movers", "outcomes"], periodDays: 7, schedule: "off", ...over });

const sectionOf = (snapshot, kind) => snapshot.sections.find((s) => s.kind === kind);
const figureOf = (section, id) => section.figures.find((f) => f.id === id);

/* ── the migration ──────────────────────────────────────────────────────── */

test("the story tables arrive as a NEW migration, leaving the shipped ones untouched", () => {
  // The module exports the SQL rather than pushing it itself, but the rule is
  // the same: a shipped entry is never edited, because an installed database
  // has already run it and would never run it again.
  // "Exactly one entry creates it, and that entry is this module's own" - not
  // "no entry mentions it", which held only while the migration was unwired and
  // correctly began failing the moment it was appended.
  const carrying = MIGRATIONS.filter((sql) => /CREATE TABLE story\b/.test(sql));
  assert.equal(carrying.length, 1, `story must be created by exactly one migration, found ${carrying.length}`);
  assert.equal(carrying[0], ST.STORY_MIGRATION, "story must come from this module's own appended migration");
  const at = MIGRATIONS.indexOf(ST.STORY_MIGRATION);
  assert.ok(at >= MIGRATIONS.length - 3, `the story migration must be appended, found at index ${at}`);
  assert.match(ST.STORY_MIGRATION, /CREATE TABLE story\b/);
  assert.match(ST.STORY_MIGRATION, /CREATE TABLE story_run\b/);
  assert.match(ST.STORY_MIGRATION, /REFERENCES story\(id\) ON DELETE CASCADE/);
});

test("a database already carrying data takes the new tables without losing any of it", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  // Only what shipped BEFORE this feature, so this stays an UPGRADE test. Once
  // STORY_MIGRATION was appended to MIGRATIONS, running the whole array and then
  // the migration again failed with "table story already exists".
  const priorTo = MIGRATIONS.indexOf(ST.STORY_MIGRATION);
  const shipped = priorTo === -1 ? MIGRATIONS : MIGRATIONS.slice(0, priorTo);
  for (const m of shipped) db.exec(m);
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('a1', 'Northwind', 1)").run();

  db.exec(ST.STORY_MIGRATION);

  assert.equal(db.prepare("SELECT COUNT(*) n FROM story").get().n, 0);
  assert.equal(db.prepare("SELECT name FROM account WHERE id = 'a1'").get().name, "Northwind");
});

/* ── the allowlist ──────────────────────────────────────────────────────── */

test("a section kind that is not in the frozen table is refused BY NAME", () => {
  const db = openDb();
  const r = ST.createStory(db, { name: "Bad", sections: ["opened", "totally_made_up"], periodDays: 7, schedule: "off" });
  assert.equal(r.ok, false);
  assert.match(r.error, /totally_made_up/, "the refusal must name what it refused, or nobody can fix it");
});

test("a section kind carrying SQL is refused, and the tables are still standing", () => {
  // The stored kind is the ONLY thing that chooses which query runs. If it could
  // reach SQL as text, a saved story would be a stored injection that fires
  // every time the schedule ticks.
  const db = seed();
  const nasty = "opened'); DROP TABLE account; --";
  const r = ST.createStory(db, { name: "Nasty", sections: [nasty], periodDays: 7, schedule: "off" });
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 3, "account must still be there");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story").get().n, 0, "nothing was stored");
});

test("a story name carrying SQL is stored as text and changes nothing", () => {
  const db = seed();
  const name = "Robert'); DROP TABLE story_run; --";
  const made = ST.createStory(db, { name, sections: ["opened"], periodDays: 7, schedule: "off" });
  assert.equal(made.ok, true);
  assert.equal(made.story.name, name);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_run").get().n, 0);
  assert.equal(ST.runStory(db, made.story.id).ok, true, "story_run must still exist to be inserted into");
});

test("the period and the schedule are checked, not clamped", () => {
  const db = openDb();
  assert.match(ST.createStory(db, { name: "A", sections: ["opened"], periodDays: 0, schedule: "off" }).error, /between 1 and 366/);
  assert.match(ST.createStory(db, { name: "A", sections: ["opened"], periodDays: 900, schedule: "off" }).error, /between 1 and 366/);
  assert.match(ST.createStory(db, { name: "A", sections: ["opened"], periodDays: 7, schedule: "hourly" }).error, /hourly/);
  assert.match(ST.createStory(db, { name: "A", sections: [], periodDays: 7, schedule: "off" }).error, /at least one section/);
  assert.match(ST.createStory(db, { name: "  ", sections: ["opened"], periodDays: 7, schedule: "off" }).error, /name/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story").get().n, 0);
});

test("two stories cannot share a name, whatever the capitals", () => {
  const db = openDb();
  assert.equal(makeStory(db).ok, true);
  const again = makeStory(db, { name: "weekly REVIEW" });
  assert.equal(again.ok, false);
  assert.match(again.error, /already a story called/);
});

/* ── the period ─────────────────────────────────────────────────────────── */

test("a 7-day story covers seven days including the as-of day, and nothing outside", () => {
  const db = seed();
  const made = makeStory(db);
  const { snapshot } = ST.runStory(db, made.story.id);
  assert.equal(snapshot.periodFrom, "2026-09-09");
  assert.equal(snapshot.periodTo, "2026-09-15");

  const opened = sectionOf(snapshot, "opened");
  assert.equal(figureOf(opened, "total").value, 3, "d1, d2 and d3 are inside; d4 on the 8th is one day outside");
  assert.deepEqual(opened.rows.map((r) => r.id).sort(), ["d1", "d2", "d3"]);
});

test("the period moves when the engine clock moves", () => {
  const db = seed();
  const made = makeStory(db, { periodDays: 30 });
  const first = ST.runStory(db, made.story.id).snapshot;
  assert.equal(first.periodTo, AS_OF);

  setMeta(db, "as_of", "2026-10-20");
  const second = ST.runStory(db, made.story.id).snapshot;
  assert.equal(second.periodTo, "2026-10-20");
  assert.equal(second.periodFrom, "2026-09-21");
  assert.equal(figureOf(sectionOf(second, "opened"), "total").value, 0, "nothing was opened in that later month");
  assert.equal(figureOf(sectionOf(first, "opened"), "total").value, 4, "and the earlier run still says what it said");
});

/* ── the sections ───────────────────────────────────────────────────────── */

test("opened counts the decisions raised, and says how many carry an impact figure", () => {
  const db = seed();
  const made = makeStory(db, { periodDays: 30 });
  const opened = sectionOf(ST.runStory(db, made.story.id).snapshot, "opened");
  assert.equal(figureOf(opened, "total").value, 4);
  assert.equal(figureOf(opened, "critical").value, 1);
  assert.equal(figureOf(opened, "high").value, 2);
  const impact = figureOf(opened, "impact");
  assert.equal(impact.value, 50000);
  assert.equal(impact.display, "$50,000");
  assert.match(impact.note, /1 of 4 carry an impact figure/, "a total over a subset must say which subset");
});

test("closed counts a DISMISSED decision, which resolved_at never records", () => {
  // `dismiss()` writes the event and does not touch resolved_at. A section
  // counted from that column would report every dismissal as never having
  // happened - silently, because zero looks like a quiet week.
  const db = seed();
  const made = makeStory(db);
  const closed = sectionOf(ST.runStory(db, made.story.id).snapshot, "closed");
  assert.equal(figureOf(closed, "total").value, 2);
  assert.equal(figureOf(closed, "resolved").value, 1);
  assert.equal(figureOf(closed, "dismissed").value, 1);
  assert.deepEqual(closed.rows.map((r) => r.id).sort(), ["d2", "d3"]);
});

test("a decision closed in the period and reopened afterwards still counts as closed then", () => {
  // This is what "the report does not rewrite its history" means at the level of
  // one row: March's closure happened in March, whatever April did next.
  const db = seed();
  db.prepare("UPDATE decision SET status = 'accepted', resolved_at = NULL WHERE id = 'd2'").run();
  const made = makeStory(db);
  const closed = sectionOf(ST.runStory(db, made.story.id).snapshot, "closed");
  assert.equal(figureOf(closed, "total").value, 2);
  assert.ok(closed.rows.some((r) => r.id === "d2"));
});

test("changed counts every event, split between the person and the system", () => {
  const db = seed();
  const made = makeStory(db);
  const changed = sectionOf(ST.runStory(db, made.story.id).snapshot, "changed");
  assert.equal(figureOf(changed, "total").value, 3, "d4's created event is outside the window");
  assert.equal(figureOf(changed, "byUser").value, 2);
  assert.equal(figureOf(changed, "bySystem").value, 1);
});

test("movers lists only the customers something actually happened to", () => {
  const db = seed();
  const made = makeStory(db);
  const movers = sectionOf(ST.runStory(db, made.story.id).snapshot, "movers");
  assert.equal(figureOf(movers, "accounts").value, 2, "Fabrikam's only decision is outside the period");
  assert.deepEqual(movers.rows.map((r) => r.id).sort(), ["a1", "a2"]);
  assert.equal(figureOf(movers, "arr").value, 160000);
  assert.equal(figureOf(movers, "opened").value, 3);
  assert.equal(figureOf(movers, "closed").value, 2);
  // Northwind first: two decisions opened plus one closed beats Contoso's two.
  assert.equal(movers.rows[0].id, "a1");
});

test("outcomes reports what was recorded, by result", () => {
  const db = seed();
  const made = makeStory(db);
  const out = sectionOf(ST.runStory(db, made.story.id).snapshot, "outcomes");
  assert.equal(figureOf(out, "total").value, 1);
  assert.equal(figureOf(out, "result_renewed").value, 1);
  assert.equal(figureOf(out, "arrAfter").value, 45000);
  assert.equal(out.rows[0].id, "d2");
});

test("an empty workspace produces empty sections, never an invented number", () => {
  const db = openDb();
  const made = makeStory(db);
  const { snapshot } = ST.runStory(db, made.story.id);
  for (const sec of snapshot.sections) {
    assert.equal(sec.rows.length, 0, `${sec.kind} must list nothing`);
    assert.equal(sec.rowsTotal, 0);
    assert.ok(sec.empty, `${sec.kind} must say why it is empty`);
    for (const f of sec.figures) assert.equal(f.value, 0, `${sec.kind}.${f.id} must be zero, not blank or invented`);
  }
});

test("a long list is truncated but the totals above it still count everything", () => {
  const db = openDb();
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('a1', 'Northwind', 1)").run();
  for (let i = 0; i < 405; i++) addDecision(db, { id: `x${i}`, account: "a1", createdDay: "2026-09-12" });
  const made = makeStory(db);
  const opened = sectionOf(ST.runStory(db, made.story.id).snapshot, "opened");
  assert.equal(figureOf(opened, "total").value, 405, "the figure counts every row in the period");
  assert.equal(opened.rows.length, 400, "the listing stops at the cap");
  assert.equal(opened.rowsShown, 400);
  assert.equal(opened.rowsTotal, 405, "and the section says so, so the list cannot lie about the total");
});

/* ── the snapshot, which is the whole point ─────────────────────────────── */

test("a stored run does not change when the data underneath it changes", () => {
  const db = seed();
  const made = makeStory(db, { periodDays: 30 });
  const first = ST.runStory(db, made.story.id);
  assert.equal(figureOf(sectionOf(first.snapshot, "opened"), "total").value, 4);

  // The world moves on: two more decisions, one of them inside the same period.
  addDecision(db, { id: "d9", account: "a1", createdDay: "2026-09-13", severity: "critical" });
  addDecision(db, { id: "d10", account: "a2", createdDay: "2026-09-14", severity: "high" });

  const read = ST.getRun(db, first.run.id);
  assert.equal(read.ok, true);
  assert.equal(
    figureOf(sectionOf(read.snapshot, "opened"), "total").value,
    4,
    "the stored run must still say 4 - a report that re-derives itself is worthless",
  );
  assert.deepEqual(sectionOf(read.snapshot, "opened").rows.map((r) => r.id).sort(), ["d1", "d2", "d3", "d4"]);

  // And a fresh run does see them, so this is storage, not staleness.
  const second = ST.runStory(db, made.story.id);
  assert.equal(figureOf(sectionOf(second.snapshot, "opened"), "total").value, 6);
});

test("a stored run survives the decisions it counted being deleted", () => {
  const db = seed();
  const made = makeStory(db, { periodDays: 30 });
  const first = ST.runStory(db, made.story.id);
  db.prepare("DELETE FROM decision").run();
  const read = ST.getRun(db, first.run.id);
  assert.equal(figureOf(sectionOf(read.snapshot, "opened"), "total").value, 4);
  assert.equal(sectionOf(read.snapshot, "opened").rows.length, 4);
});

test("editing a story changes the next run and not one that already happened", () => {
  const db = seed();
  const made = makeStory(db, { periodDays: 30 });
  const before = ST.runStory(db, made.story.id).run.id;

  const edit = ST.updateStory(db, made.story.id, { sections: ["outcomes"], periodDays: 7 });
  assert.equal(edit.ok, true);

  const old = ST.getRun(db, before).snapshot;
  assert.equal(old.periodDays, 30);
  assert.deepEqual(old.sections.map((s) => s.kind), ["opened", "closed", "changed", "movers", "outcomes"]);

  const next = ST.runStory(db, made.story.id).snapshot;
  assert.equal(next.periodDays, 7);
  assert.deepEqual(next.sections.map((s) => s.kind), ["outcomes"]);
});

test("every run is stamped with the ENGINE clock, so demo mode dates it honestly", () => {
  const db = seed();
  const made = makeStory(db);
  const { snapshot } = ST.runStory(db, made.story.id);
  assert.equal(snapshot.asOf, AS_OF);
  assert.equal(snapshot.trigger, "manual");
  assert.equal(snapshot.currency, "USD");
  assert.equal(snapshot.workspaceName, "Test Co");

  // 🔴 THIS DATE IS THE WHOLE TEST, AND THE FIRST VERSION HAD IT WRONG.
  // Checking the stamp against AS_OF proved nothing, because AS_OF was the real
  // date on the day this was written: swapping `nowIso(db)` for
  // `new Date().toISOString()` broke the guarantee and every assertion still
  // passed. 2024-03-04 is a day the wall clock cannot be, so only the pinned
  // engine clock can produce it. db.mjs carries the same scar.
  setMeta(db, "as_of", "2024-03-04");
  const later = ST.runStory(db, made.story.id).snapshot;
  assert.ok(later.generatedAt.startsWith("2024-03-04"), `expected the pinned day, saw ${later.generatedAt}`);
  // The readable form is frozen with the rest of it, so the screen and the
  // exported file cannot print two different times for one run.
  assert.match(later.generatedLabel, /^4 Mar 2024, \d\d:\d\d$/);
  const stored = db.prepare("SELECT at FROM story_run ORDER BY at ASC LIMIT 1").get().at;
  assert.ok(stored.startsWith("2024-03-04"), `the story_run row is stamped too, saw ${stored}`);
});

test("every section names the records it counted", () => {
  const db = seed();
  const made = makeStory(db);
  const { snapshot } = ST.runStory(db, made.story.id);
  for (const sec of snapshot.sections) {
    assert.ok(sec.basis && sec.basis.length > 10, `${sec.kind} must say which rows and which date column it counted`);
  }
});

test("history lists the runs newest first, and reading one never rebuilds it", () => {
  const db = seed();
  const made = makeStory(db, { periodDays: 30 });
  const r1 = ST.runStory(db, made.story.id).run.id;
  setMeta(db, "as_of", "2026-09-16");
  const r2 = ST.runStory(db, made.story.id).run.id;

  const hist = ST.listRuns(db, made.story.id);
  assert.equal(hist.ok, true);
  assert.deepEqual(hist.runs.map((r) => r.id), [r2, r1]);
  assert.equal(hist.runs[0].periodTo, "2026-09-16");
  assert.equal(ST.getRun(db, r1).snapshot.periodTo, AS_OF);
});

test("an unreadable stored run says so instead of being rebuilt from today's data", () => {
  const db = seed();
  const made = makeStory(db);
  const run = ST.runStory(db, made.story.id).run.id;
  db.prepare("UPDATE story_run SET snapshot_json = 'not json' WHERE id = ?").run(run);
  const read = ST.getRun(db, run);
  assert.equal(read.ok, false);
  assert.match(read.error, /unreadably/);
});

test("deleting a story takes its stored runs with it, and says how many", () => {
  const db = seed();
  const made = makeStory(db);
  ST.runStory(db, made.story.id);
  ST.runStory(db, made.story.id);
  const gone = ST.deleteStory(db, made.story.id);
  assert.equal(gone.ok, true);
  assert.equal(gone.runsDeleted, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_run").get().n, 0);
  assert.equal(ST.getRun(db, "srn_nope").ok, false);
});

/* ── the schedule ───────────────────────────────────────────────────────── */

test("the weekly tick runs a story that has never run, and only once", () => {
  const db = seed();
  const made = makeStory(db, { schedule: "weekly" });
  assert.deepEqual(ST.tick(db), { ran: 1, failed: 0 });
  assert.deepEqual(ST.tick(db), { ran: 0, failed: 0 }, "a story that just ran is not due again");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_run").get().n, 1);
  assert.equal(db.prepare("SELECT trigger FROM story_run").get().trigger, "schedule");
});

test("the weekly tick waits seven days, measured on the engine clock", () => {
  const db = seed();
  const made = makeStory(db, { schedule: "weekly" });
  ST.tick(db);

  setMeta(db, "as_of", "2026-09-21"); // six days later
  assert.deepEqual(ST.tick(db), { ran: 0, failed: 0 });

  setMeta(db, "as_of", "2026-09-22"); // the seventh
  assert.deepEqual(ST.tick(db), { ran: 1, failed: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_run").get().n, 2);
});

test("a story that is not marked weekly is never run by the tick", () => {
  const db = seed();
  makeStory(db, { schedule: "off" });
  assert.deepEqual(ST.tick(db), { ran: 0, failed: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_run").get().n, 0);
});

test("the schedule can be turned on and off without touching the runs", () => {
  const db = seed();
  const made = makeStory(db, { schedule: "off" });
  ST.runStory(db, made.story.id);
  assert.equal(ST.updateStory(db, made.story.id, { schedule: "weekly" }).story.schedule, "weekly");
  assert.equal(ST.updateStory(db, made.story.id, { schedule: "off" }).story.schedule, "off");
  assert.deepEqual(ST.tick(db), { ran: 0, failed: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM story_run").get().n, 1);
});

test("the tick is silent on a database that predates the story tables", () => {
  // The background pass runs in a loop where a throw is only ever seen in a log
  // line, so it must no-op rather than explode on an un-migrated workspace.
  const db = openMemory();
  assert.deepEqual(ST.tick(db), { ran: 0, failed: 0 });
});

test("the listing says which weekly stories are due and when each last ran", () => {
  const db = seed();
  const weekly = makeStory(db, { name: "Weekly", schedule: "weekly" });
  makeStory(db, { name: "Manual", schedule: "off" });

  let list = ST.listStories(db, { asOf: AS_OF });
  assert.equal(list.find((s) => s.name === "Weekly").due, true, "never run, so due now");
  assert.equal(list.find((s) => s.name === "Manual").due, false);

  ST.runStory(db, weekly.story.id);
  list = ST.listStories(db, { asOf: AS_OF });
  const w = list.find((s) => s.name === "Weekly");
  assert.equal(w.due, false);
  assert.equal(w.runs, 1);
  assert.equal(w.sinceDays, 0);
  assert.equal(w.lastRun.as_of, AS_OF);
});

/* ── the export ─────────────────────────────────────────────────────────── */

test("the exported HTML is self-contained: it loads nothing from anywhere", () => {
  // This file is opened on the machine it was written on, with no internet, and
  // often after being e-mailed somewhere else. A stylesheet link or a web font
  // would make it render differently - or not at all - for the person it is for.
  const db = seed();
  const made = makeStory(db);
  const html = ST.renderStoryHtml(ST.runStory(db, made.story.id).snapshot);
  assert.ok(!/<script/i.test(html), "no script");
  assert.ok(!/<link\b/i.test(html), "no stylesheet link");
  assert.ok(!/<img\b/i.test(html), "no image");
  assert.ok(!/\bsrc\s*=/i.test(html), "nothing is fetched");
  assert.ok(!/https?:\/\//i.test(html), "no URL of any kind");
  assert.match(html, /@media print/, "the whole point is that it prints");
  assert.match(html, /@page/);
});

test("the export prints one section per block and says how to make the PDF", () => {
  const db = seed();
  const made = makeStory(db);
  const html = ST.renderStoryHtml(ST.runStory(db, made.story.id).snapshot);
  assert.match(html, /break-inside: avoid/, "a section split across two pages is unreadable");
  assert.match(html, /Save as PDF/, "the UI claim that this prints to PDF must be in the file too");
  assert.match(html, /Weekly review/);
  assert.match(html, /Northwind/);
  assert.match(html, /Decisions opened/);
  // Dates a person reads, not the ISO stamps the columns hold.
  assert.match(html, /15 Sep 2026, \d\d:\d\d/);
  assert.ok(!/T\d\d:\d\d:\d\d\.\d\d\dZ/.test(html), "no raw ISO timestamp should reach a printed report");
  assert.match(html, />Critical</, "severity is capitalised for a reader");
});

test("a hostile customer name reaches the export as text, never as markup", () => {
  const db = seed();
  db.prepare("UPDATE account SET name = ? WHERE id = 'a1'").run('<script>alert("x")</script> & Co');
  const made = makeStory(db);
  const html = ST.renderStoryHtml(ST.runStory(db, made.story.id).snapshot);
  assert.ok(!/<script>alert/.test(html), "the tag must not survive as a tag");
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; Co/);
});

test("the export renders the STORED run, so an old report exports what it said", () => {
  const db = seed();
  const made = makeStory(db, { periodDays: 30 });
  const first = ST.runStory(db, made.story.id);
  addDecision(db, { id: "d9", account: "a1", createdDay: "2026-09-13", title: "Raised after the report" });

  const html = ST.renderStoryHtml(ST.getRun(db, first.run.id).snapshot);
  assert.ok(!/Raised after the report/.test(html), "a later decision must not appear in an earlier report");
});

test("exportRun writes a real file, named after the story and the period", () => {
  const db = seed();
  const made = makeStory(db);
  const run = ST.runStory(db, made.story.id).run.id;
  const r = ST.exportRun(db, run);
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(r.file), `expected a file at ${r.file}`);
  assert.equal(path.dirname(r.file), path.join(PATHS.downloads, "vireo-stories"));
  assert.match(path.basename(r.file), /^weekly-review-2026-09-15-srn_[0-9a-f]+\.html$/);
  const onDisk = fs.readFileSync(r.file, "utf8");
  // Bytes, not characters: the report is full of em dashes and currency signs.
  assert.equal(Buffer.byteLength(onDisk, "utf8"), r.bytes);
  assert.match(onDisk, /^<!doctype html>/);
});

test("a story name that is a path does not become a path", () => {
  const db = seed();
  const made = makeStory(db, { name: "../../../etc/passwd" });
  const run = ST.runStory(db, made.story.id).run.id;
  const r = ST.exportRun(db, run);
  assert.equal(r.ok, true);
  assert.equal(path.dirname(r.file), path.join(PATHS.downloads, "vireo-stories"), "the file must stay in its folder");
  assert.match(path.basename(r.file), /^etc-passwd-/);
});

test("exporting a run that does not exist says so instead of writing an empty file", () => {
  const db = seed();
  const r = ST.exportRun(db, "srn_nothing");
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist/);
});

/* ── the routes ─────────────────────────────────────────────────────────── */

test("every story route is namespaced, so the merged dispatcher cannot collide", () => {
  const names = Object.keys(ST.storyRoutes);
  assert.ok(names.length >= 8, `expected the full set, saw ${names.length}`);
  for (const name of names) assert.match(name, /^decisions[A-Z]/, `${name} should start with "decisions"`);
});

test("no story route name is already taken by either existing table", () => {
  // Merged into decisionRoutes, and NOT colliding with the chat app's table.
  // The original check treated any presence in decisionRoutes as a clash, which
  // only held while this module was unwired.
  const clash = Object.keys(ST.storyRoutes).filter((k) => Object.hasOwn(routes, k));
  assert.deepEqual(clash, [], `these names collide with src/ui/api.mjs: ${clash.join(", ")}`);
  for (const k of Object.keys(ST.storyRoutes)) {
    assert.ok(Object.hasOwn(decisionRoutes, k), `${k} is not merged into src/decisions/routes.mjs`);
    assert.equal(decisionRoutes[k], ST.storyRoutes[k], `${k} is shadowed by another definition`);
  }
});

test("every route the Stories page calls exists once the table is merged in", () => {
  // The same check tests/unit/v2-ui.test.mjs makes, run against the merged table
  // this feature produces. Until the orchestrator merges storyRoutes into
  // decisionRoutes that file cannot see these names, and this is the evidence
  // that wiring is the only thing missing.
  const page = pkg("src", "ui", "public", "v2", "pages", "stories.js");
  if (!fs.existsSync(page)) return;
  const js = fs.readFileSync(page, "utf8");
  const merged = { ...routes, ...decisionRoutes, ...ST.storyRoutes };
  const called = [...js.matchAll(/\bapi\(\s*["']([A-Za-z][A-Za-z0-9]*)["']/g)].map((m) => m[1]);
  assert.ok(called.length >= 6, `expected the page to call the story routes, saw ${called.length}`);
  for (const name of called) assert.ok(Object.hasOwn(merged, name), `stories.js calls /x/${name}, which nothing defines`);
});

test("the routes guard the ids the page must send", async () => {
  assert.equal((await ST.storyRoutes.decisionsStoryUpdate({ body: {} })).error, "which story?");
  assert.equal((await ST.storyRoutes.decisionsStoryDelete({ body: {} })).error, "which story?");
  assert.equal((await ST.storyRoutes.decisionsStoryRun({ body: {} })).error, "which story?");
  assert.equal((await ST.storyRoutes.decisionsStoryHistory({ query: {} })).error, "which story?");
  assert.equal((await ST.storyRoutes.decisionsStorySnapshot({ query: {} })).error, "which story run?");
  assert.equal((await ST.storyRoutes.decisionsStoryExport({ body: {} })).error, "which story run?");
});

test("with no workspace the routes say so in the way the shell understands", async () => {
  const r = await ST.storyRoutes.decisionsStories();
  assert.equal(r.ok, false);
  assert.equal(r.needsWorkspace, true, "the shell checks this exact key to show its onboarding");
});

/* ── the page ───────────────────────────────────────────────────────────── */

test("the Stories page keeps the rules every v2 page is held to", () => {
  const page = pkg("src", "ui", "public", "v2", "pages", "stories.js");
  if (!fs.existsSync(page)) return;
  const js = fs.readFileSync(page, "utf8");
  assert.match(js, /export\s+(async\s+)?function\s+render\b/, "the shell calls render(root, ctx) by name");
  assert.match(js, /export const title/);
  for (const banned of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
    const code = js.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.ok(!code.includes(banned), `${banned} must never appear: customer names pass through this page`);
  }
});
