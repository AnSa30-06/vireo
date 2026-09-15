// Guards on the v2 UI.
//
// 🔴 TEN AGENTS WROTE THESE FILES IN PARALLEL. Each was handed the real route
// list and told not to invent one, but "told not to" is not a guarantee. A route
// name that does not exist returns a 404, which the page renders as an empty
// section - that reads as "there is nothing to show" rather than as a bug, which
// is why tests/unit/decisions-routes.test.mjs already makes this check for the
// older page. Same check, second surface.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-v2-test-"));

const { pkg } = await import("../../src/util/paths.mjs");
const { decisionRoutes } = await import("../../src/decisions/routes.mjs");
const { routes } = await import("../../src/ui/api.mjs");

const V2 = pkg("src", "ui", "public", "v2");

function filesUnder(dir, ext, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) filesUnder(full, ext, out);
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

const rel = (f) => path.relative(V2, f).split(path.sep).join("/");

test("every route the v2 UI calls exists on the server", () => {
  const files = filesUnder(V2, ".js");
  if (!files.length) return; // v2 is not present in this checkout
  const missing = [];
  for (const f of files) {
    const js = fs.readFileSync(f, "utf8");
    // Matches api("x") and ctx.api("x") alike.
    for (const m of js.matchAll(/\bapi\(\s*["']([A-Za-z][A-Za-z0-9]*)["']/g)) {
      const name = m[1];
      if (!Object.hasOwn(decisionRoutes, name) && !Object.hasOwn(routes, name)) {
        missing.push(`${rel(f)} calls /x/${name}`);
      }
    }
  }
  assert.deepEqual(missing, [], `the v2 UI calls routes that do not exist:\n  ${missing.join("\n  ")}`);
});

test("no temporary or conflict files are left in the v2 UI", () => {
  // A crashed or interrupted agent leaves foo.js.tmp.1234.abcd beside the real
  // file. It ships in the installer and confuses the next reader about which
  // file is live.
  if (!fs.existsSync(V2)) return;
  const strays = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tmp\.|\.orig$|\.rej$|\.bak$/.test(e.name)) strays.push(rel(full));
    }
  };
  walk(V2);
  assert.deepEqual(strays, [], `temporary files left behind: ${strays.join(", ")}`);
});

test("the v2 UI loads nothing from the internet", () => {
  // The app must start with no network. A CDN <script> or a Google Fonts <link>
  // turns a working offline install into a blank page, and this product is
  // handed to people as a file.
  const offenders = [];
  for (const f of [...filesUnder(V2, ".js"), ...filesUnder(V2, ".css"), ...filesUnder(V2, ".html")]) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/https?:\/\/[^\s"'`)]+/g)) {
      // A comment mentioning a URL is fine; a fetch, import, src or href is not.
      const line = src.slice(Math.max(0, m.index - 80), m.index);
      if (/(src|href)\s*=|import\s|fetch\(|url\(/i.test(line)) offenders.push(`${rel(f)} -> ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `the v2 UI reaches the network:\n  ${offenders.join("\n  ")}`);
});

test("the v2 UI never assigns innerHTML from a value", () => {
  // These pages render customer names and model-written text. A literal string
  // is survivable; innerHTML = someVariable is an injection path.
  const offenders = [];
  for (const f of filesUnder(V2, ".js")) {
    const src = fs.readFileSync(f, "utf8");
    src.split("\n").forEach((line, i) => {
      const m = line.match(/\.innerHTML\s*=\s*(.+)$/);
      if (!m) return;
      const rhs = m[1].trim();
      // Clearing with "" or '' is the normal, safe idiom.
      if (/^(""|''|``);?$/.test(rhs)) return;
      offenders.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 90)}`);
    });
  }
  assert.deepEqual(offenders, [], `innerHTML assigned from a value:\n  ${offenders.join("\n  ")}`);
});

test("the v2 UI does not chain off Node.append()", () => {
  // Node.append() returns undefined. `tbl.append(el("thead")).lastChild` threw
  // "Cannot read properties of undefined" and broke the whole Customers page
  // once already, in the surface this one replaces.
  //
  // ⚠️ THE OBVIOUS REGEX IS WRONG. /\.append\([^)]*\)\s*\./ stops at the FIRST
  // ")", which for `tr.append(el("td", (spec.req ?? []).join(", ")))` is the one
  // closing `(spec.req ?? [])` - so it reports a chain off `.join` that is really
  // inside the arguments. It flagged two innocent lines on its first run. Paren
  // counting is the only way to find where append() actually ends.
  const offenders = [];
  for (const f of filesUnder(V2, ".js")) {
    const src = fs.readFileSync(f, "utf8");
    const lines = src.split("\n");
    lines.forEach((line, i) => {
      // A comment quoting the bad pattern in order to warn about it is not the
      // bad pattern. customers.js does exactly that, correctly.
      const t = line.trimStart();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
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
        // end === -1 means the call spans lines, so nothing is chained on this one.
        if (end !== -1) {
          const after = line.slice(end + 1).trimStart();
          if (after.startsWith(".")) offenders.push(`${rel(f)}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
        at = line.indexOf(".append(", at + 1);
      }
    });
  }
  assert.deepEqual(offenders, [], `append() chained, which returns undefined:\n  ${offenders.join("\n  ")}`);
});

test("every v2 page module exports the contract the shell calls", () => {
  const pages = filesUnder(path.join(V2, "pages"), ".js");
  if (!pages.length) return;
  for (const f of pages) {
    const src = fs.readFileSync(f, "utf8");
    assert.match(src, /export\s+(async\s+)?function\s+render\b|export\s+const\s+render\s*=/,
      `${rel(f)} must export render(root, ctx) - the shell calls it by name`);
  }
});
