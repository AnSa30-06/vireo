// A web page you visit must not be able to drive this app.
//
// 🔴 THE HOLE THIS CLOSES, measured on a running server before the fix.
//
// Every /x/ route is guarded by a token, and the assumption was that a token
// alone is not enough from another origin because a cross-origin fetch carrying
// `content-type: application/json` is preflighted, and this server answers a
// preflight with no allow-headers. True as far as it goes.
//
// But a fetch stays CORS-SIMPLE - no preflight at all - if its content type is
// text/plain, and readBody() never looked at the content type: it called
// JSON.parse on whatever arrived. So this, from any website:
//
//     fetch(url + "/x/decisionsWorkspaceDelete?t=" + token, {
//       method: "POST",
//       headers: { "content-type": "text/plain;charset=UTF-8" },
//       body: JSON.stringify({ id }),
//     })
//
// skipped the preflight and executed the route. The attacker could not read the
// reply - there is no Access-Control-Allow-Origin - but the WRITE landed, on any
// of the 80-odd routes, deletes included. A token that leaks once into a log or
// a screenshot became remote control of the workspace.
//
// ⚠️ The fix is a content-type requirement, which sounds like hygiene and is
// not: it is what forces the preflight back into existence.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.VIREO_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-csrf-"));

const { startServer, stopServer, serverPort, uiUrl } = await import("../../src/ui/server.mjs");

await startServer({});
const PORT = serverPort();
const TOKEN = new URL(uiUrl("/")).searchParams.get("t");
const BASE = `http://127.0.0.1:${PORT}`;

after(() => stopServer());

test("a CORS-simple POST from another origin is refused", async () => {
  // text/plain is the shape that needs no preflight. This is the whole attack.
  const r = await fetch(`${BASE}/x/decisionsStatus?t=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "text/plain;charset=UTF-8", origin: "https://evil.example" },
    body: JSON.stringify({}),
  });
  assert.notEqual(r.status, 200, "a text/plain body must not be accepted - that is the preflight bypass");
  const body = await r.json().catch(() => ({}));
  assert.match(String(body.error ?? ""), /application\/json/i, "the refusal should say what is required");
});

test("the other two CORS-simple content types are refused as well", async () => {
  // A browser also skips the preflight for these two. Blocking only text/plain
  // would leave the door open with a different handle.
  for (const ct of ["application/x-www-form-urlencoded", "multipart/form-data"]) {
    const r = await fetch(`${BASE}/x/decisionsStatus?t=${TOKEN}`, {
      method: "POST",
      headers: { "content-type": ct, origin: "https://evil.example" },
      body: JSON.stringify({}),
    });
    assert.notEqual(r.status, 200, `${ct} must not be accepted either`);
  }
});

test("the app's own JSON calls still work", async () => {
  // The control that matters: the fix must not have broken the real client. Both
  // api() helpers send application/json, so this is exactly what the app sends.
  const r = await fetch(`${BASE}/x/decisionsStatus?t=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-omni-token": TOKEN },
    body: JSON.stringify({}),
  });
  assert.equal(r.status, 200, "a legitimate JSON POST must still be served");
});

test("a GET with no body is unaffected", async () => {
  const r = await fetch(`${BASE}/x/decisionsStatus?t=${TOKEN}`);
  assert.equal(r.status, 200, "reads carry no body and must not need a content type");
});

test("a request with no token is still refused, whatever its content type", async () => {
  const r = await fetch(`${BASE}/x/decisionsStatus`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(r.status, 401, "the token check must still come first");
});

test("the app cannot be framed by another site", async () => {
  // Without frame-ancestors, any page could iframe the whole app. Framing plus a
  // leaked token is someone else's page driving this one.
  const r = await fetch(`${BASE}/v2/index.html?t=${TOKEN}`);
  assert.equal(r.status, 200);
  const csp = r.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors/, "static pages must carry a frame-ancestors directive");
  assert.ok(!/frame-ancestors[^;]*\*/.test(csp), "frame-ancestors must not be a wildcard");
});
