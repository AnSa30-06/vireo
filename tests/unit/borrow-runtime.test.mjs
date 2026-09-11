// Reusing an OmniAgent install's components.
//
// The rule under test is the one that matters: borrow the files, but NEVER
// start borrowing while OmniAgent is running, because both apps launch a model
// gateway on the same port.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-borrow-"));
process.env.VIREO_HOME = HOME;

const borrow = await import("../../src/setup/borrow-runtime.mjs");
const { loadConfig, updateConfig } = await import("../../src/config.mjs");

/** Build a fake OmniAgent install and point the detector at it. */
function fakeInstall({ gateway = true, agent = true, browser = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fake-oa-"));
  const appRoot = path.join(root, "Programs", "OmniAgent", "app");
  const dataDir = path.join(root, "OmniAgent");
  const modules = path.join(appRoot, "runtime", "node_modules");

  if (gateway) {
    fs.mkdirSync(path.join(modules, "omniroute", "bin"), { recursive: true });
    fs.writeFileSync(path.join(modules, "omniroute", "bin", "omniroute.mjs"), "// fake");
  }
  if (agent) {
    fs.mkdirSync(path.join(modules, "opencode-ai", "bin"), { recursive: true });
    const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
    fs.writeFileSync(path.join(modules, "opencode-ai", "bin", exe), "");
  }
  if (browser) {
    fs.mkdirSync(path.join(dataDir, "browsers", "chromium-1200"), { recursive: true });
  }
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "package.json"), JSON.stringify({ version: "1.2.0" }));
  fs.mkdirSync(dataDir, { recursive: true });

  // The detector reads these two environment variables to find the install.
  process.env.LOCALAPPDATA = root;
  return { root, appRoot, dataDir, modules };
}

function cleanup(inst) {
  try {
    fs.rmSync(inst.root, { recursive: true, force: true });
  } catch {}
  updateConfig({ borrowedFrom: null, borrowedBrowsers: null, borrowRuntime: "auto" });
}

test("an OmniAgent install is found, and what it can share is itemised", () => {
  const inst = fakeInstall();
  const d = borrow.detectOmniAgent();
  assert.equal(d.found, true);
  assert.deepEqual(d.components, { gateway: true, agent: true, browser: true });
  assert.equal(d.version, "1.2.0");
  assert.ok(d.savesMB > 3500, "it should report roughly 4 GB saved");
  cleanup(inst);
});

test("no OmniAgent install is reported honestly rather than guessed at", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "no-oa-"));
  process.env.LOCALAPPDATA = empty;
  const d = borrow.detectOmniAgent();
  assert.equal(d.found, false);
  assert.equal(d.savesMB, 0);
  fs.rmSync(empty, { recursive: true, force: true });
});

test("a half-installed OmniAgent shares only the parts it actually has", () => {
  const inst = fakeInstall({ agent: false, browser: false });
  const d = borrow.detectOmniAgent();
  assert.equal(d.components.gateway, true);
  assert.equal(d.components.agent, false);
  assert.equal(d.components.browser, false);
  cleanup(inst);
});

test("with no lock file, OmniAgent is not running", async () => {
  const inst = fakeInstall();
  const r = await borrow.omniAgentRunning();
  assert.equal(r.running, false);
  cleanup(inst);
});

test("a stale lock file pointing at a dead port does not count as running", async () => {
  const inst = fakeInstall();
  // Port 1 is not going to answer.
  fs.writeFileSync(path.join(inst.dataDir, "ui.lock"), JSON.stringify({ port: 1, pid: 999999 }));
  const r = await borrow.omniAgentRunning();
  assert.equal(r.running, false, "a lock left behind by a closed copy must not block borrowing");
  cleanup(inst);
});

test("an unreadable lock file FAILS CLOSED and counts as running", async () => {
  const inst = fakeInstall();
  fs.writeFileSync(path.join(inst.dataDir, "ui.lock"), "{ this is not json");
  const r = await borrow.omniAgentRunning();
  assert.equal(r.running, true, "when in doubt, do not borrow");
  cleanup(inst);
});

test("a live OmniAgent answering /instance counts as running, and blocks borrowing", async () => {
  const inst = fakeInstall();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ omniAgent: true, pid: 4242 }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  fs.writeFileSync(path.join(inst.dataDir, "ui.lock"), JSON.stringify({ port, pid: 4242 }));

  const running = await borrow.omniAgentRunning();
  assert.equal(running.running, true);
  assert.match(running.reason, /4242/);

  const decision = await borrow.resolveBorrow();
  assert.equal(decision.blocked, true, "borrowing must be refused while it runs");
  assert.match(decision.remedy, /Close OmniAgent/);
  assert.equal(loadConfig().borrowedFrom, null, "nothing may be recorded while it runs");

  server.close();
  cleanup(inst);
});

test("a port that answers something else is not OmniAgent", async () => {
  const inst = fakeInstall();
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ someOtherApp: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  fs.writeFileSync(path.join(inst.dataDir, "ui.lock"), JSON.stringify({ port: server.address().port }));
  const r = await borrow.omniAgentRunning();
  assert.equal(r.running, false);
  server.close();
  cleanup(inst);
});

test("when OmniAgent is closed, the decision is recorded and the paths resolve", async () => {
  const inst = fakeInstall();
  const decision = await borrow.resolveBorrow();
  assert.equal(decision.borrowing, true);
  assert.equal(loadConfig().borrowedFrom, inst.modules);
  assert.equal(borrow.borrowedModules(), inst.modules);
  assert.ok(borrow.borrowedBrowsers()?.endsWith("browsers"));
  assert.match(borrow.describeBorrow().text, /OmniAgent install/);
  cleanup(inst);
});

test("turning it off in settings stops it borrowing at all", async () => {
  const inst = fakeInstall();
  updateConfig({ borrowRuntime: "never" });
  const decision = await borrow.resolveBorrow();
  assert.equal(decision.borrowing, false);
  assert.equal(decision.disabled, true);
  cleanup(inst);
});

test("a borrowed path that has since been deleted degrades to nothing, not to a crash", async () => {
  const inst = fakeInstall();
  await borrow.resolveBorrow();
  assert.ok(borrow.borrowedModules(), "borrowing first");
  // The reader uninstalls OmniAgent.
  fs.rmSync(inst.root, { recursive: true, force: true });
  assert.equal(borrow.borrowedModules(), null, "a path that is gone must resolve to null");
  assert.equal(borrow.borrowedBrowsers(), null);
  assert.doesNotThrow(() => borrow.browsersDir());
  cleanup(inst);
});

test("the gateway locator offers the borrowed copy AFTER our own", async () => {
  const inst = fakeInstall();
  await borrow.resolveBorrow();
  const { locateOmniRoute, locateOpenCode } = await import("../../src/gateway/locate.mjs");
  const found = locateOmniRoute();
  assert.ok(found, "the borrowed gateway should be found");
  assert.ok(found.entry.startsWith(inst.modules), `expected the borrowed copy, got ${found.entry}`);
  const oc = locateOpenCode();
  assert.ok(String(oc).startsWith(inst.modules), `expected the borrowed agent, got ${oc}`);
  cleanup(inst);
});

test("the updater points at Vireo's own repository, not the one it was forked from", async () => {
  const src = fs.readFileSync(new URL("../../src/update/updater.mjs", import.meta.url), "utf8");
  assert.match(src, /const REPO = "AnSa30-06\/vireo"/, "an updater aimed at the upstream repo offers the wrong product's releases");
  assert.ok(!/AnSa30-06\/omni-agent/.test(src), "no reference to the upstream repo may remain");
});

// ── The browser check must not lie about WHY it failed ───────────────────────
//
// 🔴 THIS IS A REGRESSION TEST FOR A BUG THAT REACHED A USER'S MACHINE.
// `browsersPath()` in src/tools/browser.mjs was changed to call `browsersDir()`
// so a borrowed Chromium would be found, and the import was forgotten. Nothing
// failed loudly. `chromiumInstalled()` wrapped the call in a bare `catch {}`, so
// the ReferenceError became `false`, and setup printed:
//
//     [FAIL] Browser
//            Chromium is not installed
//            Fix: Run: vireo setup --browser
//
// on a machine two lines below which it also said it was borrowing a working
// Chromium from OmniAgent. Following that advice downloads 700 MB and fails the
// same way. The whole 249-test suite passed throughout, because nothing imported
// this module.

test("asking whether Chromium is installed does not crash", async () => {
  const browser = await import("../../src/tools/browser.mjs");
  // The ASSERTION IS THAT IT RETURNS AT ALL. A missing import inside
  // browsersPath() throws here; the answer itself depends on the machine, so
  // checking true/false would be checking the test runner's laptop, not the code.
  const answer = browser.chromiumInstalled();
  assert.equal(typeof answer, "boolean", "chromiumInstalled() must answer with a boolean");
});

test("a wrong answer about Chromium is never produced by swallowing a bug", async () => {
  const src = fs.readFileSync(new URL("../../src/tools/browser.mjs", import.meta.url), "utf8");
  // Every identifier browser.mjs calls from borrow-runtime must be imported.
  // Plain string checks rather than a built regex: the escaping is not worth the
  // risk of a test that passes because its own pattern was malformed.
  if (src.includes("browsersDir(")) {
    const importsIt = src
      .split("\n")
      .some((line) => line.startsWith("import") && line.includes("browsersDir") && line.includes("borrow-runtime.mjs"));
    assert.ok(importsIt, "browser.mjs calls browsersDir() but never imports it - this is the exact shipped bug");
  }
  assert.ok(
    !/catch\s*\{\s*return false;\s*\}/.test(src),
    "a bare `catch { return false }` around the browser check turns a crash into a believable wrong diagnosis"
  );
});
