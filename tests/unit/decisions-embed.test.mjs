// The embeddable widget: keys, data scopes, and the leak this feature exists to
// not have.
//
// 🔴 THE MOST VALUABLE TEST IN THIS FILE IS "a key can never silently widen".
// The product this mechanism is modelled on documents its own behaviour:
// deleting a scope leaves the keys that used it alive, with NO scope, reading
// the whole workspace. It is a data leak triggered by tidying up, and it fails
// open — nothing errors, so the first sign of it is a customer seeing another
// customer's numbers.
//
// Three tests below pin the three ways that must not happen:
//   * deleting a scope in use is REFUSED and names the keys;
//   * deleting it WITH its keys revokes them in the same transaction;
//   * a key whose scope row is gone by ANY means is refused — proved by
//     deleting the row behind the API's back, which is what a hand edit, a
//     restored backup or a future bug looks like from the key's side.
//
// The second thing these tests are for is the row filter. A filter that only
// hides ROWS leaks every TOTAL computed over them, so the assertions below
// compare a scoped answer with the unscoped one and require the numbers to
// differ by exactly the accounts the scope excludes.
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-embed-test-"));

const { openMemory, MIGRATIONS, open } = await import("../../src/decisions/db.mjs");
const E = await import("../../src/decisions/embed.mjs");
const workspace = await import("../../src/decisions/workspace.mjs");

const AS_OF = "2026-09-15";
const ask = { noModel: true };

/**
 * Create the embed tables if the migration has not been wired into MIGRATIONS
 * yet. Written this way on purpose: the same file must pass before the
 * orchestrator appends EMBED_MIGRATION and after.
 */
function ensureEmbedTables(db) {
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'embed_key'").get();
  if (!has) db.exec(E.EMBED_MIGRATION);
  return db;
}

/**
 * Five customers worth $505,000 between them: three on Enterprise worth
 * $460,000 and two on Growth worth $45,000. Three open decisions, one of which
 * belongs to nobody in particular.
 */
function seed() {
  const db = ensureEmbedTables(openMemory());
  const acc = db.prepare("INSERT INTO account (id, name, arr, plan, owner, renewal_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  acc.run("a1", "Northwind", 120000, "Enterprise", "Dana", "2026-10-01", "2024-01-01");
  acc.run("a2", "Contoso", 40000, "Growth", "Dana", "2026-12-20", "2025-02-01");
  acc.run("a3", "Fabrikam", 90000, "Enterprise", "Ravi", null, "2025-06-01");
  acc.run("a4", "Initech", 5000, "Growth", null, "2026-09-20", "2026-01-01");
  acc.run("a5", "Umbrella", 250000, "Enterprise", "Ravi", "2027-03-01", "2023-03-01");

  db.prepare("INSERT INTO run (id, started_at, as_of, status) VALUES ('r1', '2026-09-15T09:00:00Z', ?, 'done')").run(AS_OF);
  const st = db.prepare("INSERT INTO account_run_state (run_id, account_id, label, tenure_days) VALUES ('r1', ?, ?, ?)");
  st.run("a1", "at_risk", 600);
  st.run("a2", "at_risk", 400);

  const dec = db.prepare(
    `INSERT INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source, impact_amount, currency, created_at, updated_at)
     VALUES (?, ?, ?, 'churn_risk', ?, 'high', 'new', 'rule_only', ?, 'USD', '2026-09-01T09:00:00Z', '2026-09-01T09:00:00Z')`,
  );
  dec.run("d1", "a1", "f1", "Northwind is at risk", 120000);
  dec.run("d2", "a2", "f2", "Contoso is at risk", 40000);
  dec.run("d3", null, "f3", "Company-wide pricing review", 9999);
  return db;
}

const ENTERPRISE = [{ rules: [{ field: "plan", op: "is", value: "Enterprise" }] }];

/** A scope plus a key against it, the way the screen creates them. */
function scopedKey(db, { name = "Enterprise only", intents = [], groups = ENTERPRISE, ...rest } = {}) {
  const scope = E.createScope(db, { name, intents, groups });
  assert.equal(scope.ok, true, scope.error);
  const key = E.createKey(db, { name: `${name} key`, scopeId: scope.scope.id, ...rest });
  assert.equal(key.ok, true, key.error);
  return { scope: scope.scope, key: key.key, secret: key.secret };
}

const askWith = (db, { secret, scope }, question, extra = {}) =>
  E.askThroughKey(db, { key: secret, scopeId: scope?.id ?? undefined, question, ...ask, ...extra });

/* ══ THE MIGRATION ═════════════════════════════════════════════════════════ */

test("the embed tables arrive as their own migration, leaving the shipped ones untouched", () => {
  assert.match(E.EMBED_MIGRATION, /CREATE TABLE embed_scope/);
  assert.match(E.EMBED_MIGRATION, /CREATE TABLE embed_key/);
  // Migrations 1 and 2 have shipped. A database that has already run them will
  // never run them again, so editing one would change a fresh install only.
  assert.ok(!MIGRATIONS[0].includes("embed_key"), "migration 1 must not mention embed_key");
  assert.ok(!MIGRATIONS[1].includes("embed_key"), "migration 2 must not mention embed_key");
  if (MIGRATIONS.length > 2) {
    assert.ok(MIGRATIONS.includes(E.EMBED_MIGRATION), "once wired, the array must carry this exact string, appended");
  }
});

test("a database already carrying customers takes the new tables without losing them", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(MIGRATIONS[0]);
  db.exec(MIGRATIONS[1]);
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('a1', 'Northwind', 1)").run();

  db.exec(E.EMBED_MIGRATION);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embed_key").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embed_scope").get().n, 0);
  assert.equal(db.prepare("SELECT name FROM account WHERE id = 'a1'").get().name, "Northwind");
  db.close();
});

/* ══ THE KEY IS SHOWN ONCE ═════════════════════════════════════════════════ */

test("🔴 the full key is returned once and never written to the database", () => {
  const db = seed();
  const made = E.createKey(db, { name: "Marketing site" });
  assert.equal(made.ok, true);
  assert.match(made.secret, /^vek_[A-Za-z0-9_-]{20,}$/, "the secret is a real random string behind a recognisable prefix");

  const row = db.prepare("SELECT * FROM embed_key WHERE id = ?").get(made.key.id);
  for (const [col, value] of Object.entries(row)) {
    assert.ok(!String(value ?? "").includes(made.secret), `${col} holds the secret itself`);
  }
  assert.equal(row.key_hash, crypto.createHash("sha256").update(made.secret).digest("hex"), "only a hash of it is stored");
  assert.equal(row.prefix, made.secret.slice(0, 12), "and a short prefix, so a person can tell two keys apart");

  // Nothing that reads keys back can hand it out again.
  assert.equal(E.getKey(db, made.key.id).secret, undefined);
  for (const k of E.listKeys(db)) assert.equal(k.secret, undefined);
  db.close();
});

test("a key is accepted only when the exact secret is presented", () => {
  const db = seed();
  E._resetRateLimits();
  const made = E.createKey(db, { name: "Site" });

  assert.equal(E.authenticate(db, { key: made.secret }).ok, true);
  assert.match(E.authenticate(db, { key: `${made.secret}x` }).error, /not one this workspace issued/);
  assert.match(E.authenticate(db, { key: made.key.prefix }).error, /not one this workspace issued/);
  assert.match(E.authenticate(db, {}).error, /without an embed key/);
  db.close();
});

/* ══ REVOKED, EXPIRED, WRONG SITE ══════════════════════════════════════════ */

test("a revoked key stops working and says who stopped it", () => {
  const db = seed();
  E._resetRateLimits();
  const made = E.createKey(db, { name: "Site" });
  assert.equal(E.authenticate(db, { key: made.secret }).ok, true);

  assert.equal(E.revokeKey(db, made.key.id, "the contract ended").ok, true);
  const after = E.authenticate(db, { key: made.secret });
  assert.equal(after.ok, false);
  assert.match(after.error, /revoked — the contract ended/);
  assert.match(E.revokeKey(db, made.key.id, "again").error, /already revoked/);
  db.close();
});

test("an expiry is read as the END of the day it names", () => {
  const db = seed();
  E._resetRateLimits();
  const live = E.createKey(db, { name: "Live", expiresAt: "2099-01-01" });
  const dead = E.createKey(db, { name: "Dead", expiresAt: "2020-01-01" });
  assert.equal(live.key.expiresAt, "2099-01-01T23:59:59.999Z", "not midnight, or the key dies a day early");

  assert.equal(E.authenticate(db, { key: live.secret }).ok, true);
  assert.match(E.authenticate(db, { key: dead.secret }).error, /expired on 2020-01-01/);
  assert.match(E.createKey(db, { name: "x", expiresAt: "not a date" }).error, /is not a date/);
  db.close();
});

test("an allowed-origin list refuses a key used on a site it does not name", () => {
  const db = seed();
  E._resetRateLimits();
  const made = E.createKey(db, { name: "Partner", origins: ["https://partner.example/dashboard?x=1"] });
  assert.deepEqual(made.key.origins, ["https://partner.example"], "the path and query are dropped; an origin is an origin");

  assert.equal(E.authenticate(db, { key: made.secret, origin: "https://partner.example" }).ok, true);
  assert.match(E.authenticate(db, { key: made.secret, origin: "https://evil.example" }).error, /not allowed on https:\/\/evil.example/);
  assert.match(E.authenticate(db, { key: made.secret }).error, /did not say which site/);

  const open = E.createKey(db, { name: "Anywhere" });
  assert.deepEqual(open.key.origins, []);
  assert.equal(E.authenticate(db, { key: open.secret, origin: "https://anything.example" }).ok, true, "an empty list means any site");
  assert.match(E.createKey(db, { name: "x", origins: ["not a url"] }).error, /not a web address/);
  db.close();
});

/* ══ 🔴 THE FOOTGUN ════════════════════════════════════════════════════════ */

test("🔴 deleting a data scope that keys still use is REFUSED, and names them", () => {
  const db = seed();
  E._resetRateLimits();
  const { scope, key } = scopedKey(db);

  const refused = E.deleteScope(db, scope.id);
  assert.equal(refused.ok, false);
  assert.equal(refused.needsRevoke, true, "the page needs to know a second, explicit choice exists");
  assert.match(refused.error, /1 embed key still uses "Enterprise only"/);
  assert.ok(refused.error.includes(key.prefix), "and the key is named, so the person can check it before killing it");

  assert.ok(E.getScope(db, scope.id), "nothing was deleted");
  assert.equal(E.getKey(db, key.id).revokedAt, null, "and nothing was revoked");
  db.close();
});

test("🔴 deleting it WITH its keys revokes them in the same breath, and they stop working", () => {
  const db = seed();
  E._resetRateLimits();
  const made = scopedKey(db);

  assert.equal(E.authenticate(db, { key: made.secret, scopeId: made.scope.id }).ok, true);

  const gone = E.deleteScope(db, made.scope.id, { revokeKeys: true });
  assert.equal(gone.ok, true);
  assert.equal(gone.revoked, 1);
  assert.equal(E.getScope(db, made.scope.id), null);

  const row = E.getKey(db, made.key.id);
  assert.ok(row, "the key row survives, because it is the only record the key ever existed");
  assert.ok(row.revokedAt, "but it is revoked");
  assert.match(row.revokedReason, /the data scope "Enterprise only" was deleted/);

  const after = E.authenticate(db, { key: made.secret, scopeId: made.scope.id });
  assert.equal(after.ok, false);
  assert.match(after.error, /revoked/);
  db.close();
});

test("🔴 a key whose scope row has gone reads NOTHING — it never falls back to the whole workspace", async () => {
  // This is the documented leak, reproduced as closely as it can be: the scope
  // row is removed behind the API's back, which is what a hand edit, a restored
  // backup, or a bug in the two rules above looks like from the key's side.
  const db = seed();
  E._resetRateLimits();
  const made = scopedKey(db);

  const before = await askWith(db, made, "what is the total arr by plan");
  assert.equal(before.ok, true);
  assert.equal(before.result.value, "$460,000", "while the scope exists it answers for the three Enterprise customers");

  db.prepare("DELETE FROM embed_scope WHERE id = ?").run(made.scope.id);
  assert.equal(E.getScope(db, made.scope.id), null, "the row really is gone");
  assert.equal(E.getKey(db, made.key.id).revokedAt, null, "and the key was NOT revoked — this is the dangerous state");
  assert.equal(E.getKey(db, made.key.id).scopeMissing, true, "which the key list reports as orphaned, never as unscoped");

  const after = await askWith(db, made, "what is the total arr by plan");
  assert.equal(after.ok, false, "the key must be refused, not widened");
  assert.match(after.error, /no longer exists/);
  assert.ok(!JSON.stringify(after).includes("505"), "and not one figure from outside the old scope comes back");
  assert.ok(!JSON.stringify(after).includes("Contoso"));

  // The same is true of the boot call, which is the one an embed makes first.
  const info = E.widgetInfo(db, { key: made.secret, scopeId: made.scope.id });
  assert.equal(info.ok, false);
  assert.match(info.error, /no longer exists/);
  db.close();
});

/* ══ 🔴 THE URL CANNOT WIDEN ═══════════════════════════════════════════════ */

test("🔴 editing the data scope in the embed address can only make a request fail", async () => {
  const db = seed();
  E._resetRateLimits();
  const mine = scopedKey(db);
  const theirs = scopedKey(db, { name: "Growth only", groups: [{ rules: [{ field: "plan", op: "is", value: "Growth" }] }] });

  // Dropping the scopeId: refused, not treated as "no scope".
  const dropped = await E.askThroughKey(db, { key: mine.secret, question: "what is the total arr by plan", ...ask });
  assert.equal(dropped.ok, false);
  assert.match(dropped.error, /must name its data scope/);

  // Naming somebody else's scope: refused, and it does NOT read that scope.
  const swapped = await E.askThroughKey(db, {
    key: mine.secret,
    scopeId: theirs.scope.id,
    question: "what is the total arr by plan",
    ...ask,
  });
  assert.equal(swapped.ok, false);
  assert.match(swapped.error, /not the one its key was issued for/);

  // A key with no scope cannot be given one from the address either.
  const bare = E.createKey(db, { name: "Whole workspace" });
  const attached = await E.askThroughKey(db, {
    key: bare.secret,
    scopeId: mine.scope.id,
    question: "what is the total arr by plan",
    ...ask,
  });
  assert.equal(attached.ok, false);
  assert.match(attached.error, /cannot be attached from the embed address/);
  db.close();
});

/* ══ THE ROW FILTER IS ENFORCED BEFORE THE QUESTION, NOT AFTER ═════════════ */

test("🔴 a scoped answer's TOTAL is computed from the scoped rows, not filtered afterwards", async () => {
  const db = seed();
  E._resetRateLimits();
  const scoped = scopedKey(db);
  const whole = E.createKey(db, { name: "Whole workspace" });

  const all = await E.askThroughKey(db, { key: whole.secret, question: "what is the total arr by plan", ...ask });
  assert.equal(all.ok, true);
  assert.equal(all.result.value, "$505,000", "unscoped, every customer counts");
  assert.equal(all.result.records.total, 2, "two plans exist in the workspace");

  const mine = await askWith(db, scoped, "what is the total arr by plan");
  assert.equal(mine.ok, true);
  assert.equal(mine.result.value, "$460,000", "scoped, only the three Enterprise customers count");
  assert.equal(mine.result.records.total, 1, "the Growth group is not hidden — it does not exist in what was read");
  assert.ok(!JSON.stringify(mine.result).includes("Contoso"));
  assert.ok(!JSON.stringify(mine.result).includes("Initech"));
  assert.equal(mine.scope.accounts, 3);
  db.close();
});

test("a count over another table is scoped too, and a company-wide row is not 'their own'", async () => {
  const db = seed();
  E._resetRateLimits();
  const scoped = scopedKey(db);
  const whole = E.createKey(db, { name: "Whole workspace" });

  const all = await E.askThroughKey(db, { key: whole.secret, question: "how many open decisions", ...ask });
  assert.equal(all.result.value, "3", "one per customer plus the company-wide one");

  const mine = await askWith(db, scoped, "how many open decisions");
  assert.equal(mine.result.value, "1", "only Northwind's — Contoso is out of scope and nothing is company-wide here");
  assert.ok(!JSON.stringify(mine.result).includes("Contoso"));
  assert.ok(!JSON.stringify(mine.result).includes("Company-wide pricing review"));
  db.close();
});

test("a scope that matches nobody answers about nobody, rather than about everybody", async () => {
  const db = seed();
  E._resetRateLimits();
  const none = scopedKey(db, { name: "Nobody", groups: [{ rules: [{ field: "plan", op: "is", value: "Platinum" }] }] });
  const r = await askWith(db, none, "what is the total arr by plan");
  assert.equal(r.ok, true);
  assert.equal(r.scope.accounts, 0);
  assert.equal(r.result.kind, "refusal", "no customers is a refusal, not a zero dressed as an answer");
  assert.ok(!JSON.stringify(r).includes("505"));
  db.close();
});

test("🔴 a filter value that is SQL is data, and the customer table survives storing it", async () => {
  const db = seed();
  E._resetRateLimits();
  const attack = [{ rules: [{ field: "name", op: "contains", value: "'); DROP TABLE account; --" }] }];
  const made = scopedKey(db, { name: "Attack", groups: attack });

  const r = await askWith(db, made, "what is the total arr by plan");
  assert.equal(r.ok, true);
  assert.equal(r.scope.accounts, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 5, "the account table is still there");

  // And a field that is not on the segments allowlist is refused at save time.
  assert.match(E.createScope(db, { name: "Bad", groups: [{ rules: [{ field: "industry", op: "is", value: "x" }] }] }).error, /not a field/);
  db.close();
});

/* ══ THE QUESTION ALLOWLIST ════════════════════════════════════════════════ */

test("a scope can allow only some questions, and the refusal carries none of the answer", async () => {
  const db = seed();
  E._resetRateLimits();
  const made = scopedKey(db, { name: "Renewals only", intents: ["renewals_due"] });

  const allowed = await askWith(db, made, "which renewals are coming up in 30 days");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.intent, "renewals_due");

  const refused = await askWith(db, made, "what is the total arr by plan");
  assert.equal(refused.ok, true, "a refusal is a result, not an error");
  assert.equal(refused.result.kind, "refusal");
  assert.equal(refused.intent, null);
  const text = JSON.stringify(refused);
  assert.ok(!text.includes("460"), "no figure from the answer that was thrown away");
  assert.ok(!text.includes("505"));
  assert.ok(!text.includes("Northwind"));
  assert.deepEqual(refused.result.suggestions, ["Which renewals are coming up?"], "it says what it CAN answer instead");

  assert.match(E.createScope(db, { name: "x", intents: ["not_an_intent"] }).error, /is not a question Vireo can answer/);
  db.close();
});

test("an empty question list means every catalogue question, and says so", () => {
  const db = seed();
  const made = scopedKey(db, { name: "Everything", intents: [] });
  const listed = E.listScopes(db, { asOf: AS_OF, currency: "USD" }).find((s) => s.id === made.scope.id);
  assert.equal(listed.allQuestions, true);
  assert.equal(listed.questions.length, E.catalogueVocabulary().length);
  assert.ok(listed.tables.includes("account"));
  assert.equal(listed.accounts, 3);
  assert.equal(listed.liveKeys, 1);
  db.close();
});

/* ══ RATE LIMITING ═════════════════════════════════════════════════════════ */

test("a key is limited per minute, and the limit is per key", () => {
  const db = seed();
  E._resetRateLimits();
  const tight = E.createKey(db, { name: "Tight", ratePerMinute: 2 });
  const other = E.createKey(db, { name: "Other", ratePerMinute: 2 });

  assert.equal(E.authenticate(db, { key: tight.secret }).ok, true);
  assert.equal(E.authenticate(db, { key: tight.secret }).ok, true);
  const third = E.authenticate(db, { key: tight.secret });
  assert.equal(third.ok, false);
  assert.match(third.error, /limited to 2 questions a minute/);
  assert.ok(third.retryInSeconds >= 0);

  assert.equal(E.authenticate(db, { key: other.secret }).ok, true, "one key's flood must not stop another's");

  // The window is real seconds, so it reopens. An injected clock proves it
  // without the test sleeping for a minute.
  let clock = Date.now() + 61_000;
  assert.equal(E.authenticate(db, { key: tight.secret }, { now: () => clock }).ok, true);

  assert.match(E.createKey(db, { name: "x", ratePerMinute: 0 }).error, /between 1 and 600/);
  assert.match(E.createKey(db, { name: "x", ratePerMinute: 9999 }).error, /between 1 and 600/);
  assert.equal(E.createKey(db, { name: "Default rate" }).key.ratePerMinute, E.DEFAULT_RATE_PER_MINUTE);
  db.close();
});

test("use and refusal are counted on the key, so a leak leaves a trace", async () => {
  const db = seed();
  E._resetRateLimits();
  const made = scopedKey(db);
  await askWith(db, made, "what is the total arr by plan");
  await E.askThroughKey(db, { key: made.secret, question: "what is the total arr by plan", ...ask });

  const row = E.getKey(db, made.key.id);
  assert.equal(row.uses, 1, "one question answered");
  assert.equal(row.refusals, 1, "one request refused for naming no scope");
  assert.ok(row.lastUsedAt);
  assert.match(row.lastRefusal, /scope/);
  db.close();
});

/* ══ SCOPES: THE ORDINARY EDITING ══════════════════════════════════════════ */

test("a scope saves, lists with its live reach, updates and refuses a duplicate name", () => {
  const db = seed();
  const opts = { asOf: AS_OF, currency: "USD" };
  const made = E.createScope(db, { name: "  Enterprise  ", intents: ["renewals_due"], groups: ENTERPRISE });
  assert.equal(made.scope.name, "Enterprise", "the name is trimmed");
  assert.match(made.scope.id, /^esc_/);

  const listed = E.listScopes(db, opts);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].accounts, 3, "the reach follows the data, not a number stored at save time");
  assert.equal(listed[0].allAccounts, false);
  assert.deepEqual(listed[0].questions, ["Which renewals are coming up?"]);

  db.prepare("UPDATE account SET plan = 'Growth' WHERE id = 'a5'").run();
  assert.equal(E.listScopes(db, opts)[0].accounts, 2);

  assert.equal(E.updateScope(db, made.scope.id, { name: "Renamed" }).scope.name, "Renamed");
  assert.deepEqual(E.updateScope(db, made.scope.id, { name: "Renamed" }).scope.groups, ENTERPRISE, "a rename leaves the filter alone");
  assert.match(E.createScope(db, { name: "renamed", groups: ENTERPRISE }).error, /already a data scope called/);
  assert.match(E.createScope(db, { name: "  ", groups: ENTERPRISE }).error, /name/);
  assert.match(E.updateScope(db, "esc_nope", { name: "x" }).error, /does not exist/);
  assert.match(E.deleteScope(db, "esc_nope").error, /does not exist/);
  db.close();
});

test("a scope with no filter reaches every customer, and says that in words", () => {
  const db = seed();
  const made = E.createScope(db, { name: "All", groups: [] });
  const listed = E.listScopes(db, { asOf: AS_OF, currency: "USD" })[0];
  assert.equal(listed.allAccounts, true);
  assert.equal(listed.accounts, 5);

  const preview = E.previewScope(db, { groups: ENTERPRISE, intents: [] }, { asOf: AS_OF, currency: "USD" });
  assert.equal(preview.ok, true);
  assert.equal(preview.accounts, 3);
  assert.equal(preview.total, 5);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embed_scope").get().n, 1, "a preview saves nothing");
  assert.ok(made.ok);
  db.close();
});

test("a key can only be created against a scope that exists", () => {
  const db = seed();
  assert.match(E.createKey(db, { name: "x", scopeId: "esc_nope" }).error, /does not exist any more/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embed_key").get().n, 0);
  assert.match(E.createKey(db, { name: "  " }).error, /name/);
  assert.match(E.deleteKey(db, "emb_nope").error, /does not exist/);
  db.close();
});

/* ══ THE PROJECTION ════════════════════════════════════════════════════════ */

test("the scoped copy holds the scope's rows and nothing else, and the real workspace is untouched", () => {
  const db = seed();
  const made = E.createScope(db, { name: "Enterprise", groups: ENTERPRISE });
  E.createKey(db, { name: "Another customer's key", scopeId: made.scope.id });
  const p = E.projectWorkspace(db, made.scope, { asOf: AS_OF, currency: "USD" });
  assert.equal(p.ok, true);
  assert.equal(p.accounts, 3);

  assert.deepEqual(
    p.db.prepare("SELECT id FROM account ORDER BY id").all().map((r) => r.id),
    ["a1", "a3", "a5"],
  );
  assert.deepEqual(
    p.db.prepare("SELECT id FROM decision ORDER BY id").all().map((r) => r.id),
    ["d1"],
    "one customer's decision; not Contoso's and not the company-wide one",
  );
  assert.equal(p.db.prepare("SELECT COUNT(*) n FROM account_run_state").get().n, 1);
  assert.equal(p.db.prepare("SELECT COUNT(*) n FROM run").get().n, 1, "runs are workspace-level and come across");
  assert.ok(p.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get(), "and the settings the answer is computed with");

  // 🔴 The one table a widget must never reach: everybody else's keys. It is
  // absent because the copier does not list it, and this is what proves it is
  // still absent after somebody adds a table to that list.
  for (const t of ["embed_key", "embed_scope"]) {
    const present = p.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
    if (present) assert.equal(p.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n, 0, `${t} was copied into the scoped database`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM embed_key").get().n, 1, "the real workspace still has its key");

  p.db.close();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM account").get().n, 5, "nothing was moved out of the real workspace");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM decision").get().n, 3);
  db.close();
});

/* ══ THE ROUTES ════════════════════════════════════════════════════════════ */

const R = E.embedRoutes;

function liveWorkspace() {
  const made = workspace.create(`emb-${Math.random().toString(36).slice(2)}`);
  assert.equal(made.ok, true);
  const db = ensureEmbedTables(open(workspace.dbFileFor(made.workspace.id)));
  const acc = db.prepare("INSERT INTO account (id, name, arr, plan, owner) VALUES (?, ?, ?, ?, ?)");
  acc.run("a1", "Northwind", 120000, "Enterprise", "Dana");
  acc.run("a2", "Contoso", 40000, "Growth", "Dana");
  acc.run("a3", "Fabrikam", 90000, "Enterprise", "Ravi");
  db.close();
  return made.workspace.id;
}

test("the embed routes are namespaced and carry the whole screen in one read", async () => {
  liveWorkspace();
  for (const name of Object.keys(R)) assert.match(name, /^decisions[A-Z]/, `${name} must be namespaced`);

  const overview = await R.decisionsEmbedOverview({});
  assert.equal(overview.ok, true);
  assert.deepEqual(overview.scopes, []);
  assert.deepEqual(overview.keys, []);
  assert.ok(overview.catalogue.length > 5, "the page builds its question list from this");
  assert.ok(overview.fields.length > 5, "and its filter builder from this");
  assert.deepEqual(overview.choices.plans, ["Enterprise", "Growth"], "grounded in the imported data");
  assert.equal(overview.total, 3);
  assert.equal(overview.defaultRatePerMinute, E.DEFAULT_RATE_PER_MINUTE);
  assert.ok(overview.asOf);
});

test("a scope and a key are created, used and revoked over the routes", async () => {
  liveWorkspace();
  E._resetRateLimits();

  const preview = await R.decisionsEmbedScopePreview({ body: { groups: ENTERPRISE, intents: [] } });
  assert.equal(preview.accounts, 2);
  assert.deepEqual((await R.decisionsEmbedOverview({})).scopes, [], "a preview saves nothing");

  const scope = await R.decisionsEmbedScopeCreate({ body: { name: "Enterprise", groups: ENTERPRISE, intents: [] } });
  assert.equal(scope.ok, true);

  const key = await R.decisionsEmbedKeyCreate({ body: { name: "Site", scopeId: scope.scope.id } });
  assert.equal(key.ok, true);
  assert.match(key.secret, /^vek_/);

  const info = await R.decisionsEmbedInfo({ body: { key: key.secret, scopeId: scope.scope.id } });
  assert.equal(info.ok, true);
  assert.equal(info.scope.name, "Enterprise");
  assert.equal(info.accounts, 2);

  const answered = await R.decisionsEmbedAsk({
    body: { key: key.secret, scopeId: scope.scope.id, question: "what is the total arr by plan", noModel: true },
  });
  assert.equal(answered.ok, true);
  assert.equal(answered.result.value, "$210,000", "Northwind and Fabrikam only");
  assert.ok(!JSON.stringify(answered).includes("Contoso"));

  const listed = await R.decisionsEmbedOverview({});
  assert.equal(listed.keys.length, 1);
  assert.equal(listed.keys[0].uses, 1);
  assert.equal(listed.keys[0].scopeMissing, false);

  assert.equal((await R.decisionsEmbedScopeDelete({ body: { id: scope.scope.id } })).ok, false, "still in use");
  assert.equal((await R.decisionsEmbedScopeDelete({ body: { id: scope.scope.id, revokeKeys: true } })).ok, true);

  const dead = await R.decisionsEmbedAsk({
    body: { key: key.secret, scopeId: scope.scope.id, question: "what is the total arr by plan", noModel: true },
  });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /revoked/);
});

/* ══ THE PAGE AND THE WIDGET ═══════════════════════════════════════════════
 *
 * tests/unit/v2-ui.test.mjs makes these checks across the whole v2 surface, but
 * it resolves route names against `decisionRoutes` - which does not carry this
 * module's routes until they are merged in. These run the same checks against
 * the table this module exports, so the page is proved correct from the moment
 * it is written rather than from the moment it is wired.
 */

const { pkg } = await import("../../src/util/paths.mjs");
const PAGE = pkg("src", "ui", "public", "v2", "pages", "embed.js");
const WIDGET = pkg("src", "ui", "public", "v2", "embed-widget.html");
const pageSource = fs.readFileSync(PAGE, "utf8");
const widgetSource = fs.readFileSync(WIDGET, "utf8");

test("every route the embed page calls is one this module actually defines", () => {
  const called = [...pageSource.matchAll(/\bapi\(\s*["']([A-Za-z][A-Za-z0-9]*)["']/g)].map((m) => m[1]);
  assert.ok(called.length >= 8, `expected the page to name its routes as literals, saw ${called.length}`);
  for (const name of new Set(called)) {
    assert.ok(Object.hasOwn(R, name), `the page calls /x/${name}, which src/decisions/embed.mjs does not define`);
  }
});

test("the embed page never assigns innerHTML and never chains off append()", () => {
  // append() returns undefined; `x.append(el("tr")).lastChild` has broken a page
  // in this repo before. And every string on this screen is a scope name, a
  // customer name or a server error - textContent, always.
  for (const [name, src] of [["embed.js", pageSource], ["embed-widget.html", widgetSource]]) {
    for (const bad of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"]) {
      const code = src.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
      assert.ok(!code.includes(bad), `${bad} must never appear in ${name}`);
    }
  }
  for (const [i, line] of pageSource.split("\n").entries()) {
    const t = line.trimStart();
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
    let at = line.indexOf(".append(");
    while (at !== -1) {
      let depth = 0;
      let end = -1;
      for (let k = at + ".append".length; k < line.length; k++) {
        if (line[k] === "(") depth++;
        else if (line[k] === ")") {
          depth--;
          if (depth === 0) { end = k; break; }
        }
      }
      if (end !== -1 && line.slice(end + 1).trimStart().startsWith(".")) {
        assert.fail(`embed.js:${i + 1} chains off append(), which returns undefined: ${line.trim().slice(0, 80)}`);
      }
      at = line.indexOf(".append(", at + 1);
    }
  }
});

test("the page and the widget load nothing from the internet, and the widget has no inline script", () => {
  for (const [name, src] of [["embed.js", pageSource], ["embed-widget.html", widgetSource]]) {
    for (const m of src.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      const before = src.slice(Math.max(0, m.index - 80), m.index);
      assert.ok(!/(src|href)\s*=|import\s|fetch\(|url\(/i.test(before), `${name} reaches the network: ${m[0]}`);
    }
  }
  // script-src is 'self', so an inline <script> in the widget would be blocked
  // by the browser and the page would render as an empty box.
  //
  // ⚠️ Comments are stripped FIRST. The widget's own header explains this very
  // rule in prose, and the first version of this test failed on that sentence -
  // the same trap decisions-routes.test.mjs records for the Decisions page.
  const markup = widgetSource.replace(/<!--[\s\S]*?-->/g, "");
  const inline = markup.match(/<script(?![^>]*\bsrc=)[^>]*>/i);
  assert.equal(inline, null, "the widget must load its behaviour from a file, never inline");
  assert.match(widgetSource, /data-vireo-embed-widget="1"/, "the widget half of embed.js boots off this attribute");
  assert.match(widgetSource, /<script type="module" src="\.\/pages\/embed\.js">/);
});

test("the page exports the contract the shell calls", () => {
  assert.match(pageSource, /export\s+(async\s+)?function\s+render\b|export\s+const\s+render\s*=/);
  assert.match(pageSource, /export const title = "Embed"/);
});

test("the routes refuse a missing id and an empty question in words, not in codes", async () => {
  liveWorkspace();
  E._resetRateLimits();
  assert.equal((await R.decisionsEmbedScopeUpdate({ body: {} })).error, "which data scope?");
  assert.equal((await R.decisionsEmbedScopeDelete({ body: {} })).error, "which data scope?");
  assert.equal((await R.decisionsEmbedKeyRevoke({ body: {} })).error, "which embed key?");
  assert.equal((await R.decisionsEmbedKeyDelete({ body: {} })).error, "which embed key?");

  const key = await R.decisionsEmbedKeyCreate({ body: { name: "Bare" } });
  const empty = await R.decisionsEmbedAsk({ body: { key: key.secret, question: "   ", noModel: true } });
  assert.equal(empty.ok, false);
  assert.match(empty.error, /type a question first/);

  const long = await R.decisionsEmbedAsk({ body: { key: key.secret, question: "x".repeat(5000), noModel: true } });
  assert.equal(long.ok, false);
  assert.match(long.error, /characters or fewer/);
});
