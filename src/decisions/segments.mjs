// Saved segments: a named rule over the customer list.
//
// 🔴 THE ONE RULE THIS FILE EXISTS TO ENFORCE. The criteria come from the user -
// typed into a builder, or written by a model reading a sentence the user typed.
// They are stored as STRUCTURED data and compiled here into a parameterised
// query against a FIXED allowlist. A field name that is not a key of
// `SEGMENT_FIELDS` and an operator that is not a key of that field's operator
// table are REFUSED, not ignored: the caller gets an error naming what it asked
// for. No value ever reaches SQL except through a `?` placeholder.
//
// The only strings interpolated into SQL are `field.col` values, which are
// written in this file and never derived from input. `SAFE_COL` re-checks that
// at compile time anyway, because the day somebody adds a twelfth field is the
// day that invariant stops being obvious.
//
// WHY THE MATCHING LIVES ON THE SERVER AND NOT IN THE PAGE. The page used to
// match locally, which meant two implementations of the same rule - the one that
// counted and the one that would eventually save. They can only drift apart, and
// a segment whose preview count differs from its saved count is exactly the
// failure this screen was built to prevent. One matcher, here, used by the
// preview, by the saved list and by the description reader alike.
import { money } from "./format.mjs";
import { LABELS } from "./situations.mjs";
import { nowIso, getSettings } from "./db.mjs";
import { segmentId, callId } from "./ids.mjs";
import { parseBriefText } from "./schema.mjs";
import { editableThresholds } from "./rules.mjs";
import { complete as defaultComplete } from "../routing/execute.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/segments");

/* ══ THE ALLOWLIST ═══════════════════════════════════════════════════════════
 *
 * Exactly the fields `decisionsCustomers` returns, and nothing else.
 *
 * industry, segment, seats_purchased, tenure and the contact list exist on an
 * account too, but they are only surfaced one customer at a time. Adding them
 * here would be easy and is deliberately not done: the page shows this list as
 * the field menu, so anything in it must be countable for every customer in one
 * query.
 *
 * `col` is the alias the base query below projects. `needsRun` marks the three
 * that are empty until an analysis has run - a rule on them matches nobody and
 * the page warns rather than looking broken.
 */
export const SEGMENT_FIELDS = [
  { id: "name", label: "Name", type: "text", col: "name" },
  { id: "id", label: "Customer ID", type: "text", col: "id" },
  { id: "arr", label: "ARR", type: "money", col: "arr" },
  { id: "plan", label: "Plan", type: "text", col: "plan", choices: "plans" },
  { id: "owner", label: "Owner", type: "text", col: "owner", choices: "owners" },
  { id: "label", label: "State", type: "enum", col: "label", choices: "labels", needsRun: true },
  { id: "daysToRenewal", label: "Days to renewal", type: "number", col: "daysToRenewal" },
  { id: "renewalDate", label: "Renewal date", type: "date", col: "renewalDate" },
  { id: "openDecisions", label: "Open decisions", type: "number", col: "openDecisions" },
  { id: "watching", label: "Watch items", type: "number", col: "watching", needsRun: true },
  { id: "staleData", label: "Data is stale", type: "bool", col: "staleData", needsRun: true },
];

const FIELD_BY_ID = new Map(SEGMENT_FIELDS.map((f) => [f.id, f]));

/** Belt and braces: a column alias is ours, so it can only ever look like this. */
const SAFE_COL = /^[A-Za-z_][A-Za-z0-9_]*$/;

const blankSql = (c) => `(${c} IS NULL OR ${c} = '')`;
const notBlankSql = (c) => `(${c} IS NOT NULL AND ${c} <> '')`;

/**
 * Text comparisons are case-insensitive on both sides, matching how a person
 * reads "plan is enterprise" - and matching what the page used to do locally, so
 * counts did not change when the matching moved here.
 */
const TEXT_OPS = {
  is: { label: "is", sql: (c) => `LOWER(COALESCE(${c}, '')) = LOWER(?)` },
  isnot: { label: "is not", sql: (c) => `LOWER(COALESCE(${c}, '')) <> LOWER(?)` },
  contains: { label: "contains", sql: (c) => `INSTR(LOWER(COALESCE(${c}, '')), LOWER(?)) > 0` },
  notcontains: { label: "does not contain", sql: (c) => `INSTR(LOWER(COALESCE(${c}, '')), LOWER(?)) = 0` },
  blank: { label: "is blank", sql: blankSql, valueless: true },
  notblank: { label: "is not blank", sql: notBlankSql, valueless: true },
};

/** `cmp` is a literal from this file. It is never assembled from input. */
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

const ENUM_OPS = {
  is: TEXT_OPS.is,
  isnot: TEXT_OPS.isnot,
  blank: { label: "has none", sql: blankSql, valueless: true },
  notblank: { label: "has one", sql: notBlankSql, valueless: true },
};

const BOOL_OPS = {
  true: { label: "is yes", sql: (c) => `${c} = 1`, valueless: true },
  false: { label: "is no", sql: (c) => `${c} = 0`, valueless: true },
};

/**
 * Dates compare on the day part only.
 *
 * ⚠️ The NULL guard is load-bearing. `COALESCE(x, '') < '2026-01-01'` is TRUE
 * for every customer with no renewal date, because the empty string sorts before
 * every date - so "renews before March" would silently include everyone who has
 * no renewal at all.
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

export const SEGMENT_OPS = {
  text: TEXT_OPS,
  money: NUMBER_OPS,
  number: NUMBER_OPS,
  enum: ENUM_OPS,
  bool: BOOL_OPS,
  date: DATE_OPS,
};

/** The vocabulary the page builds its selects from, so the two cannot drift. */
export function fieldVocabulary() {
  return {
    fields: SEGMENT_FIELDS.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      choices: f.choices ?? null,
      needsRun: !!f.needsRun,
    })),
    ops: Object.fromEntries(
      Object.entries(SEGMENT_OPS).map(([type, table]) => [
        type,
        Object.entries(table).map(([id, op]) => [id, op.label, !op.valueless]),
      ]),
    ),
  };
}

/* ══ THE BASE QUERY ════════════════════════════════════════════════════════
 *
 * One row per account with every allowlisted field projected under its own
 * alias, so a compiled rule is a plain comparison and the run subqueries are
 * evaluated once per account rather than once per rule.
 *
 * The three run-derived columns bind the LATEST run id. When there is no run
 * that id is null, every subquery returns 0 or NULL, and the result matches what
 * `decisionsCustomers` shows for an un-analysed workspace: no label, nothing
 * watched, nothing stale. Same numbers from two code paths, on purpose.
 *
 * `SUBSTR(..., 1, 10)` inside julianday() forces a whole-day difference, which
 * is what `daysBetween` in format.mjs computes. Without it a renewal_date
 * carrying a time would produce a fractional day and CAST would truncate it the
 * wrong way for dates in the past.
 */
const OPEN_STATUSES_SQL = `('new', 'accepted', 'in_progress', 'waiting', 'snoozed')`;

const BASE_SELECT = `SELECT
    a.id                                                        AS id,
    a.name                                                      AS name,
    a.arr                                                       AS arr,
    a.plan                                                      AS plan,
    a.owner                                                     AS owner,
    a.renewal_date                                              AS renewalDate,
    CAST(julianday(SUBSTR(a.renewal_date, 1, 10)) - julianday(?) AS INTEGER) AS daysToRenewal,
    (SELECT rs.label FROM account_run_state rs WHERE rs.run_id = ? AND rs.account_id = a.id) AS label,
    (SELECT COUNT(*) FROM decision d WHERE d.account_id = a.id AND d.status IN ${OPEN_STATUSES_SQL}) AS openDecisions,
    (SELECT COUNT(*) FROM watch w WHERE w.run_id = ? AND w.account_id = a.id) AS watching,
    ((SELECT COUNT(*) FROM signal sg WHERE sg.run_id = ? AND sg.account_id = a.id AND sg.kind = 'data_stale') > 0) AS staleData
  FROM account a`;

/** Caps that turn a pathological payload into a sentence instead of a 500. */
const MAX_GROUPS = 12;
const MAX_RULES_PER_GROUP = 20;
const MAX_NAME_CHARS = 80;
const MAX_DESCRIPTION_CHARS = 600;

/**
 * Compile ONE rule.
 *
 * @returns {{ok: true, sql?: string, args?: any[], skip?: boolean} | {ok: false, error: string}}
 *   `skip: true` means the rule is incomplete - a value-taking operator with no
 *   value. Those are counted and reported, never guessed at and never saved.
 */
function compileRule(rule) {
  const wanted = String(rule?.field ?? "");
  const field = FIELD_BY_ID.get(wanted);
  if (!field) return { ok: false, error: `"${wanted}" is not a field a segment can use` };
  if (!SAFE_COL.test(field.col)) throw new Error(`segment field ${field.id} has an unusable column alias`);

  const table = SEGMENT_OPS[field.type];
  const wantedOp = String(rule?.op ?? "");
  const op = Object.hasOwn(table, wantedOp) ? table[wantedOp] : null;
  if (!op) return { ok: false, error: `"${field.label}" cannot be compared with "${wantedOp}"` };

  if (op.valueless) return { ok: true, sql: op.sql(field.col), args: [] };

  const raw = String(rule?.value ?? "").trim();
  if (raw === "") return { ok: true, skip: true };

  if (op.number) {
    const n = Number(raw);
    // Not an error: the user is mid-type. "12a" is no more a number than "" is.
    if (!Number.isFinite(n)) return { ok: true, skip: true };
    return { ok: true, sql: op.sql(field.col), args: [n] };
  }
  return { ok: true, sql: op.sql(field.col), args: [raw] };
}

/**
 * Compile the whole criteria tree: every GROUP must match, and inside a group
 * any ONE rule is enough.
 *
 * @param {Array<{rules: Array}>} groups
 * @returns {{ok: true, where: string, args: any[], active: number, incomplete: number}
 *          | {ok: false, error: string}}
 */
export function compileCriteria(groups) {
  if (!Array.isArray(groups)) return { ok: false, error: "the criteria must be a list of groups" };
  if (groups.length > MAX_GROUPS) return { ok: false, error: `a segment can have at most ${MAX_GROUPS} AND groups` };

  const parts = [];
  const args = [];
  let active = 0;
  let incomplete = 0;

  for (const group of groups) {
    const rules = Array.isArray(group?.rules) ? group.rules : null;
    if (!rules) return { ok: false, error: "every group must carry a list of rules" };
    if (rules.length > MAX_RULES_PER_GROUP) {
      return { ok: false, error: `a group can have at most ${MAX_RULES_PER_GROUP} OR rules` };
    }

    const ors = [];
    const orArgs = [];
    for (const rule of rules) {
      const c = compileRule(rule);
      if (!c.ok) return c;
      if (c.skip) {
        incomplete++;
        continue;
      }
      ors.push(c.sql);
      orArgs.push(...c.args);
    }
    // A group whose rules are all incomplete constrains nothing yet. Dropping it
    // is what lets the preview stay live while a value is being typed.
    if (!ors.length) continue;
    parts.push(ors.length === 1 ? ors[0] : `(${ors.join(" OR ")})`);
    args.push(...orArgs);
    active++;
  }

  return { ok: true, where: parts.join(" AND "), args, active, incomplete };
}

/** The id of the most recent run, or null. The three run-derived fields need it. */
function lastRunId(db) {
  return db.prepare("SELECT id FROM run ORDER BY started_at DESC LIMIT 1").get()?.id ?? null;
}

/**
 * Run a compiled rule and return the matching accounts, in the shape
 * `decisionsCustomers` returns so the page prints one kind of customer row.
 */
export function matchAccounts(db, compiled, { asOf, currency }) {
  const runId = lastRunId(db);
  const sql = `SELECT * FROM (${BASE_SELECT})${compiled.where ? ` WHERE ${compiled.where}` : ""}`;
  const rows = db.prepare(sql).all(asOf, runId, runId, runId, ...compiled.args);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    arr: r.arr,
    arrLabel: money(r.arr, currency),
    plan: r.plan,
    owner: r.owner,
    renewalDate: r.renewalDate,
    daysToRenewal: r.daysToRenewal,
    label: r.label,
    labelText: LABELS[r.label] ?? null,
    openDecisions: r.openDecisions,
    watching: r.watching,
    staleData: !!r.staleData,
  }));
}

/**
 * Count a rule and return a sample, without saving anything.
 *
 * ⭐ THE SAMPLE IS A SLICE OF THE MATCHED SET, never a second query. A count and
 * a list produced by two statements can disagree, and a preview whose number and
 * whose names contradict each other is worse than no preview.
 */
export function previewCriteria(db, groups, { asOf, currency, limit = 8 }) {
  const compiled = compileCriteria(groups);
  if (!compiled.ok) return compiled;

  const matched = matchAccounts(db, compiled, { asOf, currency });
  const total = db.prepare("SELECT COUNT(*) n FROM account").get().n;
  const arr = matched.reduce((t, c) => t + (Number.isFinite(Number(c.arr)) ? Number(c.arr) : 0), 0);
  const openDecisions = matched.reduce((t, c) => t + (Number(c.openDecisions) || 0), 0);
  const cap = Math.min(Math.max(Number(limit) || 8, 1), 200);

  return {
    ok: true,
    count: matched.length,
    total,
    arr,
    arrLabel: money(arr, currency),
    openDecisions,
    sample: matched.slice(0, cap),
    truncated: matched.length > cap,
    active: compiled.active,
    incomplete: compiled.incomplete,
  };
}

/* ══ THE STORE ═════════════════════════════════════════════════════════════ */

function rowToSegment(row) {
  let groups = [];
  try {
    const parsed = JSON.parse(row.criteria_json);
    if (Array.isArray(parsed?.groups)) groups = parsed.groups;
  } catch {
    // A criteria blob that will not parse is a broken segment, not a broken
    // page: it comes back with no rules and the caller reports zero matches.
    log.warn("segment criteria could not be parsed", { id: row.id });
  }
  return { id: row.id, name: row.name, groups, createdAt: row.created_at, updatedAt: row.updated_at };
}

/** Every saved segment, each with its live count. */
export function listSegments(db, { asOf, currency }) {
  return db
    .prepare("SELECT * FROM segment ORDER BY created_at, name")
    .all()
    .map((row) => {
      const seg = rowToSegment(row);
      const compiled = compileCriteria(seg.groups);
      // A stored rule naming a field that no longer exists must not take the
      // list down. It is shown with its count withheld and the reason attached.
      if (!compiled.ok) return { ...seg, count: null, arr: null, arrLabel: null, error: compiled.error };
      const matched = matchAccounts(db, compiled, { asOf, currency });
      const arr = matched.reduce((t, c) => t + (Number.isFinite(Number(c.arr)) ? Number(c.arr) : 0), 0);
      return {
        ...seg,
        count: matched.length,
        arr,
        arrLabel: money(arr, currency),
        openDecisions: matched.reduce((t, c) => t + (Number(c.openDecisions) || 0), 0),
      };
    });
}

export function getSegment(db, id) {
  const row = db.prepare("SELECT * FROM segment WHERE id = ?").get(String(id ?? ""));
  return row ? rowToSegment(row) : null;
}

/** Shared by create and update: a name and a rule that are both actually usable. */
function checkName(db, name, exceptId = null) {
  const clean = String(name ?? "").trim();
  if (!clean) return { ok: false, error: "give the segment a name first" };
  if (clean.length > MAX_NAME_CHARS) return { ok: false, error: `a segment name must be ${MAX_NAME_CHARS} characters or fewer` };
  const clash = db
    .prepare("SELECT id FROM segment WHERE LOWER(name) = LOWER(?) AND id <> ?")
    .get(clean, exceptId ?? "");
  if (clash) return { ok: false, error: `there is already a segment called "${clean}"` };
  return { ok: true, name: clean };
}

function checkCriteria(groups) {
  const compiled = compileCriteria(groups);
  if (!compiled.ok) return compiled;
  // 🔴 Refused on the server as well as in the page. A rule with no value is a
  // rule nobody can read back, and a segment with no rule is the whole customer
  // list wearing a name - which is how a "segment" starts being trusted as a
  // filter that filters nothing.
  if (compiled.incomplete) {
    return { ok: false, error: `${compiled.incomplete} rule${compiled.incomplete === 1 ? "" : "s"} still need a value` };
  }
  if (!compiled.active) {
    return { ok: false, error: "add at least one complete rule - a segment with no rule is the whole customer list" };
  }
  return { ok: true };
}

export function createSegment(db, { name, groups }) {
  const named = checkName(db, name);
  if (!named.ok) return named;
  const checked = checkCriteria(groups);
  if (!checked.ok) return checked;

  const id = segmentId();
  const at = nowIso(db);
  db.prepare("INSERT INTO segment (id, name, criteria_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    named.name,
    JSON.stringify({ groups }),
    at,
    at,
  );
  return { ok: true, segment: getSegment(db, id) };
}

/** Update a segment's name, its rule, or both. Renaming sends only a name. */
export function updateSegment(db, id, { name, groups }) {
  const existing = getSegment(db, id);
  if (!existing) return { ok: false, error: "that segment does not exist any more" };

  let nextName = existing.name;
  if (name !== undefined) {
    const named = checkName(db, name, existing.id);
    if (!named.ok) return named;
    nextName = named.name;
  }

  let nextGroups = existing.groups;
  if (groups !== undefined) {
    const checked = checkCriteria(groups);
    if (!checked.ok) return checked;
    nextGroups = groups;
  }

  db.prepare("UPDATE segment SET name = ?, criteria_json = ?, updated_at = ? WHERE id = ?").run(
    nextName,
    JSON.stringify({ groups: nextGroups }),
    nowIso(db),
    existing.id,
  );
  return { ok: true, segment: getSegment(db, existing.id) };
}

export function deleteSegment(db, id) {
  const existing = getSegment(db, id);
  if (!existing) return { ok: false, error: "that segment does not exist any more" };
  db.prepare("DELETE FROM segment WHERE id = ?").run(existing.id);
  return { ok: true, id: existing.id, name: existing.name };
}

/* ══ WHAT THE WORKSPACE ACTUALLY CONTAINS ══════════════════════════════════
 *
 * The values a rule is allowed to name. Both readers below - the phrase list and
 * the model - are held to it: neither may produce `Plan is Platinum` in a
 * workspace that has no Platinum plan. A phrase that cannot be grounded comes
 * back as a note saying so, which is information; a rule matching nobody is not.
 */
export function groundingFor(db) {
  const distinct = (rows) => rows.map((r) => r.v).filter((v) => v != null && String(v).trim() !== "").map(String);
  return {
    plans: distinct(db.prepare("SELECT DISTINCT plan v FROM account ORDER BY plan").all()),
    owners: distinct(db.prepare("SELECT DISTINCT owner v FROM account ORDER BY owner").all()),
    labels: LABELS,
    renewalNearDays: editableThresholds(getSettings(db)).find((t) => t.id === "renewal_near")?.current ?? null,
  };
}

/* ══ THE PHRASE READER ═════════════════════════════════════════════════════
 *
 * 🔶 NOT A MODEL. A fixed list of patterns with no network call, so the
 * description box still works when there is no model, no key and no internet -
 * which is the state this product ships in until somebody connects a gateway.
 *
 * It is also the floor under the model path: when the model answers with
 * nonsense, this is what the user gets instead of an error.
 */

const STOPWORDS = new Set([
  "a","an","the","and","or","of","in","on","at","to","for","with","that","this","these","those",
  "is","are","was","were","be","been","am","do","does","did","has","have","had","who","whose",
  "show","me","list","find","get","all","any","some","my","our","their","them","they","it",
  "customer","customers","account","accounts","client","clients","company","companies",
  "please","just","only","also","where","which","what","when","than","then","not","no",
  "one","two","three","most","more","less","other","others","still","yet","very",
]);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** "$50k" -> 50000, "1.5m" -> 1500000, "50,000" -> 50000. */
function parseAmount(digits, suffix) {
  const n = Number(String(digits).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const s = String(suffix ?? "").toLowerCase();
  if (s === "k") return n * 1000;
  if (s === "m") return n * 1000000;
  return n;
}

/** Day counts for "in N weeks/months". A month is read as 30 days and it says so. */
function toDays(n, unit) {
  const k = Number(n);
  if (!Number.isFinite(k)) return null;
  const u = String(unit ?? "day").toLowerCase();
  if (u.startsWith("week")) return k * 7;
  if (u.startsWith("month")) return k * 30;
  return k;
}

/**
 * Turn a sentence into criteria with no model at all.
 *
 * @returns {{rules: Array, phrases: string[], ignored: string[], notes: string[]}}
 */
export function readDescription(text, vocab) {
  const rules = [];
  const phrases = [];
  const notes = [];
  // Matched text is blanked out of `rest`; whatever survives is what was ignored.
  let rest = ` ${String(text ?? "").toLowerCase()} `;

  const eat = (re, make) => {
    rest = rest.replace(re, (...args) => {
      const groups = args.slice(0, -2); // drop offset and the whole string
      const rule = make(...groups);
      if (!rule) return groups[0]; // grounded nothing: leave the words visible
      rules.push(rule);
      phrases.push(groups[0].trim());
      return " ";
    });
  };

  // 1. Renewal windows. "soon" is not a number invented here - it is the
  //    workspace's own renewal_near threshold.
  eat(/\brenew\w*\s+(?:is\s+)?(?:with)?in\s+(?:the\s+)?(?:next\s+)?(\d+)\s*(day|week|month)s?\b/g, (_m, n, unit) => {
    const d = toDays(n, unit);
    if (d == null) return null;
    if (unit.startsWith("month")) notes.push("A month was read as 30 days.");
    return { field: "daysToRenewal", op: "lte", value: String(d) };
  });
  eat(/\b(?:renew\w*|renewal)\s+(?:in\s+)?(?:the\s+)?next\s+(\d+)\s*(day|week|month)s?\b/g, (_m, n, unit) => {
    const d = toDays(n, unit);
    return d == null ? null : { field: "daysToRenewal", op: "lte", value: String(d) };
  });
  eat(/\brenew\w*\s+soon\b|\bsoon\s+to\s+renew\w*\b|\bupcoming\s+renewals?\b/g, () => {
    const near = vocab.renewalNearDays;
    if (near == null) {
      notes.push('"soon" was ignored: the renewal threshold could not be read from settings.');
      return null;
    }
    notes.push(`"soon" was read as ${plural(near, "day", "days")} - your renewal_near threshold.`);
    return { field: "daysToRenewal", op: "lte", value: String(near) };
  });

  // 2. Money. Every comparison word maps to one operator; nothing is guessed.
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:over|above|more than|greater than|bigger than|>)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "gt", value: String(v) };
    });
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:at least|minimum of|>=)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "gte", value: String(v) };
    });
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:under|below|less than|smaller than|<)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "lt", value: String(v) };
    });
  eat(/\b(?:arr|revenue|value|worth|paying|spend)?\s*(?:at most|no more than|<=)\s*\$?\s*([\d][\d,.]*)\s*([km])?\b/g,
    (_m, d, s) => {
      const v = parseAmount(d, s);
      return v == null ? null : { field: "arr", op: "lte", value: String(v) };
    });

  // 3. States. The keys come from the product's own label map, so a state this
  //    product does not compute can never be produced here.
  const LABEL_PATTERNS = [
    ["payment_issue", /\bpayment\s+(?:issue|problem|failure|fail)s?\b|\bfailed\s+payments?\b|\bbilling\s+(?:issue|problem)s?\b/g],
    ["at_risk", /\bat[-\s]risk\b|\bchurn\s+risk\b|\brisk\s+of\s+churn\b|\blikely\s+to\s+churn\b/g],
    ["expansion_ready", /\bexpansion(?:\s+ready)?\b|\bupsell\b|\bupgrade\s+ready\b|\bready\s+to\s+expand\b/g],
    ["dormant", /\bdormant\b|\binactive\b|\bgone\s+quiet\b/g],
    ["watching", /\bwatch(?:ing|list)\b|\bbeing\s+watched\b/g],
    ["healthy", /\bhealthy\b|\bdoing\s+well\b|\bin\s+good\s+shape\b/g],
    ["new", /\bnew\s+(?:customer|account|client|logo)s?\b|\bnewly\s+signed\b/g],
  ];
  for (const [key, re] of LABEL_PATTERNS) {
    eat(re, () => (vocab.labels[key] ? { field: "label", op: "is", value: key } : null));
  }

  // 4. Owner. Only produced when the name is already an owner in the data.
  eat(/\bown(?:ed|er)\s*(?:by|is|:)?\s+([a-z][a-z.'-]*(?:\s+[a-z][a-z.'-]*)?)/g, (_m, who) => {
    const hit = vocab.owners.find((o) => {
      const lo = o.toLowerCase();
      return lo === who.trim() || lo.startsWith(who.trim()) || who.trim().startsWith(lo);
    });
    if (!hit) {
      notes.push(`No owner in your data matches "${who.trim()}", so no owner rule was added.`);
      return null;
    }
    return { field: "owner", op: "is", value: hit };
  });

  // 5. Plan. Same grounding rule: the plan must exist in the imported accounts.
  for (const p of vocab.plans) {
    const safe = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    eat(new RegExp(`\\b${safe}\\b(?:\\s+plan)?`, "gi"), () => ({ field: "plan", op: "is", value: p }));
  }

  // 6. Open decisions and stale data.
  eat(/\bno\s+open\s+(?:decision|issue|item)s?\b|\bnothing\s+open\b/g, () => ({ field: "openDecisions", op: "eq", value: "0" }));
  eat(/\b(?:with|has|have|having)?\s*open\s+(?:decision|issue|item)s?\b/g, () => ({ field: "openDecisions", op: "gte", value: "1" }));
  eat(/\bstale(?:\s+data)?\b|\bout[-\s]of[-\s]date\s+data\b/g, () => ({ field: "staleData", op: "true", value: "" }));

  const ignored = [];
  for (const w of rest.split(/[^a-z0-9$%'-]+/)) {
    const word = w.trim();
    if (word.length < 3) continue;
    if (STOPWORDS.has(word)) continue;
    if (/^[\d,.$%]+$/.test(word)) continue;
    if (!ignored.includes(word)) ignored.push(word);
  }

  return { rules, phrases, ignored, notes };
}

/* ══ THE MODEL READER ══════════════════════════════════════════════════════
 *
 * Bumped when the prompt changes, so an llm_call row says which wording produced
 * it. Segments are not cached on this hash - it is an audit field only.
 */
export const SEGMENT_PROMPT_VERSION = 1;

function describeSystem(vocab) {
  const fieldLines = SEGMENT_FIELDS.map(
    (f) => `- ${f.id} (${f.type}): ${f.label}. Operators: ${Object.keys(SEGMENT_OPS[f.type]).join(", ")}`,
  ).join("\n");

  // The grounded values are listed IN THE PROMPT as well as checked afterwards.
  // The check is what makes it safe; telling the model the real values is what
  // stops it guessing a plausible-looking wrong one in the first place.
  const plans = vocab.plans.length ? vocab.plans.join(", ") : "(this workspace has no plan names)";
  const owners = vocab.owners.length ? vocab.owners.join(", ") : "(this workspace has no owner names)";

  return `You turn a description of a group of software customers into filter criteria. You do not answer questions and you do not explain.

These are the only fields and operators that exist:
${fieldLines}

Operators blank, notblank, true and false take no value; write "" for those. Every other operator needs a value. Numbers are plain digits with no symbols or separators. Dates are YYYY-MM-DD. For the field "label" the value must be one of: ${Object.keys(vocab.labels).join(", ")}.

The plans in this customer list are: ${plans}
The owners in this customer list are: ${owners}
Never write a plan or an owner that is not in those lists. If the description names one that is not there, leave the rule out and say so in notes.

Rules are combined with AND: every rule must be true of a customer. Do not invent a field, an operator or a threshold the description does not give you. If the description asks for something these fields cannot express, leave it out and say so in notes.

Put every word of the description you did not use into "ignored".

Return only a JSON object and nothing else:
{"rules": [{"field": "arr", "op": "gte", "value": "50000"}], "ignored": ["word"], "notes": ["..."]}`;
}

/**
 * Record one model attempt.
 *
 * ⚠️ A separate insert from the one in reason.mjs on purpose: that one stamps
 * the DECISION prompt version on every row it writes, and stamping a brief's
 * version on a segment call would put a wrong number in an audit table. Text is
 * never stored here either - only ids, counts and errors.
 */
function recordSegmentCall(db, row) {
  if (!db) return;
  db.prepare(
    `INSERT INTO llm_call (id, run_id, situation_id, decision_id, purpose, model_requested, model_served,
       prompt_version, packet_hash, input_tokens, output_tokens, latency_ms, attempt, valid, error, at)
     VALUES (?, NULL, NULL, NULL, 'segment_criteria', ?, ?, ?, NULL, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    callId(),
    row.modelRequested ?? null,
    row.modelServed ?? null,
    SEGMENT_PROMPT_VERSION,
    row.inputTokens ?? null,
    row.outputTokens ?? null,
    row.latencyMs ?? null,
    row.valid ? 1 : 0,
    row.error ?? null,
    new Date().toISOString(),
  );
}

/**
 * Keep only rules this product can actually run, and say what was dropped.
 *
 * 🔴 THE MODEL'S OUTPUT IS DATA, NOT AUTHORITY. It is checked against the same
 * allowlist the builder is, and against the values this workspace really has. A
 * rule naming a plan that does not exist is dropped with a note rather than
 * saved as a rule that silently matches nobody.
 */
function groundModelRules(raw, vocab) {
  const rules = [];
  const notes = [];
  const all = Array.isArray(raw) ? raw : [];
  // Capped at MAX_GROUPS because the page lands each proposed rule in its own
  // AND group: a model returning thirty rules would build a tree the compiler
  // then refuses, and the user would see the refusal rather than the proposal.
  if (all.length > MAX_GROUPS) notes.push(`The model returned ${all.length} rules; only the first ${MAX_GROUPS} were kept.`);
  for (const r of all.slice(0, MAX_GROUPS)) {
    const candidate = { field: String(r?.field ?? ""), op: String(r?.op ?? ""), value: r?.value == null ? "" : String(r.value) };
    const compiled = compileRule(candidate);
    if (!compiled.ok) {
      notes.push(`The model asked for "${candidate.field} ${candidate.op}", which is not something a segment can do, so it was dropped.`);
      continue;
    }
    if (compiled.skip) {
      notes.push(`The model left "${candidate.field} ${candidate.op}" without a usable value, so it was dropped.`);
      continue;
    }
    // Only a rule that actually carries a value can name a wrong one. `Plan is
    // blank` has nothing to ground and must not be measured against the list.
    if (!compiled.args.length) {
      rules.push(candidate);
      continue;
    }
    if (candidate.field === "plan" && !vocab.plans.some((p) => p.toLowerCase() === candidate.value.toLowerCase())) {
      notes.push(`No plan in your data is called "${candidate.value}", so that rule was dropped.`);
      continue;
    }
    if (candidate.field === "owner" && !vocab.owners.some((o) => o.toLowerCase() === candidate.value.toLowerCase())) {
      notes.push(`No owner in your data is called "${candidate.value}", so that rule was dropped.`);
      continue;
    }
    if (candidate.field === "label" && !Object.hasOwn(vocab.labels, candidate.value)) {
      notes.push(`"${candidate.value}" is not a customer state this product computes, so that rule was dropped.`);
      continue;
    }
    rules.push(candidate);
  }
  return { rules, notes };
}

/** Strings the model claims it ignored, kept only when they are really in the text. */
function groundIgnored(raw, text) {
  const haystack = String(text ?? "").toLowerCase();
  const out = [];
  for (const w of Array.isArray(raw) ? raw.slice(0, 40) : []) {
    const word = String(w ?? "").trim();
    if (!word || word.length > 40) continue;
    if (!haystack.includes(word.toLowerCase())) continue; // it cannot have ignored a word you did not write
    if (!out.includes(word)) out.push(word);
  }
  return out;
}

/**
 * Read a description into criteria, with the model when there is one.
 *
 * 🔴 DEGRADES HONESTLY, AND SAYS WHICH IT DID. `source` is "model" or "phrases",
 * and `modelError` carries the reason in the gateway's own words when the model
 * could not be used. Nothing here saves anything: the criteria go back for the
 * user to confirm and edit.
 */
export async function describeSegment({ db, text, vocab, complete = defaultComplete, useModel = true }) {
  const clean = String(text ?? "").trim();
  if (!clean) return { ok: false, error: "type a description first" };
  if (clean.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `a description must be ${MAX_DESCRIPTION_CHARS} characters or fewer` };
  }

  const local = readDescription(clean, vocab);
  const fallback = (modelError) => ({
    ok: true,
    source: "phrases",
    model: null,
    modelError: modelError ?? null,
    rules: local.rules,
    phrases: local.phrases,
    ignored: local.ignored,
    notes: local.notes,
  });

  if (!useModel) return fallback(null);

  let res;
  try {
    res = await complete({
      task: "decision-segment",
      messages: [
        { role: "system", content: describeSystem(vocab) },
        { role: "user", content: clean },
      ],
      maxTokens: 600,
      temperature: 0,
      timeoutMs: 45_000,
    });
  } catch (err) {
    // The whole fallback chain in execute.mjs was already walked, so there is
    // nothing to retry. The phrase reader answers instead and the user is told.
    const error = String(err?.message ?? err).slice(0, 300);
    recordSegmentCall(db, { valid: false, error });
    log.warn("segment description: no model", { error });
    return fallback(error);
  }

  const model = res.servedBy ?? res.requested ?? null;
  const parsed = parseBriefText(res.content);
  if (!parsed.ok) {
    recordSegmentCall(db, {
      valid: false, error: parsed.reason, modelRequested: res.requested, modelServed: res.servedBy,
      inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, latencyMs: res.latencyMs,
    });
    return fallback(`the model did not return usable JSON: ${parsed.reason}`);
  }

  const grounded = groundModelRules(parsed.value?.rules, vocab);
  // Nothing survived the allowlist, so the model contributed nothing. Saying
  // "the model found no rules" when the phrase reader can find some would be a
  // worse answer than the one this product can actually give.
  if (!grounded.rules.length) {
    recordSegmentCall(db, {
      valid: false, error: "no rule survived grounding", modelRequested: res.requested, modelServed: res.servedBy,
      inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, latencyMs: res.latencyMs,
    });
    return fallback("the model produced no rule this product can run");
  }

  recordSegmentCall(db, {
    valid: true, modelRequested: res.requested, modelServed: res.servedBy,
    inputTokens: res.usage?.inputTokens, outputTokens: res.usage?.outputTokens, latencyMs: res.latencyMs,
  });

  const modelNotes = (Array.isArray(parsed.value?.notes) ? parsed.value.notes : [])
    .slice(0, 6)
    .map((n) => String(n ?? "").slice(0, 200))
    .filter(Boolean);

  return {
    ok: true,
    source: "model",
    model,
    modelError: null,
    rules: grounded.rules,
    phrases: [],
    ignored: groundIgnored(parsed.value?.ignored, clean),
    notes: [...modelNotes, ...grounded.notes],
  };
}
