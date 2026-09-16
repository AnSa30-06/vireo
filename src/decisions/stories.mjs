// Stories: a saved report over the workspace that can be run again, and that
// never rewrites its own past.
//
// WHY THIS EXISTS IN THIS SHAPE
//
// The competitor meters "Stories per month", "weekly scheduled Stories" and
// "PDF export" and documents none of the three, so there is no implementation
// to copy and no point pretending otherwise. What is left is the honest version
// of the idea, and the honest version turns on one property:
//
// 🔴 A RUN IS A SNAPSHOT, AND A SNAPSHOT IS NEVER RECOMPUTED. `runStory` works
// the numbers out once, stores the finished report as JSON, and every later read
// returns those stored bytes verbatim. Reading last month's story does not touch
// the decision table at all. A report that quietly re-derives itself tells you a
// different story each time you open it, which is worthless for exactly the
// reason this product exists: you cannot be accountable to a number that moves
// after you acted on it.
//
// Two consequences worth stating, because both look like bugs otherwise:
//   * A decision resolved in March and REOPENED in April still counts as closed
//     in March's story. That is correct - it is what happened in March.
//   * Editing a story's sections changes what the NEXT run says. It does not
//     touch a run that has already happened.
//
// WHERE THE NUMBERS COME FROM. Every figure in a section is produced by a SQL
// aggregate over the period, and the records behind it are stored in the same
// section. Nothing is estimated, nothing is carried over from a previous run and
// nothing is invented when a table is empty: an empty section says it is empty.
//
// WHAT IS NOT MEASURED HERE, so nobody reads a silence as a zero:
//   * Usage. `metric_daily` holds usage, but a movement in it is a signal, and
//     signals belong to an analysis run. A story reports on decisions, their
//     events and their outcomes.
//   * Anything a model wrote. There is no model call in this file. A story is
//     arithmetic over records, offline, always.
//
// SQL SAFETY. Every value is bound with `?`. The only thing that selects SQL is
// the section KIND, which is looked up in a frozen table defined in this file -
// a kind that is not a key of `BY_KIND` is refused by name, never interpolated.
import fs from "node:fs";
import path from "node:path";
import { getSettings, nowIso } from "./db.mjs";
import { asOfFor } from "./run.mjs";
import { addDays, daysBetween, humanDate, money } from "./format.mjs";
import { OUTCOMES, STATUS_LABELS } from "./decisions.mjs";
import { id as newId } from "./ids.mjs";
import * as workspace from "./workspace.mjs";
import { PATHS } from "../util/paths.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/stories");

/**
 * The migration for this feature.
 *
 * 🔴 APPEND IT, NEVER EDIT ONE THAT HAS SHIPPED. `MIGRATIONS` in db.mjs is an
 * ordered array whose length IS the schema version, so pushing this string onto
 * the end is the whole of the change: an installed database at version 2 runs
 * only this entry on its next open, and a fresh install runs it last. Editing an
 * existing entry would change what a fresh install gets and change nothing for
 * an installed one, and the two would diverge silently until a query hit the
 * missing table.
 *
 * `sections_json` holds an array of section KIND IDS - never SQL, never a
 * column name. The kinds are resolved against the frozen table in this file, so
 * a stored story can only ever reach the queries written here.
 *
 * `snapshot_json` is the finished report. It is deliberately the whole thing and
 * not a set of pointers: a story that stored ids would have to re-read the rows
 * to show itself, and a re-read is exactly how a report starts disagreeing with
 * what it said last month.
 *
 * There is no `last_run_at` column on `story`. The last run is a fact about the
 * run table and is read from it, so the two can never disagree.
 */
// ⚠️ THE SQL LIVES IN A HOISTED FUNCTION, and that is load-bearing.
// db.mjs imports this module to build MIGRATIONS, and this module imports
// db.mjs back - a cycle. When THIS file is the entry point, db.mjs's body runs
// first, while this file's body has not. A `const` read at that moment is in the
// temporal dead zone and throws "Cannot access ... before initialization" at
// import time. A function DECLARATION is hoisted and already callable.
// Measured both ways before choosing this. Do not inline it back into the const.
export function storyMigrationSql() {
  return `
  CREATE TABLE story (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    sections_json TEXT NOT NULL,
    period_days INTEGER NOT NULL,
    schedule TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE story_run (
    id TEXT PRIMARY KEY,
    story_id TEXT NOT NULL REFERENCES story(id) ON DELETE CASCADE,
    at TEXT NOT NULL,
    as_of TEXT NOT NULL,
    period_from TEXT NOT NULL,
    period_to TEXT NOT NULL,
    trigger TEXT NOT NULL,
    snapshot_json TEXT NOT NULL
  );
  CREATE INDEX story_run_story ON story_run(story_id, at);
`;
}

/** The same string, for callers that want it as a value rather than a call. */
export const STORY_MIGRATION = storyMigrationSql();

/** Ids for the two new tables, using the shared prefix helper. */
const storyId = () => newId("sty");
const storyRunId = () => newId("srn");

/* ══ LIMITS ════════════════════════════════════════════════════════════════ */

const MAX_NAME_CHARS = 80;
const MIN_PERIOD_DAYS = 1;
const MAX_PERIOD_DAYS = 366;

/**
 * How many records a section stores.
 *
 * ⚠️ THE FIGURES ARE NOT CAPPED - only the listing is. Every total comes from a
 * `COUNT`/`SUM` over the whole period, so a truncated section still adds up. The
 * section says `rowsShown` of `rowsTotal` whenever it has withheld anything,
 * because a list that silently stops at 400 is a list that lies about the total
 * printed above it.
 */
const ROW_CAP = 400;

/** The days a story may cover. Offered by the page; enforced here regardless. */
export const PERIOD_CHOICES = [7, 14, 30, 90];

/** A story runs on demand, or once a week. Nothing else is a schedule. */
export const SCHEDULES = ["off", "weekly"];

/** A weekly story is due when its last run was this many days ago or more. */
export const WEEKLY_DAYS = 7;

/* ══ THE SECTIONS ══════════════════════════════════════════════════════════
 *
 * Each kind is one query over the period plus one aggregate. `basis` is the
 * sentence printed under the numbers, and it names the TABLE and the DATE COLUMN
 * the section counted - so a reader who disagrees with a figure knows exactly
 * which rows to go and look at.
 */

const day = (col) => `SUBSTR(${col}, 1, 10)`;

const figure = (id, label, value, display, note = null) => ({ id, label, value, display, note });

/** Severity as a reader sees it. The column stores it lower case. */
const SEVERITY_LABELS = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const severityLabel = (s) => SEVERITY_LABELS[s] ?? String(s ?? "");

/** "15 Sep 2026, 10:02" - a stamp a person can read, from an ISO one. */
function stamp(iso) {
  const time = String(iso ?? "").slice(11, 16);
  return /^\d\d:\d\d$/.test(time) ? `${humanDate(iso)}, ${time}` : humanDate(iso);
}

const countRow = (db, sql, ...args) => db.prepare(sql).get(...args) ?? {};

/** Decisions whose `created_at` day falls inside the period. */
function openedSection(db, ctx) {
  const { from, to, currency } = ctx;
  const agg = countRow(
    db,
    `SELECT COUNT(*) n,
            SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END) critical,
            SUM(CASE WHEN severity = 'high' THEN 1 ELSE 0 END) high,
            SUM(CASE WHEN impact_amount IS NOT NULL THEN 1 ELSE 0 END) withImpact,
            SUM(CASE WHEN impact_amount IS NOT NULL THEN impact_amount ELSE 0 END) impact
       FROM decision
      WHERE ${day("created_at")} >= ? AND ${day("created_at")} <= ?`,
    from,
    to,
  );
  const total = Number(agg.n) || 0;
  const withImpact = Number(agg.withImpact) || 0;
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.severity, d.status, d.impact_amount, d.created_at, a.name accountName
         FROM decision d LEFT JOIN account a ON a.id = d.account_id
        WHERE ${day("d.created_at")} >= ? AND ${day("d.created_at")} <= ?
        ORDER BY d.created_at DESC LIMIT ?`,
    )
    .all(from, to, ROW_CAP);

  return {
    figures: [
      figure("total", "Opened", total, String(total)),
      figure("critical", "Critical", Number(agg.critical) || 0, String(Number(agg.critical) || 0)),
      figure("high", "High", Number(agg.high) || 0, String(Number(agg.high) || 0)),
      figure(
        "impact",
        "Impact named",
        Number(agg.impact) || 0,
        money(Number(agg.impact) || 0, currency),
        withImpact === total
          ? `every one of the ${total} carries an impact figure`
          : `${withImpact} of ${total} carry an impact figure; the rest are not counted in this total`,
      ),
    ],
    columns: [
      { key: "date", label: "Opened" },
      { key: "account", label: "Customer" },
      { key: "title", label: "Decision" },
      { key: "severity", label: "Severity" },
      { key: "status", label: "Status now" },
      { key: "impact", label: "Impact", numeric: true },
    ],
    link: "decision",
    rowsTotal: total,
    rows: rows.map((r) => ({
      id: r.id,
      cells: [
        humanDate(r.created_at),
        r.accountName ?? "Company-wide",
        r.title,
        severityLabel(r.severity),
        STATUS_LABELS[r.status] ?? r.status,
        r.impact_amount == null ? "—" : money(r.impact_amount, currency),
      ],
    })),
    empty: "No decision was opened in this period.",
  };
}

/**
 * Decisions closed in the period, read from the EVENT log rather than from the
 * decision row.
 *
 * ⚠️ `decision.resolved_at` would have been the obvious column and it is the
 * wrong one. `dismiss()` never sets it - only `resolve()` does - so a period
 * counted from that column would report every dismissal as having never
 * happened. `reopen()` also clears it, which would delete a closure from the
 * past. The event log is append-only, carries both kinds, and is what actually
 * happened.
 */
function closedSection(db, ctx) {
  const { from, to, currency } = ctx;
  const agg = countRow(
    db,
    `SELECT COUNT(*) n,
            SUM(CASE WHEN kind = 'resolved' THEN 1 ELSE 0 END) resolved,
            SUM(CASE WHEN kind = 'dismissed' THEN 1 ELSE 0 END) dismissed
       FROM decision_event
      WHERE kind IN ('resolved', 'dismissed') AND ${day("at")} >= ? AND ${day("at")} <= ?`,
    from,
    to,
  );
  const total = Number(agg.n) || 0;
  const rows = db
    .prepare(
      `SELECT e.id, e.at, e.kind, e.decision_id, d.title, d.impact_amount, a.name accountName
         FROM decision_event e
         JOIN decision d ON d.id = e.decision_id
         LEFT JOIN account a ON a.id = d.account_id
        WHERE e.kind IN ('resolved', 'dismissed') AND ${day("e.at")} >= ? AND ${day("e.at")} <= ?
        ORDER BY e.at DESC LIMIT ?`,
    )
    .all(from, to, ROW_CAP);

  return {
    figures: [
      figure("total", "Closed", total, String(total)),
      figure("resolved", "Resolved", Number(agg.resolved) || 0, String(Number(agg.resolved) || 0)),
      figure("dismissed", "Dismissed", Number(agg.dismissed) || 0, String(Number(agg.dismissed) || 0)),
    ],
    columns: [
      { key: "date", label: "Closed" },
      { key: "how", label: "How" },
      { key: "account", label: "Customer" },
      { key: "title", label: "Decision" },
      { key: "impact", label: "Impact", numeric: true },
    ],
    link: "decision",
    rowsTotal: total,
    rows: rows.map((r) => ({
      id: r.decision_id,
      cells: [
        humanDate(r.at),
        r.kind === "resolved" ? "Resolved" : "Dismissed",
        r.accountName ?? "Company-wide",
        r.title,
        r.impact_amount == null ? "—" : money(r.impact_amount, currency),
      ],
    })),
    empty: "No decision was resolved or dismissed in this period.",
  };
}

/** Labels for the event kinds the log actually writes. */
const EVENT_LABELS = {
  created: "Raised by an analysis run",
  status: "Status changed",
  owner: "Owner changed",
  due: "Due date changed",
  note: "Note added",
  snoozed: "Snoozed",
  unsnoozed: "Snooze ran out",
  reminder: "Reminder",
  dismissed: "Dismissed",
  resolved: "Resolved",
  outcome: "Outcome recorded",
  action_prepared: "Action prepared",
};

/** Everything that happened to a decision in the period, by kind and by actor. */
function changedSection(db, ctx) {
  const { from, to } = ctx;
  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) n,
              SUM(CASE WHEN actor = 'user' THEN 1 ELSE 0 END) byUser
         FROM decision_event
        WHERE ${day("at")} >= ? AND ${day("at")} <= ?
        GROUP BY kind ORDER BY n DESC, kind`,
    )
    .all(from, to);
  const total = byKind.reduce((t, r) => t + (Number(r.n) || 0), 0);
  const byUser = byKind.reduce((t, r) => t + (Number(r.byUser) || 0), 0);
  const rows = db
    .prepare(
      `SELECT e.id, e.at, e.actor, e.kind, e.decision_id, d.title, a.name accountName
         FROM decision_event e
         JOIN decision d ON d.id = e.decision_id
         LEFT JOIN account a ON a.id = d.account_id
        WHERE ${day("e.at")} >= ? AND ${day("e.at")} <= ?
        ORDER BY e.at DESC LIMIT ?`,
    )
    .all(from, to, ROW_CAP);

  return {
    figures: [
      figure("total", "Changes", total, String(total)),
      figure("byUser", "By a person", byUser, String(byUser)),
      figure("bySystem", "By the system", total - byUser, String(total - byUser)),
      ...byKind.slice(0, 4).map((r) => figure(`kind_${r.kind}`, EVENT_LABELS[r.kind] ?? r.kind, Number(r.n) || 0, String(r.n))),
    ],
    columns: [
      { key: "date", label: "When" },
      { key: "what", label: "What" },
      { key: "who", label: "Who" },
      { key: "account", label: "Customer" },
      { key: "title", label: "Decision" },
    ],
    link: "decision",
    rowsTotal: total,
    rows: rows.map((r) => ({
      id: r.decision_id,
      cells: [
        humanDate(r.at),
        EVENT_LABELS[r.kind] ?? r.kind,
        r.actor === "user" ? "A person" : "The system",
        r.accountName ?? "Company-wide",
        r.title,
      ],
    })),
    empty: "Nothing changed on any decision in this period.",
  };
}

/**
 * Customers with decision activity in the period.
 *
 * "Moved" means a decision about them opened or closed - a fact with a record
 * behind it and a date on it. It deliberately does NOT mean a usage movement:
 * that lives in `metric_daily`, reading it is what an analysis run is for, and a
 * story inventing its own thresholds would be a second opinion competing with
 * the engine's.
 */
function moversSection(db, ctx) {
  const { from, to, currency } = ctx;
  const sql = `
    SELECT id, name, arr, owner, opened, closed FROM (
      SELECT a.id, a.name, a.arr, a.owner,
             (SELECT COUNT(*) FROM decision d
               WHERE d.account_id = a.id AND ${day("d.created_at")} >= ? AND ${day("d.created_at")} <= ?) opened,
             (SELECT COUNT(*) FROM decision_event e JOIN decision d2 ON d2.id = e.decision_id
               WHERE d2.account_id = a.id AND e.kind IN ('resolved', 'dismissed')
                 AND ${day("e.at")} >= ? AND ${day("e.at")} <= ?) closed
        FROM account a
    ) WHERE opened > 0 OR closed > 0
      ORDER BY (opened + closed) DESC, arr DESC, name`;
  const all = db.prepare(sql).all(from, to, from, to);
  const arr = all.reduce((t, r) => t + (Number.isFinite(Number(r.arr)) ? Number(r.arr) : 0), 0);

  return {
    figures: [
      figure("accounts", "Customers", all.length, String(all.length)),
      figure(
        "arr",
        "Their ARR",
        arr,
        money(arr, currency),
        "the ARR on record when this run happened, not a change over the period",
      ),
      figure("opened", "Decisions opened", all.reduce((t, r) => t + r.opened, 0), String(all.reduce((t, r) => t + r.opened, 0))),
      figure("closed", "Decisions closed", all.reduce((t, r) => t + r.closed, 0), String(all.reduce((t, r) => t + r.closed, 0))),
    ],
    columns: [
      { key: "name", label: "Customer" },
      { key: "owner", label: "Owner" },
      { key: "opened", label: "Opened", numeric: true },
      { key: "closed", label: "Closed", numeric: true },
      { key: "arr", label: "ARR", numeric: true },
    ],
    link: "customer",
    rowsTotal: all.length,
    rows: all.slice(0, ROW_CAP).map((r) => ({
      id: r.id,
      cells: [r.name, r.owner ?? "—", String(r.opened), String(r.closed), money(r.arr, currency)],
    })),
    empty: "No customer had a decision opened or closed in this period.",
  };
}

/** Outcomes recorded in the period - the only place this product scores itself. */
function outcomesSection(db, ctx) {
  const { from, to, currency } = ctx;
  const byResult = db
    .prepare(
      `SELECT result, COUNT(*) n FROM outcome
        WHERE ${day("recorded_at")} >= ? AND ${day("recorded_at")} <= ?
        GROUP BY result ORDER BY n DESC, result`,
    )
    .all(from, to);
  const total = byResult.reduce((t, r) => t + (Number(r.n) || 0), 0);
  const arrAgg = countRow(
    db,
    `SELECT SUM(CASE WHEN arr_after IS NOT NULL THEN arr_after ELSE 0 END) arr,
            SUM(CASE WHEN arr_after IS NOT NULL THEN 1 ELSE 0 END) withArr
       FROM outcome WHERE ${day("recorded_at")} >= ? AND ${day("recorded_at")} <= ?`,
    from,
    to,
  );
  const withArr = Number(arrAgg.withArr) || 0;
  const rows = db
    .prepare(
      `SELECT o.decision_id, o.result, o.note, o.recorded_at, o.arr_after, d.title, a.name accountName
         FROM outcome o
         JOIN decision d ON d.id = o.decision_id
         LEFT JOIN account a ON a.id = d.account_id
        WHERE ${day("o.recorded_at")} >= ? AND ${day("o.recorded_at")} <= ?
        ORDER BY o.recorded_at DESC LIMIT ?`,
    )
    .all(from, to, ROW_CAP);

  return {
    figures: [
      figure("total", "Outcomes recorded", total, String(total)),
      ...byResult.map((r) => figure(`result_${r.result}`, OUTCOMES[r.result] ?? r.result, Number(r.n) || 0, String(r.n))),
      figure(
        "arrAfter",
        "ARR after",
        Number(arrAgg.arr) || 0,
        money(Number(arrAgg.arr) || 0, currency),
        withArr === total
          ? `every one of the ${total} recorded an ARR figure`
          : `${withArr} of ${total} recorded an ARR figure; the rest are not counted in this total`,
      ),
    ],
    columns: [
      { key: "date", label: "Recorded" },
      { key: "result", label: "Result" },
      { key: "account", label: "Customer" },
      { key: "title", label: "Decision" },
      { key: "arr", label: "ARR after", numeric: true },
      { key: "note", label: "Note" },
    ],
    link: "decision",
    rowsTotal: total,
    rows: rows.map((r) => ({
      id: r.decision_id,
      cells: [
        humanDate(r.recorded_at),
        OUTCOMES[r.result] ?? r.result,
        r.accountName ?? "Company-wide",
        r.title,
        r.arr_after == null ? "—" : money(r.arr_after, currency),
        r.note ?? "",
      ],
    })),
    empty: "No outcome was recorded in this period.",
  };
}

/**
 * The frozen section table. A story stores KIND IDS and nothing else, so this
 * object is the only thing that can decide which SQL runs.
 */
const SECTION_TABLE = [
  {
    kind: "opened",
    label: "Decisions opened",
    basis: "decision rows whose created_at day falls inside the period",
    compute: openedSection,
  },
  {
    kind: "closed",
    label: "Decisions closed",
    basis: "decision_event rows of kind resolved or dismissed, dated inside the period",
    compute: closedSection,
  },
  {
    kind: "changed",
    label: "What changed",
    basis: "every decision_event row dated inside the period",
    compute: changedSection,
  },
  {
    kind: "movers",
    label: "Customers that moved",
    basis: "accounts with at least one decision opened or closed inside the period",
    compute: moversSection,
  },
  {
    kind: "outcomes",
    label: "Outcomes recorded",
    basis: "outcome rows whose recorded_at day falls inside the period",
    compute: outcomesSection,
  },
];

const BY_KIND = new Map(SECTION_TABLE.map((s) => [s.kind, s]));

/**
 * What the page offers, without the functions behind it.
 *
 * It is called `sectionKinds` and not `sections` on purpose: a story has its own
 * `sections` array, and the same word meaning "the menu" in one place and "what
 * this story picked" in another is a trip hazard for whoever reads the payload
 * next.
 */
export function sectionVocabulary() {
  return {
    sectionKinds: SECTION_TABLE.map(({ kind, label, basis }) => ({ kind, label, basis })),
    periods: PERIOD_CHOICES,
  };
}

/** Every section, in the order the table declares - so two stories read alike. */
const DEFAULT_SECTIONS = SECTION_TABLE.map((s) => s.kind);

/* ══ THE STORE ═════════════════════════════════════════════════════════════ */

function rowToStory(row) {
  let sections = [];
  try {
    const parsed = JSON.parse(row.sections_json);
    if (Array.isArray(parsed)) sections = parsed.filter((k) => typeof k === "string");
  } catch {
    // A sections blob that will not parse is a broken story, not a broken page.
    // It comes back with no sections and the caller reports that it has none.
    log.warn("story sections could not be parsed", { id: row.id });
  }
  return {
    id: row.id,
    name: row.name,
    sections,
    periodDays: Number(row.period_days),
    schedule: row.schedule,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getStory(db, id) {
  const row = db.prepare("SELECT * FROM story WHERE id = ?").get(String(id ?? ""));
  return row ? rowToStory(row) : null;
}

/** The newest run of a story, without its snapshot body. */
function lastRunOf(db, storyIdValue) {
  return (
    db
      .prepare("SELECT id, at, as_of, period_from, period_to, trigger FROM story_run WHERE story_id = ? ORDER BY at DESC LIMIT 1")
      .get(storyIdValue) ?? null
  );
}

/**
 * Every saved story, with what the page needs to decide what to show: how many
 * times it has run, when it last ran, and - for a weekly one - whether it is due.
 */
export function listStories(db, { asOf }) {
  return db
    .prepare("SELECT * FROM story ORDER BY created_at, name")
    .all()
    .map((row) => {
      const story = rowToStory(row);
      const last = lastRunOf(db, story.id);
      const runs = db.prepare("SELECT COUNT(*) n FROM story_run WHERE story_id = ?").get(story.id).n;
      const sinceDays = last ? daysBetween(last.as_of, asOf) : null;
      return {
        ...story,
        runs,
        lastRun: last,
        sinceDays,
        due: story.schedule === "weekly" && (sinceDays == null || sinceDays >= WEEKLY_DAYS),
        unknownSections: story.sections.filter((k) => !BY_KIND.has(k)),
      };
    });
}

/** Shared by create and update. A name nobody can confuse with another one. */
function checkName(db, name, exceptId = null) {
  const clean = String(name ?? "").trim();
  if (!clean) return { ok: false, error: "give the story a name first" };
  if (clean.length > MAX_NAME_CHARS) return { ok: false, error: `a story name must be ${MAX_NAME_CHARS} characters or fewer` };
  const clash = db.prepare("SELECT id FROM story WHERE LOWER(name) = LOWER(?) AND id <> ?").get(clean, exceptId ?? "");
  if (clash) return { ok: false, error: `there is already a story called "${clean}"` };
  return { ok: true, name: clean };
}

/**
 * 🔴 The allowlist gate. A section kind that is not in the frozen table is
 * REFUSED BY NAME, never stored and never interpolated into anything.
 */
function checkSections(sections) {
  if (!Array.isArray(sections)) return { ok: false, error: "pick at least one section for the story" };
  const clean = [];
  for (const raw of sections) {
    const kind = String(raw ?? "");
    if (!BY_KIND.has(kind)) return { ok: false, error: `there is no story section called "${kind}"` };
    if (!clean.includes(kind)) clean.push(kind);
  }
  if (!clean.length) return { ok: false, error: "pick at least one section - a story with no section reports nothing" };
  // Stored in the table's order, so two stories with the same sections read the
  // same way round.
  return { ok: true, sections: DEFAULT_SECTIONS.filter((k) => clean.includes(k)) };
}

function checkPeriod(periodDays) {
  const n = Number(periodDays);
  if (!Number.isInteger(n) || n < MIN_PERIOD_DAYS || n > MAX_PERIOD_DAYS) {
    return { ok: false, error: `a story covers between ${MIN_PERIOD_DAYS} and ${MAX_PERIOD_DAYS} days` };
  }
  return { ok: true, periodDays: n };
}

function checkSchedule(schedule) {
  const s = String(schedule ?? "off");
  if (!SCHEDULES.includes(s)) return { ok: false, error: `a story runs on demand or weekly, not "${s}"` };
  return { ok: true, schedule: s };
}

export function createStory(db, { name, sections, periodDays, schedule }) {
  const named = checkName(db, name);
  if (!named.ok) return named;
  const sec = checkSections(sections);
  if (!sec.ok) return sec;
  const per = checkPeriod(periodDays);
  if (!per.ok) return per;
  const sch = checkSchedule(schedule);
  if (!sch.ok) return sch;

  const id = storyId();
  const at = nowIso(db);
  db.prepare(
    "INSERT INTO story (id, name, sections_json, period_days, schedule, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, named.name, JSON.stringify(sec.sections), per.periodDays, sch.schedule, at, at);
  return { ok: true, story: getStory(db, id) };
}

/**
 * Change a story's name, sections, period or schedule.
 *
 * ⭐ This does not touch a single run that has already happened. Editing a story
 * changes what the NEXT run says and nothing else, which is the whole reason a
 * run is stored rather than derived.
 */
export function updateStory(db, id, { name, sections, periodDays, schedule }) {
  const existing = getStory(db, id);
  if (!existing) return { ok: false, error: "that story does not exist any more" };

  let next = { ...existing };
  if (name !== undefined) {
    const named = checkName(db, name, existing.id);
    if (!named.ok) return named;
    next.name = named.name;
  }
  if (sections !== undefined) {
    const sec = checkSections(sections);
    if (!sec.ok) return sec;
    next.sections = sec.sections;
  }
  if (periodDays !== undefined) {
    const per = checkPeriod(periodDays);
    if (!per.ok) return per;
    next.periodDays = per.periodDays;
  }
  if (schedule !== undefined) {
    const sch = checkSchedule(schedule);
    if (!sch.ok) return sch;
    next.schedule = sch.schedule;
  }

  db.prepare("UPDATE story SET name = ?, sections_json = ?, period_days = ?, schedule = ?, updated_at = ? WHERE id = ?").run(
    next.name,
    JSON.stringify(next.sections),
    next.periodDays,
    next.schedule,
    nowIso(db),
    existing.id,
  );
  return { ok: true, story: getStory(db, existing.id) };
}

/**
 * Delete a story AND its stored runs - the foreign key cascades.
 *
 * Said plainly rather than hidden: the count of runs about to go is returned so
 * the page can warn before asking, because nothing here can be undone.
 */
export function deleteStory(db, id) {
  const existing = getStory(db, id);
  if (!existing) return { ok: false, error: "that story does not exist any more" };
  const runs = db.prepare("SELECT COUNT(*) n FROM story_run WHERE story_id = ?").get(existing.id).n;
  db.prepare("DELETE FROM story WHERE id = ?").run(existing.id);
  return { ok: true, id: existing.id, name: existing.name, runsDeleted: runs };
}

/* ══ RUNNING ═══════════════════════════════════════════════════════════════ */

/**
 * Work out every section and store the result.
 *
 * 🔴 THE STORED JSON IS THE REPORT. Nothing downstream recomputes it - not the
 * reader, not the export, not the page. That is what makes a story from March
 * still say in December what it said in March.
 *
 * The period ends on the engine's `as_of` day and runs back `periodDays`. In
 * demo mode `as_of` is pinned, so advancing the clock and running again produces
 * a genuinely different period rather than the same one twice.
 *
 * @param {string} trigger "manual" or "schedule" - recorded, because "why does
 *   this report exist" is a question somebody asks about every automated one.
 */
export function runStory(db, id, { trigger = "manual" } = {}) {
  const story = getStory(db, id);
  if (!story) return { ok: false, error: "that story does not exist any more" };
  if (!story.sections.length) return { ok: false, error: "this story has no sections to report" };

  const asOf = asOfFor(db);
  const settings = getSettings(db);
  const currency = settings.currency ?? "USD";
  // `to` is the as-of day itself and `from` is periodDays-1 days before it, so a
  // 7-day story covers seven days INCLUDING today rather than eight.
  const to = asOf;
  const from = addDays(asOf, -(story.periodDays - 1));
  const ctx = { from, to, currency };

  const sections = story.sections.map((kind) => {
    const def = BY_KIND.get(kind);
    if (!def) {
      // A stored kind this build no longer knows. It is shown as a gap with the
      // reason attached, rather than silently dropped - a missing section in a
      // report reads as "nothing happened", which is a different claim.
      return { kind, label: kind, basis: null, error: `this build has no story section called "${kind}"`, figures: [], columns: [], rows: [], rowsTotal: 0, rowsShown: 0 };
    }
    const built = def.compute(db, ctx);
    return {
      kind: def.kind,
      label: def.label,
      basis: def.basis,
      error: null,
      ...built,
      rowsShown: built.rows.length,
    };
  });

  // Read once: two calls are two different milliseconds, and the label and the
  // stamp must be the same instant.
  const generatedAt = nowIso(db);
  const snapshot = {
    version: 1,
    storyId: story.id,
    storyName: story.name,
    workspaceName: db.prepare("SELECT value FROM meta WHERE key = 'workspace_name'").get()?.value ?? null,
    periodDays: story.periodDays,
    periodFrom: from,
    periodTo: to,
    periodLabel: `${humanDate(from)} to ${humanDate(to)}`,
    asOf,
    currency,
    trigger,
    // Both forms on purpose: the ISO one orders and compares, the label is what
    // a person reads. Working the label out here rather than at display time
    // keeps it part of the frozen snapshot, like every other string in it.
    generatedAt,
    generatedLabel: stamp(generatedAt),
    rowCap: ROW_CAP,
    sections,
  };

  const runIdValue = storyRunId();
  db.prepare(
    "INSERT INTO story_run (id, story_id, at, as_of, period_from, period_to, trigger, snapshot_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runIdValue, story.id, snapshot.generatedAt, asOf, from, to, trigger, JSON.stringify(snapshot));

  return { ok: true, run: { id: runIdValue, storyId: story.id, at: snapshot.generatedAt, asOf, periodFrom: from, periodTo: to, trigger }, snapshot };
}

/** Every run of a story, newest first, WITHOUT the snapshot bodies. */
export function listRuns(db, storyIdValue) {
  const story = getStory(db, storyIdValue);
  if (!story) return { ok: false, error: "that story does not exist any more" };
  const runs = db
    .prepare("SELECT id, at, as_of, period_from, period_to, trigger FROM story_run WHERE story_id = ? ORDER BY at DESC")
    .all(story.id)
    .map((r) => ({
      id: r.id,
      at: r.at,
      asOf: r.as_of,
      periodFrom: r.period_from,
      periodTo: r.period_to,
      periodLabel: `${humanDate(r.period_from)} to ${humanDate(r.period_to)}`,
      trigger: r.trigger,
    }));
  return { ok: true, story, runs };
}

/**
 * One past run, exactly as it was stored.
 *
 * 🔴 No recomputation, no merge with today's data, no repair. If the stored JSON
 * cannot be parsed the run is reported as unreadable rather than rebuilt from
 * the current tables, because a rebuilt report is a different report wearing the
 * old one's date.
 */
export function getRun(db, runIdValue) {
  const row = db.prepare("SELECT * FROM story_run WHERE id = ?").get(String(runIdValue ?? ""));
  if (!row) return { ok: false, error: "that story run does not exist any more" };
  let snapshot;
  try {
    snapshot = JSON.parse(row.snapshot_json);
  } catch {
    return { ok: false, error: "that story run was stored unreadably and cannot be shown" };
  }
  return {
    ok: true,
    run: {
      id: row.id,
      storyId: row.story_id,
      at: row.at,
      asOf: row.as_of,
      periodFrom: row.period_from,
      periodTo: row.period_to,
      trigger: row.trigger,
    },
    snapshot,
  };
}

/* ══ EXPORT ════════════════════════════════════════════════════════════════
 *
 * The competitor offers PDF. There is no PDF library in this app, adding a
 * dependency for one button is out of proportion, and a bundled renderer that
 * fails on an offline machine would be worse than no button at all. So the
 * export is ONE self-contained HTML file with a print stylesheet, and the UI
 * says plainly that the browser turns it into a PDF.
 *
 * Self-contained means exactly that: no stylesheet link, no font, no script, no
 * image. The file opens on a machine with no network, which is the machine this
 * product is installed on.
 */

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Every value that reaches the file goes through here. Customer names included. */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

const EXPORT_CSS = `
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; background: #fff; color: #16181c;
    font: 14px/1.55 "Segoe UI", system-ui, -apple-system, Arial, sans-serif; }
  .wrap { max-width: 980px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 0 0 2px; }
  .sub { color: #666c75; font-size: 12.5px; margin: 0; }
  .meta { border-bottom: 1px solid #e1e3e8; padding-bottom: 16px; margin-bottom: 24px; }
  .meta dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 12px 0 0; font-size: 12.5px; }
  .meta dt { color: #666c75; }
  .meta dd { margin: 0; }
  section { border: 1px solid #e1e3e8; border-radius: 10px; padding: 16px; margin: 0 0 16px; }
  .basis { color: #666c75; font-size: 11px; margin: 4px 0 12px; }
  .figs { display: flex; flex-wrap: wrap; gap: 24px; margin: 0 0 12px; }
  .fig { min-width: 110px; }
  .fig .v { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
  .fig .l { color: #666c75; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .fig .n { color: #666c75; font-size: 11px; margin-top: 2px; max-width: 260px; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: #666c75; font-weight: 600; font-size: 11px;
    text-transform: uppercase; letter-spacing: .06em; border-bottom: 1px solid #e1e3e8; padding: 6px 8px; }
  td { padding: 6px 8px; border-bottom: 1px solid #edeef1; vertical-align: top; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .empty { color: #666c75; font-style: italic; }
  .trunc { color: #8a5b0f; font-size: 11px; margin: 8px 0 0; }
  .err { color: #c0362c; font-size: 12.5px; }
  footer { color: #666c75; font-size: 11px; border-top: 1px solid #e1e3e8; padding-top: 12px; margin-top: 24px; }
  .note { background: #f1f2f4; border-radius: 6px; padding: 10px 12px; font-size: 12px; margin: 0 0 24px; }

  /* Printing is the point of this file, so the print rules are not an
     afterthought: a section must not be split across a page, and the
     "print this to PDF" note must not print - it is advice for the screen. */
  @page { margin: 14mm; }
  @media print {
    body { padding: 0; }
    .note { display: none; }
    section { break-inside: avoid; page-break-inside: avoid; border: 1px solid #ccc; }
    tr { break-inside: avoid; page-break-inside: avoid; }
    thead { display: table-header-group; }
  }
`;

function sectionHtml(sec) {
  const out = [];
  out.push(`<section>`);
  out.push(`<h2>${esc(sec.label)}</h2>`);
  if (sec.error) {
    out.push(`<p class="err">${esc(sec.error)}</p></section>`);
    return out.join("");
  }
  if (sec.basis) out.push(`<p class="basis">Counted from ${esc(sec.basis)}.</p>`);
  if (sec.figures?.length) {
    out.push(`<div class="figs">`);
    for (const f of sec.figures) {
      out.push(`<div class="fig"><div class="v">${esc(f.display)}</div><div class="l">${esc(f.label)}</div>`);
      if (f.note) out.push(`<div class="n">${esc(f.note)}</div>`);
      out.push(`</div>`);
    }
    out.push(`</div>`);
  }
  if (!sec.rows?.length) {
    out.push(`<p class="empty">${esc(sec.empty ?? "Nothing to list.")}</p>`);
  } else {
    out.push(`<table><thead><tr>`);
    for (const c of sec.columns) out.push(`<th${c.numeric ? ' class="num"' : ""}>${esc(c.label)}</th>`);
    out.push(`</tr></thead><tbody>`);
    for (const r of sec.rows) {
      out.push(`<tr>`);
      r.cells.forEach((cell, i) => {
        out.push(`<td${sec.columns[i]?.numeric ? ' class="num"' : ""}>${esc(cell)}</td>`);
      });
      out.push(`</tr>`);
    }
    out.push(`</tbody></table>`);
    if (sec.rowsTotal > sec.rows.length) {
      out.push(
        `<p class="trunc">Showing the ${sec.rows.length} most recent of ${sec.rowsTotal}. The totals above count all ${sec.rowsTotal}.</p>`,
      );
    }
  }
  out.push(`</section>`);
  return out.join("");
}

/**
 * The whole export, from the SNAPSHOT alone.
 *
 * It takes no database handle on purpose: it cannot reach today's data even by
 * accident, so exporting an old run can only ever produce what that run said.
 */
export function renderStoryHtml(snapshot) {
  const title = `${snapshot.storyName ?? "Story"} — ${snapshot.periodLabel ?? ""}`.trim();
  const rows = [
    ["Period", snapshot.periodLabel],
    ["Days covered", String(snapshot.periodDays)],
    ["Workspace", snapshot.workspaceName],
    ["Run at", snapshot.generatedLabel ?? snapshot.generatedAt],
    ["Run by", snapshot.trigger === "schedule" ? "the weekly schedule" : "a person, on demand"],
  ].filter(([, v]) => v != null && v !== "");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${EXPORT_CSS}</style>
</head><body><div class="wrap">
<div class="meta">
<h1>${esc(snapshot.storyName ?? "Story")}</h1>
<p class="sub">${esc(snapshot.periodLabel ?? "")}</p>
<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
</div>
<p class="note">This file prints to PDF: open it in your browser and choose Print, then "Save as PDF". It needs no internet and carries nothing but itself.</p>
${(snapshot.sections ?? []).map(sectionHtml).join("\n")}
<footer>Every figure above was counted from the records named under it, on ${esc(snapshot.generatedLabel ?? snapshot.generatedAt)}. This is a stored snapshot: it says what it said when it was run, and re-running the story writes a new one rather than changing this.</footer>
</div></body></html>`;
}

/** A file name from a story name. Nothing but letters, digits and hyphens. */
function slug(name) {
  const s = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return s || "story";
}

/**
 * Write one stored run to an HTML file and return where it went.
 *
 * It writes a file rather than handing the browser a download, matching what
 * `decisionsTemplates` already does: the app is a local window, the file belongs
 * on the disk, and a path the user can copy works whether or not the window's
 * download plumbing does.
 */
export function exportRun(db, runIdValue) {
  const read = getRun(db, runIdValue);
  if (!read.ok) return read;
  const folder = path.join(PATHS.downloads, "ledgerline-stories");
  const file = path.join(folder, `${slug(read.snapshot.storyName)}-${read.run.periodTo}-${read.run.id}.html`);
  const html = renderStoryHtml(read.snapshot);
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(file, html, "utf8");
  } catch (err) {
    return { ok: false, error: `the story could not be written: ${err.message}` };
  }
  return { ok: true, file, folder, bytes: Buffer.byteLength(html, "utf8"), run: read.run };
}

/* ══ THE SCHEDULE ══════════════════════════════════════════════════════════
 *
 * 🔴 SAME MECHANISM AS src/decisions/followup.mjs, DELIBERATELY. That file is
 * the app's one background pass over every workspace: a plain interval, started
 * by launch.mjs, stopped with it, unref'd so it can never hold the process open.
 * `tick(db)` below has the same signature and the same contract - one pass over
 * ONE workspace, pure of side effects other than the database - so it can be
 * driven either by the pair below or by a single line inside the follow-up loop.
 * Wire ONE of them. Two intervals doing the same work is the thing not to build.
 *
 * Time comes from the engine clock, so demo mode moves it: advance `as_of` by a
 * week and the next tick finds every weekly story due.
 */

/** Is this workspace's database old enough to know about stories? */
function hasStoryTable(db) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'story'").get();
}

/**
 * One pass: run every weekly story that is due.
 *
 * ⭐ A weekly story with NO runs yet is due immediately. The alternative - wait a
 * week before the first one - means a person ticks "weekly", sees nothing, and
 * has no way to tell whether it is working or broken.
 */
export function tick(db) {
  const out = { ran: 0, failed: 0 };
  // Until the migration is appended the table is absent, and this is the one
  // caller that runs unattended in a loop where a throw would be invisible.
  if (!hasStoryTable(db)) return out;
  const asOf = asOfFor(db);
  for (const row of db.prepare("SELECT id FROM story WHERE schedule = 'weekly'").all()) {
    const last = lastRunOf(db, row.id);
    const since = last ? daysBetween(last.as_of, asOf) : null;
    if (since != null && since < WEEKLY_DAYS) continue;
    const r = runStory(db, row.id, { trigger: "schedule" });
    if (r.ok) out.ran++;
    else {
      out.failed++;
      log.warn("scheduled story failed", { story: row.id, error: r.error });
    }
  }
  return out;
}

let _timer = null;

/**
 * Start the weekly pass. Hourly, not five-minutely: the thing it watches for
 * moves once a week, and a demo clock advanced by hand is followed by a manual
 * run anyway.
 */
export function startStories({ everyMs = 60 * 60_000 } = {}) {
  if (_timer) return;
  const run = () => {
    try {
      const { workspaces } = workspace.list();
      for (const w of workspaces) {
        const db = workspace.openWorkspace(w.id);
        try {
          const r = tick(db);
          if (r.ran || r.failed) log.info("stories", { workspace: w.id, ...r });
        } finally {
          db.close();
        }
      }
    } catch (err) {
      log.warn("story schedule failed", { error: err.message });
    }
  };
  run();
  _timer = setInterval(run, everyMs);
  _timer.unref?.();
}

export function stopStories() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

/* ══ THE ROUTES ════════════════════════════════════════════════════════════
 *
 * Thin by rule: guard the ids the page must send, then hand `db` to a function
 * above. No SQL here, and nothing assembled here - same division as
 * segments.mjs, whose routes live in routes.mjs for the same reason.
 *
 * Every name starts with "decisions" because the two route tables are merged
 * into one dispatcher in src/ui/server.mjs, and the prefix is what keeps this
 * feature's names away from the chat app's.
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

export const storyRoutes = {
  /** The saved stories, plus the vocabulary the builder offers. */
  async decisionsStories() {
    return withDb((db) => {
      const asOf = asOfFor(db);
      const settings = getSettings(db);
      return ok({
        stories: listStories(db, { asOf }),
        ...sectionVocabulary(),
        defaultSections: DEFAULT_SECTIONS,
        currency: settings.currency ?? "USD",
        accounts: db.prepare("SELECT COUNT(*) n FROM account").get().n,
        decisions: db.prepare("SELECT COUNT(*) n FROM decision").get().n,
        weeklyDays: WEEKLY_DAYS,
        asOf,
      });
    });
  },

  async decisionsStoryCreate({ body }) {
    return withDb((db) =>
      createStory(db, {
        name: body?.name,
        sections: body?.sections,
        periodDays: body?.periodDays,
        schedule: body?.schedule,
      }),
    );
  },

  /** Rename, re-section, re-period, or turn the weekly schedule on and off. */
  async decisionsStoryUpdate({ body }) {
    if (!body?.id) return bad("which story?");
    return withDb((db) =>
      updateStory(db, body.id, {
        name: body.name,
        sections: body.sections,
        periodDays: body.periodDays,
        schedule: body.schedule,
      }),
    );
  },

  async decisionsStoryDelete({ body }) {
    if (!body?.id) return bad("which story?");
    return withDb((db) => deleteStory(db, body.id));
  },

  /** Run it now. Stores a snapshot and returns it, so the page shows what it stored. */
  async decisionsStoryRun({ body }) {
    if (!body?.id) return bad("which story?");
    return withDb((db) => runStory(db, body.id, { trigger: "manual" }));
  },

  /** Every past run of one story, newest first. */
  async decisionsStoryHistory({ query }) {
    if (!query?.id) return bad("which story?");
    return withDb((db) => listRuns(db, query.id));
  },

  /** One past run, exactly as it was stored. */
  async decisionsStorySnapshot({ query }) {
    if (!query?.id) return bad("which story run?");
    return withDb((db) => getRun(db, query.id));
  },

  /** Write one past run to a self-contained HTML file and say where it went. */
  async decisionsStoryExport({ body }) {
    if (!body?.id) return bad("which story run?");
    return withDb((db) => exportRun(db, body.id));
  },
};

export default storyRoutes;
