// The product is called Vireo. It must never introduce itself as anything else.
//
// 🔴 THIS SHIPPED. Anmol's first instruction on this fork was "change up the name
// of the app, don't show omniagent", and the rename script did almost all of it.
// Two strings survived: `vireo doctor` printed "OMNI AGENT HEALTH CHECK" as its
// banner, in src/setup/doctor.mjs and again in bin/vireo.mjs. Anyone running the
// health check on a build sent to them saw the old product's name at the top of
// the screen. It was found by running the command, not by reading the code -
// which is the lesson worth keeping.
//
// ⚠️ TWO NAMES ARE LEGITIMATE AND MUST NOT BE FLAGGED:
//   - OmniRoute is a real upstream product this app depends on and does not own.
//   - The `AnSa30-06/omni-agent` URL is the actual repository this was forked
//     from; README and the updater reference it truthfully.
// A guard that fails on those would be noise, and noise gets deleted.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-brand-"));

const { pkg } = await import("../../src/util/paths.mjs");

const ROOTS = [pkg("src"), pkg("bin")];

function jsFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      jsFiles(full, out);
    } else if (/\.(mjs|js)$/.test(e.name)) out.push(full);
  }
  return out;
}

/** A comment line is prose for developers, not something a user ever reads. */
function isComment(line) {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

test("no user-visible string calls the product OmniAgent", () => {
  const offenders = [];
  for (const root of ROOTS) {
    for (const f of jsFiles(root)) {
      const rel = path.relative(pkg(), f).split(path.sep).join("/");
      fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
        if (isComment(line)) return;
        // The repository URL is a truthful reference to where this was forked
        // from, and OmniRoute is somebody else's product.
        const cleaned = line.replace(/omni-agent/g, "").replace(/OmniRoute/g, "");
        if (/OmniAgent|Omni Agent|OMNI AGENT|OMNIAGENT/i.test(cleaned)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, [], `these lines show the old product name to a user:\n  ${offenders.join("\n  ")}`);
});

test("the health check introduces itself as Vireo", async () => {
  // Checked on the rendered output rather than by grepping for a constant, so
  // moving the banner into a variable cannot quietly defeat this.
  const { renderDoctor } = await import("../../src/setup/doctor.mjs");
  const rendered = renderDoctor({
    rows: [{ name: "Node.js", status: "ok", detail: "v24", fix: null }],
    failed: 0,
    warned: 0,
  });
  assert.match(rendered, /VIREO HEALTH CHECK/, "the health check banner must name this product");
  assert.ok(!/OMNI AGENT/i.test(rendered), "the banner must not name the product it was forked from");
});

test("no screen hard-codes how big the demo company is", () => {
  // 🔴 THIS WENT STALE AND NOBODY NOTICED. The setup screen said "48 made-up
  // customers" in a fixed string. The generator later grew, the sentence did
  // not, and the button then stated a number the product would not produce - a
  // fabricated figure, on the first screen a new user sees.
  //
  // ⭐ The rule is not "keep the number up to date". It is that a screen must
  // never carry its own copy of a number the code computes. The v2 Data screen
  // gets this right: it prints decisionsStatus.variants, which the generator
  // builds from its own size. This guard exists so the next person copies that
  // and not the string.
  //
  // ⚠️ Comments are exempt. A comment saying "~48 accounts" is a note to a
  // developer about the scale of a thing, not a claim shown to anybody.
  const offenders = [];
  for (const root of ROOTS) {
    for (const f of jsFiles(root)) {
      const lines = fs.readFileSync(f, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (isComment(line)) return;
        // A digit immediately before a word for the demo's contents, inside a
        // quoted string. "48 made-up customers", "120 demo accounts".
        if (!/["'`][^"'`]*\b\d{1,4}\s+(made-up|demo|fake|sample|pretend)?\s*(customers|accounts)\b/i.test(line)) return;
        offenders.push(`${path.relative(pkg("."), f)}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these screens state a demo size of their own instead of reading it from the generator:\n  " +
      offenders.join("\n  "),
  );
});
