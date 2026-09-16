// A scope cannot be widened out from under a live key without being asked.
//
// 🔴 THE COMPETITOR'S OWN DOCUMENTED FOOTGUN, THROUGH A DIFFERENT DOOR.
//
// Cobi's documentation says, of their equivalent feature: "Deleting a scope does
// not automatically revoke the embed keys assigned to it. Those keys will revert
// to having no scope, potentially exposing more data than intended." Routine
// tidying-up becomes a data leak.
//
// deleteScope() here refuses while live keys point at the scope, names them, and
// makes you ask again. updateScope() did not, so the identical outcome was one
// silent save away - measured on a running workspace: a key scoped to three
// customers and one allowed question answered everything about all five
// customers after a single edit, with no warning and no second click.
//
// ⚠️ NARROWING MUST STAY FREE. A guard that refused every edit would push people
// to delete and recreate, which is the worse path. These tests pin both halves.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.LEDGERLINE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ledgerline-widen-"));

const { openMemory } = await import("../../src/decisions/db.mjs");
const E = await import("../../src/decisions/embed.mjs");

function workspace() {
  const db = openMemory();
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='embed_scope'").get()) {
    db.exec(E.EMBED_MIGRATION);
  }
  const acc = db.prepare("INSERT INTO account (id, name, arr, plan) VALUES (?, ?, ?, ?)");
  acc.run("a1", "Northwind", 120000, "Enterprise");
  acc.run("a2", "Contoso", 40000, "Growth");
  return db;
}

/** A narrow scope with one live key pointing at it. */
function narrowScopeWithKey(db) {
  const scope = E.createScope(db, {
    name: "Enterprise only",
    intents: ["open_decisions"],
    groups: [{ rules: [{ field: "plan", op: "is", value: "Enterprise" }] }],
  });
  assert.ok(scope.ok, `scope not created: ${scope.error}`);
  const key = E.createKey(db, { name: "Customer portal", scopeId: scope.scope.id });
  assert.ok(key.ok, `key not created: ${key.error}`);
  return scope.scope;
}

test("widening a scope with a live key is REFUSED and names the key", () => {
  const db = workspace();
  const scope = narrowScopeWithKey(db);

  // The exact edit that was measured leaking: drop the filter and allow
  // every question.
  const r = E.updateScope(db, scope.id, { intents: [], groups: [] });

  assert.equal(r.ok, false, "removing the filter and the intent list must not save silently");
  assert.equal(r.needsConfirmWiden, true, "the caller must be told a confirmation is what is missing");
  assert.equal(r.keys.length, 1, "the live key must be named, the way deleteScope names them");
  assert.match(r.error, /Customer portal/, "the message must say WHICH key is affected");

  // And nothing changed on disk.
  const after = E.getScope(db, scope.id);
  assert.deepEqual(after.intents, ["open_decisions"], "a refused edit must not have been applied");
  assert.equal(after.groups.length, 1, "the row filter must still be there");
  db.close();
});

test("the same widening goes through once it is confirmed", () => {
  const db = workspace();
  const scope = narrowScopeWithKey(db);

  const r = E.updateScope(db, scope.id, { intents: [], groups: [], confirmWiden: true });
  assert.equal(r.ok, true, `confirming must let it through: ${r.error}`);

  const after = E.getScope(db, scope.id);
  assert.deepEqual(after.intents, [], "the confirmed change must actually be applied");
  db.close();
});

test("NARROWING a scope needs no confirmation", () => {
  // The half that keeps the guard usable. If tightening also required a
  // confirmation, people would delete and recreate instead, which is worse.
  const db = workspace();
  const scope = E.createScope(db, { name: "Wide", intents: [], groups: [] });
  E.createKey(db, { name: "Portal", scopeId: scope.scope.id });

  const r = E.updateScope(db, scope.scope.id, {
    intents: ["open_decisions"],
    groups: [{ rules: [{ field: "plan", op: "is", value: "Enterprise" }] }],
  });
  assert.equal(r.ok, true, `tightening a scope must not be blocked: ${r.error}`);
  db.close();
});

test("renaming a scope is not a widening", () => {
  const db = workspace();
  const scope = narrowScopeWithKey(db);
  const r = E.updateScope(db, scope.id, { name: "Enterprise customers" });
  assert.equal(r.ok, true, `a rename must not need confirmation: ${r.error}`);
  db.close();
});

test("widening a scope with NO live key needs no confirmation", () => {
  // There is nobody to surprise. The guard is about published pages that are
  // already serving, not about the shape of the record.
  const db = workspace();
  const scope = E.createScope(db, {
    name: "Unused",
    intents: ["open_decisions"],
    groups: [{ rules: [{ field: "plan", op: "is", value: "Enterprise" }] }],
  });
  const r = E.updateScope(db, scope.scope.id, { intents: [], groups: [] });
  assert.equal(r.ok, true, `no live key means no confirmation: ${r.error}`);
  db.close();
});

test("a revoked key does not count as live", () => {
  const db = workspace();
  const scope = E.createScope(db, {
    name: "Retired",
    intents: ["open_decisions"],
    groups: [{ rules: [{ field: "plan", op: "is", value: "Enterprise" }] }],
  });
  const key = E.createKey(db, { name: "Old portal", scopeId: scope.scope.id });
  E.revokeKey(db, key.key.id, "finished with it");

  const r = E.updateScope(db, scope.scope.id, { intents: [], groups: [] });
  assert.equal(r.ok, true, "a revoked key serves nobody, so it must not block an edit");
  db.close();
});
