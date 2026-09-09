// Reuse an OmniAgent install's heavy components instead of downloading them again.
//
// Vireo is a fork of OmniAgent, and the three things that make a first run take
// half an hour are identical in both:
//
//   model gateway (omniroute)   2.7 GB
//   agent harness (opencode-ai) 514 MB
//   Chromium                    701 MB
//
// Someone who already has OmniAgent installed has all of it on disk. Making them
// download it a second time to run the same code under a different name is
// nearly 4 GB and twenty minutes of nothing.
//
// 🔴 THE ONE CONDITION, AND WHY IT IS NOT ABOUT THE FILES. Reading another
// install's package directory is harmless even while it runs. The conflict is
// the GATEWAY: both apps default to port 20129, and each spawns its own gateway
// process. If OmniAgent is already running, its gateway owns that port, and
// Vireo's would either fail to bind or - worse - the two would race for it. So
// borrowing is refused whenever OmniAgent is running, and the reader is told to
// close it rather than left with a gateway that will not start.
//
// ⚠️ FAILS CLOSED. Anything unclear - an unreadable lock file, a port that
// answers something unexpected - counts as "running", because the cost of a
// wrong "not running" is a broken start and the cost of a wrong "running" is a
// download the reader was going to do anyway.
//
// The decision is made ONCE, asynchronously, at startup, and written to config.
// locate.mjs is synchronous and cannot probe a port, so it reads that answer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../util/paths.mjs";
import { loadConfig, updateConfig } from "../config.mjs";
import { logger } from "../util/log.mjs";

const log = logger("borrow");

/** Where an OmniAgent install puts its application files. */
function appRootCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  return [
    path.join(local, "Programs", "OmniAgent", "app"),
    path.join(local, "Programs", "OmniAgent"),
    path.join(programFiles, "OmniAgent", "app"),
    path.join(programFiles, "OmniAgent"),
  ];
}

/** Where an OmniAgent install puts its data (browsers, lock file, gateway db). */
function dataDirCandidates() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return [path.join(local, "OmniAgent"), path.join(os.homedir(), ".omni-agent")];
}

function hasChromium(browsersDir) {
  try {
    return fs.readdirSync(browsersDir).some((d) => /^chromium/.test(d));
  } catch {
    return false;
  }
}

/**
 * Find an OmniAgent install and say which of its components are usable.
 * Pure filesystem, no network, safe to call often.
 */
export function detectOmniAgent() {
  let appRoot = null;
  let runtimeModules = null;
  for (const root of appRootCandidates()) {
    const modules = path.join(root, "runtime", "node_modules");
    if (fs.existsSync(path.join(modules, "omniroute", "bin", "omniroute.mjs"))) {
      appRoot = root;
      runtimeModules = modules;
      break;
    }
  }

  let dataDir = null;
  let browsers = null;
  for (const dir of dataDirCandidates()) {
    const b = path.join(dir, "browsers");
    if (hasChromium(b)) {
      dataDir = dir;
      browsers = b;
      break;
    }
    if (!dataDir && fs.existsSync(dir)) dataDir = dir;
  }

  const gateway = runtimeModules && fs.existsSync(path.join(runtimeModules, "omniroute", "bin", "omniroute.mjs"));
  const opencodeExe = process.platform === "win32" ? "opencode.exe" : "opencode";
  const agent = runtimeModules && fs.existsSync(path.join(runtimeModules, "opencode-ai", "bin", opencodeExe));

  let version = null;
  if (appRoot) {
    try {
      version = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8")).version ?? null;
    } catch {}
  }

  const found = Boolean(runtimeModules || browsers);
  return {
    found,
    appRoot,
    dataDir,
    runtimeModules,
    browsers: browsers ?? null,
    components: { gateway: !!gateway, agent: !!agent, browser: !!browsers },
    version,
    /** Roughly what reusing this saves, for the sentence shown to the reader. */
    savesMB: (gateway ? 2700 : 0) + (agent ? 514 : 0) + (browsers ? 701 : 0),
  };
}

/**
 * Is OmniAgent running right now?
 *
 * Uses OmniAgent's OWN single-instance mechanism: it writes `ui.lock` with the
 * port its UI server is on, and answers `GET /instance` with `{omniAgent:true}`.
 * That is a far better signal than a process name, because it is the same check
 * OmniAgent itself uses to decide whether a second copy should hand over.
 *
 * @returns {Promise<{running: boolean, reason: string}>}
 */
export async function omniAgentRunning(detected = detectOmniAgent()) {
  if (!detected.dataDir) return { running: false, reason: "no OmniAgent data directory" };
  const lockFile = path.join(detected.dataDir, "ui.lock");
  if (!fs.existsSync(lockFile)) return { running: false, reason: "no lock file, so nothing is holding it" };

  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  } catch {
    // Unreadable lock. Fail closed: assume it is running.
    return { running: true, reason: "its lock file could not be read, so it is treated as running" };
  }
  if (!lock?.port) return { running: false, reason: "the lock file names no port" };

  try {
    const r = await fetch(`http://127.0.0.1:${lock.port}/instance`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { running: false, reason: "the lock is stale; nothing answered properly" };
    const body = await r.json();
    if (body?.omniAgent === true) {
      return { running: true, reason: `OmniAgent is open (process ${body.pid ?? lock.pid ?? "?"})` };
    }
    return { running: false, reason: "something else has that port; not OmniAgent" };
  } catch {
    // Nothing answered: the lock is left over from a copy that has since closed.
    return { running: false, reason: "the lock is stale; OmniAgent is not answering" };
  }
}

/**
 * Decide once whether to borrow, and record it.
 *
 * Called from setup and from launch. Cheap when already decided and still valid.
 *
 * @param {{force?: boolean}} [opts]
 */
export async function resolveBorrow(opts = {}) {
  const cfg = loadConfig();
  if (cfg.borrowRuntime === "never") {
    return { borrowing: false, reason: "turned off in settings", disabled: true };
  }

  const detected = detectOmniAgent();
  if (!detected.found) {
    if (cfg.borrowedFrom) updateConfig({ borrowedFrom: null, borrowedBrowsers: null });
    return { borrowing: false, reason: "no OmniAgent install found", detected };
  }

  const run = await omniAgentRunning(detected);
  if (run.running) {
    // Do NOT clear a borrow that is already in place: the files are still there
    // and still readable. Only refuse to START borrowing while it runs, and say
    // why, because the gateway port is the thing that will actually collide.
    return {
      borrowing: Boolean(cfg.borrowedFrom),
      blocked: true,
      reason: run.reason,
      remedy: "Close OmniAgent and start Vireo again to share its components instead of downloading them.",
      detected,
    };
  }

  const patch = {
    borrowedFrom: detected.runtimeModules ?? null,
    borrowedBrowsers: detected.browsers ?? null,
  };
  if (cfg.borrowedFrom !== patch.borrowedFrom || cfg.borrowedBrowsers !== patch.borrowedBrowsers) {
    updateConfig(patch);
    log.info("borrowing components from an OmniAgent install", { from: patch.borrowedFrom, savesMB: detected.savesMB });
  }
  return { borrowing: true, reason: run.reason, detected, ...patch };
}

/**
 * The borrowed package directory, or null. SYNCHRONOUS, for locate.mjs.
 * Re-checks that the path still exists, so uninstalling OmniAgent degrades to a
 * normal download rather than to a broken start.
 */
export function borrowedModules() {
  const dir = loadConfig().borrowedFrom;
  if (!dir) return null;
  return fs.existsSync(dir) ? dir : null;
}

/** The borrowed Chromium directory, or null. Synchronous, same reasoning. */
export function borrowedBrowsers() {
  const dir = loadConfig().borrowedBrowsers;
  if (!dir) return null;
  return hasChromium(dir) ? dir : null;
}

/** Where Playwright should look for Chromium: ours if we have it, else borrowed. */
export function browsersDir() {
  if (hasChromium(PATHS.browsers)) return PATHS.browsers;
  return borrowedBrowsers() ?? PATHS.browsers;
}

/** One line for the doctor, the setup wizard and the UI. */
export function describeBorrow() {
  const cfg = loadConfig();
  const modules = borrowedModules();
  const browsers = borrowedBrowsers();
  if (!modules && !browsers) return { borrowing: false, text: null };
  const parts = [];
  if (modules) parts.push("the model gateway and the agent");
  if (browsers) parts.push("the browser");
  return {
    borrowing: true,
    from: modules ?? browsers,
    text: `Using ${parts.join(" and ")} from your OmniAgent install, so they were not downloaded again.`,
    disabled: cfg.borrowRuntime === "never",
  };
}
