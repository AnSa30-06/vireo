// Every module must be importable on its own.
//
// 🔴 THREE OF THEM WERE NOT, AND THE WHOLE SUITE WAS GREEN. embed.mjs,
// metrics.mjs and stories.mjs each threw "Cannot access X before
// initialization" at import time - before a single line of their code ran - when
// they were the first module of this package to be loaded.
//
// ⭐ WHY NO TEST SAW IT. Every existing test imports db.mjs, or routes.mjs, or a
// helper that pulls one of them in first. That order initialises the far side of
// the cycle before anything reads across it, so the bug is invisible from
// inside the suite. It surfaced only when something imported synthetic.mjs by
// itself. A defect that depends on WHICH FILE YOU TOUCH FIRST cannot be found by
// a suite that always touches the same file first.
//
// THE UNDERLYING RULE, which is the thing worth keeping:
//
//   In a module cycle, a `const` read at module scope is in the temporal dead
//   zone and throws. A FUNCTION DECLARATION is hoisted and already callable.
//
// So anything reached across a cycle is either called lazily from inside a
// function body, or exported as a hoisted function. db.mjs documents both.
//
// ⚠️ THIS TEST MUST SPAWN A FRESH PROCESS PER MODULE. Importing them in a loop
// inside one process proves nothing: the first import warms the whole graph and
// every later one finds it already initialised. That is precisely the false pass
// the rest of the suite was giving.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

/** Import one module as the entry point of its own process. */
function importsCleanly(relPath) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-order-"));
  const url = new URL(`file://${path.resolve(ROOT, relPath).replace(/\\/g, "/")}`).href;
  try {
    execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)});`], {
      cwd: ROOT,
      env: { ...process.env, VIREO_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return null;
  } catch (err) {
    const out = `${err.stderr ?? ""}${err.stdout ?? ""}`;
    const line = out.split("\n").find((l) => /Error/.test(l));
    if (line) return line.trim();
    return out.slice(0, 200).trim() || "exited non-zero";
  }
}

test("every decisions module can be the first one imported", () => {
  const dir = path.join(ROOT, "src", "decisions");
  const modules = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  assert.ok(modules.length >= 20, `expected the whole package, saw ${modules.length}`);

  const broken = [];
  for (const m of modules) {
    const why = importsCleanly(path.join("src", "decisions", m));
    if (why) broken.push(`${m}: ${why}`);
  }

  assert.deepEqual(
    broken,
    [],
    "these modules throw when imported first - something is read across an import cycle at module scope:\n  " +
      broken.join("\n  "),
  );
});

test("the migration SQL is identical whichever way it is reached", () => {
  // The three feature migrations moved into hoisted functions to break the
  // cycle. The SQL itself must not have changed by a single character: an
  // installed database has already run these, and a fresh install running
  // different text would diverge permanently and silently.
  const out = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const db = await import("./src/decisions/db.mjs");
       const e = await import("./src/decisions/embed.mjs");
       const m = await import("./src/decisions/metrics.mjs");
       const s = await import("./src/decisions/stories.mjs");
       console.log(JSON.stringify({
         embed: db.MIGRATIONS.includes(e.EMBED_MIGRATION) && e.EMBED_MIGRATION === e.embedMigrationSql(),
         metrics: db.MIGRATIONS.includes(m.METRICS_MIGRATION) && m.METRICS_MIGRATION === m.metricsMigrationSql(),
         stories: db.MIGRATIONS.includes(s.STORY_MIGRATION) && s.STORY_MIGRATION === s.storyMigrationSql(),
       }));`,
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 60_000 },
  );
  const got = JSON.parse(out.trim().split("\n").pop());
  assert.deepEqual(got, { embed: true, metrics: true, stories: true });
});
