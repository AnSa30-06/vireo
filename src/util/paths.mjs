// Filesystem layout for the Ledgerline distribution.
//
// Everything the app owns lives under one root so an uninstall is a single
// directory removal, and so the bundled OmniRoute never collides with a
// pre-existing user install (which keeps its own data in ~/.omniroute).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository / installation root (the directory containing package.json). */
export const APP_ROOT = path.resolve(HERE, "..", "..");

/**
 * Where this install keeps its data.
 *
 * 🔴 THE LEGACY FOLDER IS NOT OPTIONAL. The product was called Vireo until
 * 1.3.2, and its data - every workspace, the settings, the encrypted credential
 * store - lives in a folder named after it. Renaming the product renames this
 * function's answer, and on a machine that already had Vireo installed that
 * means every workspace, every imported customer and every decision silently
 * disappears on update. Nothing errors. The app simply opens as though it had
 * never been used.
 *
 * ⭐ So an existing folder WINS over a new one. If the new directory does not
 * exist yet and the old one does, the old one is used, for good. Nothing is
 * moved, copied or deleted: a rename that half-finishes is worse than a folder
 * with a stale name, and a stale folder name is invisible to everybody.
 *
 * ⚠️ The environment variable is checked first and is never second-guessed - the
 * tests set it to a temporary directory, and a fallback that outvoted it would
 * make every test share one home.
 */
function baseDir() {
  if (process.env.LEDGERLINE_HOME) return path.resolve(process.env.LEDGERLINE_HOME);
  // Honour the old variable too, so a script or shortcut written against the
  // previous name keeps pointing at the same data.
  if (process.env.VIREO_HOME) return path.resolve(process.env.VIREO_HOME);

  const preferLegacy = (next, legacy) => {
    try {
      if (!fs.existsSync(next) && fs.existsSync(legacy)) return legacy;
    } catch {
      // An unreadable path is not a reason to refuse to start.
    }
    return next;
  };

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return preferLegacy(path.join(local, "Ledgerline"), path.join(local, "Vireo"));
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return preferLegacy(path.join(xdg, "ledgerline"), path.join(xdg, "vireo"));
  return preferLegacy(path.join(os.homedir(), ".ledgerline"), path.join(os.homedir(), ".vireo"));
}

export const HOME = baseDir();

export const PATHS = {
  home: HOME,
  /** User-editable settings (never contains secrets). */
  config: path.join(HOME, "config.json"),
  /** DPAPI/0600-protected credential store. */
  secrets: path.join(HOME, "credentials.dat"),
  /** Isolated OmniRoute DATA_DIR - deliberately not ~/.omniroute. */
  gatewayData: path.join(HOME, "gateway"),
  /** Playwright browser download location. */
  browsers: path.join(HOME, "browsers"),
  /** Local usage telemetry (JSONL, one line per model call). */
  telemetry: path.join(HOME, "telemetry"),
  /** Cached provider quota responses, so the UI can show "last known value". */
  quotaCache: path.join(HOME, "quota-cache.json"),
  /** Diagnostics logs. Sanitised on export. */
  logs: path.join(HOME, "logs"),
  /** Where OpenCode config for this distribution is written. */
  opencode: path.join(HOME, "opencode"),
  /** Default workspace opened when the user launches with no directory. */
  workspace: path.join(os.homedir(), "Ledgerline Workspace"),
  /** Decisions workspaces: one SQLite file and its import copies per company. */
  decisions: path.join(HOME, "decisions"),
  /** Scratch space for downloads made by the browser/scraper tools. */
  downloads: path.join(HOME, "downloads"),
  /**
   * Which copy of the app owns this data directory. Holds a port and a pid -
   * deliberately NOT the UI token, which is a per-launch secret and stays out
   * of the filesystem (see the note in src/ui/server.mjs).
   */
  uiLock: path.join(HOME, "ui.lock"),
};

export function ensureDirs() {
  for (const key of ["home", "gatewayData", "browsers", "telemetry", "logs", "opencode", "downloads", "decisions"]) {
    fs.mkdirSync(PATHS[key], { recursive: true });
  }
  return PATHS;
}

/** Resolve a path inside the installed package (config templates, skills, plugin). */
export function pkg(...parts) {
  return path.join(APP_ROOT, ...parts);
}
