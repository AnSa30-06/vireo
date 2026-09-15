// Dropping files on the page.
//
// 🔴 WHY THIS ROUTE EXISTS AT ALL. `decisionsImport` takes a server-side folder
// path and `decisionsImportPick` opens a native folder dialog. A browser can
// supply neither - a dropped File deliberately reports `C:\fakepath\...` and
// carries no real path - so before `decisionsUpload` there was nowhere for
// dropped bytes to go, and drag-and-drop could not work however the page was
// written.
//
// ⚠️ THE FILENAMES IN THESE TESTS COME FROM A BROWSER AND ARE UNTRUSTED. The
// traversal test below is the one that matters most: without path.basename the
// route would happily write `../../../config.json`.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-upload-test-"));

const workspace = await import("../../src/decisions/workspace.mjs");
const { decisionRoutes } = await import("../../src/decisions/routes.mjs");

const made = workspace.create("Upload test");
assert.ok(made.ok, "the test needs a workspace");
const WS_DIR = workspace.dirFor(made.workspace.id);

const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

/** The two files the importer requires, so a drop can actually succeed. */
const GOOD_FILES = [
  { name: "accounts.csv", base64: b64("account_id,name,arr\nA1,Acme,50000\n") },
  { name: "usage_daily.csv", base64: b64("account_id,day,active_users\nA1,2026-09-01,5\n") },
];

test("a dropped CSV reaches the importer", async () => {
  const r = await decisionRoutes.decisionsUpload({ body: { files: GOOD_FILES } });
  assert.equal(r.ok, true, `upload failed: ${r.error}`);
  assert.equal(r.written.length, 2);
  assert.ok(r.written.some((w) => w.name === "accounts.csv"));
  assert.ok(r.report, "the import report must come back so the page can show what was read");
});

test("a filename cannot escape the drop folder", async () => {
  // The attack: a crafted name that walks out of the scratch directory and
  // overwrites something real. path.basename is the whole defence.
  //
  // ⚠️ THIS TEST WAS WRONG ONCE AND PASSED ANYWAY. The first version resolved
  // the escape path from WS_DIR, but the route writes from WS_DIR/dropped - one
  // level deeper - so it asserted about a path the attack never targeted and
  // stayed green with the defence removed. Both assertions below are now derived
  // from the SAME directory the route actually writes into, and the test was
  // re-checked against an undefended route to confirm it fails.
  const dropped = path.join(WS_DIR, "dropped");
  const evil = "../../../../pwned.csv";
  const target = path.resolve(dropped, evil); // where the bytes would land undefended

  fs.rmSync(target, { force: true });
  await decisionRoutes.decisionsUpload({
    body: { files: [{ name: evil, base64: b64("account_id,name\nA1,x\n") }, ...GOOD_FILES] },
  });

  assert.equal(fs.existsSync(target), false, `a traversal filename wrote outside the drop folder, to ${target}`);

  // And every file that WAS written must sit directly inside the drop folder.
  const names = fs.existsSync(dropped) ? fs.readdirSync(dropped) : [];
  assert.ok(names.includes("pwned.csv"), "the name should be stripped to a plain basename, not dropped silently");
  assert.ok(!names.some((n) => n.includes("..") || n.includes("/") || n.includes("\\")), `a written name still carries a path: ${names.join(", ")}`);
});

test("a file type that cannot be imported is refused with a reason, not ignored", async () => {
  const r = await decisionRoutes.decisionsUpload({
    body: { files: [{ name: "setup.exe", base64: b64("MZ") }] },
  });
  assert.equal(r.ok, false);
  assert.equal(r.rejected.length, 1);
  assert.match(r.rejected[0].why, /CSV|XLSX|JSON/i, "the message must say what IS accepted");
});

test("an empty file is refused rather than imported as zero rows", async () => {
  const r = await decisionRoutes.decisionsUpload({
    body: { files: [{ name: "empty.csv", base64: "" }] },
  });
  assert.equal(r.ok, false);
  assert.match(r.rejected[0].why, /empty/i);
});

test("a partial drop still reports what was refused", async () => {
  // Importing three of four files and saying nothing about the fourth is how a
  // partial import passes for a complete one.
  const r = await decisionRoutes.decisionsUpload({
    body: { files: [...GOOD_FILES, { name: "notes.docx", base64: b64("x") }] },
  });
  assert.equal(r.ok, true, "the good files must still import");
  assert.equal(r.rejected.length, 1, "the refused file must be reported alongside the success");
  assert.equal(r.rejected[0].name, "notes.docx");
});

test("a batched drop keeps every batch and imports once at the end", async () => {
  // 🔴 THE BUG THIS PINS. The route cleared its folder on every call, so a
  // second batch deleted the first. That matters because the importer needs
  // accounts.csv and usage_daily.csv together: batch them naively and the
  // import fails with "a required file is absent" while both files were sent.
  const first = await decisionRoutes.decisionsUpload({
    body: { files: [GOOD_FILES[0]], append: false, final: false },
  });
  assert.equal(first.ok, true);
  assert.equal(first.staged, 1, "a non-final batch must stage, not import");
  assert.equal(first.report, undefined, "nothing should be imported until the last batch");

  const second = await decisionRoutes.decisionsUpload({
    body: { files: [GOOD_FILES[1]], append: true, final: true },
  });
  assert.equal(second.ok, true, `the batched import failed: ${second.error}`);
  assert.ok(second.report, "the final batch must run the import");

  // Both files must still be on disk - the proof that batch one survived.
  const dropped = fs.readdirSync(path.join(WS_DIR, "dropped")).sort();
  assert.deepEqual(dropped, ["accounts.csv", "usage_daily.csv"]);
});

test("sending no files says so plainly", async () => {
  const r = await decisionRoutes.decisionsUpload({ body: { files: [] } });
  assert.equal(r.ok, false);
  assert.match(r.error, /no files/i);
});
