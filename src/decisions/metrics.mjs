// Saved metrics, saved charts and saved dashboards.
//
// WHAT THE THREE THINGS ARE, and why they are three tables and not one:
//
//   A METRIC is a named definition — what it counts, over what window, filtered
//   how. It is a STRUCTURED RECORD against a frozen allowlist. Never a stored
//   SQL string, never a prose blob a model has to re-read.
//   A CHART is a saved metric plus a shape (line / bar / unit-dot) and a
//   grouping. The metric owns the number; the chart owns how it is cut and drawn.
//   A DASHBOARD is an ordered set of charts, and nothing else.
//
// ⭐ THE ONE THING THIS DOES THAT THE COMPETITOR DOES NOT. Every computed number
// comes back with `definitionText` — the definition written out in English — and
// with `rows`, the records the number was counted from. The page prints the
// sentence under the number and puts an edit button on it, so "what did this
// count?" is answered where the number is, not in a settings blob two screens
// away. `describeDefinition` is the ONLY place that sentence is written: if the
// page wrote its own, the sentence and the number could disagree, which is worse
// than having no sentence at all.
//
// 🔴 THE SECURITY RULE, same as segments.mjs. A definition is typed by a user
// and then re-run every time somebody opens a dashboard. A source, a measure, a
// window, a field, an operator and a grouping are all looked up in frozen
// tables in THIS FILE; anything not found is REFUSED with a sentence naming what
// was asked for. The only strings interpolated into SQL are `col` values written
// here, and `SAFE_COL` re-checks every one of them at compile time anyway. No
// user value reaches SQL except through a `?` placeholder.
//
// 🔴 THE HONESTY RULE. A number that cannot be computed comes back as null with
// a reason, never as 0. An average over no rows is a gap, not a zero. A window
// that excludes undated rows says how many it excluded. A sum over rows whose
// amount is missing says how many carried no amount. Every one of those was a
// place where a plausible-looking wrong number could have been shipped.
import { money, addDays } from "./format.mjs";
import { nowIso, getSettings, tx } from "./db.mjs";
import { id as newId } from "./ids.mjs";
import * as workspace from "./workspace.mjs";
import { asOfFor } from "./run.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/metrics");

/* ══ THE MIGRATION ═════════════════════════════════════════════════════════
 *
 * Exported as a string and APPENDED to the MIGRATIONS array by whoever wires
 * this module in. It is never an edit to a migration that has shipped: an
 * installed database is already at its version and would never re-run it, so an
 * edit changes only what a FRESH install gets and the two diverge for good.
 *
 * The tables are `saved_metric` / `saved_chart` and not `metric` / `chart` on
 * purpose. `metric_daily` already exists and holds a completely different thing
 * — one row per account per day per measurement — and two tables whose names
 * differ by a suffix is how the wrong one gets queried.
 *
 * ON DELETE CASCADE is the backstop, not the policy. `deleteMetric` refuses
 * while a chart still points at the metric, so the cascade should never fire
 * from the UI; it exists so that a row deleted by hand cannot leave an orphan.
 */
export const METRICS_MIGRATION = `
  CREATE TABLE saved_metric (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    definition_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE saved_chart (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    metric_id TEXT NOT NULL REFERENCES saved_metric(id) ON DELETE CASCADE,
    shape TEXT NOT NULL,
    group_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX saved_chart_metric ON saved_chart(metric_id);

  CREATE TABLE dashboard (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE dashboard_chart (
    dashboard_id TEXT NOT NULL REFERENCES dashboard(id) ON DELETE CASCADE,
    chart_id TEXT NOT NULL REFERENCES saved_chart(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    PRIMARY KEY (dashboard_id, chart_id)
  );
  CREATE INDEX dashboard_chart_order ON dashboard_chart(dashboard_id, position);
`;

/* ══ THE ALLOWLIST ═════════════════════════════════════════════════════════
 *
 * Four sources, because these are the four tables that carry both a date and
 * something worth counting. Each declares:
 *
 *   from        the FROM clause, written here and never assembled from input
 *   dateCol     the column the window is measured on, and the column a time
 *               grouping buckets by. One per source, so "over what window" can
 *               only ever mean one thing.
 *   amountCol   the money column sum/avg work on. null means count only.
 *   fields      what a filter may name, and what a grouping may cut by
 *   row         how one record is projected for the evidence list
 *
 * `col` values are the only strings from this file that reach SQL. They are
 * `alias.column` and nothing else, checked by SAFE_COL at compile time.
 */

/** A column reference is ours, so it can only ever look like this. */
const SAFE_COL = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/;

export const SOURCES = [
  {
    id: "decisions",
    label: "Decisions",
    noun: "decision",
    nounPlural: "decisions",
    from: "decision d LEFT JOIN account a ON a.id = d.account_id",
    dateCol: "d.created_at",
    dateLabel: "raised",
    amountCol: "d.impact_amount",
    amountLabel: "impact",
    amountIsMoney: true,
    fields: [
      { id: "status", label: "Status", type: "text", col: "d.status" },
      { id: "severity", label: "Severity", type: "text", col: "d.severity" },
      { id: "kind", label: "Kind", type: "text", col: "d.kind" },
      { id: "owner", label: "Owner", type: "text", col: "d.owner" },
      { id: "confidence", label: "Confidence", type: "text", col: "d.confidence" },
      { id: "reasoning", label: "Reasoned by", type: "text", col: "d.reasoning_source" },
      { id: "customer", label: "Customer", type: "text", col: "a.name" },
      { id: "impact", label: "Impact amount", type: "money", col: "d.impact_amount" },
      { id: "dueAt", label: "Due date", type: "date", col: "d.due_at" },
      { id: "resolvedAt", label: "Resolved date", type: "date", col: "d.resolved_at" },
    ],
    row: {
      idCol: "d.id",
      labelCol: "d.title",
      metaCol: "d.status",
      amountCol: "d.impact_amount",
      link: "decisions",
      linkIdCol: "d.id",
    },
  },
  {
    id: "customers",
    label: "Customers",
    noun: "customer",
    nounPlural: "customers",
    from: "account a",
    dateCol: "a.created_at",
    dateLabel: "added",
    amountCol: "a.arr",
    amountLabel: "ARR",
    amountIsMoney: true,
    fields: [
      { id: "plan", label: "Plan", type: "text", col: "a.plan" },
      { id: "owner", label: "Owner", type: "text", col: "a.owner" },
      { id: "segment", label: "Segment", type: "text", col: "a.segment" },
      { id: "industry", label: "Industry", type: "text", col: "a.industry" },
      { id: "name", label: "Name", type: "text", col: "a.name" },
      { id: "arr", label: "ARR", type: "money", col: "a.arr" },
      { id: "seats", label: "Seats purchased", type: "number", col: "a.seats_purchased" },
      { id: "renewalDate", label: "Renewal date", type: "date", col: "a.renewal_date" },
    ],
    row: {
      idCol: "a.id",
      labelCol: "a.name",
      metaCol: "a.plan",
      amountCol: "a.arr",
      link: "customers",
      linkIdCol: "a.id",
    },
  },
  {
    id: "tickets",
    label: "Support tickets",
    noun: "ticket",
    nounPlural: "tickets",
    from: "ticket t LEFT JOIN account a ON a.id = t.account_id",
    dateCol: "t.opened_at",
    dateLabel: "opened",
    amountCol: null,
    amountLabel: null,
    amountIsMoney: false,
    fields: [
      { id: "priority", label: "Priority", type: "text", col: "t.priority" },
      { id: "customer", label: "Customer", type: "text", col: "a.name" },
      { id: "subject", label: "Subject", type: "text", col: "t.subject" },
      { id: "closedAt", label: "Closed date", type: "date", col: "t.closed_at" },
    ],
    row: {
      idCol: "t.id",
      labelCol: "t.subject",
      metaCol: "a.name",
      amountCol: null,
      link: "customers",
      linkIdCol: "a.id",
    },
  },
  {
    id: "invoices",
    label: "Invoices",
    noun: "invoice",
    nounPlural: "invoices",
    from: "invoice i LEFT JOIN account a ON a.id = i.account_id",
    dateCol: "i.due_at",
    dateLabel: "due",
    amountCol: "i.amount",
    amountLabel: "amount",
    amountIsMoney: true,
    fields: [
      { id: "status", label: "Status", type: "text", col: "i.status" },
      { id: "customer", label: "Customer", type: "text", col: "a.name" },
      { id: "amount", label: "Amount", type: "money", col: "i.amount" },
      { id: "attempts", label: "Payment attempts", type: "number", col: "i.attempts" },
      { id: "paidAt", label: "Paid date", type: "date", col: "i.paid_at" },
    ],
    row: {
      idCol: "i.id",
      labelCol: "a.name",
      metaCol: "i.status",
      amountCol: "i.amount",
      link: "customers",
      linkIdCol: "a.id",
    },
  },
];

const SOURCE_BY_ID = new Map(SOURCES.map((s) => [s.id, s]));
const fieldsOf = (source) => new Map(source.fields.map((f) => [f.id, f]));

/* ── operators, by field type ──────────────────────────────────────────── */

const blankSql = (c) => `(${c} IS NULL OR ${c} = '')`;
const notBlankSql = (c) => `(${c} IS NOT NULL AND ${c} <> '')`;

/** Text compares case-insensitively on both sides, the way a person reads it. */
const TEXT_OPS = {
  is: { label: "is", sql: (c) => `LOWER(COALESCE(${c}, '')) = LOWER(?)` },
  isnot: { label: "is not", sql: (c) => `LOWER(COALESCE(${c}, '')) <> LOWER(?)` },
  contains: { label: "contains", sql: (c) => `INSTR(LOWER(COALESCE(${c}, '')), LOWER(?)) > 0` },
  notcontains: { label: "does not contain", sql: (c) => `INSTR(LOWER(COALESCE(${c}, '')), LOWER(?)) = 0` },
  blank: { label: "is blank", sql: blankSql, valueless: true },
  notblank: { label: "is not blank", sql: notBlankSql, valueless: true },
};

/** `cmp` is a literal written here. It is never assembled from input. */
const numOp = (cmp, label) => ({ label, number: true, sql: (c) => `(${c} IS NOT NULL AND ${c} ${cmp} ?)` });

const NUMBER_OPS = {
  gte: numOp(">=", "is at least"),
  gt: numOp(">", "is more than"),
  lte: numOp("<=", "is at most"),
  lt: numOp("<", "is less than"),
  eq: numOp("=", "is exactly"),
  blank: { label: "is not known", sql: (c) => `${c} IS NULL`, valueless: true },
  notblank: { label: "is known", sql: (c) => `${c} IS NOT NULL`, valueless: true },
};

/**
 * ⚠️ THE NULL GUARD IS LOAD-BEARING, and it is the same trap segments.mjs
 * documents. `COALESCE(x, '') < '2026-01-01'` is TRUE for every row with no
 * date, because the empty string sorts before every date — so "due before
 * March" would silently include everything that has no due date at all.
 */
const dateOp = (cmp, label) => ({
  label,
  sql: (c) => `(${c} IS NOT NULL AND ${c} <> '' AND SUBSTR(${c}, 1, 10) ${cmp} ?)`,
});

const DATE_OPS = {
  before: dateOp("<", "is before"),
  after: dateOp(">", "is after"),
  on: dateOp("=", "is on"),
  blank: { label: "is blank", sql: blankSql, valueless: true },
  notblank: { label: "is not blank", sql: notBlankSql, valueless: true },
};

export const METRIC_OPS = { text: TEXT_OPS, money: NUMBER_OPS, number: NUMBER_OPS, date: DATE_OPS };

/* ── measures, windows, shapes, groupings ─────────────────────────────── */

export const MEASURES = [
  { id: "count", label: "Count of rows", needsAmount: false },
  { id: "sum", label: "Sum of", needsAmount: true },
  { id: "avg", label: "Average of", needsAmount: true },
];
const MEASURE_BY_ID = new Map(MEASURES.map((m) => [m.id, m]));

/**
 * `days` counts back from as-of INCLUSIVE, so "last 7 days" is seven dated days
 * ending today and not eight. The computed bounds ride back on every result so
 * the page prints the dates rather than working them out a second time.
 */
export const WINDOWS = [
  { id: "all", label: "All time", days: null },
  { id: "7", label: "Last 7 days", days: 7 },
  { id: "30", label: "Last 30 days", days: 30 },
  { id: "90", label: "Last 90 days", days: 90 },
  { id: "365", label: "Last 365 days", days: 365 },
];
const WINDOW_BY_ID = new Map(WINDOWS.map((w) => [w.id, w]));

export const SHAPES = [
  { id: "line", label: "Line" },
  { id: "bar", label: "Bar" },
  { id: "unit-dot", label: "Unit dots" },
];
const SHAPE_IDS = new Set(SHAPES.map((s) => s.id));

/** Time buckets every source offers, plus that source's own text fields. */
export const TIME_GROUPS = [
  { id: "day", label: "By day" },
  { id: "week", label: "By week" },
  { id: "month", label: "By month" },
];
const TIME_BY_ID = new Map(TIME_GROUPS.map((g) => [g.id, g]));

const timeGroupSql = {
  day: (c) => `SUBSTR(${c}, 1, 10)`,
  // The Monday on or before the date. Going forward to 'weekday 1' from six days
  // earlier lands on this week's Monday for every day INCLUDING Monday itself,
  // which a bare 'weekday 1' does not.
  week: (c) => `date(SUBSTR(${c}, 1, 10), '-6 days', 'weekday 1')`,
  month: (c) => `SUBSTR(${c}, 1, 7)`,
};

/** What a grouping may be, for one source. Only text fields can be cut by. */
export function groupingsFor(source) {
  return [
    { id: "none", label: "No grouping" },
    ...TIME_GROUPS.map((g) => ({ ...g })),
    ...source.fields.filter((f) => f.type === "text").map((f) => ({ id: `field:${f.id}`, label: `By ${f.label}` })),
  ];
}

/** The whole vocabulary the page builds its menus from, so the two cannot drift. */
export function vocabulary() {
  return {
    sources: SOURCES.map((s) => ({
      id: s.id,
      label: s.label,
      noun: s.noun,
      nounPlural: s.nounPlural,
      dateLabel: s.dateLabel,
      amountLabel: s.amountLabel,
      amountIsMoney: s.amountIsMoney,
      measures: MEASURES.filter((m) => !m.needsAmount || s.amountCol).map((m) => m.id),
      fields: s.fields.map((f) => ({ id: f.id, label: f.label, type: f.type })),
      groupings: groupingsFor(s),
    })),
    ops: Object.fromEntries(
      Object.entries(METRIC_OPS).map(([type, table]) => [
        type,
        Object.entries(table).map(([opId, op]) => [opId, op.label, !op.valueless]),
      ]),
    ),
    windows: WINDOWS.map((w) => ({ id: w.id, label: w.label })),
    shapes: SHAPES.map((s) => ({ id: s.id, label: s.label })),
  };
}

/* ══ CAPS ══════════════════════════════════════════════════════════════════
 * Turn a pathological payload into a sentence instead of a 500 or a hang.
 */
const MAX_FILTERS = 12;
const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 400;
const MAX_ROWS = 200;
const DEFAULT_ROWS = 25;
const SERIES_MAX = 12; // groups drawn before the rest folds into one "Other"
const BUCKET_MAX = 370; // time buckets filled before the oldest are dropped
const MAX_CHARTS_PER_DASHBOARD = 24;

/* ══ COMPILING A DEFINITION ════════════════════════════════════════════════ */

const okv = (d = {}) => ({ ok: true, ...d });
const badv = (error) => ({ ok: false, error });

function checkCol(col) {
  if (!SAFE_COL.test(col)) throw new Error(`metric column "${col}" is not a usable column reference`);
  return col;
}

/**
 * Compile ONE filter rule.
 *
 * @returns {{ok:true, sql?:string, args?:any[], skip?:boolean, field?:object, op?:object}
 *          | {ok:false, error:string}}
 *   `skip: true` means the rule takes a value and has none yet. Those are
 *   counted and reported, never guessed at.
 */
function compileFilter(source, rule) {
  const byId = fieldsOf(source);
  const wanted = String(rule?.field ?? "");
  const field = byId.get(wanted);
  if (!field) return badv(`"${wanted}" is not a field ${source.label} can be filtered by`);
  checkCol(field.col);

  const table = METRIC_OPS[field.type];
  const opId = String(rule?.op ?? "");
  const op = Object.hasOwn(table, opId) ? table[opId] : null;
  if (!op) return badv(`"${field.label}" cannot be compared with "${opId}"`);

  if (op.valueless) return okv({ sql: op.sql(field.col), args: [], field, op, opId });

  const raw = String(rule?.value ?? "").trim();
  if (raw === "") return okv({ skip: true, field, op, opId });

  if (op.number) {
    const n = Number(raw);
    // Not an error: the user is mid-type. "12a" is no more a number than "" is.
    if (!Number.isFinite(n)) return okv({ skip: true, field, op, opId });
    return okv({ sql: op.sql(field.col), args: [n], field, op, opId, value: n });
  }
  return okv({ sql: op.sql(field.col), args: [raw], field, op, opId, value: raw });
}

/**
 * Compile a whole definition against the allowlist.
 *
 * @param {{source:string, measure:string, window:string, filters:Array}} definition
 * @param {{asOf:string}} opts
 * @returns {{ok:true, ...} | {ok:false, error:string}}
 */
export function compileDefinition(definition, { asOf }) {
  if (!definition || typeof definition !== "object") return badv("a metric needs a definition");

  const source = SOURCE_BY_ID.get(String(definition.source ?? ""));
  if (!source) return badv(`"${String(definition.source ?? "")}" is not something this workspace can count`);

  const measure = MEASURE_BY_ID.get(String(definition.measure ?? ""));
  if (!measure) return badv(`"${String(definition.measure ?? "")}" is not a measure`);
  if (measure.needsAmount && !source.amountCol) {
    return badv(`${source.label} carry no amount, so they can only be counted`);
  }

  const win = WINDOW_BY_ID.get(String(definition.window ?? ""));
  if (!win) return badv(`"${String(definition.window ?? "")}" is not a window`);

  const filters = definition.filters === undefined || definition.filters === null ? [] : definition.filters;
  if (!Array.isArray(filters)) return badv("the filters must be a list");
  if (filters.length > MAX_FILTERS) return badv(`a metric can have at most ${MAX_FILTERS} filters`);

  // The window and the filters are kept APART as well as joined. Three of the
  // four queries below need one without the other — the denominator wants the
  // window alone, the undated count wants the filters alone — and slicing them
  // back out of one combined list by position is the kind of arithmetic that is
  // right until somebody adds a clause.
  const windowWhere = [];
  const windowArgs = [];
  checkCol(source.dateCol);
  let from = null;
  const to = String(asOf ?? "").slice(0, 10);
  if (win.days !== null) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return badv("the as-of date could not be read, so a window cannot be applied");
    from = addDays(to, -(win.days - 1));
    windowWhere.push(
      `(${source.dateCol} IS NOT NULL AND ${source.dateCol} <> '' AND SUBSTR(${source.dateCol}, 1, 10) >= ? AND SUBSTR(${source.dateCol}, 1, 10) <= ?)`,
    );
    windowArgs.push(from, to);
  }

  const filterWhere = [];
  const filterArgs = [];
  const used = [];
  let incomplete = 0;

  for (const rule of filters) {
    const c = compileFilter(source, rule);
    if (!c.ok) return c;
    if (c.skip) {
      incomplete++;
      continue;
    }
    filterWhere.push(c.sql);
    filterArgs.push(...c.args);
    used.push({ field: c.field, op: c.op, opId: c.opId, value: c.value });
  }

  return okv({
    source,
    measure,
    window: win,
    windowFrom: from,
    windowTo: win.days === null ? null : to,
    windowWhere,
    windowArgs,
    filterWhere,
    filterArgs,
    where: [...windowWhere, ...filterWhere],
    args: [...windowArgs, ...filterArgs],
    used,
    incomplete,
    filters,
  });
}

/** The compiled grouping, or an error naming what was asked for. */
function compileGrouping(source, groupBy) {
  const wanted = String(groupBy ?? "none") || "none";
  if (wanted === "none") return okv({ kind: "none", id: "none", label: "No grouping", sql: null });

  if (TIME_BY_ID.has(wanted)) {
    checkCol(source.dateCol);
    return okv({
      kind: "time",
      id: wanted,
      unit: wanted,
      label: TIME_BY_ID.get(wanted).label,
      sql: timeGroupSql[wanted](source.dateCol),
    });
  }

  if (wanted.startsWith("field:")) {
    const field = fieldsOf(source).get(wanted.slice("field:".length));
    if (field && field.type === "text") {
      checkCol(field.col);
      return okv({ kind: "field", id: wanted, field, label: `By ${field.label}`, sql: field.col });
    }
  }
  return badv(`"${wanted}" is not a way ${source.label} can be grouped`);
}

/* ══ THE DEFINITION, IN ENGLISH ════════════════════════════════════════════
 *
 * 🔴 THE ONLY PLACE THIS SENTENCE IS WRITTEN. The page prints what comes back
 * from here. A second copy in the browser would eventually describe a rule the
 * server did not run, and the whole point of this feature is that the sentence
 * and the number are the same claim.
 */
export function describeDefinition(compiled, { currency = "USD" } = {}) {
  const { source, measure, window: win, used } = compiled;
  const head =
    measure.id === "count"
      ? `Count of ${source.nounPlural}`
      : `${measure.id === "sum" ? "Sum" : "Average"} of ${source.amountLabel} across ${source.nounPlural}`;

  const parts = [head];
  if (used.length) {
    parts.push(
      "where " +
        used
          .map((u) => {
            if (u.value === undefined) return `${u.field.label} ${u.op.label}`;
            if (u.field.type === "money") return `${u.field.label} ${u.op.label} ${money(u.value, currency)}`;
            return `${u.field.label} ${u.op.label} ${u.value}`;
          })
          .join(" and "),
    );
  }
  parts.push(
    win.days === null
      ? "over all time"
      : `${source.dateLabel} in the last ${win.days} days (${compiled.windowFrom} to ${compiled.windowTo})`,
  );
  return `${parts.join(", ")}.`;
}

/* ══ COMPUTING ═════════════════════════════════════════════════════════════ */

const whereSql = (where) => (where.length ? ` WHERE ${where.join(" AND ")}` : "");

/**
 * Read one aggregate row. `missing` is counted here and not inferred later,
 * because "rows with no amount" is a different quantity from "rows that did not
 * match", and reporting one as the other is how a sum quietly under-reports.
 */
function aggregateSql(source, extra = "") {
  const amt = source.amountCol ? checkCol(source.amountCol) : null;
  return `SELECT ${extra}COUNT(*) AS n,
      ${amt ? `SUM(${amt})` : "NULL"} AS total,
      ${amt ? `AVG(${amt})` : "NULL"} AS mean,
      ${amt ? `SUM(CASE WHEN ${amt} IS NULL THEN 1 ELSE 0 END)` : "0"} AS missing`;
}

/** Turn one aggregate row into the measure's number, or null where there is none. */
function valueOf(measure, row) {
  const n = Number(row?.n ?? 0);
  if (measure.id === "count") return n;
  if (measure.id === "sum") return row?.total == null ? 0 : Number(row.total);
  // An average over no measured row is a gap. Zero would be a claim nobody made.
  return row?.mean == null ? null : Number(row.mean);
}

/** One number, written the way the measure and the source mean it. */
function labelFor(measure, source, value, currency) {
  if (value == null) return null;
  if (measure.id === "count") return Math.round(value).toLocaleString("en-US");
  if (source.amountIsMoney) return money(value, currency);
  return String(Math.round(value * 100) / 100);
}

const monthKey = (day) => String(day).slice(0, 7);

/** The Monday on or before `day`, matching the SQL bucket exactly. */
function mondayOf(day) {
  const d = new Date(`${String(day).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return String(day).slice(0, 10);
  return addDays(String(day).slice(0, 10), -((d.getUTCDay() + 6) % 7));
}

/**
 * Every bucket between two days, so a gap in the data draws as a gap rather than
 * as two adjacent points pretending to be consecutive.
 */
/**
 * 🔴 GENERATED NEWEST-FIRST, AND THE REASON IS A MEASURED BUG.
 *
 * This used to walk FORWARD from the oldest day and stop after BUCKET_MAX * 2
 * buckets; `seriesFor` then kept the last BUCKET_MAX of that truncated list. On
 * three years of daily data that meant generating days 1..741 and drawing
 * 372..741 - a slice out of the MIDDLE of the history, with the newest year
 * never generated at all. Measured: a metric reading 110 drew a line holding 69
 * of those rows, and printed "the oldest 406 buckets are not drawn" when the
 * true figure was 727.
 *
 * Two separate wrongs: the picture disagreed with the number above it, and the
 * note explaining the gap was itself wrong. Walking back from `to` keeps the
 * NEWEST buckets, which is what anyone looking at a trend means, and counting
 * the whole range gives a `dropped` figure that is true.
 *
 * @returns {{keys: string[], dropped: number}} dropped is how many real buckets
 *   fall outside the window, not how many the generator happened to make.
 */
function bucketKeys(from, to, unit) {
  if (!from || !to || from > to) return { keys: [], dropped: 0 };

  const prev = (k) => {
    if (unit === "month") {
      const [y, m] = k.split("-").map(Number);
      return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    }
    return addDays(k, unit === "week" ? -7 : -1);
  };

  const start = unit === "month" ? monthKey(from) : unit === "week" ? mondayOf(from) : String(from).slice(0, 10);
  const end = unit === "month" ? monthKey(to) : unit === "week" ? mondayOf(to) : String(to).slice(0, 10);

  const keys = [];
  let k = end;
  // Newest first, up to the cap.
  while (k >= start && keys.length < BUCKET_MAX) {
    keys.push(k);
    k = prev(k);
  }
  // Whatever is still left below the cap is genuinely dropped. Counting it
  // rather than inferring it is what makes the note on the page true.
  let dropped = 0;
  while (k >= start) {
    dropped++;
    k = prev(k);
  }
  keys.reverse();
  return { keys, dropped };
}

const weekLabel = (key) => `week of ${key}`;

/**
 * Compute a metric: the number, the series behind the grouping, and the rows
 * behind the number.
 *
 * @returns {{ok:true, ...} | {ok:false, error:string}}
 */
export function computeMetric(db, definition, { asOf, currency = "USD", groupBy = "none", limit = DEFAULT_ROWS } = {}) {
  const compiled = compileDefinition(definition, { asOf });
  if (!compiled.ok) return compiled;

  const grouping = compileGrouping(compiled.source, groupBy);
  if (!grouping.ok) return grouping;

  const { source, measure } = compiled;
  const head = db
    .prepare(`${aggregateSql(source)} FROM ${source.from}${whereSql(compiled.where)}`)
    .get(...compiled.args);

  // The same window with no filters at all. This is the denominator a unit-dot
  // chart needs, and it is what makes "48 of 210" a sentence instead of "48".
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM ${source.from}${whereSql(compiled.windowWhere)}`)
    .get(...compiled.windowArgs).n;

  // Rows the window could not place. Reported rather than silently dropped: a
  // count over "the last 30 days" that quietly ignored 40 undated rows is the
  // kind of number that gets believed.
  let undated = 0;
  if (compiled.window.days !== null) {
    const clauses = [`(${source.dateCol} IS NULL OR ${source.dateCol} = '')`, ...compiled.filterWhere];
    undated = db
      .prepare(`SELECT COUNT(*) AS n FROM ${source.from} WHERE ${clauses.join(" AND ")}`)
      .get(...compiled.filterArgs).n;
  }

  const value = valueOf(measure, head);
  const count = Number(head?.n ?? 0);
  const grouped = grouping.kind === "none" ? { list: [], dropped: 0, otherGroups: 0 } : seriesFor(db, compiled, grouping, currency);
  const rows = rowsFor(db, compiled, currency, limit);

  return {
    ok: true,
    source: source.id,
    sourceLabel: source.label,
    noun: source.noun,
    nounPlural: source.nounPlural,
    measure: measure.id,
    isMoney: measure.id !== "count" && source.amountIsMoney,
    value,
    valueLabel: labelFor(measure, source, value, currency),
    count,
    total,
    // Rows that matched but carry no amount. Different from rows that did not
    // match, and reporting one as the other is how a sum quietly under-reports.
    missingAmount: measure.id === "count" ? 0 : Number(head?.missing ?? 0),
    undated,
    incomplete: compiled.incomplete,
    window: compiled.window.id,
    windowLabel: compiled.window.label,
    windowFrom: compiled.windowFrom,
    windowTo: compiled.windowTo,
    groupBy: grouping.id,
    groupLabel: grouping.label,
    definitionText: describeDefinition(compiled, { currency }),
    series: grouped.list,
    bucketsDropped: grouped.dropped,
    otherGroups: grouped.otherGroups,
    rows,
    rowsTruncated: count > rows.length,
    currency,
    asOf,
  };
}

/**
 * The grouped numbers. Time groupings are filled bucket by bucket so the drawn
 * spacing is real; a field grouping is ordered by its own value, biggest first,
 * with everything past SERIES_MAX summed into one honest "Other".
 */
function seriesFor(db, compiled, grouping, currency) {
  const { source, measure } = compiled;
  const tail = `${source.from}${whereSql(compiled.where)}`;
  const rows = db
    .prepare(`${aggregateSql(source, `${grouping.sql} AS gk, `)} FROM ${tail} GROUP BY gk`)
    .all(...compiled.args);

  // An empty bucket has a count of 0 and a sum of 0 — both are true of no rows.
  // It has NO average, so that one stays null and draws as a gap in the line.
  const point = (key, label, row) => {
    const value = row ? valueOf(measure, row) : measure.id === "avg" ? null : 0;
    return { key, label, value, count: row ? Number(row.n) : 0, valueLabel: labelFor(measure, source, value, currency) };
  };

  if (grouping.kind === "time") {
    const byKey = new Map(rows.map((r) => [String(r.gk ?? ""), r]));
    const present = [...byKey.keys()].filter((k) => k !== "").sort();
    if (!present.length) return { list: [], dropped: 0, otherGroups: 0 };

    const from = compiled.windowFrom ?? present[0];
    const to = compiled.windowTo ?? present[present.length - 1];
    // bucketKeys already keeps the NEWEST BUCKET_MAX and reports how many real
    // buckets fall outside that window, so nothing is trimmed a second time
    // here. Trimming twice is what produced a window from the middle of the
    // history and a "not drawn" count that was wrong by 321.
    const built = bucketKeys(from, to, grouping.unit);
    const keys = built.keys;
    const dropped = built.dropped;

    // A key the database produced that the generator did not is a disagreement
    // between the SQL bucket and the JS one. Append it rather than drop the rows
    // it carries: a visible extra point is a bug you can see.
    //
    // ⚠️ Only keys INSIDE the drawn window. One older than the window is not a
    // disagreement, it is a row the window deliberately excludes, and appending
    // it would put a lone ancient point on the left of an otherwise recent chart.
    const oldest = keys[0];
    for (const k of present) {
      if (!keys.includes(k) && (!oldest || k >= oldest)) keys.push(k);
    }
    keys.sort();
    const list = keys.map((k) =>
      point(k, grouping.unit === "week" ? weekLabel(k) : k, byKey.get(k) ?? null),
    );
    return { list, dropped, otherGroups: 0 };
  }

  const all = rows.map((r) => {
    const raw = r.gk == null || String(r.gk) === "" ? "" : String(r.gk);
    return point(raw, raw === "" ? "Not set" : raw, r);
  });
  all.sort((x, y) => (Number(y.value ?? 0) - Number(x.value ?? 0)) || String(x.label).localeCompare(String(y.label)));
  if (all.length <= SERIES_MAX) return { list: all, dropped: 0, otherGroups: 0 };

  const shown = all.slice(0, SERIES_MAX);
  const rest = all.slice(SERIES_MAX);
  const restCount = rest.reduce((t, p) => t + p.count, 0);
  // An "Other" bar for an AVERAGE would be an average of averages, which is not
  // a number anybody computed. It carries its row count and no value instead.
  const restValue = measure.id === "avg" ? null : rest.reduce((t, p) => t + Number(p.value ?? 0), 0);
  shown.push({
    key: "__other__",
    label: `Other (${rest.length} groups)`,
    value: restValue,
    count: restCount,
    valueLabel: labelFor(measure, source, restValue, currency),
  });
  return { list: shown, dropped: 0, otherGroups: rest.length };
}

/** The records the number was counted from. Newest first, capped. */
function rowsFor(db, compiled, currency, limit) {
  const { source } = compiled;
  const spec = source.row;
  // A LIST of metrics wants every headline number and none of the evidence, so
  // limit 0 means "no rows" rather than "the default number of rows".
  const asked = Number(limit);
  if (Number.isFinite(asked) && asked <= 0) return [];
  const cap = Math.min(Math.max(asked || DEFAULT_ROWS, 1), MAX_ROWS);
  const amt = spec.amountCol ? checkCol(spec.amountCol) : null;
  const sql = `SELECT ${checkCol(spec.idCol)} AS rid, ${checkCol(spec.labelCol)} AS rlabel,
      ${checkCol(spec.metaCol)} AS rmeta, ${checkCol(source.dateCol)} AS rat,
      ${amt ? amt : "NULL"} AS ramount, ${checkCol(spec.linkIdCol)} AS rlink
    FROM ${source.from}${whereSql(compiled.where)}
    ORDER BY ${source.dateCol} DESC, ${spec.idCol} DESC LIMIT ?`;
  return db.prepare(sql).all(...compiled.args, cap).map((r) => ({
    id: r.rid,
    label: r.rlabel,
    meta: r.rmeta,
    at: r.rat,
    amount: r.ramount,
    amountLabel: r.ramount == null ? null : source.amountIsMoney ? money(r.ramount, currency) : String(r.ramount),
    link: r.rlink ? spec.link : null,
    linkId: r.rlink,
  }));
}

/* ══ THE STORE ═════════════════════════════════════════════════════════════ */

function parseDefinition(rowJson, id) {
  try {
    const parsed = JSON.parse(rowJson);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // A definition that will not parse is a broken metric, not a broken page. It
    // comes back empty and the caller reports it with its value withheld.
    log.warn("metric definition could not be parsed", { id });
  }
  return { source: null, measure: null, window: null, filters: [] };
}

const rowToMetric = (row) => ({
  id: row.id,
  name: row.name,
  description: row.description ?? "",
  definition: parseDefinition(row.definition_json, row.id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * A name that is present, short enough, and not already taken.
 *
 * The duplicate check is done here rather than by a UNIQUE index so the user
 * gets a sentence naming the clash instead of a constraint error, which is the
 * same choice the segment table made.
 */
const NAMED_TABLES = new Set(["saved_metric", "saved_chart", "dashboard"]);

function checkName(db, table, name, exceptId = null) {
  // Belt and braces: the three callers pass literals, and this makes that true
  // rather than merely intended.
  if (!NAMED_TABLES.has(table)) throw new Error(`"${table}" is not a table names are checked in`);
  const clean = String(name ?? "").trim();
  if (!clean) return badv("give it a name first");
  if (clean.length > MAX_NAME_CHARS) return badv(`a name must be ${MAX_NAME_CHARS} characters or fewer`);
  const clash = db.prepare(`SELECT name FROM ${table} WHERE LOWER(name) = LOWER(?) AND id <> ?`).get(clean, exceptId ?? "");
  // Quote the name ALREADY SAVED, not the one just typed: "there is already one
  // called Open decisions" tells you where to look, and echoing your own words
  // back at you does not.
  if (clash) return badv(`there is already one called "${clash.name}"`);
  return okv({ name: clean });
}

/**
 * A definition good enough to SAVE. Stricter than one good enough to preview: a
 * filter with no value is fine while you type and is refused on the way to disk,
 * because a saved rule nobody can read back is the thing this feature exists to
 * prevent.
 */
function checkDefinition(definition, asOf) {
  const compiled = compileDefinition(definition, { asOf });
  if (!compiled.ok) return compiled;
  if (compiled.incomplete) {
    return badv(`${compiled.incomplete} filter${compiled.incomplete === 1 ? "" : "s"} still need a value`);
  }
  return okv({ compiled });
}

/**
 * Store only what the allowlist recognised.
 *
 * 🔴 The definition that goes to disk is REBUILT from the compiled rules, never
 * the object that arrived. An extra key on an incoming filter — a stray `sql`,
 * a `col`, anything — is dropped here and can never be read back and trusted by
 * a later version of this file.
 */
const cleanDefinition = (compiled) => ({
  source: compiled.source.id,
  measure: compiled.measure.id,
  window: compiled.window.id,
  filters: compiled.used.map((u) => ({
    field: u.field.id,
    op: u.opId,
    ...(u.value === undefined ? {} : { value: u.value }),
  })),
});

export function getMetric(db, id) {
  const row = db.prepare("SELECT * FROM saved_metric WHERE id = ?").get(String(id ?? ""));
  return row ? rowToMetric(row) : null;
}

/** Every saved metric with its current number. A broken one keeps its place. */
export function listMetrics(db, { asOf, currency }) {
  return db
    .prepare("SELECT * FROM saved_metric ORDER BY created_at, name")
    .all()
    .map((row) => {
      const metric = rowToMetric(row);
      const computed = computeMetric(db, metric.definition, { asOf, currency, groupBy: "none", limit: 0 });
      if (!computed.ok) return { ...metric, value: null, valueLabel: null, definitionText: null, error: computed.error };
      return {
        ...metric,
        value: computed.value,
        valueLabel: computed.valueLabel,
        count: computed.count,
        total: computed.total,
        definitionText: computed.definitionText,
        isMoney: computed.isMoney,
      };
    });
}

export function createMetric(db, { name, description, definition }, { asOf, currency }) {
  const named = checkName(db, "saved_metric", name);
  if (!named.ok) return named;
  const desc = String(description ?? "").trim();
  if (desc.length > MAX_DESCRIPTION_CHARS) return badv(`a description must be ${MAX_DESCRIPTION_CHARS} characters or fewer`);
  const checked = checkDefinition(definition, asOf);
  if (!checked.ok) return checked;

  const id = newId("met");
  const at = nowIso(db);
  db.prepare(
    "INSERT INTO saved_metric (id, name, description, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, named.name, desc, JSON.stringify(cleanDefinition(checked.compiled)), at, at);
  return okv({ metric: withNumber(db, getMetric(db, id), { asOf, currency }) });
}

const withNumber = (db, metric, { asOf, currency }) => {
  if (!metric) return metric;
  const computed = computeMetric(db, metric.definition, { asOf, currency, groupBy: "none", limit: 0 });
  return computed.ok
    ? { ...metric, value: computed.value, valueLabel: computed.valueLabel, definitionText: computed.definitionText, count: computed.count, total: computed.total, isMoney: computed.isMoney }
    : { ...metric, value: null, valueLabel: null, definitionText: null, error: computed.error };
};

/**
 * Change a metric's name, its description, its definition, or any mix.
 *
 * 🔴 CHANGING THE SOURCE CAN ORPHAN A CHART'S GROUPING. "By Priority" means
 * nothing once the metric counts invoices, and a chart left pointing at it would
 * come back as an error tile on somebody's dashboard days later. The update is
 * REFUSED and names the charts, so the person making the change is the person
 * who sees the problem.
 */
export function updateMetric(db, id, { name, description, definition }, { asOf, currency }) {
  const existing = getMetric(db, id);
  if (!existing) return badv("that metric does not exist any more");

  let nextName = existing.name;
  if (name !== undefined) {
    const named = checkName(db, "saved_metric", name, existing.id);
    if (!named.ok) return named;
    nextName = named.name;
  }

  let nextDesc = existing.description;
  if (description !== undefined) {
    nextDesc = String(description ?? "").trim();
    if (nextDesc.length > MAX_DESCRIPTION_CHARS) return badv(`a description must be ${MAX_DESCRIPTION_CHARS} characters or fewer`);
  }

  let nextDefinition = existing.definition;
  if (definition !== undefined) {
    const checked = checkDefinition(definition, asOf);
    if (!checked.ok) return checked;
    nextDefinition = cleanDefinition(checked.compiled);

    if (nextDefinition.source !== existing.definition.source) {
      const source = SOURCE_BY_ID.get(nextDefinition.source);
      const stranded = db
        .prepare("SELECT name, group_by FROM saved_chart WHERE metric_id = ?")
        .all(existing.id)
        .filter((c) => !compileGrouping(source, c.group_by).ok)
        .map((c) => c.name);
      if (stranded.length) {
        return badv(
          `changing the source would leave ${stranded.length === 1 ? "this chart" : "these charts"} grouped by something ${source.label} do not have: ${stranded.join(", ")}. Change or delete ${stranded.length === 1 ? "it" : "them"} first.`,
        );
      }
    }
  }

  db.prepare("UPDATE saved_metric SET name = ?, description = ?, definition_json = ?, updated_at = ? WHERE id = ?").run(
    nextName,
    nextDesc,
    JSON.stringify(nextDefinition),
    nowIso(db),
    existing.id,
  );
  return okv({ metric: withNumber(db, getMetric(db, existing.id), { asOf, currency }) });
}

/** Refused while a chart still uses it. The cascade is a backstop, not a policy. */
export function deleteMetric(db, id) {
  const existing = getMetric(db, id);
  if (!existing) return badv("that metric does not exist any more");
  const users = db.prepare("SELECT name FROM saved_chart WHERE metric_id = ? ORDER BY name").all(existing.id);
  if (users.length) {
    return badv(
      `"${existing.name}" is used by ${users.length === 1 ? "a chart" : `${users.length} charts`}: ${users.map((c) => c.name).join(", ")}. Delete ${users.length === 1 ? "it" : "them"} first.`,
    );
  }
  db.prepare("DELETE FROM saved_metric WHERE id = ?").run(existing.id);
  return okv({ id: existing.id, name: existing.name });
}

/* ── charts ────────────────────────────────────────────────────────────── */

const rowToChart = (row) => ({
  id: row.id,
  name: row.name,
  metricId: row.metric_id,
  shape: row.shape,
  groupBy: row.group_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function getChart(db, id) {
  const row = db.prepare("SELECT * FROM saved_chart WHERE id = ?").get(String(id ?? ""));
  return row ? rowToChart(row) : null;
}

export function listCharts(db) {
  return db
    .prepare(
      "SELECT c.*, m.name AS metric_name FROM saved_chart c JOIN saved_metric m ON m.id = c.metric_id ORDER BY c.created_at, c.name",
    )
    .all()
    .map((row) => ({ ...rowToChart(row), metricName: row.metric_name }));
}

/** Shape and grouping are checked against the METRIC'S OWN source, never in general. */
function checkChartShape(db, metricId, shape, groupBy) {
  const metric = getMetric(db, metricId);
  if (!metric) return badv("pick a metric for this chart");
  const source = SOURCE_BY_ID.get(metric.definition.source);
  if (!source) return badv("that metric's definition cannot be read, so a chart cannot be drawn from it");
  if (!SHAPE_IDS.has(String(shape))) return badv(`"${String(shape)}" is not a shape`);
  const grouping = compileGrouping(source, groupBy);
  if (!grouping.ok) return grouping;
  // 🔴 SHAPE AND GROUPING ARE ONE DECISION, so they are checked together.
  // A unit-dot chart draws one share of one whole; cut into groups it is a grid
  // of grids, which is not a thing this can draw. A line or a bar with no
  // grouping is a single point — a big number wearing a chart, which is worse
  // than a big number. Both are refused here rather than drawn misleadingly.
  if (String(shape) === "unit-dot" && grouping.kind !== "none") {
    return badv("a unit-dot chart shows one share of a whole, so it cannot be grouped");
  }
  if (String(shape) !== "unit-dot" && grouping.kind === "none") {
    return badv(`a ${shape} chart needs a grouping — with none there is a single value, which is a number and not a chart`);
  }
  return okv({ metric, shape: String(shape), groupBy: grouping.id });
}

export function createChart(db, { name, metricId, shape, groupBy }) {
  const named = checkName(db, "saved_chart", name);
  if (!named.ok) return named;
  const checked = checkChartShape(db, metricId, shape, groupBy ?? "none");
  if (!checked.ok) return checked;

  const id = newId("cht");
  const at = nowIso(db);
  db.prepare(
    "INSERT INTO saved_chart (id, name, metric_id, shape, group_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(id, named.name, checked.metric.id, checked.shape, checked.groupBy, at, at);
  return okv({ chart: { ...getChart(db, id), metricName: checked.metric.name } });
}

export function updateChart(db, id, { name, metricId, shape, groupBy }) {
  const existing = getChart(db, id);
  if (!existing) return badv("that chart does not exist any more");

  let nextName = existing.name;
  if (name !== undefined) {
    const named = checkName(db, "saved_chart", name, existing.id);
    if (!named.ok) return named;
    nextName = named.name;
  }

  const checked = checkChartShape(
    db,
    metricId === undefined ? existing.metricId : metricId,
    shape === undefined ? existing.shape : shape,
    groupBy === undefined ? existing.groupBy : groupBy,
  );
  if (!checked.ok) return checked;

  db.prepare("UPDATE saved_chart SET name = ?, metric_id = ?, shape = ?, group_by = ?, updated_at = ? WHERE id = ?").run(
    nextName,
    checked.metric.id,
    checked.shape,
    checked.groupBy,
    nowIso(db),
    existing.id,
  );
  return okv({ chart: { ...getChart(db, existing.id), metricName: checked.metric.name } });
}

export function deleteChart(db, id) {
  const existing = getChart(db, id);
  if (!existing) return badv("that chart does not exist any more");
  // dashboard_chart cascades, so a deleted chart leaves no hole on a dashboard.
  db.prepare("DELETE FROM saved_chart WHERE id = ?").run(existing.id);
  return okv({ id: existing.id, name: existing.name });
}

/** One chart's numbers AND the rows behind them. */
export function computeChart(db, id, { asOf, currency, limit = DEFAULT_ROWS }) {
  const chart = getChart(db, id);
  if (!chart) return badv("that chart does not exist any more");
  const metric = getMetric(db, chart.metricId);
  if (!metric) return badv("the metric behind that chart is gone");
  const computed = computeMetric(db, metric.definition, { asOf, currency, groupBy: chart.groupBy, limit });
  if (!computed.ok) return badv(computed.error);
  const { ok: _ignored, ...rest } = computed;
  return okv({
    chart: { ...chart, metricName: metric.name, metricDescription: metric.description },
    result: rest,
  });
}

/* ── dashboards ────────────────────────────────────────────────────────── */

const chartIdsFor = (db, dashboardId) =>
  db
    .prepare("SELECT chart_id FROM dashboard_chart WHERE dashboard_id = ? ORDER BY position")
    .all(dashboardId)
    .map((r) => r.chart_id);

const rowToDashboard = (db, row) => ({
  id: row.id,
  name: row.name,
  chartIds: chartIdsFor(db, row.id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export function getDashboard(db, id) {
  const row = db.prepare("SELECT * FROM dashboard WHERE id = ?").get(String(id ?? ""));
  return row ? rowToDashboard(db, row) : null;
}

export function listDashboards(db) {
  return db
    .prepare("SELECT * FROM dashboard ORDER BY created_at, name")
    .all()
    .map((row) => rowToDashboard(db, row));
}

export function createDashboard(db, { name, chartIds }) {
  const named = checkName(db, "dashboard", name);
  if (!named.ok) return named;
  const id = newId("dsh");
  const at = nowIso(db);
  const placed = chartIds === undefined ? okv({ ids: [] }) : orderedCharts(db, chartIds);
  if (!placed.ok) return placed;

  tx(db, () => {
    db.prepare("INSERT INTO dashboard (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, named.name, at, at);
    writeOrder(db, id, placed.ids);
  });
  return okv({ dashboard: getDashboard(db, id) });
}

/** Every id must be a real chart, and each may appear once. Order is the payload. */
function orderedCharts(db, chartIds) {
  if (!Array.isArray(chartIds)) return badv("the chart list must be a list");
  if (chartIds.length > MAX_CHARTS_PER_DASHBOARD) {
    return badv(`a dashboard can hold at most ${MAX_CHARTS_PER_DASHBOARD} charts`);
  }
  const ids = [];
  for (const raw of chartIds) {
    const cid = String(raw ?? "");
    if (ids.includes(cid)) return badv("a chart can only appear once on a dashboard");
    if (!getChart(db, cid)) return badv("one of those charts does not exist any more");
    ids.push(cid);
  }
  return okv({ ids });
}

function writeOrder(db, dashboardId, ids) {
  db.prepare("DELETE FROM dashboard_chart WHERE dashboard_id = ?").run(dashboardId);
  const ins = db.prepare("INSERT INTO dashboard_chart (dashboard_id, chart_id, position) VALUES (?, ?, ?)");
  ids.forEach((cid, i) => ins.run(dashboardId, cid, i));
}

export function updateDashboard(db, id, { name, chartIds }) {
  const existing = getDashboard(db, id);
  if (!existing) return badv("that dashboard does not exist any more");

  let nextName = existing.name;
  if (name !== undefined) {
    const named = checkName(db, "dashboard", name, existing.id);
    if (!named.ok) return named;
    nextName = named.name;
  }

  let placed = null;
  if (chartIds !== undefined) {
    placed = orderedCharts(db, chartIds);
    if (!placed.ok) return placed;
  }

  tx(db, () => {
    db.prepare("UPDATE dashboard SET name = ?, updated_at = ? WHERE id = ?").run(nextName, nowIso(db), existing.id);
    if (placed) writeOrder(db, existing.id, placed.ids);
  });
  return okv({ dashboard: getDashboard(db, existing.id) });
}

export function deleteDashboard(db, id) {
  const existing = getDashboard(db, id);
  if (!existing) return badv("that dashboard does not exist any more");
  db.prepare("DELETE FROM dashboard WHERE id = ?").run(existing.id);
  return okv({ id: existing.id, name: existing.name });
}

/**
 * A dashboard with every chart on it computed, in order.
 *
 * One chart that cannot compute does not take the dashboard down: it comes back
 * with `error` in its place, so the other tiles still answer.
 */
export function computeDashboard(db, id, { asOf, currency, limit = DEFAULT_ROWS }) {
  const dashboard = getDashboard(db, id);
  if (!dashboard) return badv("that dashboard does not exist any more");
  const charts = dashboard.chartIds.map((cid) => {
    const computed = computeChart(db, cid, { asOf, currency, limit });
    if (!computed.ok) return { chart: getChart(db, cid), result: null, error: computed.error };
    return { chart: computed.chart, result: computed.result, error: null };
  });
  return okv({ dashboard, charts });
}

/* ══ THE ROUTES ════════════════════════════════════════════════════════════
 *
 * Thin by design. Every one of them guards the ids it needs and hands the work
 * to a function above; none of them assembles SQL, and none of them decides
 * anything the store does not. They are merged into the dispatcher in
 * src/ui/server.mjs alongside the other decisions routes, so each inherits the
 * per-launch token, the loopback Host check and the `ok:false -> HTTP 400` rule
 * without restating any of it.
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

/** The two things every route below needs before it can compute anything. */
const context = (db) => ({ asOf: asOfFor(db), currency: getSettings(db).currency ?? "USD" });

export const metricsRoutes = {
  /**
   * Everything this page draws with: the saved metrics with their current
   * numbers, the saved charts, the dashboards in order, and the vocabulary the
   * editor builds its menus from.
   *
   * The vocabulary rides along for the same reason the segments page gets its
   * fields from the server: a menu offering something the server would refuse is
   * a dead end the user finds by walking into it.
   */
  async decisionsMetrics() {
    return withDb((db) => {
      const { asOf, currency } = context(db);
      return ok({
        metrics: listMetrics(db, { asOf, currency }),
        charts: listCharts(db),
        dashboards: listDashboards(db),
        ...vocabulary(),
        accounts: db.prepare("SELECT COUNT(*) n FROM account").get().n,
        decisions: db.prepare("SELECT COUNT(*) n FROM decision").get().n,
        currency,
        asOf,
      });
    });
  },

  /**
   * Compute a metric — saved by `id`, or an unsaved `definition` straight from
   * the editor. One route for both on purpose: the number under the editor and
   * the number on the dashboard have to come from one function, or a metric can
   * be saved showing one figure and read back showing another.
   */
  async decisionsMetricCompute({ body }) {
    return withDb((db) => {
      const { asOf, currency } = context(db);
      let definition = body?.definition;
      if (definition === undefined) {
        if (!body?.id) return bad("which metric?");
        const metric = getMetric(db, body.id);
        if (!metric) return bad("that metric does not exist any more");
        definition = metric.definition;
      }
      const r = computeMetric(db, definition, {
        asOf,
        currency,
        groupBy: body?.groupBy ?? "none",
        limit: body?.limit,
      });
      if (!r.ok) return bad(r.error);
      return r;
    });
  },

  async decisionsMetricCreate({ body }) {
    return withDb((db) =>
      createMetric(db, { name: body?.name, description: body?.description, definition: body?.definition }, context(db)),
    );
  },

  async decisionsMetricUpdate({ body }) {
    if (!body?.id) return bad("which metric?");
    return withDb((db) =>
      updateMetric(
        db,
        body.id,
        { name: body.name, description: body.description, definition: body.definition },
        context(db),
      ),
    );
  },

  async decisionsMetricDelete({ body }) {
    if (!body?.id) return bad("which metric?");
    return withDb((db) => deleteMetric(db, body.id));
  },

  async decisionsChartCreate({ body }) {
    return withDb((db) =>
      createChart(db, { name: body?.name, metricId: body?.metricId, shape: body?.shape, groupBy: body?.groupBy }),
    );
  },

  async decisionsChartUpdate({ body }) {
    if (!body?.id) return bad("which chart?");
    return withDb((db) =>
      updateChart(db, body.id, { name: body.name, metricId: body.metricId, shape: body.shape, groupBy: body.groupBy }),
    );
  },

  async decisionsChartDelete({ body }) {
    if (!body?.id) return bad("which chart?");
    return withDb((db) => deleteChart(db, body.id));
  },

  /** One chart's numbers and the rows behind them. */
  async decisionsChartCompute({ body }) {
    if (!body?.id) return bad("which chart?");
    return withDb((db) => computeChart(db, body.id, { ...context(db), limit: body?.limit }));
  },

  /** One dashboard, with every chart on it computed in its saved order. */
  async decisionsDashboard({ body }) {
    if (!body?.id) return bad("which dashboard?");
    return withDb((db) => computeDashboard(db, body.id, { ...context(db), limit: body?.limit }));
  },

  async decisionsDashboardCreate({ body }) {
    return withDb((db) => createDashboard(db, { name: body?.name, chartIds: body?.chartIds }));
  },

  /** Rename, reorder, add or remove: the chart list IS the order. */
  async decisionsDashboardUpdate({ body }) {
    if (!body?.id) return bad("which dashboard?");
    return withDb((db) => updateDashboard(db, body.id, { name: body.name, chartIds: body.chartIds }));
  },

  async decisionsDashboardDelete({ body }) {
    if (!body?.id) return bad("which dashboard?");
    return withDb((db) => deleteDashboard(db, body.id));
  },
};

export default metricsRoutes;
