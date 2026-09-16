// A rename must not take somebody's data with it.
//
// 🔴 WHAT THIS PREVENTS. The product was called Vireo until 1.3.2 and kept its
// data in a folder named after it - every workspace, every imported customer,
// every decision, the settings and the encrypted credential store. Renaming the
// product renames the folder the code looks in. On a machine that already had
// Vireo installed, the update would therefore open a brand new empty home and
// the user's entire history would be gone from their point of view.
//
// ⭐ IT WOULD NOT LOOK LIKE A BUG. Nothing errors. No file is deleted. The app
// starts perfectly and offers to create a first workspace, exactly as it does on
// a clean machine. That is the worst shape a defect can have, and it is why this
// is tested rather than reasoned about.
//
// The rule: an existing old folder wins over a new one that does not exist yet.
// Nothing is moved or copied - a half-finished migration is worse than a folder
// with a stale name, and nobody ever looks at the folder name.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Ask a FRESH process what HOME it resolves to.
 *
 * ⚠️ It has to be a fresh process. paths.mjs computes HOME once at import time,
 * so a second call inside this process would return the first answer whatever
 * the environment says.
 */
function resolvedHome(env) {
  const out = execFileSync(
    process.execPath,
    ["--input-type=module", "-e", `const p = await import("./src/util/paths.mjs"); console.log(p.HOME);`],
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 60_000,
      // A clean environment, or the real machine's LOCALAPPDATA leaks in.
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
    },
  );
  return out.trim().split("\n").pop().trim();
}

/** A temporary stand-in for %LOCALAPPDATA% / $XDG_DATA_HOME. */
function tempLocal() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lgl-home-"));
}

const isWin = process.platform === "win32";
const NEW_NAME = isWin ? "Ledgerline" : "ledgerline";
const OLD_NAME = isWin ? "Vireo" : "vireo";

/** The environment that points baseDir() at our temporary directory. */
const localEnv = (dir) => (isWin ? { LOCALAPPDATA: dir } : { XDG_DATA_HOME: dir });

test("an install that only has the old folder keeps using it", () => {
  const local = tempLocal();
  const legacy = path.join(local, OLD_NAME);
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, "config.json"), '{"proof":"this is the user\'s data"}');

  const home = resolvedHome(localEnv(local));
  assert.equal(
    home,
    legacy,
    "a machine that already had the old product must keep reading its existing data, not open an empty new home",
  );
  // And the data is genuinely reachable at the resolved path.
  assert.ok(fs.existsSync(path.join(home, "config.json")), "the resolved home must be the one holding the data");
});

test("a clean machine gets the new folder", () => {
  const local = tempLocal();
  const home = resolvedHome(localEnv(local));
  assert.equal(home, path.join(local, NEW_NAME), "a first install must use the current name");
});

test("once the new folder exists it wins, even if the old one is still there", () => {
  // Otherwise the app would be pinned to the legacy folder for ever, and a user
  // who deliberately started fresh would keep being sent back to the old data.
  const local = tempLocal();
  fs.mkdirSync(path.join(local, OLD_NAME), { recursive: true });
  fs.mkdirSync(path.join(local, NEW_NAME), { recursive: true });

  const home = resolvedHome(localEnv(local));
  assert.equal(home, path.join(local, NEW_NAME));
});

test("the environment variable always wins, under either name", () => {
  // The suite depends on this: every test file sets the variable to its own
  // temporary directory, and a fallback that outvoted it would make them share
  // one home and interfere with each other.
  const local = tempLocal();
  fs.mkdirSync(path.join(local, OLD_NAME), { recursive: true });
  const chosen = tempLocal();

  assert.equal(resolvedHome({ ...localEnv(local), LEDGERLINE_HOME: chosen }), chosen);
  // The previous variable is still honoured, so an old shortcut or script that
  // sets it keeps pointing at the same data instead of silently opening another.
  assert.equal(resolvedHome({ ...localEnv(local), VIREO_HOME: chosen }), chosen);
});
