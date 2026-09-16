// Answering a typed question — WITHOUT letting a model write SQL.
//
// 🔴 THE THING THIS FILE REFUSES TO DO, and why it is the whole point.
//
// The obvious build is text-to-SQL: hand the schema to a model, run whatever it
// writes, print the number. That approach scores 86% on academic benchmarks and
// 0-6% on real enterprise databases (Spider 2.0). On this product the cost of a
// miss is not a retry, it is a person telling a customer a wrong figure — and a
// single plausible-looking wrong number erodes more trust than ten correct
// answers build. So no model output ever reaches SQLite here.
//
// WHAT HAPPENS INSTEAD, in three steps:
//
//   1. A FIXED CATALOGUE of intents, below. Each one owns a hand-written,
//      parameterised query over the real schema, written once and reviewable.
//   2. The model's ONLY job is to name an intent id and fill its declared
//      parameters. Everything it returns is validated against the catalogue
//      before anything runs: an unknown id, an unknown parameter name or an
//      out-of-range value is rejected, not coerced into something plausible.
//   3. NO MATCH IS A RESULT. A refusal carries what was checked and what can be
//      asked instead. It is never an empty answer with a zero in it, because
//      "no customer is at risk" and "Ledgerline did not understand you" are opposite
//      facts that would render identically.
//
// ⭐ IT WORKS WITH NO MODEL AT ALL. When `complete()` throws — no key, no
// gateway, offline — the question is matched against the catalogue by keyword
// and the answer SAYS SO, in the evidence, every time. This is the same
// degradation `reason.mjs` already makes when a brief cannot be generated:
// `rule_only` is a first-class outcome there and here.
//
// ⚠️ WHAT IS SENT TO THE MODEL: the question text and the catalogue. No customer
// row, name, amount or date ever leaves this process for the intent call — the
// query runs locally after the intent comes back. The `pseudonymise` setting
// therefore does not apply to it, but a question someone TYPES can of course
// contain a customer's name, so the evidence block says the question text was
// sent. Saying nothing would be the quiet version of a data leak.
import { getSettings } from "./db.mjs";
import { asOfFor } from "./run.mjs";
import { rules, editableThresholds } from "./rules.mjs";
import { LABELS } from "./situations.mjs";
import { OPEN_STATUSES } from "./decisions.mjs";
import { overdueDays } from "./followup.mjs";
import { money, daysBetween, addDays, humanDate } from "./format.mjs";
import { parseBriefText } from "./schema.mjs";
import { complete as defaultComplete } from "../routing/execute.mjs";
import { callId } from "./ids.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/ask");

/** The two result shapes the Ask page renders. Identical to the ones it builds itself. */
const answer = (a) => ({ kind: "answer", corrections: [], evidence: [], tone: "plain", ...a });
const refusal = (r) => ({ kind: "refusal", checked: [], remedies: [], suggestions: [], ...r });

// Bound, not interpolated, even though these five strings are ours: one idiom for
// every value in this file means there is no "safe case" for the next person to
// copy in the direction of an unsafe one.
//
// 🔴 LAZY, AND IT HAS TO STAY LAZY. This was a module-scope const, and it made
// the whole decisions package unimportable in one order:
//
//   synthetic.mjs -> decisions.mjs -> db.mjs -> ask.mjs -> decisions.mjs
//
// db.mjs importing the feature modules is a deliberate cycle and is documented
// there as safe, because everything it reaches back for is a HOISTED FUNCTION
// DECLARATION. OPEN_STATUSES is a `const`, so on the way round it is still in
// the temporal dead zone, and reading it at module scope threw
// "Cannot access 'OPEN_STATUSES' before initialization" - at import time,
// before any code ran.
//
// ⚠️ The failure does not look like a cycle. It looks like ask.mjs being
// broken, and only in SOME entry orders: the test suite was entirely green,
// because every test happened to import a module that initialised decisions.mjs
// first. It surfaced only when something imported synthetic.mjs on its own.
//
// Computing it on first use puts the read inside a function body, where
// decisions.mjs is always finished. Do not turn it back into a top-level const.
let _openIn = null;
const OPEN_IN = () => (_openIn ??= `status IN (${OPEN_STATUSES.map(() => "?").join(",")})`);

// A workspace can hold thousands of rows and the page caps its table at 50. The
// server cap is higher so the "showing the first N" line stays truthful, and
// still bounded so one question cannot ship a 10 MB payload over the socket.
const ROW_CAP = 200;

/* ── parameter specs ─────────────────────────────────────────────────────── */
//
// A spec is data, so the prompt the model sees and the validation its answer
// faces are generated from the SAME object. A prompt that drifts from the
// validator is how "the model keeps sending an invalid value" bugs happen.

const enumOf = (values, dflt) => ({ type: "enum", values, default: dflt });
const intOf = (min, max, dflt) => ({ type: "int", min, max, default: dflt });
const dateOf = (dflt) => ({ type: "day", default: dflt });
const textOf = (max) => ({ type: "text", max });

const defaultOf = (spec, env) => (typeof spec.default === "function" ? spec.default(env) : spec.default);

function describeSpec(spec, env) {
  const dflt = defaultOf(spec, env);
  const tail = dflt === undefined ? " (required)" : ` (default: ${dflt})`;
  if (spec.type === "enum") return `one of ${spec.values.join(" | ")}${tail}`;
  if (spec.type === "int") return `a whole number from ${spec.min} to ${spec.max}${tail}`;
  if (spec.type === "day") return `a date written YYYY-MM-DD${tail}`;
  return `free text, at most ${spec.max} characters${tail}`;
}

/**
 * Turn one value from the model (or from the keyword sniffer) into something
 * safe to bind. Never repairs silently: the caller reports every fallback.
 */
function coerceParam(spec, raw, env) {
  if (raw === undefined || raw === null || raw === "") {
    const d = defaultOf(spec, env);
    if (d === undefined) return { ok: false, why: "no value was given and this one has no default" };
    return { ok: true, value: d, fromDefault: true };
  }
  const shown = String(raw).slice(0, 40);
  if (spec.type === "enum") {
    const v = String(raw).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!spec.values.includes(v)) return { ok: false, why: `"${shown}" is not one of ${spec.values.join(", ")}` };
    return { ok: true, value: v };
  }
  if (spec.type === "int") {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return { ok: false, why: `"${shown}" is not a number` };
    if (n < spec.min || n > spec.max) return { ok: false, why: `${n} is outside ${spec.min}-${spec.max}` };
    return { ok: true, value: n };
  }
  if (spec.type === "day") {
    const v = String(raw).trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return { ok: false, why: `"${shown}" is not a date written YYYY-MM-DD` };
    if (!Number.isFinite(Date.parse(v + "T00:00:00Z"))) return { ok: false, why: `"${shown}" is not a real date` };
    return { ok: true, value: v };
  }
  const v = String(raw).trim().slice(0, spec.max);
  if (!v) return { ok: false, why: "the value was empty" };
  return { ok: true, value: v };
}

/**
 * Validate a whole parameter object against one intent.
 *
 * Unknown names are DROPPED and reported rather than passed on: a parameter the
 * catalogue does not declare cannot reach a query, so the only question is
 * whether the person is told it was ignored.
 */
function coerceParams(intent, raw, env) {
  const specs = intent.params ?? {};
  const args = {};
  const notes = [];
  const ignored = Object.keys(raw ?? {}).filter((k) => !Object.hasOwn(specs, k));

  for (const [name, spec] of Object.entries(specs)) {
    const got = coerceParam(spec, raw?.[name], env);
    if (got.ok) {
      args[name] = got.value;
      continue;
    }
    const dflt = defaultOf(spec, env);
    if (dflt === undefined) return { ok: false, error: `${name}: ${got.why}`, ignored };
    // Recoverable: the value was wrong but the parameter has a shipped default.
    // Using it is fine only because the substitution is printed in the evidence.
    args[name] = dflt;
    notes.push(`${name}: ${got.why} — used the default ${dflt} instead`);
  }
  return { ok: true, args, notes, ignored };
}

/* ── shared readers ──────────────────────────────────────────────────────── */

function buildEnv(db) {
  const settings = getSettings(db);
  const lastRun = db.prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 1").get() ?? null;
  return {
    asOf: asOfFor(db),
    settings,
    currency: settings.currency ?? "USD",
    lastRun,
    lastRunId: lastRun?.id ?? null,
    accounts: db.prepare("SELECT COUNT(*) n FROM account").get().n,
    thresholds: editableThresholds(settings),
  };
}

const thresholdDays = (env, id, fallback) => {
  const row = env.thresholds.find((t) => t.id === id);
  return row ? Number(row.current) : fallback;
};

/** Rows, capped, with the cap stated rather than silently applied. */
function capped(rows, build) {
  return {
    total: rows.length,
    note: rows.length > ROW_CAP ? `the first ${ROW_CAP} of ${rows.length} rows are listed` : "",
    rows: rows.slice(0, ROW_CAP).map(build),
  };
}

function accountNames(db) {
  return new Map(db.prepare("SELECT id, name FROM account").all().map((a) => [a.id, a.name]));
}

function openCountsByAccount(db) {
  return new Map(
    db
      .prepare(`SELECT account_id, COUNT(*) n FROM decision WHERE ${OPEN_IN()} GROUP BY account_id`)
      .all(...OPEN_STATUSES)
      .map((r) => [r.account_id, r.n]),
  );
}

// decision_event.kind is a history verb, NOT a status - "created", "escalated",
// "unsnoozed", "action_prepared" and so on. Reading it through STATUS_LABELS
// would print nothing for most rows, which is exactly the kind of quiet blank
// that gets read as "nothing happened".
const EVENT_LABELS = {
  created: "Raised",
  updated: "Updated by the analysis",
  escalated: "Got worse",
  status: "Status changed",
  owner: "Owner changed",
  due: "Due date changed",
  note: "Note added",
  snoozed: "Snoozed",
  unsnoozed: "Came back from snooze",
  dismissed: "Dismissed",
  resolved: "Resolved",
  outcome: "Outcome recorded",
  reminder: "Reminder",
  action_prepared: "Action prepared",
  action_done: "Action done",
  action_cancelled: "Action cancelled",
};

function dueCell(d, asOf) {
  const over = overdueDays(d, asOf);
  if (over != null) return `${over} days overdue`;
  return d.due_at ? humanDate(d.due_at) : "no due date";
}

/** Raw decision rows -> the records table the page already knows how to draw. */
function decisionRecords(db, rows, env) {
  const names = accountNames(db);
  const body = capped(rows, (d) => ({
    go: `decisions/${d.id}`,
    cells: [
      d.title ?? d.id,
      d.account_id ? (names.get(d.account_id) ?? d.account_id) : "Company-wide",
      d.impact_amount == null ? "—" : money(d.impact_amount, d.currency ?? env.currency),
      d.owner || "Unassigned",
      dueCell(d, env.asOf),
    ],
  }));
  return { columns: ["Decision", "Customer", "Impact", "Owner", "Due"], ...body };
}

/** Raw account rows -> the same five columns the picked questions use. */
function customerRecords(db, rows, env) {
  const openCounts = openCountsByAccount(db);
  const labels = new Map(
    env.lastRunId
      ? db
          .prepare("SELECT account_id, label FROM account_run_state WHERE run_id = ?")
          .all(env.lastRunId)
          .map((r) => [r.account_id, r.label])
      : [],
  );
  const body = capped(rows, (a) => {
    const days = a.renewal_date ? daysBetween(env.asOf, a.renewal_date) : null;
    return {
      go: `customers/${a.id}`,
      cells: [
        a.name ?? a.id,
        money(a.arr, env.currency),
        LABELS[labels.get(a.id)] ?? "no label",
        String(openCounts.get(a.id) ?? 0),
        a.renewal_date ? `${humanDate(a.renewal_date)}${days == null ? "" : days < 0 ? ` · ${Math.abs(days)} days ago` : ` · in ${days} days`}` : "no renewal date",
      ],
    };
  });
  return { columns: ["Customer", "ARR", "Ledgerline's label", "Open decisions", "Renewal"], ...body };
}

/* ── refusals the intents share ──────────────────────────────────────────── */

const noDataRefusal = (what, checked) =>
  refusal({
    reason: `${what} come from the customer data you import, and this workspace has none. A zero here would read as "you are clear" when it means "nothing has been loaded".`,
    checked,
    remedies: [{ label: "Import customer data", kind: "go:data" }],
  });

const noRunRefusal = (what, checked) =>
  refusal({
    reason: `${what} come from the analysis run, and no analysis has finished in this workspace yet. Ledgerline will not report zero when the truthful answer is "nobody has looked".`,
    checked,
    remedies: [
      { label: "Run the analysis", kind: "run" },
      { label: "Check the imported data", kind: "go:data" },
    ],
  });

/* ── THE CATALOGUE ───────────────────────────────────────────────────────── */
//
// Every query below is written by hand, reads only columns that exist, and binds
// every value. `groupBy` in arr_by_group is the one place a name is spliced into
// SQL, and it is mapped through a frozen allowlist first — never the caller's
// string. That is the same discipline routes.mjs already keeps: fixed fragments
// may be interpolated, values never.

const DECISION_KINDS = ["churn_risk", "expansion", "payment_risk", "cohort_shift"];
const SEVERITIES = ["critical", "high", "medium"];
const LABEL_IDS = Object.keys(LABELS);

/** groupBy -> the literal column. The VALUE is never what reaches the SQL string. */
const GROUP_COLUMNS = Object.freeze({ segment: "segment", plan: "plan", industry: "industry", owner: "owner" });

export const CATALOGUE = [
  {
    id: "open_decisions",
    question: "Which decisions are open?",
    counts: "open decisions, optionally narrowed to one kind, severity, owner, or only the overdue ones",
    keywords:
      "open decisions queue overdue due late outstanding pending severity critical high medium owner unassigned nobody assigned work waiting snoozed how many",
    tables: "decision",
    params: {
      kind: enumOf([...DECISION_KINDS, "any"], "any"),
      severity: enumOf([...SEVERITIES, "any"], "any"),
      owner: enumOf(["any", "unassigned"], "any"),
      overdue: enumOf(["yes", "no", "any"], "any"),
    },
    sniff(q) {
      const out = {};
      if (/\boverdue|late|past due|missed\b/.test(q)) out.overdue = "yes";
      if (/\bunassigned|nobody|no owner|ownerless|unowned\b/.test(q)) out.owner = "unassigned";
      if (/\bchurn|at risk|leaving\b/.test(q)) out.kind = "churn_risk";
      else if (/\bexpansion|upsell|more seats\b/.test(q)) out.kind = "expansion";
      else if (/\bpayment|invoice|billing\b/.test(q)) out.kind = "payment_risk";
      const sev = SEVERITIES.find((s) => new RegExp(`\\b${s}\\b`).test(q));
      if (sev) out.severity = sev;
      return out;
    },
    run(db, a, env) {
      const where = [OPEN_IN()];
      const args = [...OPEN_STATUSES];
      if (a.kind !== "any") {
        where.push("kind = ?");
        args.push(a.kind);
      }
      if (a.severity !== "any") {
        where.push("severity = ?");
        args.push(a.severity);
      }
      if (a.owner === "unassigned") where.push("(owner IS NULL OR owner = '')");

      let rows = db.prepare(`SELECT * FROM decision WHERE ${where.join(" AND ")}`).all(...args);
      const beforeOverdue = rows.length;
      // Overdue is not a column. It is due_at in the past AND a status that can
      // still act, which followup.mjs owns — so it is filtered here rather than
      // reimplemented as a date comparison that would drift from the reminder.
      if (a.overdue === "yes") rows = rows.filter((d) => overdueDays(d, env.asOf) != null);
      if (a.overdue === "no") rows = rows.filter((d) => overdueDays(d, env.asOf) == null);
      rows.sort((x, y) => (y.impact_amount ?? 0) - (x.impact_amount ?? 0));

      if (!rows.length && !env.lastRun) {
        return noRunRefusal("Decisions", ["the decision table is empty", "no analysis run has ever finished in this workspace"]);
      }

      const filters = [
        a.kind === "any" ? null : `kind ${a.kind}`,
        a.severity === "any" ? null : `severity ${a.severity}`,
        a.owner === "unassigned" ? "with no owner" : null,
        a.overdue === "yes" ? "past their due date" : a.overdue === "no" ? "not yet due" : null,
      ].filter(Boolean);

      const bySeverity = SEVERITIES.map((s) => [s, rows.filter((d) => d.severity === s).length]);
      return answer({
        value: String(rows.length),
        unit: `open ${rows.length === 1 ? "decision" : "decisions"}${filters.length ? ", " + filters.join(", ") : ""}`,
        sentence: rows.length
          ? `Largest impact first. ${rows.filter((d) => !d.owner).length} of them have no owner.`
          : "Nothing in this workspace matches that filter right now.",
        definition: `Open means one of ${OPEN_STATUSES.join(", ")}. A resolved or dismissed decision is never counted. Overdue means the decision has a due date in the past AND a status that can still act on it, so a snoozed decision is open but never overdue.`,
        tone: a.overdue === "yes" && rows.length ? "danger" : rows.length ? "warn" : "plain",
        evidence: [
          ["Query", `SELECT FROM decision WHERE ${where.join(" AND ")}`],
          ["Open decisions before the overdue filter", String(beforeOverdue)],
          ["Rows counted", String(rows.length)],
          ...bySeverity.map(([s, n]) => [`Of those, ${s}`, String(n)]),
        ],
        records: decisionRecords(db, rows, env),
        corrections: [],
      });
    },
  },

  {
    id: "arr_under_review",
    question: "How much ARR is under review?",
    counts: "the money attached to open decisions of one kind",
    keywords: "arr money revenue risk exposed amount total value dollars under review contract worth much",
    tables: "decision, account",
    params: { kind: enumOf([...DECISION_KINDS, "any"], "churn_risk") },
    sniff(q) {
      if (/\bexpansion|upsell|seats\b/.test(q)) return { kind: "expansion" };
      if (/\bpayment|invoice|billing\b/.test(q)) return { kind: "payment_risk" };
      if (/\ball kinds|everything|any kind|in total\b/.test(q)) return { kind: "any" };
      return {};
    },
    run(db, a, env) {
      const where = [OPEN_IN()];
      const args = [...OPEN_STATUSES];
      if (a.kind !== "any") {
        where.push("kind = ?");
        args.push(a.kind);
      }
      const rows = db
        .prepare(`SELECT * FROM decision WHERE ${where.join(" AND ")} ORDER BY impact_amount DESC`)
        .all(...args);

      if (!rows.length && !env.lastRun) {
        return noRunRefusal("Impact amounts", ["no open decision of that kind exists", "no analysis run has ever finished in this workspace"]);
      }

      const total = rows.reduce((n, d) => n + (Number(d.impact_amount) || 0), 0);
      const missing = rows.filter((d) => d.impact_amount == null).length;
      const label = a.kind === "any" ? "open decisions of every kind" : `open ${a.kind.replace("_", " ")} decisions`;

      return answer({
        value: money(total, env.currency),
        unit: `sits under ${label}`,
        sentence: missing
          ? `${missing} of the ${rows.length} rows carry no money figure, so the real exposure is higher than the number above.`
          : `${rows.length} open ${rows.length === 1 ? "decision is" : "decisions are"} behind that figure.`,
        definition:
          "The sum of impact_amount over OPEN decisions only; a decision stops counting the moment it is resolved or dismissed. For a churn risk the impact is the account's whole ARR — the contract value at risk, not a forecast of what you would lose. For an expansion it is extra seats multiplied by the seat price, so a workspace with no seat price records no amount rather than guessing one.",
        tone: total > 0 && a.kind === "churn_risk" ? "danger" : "plain",
        evidence: [
          ["Query", `SELECT FROM decision WHERE ${where.join(" AND ")}`],
          ["Rows summed", String(rows.length)],
          ["Rows with no impact amount", missing ? `${missing} — these add nothing to the total` : "none"],
          ["Currency", env.currency],
        ],
        records: decisionRecords(db, rows, env),
        // Thresholds decide WHICH accounts enter this sum, not what each contributes.
        corrections: a.kind === "expansion" ? [] : ["usage_drop_30d", "renewal_near", "tickets_up_30d"],
        usesSeatPrice: a.kind === "expansion" || a.kind === "any",
      });
    },
  },

  {
    id: "customers_by_label",
    question: "Which customers carry a given label?",
    counts: "customers the last analysis run put in one health band",
    keywords:
      "customers accounts label at risk churn healthy dormant watching payment issue expansion ready new how many which who band segment health",
    tables: "account, account_run_state",
    params: { label: enumOf(LABEL_IDS, "at_risk") },
    sniff(q) {
      if (/\bpayment|invoice|billing|failed card|unpaid\b/.test(q)) return { label: "payment_issue" };
      if (/\bexpansion|upsell|ready to buy|more seats\b/.test(q)) return { label: "expansion_ready" };
      if (/\bdormant|quiet|inactive|asleep\b/.test(q)) return { label: "dormant" };
      if (/\bhealthy|fine|doing well|ok\b/.test(q)) return { label: "healthy" };
      if (/\bwatching|watch list|watchlist\b/.test(q)) return { label: "watching" };
      if (/\bnew customers|newly|just joined|recently joined\b/.test(q)) return { label: "new" };
      return {};
    },
    run(db, a, env) {
      if (!env.accounts) return noDataRefusal("Health labels", ["the account table is empty"]);
      if (!env.lastRunId) {
        return noRunRefusal("Health labels", [`${env.accounts} customers are loaded`, "no analysis run has ever finished, so no customer carries a label"]);
      }
      const rows = db
        .prepare(
          `SELECT a.* FROM account a
             JOIN account_run_state s ON s.account_id = a.id AND s.run_id = ?
            WHERE s.label = ?
            ORDER BY a.arr DESC`,
        )
        .all(env.lastRunId, a.label);
      const arr = rows.reduce((n, r) => n + (Number(r.arr) || 0), 0);
      const risky = a.label === "at_risk" || a.label === "payment_issue";
      // The denominator is how many customers that run LABELLED, which is not the
      // same as how many are loaded: a run that failed part-way labels some of
      // them. Printing the account count here would quietly overstate the sample.
      const labelled = db.prepare("SELECT COUNT(*) n FROM account_run_state WHERE run_id = ?").get(env.lastRunId).n;

      return answer({
        value: String(rows.length),
        unit: `${rows.length === 1 ? "customer carries" : "customers carry"} the "${LABELS[a.label]}" label`,
        sentence: rows.length
          ? `Highest ARR first. They are worth ${money(arr, env.currency)} between them.`
          : `No customer met that rule in the last run, which labelled ${labelled} of the ${env.accounts} customers loaded.`,
        definition:
          'Every customer gets exactly one label per run, and the rules are checked in order, so a customer with a failed payment is labelled "Payment issue" even when it also has a churn risk. The label is a snapshot of one run and does not move until the next one.',
        tone: risky && rows.length ? "warn" : "plain",
        evidence: [
          ["Query", "SELECT FROM account JOIN account_run_state ON run_id = ? WHERE label = ?"],
          ["Run the labels come from", env.lastRunId],
          ["Label asked for", `${a.label} ("${LABELS[a.label]}")`],
          ["Customers with this label", String(rows.length)],
          ["Customers labelled in that run", String(labelled)],
          ["ARR in this group", money(arr, env.currency)],
        ],
        records: customerRecords(db, rows, env),
        corrections: risky ? ["usage_drop_30d", "renewal_near", "tickets_up_30d"] : [],
      });
    },
  },

  {
    id: "renewals_due",
    question: "Which renewals are coming up?",
    counts: "customers whose renewal date falls inside a window that starts today",
    keywords: "renewal renewals renew contract expiring expires expiry coming up soon next days window date",
    tables: "account",
    params: { days: intOf(1, 365, (env) => thresholdDays(env, "renewal_near", 60)) },
    sniff(q) {
      const m = q.match(/(\d{1,3})\s*days?/);
      if (m) return { days: Number(m[1]) };
      if (/\bnext month|this month\b/.test(q)) return { days: 30 };
      if (/\bnext quarter|this quarter\b/.test(q)) return { days: 90 };
      if (/\bnext week|this week\b/.test(q)) return { days: 7 };
      return {};
    },
    run(db, a, env) {
      if (!env.accounts) return noDataRefusal("Renewal dates", ["the account table is empty"]);
      const until = addDays(env.asOf, a.days);
      const rows = db
        .prepare("SELECT * FROM account WHERE renewal_date IS NOT NULL AND renewal_date >= ? AND renewal_date <= ? ORDER BY renewal_date")
        .all(env.asOf, until);
      const past = db.prepare("SELECT COUNT(*) n FROM account WHERE renewal_date IS NOT NULL AND renewal_date < ?").get(env.asOf).n;
      const undated = db.prepare("SELECT COUNT(*) n FROM account WHERE renewal_date IS NULL OR renewal_date = ''").get().n;
      const arr = rows.reduce((n, r) => n + (Number(r.arr) || 0), 0);
      const shipped = env.thresholds.find((t) => t.id === "renewal_near");

      return answer({
        value: String(rows.length),
        unit: `${rows.length === 1 ? "renewal falls" : "renewals fall"} inside the next ${a.days} days`,
        sentence: past
          ? `${money(arr, env.currency)} of ARR is in that window. ${past} more renewal ${past === 1 ? "date is" : "dates are"} already in the past.`
          : `${money(arr, env.currency)} of ARR is in that window.`,
        definition: `The window runs from ${env.asOf} to ${until} inclusive and is compared against account.renewal_date as imported. ${shipped ? `The default window is the "${shipped.label}" threshold, currently ${shipped.current} days (shipped ${shipped.shipped}).` : ""} A customer is counted once by its date, whether or not it has an open decision.`,
        evidence: [
          ["Query", "SELECT FROM account WHERE renewal_date BETWEEN ? AND ? ORDER BY renewal_date"],
          ["Window", `${env.asOf} to ${until} (${a.days} days)`],
          ["Customers scanned", String(env.accounts)],
          ["Inside the window", String(rows.length)],
          ["Renewal date already past", String(past)],
          ["No renewal date on record", String(undated)],
        ],
        records: customerRecords(db, rows, env),
        corrections: ["renewal_near"],
      });
    },
  },

  {
    id: "arr_by_group",
    question: "What is the total ARR by segment?",
    counts: "ARR and customer count, grouped by one column of the account table",
    keywords: "arr total revenue by segment plan industry owner group breakdown split share book of business how much",
    tables: "account",
    params: { groupBy: enumOf(Object.keys(GROUP_COLUMNS), "segment") },
    sniff(q) {
      if (/\bplan|tier|package\b/.test(q)) return { groupBy: "plan" };
      if (/\bindustry|vertical|sector\b/.test(q)) return { groupBy: "industry" };
      if (/\bowner|rep|csm|account manager|per person\b/.test(q)) return { groupBy: "owner" };
      return {};
    },
    run(db, a, env) {
      if (!env.accounts) return noDataRefusal("ARR figures", ["the account table is empty"]);
      // 🔴 THE ONE INTERPOLATION IN THIS FILE, and the reason it is safe: the
      // enum value is a KEY into a frozen map and the map's VALUE is what reaches
      // the string. A groupBy that survived validation but is not in the map is a
      // bug in this file, so it refuses rather than building SQL out of it.
      const col = GROUP_COLUMNS[a.groupBy];
      if (!col) {
        return refusal({
          reason: `"${a.groupBy}" is not a column Ledgerline groups by, so nothing was run.`,
          checked: [`the allowed groupings are ${Object.keys(GROUP_COLUMNS).join(", ")}`],
          remedies: [{ label: "Try again", kind: "retry" }],
        });
      }
      const rows = db
        .prepare(
          `SELECT COALESCE(NULLIF(${col}, ''), '(not set)') AS g, COUNT(*) AS n, SUM(arr) AS arr
             FROM account GROUP BY g ORDER BY arr DESC`,
        )
        .all();
      const total = rows.reduce((n, r) => n + (Number(r.arr) || 0), 0);
      const unset = rows.find((r) => r.g === "(not set)");

      return answer({
        value: money(total, env.currency),
        unit: `of ARR across ${env.accounts} customers, in ${rows.length} ${a.groupBy} ${rows.length === 1 ? "group" : "groups"}`,
        sentence: unset
          ? `${unset.n} ${unset.n === 1 ? "customer has" : "customers have"} no ${a.groupBy} on record and are grouped under "(not set)".`
          : `Every customer has a ${a.groupBy} on record.`,
        definition: `ARR is summed straight from the account table as imported — no decision, run or threshold is involved, so this number does not move when the analysis runs. A customer with an empty ${a.groupBy} is grouped under "(not set)" rather than dropped, because dropping it would make the groups add up to less than the total.`,
        evidence: [
          ["Query", `SELECT ${col}, COUNT(*), SUM(arr) FROM account GROUP BY ${col}`],
          ["Grouped by", `account.${col}`],
          ["Customers", String(env.accounts)],
          ["Groups", String(rows.length)],
          ["Total ARR", money(total, env.currency)],
        ],
        facts: rows.slice(0, 6).map((r) => [String(r.g), money(r.arr, env.currency)]),
        records: {
          columns: [a.groupBy.charAt(0).toUpperCase() + a.groupBy.slice(1), "Customers", "ARR", "Share of ARR"],
          ...capped(rows, (r) => ({
            // There is no page for a segment, so these rows are figures, not links.
            go: null,
            cells: [String(r.g), String(r.n), money(r.arr, env.currency), total ? `${Math.round((Number(r.arr) / total) * 100)}%` : "—"],
          })),
        },
        corrections: [],
      });
    },
  },

  {
    id: "accounts_with_signal",
    question: "Which accounts show a given signal?",
    counts: "accounts on which the last run found one named signal",
    keywords:
      "signal signals usage drop fell rise tickets seats champion quiet pricing interest stale payment failed which accounts show fired flagged",
    tables: "signal, account",
    params: { signal: enumOf(Object.keys(rules().signals), "usage_drop_30d") },
    sniff(q) {
      // Matched against each signal's own label, so a new signal in rules.json is
      // reachable here the day it ships without this list being edited.
      const R = rules().signals;
      let best = null;
      for (const [id, s] of Object.entries(R)) {
        const words = String(s.label ?? "").toLowerCase().match(/[a-z]{4,}/g) ?? [];
        const hits = words.filter((w) => q.includes(w)).length;
        if (hits && (!best || hits > best.hits)) best = { id, hits };
      }
      return best ? { signal: best.id } : {};
    },
    run(db, a, env) {
      if (!env.lastRunId) {
        return noRunRefusal("Signals", ["the signal table is only written by an analysis run", "no analysis run has ever finished in this workspace"]);
      }
      const R = rules().signals[a.signal];
      const rows = db
        .prepare(
          `SELECT s.*, a.name AS account_name, a.arr AS account_arr
             FROM signal s LEFT JOIN account a ON a.id = s.account_id
            WHERE s.run_id = ? AND s.kind = ?
            ORDER BY s.band DESC, a.arr DESC`,
        )
        .all(env.lastRunId, a.signal);
      const inRun = db.prepare("SELECT COUNT(*) n FROM signal WHERE run_id = ?").get(env.lastRunId).n;
      const editable = env.thresholds.some((t) => t.id === a.signal);

      return answer({
        value: String(rows.length),
        unit: `${rows.length === 1 ? "account shows" : "accounts show"} "${R?.label ?? a.signal}"`,
        sentence: rows.length
          ? "Strongest band first. A signal on its own is never a decision — it takes at least two to raise one."
          : `No account tripped this signal in the last run, which computed ${inRun} signals in total.`,
        definition: `A signal is one measured fact about one account, recorded by the analysis run with the band it reached (1 to 3, higher is stronger). ${editable ? "The level at which this one starts to fire is editable below." : "The level at which this one fires is set in the shipped rules file, not in Settings."} Signals are a snapshot of one run and are not recomputed when you read them.`,
        tone: rows.length ? "warn" : "plain",
        evidence: [
          ["Query", "SELECT FROM signal LEFT JOIN account WHERE run_id = ? AND kind = ?"],
          ["Run the signals come from", env.lastRunId],
          ["Signal asked for", `${a.signal} ("${R?.label ?? a.signal}")`],
          ["Accounts with this signal", String(rows.length)],
          ["Signals of every kind in that run", String(inRun)],
        ],
        records: {
          columns: ["Customer", "What Ledgerline saw", "Band", "ARR"],
          ...capped(rows, (s) => ({
            go: s.account_id ? `customers/${s.account_id}` : null,
            cells: [s.account_name ?? s.account_id ?? "Company-wide", s.statement, String(s.band), s.account_arr == null ? "—" : money(s.account_arr, env.currency)],
          })),
        },
        corrections: editable ? [a.signal] : [],
      });
    },
  },

  {
    id: "changed_since",
    question: "What has changed since a date?",
    counts: "everything written to a decision's history on or after one day",
    keywords: "changed change since happened recent lately history activity updates last week yesterday month new moved",
    tables: "decision_event, decision",
    params: { since: dateOf((env) => addDays(env.asOf, -7)) },
    sniff(q, env) {
      const iso = q.match(/\d{4}-\d{2}-\d{2}/);
      if (iso) return { since: iso[0] };
      const m = q.match(/(?:last|past)\s+(\d{1,3})\s*days?/);
      if (m) return { since: addDays(env.asOf, -Number(m[1])) };
      if (/\byesterday\b/.test(q)) return { since: addDays(env.asOf, -1) };
      if (/\b(last|this) week\b/.test(q)) return { since: addDays(env.asOf, -7) };
      if (/\b(last|this) month\b/.test(q)) return { since: addDays(env.asOf, -30) };
      return {};
    },
    run(db, a, env) {
      // decision_event.at is a full ISO timestamp and `since` is a day. A string
      // compare is correct because "2026-09-01T09:00:00Z" sorts after
      // "2026-09-01" — which is also why the bound value is the bare day and not
      // a timestamp with a made-up time of day on it.
      const rows = db
        .prepare(
          `SELECT e.*, d.title, d.account_id, d.status FROM decision_event e
             JOIN decision d ON d.id = e.decision_id
            WHERE e.at >= ? ORDER BY e.at DESC`,
        )
        .all(a.since);
      const created = db.prepare("SELECT COUNT(*) n FROM decision WHERE created_at >= ?").get(a.since).n;
      const resolved = db.prepare("SELECT COUNT(*) n FROM decision WHERE resolved_at IS NOT NULL AND resolved_at >= ?").get(a.since).n;
      const runs = db.prepare("SELECT COUNT(*) n FROM run WHERE started_at >= ?").get(a.since).n;
      const byUser = rows.filter((e) => e.actor === "user").length;

      if (!rows.length && !env.lastRun) {
        return noRunRefusal("Decision history", ["no decision event exists at all", "no analysis run has ever finished in this workspace"]);
      }

      const names = accountNames(db);
      return answer({
        value: String(rows.length),
        unit: `${rows.length === 1 ? "change was" : "changes were"} recorded since ${a.since}`,
        sentence: rows.length
          ? `${byUser} of them were made by a person and ${rows.length - byUser} by the analysis.`
          : `Nothing has been recorded against a decision since ${a.since}.`,
        definition:
          "One row per entry in a decision's history: created, status changed, owner set, note added, snoozed, resolved, dismissed. It is the audit trail rather than a diff, so a decision touched four times appears four times. Events belong to decisions, so an import that changed no decision leaves no row here.",
        evidence: [
          ["Query", "SELECT FROM decision_event JOIN decision WHERE at >= ? ORDER BY at DESC"],
          ["Since", a.since],
          ["As of", env.asOf],
          ["Events in the window", String(rows.length)],
          ["Decisions created in the window", String(created)],
          ["Decisions resolved in the window", String(resolved)],
          ["Analysis runs started in the window", String(runs)],
        ],
        records: {
          columns: ["Decision", "When", "Who", "What", "Customer"],
          ...capped(rows, (e) => ({
            go: `decisions/${e.decision_id}`,
            cells: [
              e.title ?? e.decision_id,
              `${humanDate(e.at)} ${String(e.at).slice(11, 16)} UTC`,
              e.actor === "user" ? "A person" : "Ledgerline",
              EVENT_LABELS[e.kind] ?? e.kind,
              e.account_id ? (names.get(e.account_id) ?? e.account_id) : "Company-wide",
            ],
          })),
        },
        corrections: [],
      });
    },
  },

  {
    id: "customer_lookup",
    question: "How is one named customer doing?",
    counts: "one customer's ARR, label, open decisions, renewal and data freshness",
    keywords: "customer account company doing status tell me about how is look up find named",
    tables: "account, account_run_state, decision, metric_daily",
    params: { name: textOf(80) },
    sniff(q, env, db) {
      // The parameter is only filled when a REAL account name is in the question.
      // Guessing a name would make every unmatched question look like a customer
      // lookup for a customer that does not exist.
      const rows = db.prepare("SELECT id, name FROM account").all();
      let best = null;
      for (const r of rows) {
        const name = String(r.name ?? "").toLowerCase();
        if (name.length > 2 && q.includes(name) && (!best || name.length > best.len)) best = { name: r.name, len: name.length };
      }
      return best ? { name: best.name } : {};
    },
    run(db, a, env) {
      if (!env.accounts) return noDataRefusal("Customer records", ["the account table is empty"]);
      // ⚠️ `%` and `_` are LIKE wildcards. Binding the value stops SQL injection
      // outright, but an unescaped "%" in a typed name would still widen the
      // search silently — "50% plan" would match everything. Escaping is about
      // the answer being right, not about safety.
      const term = `%${a.name.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
      const rows = db
        .prepare("SELECT * FROM account WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(id) LIKE ? ESCAPE '\\' ORDER BY arr DESC")
        .all(term, term);

      if (!rows.length) {
        return refusal({
          reason: `No customer in this workspace has "${a.name}" in its name or id, so there is nothing to report. Ledgerline will not answer about the nearest-looking customer instead.`,
          checked: [`${env.accounts} customers were searched by name and by id`, `the search term was "${a.name}"`],
          remedies: [
            { label: "Open the customer list", kind: "go:customers" },
            { label: "Check the imported data", kind: "go:data" },
          ],
        });
      }
      if (rows.length > 1) {
        return answer({
          value: String(rows.length),
          unit: `customers match "${a.name}"`,
          sentence: "More than one customer matches, so no single set of figures is shown. Open the one you meant.",
          definition: "The name you typed is matched anywhere inside a customer's name or id, case-insensitively. Ledgerline lists every match rather than picking the largest one.",
          evidence: [
            ["Query", "SELECT FROM account WHERE lower(name) LIKE ? OR lower(id) LIKE ?"],
            ["Search term", a.name],
            ["Customers searched", String(env.accounts)],
            ["Matches", String(rows.length)],
          ],
          records: customerRecords(db, rows, env),
          corrections: [],
        });
      }

      const acc = rows[0];
      const label = env.lastRunId
        ? db.prepare("SELECT label FROM account_run_state WHERE run_id = ? AND account_id = ?").get(env.lastRunId, acc.id)?.label
        : null;
      const open = db.prepare(`SELECT * FROM decision WHERE account_id = ? AND ${OPEN_IN()} ORDER BY impact_amount DESC`).all(acc.id, ...OPEN_STATUSES);
      const usage = db.prepare("SELECT MAX(day) d, COUNT(*) n FROM metric_daily WHERE account_id = ? AND metric = 'active_users'").get(acc.id);
      const signals = env.lastRunId
        ? db.prepare("SELECT COUNT(*) n FROM signal WHERE run_id = ? AND account_id = ?").get(env.lastRunId, acc.id).n
        : 0;
      const toRenewal = acc.renewal_date ? daysBetween(env.asOf, acc.renewal_date) : null;

      return answer({
        value: money(acc.arr, env.currency),
        unit: `of ARR — ${acc.name}`,
        sentence: open.length
          ? `${open.length} open ${open.length === 1 ? "decision is" : "decisions are"} on this customer.`
          : "Nothing is open on this customer right now.",
        definition:
          "ARR, plan, owner and renewal date are read from the imported account record and are not computed. The label and the signal count come from the last analysis run and do not move until the next one. The last usage day is the newest active_users row imported for this customer, which is what decides whether its numbers are treated as stale.",
        tone: label === "at_risk" || label === "payment_issue" ? "warn" : "plain",
        evidence: [
          ["Query", "SELECT FROM account WHERE lower(name) LIKE ? OR lower(id) LIKE ?"],
          ["Search term", a.name],
          ["Customer id", acc.id],
          ["Run the label comes from", env.lastRunId ?? "no run yet"],
          ["Usage rows imported", String(usage?.n ?? 0)],
        ],
        facts: [
          ["ARR", money(acc.arr, env.currency)],
          ["Plan", acc.plan || "not set"],
          ["Owner", acc.owner || "Unassigned"],
          ["Ledgerline's label", LABELS[label] ?? (env.lastRunId ? "no label" : "no run yet")],
          ["Open decisions", String(open.length)],
          ["Signals in the last run", String(signals)],
          ["Seats purchased", acc.seats_purchased == null ? "—" : String(acc.seats_purchased)],
          ["Renewal", acc.renewal_date ? `${humanDate(acc.renewal_date)}${toRenewal == null ? "" : ` (in ${toRenewal} days)`}` : "no date"],
          ["Last usage day", usage?.d ?? "none imported"],
        ],
        records: decisionRecords(db, open, env),
        corrections: [],
      });
    },
  },

  {
    id: "last_run",
    question: "What did the last analysis do?",
    counts: "the figures the most recent analysis run recorded about itself",
    keywords: "run analysis last ran model tokens failed when job cost calls latest analysed",
    tables: "run",
    params: {},
    run(db, a, env) {
      const run = env.lastRun;
      if (!run) return noRunRefusal("Run figures", ["the run table is empty"]);
      const failed = run.status === "failed";

      return answer({
        value: String(run.decisions_created ?? 0),
        unit: `${run.decisions_created === 1 ? "decision was" : "decisions were"} created by the last run`,
        sentence: failed
          ? "The run did not finish. The figures below are as far as it got."
          : `It read ${run.accounts ?? 0} accounts and updated ${run.decisions_updated ?? 0} existing decisions.`,
        definition:
          "One analysis run reads every account, computes signals, turns the ones over threshold into situations, and asks the model about at most maxReasonedPerRun of them. A decision is created only when a situation has no matching open record already, which is why created and updated are separate figures.",
        tone: failed ? "danger" : "plain",
        evidence: [
          ["Query", "SELECT FROM run ORDER BY started_at DESC LIMIT 1"],
          ["Run id", run.id],
          ["Status", run.status],
          ["Started", `${humanDate(run.started_at)} ${String(run.started_at).slice(11, 16)} UTC`],
          ["Finished", run.finished_at ? `${humanDate(run.finished_at)} ${String(run.finished_at).slice(11, 16)} UTC` : "did not finish"],
          ["Model", run.model ?? "none — rules only"],
          ...(failed ? [["Error", String(run.error ?? "no message stored")]] : []),
        ],
        facts: [
          ["Accounts read", String(run.accounts ?? 0)],
          ["Signals computed", String(run.signals ?? 0)],
          ["Situations found", String(run.candidates ?? 0)],
          ["Sent to the model", String(run.reasoned ?? 0)],
          ["Answered from cache", String(run.cached ?? 0)],
          ["Decisions created", String(run.decisions_created ?? 0)],
          ["Decisions updated", String(run.decisions_updated ?? 0)],
          ["Dropped as not actionable", String(run.dropped_not_actionable ?? 0)],
          ["Model calls", String(run.llm_calls ?? 0)],
          ["Model failures", String(run.llm_failures ?? 0)],
          ["Input tokens", String(run.input_tokens ?? 0)],
          ["Output tokens", String(run.output_tokens ?? 0)],
        ],
        corrections: [],
      });
    },
  },
];

const byId = new Map(CATALOGUE.map((i) => [i.id, i]));

/* ── matching without a model ────────────────────────────────────────────── */
//
// The fallback path, and the only path when no model answers. It ranks the
// catalogue by word overlap and refuses below a bar rather than always
// returning its best guess — a forced fit is the failure mode this screen
// exists to avoid, and a fuzzy match is worth offering, never worth running.

const STOP = new Set(
  "a an the is are was were be been do does did have has had i me my our we us you your what which who whom whose how many much of in on for to and or with at by from show tell give list all any it its that this there here about please can could would should".split(
    " ",
  ),
);

const wordsOf = (s) => String(s).toLowerCase().match(/[a-z0-9']+/g) ?? [];

/**
 * Score every intent against the question.
 * @returns {Array<{intent, hits, score}>} best first
 */
function rankIntents(question, env, db) {
  const asked = new Set(wordsOf(question).filter((w) => w.length > 2 && !STOP.has(w)));
  const lower = String(question).toLowerCase();
  return CATALOGUE.map((intent) => {
    const bag = new Set([...wordsOf(intent.question), ...wordsOf(intent.keywords)]);
    let hits = 0;
    for (const w of asked) if (bag.has(w)) hits++;
    // A parameter the text actually names is evidence about which question was
    // asked, so it counts as a hit: "renewals in 30 days" is a stronger match for
    // renewals_due than the word "renewals" alone.
    const sniffed = safeSniff(intent, lower, env, db);
    if (Object.keys(sniffed).length) hits += 1;
    return { intent, hits, sniffed, score: asked.size ? hits / asked.size : 0 };
  }).sort((a, b) => b.score - a.score || b.hits - a.hits);
}

function safeSniff(intent, lower, env, db) {
  if (typeof intent.sniff !== "function") return {};
  try {
    return intent.sniff(lower, env, db) ?? {};
  } catch (err) {
    // A sniffer is a convenience. One that throws must cost a match, not the run.
    log.warn("intent sniff failed", { intent: intent.id, error: String(err?.message ?? err) });
    return {};
  }
}

// Two independent words, or half of a short question, is the bar. Below it the
// answer would be a coin toss wearing a number.
const isConfident = (r) => r.hits >= 2 || (r.hits >= 1 && r.score >= 0.5);

/* ── matching with a model ───────────────────────────────────────────────── */

const SYSTEM = `You route a question to ONE entry in a fixed catalogue of database questions. You never write SQL and you never answer the question yourself.

Reply with JSON only, no prose and no code fence, in one of these two forms:
  {"intent": "<id from the catalogue>", "params": { ... }}
  {"intent": null, "why": "<short reason no entry fits>"}

Rules:
- The id must be copied exactly from the catalogue below.
- Use only the parameter names listed under the entry you choose, with values from the allowed set. Omit a parameter to accept its default.
- Choose null when no entry answers the question. A wrong entry that returns a real number is worse than no answer, so do not force a fit.`;

function cataloguePrompt(env) {
  return CATALOGUE.map((i) => {
    const params = Object.entries(i.params ?? {}).map(([name, spec]) => `    ${name}: ${describeSpec(spec, env)}`);
    return [`- ${i.id}`, `    question: ${i.question}`, `    returns: ${i.counts}`, ...params].join("\n");
  }).join("\n");
}

/** Text is never stored — only ids, counts and errors, exactly as reason.mjs does. */
function recordCall(db, row) {
  try {
    db.prepare(
      `INSERT INTO llm_call (id, run_id, situation_id, decision_id, purpose, model_requested, model_served,
         prompt_version, packet_hash, input_tokens, output_tokens, latency_ms, attempt, valid, error, at)
       VALUES (?, NULL, NULL, NULL, 'ask_intent', ?, ?, NULL, NULL, ?, ?, ?, 1, ?, ?, ?)`,
    ).run(
      callId(),
      row.modelRequested ?? null,
      row.modelServed ?? null,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.latencyMs ?? null,
      row.valid ? 1 : 0,
      row.error ?? null,
      new Date().toISOString(),
    );
  } catch (err) {
    // An audit row failing must never cost the person their answer.
    log.warn("could not record the ask call", { error: String(err?.message ?? err) });
  }
}

/* ── remembering that the gateway is down ───────────────────────────────── */

/**
 * How long to stop dialling a model that just failed.
 *
 * 🔴 WHY THIS EXISTS. On an install with no key, no gateway or no network,
 * EVERY question paid the full model round trip before falling back to keyword
 * matching — measured at 6 to 10 seconds when the connection failed fast, and up
 * to the 30-second timeout when the gateway hung instead. The answer was always
 * going to come from keywords; the wait bought nothing at all. Someone with no
 * key would conclude the feature is broken rather than offline.
 *
 * Ninety seconds is short on purpose. It has to be long enough to spare a person
 * typing several questions in a row, and short enough that starting the gateway
 * and asking again just works, without anyone having to know this cooldown
 * exists.
 */
const MODEL_DOWN_MS = 90_000;

let modelDownUntil = 0;
let modelDownReason = "";

/**
 * ⚠️ REAL WALL CLOCK, deliberately, NOT the engine's nowIso(db).
 *
 * Everything the engine STAMPS goes through nowIso so demo mode can advance the
 * date by hand. This is not a stamp: it measures how long ago a network call
 * failed. Pinning the demo clock must not convince the app that a gateway which
 * failed a moment ago failed a year ago, or the cooldown would never expire.
 */
function noteModelDown(reason) {
  modelDownUntil = Date.now() + MODEL_DOWN_MS;
  modelDownReason = reason;
}

/** Null when the model is worth trying, otherwise why it is being skipped. */
function modelIsDown() {
  if (Date.now() >= modelDownUntil) return null;
  const secs = Math.ceil((modelDownUntil - Date.now()) / 1000);
  return `the model failed ${modelDownReason ? `(${modelDownReason})` : ""} and is not being called again for ${secs}s`;
}

/** Tests need a clean slate; nothing else should call this. */
export function _resetModelDown() {
  modelDownUntil = 0;
  modelDownReason = "";
}

/**
 * Ask the model which intent this is.
 *
 * @returns {Promise<{ok:true, intentId:string|null, params:object, model:string|null, why?:string}
 *                 | {ok:false, error:string}>}
 */
async function pickWithModel({ db, question, env, complete }) {
  let res;
  try {
    res = await complete({
      // "classify" already exists in config/models/metadata.json and routes to the
      // cheap preset. Picking one id out of nine IS classification, so no new task
      // mapping is invented here for it to drift out of date.
      task: "classify",
      messages: [
        { role: "system", content: `${SYSTEM}\n\nCATALOGUE:\n${cataloguePrompt(env)}` },
        { role: "user", content: question },
      ],
      maxTokens: 200,
      temperature: 0,
      timeoutMs: 30_000,
    });
  } catch (err) {
    const error = String(err?.message ?? err).slice(0, 300);
    recordCall(db, { valid: false, error });
    noteModelDown(error);
    return { ok: false, error };
  }

  const shared = {
    modelRequested: res.requested,
    modelServed: res.servedBy,
    inputTokens: res.usage?.inputTokens,
    outputTokens: res.usage?.outputTokens,
    latencyMs: res.latencyMs,
  };
  const model = res.servedBy ?? res.requested ?? null;

  const parsed = parseBriefText(res.content);
  if (!parsed.ok) {
    recordCall(db, { ...shared, valid: false, error: parsed.reason });
    return { ok: false, error: parsed.reason };
  }
  const value = parsed.value;

  if (value.intent === null || value.intent === undefined) {
    recordCall(db, { ...shared, valid: true });
    return { ok: true, intentId: null, params: {}, model, why: String(value.why ?? "").slice(0, 200) };
  }
  // 🔴 The validation that makes the whole design hold. An id the catalogue does
  // not contain is discarded here, before anything is prepared, so no string the
  // model produced can name a table, a column or a query.
  if (typeof value.intent !== "string" || !byId.has(value.intent)) {
    const error = `the model named "${String(value.intent).slice(0, 60)}", which is not in the catalogue`;
    recordCall(db, { ...shared, valid: false, error });
    return { ok: false, error };
  }
  recordCall(db, { ...shared, valid: true });
  return { ok: true, intentId: value.intent, params: value.params && typeof value.params === "object" ? value.params : {}, model };
}

/* ── the answerer ────────────────────────────────────────────────────────── */

const suggestionsFrom = (ranked) => {
  const scored = ranked.filter((r) => r.hits > 0).slice(0, 3);
  return (scored.length ? scored.map((r) => r.intent) : CATALOGUE.slice(0, 4)).map((i) => i.question);
};

/**
 * Answer one typed question, or refuse it.
 *
 * @param {DatabaseSync} db
 * @param {{question: string, noModel?: boolean, complete?: Function}} args
 * @returns {Promise<{result: object, source: string, intent: string|null, asOf: string, model: string|null}>}
 */
export async function answerQuestion(db, { question, noModel = false, complete = defaultComplete } = {}) {
  const q = String(question ?? "").trim();
  const env = buildEnv(db);
  const ranked = rankIntents(q, env, db);
  const best = ranked[0];

  if (!q) {
    return {
      source: "none",
      intent: null,
      model: null,
      asOf: env.asOf,
      result: refusal({
        reason: "No question was typed, so there is nothing to match against the catalogue.",
        checked: ["the question was empty"],
        remedies: [{ label: "Try again", kind: "retry" }],
        suggestions: CATALOGUE.slice(0, 4).map((i) => i.question),
      }),
    };
  }

  // A model that failed moments ago is not dialled again: the answer would come
  // from keywords either way, and the wait is pure cost. The reason is carried
  // into the evidence so the page still says why no model was used.
  const downReason = noModel ? null : modelIsDown();
  const picked = noModel
    ? { ok: false, error: "the model was not used for this question" }
    : downReason
      ? { ok: false, error: downReason }
      : await pickWithModel({ db, question: q, env, complete });

  let intent = null;
  let rawParams = {};
  let source = "rule_only";
  let sourceLine = "";
  let model = null;

  if (picked.ok && picked.intentId) {
    intent = byId.get(picked.intentId);
    rawParams = picked.params;
    source = "model";
    model = picked.model;
    sourceLine = `the model (${model ?? "model not named"}), which chose from the ${CATALOGUE.length} catalogue entries`;
  } else if (picked.ok && !picked.intentId) {
    // The model read the catalogue and said none of it fits. That is a better
    // signal than a keyword score, so it is honoured rather than second-guessed —
    // the near misses are offered as suggestions instead of being run.
    return {
      source: "model",
      intent: null,
      model: picked.model,
      asOf: env.asOf,
      result: refusal({
        reason: "Ledgerline has a fixed list of questions it can answer from your records, and this is not one of them. It will not guess which of them you meant and show a real number for that instead.",
        checked: [
          `the question was matched against all ${CATALOGUE.length} entries in the catalogue`,
          `the model answered: ${picked.why || "no entry fits this question"}`,
          `the closest entry by wording was "${best?.intent.question}" (${best?.hits ?? 0} matching words), which was not close enough to run`,
        ],
        remedies: [{ label: "Try again", kind: "retry" }],
        suggestions: suggestionsFrom(ranked),
      }),
    };
  } else {
    // No model, or a model that failed. Keyword match, and say which.
    if (!best || !isConfident(best)) {
      return {
        source: "rule_only",
        intent: null,
        model: null,
        asOf: env.asOf,
        result: refusal({
          reason: "Ledgerline has a fixed list of questions it can answer from your records, and none of them matches this closely enough. It will not guess and show a real number for a question you did not ask.",
          checked: [
            noModel ? "no model was used for this question" : `no model answered: ${picked.error}`,
            `the question was matched against all ${CATALOGUE.length} entries by keyword instead`,
            `the closest entry was "${best?.intent.question}" with ${best?.hits ?? 0} matching ${best?.hits === 1 ? "word" : "words"}, below the bar for answering`,
          ],
          remedies: [{ label: "Try again", kind: "retry" }],
          suggestions: suggestionsFrom(ranked),
        }),
      };
    }
    intent = best.intent;
    rawParams = best.sniffed;
    source = "rule_only";
    sourceLine = noModel
      ? `keyword match — no model was used. ${best.hits} matching ${best.hits === 1 ? "word" : "words"}`
      : `keyword match — no model answered (${picked.error}). ${best.hits} matching ${best.hits === 1 ? "word" : "words"}`;
  }

  const coerced = coerceParams(intent, rawParams, env);
  if (!coerced.ok) {
    return {
      source,
      intent: intent.id,
      model,
      asOf: env.asOf,
      result: refusal({
        reason: `Ledgerline matched this to "${intent.question}" but could not fill in what it needs, so it ran nothing.`,
        checked: [`chosen by ${sourceLine}`, `the parameter was rejected — ${coerced.error}`],
        remedies: [{ label: "Try again", kind: "retry" }],
        suggestions: suggestionsFrom(ranked),
      }),
    };
  }

  let out;
  try {
    out = intent.run(db, coerced.args, env);
  } catch (err) {
    // A broken query is a bug, not a refusal, and must not be dressed as one.
    log.warn("intent failed", { intent: intent.id, error: String(err?.message ?? err) });
    throw err;
  }

  const paramsLine = Object.keys(coerced.args).length
    ? Object.entries(coerced.args).map(([k, v]) => `${k}=${v}`).join(", ")
    : "none";
  const understood = [
    ["Question asked", q],
    ["Understood as", intent.question],
    ["Catalogue entry", intent.id],
    ["Chosen by", sourceLine],
    ["Parameters used", paramsLine],
    ["Tables read", intent.tables],
    ["Sent to the model", source === "model" ? "the question text and the catalogue — no customer record" : "nothing"],
    ["As of", env.asOf],
    ...coerced.notes.map((n) => ["Parameter corrected", n]),
    ...(coerced.ignored.length ? [["Parameters ignored", `${coerced.ignored.join(", ")} — not declared by this entry`]] : []),
  ];

  if (out.kind === "refusal") {
    return { source, intent: intent.id, model, asOf: env.asOf, result: { ...out, checked: [...understood.map(([k, v]) => `${k}: ${v}`), ...out.checked] } };
  }
  return {
    source,
    intent: intent.id,
    model,
    asOf: env.asOf,
    result: {
      ...out,
      // Always say which question was answered. The person typed their own words
      // and got back a number computed for a catalogue question; hiding which one
      // is how the right number for the wrong question gets believed.
      sentence: `Ledgerline read this as "${intent.question}". ${out.sentence ?? ""}`.trim(),
      evidence: [...understood, ...(out.evidence ?? [])],
    },
  };
}
