// The embeddable widget: keys, data scopes, and the one route the widget calls.
//
// WHAT THIS IS. A page outside Vireo can drop in an <iframe> that answers
// questions about the workspace. The iframe carries an EMBED KEY. The key -
// never the URL - decides what that widget is allowed to see.
//
// 🔴 THE FOOTGUN THIS FILE EXISTS TO CLOSE. The product this mechanism is
// modelled on documents its own leak: "Deleting a scope does not automatically
// revoke the embed keys assigned to it. Those keys will revert to having no
// scope, potentially exposing more data than intended." So tidying up a scope
// you no longer want silently UPGRADES every key that used it, from "this
// customer's rows" to "the whole workspace". Nothing errors. Nothing is
// logged. The widget simply starts answering with more.
//
// Three independent rules close it here, and the third is the one that holds
// when the first two are bypassed:
//
//   1. DELETING A SCOPE IN USE IS REFUSED. `deleteScope` names the keys that
//      still point at it and does nothing.
//   2. DELETING IT WITH `revokeKeys` REVOKES THOSE KEYS IN THE SAME
//      TRANSACTION. The scope and the keys die together or neither does.
//   3. 🔴 A KEY WHOSE SCOPE CANNOT BE RESOLVED IS DEAD, NOT UNSCOPED. If a
//      scope row disappears by any means at all - a hand edit, a restored
//      backup, a bug in a future version of rules 1 and 2 - `authenticate`
//      REFUSES the key. There is no code path anywhere in this file that turns
//      a missing scope into "no scope". That is the guarantee, and
//      tests/unit/decisions-embed.test.mjs deletes the row behind the API's
//      back to prove it.
//
// ⚠️ WHY `embed_key.scope_id` CARRIES NO FOREIGN KEY. `ON DELETE SET NULL` is
// the leak, written as schema. `ON DELETE RESTRICT` reads well but forces
// `deleteScope` to DELETE the key rows to get past it, which throws away the
// record that the key ever existed and that it was revoked - the audit trail
// you most want after a scope was deleted in a hurry. So the column is a plain
// TEXT reference, enforced in code, and rule 3 is what makes that safe.
// `signal.account_id` is already unconstrained in this schema for the same kind
// of reason, so this is not a new idiom.
//
// 🔴 HOW A ROW-LEVEL FILTER IS ENFORCED, and why it is not a WHERE clause bolted
// onto the answer. The obvious build filters the ROWS THE ANSWER LISTS. That
// leaks anyway: "how much ARR is under review" is one number computed over every
// decision in the table, and hiding the rows underneath it changes nothing about
// the number. So the filter is applied BEFORE anything is asked: a fresh
// in-memory database is built holding ONLY the accounts the scope allows and
// their own rows, and `answerQuestion` is run against THAT. The engine cannot
// leak a row it was never handed. See `projectWorkspace`.
//
// ⚠️ WHAT THE ORIGIN LIST IS AND IS NOT. A route in this app receives
// `{body, query, method}` - the dispatcher in src/ui/server.mjs does not pass
// request headers through - so the origin checked here is the one the WIDGET
// REPORTS about itself. That makes the list a guard against a key being pasted
// into the wrong page, NOT a security boundary against someone who has the key
// and is willing to lie. It is labelled that way on screen too. The boundary
// that does hold is the one below it: the key decides the scope, and the scope
// is enforced by building a database that only contains what the scope allows.
import crypto from "node:crypto";
import { openMemory, nowIso, getSettings, tx } from "./db.mjs";
import { id } from "./ids.mjs";
import { asOfFor } from "./run.mjs";
import { answerQuestion, CATALOGUE } from "./ask.mjs";
import * as S from "./segments.mjs";
import * as workspace from "./workspace.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/embed");

const ok = (d = {}) => ({ ok: true, ...d });
const bad = (error, extra = {}) => ({ ok: false, error, ...extra });

/* ══ THE MIGRATION ═════════════════════════════════════════════════════════
 *
 * Exported as a string and appended to MIGRATIONS by the caller. It is never
 * edited after it ships: an installed database has already run it, and changing
 * it would change only what a FRESH install gets - the two would then diverge
 * permanently and invisibly.
 *
 * `embed_key` stores a HASH and a short display PREFIX. The full key exists for
 * exactly as long as it takes to hand it back to the person who created it.
 * There is no route, and no function in this file, that can print it again.
 */
// ⚠️ THE SQL LIVES IN A HOISTED FUNCTION, and that is load-bearing.
// db.mjs imports this module to build MIGRATIONS, and this module imports
// db.mjs back - a cycle. When THIS file is the entry point, db.mjs's body runs
// first, while this file's body has not. A `const` read at that moment is in the
// temporal dead zone and throws "Cannot access ... before initialization" at
// import time. A function DECLARATION is hoisted and already callable.
// Measured both ways before choosing this. Do not inline it back into the const.
export function embedMigrationSql() {
  return `
CREATE TABLE embed_scope (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  intents_json TEXT NOT NULL,
  filter_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE embed_key (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scope_id TEXT,
  origins_json TEXT NOT NULL,
  expires_at TEXT,
  rate_per_minute INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_reason TEXT,
  last_used_at TEXT,
  last_refusal TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  refusals INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX embed_key_hash ON embed_key(key_hash);
CREATE INDEX embed_key_scope ON embed_key(scope_id);
`;
}

/** The same string, for callers that want it as a value rather than a call. */
export const EMBED_MIGRATION = embedMigrationSql();

/* ══ CAPS AND DEFAULTS ═════════════════════════════════════════════════════ */

export const DEFAULT_RATE_PER_MINUTE = 30;
export const MIN_RATE_PER_MINUTE = 1;
export const MAX_RATE_PER_MINUTE = 600;
const MAX_NAME_CHARS = 80;
const MAX_ORIGINS = 20;
const MAX_QUESTION_CHARS = 400;

/** An identifier written in THIS file. Re-checked anyway before it reaches SQL. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/* ══ THE CATALOGUE, AS A SCOPE SEES IT ═════════════════════════════════════
 *
 * A scope names the catalogue entries it allows. Each entry already declares
 * the tables it reads, so "which tables and fields this key may read" is not a
 * second list that can drift from the first - it is read off the catalogue.
 */
export function catalogueVocabulary() {
  return CATALOGUE.map((i) => ({ id: i.id, question: i.question, returns: i.counts, tables: i.tables }));
}

// 🔴 LAZY FOR THE SAME REASON AS OPEN_IN IN ask.mjs - see the long note there.
// This was `const CATALOGUE_IDS = new Set(CATALOGUE.map(...))` at module scope,
// and CATALOGUE is a `const` in ask.mjs, which db.mjs pulls into a cycle. Read
// on the way round it is still in the temporal dead zone, so importing this
// package by certain entry points threw "Cannot access 'CATALOGUE' before
// initialization" before a line of code ran.
//
// ⚠️ Every test stayed green, because each one happened to import something that
// initialised ask.mjs first. Reading it on first use puts the access inside a
// function body, where the cycle has always resolved. Do not hoist it back.
let _catalogueIds = null;
const catalogueIds = () => (_catalogueIds ??= new Set(CATALOGUE.map((i) => i.id)));
const questionFor = (intentId) => CATALOGUE.find((i) => i.id === intentId)?.question ?? intentId;

/* ══ SCOPES ════════════════════════════════════════════════════════════════ */

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

function rowToScope(row) {
  const filter = parseJson(row.filter_json, {});
  return {
    id: row.id,
    name: row.name,
    intents: parseJson(row.intents_json, []),
    groups: Array.isArray(filter?.groups) ? filter.groups : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * One scope by id, or null.
 *
 * 🔴 EVERY READ OF A SCOPE GOES THROUGH HERE, so there is exactly one place
 * that can answer "the scope is missing" - and its only possible answers are a
 * scope or null. It can never answer "no scope required".
 */
export function getScope(db, scopeId) {
  const row = db.prepare("SELECT * FROM embed_scope WHERE id = ?").get(String(scopeId ?? ""));
  return row ? rowToScope(row) : null;
}

function checkScopeName(db, name, exceptId = null) {
  const clean = String(name ?? "").trim();
  if (!clean) return bad("give the data scope a name first");
  if (clean.length > MAX_NAME_CHARS) return bad(`a data scope name must be ${MAX_NAME_CHARS} characters or fewer`);
  const clash = db.prepare("SELECT id FROM embed_scope WHERE LOWER(name) = LOWER(?) AND id <> ?").get(clean, exceptId ?? "");
  if (clash) return bad(`there is already a data scope called "${clean}"`);
  return ok({ name: clean });
}

/**
 * The intent allowlist a scope may carry.
 *
 * An empty list means EVERY catalogue question, and that is spelled out on
 * screen rather than left to be inferred: a blank list that quietly meant
 * "nothing" would make a scope look broken, and one that quietly meant
 * "everything" without saying so is how a permission gets granted by accident.
 */
function checkIntents(intents) {
  if (intents === undefined || intents === null) return ok({ intents: [] });
  if (!Array.isArray(intents)) return bad("the list of questions must be a list");
  const out = [];
  for (const raw of intents) {
    const v = String(raw ?? "");
    if (!catalogueIds().has(v)) return bad(`"${v.slice(0, 40)}" is not a question Vireo can answer`);
    if (!out.includes(v)) out.push(v);
  }
  return ok({ intents: out });
}

/**
 * The row-level filter, compiled by the SAME allowlist compiler saved segments
 * use. A scope filter is therefore never a SQL fragment, and a field or an
 * operator that is not on segments.mjs's list is refused by name.
 */
function checkFilter(groups) {
  if (groups === undefined || groups === null) return ok({ groups: [] });
  const compiled = S.compileCriteria(groups);
  if (!compiled.ok) return compiled;
  if (compiled.incomplete) {
    return bad(`${compiled.incomplete} filter rule${compiled.incomplete === 1 ? "" : "s"} still need a value`);
  }
  return ok({ groups });
}

/** How many accounts a filter lets through, and which tables the intents read. */
function scopeReach(db, scope, { asOf, currency }) {
  if (!scope.groups.length) {
    return { accounts: db.prepare("SELECT COUNT(*) n FROM account").get().n, allAccounts: true, error: null };
  }
  const compiled = S.compileCriteria(scope.groups);
  if (!compiled.ok) return { accounts: null, allAccounts: false, error: compiled.error };
  return { accounts: S.matchAccounts(db, compiled, { asOf, currency }).length, allAccounts: false, error: null };
}

const tablesFor = (intents) => {
  const list = intents.length ? intents : CATALOGUE.map((i) => i.id);
  const bag = new Set();
  for (const i of list) {
    const entry = CATALOGUE.find((c) => c.id === i);
    for (const t of String(entry?.tables ?? "").split(",")) if (t.trim()) bag.add(t.trim());
  }
  return [...bag].sort();
};

export function listScopes(db, { asOf, currency }) {
  return db
    .prepare("SELECT * FROM embed_scope ORDER BY created_at, name")
    .all()
    .map((row) => {
      const scope = rowToScope(row);
      const reach = scopeReach(db, scope, { asOf, currency });
      const keys = db.prepare("SELECT COUNT(*) n FROM embed_key WHERE scope_id = ? AND revoked_at IS NULL").get(scope.id).n;
      return {
        ...scope,
        questions: (scope.intents.length ? scope.intents : CATALOGUE.map((i) => i.id)).map(questionFor),
        allQuestions: scope.intents.length === 0,
        tables: tablesFor(scope.intents),
        accounts: reach.accounts,
        allAccounts: reach.allAccounts,
        error: reach.error,
        liveKeys: keys,
      };
    });
}

export function createScope(db, { name, intents, groups }) {
  const named = checkScopeName(db, name);
  if (!named.ok) return named;
  const chosen = checkIntents(intents);
  if (!chosen.ok) return chosen;
  const filtered = checkFilter(groups);
  if (!filtered.ok) return filtered;

  const scopeId = id("esc");
  const at = nowIso(db);
  db.prepare(
    "INSERT INTO embed_scope (id, name, intents_json, filter_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(scopeId, named.name, JSON.stringify(chosen.intents), JSON.stringify({ groups: filtered.groups }), at, at);
  return ok({ scope: getScope(db, scopeId) });
}

/**
 * Would moving from `before` to `after` let a key see anything it cannot today?
 *
 * Deliberately conservative: it answers "yes" whenever it cannot prove the new
 * shape is no wider. Row filters are compared by exact structure rather than by
 * meaning, because deciding whether one set of criteria is a subset of another
 * is not something to get subtly wrong on a security boundary - so ANY change to
 * the filter counts as widening and asks for a confirmation. Over-asking is a
 * click; under-asking is a data leak on a published page.
 *
 * @returns {string|null} what widened, or null if nothing did
 */
function isWider(before, after) {
  const wasAll = !before.intents || before.intents.length === 0;
  const isAll = !after.intents || after.intents.length === 0;
  // An empty intent list means "every question", so going to empty is the
  // widest possible move.
  if (!wasAll && isAll) return "every question becomes answerable";
  if (!wasAll && !isAll) {
    const had = new Set(before.intents);
    const added = after.intents.filter((i) => !had.has(i));
    if (added.length) return `questions added: ${added.join(", ")}`;
  }
  const beforeRows = JSON.stringify(before.groups ?? []);
  const afterRows = JSON.stringify(after.groups ?? []);
  if (beforeRows !== afterRows) {
    const hadFilter = (before.groups ?? []).length > 0;
    const hasFilter = (after.groups ?? []).length > 0;
    if (hadFilter && !hasFilter) return "the row filter is removed, so every row becomes visible";
    if (hadFilter) return "the row filter changed, which may expose rows it did not before";
  }
  return null;
}

export function updateScope(db, scopeId, { name, intents, groups, confirmWiden = false }) {
  const existing = getScope(db, scopeId);
  if (!existing) return bad("that data scope does not exist any more");

  let nextName = existing.name;
  if (name !== undefined) {
    const named = checkScopeName(db, name, existing.id);
    if (!named.ok) return named;
    nextName = named.name;
  }
  let nextIntents = existing.intents;
  if (intents !== undefined) {
    const chosen = checkIntents(intents);
    if (!chosen.ok) return chosen;
    nextIntents = chosen.intents;
  }
  let nextGroups = existing.groups;
  if (groups !== undefined) {
    const filtered = checkFilter(groups);
    if (!filtered.ok) return filtered;
    nextGroups = filtered.groups;
  }

  // 🔴 EDITING A SCOPE CAN WIDEN IT, AND THAT IS THE SAME LEAK AS DELETING IT.
  //
  // deleteScope refuses while live keys point at the scope, names them, and
  // makes you ask again with revokeKeys. This function had no such check, so the
  // identical outcome was one silent save away: a key scoped to three customers
  // and one allowed question was measured answering every question over all five
  // customers after a single updateScope({groups: [], intents: []}). No warning,
  // no second click, no mention of the key it affected.
  //
  // This is the competitor's documented footgun - "deleting a scope does not
  // revoke the keys assigned to it... potentially exposing more data than
  // intended" - arriving through a different door, which is exactly how a fixed
  // bug comes back.
  //
  // ⚠️ NARROWING IS ALWAYS ALLOWED. Refusing every edit would push people to
  // delete and recreate, which is worse. Only a WIDENING needs the second look.
  const widening = isWider(
    { intents: existing.intents, groups: existing.groups },
    { intents: nextIntents, groups: nextGroups },
  );
  if (widening && !confirmWiden) {
    const live = db
      .prepare("SELECT id, name, prefix FROM embed_key WHERE scope_id = ? AND revoked_at IS NULL ORDER BY created_at")
      .all(existing.id);
    if (live.length) {
      const names = live.map((k) => `${k.name} (${k.prefix}…)`).join(", ");
      return bad(
        `This change gives "${existing.name}" access to MORE than it has now, and ${live.length} live embed ` +
          `${live.length === 1 ? "key uses" : "keys use"} it: ${names}. ` +
          `${live.length === 1 ? "That key" : "Those keys"} would immediately start returning the extra data, ` +
          "on pages that are already published. Confirm the widening, or narrow the change instead.",
        { keys: live, needsConfirmWiden: true, widened: widening },
      );
    }
  }

  db.prepare("UPDATE embed_scope SET name = ?, intents_json = ?, filter_json = ?, updated_at = ? WHERE id = ?").run(
    nextName,
    JSON.stringify(nextIntents),
    JSON.stringify({ groups: nextGroups }),
    nowIso(db),
    existing.id,
  );
  return ok({ scope: getScope(db, existing.id) });
}

/**
 * 🔴 THE FIX FOR THE DOCUMENTED LEAK, half one.
 *
 * Deleting a scope that keys still use is REFUSED and names them. Passing
 * `revokeKeys: true` is the explicit second choice: the keys are revoked and
 * the scope is deleted inside ONE transaction, so there is no instant at which
 * a live key points at a scope that has gone.
 *
 * The keys are revoked, not deleted: the row is the only record that the key
 * existed, what it could read and when it was killed - which is exactly what
 * somebody will want to read after deleting a scope in a hurry.
 */
export function deleteScope(db, scopeId, { revokeKeys = false } = {}) {
  const existing = getScope(db, scopeId);
  if (!existing) return bad("that data scope does not exist any more");

  const live = db
    .prepare("SELECT id, name, prefix FROM embed_key WHERE scope_id = ? AND revoked_at IS NULL ORDER BY created_at")
    .all(existing.id);

  if (live.length && !revokeKeys) {
    const names = live.map((k) => `${k.name} (${k.prefix}…)`).join(", ");
    return bad(
      `${live.length} embed ${live.length === 1 ? "key still uses" : "keys still use"} "${existing.name}": ${names}. ` +
        "Deleting the scope on its own would leave them pointing at a scope that is gone, so Vireo refuses. " +
        "Revoke them along with it, or move them to another scope first.",
      { keys: live, needsRevoke: true },
    );
  }

  const at = nowIso(db);
  tx(db, () => {
    if (live.length) {
      db.prepare("UPDATE embed_key SET revoked_at = ?, revoked_reason = ? WHERE scope_id = ? AND revoked_at IS NULL").run(
        at,
        `the data scope "${existing.name}" was deleted`,
        existing.id,
      );
    }
    db.prepare("DELETE FROM embed_scope WHERE id = ?").run(existing.id);
  });
  return ok({ id: existing.id, name: existing.name, revoked: live.length });
}

/** Count a scope's reach without saving it. Nothing here writes. */
export function previewScope(db, { groups, intents }, { asOf, currency }) {
  const chosen = checkIntents(intents);
  if (!chosen.ok) return chosen;
  const filtered = checkFilter(groups);
  if (!filtered.ok) return filtered;
  const reach = scopeReach(db, { groups: filtered.groups }, { asOf, currency });
  if (reach.error) return bad(reach.error);
  return ok({
    accounts: reach.accounts,
    allAccounts: reach.allAccounts,
    total: db.prepare("SELECT COUNT(*) n FROM account").get().n,
    questions: (chosen.intents.length ? chosen.intents : CATALOGUE.map((i) => i.id)).map(questionFor),
    allQuestions: chosen.intents.length === 0,
    tables: tablesFor(chosen.intents),
  });
}

/* ══ KEYS ══════════════════════════════════════════════════════════════════ */

const hashKey = (full) => crypto.createHash("sha256").update(String(full), "utf8").digest("hex");

/**
 * A new secret. 32 random bytes, base64url, behind a fixed prefix so a leaked
 * string is recognisable as a Vireo embed key in a log or a repository scan.
 */
function mintKey() {
  const full = `vek_${crypto.randomBytes(32).toString("base64url")}`;
  return { full, prefix: full.slice(0, 12), hash: hashKey(full) };
}

/** "https://example.com/dashboard?x=1" -> "https://example.com". */
function normaliseOrigins(raw) {
  if (raw === undefined || raw === null || raw === "") return ok({ origins: [] });
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(/[\s,]+/)
        .filter(Boolean);
  if (list.length > MAX_ORIGINS) return bad(`an embed key can list at most ${MAX_ORIGINS} origins`);
  const out = [];
  for (const entry of list) {
    const text = String(entry ?? "").trim();
    if (!text) continue;
    let origin;
    try {
      origin = new URL(text).origin;
    } catch {
      return bad(`"${text.slice(0, 60)}" is not a web address Vireo can read as an origin`);
    }
    if (origin === "null") return bad(`"${text.slice(0, 60)}" has no origin Vireo can match against`);
    if (!out.includes(origin)) out.push(origin);
  }
  return ok({ origins: out });
}

/**
 * An expiry date.
 *
 * A bare day means the END of that day, so "expires 2026-10-01" is usable for
 * the whole of the 1st. Reading it as midnight would kill the key a day early,
 * which is the kind of off-by-one nobody reports as a bug - they just say the
 * widget stopped working.
 */
function normaliseExpiry(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return ok({ expiresAt: null });
  const text = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    if (!Number.isFinite(Date.parse(`${text}T00:00:00Z`))) return bad(`"${text}" is not a real date`);
    return ok({ expiresAt: `${text}T23:59:59.999Z` });
  }
  const stamp = Date.parse(text);
  if (!Number.isFinite(stamp)) return bad(`"${text.slice(0, 40)}" is not a date written YYYY-MM-DD`);
  return ok({ expiresAt: new Date(stamp).toISOString() });
}

function normaliseRate(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return ok({ rate: DEFAULT_RATE_PER_MINUTE });
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return bad("the rate limit must be a number of requests per minute");
  if (n < MIN_RATE_PER_MINUTE || n > MAX_RATE_PER_MINUTE) {
    return bad(`the rate limit must be between ${MIN_RATE_PER_MINUTE} and ${MAX_RATE_PER_MINUTE} requests a minute`);
  }
  return ok({ rate: n });
}

function rowToKey(db, row) {
  const scope = row.scope_id ? getScope(db, row.scope_id) : null;
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopeId: row.scope_id,
    scopeName: scope?.name ?? null,
    // 🔴 The tell that makes the leak visible instead of silent: a key whose
    // scope row is gone is reported as ORPHANED, and `authenticate` refuses it.
    // It is never reported, and never treated, as a key with no scope.
    scopeMissing: !!row.scope_id && !scope,
    origins: parseJson(row.origins_json, []),
    expiresAt: row.expires_at,
    ratePerMinute: row.rate_per_minute,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
    lastUsedAt: row.last_used_at,
    lastRefusal: row.last_refusal,
    uses: row.uses,
    refusals: row.refusals,
  };
}

export function listKeys(db) {
  return db
    .prepare("SELECT * FROM embed_key ORDER BY created_at DESC")
    .all()
    .map((row) => rowToKey(db, row));
}

export function getKey(db, keyId) {
  const row = db.prepare("SELECT * FROM embed_key WHERE id = ?").get(String(keyId ?? ""));
  return row ? rowToKey(db, row) : null;
}

/**
 * Create a key and hand back the full secret ONCE.
 *
 * ⚠️ `key` is in the return value of this call and nowhere else, ever. Only the
 * hash and the 12-character display prefix are written.
 */
export function createKey(db, { name, scopeId, origins, expiresAt, ratePerMinute }) {
  const clean = String(name ?? "").trim();
  if (!clean) return bad("give the embed key a name first");
  if (clean.length > MAX_NAME_CHARS) return bad(`an embed key name must be ${MAX_NAME_CHARS} characters or fewer`);

  const wantsScope = scopeId !== undefined && scopeId !== null && String(scopeId).trim() !== "";
  let scope = null;
  if (wantsScope) {
    scope = getScope(db, scopeId);
    if (!scope) return bad("that data scope does not exist any more, so no key was created for it");
  }

  const org = normaliseOrigins(origins);
  if (!org.ok) return org;
  const exp = normaliseExpiry(expiresAt);
  if (!exp.ok) return exp;
  const rate = normaliseRate(ratePerMinute);
  if (!rate.ok) return rate;

  const minted = mintKey();
  const rowId = id("emb");
  db.prepare(
    `INSERT INTO embed_key (id, name, prefix, key_hash, scope_id, origins_json, expires_at, rate_per_minute, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(rowId, clean, minted.prefix, minted.hash, scope?.id ?? null, JSON.stringify(org.origins), exp.expiresAt, rate.rate, nowIso(db));

  return ok({ key: getKey(db, rowId), secret: minted.full });
}

export function revokeKey(db, keyId, reason) {
  const existing = getKey(db, keyId);
  if (!existing) return bad("that embed key does not exist any more");
  if (existing.revokedAt) return bad("that embed key was already revoked");
  db.prepare("UPDATE embed_key SET revoked_at = ?, revoked_reason = ? WHERE id = ?").run(
    nowIso(db),
    String(reason ?? "revoked by hand").slice(0, 200),
    existing.id,
  );
  return ok({ key: getKey(db, existing.id) });
}

export function deleteKey(db, keyId) {
  const existing = getKey(db, keyId);
  if (!existing) return bad("that embed key does not exist any more");
  db.prepare("DELETE FROM embed_key WHERE id = ?").run(existing.id);
  return ok({ id: existing.id, name: existing.name });
}

/* ══ RATE LIMITING ═════════════════════════════════════════════════════════
 *
 * ⚠️ REAL WALL CLOCK, deliberately, NOT nowIso(db). Everything this product
 * STAMPS goes through nowIso so demo mode can pin the date. This is not a
 * stamp: it measures how long ago a request arrived. Pinning the demo clock
 * must not convince the limiter that sixty requests a second ago were a year
 * ago, or the limit would never apply.
 *
 * In memory, per key id, for the life of the process. A restart clears it, and
 * that is the honest trade: this is a loopback desktop app, not a public API,
 * and a counter in the database would cost a write on every refused request.
 */
const recentHits = new Map();

/** Tests need a clean slate; nothing else should call this. */
export function _resetRateLimits() {
  recentHits.clear();
}

function rateCheck(keyId, perMinute, nowMs) {
  const cutoff = nowMs - 60_000;
  const kept = (recentHits.get(keyId) ?? []).filter((t) => t > cutoff);
  if (kept.length >= perMinute) {
    recentHits.set(keyId, kept);
    const waitMs = Math.max(0, kept[0] + 60_000 - nowMs);
    return { ok: false, retryInSeconds: Math.ceil(waitMs / 1000) };
  }
  kept.push(nowMs);
  recentHits.set(keyId, kept);
  return { ok: true, used: kept.length };
}

/* ══ AUTHENTICATION ════════════════════════════════════════════════════════ */

function noteUse(db, keyId, okUse, refusal) {
  try {
    if (okUse) db.prepare("UPDATE embed_key SET uses = uses + 1, last_used_at = ? WHERE id = ?").run(nowIso(db), keyId);
    else db.prepare("UPDATE embed_key SET refusals = refusals + 1, last_refusal = ? WHERE id = ?").run(String(refusal).slice(0, 200), keyId);
  } catch (err) {
    // A counter failing must never decide whether a request is allowed.
    log.warn("could not record embed key use", { error: String(err?.message ?? err) });
  }
}

/**
 * Turn a presented key into the scope it is allowed to read, or refuse it.
 *
 * 🔴 THE REQUESTED `scopeId` IS ONLY EVER CHECKED FOR AGREEMENT. It never
 * selects anything. The key's stored `scope_id` is the only thing that decides
 * what is readable, so editing the iframe URL can make a request FAIL and can
 * never make it see more:
 *
 *   key has a scope, request names none         -> refused
 *   key has a scope, request names a different one -> refused
 *   key has NO scope, request names one         -> refused
 *   key has a scope, request names the same one -> allowed, with THAT scope
 *
 * @returns {{ok:true, key:object, scope:object|null} | {ok:false, error:string}}
 */
export function authenticate(db, { key, scopeId, origin } = {}, { now = Date.now } = {}) {
  const presented = String(key ?? "").trim();
  if (!presented) return bad("this widget was embedded without an embed key, so it has nothing to read");

  const row = db.prepare("SELECT * FROM embed_key WHERE key_hash = ?").get(hashKey(presented));
  if (!row) return bad("that embed key is not one this workspace issued");

  const limited = rateCheck(row.id, row.rate_per_minute, now());
  if (!limited.ok) {
    noteUse(db, row.id, false, "rate limit");
    return bad(
      `this embed key is limited to ${row.rate_per_minute} questions a minute and has used them. Try again in ${limited.retryInSeconds}s.`,
      { retryInSeconds: limited.retryInSeconds },
    );
  }

  if (row.revoked_at) {
    noteUse(db, row.id, false, "revoked");
    return bad(`that embed key was revoked${row.revoked_reason ? ` — ${row.revoked_reason}` : ""}`);
  }

  const at = nowIso(db);
  if (row.expires_at && at > row.expires_at) {
    noteUse(db, row.id, false, "expired");
    return bad(`that embed key expired on ${String(row.expires_at).slice(0, 10)}`);
  }

  const allowedOrigins = parseJson(row.origins_json, []);
  if (allowedOrigins.length) {
    const reported = String(origin ?? "").trim();
    if (!allowedOrigins.includes(reported)) {
      noteUse(db, row.id, false, "origin");
      return bad(
        reported
          ? `this embed key is not allowed on ${reported.slice(0, 80)}`
          : "this embed key lists allowed sites, and the page it is on did not say which site it is",
      );
    }
  }

  // 🔴 THE FAIL-CLOSED CHECK. Everything above can be got round by editing rows
  // by hand; this cannot, because there is no branch under it that continues
  // with a null scope when the key claims one.
  if (row.scope_id) {
    const scope = getScope(db, row.scope_id);
    if (!scope) {
      noteUse(db, row.id, false, "scope missing");
      return bad(
        "the data scope this embed key was issued for no longer exists, so the key reads nothing. " +
          "A key never falls back to the whole workspace. Issue a new key against a scope that exists.",
      );
    }
    const asked = String(scopeId ?? "").trim();
    if (!asked) {
      noteUse(db, row.id, false, "no scope id");
      return bad("this embed key is scoped, so the embed must name its data scope. Copy the snippet again from the Embed screen.");
    }
    if (asked !== scope.id) {
      noteUse(db, row.id, false, "wrong scope id");
      return bad("this embed asked for a data scope that is not the one its key was issued for, so nothing was read.");
    }
    return ok({ key: rowToKey(db, row), scope });
  }

  if (String(scopeId ?? "").trim()) {
    noteUse(db, row.id, false, "scope id on an unscoped key");
    return bad(
      "this embed key was issued with no data scope, and a scope cannot be attached from the embed address. " +
        "Issue a key against the scope you want instead.",
    );
  }
  return ok({ key: rowToKey(db, row), scope: null });
}

/* ══ THE SCOPED DATABASE ═══════════════════════════════════════════════════
 *
 * 🔴 THIS IS THE ENFORCEMENT. Not a WHERE clause added to an answer - a whole
 * database that only ever contained the rows the scope allows. `answerQuestion`
 * runs against it and computes its totals from it, so a total cannot be a total
 * over rows the caller may not see.
 *
 * WHAT IS COPIED, and in this order so a foreign key never points at a row that
 * has not arrived yet. Only the tables the ask catalogue reads are copied;
 * `situation`, `llm_call` and the engine's own bookkeeping are left empty.
 *
 * 🔴 `embed_key` AND `embed_scope` ARE DELIBERATELY NOT ON THIS LIST. They are
 * the one thing a widget must never be able to reach: every other key in the
 * workspace, its prefix, its scope and its expiry. They are absent by omission
 * AND by the ask catalogue having no entry that reads them, and the test
 * "the scoped copy holds the scope's rows and nothing else" checks the copy is
 * empty of them rather than trusting that both of those stay true.
 */
const PROJECTION = Object.freeze([
  // meta carries settings_json and the pinned as_of, which decide the currency
  // and the day every answer is computed against. Without it the copy would
  // answer in dollars on today's real date, silently disagreeing with the app.
  { table: "meta", by: null },
  { table: "run", by: null },
  { table: "account", by: "id" },
  { table: "contact", by: "account_id" },
  { table: "metric_daily", by: "account_id" },
  { table: "ticket", by: "account_id" },
  { table: "invoice", by: "account_id" },
  { table: "event", by: "account_id" },
  { table: "signal", by: "account_id" },
  { table: "watch", by: "account_id" },
  { table: "account_run_state", by: "account_id" },
  { table: "decision", by: "account_id" },
  { table: "decision_evidence", by: "decision_id" },
  { table: "decision_hypothesis", by: "decision_id" },
  { table: "decision_event", by: "decision_id" },
  { table: "action", by: "decision_id" },
  { table: "outcome", by: "decision_id" },
]);

/** SQLite binds a bounded number of parameters, so an id list is copied in runs. */
const CHUNK = 400;

/**
 * The real column list, read off the schema rather than written out here.
 *
 * ⚠️ Every name that reaches the SQL below is an IDENTIFIER, never a value, and
 * every one of them is re-checked against SAFE_IDENT first. The table names come
 * from the frozen PROJECTION list in this file; the column names come from the
 * database's own PRAGMA. Neither can come from a caller.
 */
function columnsOf(db, table) {
  if (!SAFE_IDENT.test(table)) throw new Error(`refusing to read the schema of "${table}"`);
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.length) throw new Error(`${table} has no columns in this database`);
  for (const c of cols) if (!SAFE_IDENT.test(c)) throw new Error(`${table}.${c} is not a column name this copier can use`);
  return cols;
}

function copyRows(source, target, table, by, ids) {
  if (by && !SAFE_IDENT.test(by)) throw new Error(`refusing to filter ${table} on "${by}"`);
  const cols = columnsOf(source, table);
  const list = cols.join(", ");
  const holes = cols.map(() => "?").join(", ");
  const insert = target.prepare(`INSERT OR REPLACE INTO ${table} (${list}) VALUES (${holes})`);

  const write = (rows) => {
    for (const row of rows) insert.run(...cols.map((c) => row[c] ?? null));
  };

  if (!by) {
    write(source.prepare(`SELECT ${list} FROM ${table}`).all());
    return;
  }
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const sql = `SELECT ${list} FROM ${table} WHERE ${by} IN (${slice.map(() => "?").join(", ")})`;
    write(source.prepare(sql).all(...slice));
  }
}

/**
 * Build the database a scoped question is answered from.
 *
 * `scope` null, or a scope with no filter rules, still gets a copy rather than
 * the real handle. ONE code path means the unfiltered case cannot be the one
 * nobody tested, and the answer for an unfiltered scope is provably produced by
 * the same machinery as the filtered one.
 *
 * @returns {{ok:true, db:DatabaseSync, accounts:number|null} | {ok:false, error:string}}
 */
export function projectWorkspace(source, scope, { asOf, currency }) {
  let accountIds = null;
  if (scope?.groups?.length) {
    const compiled = S.compileCriteria(scope.groups);
    if (!compiled.ok) return bad(`the filter saved on this data scope cannot be run: ${compiled.error}`);
    accountIds = S.matchAccounts(source, compiled, { asOf, currency }).map((a) => a.id);
  }

  const target = openMemory();
  try {
    for (const { table, by } of PROJECTION) {
      if (!SAFE_IDENT.test(table) || (by && !SAFE_IDENT.test(by))) throw new Error(`refusing to copy ${table}`);
      if (accountIds === null) {
        copyRows(source, target, table, null, []);
        continue;
      }
      if (!by) {
        copyRows(source, target, table, null, []);
        continue;
      }
      if (by === "decision_id") {
        const decisionIds = target.prepare("SELECT id FROM decision").all().map((d) => d.id);
        copyRows(source, target, table, "decision_id", decisionIds);
        continue;
      }
      copyRows(source, target, table, by, accountIds);
    }
  } catch (err) {
    try {
      target.close();
    } catch {}
    return bad(`the scoped copy of this workspace could not be built: ${String(err?.message ?? err).slice(0, 200)}`);
  }
  return ok({ db: target, accounts: accountIds === null ? null : accountIds.length });
}

/**
 * The model audit row belongs to the REAL workspace, not to a copy that is
 * about to be thrown away. Anything ask.mjs wrote is carried back.
 */
function carryBackCalls(source, target) {
  try {
    const cols = columnsOf(target, "llm_call");
    const rows = target.prepare(`SELECT ${cols.join(", ")} FROM llm_call`).all();
    if (!rows.length) return;
    const insert = source.prepare(`INSERT OR REPLACE INTO llm_call (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`);
    for (const row of rows) insert.run(...cols.map((c) => row[c] ?? null));
  } catch (err) {
    log.warn("could not carry the embed model call back", { error: String(err?.message ?? err) });
  }
}

/* ══ ANSWERING ═════════════════════════════════════════════════════════════ */

const refusal = (reason, checked, suggestions = []) => ({
  kind: "refusal",
  reason,
  checked,
  remedies: [],
  suggestions,
});

/**
 * The widget's whole job: authenticate, narrow, ask, and never widen.
 *
 * @returns {Promise<object>} the ok/bad envelope every route in this app returns.
 */
export async function askThroughKey(db, { key, scopeId, origin, question, noModel = false, complete } = {}, opts = {}) {
  const auth = authenticate(db, { key, scopeId, origin }, opts);
  if (!auth.ok) return auth;

  const text = String(question ?? "").trim();
  if (!text) return bad("type a question first");
  if (text.length > MAX_QUESTION_CHARS) return bad(`a question must be ${MAX_QUESTION_CHARS} characters or fewer`);

  const asOf = asOfFor(db);
  const currency = getSettings(db).currency ?? "USD";
  const allowed = auth.scope?.intents?.length ? auth.scope.intents : CATALOGUE.map((i) => i.id);
  const suggestions = allowed.map(questionFor);

  const projected = projectWorkspace(db, auth.scope, { asOf, currency });
  if (!projected.ok) return projected;

  let out;
  try {
    out = await answerQuestion(projected.db, { question: text, noModel, ...(complete ? { complete } : {}) });
    carryBackCalls(db, projected.db);
  } catch (err) {
    log.warn("embed question failed", { error: String(err?.message ?? err) });
    return bad(`that question could not be answered: ${String(err?.message ?? err).slice(0, 200)}`);
  } finally {
    try {
      projected.db.close();
    } catch {}
  }

  noteUse(db, auth.key.id, true, null);

  // 🔴 The intent allowlist, applied to the RESULT. The query already ran, but
  // it ran against the scoped copy, so nothing outside the row filter was ever
  // readable. What is refused here is the QUESTION, and the refusal carries
  // none of the answer - not the number, not the rows, not the evidence.
  if (auth.scope && !allowed.includes(out.intent)) {
    return ok({
      scope: { id: auth.scope.id, name: auth.scope.name, accounts: projected.accounts, questions: suggestions },
      intent: null,
      source: out.source,
      model: null,
      asOf: out.asOf,
      result: refusal(
        `This embed is allowed to answer ${allowed.length} ${allowed.length === 1 ? "question" : "questions"}, and "${questionFor(out.intent) || text}" is not one of them. Nothing was returned.`,
        [
          `the embed key "${auth.key.name}" is scoped to "${auth.scope.name}"`,
          `the question was read as "${questionFor(out.intent)}", which this scope does not allow`,
        ],
        suggestions,
      ),
    });
  }

  return ok({
    scope: auth.scope
      ? { id: auth.scope.id, name: auth.scope.name, accounts: projected.accounts, questions: suggestions }
      : { id: null, name: null, accounts: projected.accounts, questions: suggestions },
    intent: out.intent,
    source: out.source,
    model: out.model,
    asOf: out.asOf,
    result: out.result,
  });
}

/** What the widget shows before anybody types: its name and what it may ask. */
export function widgetInfo(db, { key, scopeId, origin } = {}, opts = {}) {
  const auth = authenticate(db, { key, scopeId, origin }, opts);
  if (!auth.ok) return auth;
  const allowed = auth.scope?.intents?.length ? auth.scope.intents : CATALOGUE.map((i) => i.id);
  const asOf = asOfFor(db);
  const currency = getSettings(db).currency ?? "USD";
  const reach = auth.scope ? scopeReach(db, auth.scope, { asOf, currency }) : { accounts: null, allAccounts: true, error: null };
  return ok({
    name: auth.key.name,
    scope: auth.scope ? { id: auth.scope.id, name: auth.scope.name } : null,
    accounts: reach.accounts,
    allAccounts: reach.allAccounts,
    questions: allowed.map(questionFor),
    asOf,
  });
}

/* ══ THE ROUTES ════════════════════════════════════════════════════════════
 *
 * Merged into `decisionRoutes` by the caller, so every route below inherits the
 * per-launch token, the loopback-only Host check and the `ok:false -> HTTP 400`
 * rule without restating any of it.
 *
 * ⚠️ `withDb` is repeated here rather than imported because routes.mjs does not
 * export it and this module must not edit that file. Same three lines, same
 * rule: open the selected workspace, do the work, CLOSE IT.
 */
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

async function withDbAsync(fn) {
  const sel = workspace.openSelected();
  if (!sel) return bad("no workspace yet", { needsWorkspace: true });
  try {
    return await fn(sel.db, sel.id);
  } finally {
    try {
      sel.db.close();
    } catch {}
  }
}

export const embedRoutes = {
  /** Everything the Embed screen draws: scopes, keys, the catalogue, the vocabulary. */
  async decisionsEmbedOverview() {
    return withDb((db) => {
      const asOf = asOfFor(db);
      const currency = getSettings(db).currency ?? "USD";
      return ok({
        scopes: listScopes(db, { asOf, currency }),
        keys: listKeys(db),
        catalogue: catalogueVocabulary(),
        ...S.fieldVocabulary(),
        choices: S.groundingFor(db),
        total: db.prepare("SELECT COUNT(*) n FROM account").get().n,
        defaultRatePerMinute: DEFAULT_RATE_PER_MINUTE,
        maxRatePerMinute: MAX_RATE_PER_MINUTE,
        currency,
        asOf,
      });
    });
  },

  async decisionsEmbedScopePreview({ body }) {
    return withDb((db) =>
      previewScope(db, { groups: body?.groups, intents: body?.intents }, { asOf: asOfFor(db), currency: getSettings(db).currency ?? "USD" }),
    );
  },

  async decisionsEmbedScopeCreate({ body }) {
    return withDb((db) => createScope(db, { name: body?.name, intents: body?.intents, groups: body?.groups }));
  },

  async decisionsEmbedScopeUpdate({ body }) {
    if (!body?.id) return bad("which data scope?");
    return withDb((db) => updateScope(db, body.id, { name: body.name, intents: body.intents, groups: body.groups }));
  },

  /**
   * 🔴 `revokeKeys` is the ONLY way a scope in use is ever deleted, and the
   * page sends it only after the person has read the names of the keys that
   * will die with it.
   */
  async decisionsEmbedScopeDelete({ body }) {
    if (!body?.id) return bad("which data scope?");
    return withDb((db) => deleteScope(db, body.id, { revokeKeys: body?.revokeKeys === true }));
  },

  /** The full key is in this response and in no other, ever. */
  async decisionsEmbedKeyCreate({ body }) {
    return withDb((db) =>
      createKey(db, {
        name: body?.name,
        scopeId: body?.scopeId,
        origins: body?.origins,
        expiresAt: body?.expiresAt,
        ratePerMinute: body?.ratePerMinute,
      }),
    );
  },

  async decisionsEmbedKeyRevoke({ body }) {
    if (!body?.id) return bad("which embed key?");
    return withDb((db) => revokeKey(db, body.id, body?.reason));
  },

  async decisionsEmbedKeyDelete({ body }) {
    if (!body?.id) return bad("which embed key?");
    return withDb((db) => deleteKey(db, body.id));
  },

  /** The widget's boot call. Says what may be asked and nothing else. */
  async decisionsEmbedInfo({ body, query }) {
    const args = { key: body?.key ?? query?.key, scopeId: body?.scopeId ?? query?.scopeId, origin: body?.origin ?? query?.origin };
    return withDb((db) => widgetInfo(db, args));
  },

  /** The widget's only other call. */
  async decisionsEmbedAsk({ body }) {
    return withDbAsync((db) =>
      askThroughKey(db, {
        key: body?.key,
        scopeId: body?.scopeId,
        origin: body?.origin,
        question: body?.question,
        noModel: body?.noModel === true,
      }),
    );
  },
};

export default embedRoutes;
