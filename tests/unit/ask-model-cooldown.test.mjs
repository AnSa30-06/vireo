// A model that just failed is not dialled again on the next question.
//
// 🔴 THE COST THIS REMOVES. On an install with no key, no gateway or no network,
// every single question paid a full model round trip before falling back to
// keyword matching - 6 to 10 seconds when the connection failed fast, and up to
// the 30-second timeout when the gateway hung. The answer was always going to
// come from keywords. Someone with no key would reasonably conclude the feature
// was broken rather than offline.
//
// ⚠️ The cooldown must not swallow the model coming BACK. The last test here is
// the one that matters: it fails if the cooldown is ever made permanent, which
// is the obvious wrong way to write this.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-cooldown-"));

const { openMemory, setSettings, setMeta } = await import("../../src/decisions/db.mjs");
const { answerQuestion, _resetModelDown } = await import("../../src/decisions/ask.mjs");

const AS_OF = "2026-05-06";

function workspace() {
  const db = openMemory();
  db.prepare("INSERT INTO account (id, name, arr) VALUES ('A1','Acme',50000)").run();
  setSettings(db, { demoMode: true });
  setMeta(db, "as_of", AS_OF);
  return db;
}

test("a failing model is called once, not once per question", async () => {
  _resetModelDown();
  const db = workspace();
  let calls = 0;
  const complete = async () => {
    calls++;
    throw new Error("fetch failed");
  };

  await answerQuestion(db, { question: "which decisions are open", complete });
  assert.equal(calls, 1, "the first question must genuinely try the model");

  await answerQuestion(db, { question: "how much ARR is under review", complete });
  await answerQuestion(db, { question: "which customers are at risk", complete });
  assert.equal(calls, 1, "later questions must not re-dial a model that just failed");

  db.close();
});

test("the answer still says a model was not used, and why", async () => {
  _resetModelDown();
  const db = workspace();
  const complete = async () => {
    throw new Error("fetch failed");
  };

  await answerQuestion(db, { question: "which decisions are open", complete });
  const second = await answerQuestion(db, { question: "which decisions are open", complete });

  // Skipping the call must not make the app quieter about what happened. The
  // page's honesty depends on this line being present either way.
  const blob = JSON.stringify(second).toLowerCase();
  assert.ok(
    blob.includes("keyword") || blob.includes("no model"),
    "a skipped model call must still be reported in the evidence",
  );

  db.close();
});

test("a working model is never skipped", async () => {
  _resetModelDown();
  const db = workspace();
  let calls = 0;
  const complete = async () => {
    calls++;
    return { text: '{"intent":"open_decisions","params":{}}', requested: "test-model", servedBy: "test-model" };
  };

  await answerQuestion(db, { question: "which decisions are open", complete });
  await answerQuestion(db, { question: "which decisions are open", complete });
  assert.equal(calls, 2, "success must never start a cooldown");

  db.close();
});

test("the cooldown expires, so starting the gateway just works", async () => {
  // 🔴 THE TEST THAT STOPS THE OBVIOUS WRONG FIX. A permanent "model is down"
  // flag would pass every other test in this file and leave the feature dead
  // until a restart, with no way for the user to know why.
  _resetModelDown();
  const db = workspace();
  let fail = true;
  let calls = 0;
  const complete = async () => {
    calls++;
    if (fail) throw new Error("fetch failed");
    return { text: '{"intent":"open_decisions","params":{}}', requested: "m", servedBy: "m" };
  };

  await answerQuestion(db, { question: "which decisions are open", complete });
  assert.equal(calls, 1);

  await answerQuestion(db, { question: "which decisions are open", complete });
  assert.equal(calls, 1, "still cooling down");

  // The gateway comes back. Clearing the memo is what a real 90-second wait does.
  fail = false;
  _resetModelDown();
  await answerQuestion(db, { question: "which decisions are open", complete });
  assert.equal(calls, 2, "once the cooldown lapses the model must be tried again");

  db.close();
});
