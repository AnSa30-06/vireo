// The interface that ships must be the interface you can reach.
//
// 🔴 THIS SHIPPED, AND A USER FOUND IT, NOT A TEST. Vireo 1.3.0 contained the
// whole rebuilt Decisions interface under src/ui/public/v2/ - ten screens, 455
// passing tests, verified in a browser. Nothing linked to it. The Decisions
// button in the chat app sent people to "/decisions/", the interface it
// replaced, and `vireo decisions` opened the same old screens. Anmol installed
// it on a friend's laptop and saw the old UI.
//
// ⭐ EVERY EXISTING TEST PASSED. tests/unit/v2-ui.test.mjs checked that the v2
// pages call real routes. It never asked whether anything opens v2. A feature
// can be complete, correct, tested and shipped, and still not exist for the
// person who installed it, because no route reaches it. The check that was
// missing is this one.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-reach-"));

const { pkg } = await import("../../src/util/paths.mjs");

const read = (...p) => fs.readFileSync(pkg(...p), "utf8");

test("the chat app's Decisions button opens the interface that ships", () => {
  const js = read("src", "ui", "public", "app.js");
  const nav = js.match(/pages\.decisions\s*=\s*async[\s\S]{0,320}?\};/);
  assert.ok(nav, "app.js must still define pages.decisions");
  const body = nav[0];
  assert.match(body, /location\.href\s*=\s*"\/v2\//, "the Decisions button must open /v2/");
  assert.ok(
    !/location\.href\s*=\s*"\/decisions\//.test(body),
    "the Decisions button must not open the replaced interface",
  );
});

test("`vireo decisions` opens the interface that ships", () => {
  const js = read("src", "ui", "launch.mjs");
  const line = js.split("\n").find((l) => l.includes('opts.page === "decisions"'));
  assert.ok(line, "launch.mjs must still route the decisions page");
  assert.match(line, /"\/v2\/"/, "`vireo decisions` must open /v2/");
});

test("everything the v2 shell lists has a page file behind it", () => {
  // A nav row with no module is a dead link that renders "not built yet".
  const shell = read("src", "ui", "public", "v2", "shell.js");
  const nav = shell.match(/const NAV = \[[\s\S]*?\n\];/);
  assert.ok(nav, "shell.js must define NAV");
  const ids = [...nav[0].matchAll(/id:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, `expected the whole sidebar, saw ${ids.length}`);

  const missing = ids.filter((id) => !fs.existsSync(pkg("src", "ui", "public", "v2", "pages", `${id}.js`)));
  assert.deepEqual(missing, [], `these sidebar rows have no page module: ${missing.join(", ")}`);
});

test("the manual is reachable inside the new interface", () => {
  // The manual was written once and wired only into the older page. Moving the
  // app to v2 without this would have dropped it silently, leaving no way to
  // learn what any screen does from inside the product.
  const shell = read("src", "ui", "public", "v2", "shell.js");
  assert.match(shell, /id:\s*"help"/, "the sidebar must carry a help row");

  const help = read("src", "ui", "public", "v2", "pages", "help.js");
  assert.match(help, /import \{ MANUAL \}/, "the help page must use the real manual, not a second copy of the words");
  assert.match(help, /export\s+(async\s+)?function\s+render\b/, "the help page must export render(root, ctx)");
});

test("the v2 entry point is actually served", () => {
  // The server maps a directory URL to its index.html, so "/v2/" only works
  // because this file exists. Renaming it would break the link with no error.
  assert.ok(fs.existsSync(pkg("src", "ui", "public", "v2", "index.html")), "v2/index.html must exist");
  assert.ok(fs.existsSync(pkg("src", "ui", "public", "v2", "shell.js")), "v2/shell.js must exist");
});

test("the v2 interface is inside the files the installer ships", () => {
  // src/ is in APP_INCLUDE, so v2 travels with it. If that list is ever narrowed
  // to specific subfolders, this fails rather than shipping an app whose new
  // interface is missing from the download.
  const build = read("scripts", "build-installer.mjs");
  const list = build.match(/const APP_INCLUDE = \[[\s\S]*?\];/);
  assert.ok(list, "build-installer.mjs must define APP_INCLUDE");
  assert.ok(
    /"src"/.test(list[0]) || /v2/.test(list[0]),
    "the installer must ship src/, which is what carries the v2 interface",
  );
});
