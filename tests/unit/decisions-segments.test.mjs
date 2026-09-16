// Saved segments: the migration, the compiler, the store and the description
// reader.
//
// 🔴 THE TEST THAT MATTERS MOST IS THE INJECTION ONE. A segment is criteria
// typed by a user, stored, and then run again every time somebody opens the
// page. If a field name or a value could reach SQL as text rather than as a
// bound parameter, a saved segment would be a stored injection that fires on
// every visit. "We use placeholders" is a claim; `account` still standing after
// a rule that asks for it to be dropped is evidence.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.LEDGERLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerline-segments-test-"));

const { openMemory, migrate, MIGRATIONS, getMeta, setSettings } = await import("../../src/decisions/db.mjs");
const S = await import("../../src/decisions/segments.mjs");
const { daysBetween } = await import("../../src/decisions/format.mjs");

const AS_OF = "2026-09-15";
const opts = { asOf: AS_OF, currency: "USD" };

/**
 * Five accounts that between them exercise every field type: a NULL renewal
 * date, a missing owner, two plans and two states.
 */
function seed() {
  const db = openMemory();
  const acc = db.prepare(
    "INSERT INTO account (id, name, arr, plan, owner, renewal_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  acc.run("a1", "Northwind", 120000, "Enterprise", "Dana", "2026-10-01", "2024-01-01");
  acc.run("a2", "Contoso", 40000, "Growth", "Dana", "2026-12-20", "2025-02-01");
  acc.run("a3", "Fabrikam", 90000, "Enterprise", "Ravi", null, "2025-06-01");
  acc.run("a4", "Initech", 5000, "Growth", null, "2026-09-20", "2026-01-01");
  acc.run("a5", "Umbrella", 250000, "Enterprise", "Ravi", "2027-03-01", "2023-03-01");
  return db;
}

/** A finished run, so label / watching / staleData have something to read. */
function seedRun(db) {
  db.prepare("INSERT INTO run (id, started_at, as_of, status) VALUES ('r1', '2026-09-15T09:00:00Z', ?, 'done')").run(AS_OF);
  const st = db.prepare("INSERT INTO account_run_state (run_id, account_id, label, tenure_days) VALUES ('r1', ?, ?, ?)");
  st.run("a1", "at_risk", 600);
  st.run("a2", "healthy", 400);
  st.run("a3", "at_risk", 300);
  db.prepare("INSERT INTO watch (run_id, account_id, signal_id) VALUES ('r1', 'a1', 'sig1')").run();
  db.prepare(
    "INSERT INTO signal (id, run_id, account_id, kind, band, statement) VALUES ('sig2', 'r1', 'a2', 'data_stale', 1, 'no usage rows for 12 days')",
  ).run();
  return db;
}

const names = (db, groups) => S.matchAccounts(db, S.compileCriteria(groups), opts).map((c) => c.name).sort();
const one = (field, op, value = "") => [{ rules: [{ field, op, value }] }];

/* ── the migration ──────────────────────────────────────────────────────── */

test("the segment table arrives as a NEW migration, leaving the shipped one untouched", () => {
  // Stated as "exactly one entry creates it, and no earlier entry mentions it",
  // NOT as a fixed MIGRATIONS.length. The original pinned the length at 2, which
  // was true only while segments was the newest feature and broke the moment
  // metrics, stories and embed were appended - a false failure that says nothing
  // about whether a shipped migration was edited.
  const carrying = MIGRATIONS.filter((sql) => sql.includes("CREATE TABLE segment"));
  assert.equal(carrying.length, 1, `segment must be created by exactly one migration, found ${carrying.length}`);
  const at = MIGRATIONS.indexOf(carrying[0]);
  assert.ok(at > 0, "segment must not be created by migration 1, which has shipped");
  for (let i = 0; i < at; i++) {
    assert.ok(!MIGRATIONS[i].includes("CREATE TABLE segment"), `migration ${i + 1} has shipped and must not mention segment`);
  }
});

test("a database already at version 1 upgrades without losing its data", () => {
  // The real case: somebody has the installed build, with accounts in it.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATIONS[0]);
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('a1', 'Northwind', 1)").run();

  // Every migration after the first is applied, whatever their number is today.
  // Pinning to:2 applied:1 described the world when segments was the only one.
  const r = migrate(db);
  assert.equal(r.from, 1, "the database starts at the shipped version");
  assert.equal(r.to, MIGRATIONS.length, "it must end up fully up to date");
  assert.equal(r.applied, MIGRATIONS.length - 1, "every later migration must run");
  assert.equal(getMeta(db, "schema_version"), String(MIGRATIONS.length));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM segment").get().n, 0);
  assert.equal(db.prepare("SELECT name FROM account WHERE id = 'a1'").get().name, "Northwind");
  db.close();
});

/* ── the allowlist ──────────────────────────────────────────────────────── */

test("a field that is not on the allowlist is REFUSED, not ignored", () => {
  // Silently dropping it would mean "ARR over 50k AND industry is banking"
  // quietly becoming "ARR over 50k" - a rule the user never wrote, counting
  // customers they never asked for.
  for (const field of ["industry", "seats_purchased", "arr; DROP TABLE account", "__proto__", ""]) {
    const r = S.compileCriteria(one(field, "is", "x"));
    assert.equal(r.ok, false, `${field} must be refused`);
    assert.match(r.error, /is not a field a segment can use/);
  }
});

test("an operator that is not on that field's list is refused, naming the field", () => {
  const r = S.compileCriteria(one("plan", "gte", "5"));
  assert.equal(r.ok, false);
  assert.match(r.error, /"Plan" cannot be compared with "gte"/);

  const sneaky = S.compileCriteria(one("arr", "gte = 1 OR 1", "5"));
  assert.equal(sneaky.ok, false);
});

test("🔴 a value that is SQL is data, and the table it names survives", () => {
  const db = seed();
  const attacks = [
    "'); DROP TABLE account; --",
    "' OR '1'='1",
    "Enterprise' UNION SELECT id, name, arr, plan, owner, renewal_date, 0, null, 0, 0, 0 FROM account --",
  ];
  for (const value of attacks) {
    const r = S.compileCriteria(one("plan", "is", value));
    assert.equal(r.ok, true, "a value is never rejected for its contents - it is bound");
    assert.deepEqual(r.args, [value], "the whole string is one bound parameter");
    const matched = S.matchAccounts(db, r, opts);
    assert.deepEqual(matched, [], "no plan is called that, so nothing matches");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 5, "the account table is still there");
  }
  // And the same string saved, then read back and run again on a later visit.
  const created = S.createSegment(db, { name: "attack", groups: one("name", "contains", attacks[0]) });
  assert.equal(created.ok, true);
  const listed = S.listSegments(db, opts);
  assert.equal(listed[0].count, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 5);
  db.close();
});

test("the compiled SQL never contains the value, only a placeholder", () => {
  const r = S.compileCriteria([
    { rules: [{ field: "plan", op: "is", value: "Enterprise" }, { field: "owner", op: "contains", value: "Dana" }] },
    { rules: [{ field: "arr", op: "gte", value: "50000" }] },
  ]);
  assert.equal(r.ok, true);
  assert.ok(!r.where.includes("Enterprise"), "the value must not be in the SQL text");
  assert.ok(!r.where.includes("Dana"));
  assert.ok(!r.where.includes("50000"));
  assert.equal(r.args.length, 3);
  assert.equal(r.where.split("?").length - 1, 3, "one placeholder per bound value");
});

/* ── matching ───────────────────────────────────────────────────────────── */

test("groups are ANDed and rules inside a group are ORed", () => {
  const db = seed();
  assert.deepEqual(names(db, one("plan", "is", "Enterprise")), ["Fabrikam", "Northwind", "Umbrella"]);

  // (Enterprise OR Growth) AND arr >= 90000
  const both = [
    { rules: [{ field: "plan", op: "is", value: "Enterprise" }, { field: "plan", op: "is", value: "Growth" }] },
    { rules: [{ field: "arr", op: "gte", value: "90000" }] },
  ];
  assert.deepEqual(names(db, both), ["Fabrikam", "Northwind", "Umbrella"]);
  db.close();
});

test("text comparisons ignore case, the way a person reading the rule does", () => {
  const db = seed();
  assert.deepEqual(names(db, one("plan", "is", "enterprise")), ["Fabrikam", "Northwind", "Umbrella"]);
  assert.deepEqual(names(db, one("name", "contains", "WIND")), ["Northwind"]);
  assert.deepEqual(names(db, one("name", "notcontains", "WIND")), ["Contoso", "Fabrikam", "Initech", "Umbrella"]);
  assert.deepEqual(names(db, one("owner", "isnot", "dana")), ["Fabrikam", "Initech", "Umbrella"], "and a missing owner is not that owner");
  db.close();
});

test("blank and not-blank read a missing owner correctly", () => {
  const db = seed();
  assert.deepEqual(names(db, one("owner", "blank")), ["Initech"]);
  assert.deepEqual(names(db, one("owner", "notblank")), ["Contoso", "Fabrikam", "Northwind", "Umbrella"]);
  db.close();
});

test("a date rule never sweeps in the customers who have no date at all", () => {
  // ⚠️ THE BUG THIS PINS: COALESCE(renewal_date, '') < '2026-11-01' is TRUE for
  // every account with no renewal date, because '' sorts before every date. The
  // rule would silently include Fabrikam, which renews never.
  const db = seed();
  assert.deepEqual(names(db, one("renewalDate", "before", "2026-11-01")), ["Initech", "Northwind"]);
  assert.deepEqual(names(db, one("renewalDate", "after", "2026-11-01")), ["Contoso", "Umbrella"]);
  assert.deepEqual(names(db, one("renewalDate", "on", "2026-09-20")), ["Initech"]);
  assert.deepEqual(names(db, one("renewalDate", "blank")), ["Fabrikam"]);
  db.close();
});

test("days to renewal counts the same days format.mjs counts", () => {
  // Two implementations of "how many days until then" is how a card and a filter
  // start disagreeing about the same customer.
  const db = seed();
  const rows = S.matchAccounts(db, S.compileCriteria([]), opts);
  for (const c of rows) {
    assert.equal(c.daysToRenewal, c.renewalDate ? daysBetween(AS_OF, c.renewalDate) : null, `${c.name} disagrees`);
  }
  assert.deepEqual(names(db, one("daysToRenewal", "lte", "30")), ["Initech", "Northwind"]);
  assert.deepEqual(names(db, one("daysToRenewal", "blank")), ["Fabrikam"]);
  db.close();
});

test("the three run-derived fields are empty before a run and real after one", () => {
  const db = seed();
  assert.deepEqual(names(db, one("label", "is", "at_risk")), [], "no run means no state for anyone");
  assert.deepEqual(names(db, one("staleData", "true")), []);
  assert.deepEqual(names(db, one("watching", "gte", "1")), []);

  seedRun(db);
  assert.deepEqual(names(db, one("label", "is", "at_risk")), ["Fabrikam", "Northwind"]);
  assert.deepEqual(names(db, one("label", "blank")), ["Initech", "Umbrella"]);
  assert.deepEqual(names(db, one("staleData", "true")), ["Contoso"]);
  assert.deepEqual(names(db, one("staleData", "false")), ["Fabrikam", "Initech", "Northwind", "Umbrella"]);
  assert.deepEqual(names(db, one("watching", "gte", "1")), ["Northwind"]);
  db.close();
});

test("open decisions are counted from open statuses only", () => {
  const db = seed();
  const ins = db.prepare(
    `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, created_at, updated_at)
     VALUES (?, ?, ?, 'churn_risk', 't', 'high', ?, 'rule_only', '2026-09-01', '2026-09-01')`,
  );
  ins.run("d1", "a1", "f1", "new");
  ins.run("d2", "a1", "f2", "waiting");
  ins.run("d3", "a2", "f3", "resolved");
  assert.deepEqual(names(db, one("openDecisions", "gte", "1")), ["Northwind"]);
  assert.deepEqual(names(db, one("openDecisions", "eq", "2")), ["Northwind"]);
  assert.deepEqual(names(db, one("openDecisions", "eq", "0")), ["Contoso", "Fabrikam", "Initech", "Umbrella"]);
  db.close();
});

/* ── preview ────────────────────────────────────────────────────────────── */

test("preview counts, sums and samples without saving anything", () => {
  const db = seed();
  const r = S.previewCriteria(db, one("plan", "is", "Enterprise"), { ...opts, limit: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.count, 3);
  assert.equal(r.total, 5);
  assert.equal(r.arr, 120000 + 90000 + 250000);
  assert.equal(r.arrLabel, "$460,000");
  assert.equal(r.sample.length, 2, "the sample is capped");
  assert.equal(r.truncated, true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM segment").get().n, 0, "a preview must save nothing");
  db.close();
});

test("the sample is a slice of the counted set, so the number and the names agree", () => {
  const db = seed();
  const r = S.previewCriteria(db, one("arr", "gte", "0"), { ...opts, limit: 200 });
  assert.equal(r.count, r.sample.length);
  assert.equal(r.count, 5);
  db.close();
});

test("a rule still waiting for a value is not counted, and says so", () => {
  const db = seed();
  const r = S.previewCriteria(db, [{ rules: [{ field: "arr", op: "gte", value: "" }] }], opts);
  assert.equal(r.ok, true);
  assert.equal(r.incomplete, 1);
  assert.equal(r.active, 0);
  assert.equal(r.count, 5, "an unfinished rule constrains nothing yet");
  db.close();
});

test("a preview with no rules at all is the whole customer list", () => {
  const db = seed();
  assert.equal(S.previewCriteria(db, [], opts).count, 5);
  db.close();
});

/* ── the store ──────────────────────────────────────────────────────────── */

test("a segment saves, lists with a live count, updates and deletes", () => {
  const db = seed();
  const created = S.createSegment(db, { name: "  Big enterprise  ", groups: one("plan", "is", "Enterprise") });
  assert.equal(created.ok, true);
  assert.equal(created.segment.name, "Big enterprise", "the name is trimmed");
  assert.match(created.segment.id, /^seg_/);

  const listed = S.listSegments(db, opts);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].count, 3);
  assert.equal(listed[0].arr, 460000);
  assert.deepEqual(listed[0].groups, one("plan", "is", "Enterprise"), "the rule comes back exactly as it went in");

  // The count follows the data, not a number stored at save time.
  db.prepare("UPDATE account SET plan = 'Growth' WHERE id = 'a5'").run();
  assert.equal(S.listSegments(db, opts)[0].count, 2);

  const renamed = S.updateSegment(db, created.segment.id, { name: "Renamed" });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.segment.name, "Renamed");
  assert.deepEqual(renamed.segment.groups, one("plan", "is", "Enterprise"), "renaming must not disturb the rule");

  const rerul = S.updateSegment(db, created.segment.id, { groups: one("owner", "is", "Ravi") });
  assert.equal(rerul.segment.name, "Renamed", "re-ruling must not disturb the name");
  assert.equal(S.listSegments(db, opts)[0].count, 2);

  assert.equal(S.deleteSegment(db, created.segment.id).ok, true);
  assert.deepEqual(S.listSegments(db, opts), []);
  db.close();
});

test("saving refuses a nameless segment, an empty rule and a duplicate name", () => {
  const db = seed();
  assert.match(S.createSegment(db, { name: "   ", groups: one("plan", "is", "Enterprise") }).error, /name/);
  assert.match(S.createSegment(db, { name: "x", groups: [] }).error, /at least one complete rule/);
  assert.match(
    S.createSegment(db, { name: "x", groups: [{ rules: [{ field: "arr", op: "gte", value: "" }] }] }).error,
    /still need a value/,
  );

  assert.equal(S.createSegment(db, { name: "Whales", groups: one("arr", "gte", "100000") }).ok, true);
  const dupe = S.createSegment(db, { name: "  whales ", groups: one("arr", "gte", "1") });
  assert.equal(dupe.ok, false, "a second segment called the same thing is two rules with one name");
  assert.match(dupe.error, /already a segment called/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM segment").get().n, 1);
  db.close();
});

test("saving refuses criteria the compiler refuses, so nothing unrunnable is stored", () => {
  const db = seed();
  const r = S.createSegment(db, { name: "bad", groups: one("industry", "is", "banking") });
  assert.equal(r.ok, false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM segment").get().n, 0);
  db.close();
});

test("updating and deleting a segment that is gone says so instead of throwing", () => {
  const db = seed();
  assert.match(S.updateSegment(db, "seg_nope", { name: "x" }).error, /does not exist/);
  assert.match(S.deleteSegment(db, "seg_nope").error, /does not exist/);
  db.close();
});

test("a stored rule naming a field that no longer exists does not take the list down", () => {
  // Hand-written into the table, which is what a downgrade or a hand edit looks
  // like. The row comes back with its count withheld and the reason attached.
  const db = seed();
  db.prepare(
    "INSERT INTO segment (id, name, criteria_json, created_at, updated_at) VALUES ('seg_x', 'Legacy', ?, '2026-01-01', '2026-01-01')",
  ).run(JSON.stringify({ groups: one("industry", "is", "banking") }));
  const listed = S.listSegments(db, opts);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].count, null);
  assert.match(listed[0].error, /is not a field a segment can use/);
  db.close();
});

/* ── description -> criteria ────────────────────────────────────────────── */

const vocabOf = (db) => S.groundingFor(db);

test("with no model at all, the description still reads and says the model was not used", async () => {
  const db = seed();
  const boom = async () => {
    throw new Error("no gateway is connected");
  };
  const r = await S.describeSegment({ db, text: "enterprise customers over $50k", vocab: vocabOf(db), complete: boom });
  assert.equal(r.ok, true);
  assert.equal(r.source, "phrases", "it must degrade to the offline reader");
  assert.match(r.modelError, /no gateway is connected/, "and say why, in the gateway's own words");
  assert.deepEqual(
    r.rules.map((x) => `${x.field} ${x.op} ${x.value}`).sort(),
    ["arr gt 50000", "plan is Enterprise"],
  );
  db.close();
});

test("the offline reader will not name a plan or an owner this workspace does not have", async () => {
  const db = seed();
  const boom = async () => {
    throw new Error("offline");
  };
  const r = await S.describeSegment({ db, text: "platinum customers owned by Mallory", vocab: vocabOf(db), complete: boom });
  assert.deepEqual(r.rules, [], "nothing it cannot ground");
  assert.ok(r.notes.some((n) => /No owner in your data matches "mallory"/i.test(n)));
  assert.ok(r.ignored.includes("platinum"), "and it reports the word it could not use");
  db.close();
});

test("the model's criteria are checked against the same allowlist the builder is", async () => {
  const db = seed();
  const complete = async () => ({
    content: JSON.stringify({
      rules: [
        { field: "arr", op: "gte", value: "50000" },
        { field: "industry", op: "is", value: "banking" },
        { field: "plan", op: "is", value: "Platinum" },
        { field: "owner", op: "is", value: "Mallory" },
        { field: "label", op: "is", value: "on_fire" },
        { field: "arr", op: "gte OR 1=1", value: "1" },
      ],
      ignored: ["banking", "a word that was never typed"],
      notes: ["read six things"],
    }),
    servedBy: "test/model",
    usage: { inputTokens: 10, outputTokens: 20 },
  });

  const r = await S.describeSegment({ db, text: "banking customers over 50000", vocab: vocabOf(db), complete });
  assert.equal(r.source, "model");
  assert.deepEqual(r.rules, [{ field: "arr", op: "gte", value: "50000" }], "only the runnable, grounded rule survives");
  assert.equal(r.notes.length, 6, "and every drop is reported, never silent");
  assert.ok(r.notes.some((n) => /industry/.test(n)));
  assert.ok(r.notes.some((n) => /No plan in your data is called "Platinum"/.test(n)));
  assert.ok(r.notes.some((n) => /on_fire/.test(n)));
  assert.deepEqual(r.ignored, ["banking"], "a word that is not in the text cannot have been ignored");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM llm_call WHERE purpose = 'segment_criteria'").get().n, 1);
  db.close();
});

test("a model that returns prose, or nothing runnable, falls back rather than failing", async () => {
  const db = seed();
  const prose = async () => ({ content: "Sure! Here are some ideas about your customers." });
  const r1 = await S.describeSegment({ db, text: "enterprise customers", vocab: vocabOf(db), complete: prose });
  assert.equal(r1.source, "phrases");
  assert.match(r1.modelError, /usable JSON/);
  assert.deepEqual(r1.rules, [{ field: "plan", op: "is", value: "Enterprise" }]);

  const junk = async () => ({ content: JSON.stringify({ rules: [{ field: "industry", op: "is", value: "x" }] }) });
  const r2 = await S.describeSegment({ db, text: "enterprise customers", vocab: vocabOf(db), complete: junk });
  assert.equal(r2.source, "phrases");
  assert.match(r2.modelError, /no rule this product can run/);
  db.close();
});

test("a description route can be told not to call a model at all", async () => {
  const db = seed();
  let called = 0;
  const complete = async () => {
    called++;
    return { content: "{}" };
  };
  const r = await S.describeSegment({ db, text: "growth customers", vocab: vocabOf(db), complete, useModel: false });
  assert.equal(called, 0);
  assert.equal(r.source, "phrases");
  assert.equal(r.modelError, null);
  db.close();
});

test("an empty or oversized description is refused before any model is asked", async () => {
  const db = seed();
  let called = 0;
  const complete = async () => {
    called++;
    return { content: "{}" };
  };
  assert.equal((await S.describeSegment({ db, text: "   ", vocab: vocabOf(db), complete })).ok, false);
  assert.equal((await S.describeSegment({ db, text: "x".repeat(5000), vocab: vocabOf(db), complete })).ok, false);
  assert.equal(called, 0);
  db.close();
});

test('"renewing soon" means this workspace\'s own threshold, never a number invented here', async () => {
  const db = seed();
  setSettings(db, { thresholds: { renewal_near: 40 } });
  const boom = async () => {
    throw new Error("offline");
  };
  const r = await S.describeSegment({ db, text: "customers renewing soon", vocab: vocabOf(db), complete: boom });
  assert.deepEqual(r.rules, [{ field: "daysToRenewal", op: "lte", value: "40" }]);
  assert.ok(r.notes.some((n) => /40 days/.test(n)));
  db.close();
});

/* ── the vocabulary the page builds its menus from ──────────────────────── */

test("the field vocabulary the page is handed is the list the server enforces", () => {
  const v = S.fieldVocabulary();
  assert.deepEqual(
    v.fields.map((f) => f.id),
    S.SEGMENT_FIELDS.map((f) => f.id),
  );
  for (const f of v.fields) {
    assert.ok(Object.hasOwn(v.ops, f.type), `${f.id} is typed ${f.type}, which has no operator list`);
    // Every operator the page can offer must be one the compiler accepts.
    for (const [opId] of v.ops[f.type]) {
      const r = S.compileCriteria(one(f.id, opId, f.type === "date" ? "2026-01-01" : "1"));
      assert.equal(r.ok, true, `${f.id} ${opId} is offered but refused`);
    }
  }
});

test("the caps turn a pathological rule into a sentence, not a crash", () => {
  const many = Array.from({ length: 40 }, () => ({ rules: [{ field: "arr", op: "gte", value: "1" }] }));
  assert.match(S.compileCriteria(many).error, /at most 12 AND groups/);
  const wide = [{ rules: Array.from({ length: 50 }, () => ({ field: "arr", op: "gte", value: "1" })) }];
  assert.match(S.compileCriteria(wide).error, /at most 20 OR rules/);
  assert.match(S.compileCriteria("not a list").error, /list of groups/);
  assert.match(S.compileCriteria([{ rules: "nope" }]).error, /list of rules/);
});

/* ══ THE ROUTES ════════════════════════════════════════════════════════════
 *
 * The tests above drive src/decisions/segments.mjs directly. These drive the
 * six handlers the page actually calls, because the wiring between them is its
 * own place to go wrong: a route reading `query` where the page sends `body`
 * answers ok:true and does nothing, which is indistinguishable on screen from
 * a rule that matched nobody.
 */

const workspace = await import("../../src/decisions/workspace.mjs");
const { open } = await import("../../src/decisions/db.mjs");
const { decisionRoutes: R } = await import("../../src/decisions/routes.mjs");

/** A real workspace on disk, with five accounts in it. */
function workspaceWithAccounts() {
  const made = workspace.create(`seg-${Math.random().toString(36).slice(2)}`);
  assert.equal(made.ok, true);
  const db = open(workspace.dbFileFor(made.workspace.id));
  const acc = db.prepare("INSERT INTO account (id, name, arr, plan, owner, renewal_date) VALUES (?, ?, ?, ?, ?, ?)");
  acc.run("a1", "Northwind", 120000, "Enterprise", "Dana", "2026-10-01");
  acc.run("a2", "Contoso", 40000, "Growth", "Dana", "2026-12-20");
  acc.run("a3", "Fabrikam", 90000, "Enterprise", "Ravi", null);
  db.close();
  return made.workspace.id;
}

test("decisionsSegments hands the page the vocabulary and the saved list together", async () => {
  workspaceWithAccounts();
  const r = await R.decisionsSegments({});
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  assert.deepEqual(r.segments, []);
  assert.ok(r.fields.length > 5, "the page builds its field menu from this");
  assert.ok(Array.isArray(r.ops.text), "and its operator menu from this");
  assert.deepEqual(r.choices.plans, ["Enterprise", "Growth"], "grounded in the imported data");
  assert.deepEqual(r.choices.owners, ["Dana", "Ravi"]);
  assert.equal(r.hasRun, false);
  assert.ok(r.asOf);
});

test("a segment is created, listed, previewed, updated and deleted over the routes", async () => {
  workspaceWithAccounts();
  const groups = [{ rules: [{ field: "plan", op: "is", value: "Enterprise" }] }];

  const preview = await R.decisionsSegmentPreview({ body: { groups } });
  assert.equal(preview.ok, true);
  assert.equal(preview.count, 2);
  assert.equal(preview.sample.length, 2);
  assert.equal((await R.decisionsSegments({})).segments.length, 0, "a preview saves nothing");

  const made = await R.decisionsSegmentCreate({ body: { name: "Enterprise", groups } });
  assert.equal(made.ok, true);

  const listed = await R.decisionsSegments({});
  assert.equal(listed.segments.length, 1);
  assert.equal(listed.segments[0].count, 2, "the same count the preview gave");
  assert.equal(listed.segments[0].name, "Enterprise");

  const renamed = await R.decisionsSegmentUpdate({ body: { id: made.segment.id, name: "Big ones" } });
  assert.equal(renamed.ok, true);
  assert.equal(renamed.segment.name, "Big ones");
  assert.deepEqual(renamed.segment.groups, groups, "a rename leaves the rule alone");

  const gone = await R.decisionsSegmentDelete({ body: { id: made.segment.id } });
  assert.equal(gone.ok, true);
  assert.deepEqual((await R.decisionsSegments({})).segments, []);
});

test("the routes refuse a bad field, a missing id and a duplicate name in words", async () => {
  workspaceWithAccounts();
  const bad = await R.decisionsSegmentCreate({ body: { name: "x", groups: [{ rules: [{ field: "industry", op: "is", value: "b" }] }] } });
  assert.equal(bad.ok, false, "ok:false is what the dispatcher turns into HTTP 400");
  assert.match(bad.error, /is not a field a segment can use/);

  assert.equal((await R.decisionsSegmentUpdate({ body: {} })).error, "which segment?");
  assert.equal((await R.decisionsSegmentDelete({ body: {} })).error, "which segment?");

  const groups = [{ rules: [{ field: "arr", op: "gte", value: "1" }] }];
  assert.equal((await R.decisionsSegmentCreate({ body: { name: "Dupe", groups } })).ok, true);
  assert.equal((await R.decisionsSegmentCreate({ body: { name: "dupe", groups } })).ok, false);
});

test("🔴 a segment saved through the routes cannot reach another table", async () => {
  workspaceWithAccounts();
  const attack = [{ rules: [{ field: "name", op: "contains", value: "'); DROP TABLE account; --" }] }];
  const preview = await R.decisionsSegmentPreview({ body: { groups: attack } });
  assert.equal(preview.ok, true);
  assert.equal(preview.count, 0);

  assert.equal((await R.decisionsSegmentCreate({ body: { name: "attack", groups: attack } })).ok, true);
  const listed = await R.decisionsSegments({});
  assert.equal(listed.total, 3, "every account is still there after the rule was stored and run again");
  assert.equal(listed.segments[0].count, 0);
});

test("the description route answers with criteria and never saves one", async () => {
  workspaceWithAccounts();
  // useModel:false keeps this test off the network. The model paths are covered
  // above with an injected complete(), where the answer can be chosen.
  const r = await R.decisionsSegmentDescribe({ body: { text: "enterprise customers over $50k", useModel: false } });
  assert.equal(r.ok, true);
  assert.equal(r.source, "phrases");
  assert.deepEqual(
    r.rules.map((x) => `${x.field} ${x.op} ${x.value}`).sort(),
    ["arr gt 50000", "plan is Enterprise"],
  );
  assert.deepEqual((await R.decisionsSegments({})).segments, [], "a reading is a proposal, not a save");

  assert.equal((await R.decisionsSegmentDescribe({ body: { text: "   " } })).ok, false);
});

test("the segment routes are namespaced and do not collide with the ones already there", async () => {
  const mine = Object.keys(R).filter((k) => k.startsWith("decisionsSegment"));
  assert.equal(mine.length, 6, `expected six segment routes, saw ${mine.join(", ")}`);
  for (const name of mine) assert.match(name, /^decisions[A-Z]/);
});
