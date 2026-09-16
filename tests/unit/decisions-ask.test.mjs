// The Ask backend: a bounded question answerer that is NOT text-to-SQL.
//
// 🔴 WHAT THESE TESTS ARE REALLY GUARDING. The whole competitive argument is that
// no model output reaches the database, so the tests that matter most are the
// hostile ones: a model that names a table instead of an intent, a model that
// sends a parameter the catalogue never declared, a model that is not there at
// all. Every one of those must end in a refusal or a keyword match, never in a
// number that looks right.
//
// Hermetic: an in-memory database, no gateway, no network. `complete` is always
// a function the test supplies - the same seam reason.mjs already uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LEDGERLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerline-ask-test-"));

const { openMemory, setMeta, setSettings } = await import("../../src/decisions/db.mjs");
const { answerQuestion, CATALOGUE } = await import("../../src/decisions/ask.mjs");
const { decisionRoutes } = await import("../../src/decisions/routes.mjs");
const { pkg } = await import("../../src/util/paths.mjs");

const AS_OF = "2026-09-09";

/** A workspace with two customers, one run, one overdue churn risk and some history. */
function seeded() {
  const db = openMemory();
  setMeta(db, "as_of", AS_OF);
  setSettings(db, { demoMode: true });

  const account = db.prepare(
    "INSERT INTO account (id, name, arr, plan, seats_purchased, renewal_date, owner, segment, industry, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  account.run("a1", "Northwind", 50000, "Pro", 40, "2026-10-01", "Dana", "Enterprise", "Logistics", "2024-01-01");
  account.run("a2", "Contoso", 12000, "Team", 10, "2027-03-01", "", "SMB", "Retail", "2025-06-01");
  // 🔴 THESE TWO NAMES ARE THE TEST. "50% Off" as an UNESCAPED LIKE pattern is
  // "50", anything, " off" — which matches BOTH of them. Escaped, it is the
  // literal text and matches only the first. Without the second row the escaping
  // could be deleted and every assertion here would still pass.
  account.run("a3", "50% Off Ltd", 3000, "Team", 5, null, "", "SMB", "Retail", "2025-06-01");
  account.run("a4", "50 Percent Off Co", 4000, "Team", 5, null, "", "SMB", "Retail", "2025-06-01");

  db.prepare(
    "INSERT INTO run (id, started_at, finished_at, as_of, status, accounts, signals, candidates, decisions_created, decisions_updated) VALUES ('run1', ?, ?, ?, 'ok', 3, 4, 2, 1, 0)",
  ).run(`${AS_OF}T08:00:00.000Z`, `${AS_OF}T08:01:00.000Z`, AS_OF);

  db.prepare("INSERT INTO account_run_state (run_id, account_id, label, tenure_days) VALUES ('run1', ?, ?, 600)").run("a1", "at_risk");
  db.prepare("INSERT INTO account_run_state (run_id, account_id, label, tenure_days) VALUES ('run1', ?, ?, 90)").run("a2", "healthy");

  db.prepare(
    "INSERT INTO signal (id, run_id, account_id, kind, band, statement) VALUES ('s1', 'run1', 'a1', 'usage_drop_30d', 3, 'Daily active users fell 45% over 30 days')",
  ).run();

  db.prepare(
    `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, impact_amount,
       currency, created_at, updated_at, due_at, owner)
     VALUES ('d1', 'a1', 'a1:churn_risk', 'churn_risk', 'Northwind: churn risk', 'high', 'new', 'rule_only', 50000, 'USD', '2026-09-01', '2026-09-01', '2026-09-05', '')`,
  ).run();
  db.prepare(
    `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, impact_amount,
       currency, created_at, updated_at, due_at, owner)
     VALUES ('d2', 'a2', 'a2:expansion', 'expansion', 'Contoso: room to grow', 'medium', 'accepted', 'rule_only', NULL, 'USD', '2026-09-02', '2026-09-02', '2026-09-30', 'Dana')`,
  ).run();
  db.prepare("INSERT INTO decision_event (id, decision_id, at, actor, kind) VALUES ('e1', 'd1', ?, 'system', 'created')").run("2026-09-01T09:00:00.000Z");
  db.prepare("INSERT INTO decision_event (id, decision_id, at, actor, kind) VALUES ('e2', 'd2', ?, 'user', 'status')").run("2026-09-08T09:00:00.000Z");
  return db;
}

/** A model that returns whatever text the test names, through the real call shape. */
const modelSaying = (content) => async () => ({ content, servedBy: "test/model", requested: "test/model", usage: { inputTokens: 10, outputTokens: 5 }, latencyMs: 1 });
const deadModel = async () => {
  throw new Error("model request failed after 5 attempt(s) - no key");
};

/* ── the boundary: nothing a model writes reaches SQLite ─────────────────── */

test("a model that answers with SQL instead of an intent id never reaches the database", async () => {
  const db = seeded();
  const sql = "SELECT name FROM account; DROP TABLE decision;";
  const r = await answerQuestion(db, {
    question: "list every customer with their plan and their invoice history",
    complete: modelSaying(JSON.stringify({ intent: sql, params: {} })),
  });

  // The proof that nothing ran: the table the string tried to drop is still there.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM decision").get().n, 2);
  // An invalid id is a broken model, which degrades to the keyword path like any
  // other model failure. What must NOT happen is the string being honoured.
  assert.equal(r.source, "rule_only", "an unusable model answer must fall through to the keyword path");
  assert.ok(r.intent === null || CATALOGUE.some((i) => i.id === r.intent), `ran "${r.intent}", which is not a catalogue entry`);
  if (r.result.kind === "answer") {
    const at = (key) => r.result.evidence.find(([k]) => k === key)?.[1] ?? "";
    assert.ok(!at("Query").includes("DROP"), "the model's string must not reach the query");
    assert.ok(!at("Parameters used").includes("DROP"), "the model's string must not reach a bound value");
    // It IS quoted back in the evidence, on purpose: a model behaving like this
    // should be visible to the person reading the answer, not swallowed.
    assert.match(at("Chosen by"), /not in the catalogue/);
  }

  const call = db.prepare("SELECT * FROM llm_call WHERE purpose = 'ask_intent' ORDER BY at DESC").get();
  assert.equal(call.valid, 0, "the rejected answer must be recorded as invalid, so a model doing this is visible");
  assert.match(call.error, /not in the catalogue/);
  db.close();
});

test("a parameter the catalogue never declared is dropped and reported, not passed on", async () => {
  const db = seeded();
  const r = await answerQuestion(db, {
    question: "how many decisions are open",
    complete: modelSaying(JSON.stringify({ intent: "open_decisions", params: { kind: "churn_risk", sqlWhere: "1=1 OR name LIKE '%'", tableName: "sqlite_master" } })),
  });
  assert.equal(r.result.kind, "answer");
  const ignored = r.result.evidence.find(([k]) => k === "Parameters ignored");
  assert.ok(ignored, "the answer must say which parameters were thrown away");
  assert.match(ignored[1], /sqlWhere/);
  assert.match(ignored[1], /tableName/);
  const used = r.result.evidence.find(([k]) => k === "Parameters used");
  assert.ok(!used[1].includes("sqlWhere"), "an undeclared parameter must not reach the query");
  db.close();
});

test("an out-of-range parameter falls back to the default and says so", async () => {
  const db = seeded();
  const r = await answerQuestion(db, {
    question: "which renewals are coming up",
    complete: modelSaying(JSON.stringify({ intent: "renewals_due", params: { days: 100000 } })),
  });
  assert.equal(r.result.kind, "answer");
  const note = r.result.evidence.find(([k]) => k === "Parameter corrected");
  assert.ok(note, "a rejected value must be visible, not silently replaced");
  assert.match(note[1], /days: 100000 is outside 1-365/);
  db.close();
});

test("a required parameter that cannot be filled refuses rather than guessing", async () => {
  const db = seeded();
  const r = await answerQuestion(db, {
    question: "tell me about that company we spoke to",
    complete: modelSaying(JSON.stringify({ intent: "customer_lookup", params: {} })),
  });
  assert.equal(r.result.kind, "refusal");
  assert.ok(r.result.checked.some((c) => c.includes("name:")), `the refusal must name the parameter, saw: ${JSON.stringify(r.result.checked)}`);
  db.close();
});

test("free text in a parameter is bound, and LIKE wildcards in it are escaped", async () => {
  const db = seeded();
  const hit = await answerQuestion(db, {
    question: "how is 50% Off Ltd doing",
    complete: modelSaying(JSON.stringify({ intent: "customer_lookup", params: { name: "50% Off" } })),
  });
  assert.equal(hit.result.kind, "answer");
  assert.equal(hit.result.records.total, 0, "one customer matched, so the records are that customer's open decisions");
  const id = hit.result.evidence.find(([k]) => k === "Customer id");
  assert.ok(id, "an unescaped % would match two customers and return the disambiguation list instead");
  assert.equal(id[1], "a3", "the % must be matched as a character, not as a wildcard");
  assert.equal(hit.result.value, "$3,000");

  const quoted = await answerQuestion(db, {
    question: "how is this customer doing",
    complete: modelSaying(JSON.stringify({ intent: "customer_lookup", params: { name: "' OR 1=1 --" } })),
  });
  assert.equal(quoted.result.kind, "refusal", "a quote in a name is a value, so it simply matches nothing");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 4);
  db.close();
});

/* ── refusal is a first-class result ─────────────────────────────────────── */

test("a question outside the catalogue is refused, with what can be asked instead", async () => {
  const db = seeded();
  const r = await answerQuestion(db, {
    question: "what is the weather in Oslo tomorrow",
    complete: modelSaying(JSON.stringify({ intent: null, why: "no entry is about weather" })),
  });
  assert.equal(r.result.kind, "refusal");
  assert.ok(r.result.suggestions.length > 0, "a refusal must list what CAN be asked");
  for (const s of r.result.suggestions) {
    assert.ok(CATALOGUE.some((i) => i.question === s), `"${s}" is not a catalogue question`);
  }
  db.close();
});

test("a no-match refusal is never a zero", async () => {
  const db = seeded();
  const r = await answerQuestion(db, { question: "what is the weather in Oslo tomorrow", noModel: true });
  assert.equal(r.result.kind, "refusal");
  assert.equal(r.result.value, undefined, "a refusal must carry no number at all — a 0 here reads as an answer");
  assert.ok(r.result.reason.length > 20);
  db.close();
});

test("a question that needs a run refuses instead of reporting zero", async () => {
  const db = openMemory();
  setMeta(db, "as_of", AS_OF);
  setSettings(db, { demoMode: true });
  db.prepare("INSERT INTO account (id, name, arr, created_at) VALUES ('a1', 'Northwind', 50000, '2024-01-01')").run();

  const r = await answerQuestion(db, { question: "which customers are at risk", noModel: true });
  assert.equal(r.result.kind, "refusal", "no analysis has run, so nobody has looked — that is not the same as nobody being at risk");
  assert.ok(r.result.remedies.some((m) => m.kind === "run"), "the remedy must be to run the analysis");
  db.close();
});

/* ── working with no model at all ────────────────────────────────────────── */

test("with no model the question is matched by keyword, and the answer says that", async () => {
  const db = seeded();
  const r = await answerQuestion(db, { question: "how much ARR is under review", complete: deadModel });
  assert.equal(r.result.kind, "answer");
  assert.equal(r.source, "rule_only", "a dead model must degrade, exactly as reason.mjs does");
  assert.equal(r.intent, "arr_under_review");
  const how = r.result.evidence.find(([k]) => k === "Chosen by");
  assert.match(how[1], /keyword match/, "the answer must admit the model was not involved");
  assert.match(how[1], /no key/, "and must carry the reason the model was not involved");
  assert.equal(r.result.value, "$50,000");
  db.close();
});

test("every catalogue entry is reachable by keyword alone, so the offline build is not half a feature", async () => {
  const db = seeded();
  const asked = {
    open_decisions: "which decisions are overdue",
    arr_under_review: "how much ARR is under review",
    customers_by_label: "which customers are at risk",
    renewals_due: "which renewals are coming up in 30 days",
    arr_by_group: "what is the total ARR by segment",
    accounts_with_signal: "which accounts have a usage drop",
    changed_since: "what changed since 2026-09-01",
    customer_lookup: "how is Northwind doing",
    last_run: "what did the last analysis run do",
  };
  assert.deepEqual(Object.keys(asked).sort(), CATALOGUE.map((i) => i.id).sort(), "every catalogue entry needs a phrasing here");
  for (const [id, question] of Object.entries(asked)) {
    const r = await answerQuestion(db, { question, noModel: true });
    assert.equal(r.intent, id, `"${question}" matched ${r.intent} instead of ${id}`);
    assert.equal(r.result.kind, "answer", `"${question}" did not produce an answer`);
  }
  db.close();
});

test("keyword matching fills parameters out of the sentence", async () => {
  const db = seeded();
  const days = await answerQuestion(db, { question: "which renewals are coming up in the next 14 days", noModel: true });
  assert.match(days.result.evidence.find(([k]) => k === "Parameters used")[1], /days=14/);

  const group = await answerQuestion(db, { question: "what is total ARR by industry", noModel: true });
  assert.match(group.result.evidence.find(([k]) => k === "Parameters used")[1], /groupBy=industry/);

  const unowned = await answerQuestion(db, { question: "which open decisions have nobody on them", noModel: true });
  assert.match(unowned.result.evidence.find(([k]) => k === "Parameters used")[1], /owner=unassigned/);
  assert.equal(unowned.result.records.total, 1, "only d1 has an empty owner");
  db.close();
});

/* ── every answer carries its evidence and its records ───────────────────── */

test("an answer always says which catalogue question it actually answered", async () => {
  const db = seeded();
  for (const question of ["how much ARR is under review", "which renewals are coming up", "what did the last analysis do"]) {
    const r = await answerQuestion(db, { question, noModel: true });
    const understood = r.result.evidence.find(([k]) => k === "Understood as");
    assert.ok(understood, `"${question}" produced no "Understood as" line`);
    assert.ok(CATALOGUE.some((i) => i.question === understood[1]));
    assert.match(r.result.sentence, /^Ledgerline read this as "/, "the sentence must state the question that was answered, not only the evidence block");
    assert.ok(r.result.evidence.some(([k]) => k === "Query"), "every answer must name the query it ran");
    assert.ok(r.result.definition.length > 40, "every answer must say what it counted");
  }
  db.close();
});

test("the records behind a number are returned with it, not a bare figure", async () => {
  const db = seeded();
  const r = await answerQuestion(db, { question: "which decisions are open", noModel: true });
  assert.equal(r.result.value, "2");
  assert.equal(r.result.records.total, 2);
  assert.equal(r.result.records.rows.length, 2);
  assert.equal(r.result.records.columns.length, r.result.records.rows[0].cells.length, "every row must have one cell per column");
  assert.deepEqual(
    r.result.records.rows.map((row) => row.go).sort(),
    ["decisions/d1", "decisions/d2"],
    "each record must link to the decision it counted",
  );
  db.close();
});

test("overdue is counted the way the follow-up loop counts it, not by a second date rule", async () => {
  const db = seeded();
  // d1 is due 2026-09-05 and still "new"; d2 is due 2026-09-30 and "accepted".
  const r = await answerQuestion(db, { question: "which open decisions are overdue", noModel: true });
  assert.equal(r.result.records.total, 1);
  assert.equal(r.result.records.rows[0].go, "decisions/d1");
  assert.match(r.result.records.rows[0].cells[4], /4 days overdue/);
  db.close();
});

test("ARR by segment adds up to the ARR of every customer, including the ones with no segment", async () => {
  const db = seeded();
  db.prepare("INSERT INTO account (id, name, arr, segment, created_at) VALUES ('a5', 'Fabrikam', 7000, '', '2025-01-01')").run();
  const r = await answerQuestion(db, { question: "what is the total ARR by segment", noModel: true });
  assert.equal(r.result.value, "$76,000", "50000 + 12000 + 3000 + 4000 + 7000");
  const rows = r.result.records.rows;
  assert.ok(rows.some((x) => x.cells[0] === "(not set)"), "a customer with no segment must be grouped, never dropped");
  db.close();
});

/* ── the route ───────────────────────────────────────────────────────────── */

test("the Ask route exists, is namespaced, and guards its input before touching a workspace", async () => {
  assert.ok(Object.hasOwn(decisionRoutes, "decisionsAsk"), "the page calls /x/decisionsAsk");
  assert.match("decisionsAsk", /^decisions[A-Z]/);

  const empty = await decisionRoutes.decisionsAsk({ body: {} });
  assert.equal(empty.ok, false);
  const long = await decisionRoutes.decisionsAsk({ body: { question: "a".repeat(401) } });
  assert.equal(long.ok, false);
  assert.match(long.error, /too long/);
});

test("the route answers end to end through a real workspace, with no model and no network", async () => {
  const workspace = await import("../../src/decisions/workspace.mjs");

  // Before a workspace exists the page has a state to branch on, not an exception.
  const none = await decisionRoutes.decisionsAsk({ body: { question: "how much ARR is under review" } });
  assert.equal(none.ok, false);
  assert.equal(none.needsWorkspace, true);

  const made = workspace.create("Ask end to end");
  assert.equal(made.ok, true);
  const sel = workspace.openSelected();
  setMeta(sel.db, "as_of", AS_OF);
  setSettings(sel.db, { demoMode: true });
  sel.db.prepare("INSERT INTO account (id, name, arr, segment, created_at) VALUES ('a1', 'Northwind', 50000, 'Enterprise', '2024-01-01')").run();
  sel.db.prepare("INSERT INTO account (id, name, arr, segment, created_at) VALUES ('a2', 'Contoso', 12000, 'SMB', '2025-01-01')").run();
  sel.db.close();

  // noModel is the same seam decisionsRun already has: it forces the keyword
  // path, which is what proves this works on a machine with no gateway at all.
  const r = await decisionRoutes.decisionsAsk({ body: { question: "what is the total ARR by segment", noModel: true } });
  assert.equal(r.ok, true);
  assert.equal(r.source, "rule_only");
  assert.equal(r.intent, "arr_by_group");
  assert.equal(r.asOf, AS_OF, "the route must answer against the pinned day, not the wall clock");
  assert.equal(r.result.kind, "answer");
  assert.equal(r.result.value, "$62,000");
  assert.ok(r.catalogue.length >= 9, "the route must tell the page what CAN be asked");
  assert.ok(r.catalogue.every((c) => c.id && c.question), "every catalogue entry needs an id and a question");

  const refused = await decisionRoutes.decisionsAsk({ body: { question: "what is the weather in Oslo", noModel: true } });
  assert.equal(refused.ok, true, "a refusal is a result, not an HTTP error");
  assert.equal(refused.result.kind, "refusal");
  assert.equal(refused.result.suggestions.length > 0, true);

  workspace.remove(made.workspace.id, made.workspace.name);
});

test("the Ask page calls the route it needs and no longer carries the unwired stub", () => {
  const js = fs.readFileSync(pkg("src", "ui", "public", "v2", "pages", "ask.js"), "utf8");
  assert.match(js, /api\(\s*["']decisionsAsk["']/, "the page must call the route");
  assert.ok(!/Not wired yet/.test(js), "the stub's throw must be gone");
  assert.ok(!/throw new Error/.test(js.slice(0, 4000)), "the typed path must not throw any more");
});
