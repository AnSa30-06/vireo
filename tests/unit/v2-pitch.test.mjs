// Guards on the "Why this exists" screen — src/ui/public/v2/pages/why.js.
//
// 🔴 WHY THIS FILE IS STRICTER THAN A NORMAL PAGE TEST. This screen is shown to an
// investor, and two different kinds of lie are possible on it:
//
//   1. A STATISTIC THAT IS NOT IN THE SOURCE. Every percentage on the page is quoted
//      from docs/pitch/why-not-chatgpt.md, whose own warning says the decimal places are
//      second-hand. A figure that drifts by one digit, or a new one somebody added from
//      memory, is a number an investor can check and find wrong. So the test reads the
//      pitch file and requires every figure the page draws to appear in it verbatim.
//   2. A ZERO DRESSED UP AS A RESULT. "0 open decisions", "we have not looked yet" and
//      "we looked but could not read the answer" render identically unless the page is
//      made to tell them apart. Section 4 pins the first pair; section 5b pins the third
//      state, which is the one the page actually got wrong in the field.
//
// ⚠️ ASSERT ON THE PART, NOT ON THE BLOB. A tile's textContent is its label, value and
// note run together with no separator — "Last analysis2026-09-170 customers checked". A
// \b in a regex over that string matches nothing, and a test written that way passed
// against code that was deliberately broken during this file's own mutation run. Every
// assertion about a tile goes through tileParts/partsIn/partsOf.
//
// The page is rendered for real against a linkedom DOM — the same library the search
// tools already use — rather than grepped, because the claim being tested is what a
// reader SEES, and a string that exists in the source can still never reach the screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const PAGE = path.join(ROOT, "src", "ui", "public", "v2", "pages", "why.js");
const PITCH = path.join(ROOT, "docs", "pitch", "why-not-chatgpt.md");

// linkedom gives a document with createElement, replaceChildren, style and click. The
// page module reads `document` at call time, so setting it before the import is enough.
const { document } = parseHTML("<html><body></body></html>");
globalThis.document = document;

// Dynamic, and after globalThis.document is set: a static import is hoisted above it.
const why = await import("../../src/ui/public/v2/pages/why.js");

const PITCH_TEXT = fs.readFileSync(PITCH, "utf8");
// The pitch file is markdown: a quotation is wrapped across lines behind "> ". Comparing
// a sentence against the raw file would fail on the line break rather than on the words.
const PITCH_FLAT = PITCH_TEXT.replace(/^\s*>\s?/gm, " ").replace(/\s+/g, " ");
const PAGE_SRC = fs.readFileSync(PAGE, "utf8");

/* ── a fake ctx ─────────────────────────────────────────────────────────── */

const FMT = {
  money: (a, c = "USD") => (a == null || !Number.isFinite(a) ? "—" : "$" + Math.round(a).toLocaleString("en-US")),
  date: (iso) => String(iso ?? "").slice(0, 10),
  days: (n) => `${n} days`,
  pct: (n) => `${n}%`,
};

/** A workspace with data, one finished run and open decisions. */
function loadedReplies() {
  return {
    decisionsStatus: {
      ok: true,
      workspace: { id: "w1", name: "Northwind", accounts: 48 },
      asOf: "2026-09-17",
      demoMode: false,
      hasData: true,
      lastRun: { id: "r1", at: "2026-09-17T09:12:00.000Z", status: "done", accounts: 48, candidates: 9, created: 7 },
      running: null,
    },
    decisionsOverview: {
      ok: true,
      asOf: "2026-09-17",
      tiles: { attention: 5, overdue: 2, waiting: 3, snoozed: 1, arrUnderReview: 412500, arrUnderReviewLabel: "$412,500" },
      counts: { open: 11, all: 19, dismissed: 2 },
      sections: {},
    },
  };
}

function makeCtx(replies, { throws = false } = {}) {
  const calls = [];
  const gone = [];
  return {
    calls,
    gone,
    api(name) {
      calls.push(name);
      if (throws) return Promise.reject(new Error("fetch failed: ECONNREFUSED"));
      return Promise.resolve(replies[name] ?? { ok: false, error: `no such route: ${name}` });
    },
    go: (route) => gone.push(route),
    fmt: FMT,
    state: {},
    refresh: () => {},
  };
}

const rootNode = () => document.createElement("div");
const textOf = (node) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
// The page appends its own <style>, whose textContent would otherwise be counted as page
// copy — and a CSS rule containing "85.91" would then satisfy an assertion about a chart.
const pageText = (root) => textOf(root.querySelector(".wy-wrap"));

/* ── 1. no invented statistics ──────────────────────────────────────────── */

test("every benchmark figure the page draws is quoted verbatim from the pitch document", () => {
  const drawn = why.BENCHMARKS.flatMap((b) => b.rows.map((r) => r.pct));
  assert.ok(drawn.length >= 5, "the page must still draw the benchmark rows");
  const missing = drawn.filter((p) => !PITCH_TEXT.includes(String(p)));
  assert.deepEqual(missing, [], `figures not found in docs/pitch/why-not-chatgpt.md: ${missing.join(", ")}`);
});

test("every figure stated in prose beside a chart is in the pitch document too", () => {
  // A number in a sentence is as checkable as a number on a bar, and easier to get
  // wrong, because nothing forces it through the BENCHMARKS rows.
  const prose = why.BENCHMARKS.map((b) => `${b.lead ?? ""} ${b.note ?? ""}`).join(" ");
  const stated = [...prose.matchAll(/\d+(?:\.\d+)?%/g)].map((m) => m[0]);
  assert.ok(stated.length, "the panels state at least one figure in prose");
  const missing = stated.filter((s) => !PITCH_TEXT.includes(s));
  assert.deepEqual(missing, [], `prose figures not found in the pitch file: ${missing.join(", ")}`);
});

test("a quoted conclusion is the paper's own words, character for character", () => {
  for (const b of why.BENCHMARKS.filter((x) => x.quote)) {
    assert.ok(
      PITCH_FLAT.includes(b.quote.replace(/\s+/g, " ")),
      `${b.id} quotes wording the pitch file does not contain: “${b.quote}”`,
    );
  }
});

test("the TableBench figures are labelled as scores, and its models are dated", () => {
  // 🔴 The pitch file records this as a correction an investor could have caught: these
  // are Direct Prompting OVERALL SCORES from Table 4, not accuracy, and a % sign on them
  // tells anyone who opens the paper that you did not read it. The models are 2024 ones
  // and saying so out loud is what stops the number being knocked down.
  const t = why.BENCHMARKS.find((b) => b.id === "tables");
  assert.ok(t, "the TableBench panel is gone");
  assert.equal(t.unit, "", "the TableBench figures must not carry a % sign");
  assert.match(t.scale, /overall score/i);
  assert.match(t.source, /Direct Prompting/);
  // `some` was not enough: dropping the year from ONE model row left the test green
  // while the screen showed an undated "GPT-4o", which is the exact thing that gets the
  // number knocked down in the room. Every model row carries its year.
  const undated = t.rows.filter((r) => /GPT/i.test(r.label) && !/\b2024\b/.test(r.label));
  assert.deepEqual(undated.map((r) => r.label), [], "every model row must be dated 2024");
});

test("the 2026 benchmark leads, because the 2024 one is the easy one to knock down", () => {
  assert.equal(why.BENCHMARKS[0].id, "sheets");
  assert.match(why.BENCHMARKS[0].source, /2026/);
});

test("every benchmark panel names a source that exists in the pitch document", () => {
  const missing = [];
  for (const b of why.BENCHMARKS) {
    const id = /arXiv:[\d.]+/.exec(b.source ?? "");
    if (!id) missing.push(`${b.id} has no arXiv id in its source line`);
    else if (!PITCH_TEXT.includes(id[0])) missing.push(`${b.id} cites ${id[0]}, which the pitch file does not`);
  }
  assert.deepEqual(missing, [], missing.join("; "));
});

test("the figures the pitch is built on reach the screen", async () => {
  const root = rootNode();
  await why.render(root, makeCtx(loadedReplies()));
  const t = pageText(root);
  for (const n of ["89.1%", "19.6%", "33.3%", "82.4%", "85.91", "42.73"]) {
    assert.ok(t.includes(n), `the rendered page does not show ${n}`);
  }
  // The correction, pinned: a % sign on the TableBench score is the mistake the pitch
  // file was rewritten to remove.
  assert.ok(!t.includes("85.91%"), "the TableBench score was printed as a percentage");
  assert.ok(!t.includes("42.73%"), "the TableBench score was printed as a percentage");
});

test("each bar's width is set from its own percentage", async () => {
  const root = rootNode();
  await why.render(root, makeCtx(loadedReplies()));
  const bars = [...root.querySelectorAll(".wy-track .sev-bar")];
  // The width is always a percentage of the track; only the PRINTED unit differs.
  const expected = why.BENCHMARKS.flatMap((b) => b.rows.map((r) => `${r.pct}%`));
  assert.equal(bars.length, expected.length, "one bar per benchmark row");
  assert.deepEqual(bars.map((b) => b.style.width), expected);
});

/* ── 2. the five questions, in order ────────────────────────────────────── */

test("the page answers its five questions in order", async () => {
  const root = rootNode();
  await why.render(root, makeCtx(loadedReplies()));
  const heads = [...root.querySelectorAll("h1, h2")].map((h) => textOf(h));
  // 1 what it does, 2 the problem, 3 why not ChatGPT, 4 what we do, 5 the limits.
  const order = [
    /which of your customers need you/i,
    /already in your data/i,
    /ChatGPT/i,
    /never let a model near the arithmetic/i,
    /what it will not do/i,
  ];
  let at = -1;
  for (const re of order) {
    const found = heads.findIndex((h, i) => i > at && re.test(h));
    assert.ok(found > at, `heading matching ${re} is missing or out of order in: ${heads.join(" | ")}`);
    at = found;
  }
});

test("all four honest limits are on the page", async () => {
  const root = rootNode();
  await why.render(root, makeCtx(loadedReplies()));
  const items = [...root.querySelectorAll(".wy-limit-list li")];
  assert.equal(items.length, 4, "the limits section must keep all four admissions");
  const t = textOf(root);
  assert.ok(/not a measurement of us|not a measurement/i.test(t), "the page must admit the benchmarks are not about this product");
  assert.ok(/have not published our own benchmark/i.test(t), "the page must admit there is no published benchmark of our own");
});

/* ── 3. the live numbers are the workspace's own ────────────────────────── */

test("the live strip prints the real numbers from the two routes", async () => {
  const ctx = makeCtx(loadedReplies());
  const root = rootNode();
  await why.render(root, ctx);

  assert.deepEqual(ctx.calls.sort(), ["decisionsOverview", "decisionsStatus"]);
  const t = textOf(root.querySelector(".wy-live"));
  assert.ok(t.includes("48"), "the customer count is not shown");
  assert.ok(t.includes("11"), "the open decision count is not shown");
  assert.ok(t.includes("$412,500"), "the revenue under review is not shown");
  assert.ok(t.includes("2026-09-17"), "the last analysis date is not shown");
});

test("the page calls no route that does not already exist", () => {
  const called = [...PAGE_SRC.matchAll(/\bapi\(\s*["']([A-Za-z][A-Za-z0-9]*)["']/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(called)].sort(), ["decisionsOverview", "decisionsStatus"]);
});

/* ── 4. a zero is never dressed up as a result ──────────────────────────── */

test("an empty workspace says so and points at Data instead of printing zeros", async () => {
  const replies = loadedReplies();
  replies.decisionsStatus = { ok: true, workspace: { id: "w1", name: "Northwind", accounts: 0 }, asOf: "2026-09-17", demoMode: false, hasData: false, lastRun: null, running: null };
  replies.decisionsOverview = { ok: true, tiles: {}, counts: { open: 0 }, sections: {} };
  const ctx = makeCtx(replies);
  const root = rootNode();
  await why.render(root, ctx);

  assert.equal(root.querySelectorAll(".wy-tile").length, 0, "no tile may be drawn with nothing loaded");
  const box = root.querySelector(".wy-live .empty");
  assert.ok(box, "the live strip must show the settled empty state");
  assert.match(textOf(box), /No customer data is loaded yet/i);

  box.querySelector("button").click();
  assert.deepEqual(ctx.gone, ["data"], "the empty state must send the reader to Data");
});

test("no finished run means the open count is withheld, not printed as zero", async () => {
  const replies = loadedReplies();
  replies.decisionsStatus.lastRun = null;
  replies.decisionsOverview.counts = { open: 0, all: 0, dismissed: 0 };
  replies.decisionsOverview.tiles = { attention: 0, overdue: 0, arrUnderReview: 0, arrUnderReviewLabel: "$0" };
  const root = rootNode();
  await why.render(root, makeCtx(replies));

  // Read the VALUE on its own. A tile's textContent runs label, value and note together,
  // so a regex over the blob can be defeated by the characters either side of it.
  const open = partsIn(root, "Open decisions");
  assert.ok(!/\d/.test(open.value), `a zero was printed before any run finished: ${open.value}`);
  assert.match(open.note, /no analysis has run yet/i);

  const money = partsIn(root, "Revenue under review");
  assert.ok(!/\d/.test(money.value), `a zero revenue was dressed up as a figure: ${money.value}`);
  assert.match(money.note, /no analysis has run yet/i);
});

test("a failed run is said out loud rather than shown as an empty queue", async () => {
  const replies = loadedReplies();
  replies.decisionsStatus.lastRun = { id: "r1", at: "2026-09-17T09:12:00.000Z", status: "failed", accounts: null, error: "the model refused" };
  const root = rootNode();
  await why.render(root, makeCtx(replies));
  assert.match(textOf(root.querySelector(".wy-live")), /the last analysis failed/i);
});

test("demo data is labelled on the screen that quotes it", async () => {
  const replies = loadedReplies();
  replies.decisionsStatus.demoMode = true;
  const root = rootNode();
  await why.render(root, makeCtx(replies));
  const chip = [...root.querySelectorAll(".chip")].map((c) => textOf(c));
  assert.ok(chip.includes("Demo data"), `demo numbers were quoted with no label: ${chip.join(", ")}`);
});

/* ── 5. the argument survives a backend that is down ────────────────────── */

test("a failed read shows the real message and keeps the argument on screen", async () => {
  const root = rootNode();
  await why.render(root, makeCtx({}, { throws: true }));

  const err = root.querySelector(".wy-live .err");
  assert.ok(err, "a failed read must draw the error box");
  assert.match(textOf(err), /ECONNREFUSED/, "the server's own wording must be kept, not paraphrased");
  // The static case must still be readable — this screen is shown live.
  assert.match(pageText(root), /85\.91/);
  assert.match(pageText(root), /What it will not do/i);
});

/* ── 5b. unreadable is a THIRD state, and never borrows the look of zero ──────
 *
 * 🔴 THE DEFECT THESE PIN. Audited against a real workspace holding 39 open decisions
 * and $1,194,000 of revenue under review, the overview read failed, the page fell back
 * to an empty counts object, and the tiles printed:
 *
 *     Open decisions / None / nothing crossed the line
 *     Revenue under review / — / no revenue is flagged
 *
 * Both are positive claims, both were false, and a footnote underneath saying the counts
 * were unavailable did not undo them — the tile is what gets read in the room.
 *
 * ⚠️ The test that used to stand here asserted only that "48" and the error string
 * appeared SOMEWHERE in the live strip. Both were true while the tile lied, so it passed
 * on the broken code. Asserting a page contains something can never catch a page that
 * also contains a lie; these tests read the offending tile and assert what it does NOT
 * say.
 */

/**
 * The three parts of a tile, read separately.
 *
 * ⚠️ WHY THIS EXISTS, and it is a real trap that this file already fell into once. A
 * tile's textContent is its label, value and note run together with no space —
 * "Last analysis2026-09-170 customers checked". A regex written with \b to find a
 * fabricated "0 customers checked" NEVER MATCHES, because the character before the 0 is
 * the 7 of the date and \b needs a non-word character. The test passed against code that
 * was deliberately broken. Assert against the parts, not the blob.
 */
function tileParts(node) {
  return {
    label: textOf(node.querySelector(".wy-tile-label")),
    value: textOf(node.querySelector(".wy-tile-value")),
    note: textOf(node.querySelector(".wy-tile-note")),
  };
}

/** The parts of one tile from a liveTiles() array, found by its label. */
function partsOf(nodes, label) {
  const hit = nodes.map(tileParts).find((p) => p.label === label);
  assert.ok(hit, `no tile labelled "${label}" was drawn`);
  return hit;
}

/** The parts of one tile on a rendered page, found by its label. */
function partsIn(root, label) {
  return partsOf([...root.querySelectorAll(".wy-tile")], label);
}

/**
 * Everything a tile must never say when it could not read its own number.
 *
 * The VALUE is checked exactly rather than by substring, because the value is the big
 * figure an investor reads from across the room. "None", "0", "$0" and "—" are each a
 * positive claim; only a word can be the third state.
 */
function assertNotFabricated(parts, what) {
  assert.ok(parts, `${what}: the tile is missing`);
  const seen = `value "${parts.value}", note "${parts.note}"`;
  assert.notEqual(parts.value, "None", `${what}: an unreadable count was printed as "None" — ${seen}`);
  assert.notEqual(parts.value, "—", `${what}: an unreadable count was printed as a dash — ${seen}`);
  assert.ok(!/\d/.test(parts.value), `${what}: an unreadable count was printed as a figure — ${seen}`);
  assert.equal(parts.value, "Unknown", `${what}: the tile must say the number could not be read — ${seen}`);
  assert.ok(parts.note.length > 0, `${what}: the tile must say WHY it could not be read`);
}

test("a workspace that answers but has no overview says the counts are UNKNOWN, not zero", async () => {
  const replies = loadedReplies();
  // The measured shape: status is fine, a run finished, the overview read failed.
  replies.decisionsOverview = { ok: false, error: "the decisions table is locked" };
  const root = rootNode();
  await why.render(root, makeCtx(replies));

  const live = textOf(root.querySelector(".wy-live"));
  assert.ok(live.includes("48"), "the customer count is known and must still be shown");
  assert.match(live, /the decisions table is locked/, "the reason the counts are missing must be printed");

  assertNotFabricated(partsIn(root, "Open decisions"), "open decisions, overview read failed");
  assertNotFabricated(partsIn(root, "Revenue under review"), "revenue, overview read failed");
});

test("an overview that answers ok with no counts object is unknown, not an empty queue", async () => {
  // The second way in. ok:true passes every guard in render(), so the page used to walk
  // straight into `counts = {}` and print a settled zero.
  const replies = loadedReplies();
  replies.decisionsOverview = { ok: true, asOf: "2026-09-17", sections: {} };
  const root = rootNode();
  await why.render(root, makeCtx(replies));

  assertNotFabricated(partsIn(root, "Open decisions"), "open decisions, counts key absent");
  assertNotFabricated(partsIn(root, "Revenue under review"), "revenue, tiles key absent");
});

test("a count that is present but not a number is unknown, not zero", async () => {
  const replies = loadedReplies();
  replies.decisionsOverview.counts = { open: null, all: null, dismissed: null };
  replies.decisionsOverview.tiles = { overdue: 2, arrUnderReview: undefined, arrUnderReviewLabel: null };
  const root = rootNode();
  await why.render(root, makeCtx(replies));

  assertNotFabricated(partsIn(root, "Open decisions"), "open decisions, count is null");
  assertNotFabricated(partsIn(root, "Revenue under review"), "revenue, amount is undefined");
});

test("liveTiles called with no overview at all never prints a number it does not have", () => {
  // The unit underneath the page, so the guarantee is pinned at its source too.
  const status = {
    ok: true,
    workspace: { id: "w1", name: "Northwind", accounts: 39 },
    lastRun: { id: "r1", at: "2026-09-17T09:12:00.000Z", status: "done", accounts: 39 },
  };
  const nodes = why.liveTiles(status, null, FMT);
  assert.equal(nodes.length, 4, "the strip is four tiles");
  assert.equal(partsOf(nodes, "Customers loaded").value, "39", "a known number must still be shown");
  assertNotFabricated(partsOf(nodes, "Open decisions"), "open decisions, overview null");
  assertNotFabricated(partsOf(nodes, "Revenue under review"), "revenue, overview null");
});

test("a run that did not record how many customers it checked does not claim zero", () => {
  // run.accounts is a nullable column, and `?? 0` turned an unrecorded run into the
  // sentence "0 customers checked", which is a measurement nobody took.
  const status = {
    ok: true,
    workspace: { id: "w1", name: "Northwind", accounts: 39 },
    lastRun: { id: "r1", at: "2026-09-17T09:12:00.000Z", status: "done", accounts: null },
  };
  const last = partsOf(why.liveTiles(status, { tiles: {}, counts: { open: 3 } }, FMT), "Last analysis");
  assert.equal(last.value, "2026-09-17", "the date it did record must still be shown");
  assert.ok(!/0 customers checked/.test(last.note), `a count nobody took was printed: ${last.note}`);
  assert.match(last.note, /not recorded/i, "the tile must say the figure was not recorded");
});

test("a workspace whose reply carries no customer count says so", () => {
  const status = { ok: true, workspace: { id: "w1", name: "Northwind" }, lastRun: null };
  assertNotFabricated(partsOf(why.liveTiles(status, null, FMT), "Customers loaded"), "customers, no count in the reply");
});

test("a real zero still reads as a real zero once a run has finished", async () => {
  // The other half of the guarantee. Making "unknown" loud must not make a genuine
  // empty queue look broken — a finished run that found nothing says None, not Unknown.
  const replies = loadedReplies();
  replies.decisionsOverview.counts = { open: 0, all: 4, dismissed: 4 };
  replies.decisionsOverview.tiles = { overdue: 0, arrUnderReview: 0, arrUnderReviewLabel: "$0" };
  const root = rootNode();
  await why.render(root, makeCtx(replies));

  const open = partsIn(root, "Open decisions");
  assert.equal(open.value, "None", `a finished run that found nothing must say so: ${open.value}`);
  const money = partsIn(root, "Revenue under review");
  assert.equal(money.value, "None", `a finished run with no revenue at risk must say so: ${money.value}`);
  assert.ok(!money.value.includes("$0"), "a zero was dressed up as a figure");
});

test("the unreadable tiles are marked in the markup, not only in words", async () => {
  const replies = loadedReplies();
  replies.decisionsOverview = { ok: false, error: "the decisions table is locked" };
  const root = rootNode();
  await why.render(root, makeCtx(replies));
  const marked = [...root.querySelectorAll(".wy-tile-unknown")];
  assert.equal(marked.length, 2, "both unreadable tiles carry the class that styles them apart");
  for (const n of marked) assert.match(textOf(n), /Unknown/);
});

/* ── 6. the rules the whole surface is built on ─────────────────────────── */

test("the page never assigns innerHTML from a value", () => {
  const offenders = PAGE_SRC.split("\n")
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /\.innerHTML\s*=/.test(line) && !/^\s*(\/\/|\*)/.test(line));
  assert.deepEqual(offenders.map(([n, l]) => `${n}: ${l.trim()}`), []);
});

test("the page invents no colour of its own", () => {
  // tokens.css owns the palette and re-points every token for the light theme. A hex or
  // an rgb() written here would look right in the dark and wrong on a projector in a lit
  // room, and nothing would catch it.
  const styles = /function styles\(\)[\s\S]*$/.exec(PAGE_SRC)?.[0] ?? "";
  const hex = [...styles.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g)].map((m) => m[0]);
  assert.deepEqual(hex, [], `the page style block hard-codes colour: ${hex.join(", ")}`);
});

test("the grids take back the stacked-panel margin tokens.css adds", () => {
  // `.panel + .panel { margin-top: var(--s3) }` is correct for panels in a column and
  // wrong for panels in a grid: every cell after the first is pushed down, so the two
  // benchmark charts start on different lines. A near-identical rule shipped broken
  // across 39 pages in another project here, so the neutraliser is pinned.
  const styles = /function styles\(\)[\s\S]*$/.exec(PAGE_SRC)?.[0] ?? "";
  for (const grid of [".wy-charts", ".wy-grid"]) {
    assert.ok(
      new RegExp(`\\${grid} > \\.panel \\+ \\.panel`).test(styles) ||
        styles.includes(`${grid} > .panel + .panel`),
      `${grid} holds .panel children and must cancel the stacked-panel margin`,
    );
  }
  assert.match(styles, /margin-top:0;/, "the neutralising rule must actually set margin-top to 0");
});

test("the page renders well inside the time an investor demo allows", async () => {
  const root = rootNode();
  const t0 = performance.now();
  await why.render(root, makeCtx(loadedReplies()));
  const ms = performance.now() - t0;
  assert.ok(ms < 500, `render took ${ms.toFixed(1)}ms`);
});
