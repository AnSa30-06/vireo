// Ledgerline must be SELF-CONTAINED. It never reads another program's install.
//
// 🔴 WHY THIS TEST EXISTS. Ledgerline 1.2.1 shipped a feature that reused an
// OmniAgent install's model gateway, agent and Chromium, to save ~4 GB on first
// run. Anmol had it removed on 2026-09-15: *"Remove that whole thing where I
// allowed the usage of the same stack in the backend. That just messes things up
// when you download both software programs on your laptop. Keep it
// self-contained. I'm okay with re-downloading the models and whatnot."*
//
// ⚠️ The sharing was not merely redundant, it was harmful in a way that is easy
// to re-introduce by accident: both apps start a model gateway on port 20129, so
// the two installs fought whenever both were open, and Ledgerline's behaviour then
// depended on whether an unrelated program happened to be running. A feature
// whose correctness depends on another app's process state is not a feature.
//
// ⭐ The rule is a ONE-WAY door: re-downloading 45 GB is acceptable, reading
// another install is not. These tests fail loudly if anyone reverses it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

/** Every .mjs file under src/, recursively. */
function sourceFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (e.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(SRC, f).split(path.sep).join("/");

test("no source file imports the removed component-sharing module", () => {
  const offenders = sourceFiles()
    .filter((f) => fs.readFileSync(f, "utf8").includes("borrow-runtime"))
    .map(rel);
  assert.deepEqual(offenders, [], `these files still reference borrow-runtime: ${offenders.join(", ")}`);
});

test("no source file calls the removed borrow helpers", () => {
  // Named individually rather than by a loose /borrow/i match, so the word may
  // still appear in prose explaining why the feature is gone.
  const banned = [
    "borrowedModules(",
    "borrowedBrowsers(",
    "describeBorrow(",
    "detectOmniAgent(",
    "omniAgentRunning(",
    "resolveBorrow(",
    "browsersDir(",
  ];
  const offenders = [];
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, "utf8");
    for (const b of banned) if (src.includes(b)) offenders.push(`${rel(f)} -> ${b})`);
  }
  assert.deepEqual(offenders, [], `removed helpers are still called: ${offenders.join("; ")}`);
});

test("Playwright is always pointed at our OWN browsers directory", () => {
  // Three files spawn something with this variable. If any of them ever points
  // it at a path we did not choose, Ledgerline is silently running another program's
  // Chromium again.
  const setters = [];
  for (const f of sourceFiles()) {
    const src = fs.readFileSync(f, "utf8");
    if (!src.includes("PLAYWRIGHT_BROWSERS_PATH")) continue;
    for (const line of src.split("\n")) {
      if (line.includes("PLAYWRIGHT_BROWSERS_PATH")) setters.push({ file: rel(f), line: line.trim() });
    }
  }
  assert.ok(setters.length > 0, "expected at least one place to set PLAYWRIGHT_BROWSERS_PATH");
  for (const s of setters) {
    assert.ok(
      s.line.includes("PATHS.browsers") || s.line.includes("browsersPath()"),
      `${s.file} sets PLAYWRIGHT_BROWSERS_PATH to something other than our own directory: ${s.line}`
    );
  }
});

test("the gateway locator only ever looks inside our own install", async () => {
  const { locateOmniRoute } = await import("../../src/gateway/locate.mjs");
  const found = locateOmniRoute();
  // On a dev checkout the gateway may legitimately be absent; the assertion is
  // about WHERE it looked, not whether it found one.
  if (!found) return;
  assert.ok(
    !/OmniAgent/i.test(found.entry),
    `the gateway was located inside an OmniAgent install: ${found.entry}`
  );
});

test("the config carries no component-sharing settings", async () => {
  const { DEFAULTS } = await import("../../src/config.mjs");
  assert.ok(DEFAULTS && typeof DEFAULTS === "object", "config.mjs must export DEFAULTS");
  for (const key of ["borrowRuntime", "borrowedFrom", "borrowedBrowsers"]) {
    assert.ok(!(key in DEFAULTS), `DEFAULTS still has the removed key "${key}"`);
  }
});
