// Retrying is for a network that flickers, not for an answer you already have.
//
// 🔴 THE MEASUREMENT THAT CAUSED THIS FILE. With no model gateway listening, a
// full analysis run took 12.8s and 14.0s across two runs, and essentially all of
// it was backoff. Each reasoning attempt retried a REFUSED CONNECTION three
// times with growing waits before giving up, and the run makes several attempts
// before its failure budget stops it.
//
// ⭐ That is thirteen seconds of a blank screen on exactly the laptop where the
// gateway failed to start - which is the laptop you are standing in front of
// when it matters. Nothing is listening on that port; asking it again two
// seconds later cannot change the answer.
//
// ⚠️ The other half matters just as much. A 503, or a connection that DROPS
// mid-conversation, is a real hiccup and must still be retried. A fix that made
// everything fail fast would trade a slow demo for an unreliable product.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { request } from "../../src/util/http.mjs";

/** A port we bind and immediately release, so nothing can be listening on it. */
async function deadPort() {
  const probe = http.createServer(() => {});
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  return port;
}

test("a refused connection is not retried, and gives up in milliseconds", async () => {
  const port = await deadPort();
  const started = Date.now();
  await assert.rejects(() => request(`http://127.0.0.1:${port}/`, { timeoutMs: 5000 }));
  const took = Date.now() - started;

  // With the retries in place this was ~3,700ms. The bound is deliberately
  // loose: the claim is "it does not back off", not a benchmark of the socket.
  assert.ok(took < 750, `a refused connection must fail fast, took ${took}ms`);
});

test("a 503 is still retried, because that one is a real hiccup", async () => {
  let hits = 0;
  const srv = http.createServer((_q, s) => {
    hits++;
    s.writeHead(503);
    s.end("busy");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const res = await request(`http://127.0.0.1:${port}/`, { timeoutMs: 5000 });
  await new Promise((r) => srv.close(r));

  assert.equal(res.status, 503);
  assert.ok(hits > 1, `a 503 must still be retried, saw ${hits} attempt(s)`);
});

test("a server that answers is not slowed down by any of this", async () => {
  let hits = 0;
  const srv = http.createServer((_q, s) => {
    hits++;
    s.writeHead(200, { "content-type": "text/plain" });
    s.end("ok");
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;

  const res = await request(`http://127.0.0.1:${port}/`, { timeoutMs: 5000 });
  await new Promise((r) => srv.close(r));

  assert.equal(res.status, 200);
  assert.equal(hits, 1, "a successful request must be made exactly once");
});
