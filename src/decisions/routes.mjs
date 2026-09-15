// Everything the Decisions page can ask the server to do.
//
// Merged into the dispatcher in src/ui/server.mjs, so every route here
// inherits the per-launch token, the loopback-only Host check and the
// `ok:false -> HTTP 400` rule without restating any of it. The table is an
// explicit object, never built from the request path.
//
// Each route opens the workspace database, does its work, and CLOSES IT. Long
// -lived handles across an app that can have its data directory deleted from
// under it is how you get a file lock nobody can explain.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as workspace from "./workspace.mjs";
import { importFolder, writeTemplates, CONTRACT } from "./ingest.mjs";
import { generate, writeDataset, variant, VARIANTS } from "./synthetic.mjs";
import { runAnalysis, rereason, asOfFor } from "./run.mjs";
import { answerQuestion, CATALOGUE } from "./ask.mjs";
import * as D from "./decisions.mjs";
import * as A from "./actions.mjs";
import { tick, overdueDays } from "./followup.mjs";
import { getSettings, setSettings, getMeta, setMeta } from "./db.mjs";
import * as S from "./segments.mjs";
import { rules, editableThresholds, actionLabel } from "./rules.mjs";
import { LABELS, severityRank } from "./situations.mjs";
import { PATHS } from "../util/paths.mjs";
import { daysBetween, addDays, money } from "./format.mjs";
import { logger } from "../util/log.mjs";

const log = logger("decisions/routes");
const ok = (d = {}) => ({ ok: true, ...d });
const bad = (error, extra = {}) => ({ ok: false, error, ...extra });

/** Open the selected workspace, run `fn`, close it whatever happens. */
function withDb(fn) {
  const sel = workspace.openSelected();
  if (!sel) return bad("no workspace yet", { needsWorkspace: true });
  try {
    return fn(sel.db, sel.id);
  } finally {
    try {
      sel.db.close();
    } catch {}
  }
}

async function withDbAsync(fn) {
  const sel = workspace.openSelected();
  if (!sel) return bad("no workspace yet", { needsWorkspace: true });
  try {
    return await fn(sel.db, sel.id);
  } finally {
    try {
      sel.db.close();
    } catch {}
  }
}

// --- shapes the page renders ------------------------------------------------

function decisionCard(db, d, asOf) {
  const evidence = db.prepare("SELECT statement FROM decision_evidence WHERE decision_id = ? ORDER BY rank LIMIT 3").all(d.id);
  const account = d.account_id ? db.prepare("SELECT name, arr FROM account WHERE id = ?").get(d.account_id) : null;
  return {
    id: d.id,
    title: d.title,
    kind: d.kind,
    severity: d.severity,
    status: d.status,
    statusLabel: D.STATUS_LABELS[d.status] ?? d.status,
    owner: d.owner,
    dueAt: d.due_at,
    snoozedUntil: d.snoozed_until,
    accountId: d.account_id,
    accountName: account?.name ?? "Company-wide",
    impactAmount: d.impact_amount,
    impactBasis: d.impact_basis,
    impactLabel: d.impact_amount == null ? null : money(d.impact_amount, d.currency),
    currency: d.currency,
    recommendation: d.recommended_action_text,
    evidence: evidence.map((e) => e.statement),
    ageDays: daysBetween(d.created_at, asOf),
    overdueDays: overdueDays(d, asOf),
    signalsEased: !!d.signals_eased,
    ruleOnly: d.reasoning_source === "rule_only",
    confidence: d.confidence,
  };
}

const OPEN_SQL = `status IN ('new','accepted','in_progress','waiting','snoozed')`;

export const decisionRoutes = {
  // --- state ---------------------------------------------------------------

  async decisionsStatus() {
    const { workspaces, selected } = workspace.list();
    if (!selected) {
      return ok({ workspace: null, workspaces, needsWorkspace: true, variants: VARIANTS });
    }
    return withDb((db, id) => {
      const info = workspace.info(id);
      const lastRun = db.prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 1").get();
      const accounts = db.prepare("SELECT COUNT(*) n FROM account").get().n;
      const settings = getSettings(db);
      return ok({
        workspace: { id, name: info?.name ?? getMeta(db, "workspace_name") ?? "Workspace", accounts },
        workspaces,
        variants: VARIANTS,
        asOf: asOfFor(db),
        demoMode: !!settings.demoMode,
        hasData: accounts > 0,
        lastRun: lastRun
          ? {
              id: lastRun.id,
              at: lastRun.finished_at ?? lastRun.started_at,
              status: lastRun.status,
              accounts: lastRun.accounts,
              candidates: lastRun.candidates,
              created: lastRun.decisions_created,
              model: lastRun.model,
              tokens: (lastRun.input_tokens ?? 0) + (lastRun.output_tokens ?? 0),
              error: lastRun.error,
            }
          : null,
        running: lastRun?.status === "running" ? lastRun.id : null,
      });
    });
  },

  async decisionsWorkspaceCreate({ body }) {
    return workspace.create(body?.name);
  },
  async decisionsWorkspaceSelect({ body }) {
    return workspace.select(body?.id);
  },
  async decisionsWorkspaceRename({ body }) {
    return workspace.rename(body?.id, body?.name);
  },
  async decisionsWorkspaceDelete({ body }) {
    return workspace.remove(body?.id, body?.confirmName);
  },

  // --- data ----------------------------------------------------------------

  async decisionsImport({ body }) {
    const p = String(body?.path ?? "").trim();
    if (!p) return bad("choose a folder first");
    return withDb((db, id) => {
      const r = importFolder(db, p, { workspaceDir: workspace.dirFor(id) });
      return r.ok ? ok({ report: r.report }) : bad(r.error, { report: r.report });
    });
  },

  /**
   * The Windows folder picker, reusing the app's own dialog.
   *
   * `showDialog` rather than the `folderPick` route: that route also sets the
   * AGENT's working folder as a side effect, and choosing a folder of CSVs to
   * import has no business moving where the coding agent writes files.
   */
  async decisionsImportPick() {
    const { showDialog, FOLDER_DIALOG } = await import("../ui/api.mjs");
    const picked = await showDialog(FOLDER_DIALOG);
    if (!picked?.ok) return bad(picked?.error ?? "the picker could not open");
    if (picked.cancelled) return ok({ cancelled: true });
    return decisionRoutes.decisionsImport({ body: { path: picked.paths[0] } });
  },

  /**
   * Import files the user DROPPED on the page, rather than a folder on disk.
   *
   * 🔴 WHY THIS ROUTE HAS TO EXIST. `decisionsImport` takes a server-side folder
   * path, and `decisionsImportPick` opens a native folder dialog. A browser can
   * supply neither: a dropped File has no real path (browsers report
   * `C:\fakepath\...` on purpose), so before this route drag-and-drop could not
   * work at all, no matter what the page did. The bytes had nowhere to go.
   *
   * Files land in a scratch folder inside the workspace, which `importFolder`
   * then reads exactly as it reads any other folder - so dropped files and
   * picked folders go down one code path, not two.
   *
   * ⚠️ FILENAMES HERE COME FROM A BROWSER AND ARE UNTRUSTED. `path.basename`
   * plus the extension allowlist is what stops `../../../config.json` being
   * written outside the scratch folder. Never join a caller-supplied name onto
   * a directory without stripping it first.
   *
   * The 8 MB cap in server.mjs readBody() applies to the whole request, and
   * base64 inflates bytes by about a third. The page therefore sends files in
   * batches; this route reports the limit plainly rather than failing with a
   * generic parse error.
   */
  async decisionsUpload({ body }) {
    const files = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) return bad("no files were sent");

    // 🔴 BATCHING, AND WHY IT IS NOT OPTIONAL. readBody() in server.mjs caps a
    // request at 8 MB and base64 inflates bytes by about a third, so a drop of
    // more than roughly 5 MB has to arrive in several requests. The importer
    // needs every file present at once - accounts.csv is meaningless without
    // usage_daily.csv - so the folder is cleared only on the FIRST batch, and
    // the import runs only on the LAST. An earlier version cleared on every
    // call, which silently deleted batch one when batch two arrived.
    const append = body?.append === true;
    const final = body?.final !== false;

    const ALLOWED = new Set([".csv", ".xlsx", ".xls", ".json", ".tsv"]);
    return withDb((db, id) => {
      const dir = path.join(workspace.dirFor(id), "dropped");
      if (!append) fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });

      const written = [];
      const rejected = [];
      for (const f of files) {
        const name = path.basename(String(f?.name ?? "").trim());
        if (!name || name.startsWith(".")) {
          rejected.push({ name: String(f?.name ?? ""), why: "the file has no usable name" });
          continue;
        }
        const ext = path.extname(name).toLowerCase();
        if (!ALLOWED.has(ext)) {
          rejected.push({ name, why: `${ext || "a file with no extension"} cannot be imported. Use CSV, TSV, XLSX or JSON.` });
          continue;
        }
        let buf;
        try {
          buf = Buffer.from(String(f.base64 ?? ""), "base64");
        } catch {
          rejected.push({ name, why: "the file could not be decoded" });
          continue;
        }
        if (!buf.length) {
          rejected.push({ name, why: "the file is empty" });
          continue;
        }
        fs.writeFileSync(path.join(dir, name), buf);
        written.push({ name, bytes: buf.length });
      }

      if (!written.length && !append) {
        return bad("none of those files could be imported", { rejected });
      }

      // More batches are still coming: hold the files and import nothing yet.
      if (!final) return ok({ staged: written.length, written, rejected });

      const r = importFolder(db, dir, { workspaceDir: workspace.dirFor(id) });
      // `rejected` rides along on success too: importing three of four files and
      // saying nothing about the fourth is how a partial import passes for a
      // complete one.
      return r.ok
        ? ok({ report: r.report, written, rejected })
        : bad(r.error, { report: r.report, written, rejected });
    });
  },

  async decisionsImportReport() {
    return withDb((db) => {
      try {
        return ok({ report: JSON.parse(getMeta(db, "last_import_json") ?? "null") });
      } catch {
        return ok({ report: null });
      }
    });
  },

  async decisionsTemplates() {
    const dest = path.join(PATHS.downloads, "decisions-templates");
    try {
      const files = writeTemplates(dest);
      return ok({ folder: dest, files: files.map((f) => path.basename(f)), contract: CONTRACT });
    } catch (err) {
      return bad(`the templates could not be written: ${err.message}`);
    }
  },

  async decisionsSeedDemo({ body }) {
    const name = ["demo", "demo-cohort", "edge"].includes(body?.variant) ? body.variant : "demo";
    return withDb((db, id) => {
      const asOf = new Date().toISOString().slice(0, 10);
      const data = variant(name, asOf);
      const dir = path.join(os.tmpdir(), `omni-decisions-${name}-${Date.now()}`);
      writeDataset(dir, data);
      const r = importFolder(db, dir, { workspaceDir: workspace.dirFor(id) });
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
      if (!r.ok) return bad(r.error, { report: r.report });

      // The demo needs its two dismissed decisions to already exist, or the
      // suppression scenario cannot be demonstrated at all.
      seedDismissed(db, data, asOf);
      setMeta(db, "as_of", asOf);
      setMeta(db, "demo_variant", name);
      setSettings(db, { demoMode: true });
      return ok({ report: r.report, variant: name, accounts: data.scenarios.length });
    });
  },

  // --- the run -------------------------------------------------------------

  async decisionsRun({ body }) {
    return withDbAsync(async (db, id) => {
      const r = await runAnalysis({ db, noModel: body?.noModel === true });
      if (r.ok) workspace.touchRun(id);
      return r.ok ? ok({ runId: r.runId, summary: r.summary }) : bad(r.error);
    });
  },

  async decisionsRunStatus({ query }) {
    return withDb((db) => {
      const run = query?.id
        ? db.prepare("SELECT * FROM run WHERE id = ?").get(query.id)
        : db.prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 1").get();
      if (!run) return ok({ run: null });
      let progress = null;
      try {
        progress = JSON.parse(run.progress_json ?? "null");
      } catch {}
      return ok({ run: { ...run, progress } });
    });
  },

  async decisionsRereason({ body }) {
    if (!body?.id) return bad("which decision?");
    return withDbAsync(async (db) => {
      const r = await rereason({ db, decisionId: body.id });
      return r.ok ? ok({ model: r.model }) : bad(r.error);
    });
  },

  // --- reading decisions ---------------------------------------------------

  async decisionsOverview() {
    return withDb((db) => {
      const asOf = asOfFor(db);
      const all = db.prepare(`SELECT * FROM decision ORDER BY updated_at DESC`).all();
      const open = all.filter((d) => D.OPEN_STATUSES.includes(d.status));
      const bySeverity = (a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.impact_amount ?? 0) - (a.impact_amount ?? 0);

      const overdue = open.filter((d) => overdueDays(d, asOf) != null).sort(bySeverity);
      const overdueIds = new Set(overdue.map((d) => d.id));
      const attention = open.filter((d) => ["new"].includes(d.status) && !overdueIds.has(d.id)).sort(bySeverity);
      const waiting = open
        .filter((d) => ["accepted", "in_progress", "waiting"].includes(d.status) && !overdueIds.has(d.id))
        .sort(bySeverity);
      const snoozed = open.filter((d) => d.status === "snoozed").sort(bySeverity);

      const monthAgo = addDays(asOf, -30);
      const resolved = all.filter((d) => d.status === "resolved" && (d.resolved_at ?? "") >= monthAgo);
      const dismissed = all.filter((d) => d.status === "dismissed");

      const arrUnderReview = open.reduce((n, d) => n + (d.kind === "churn_risk" ? Number(d.impact_amount) || 0 : 0), 0);
      const currency = open[0]?.currency ?? getSettings(db).currency ?? "USD";

      const card = (d) => decisionCard(db, d, asOf);
      return ok({
        asOf,
        tiles: {
          attention: attention.length,
          overdue: overdue.length,
          waiting: waiting.length,
          snoozed: snoozed.length,
          resolvedThisMonth: resolved.length,
          arrUnderReview,
          arrUnderReviewLabel: money(arrUnderReview, currency),
        },
        sections: {
          attention: attention.map(card),
          overdue: overdue.map(card),
          waiting: waiting.map(card),
          snoozed: snoozed.map(card),
          resolved: resolved.slice(0, 5).map(card),
        },
        counts: { open: open.length, all: all.length, dismissed: dismissed.length },
      });
    });
  },

  async decisionsList({ query }) {
    return withDb((db) => {
      const asOf = asOfFor(db);
      const where = [];
      const args = [];
      const status = query?.status ?? "open";
      if (status === "open") where.push(OPEN_SQL);
      else if (status && status !== "all") {
        where.push("status = ?");
        args.push(status);
      }
      if (query?.severity && query.severity !== "all") {
        where.push("severity = ?");
        args.push(query.severity);
      }
      if (query?.kind && query.kind !== "all") {
        where.push("kind = ?");
        args.push(query.kind);
      }
      if (query?.owner && query.owner !== "all") {
        if (query.owner === "unassigned") where.push("(owner IS NULL OR owner = '')");
        else {
          where.push("owner = ?");
          args.push(query.owner);
        }
      }
      if (query?.account) {
        where.push("account_id = ?");
        args.push(query.account);
      }
      const sql = `SELECT * FROM decision ${where.length ? "WHERE " + where.join(" AND ") : ""}`;
      let rows = db.prepare(sql).all(...args);
      const sort = query?.sort ?? "priority";
      rows.sort((a, b) => {
        if (sort === "newest") return String(b.created_at).localeCompare(String(a.created_at));
        if (sort === "due") return String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999"));
        return severityRank(b.severity) - severityRank(a.severity) || (b.impact_amount ?? 0) - (a.impact_amount ?? 0);
      });
      const owners = db.prepare("SELECT DISTINCT owner FROM decision WHERE owner IS NOT NULL AND owner != ''").all().map((r) => r.owner);
      return ok({ decisions: rows.map((d) => decisionCard(db, d, asOf)), total: rows.length, owners, asOf });
    });
  },

  async decisionsGet({ query }) {
    if (!query?.id) return bad("which decision?");
    return withDb((db) => {
      const d = D.getDecision(db, query.id);
      if (!d) return bad("that decision does not exist any more");
      const asOf = asOfFor(db);
      const account = d.account_id ? db.prepare("SELECT * FROM account WHERE id = ?").get(d.account_id) : null;
      const evidence = db.prepare("SELECT * FROM decision_evidence WHERE decision_id = ? ORDER BY rank").all(d.id);
      const hypotheses = db
        .prepare("SELECT * FROM decision_hypothesis WHERE decision_id = ? ORDER BY rank")
        .all(d.id)
        .map((h) => ({ ...h, evidence: JSON.parse(h.evidence_ids_json || "[]") }));
      const events = db.prepare("SELECT * FROM decision_event WHERE decision_id = ? ORDER BY at").all(d.id).map((e) => ({
        ...e,
        data: e.data_json ? JSON.parse(e.data_json) : null,
      }));
      const actions = A.listActions(db, d.id);
      const outcome = db.prepare("SELECT * FROM outcome WHERE decision_id = ?").get(d.id) ?? null;

      // Every signal on this account in the latest run, cited or not: the
      // "here is everything we looked at" panel that makes the recommendation
      // checkable rather than merely plausible.
      const lastRun = d.last_run_id ?? db.prepare("SELECT id FROM run ORDER BY started_at DESC LIMIT 1").get()?.id;
      const allSignals = d.account_id
        ? db.prepare("SELECT * FROM signal WHERE run_id = ? AND account_id = ? ORDER BY band DESC").all(lastRun, d.account_id)
        : [];
      const citedIds = new Set(evidence.map((e) => e.signal_id));
      const settings = getSettings(db);
      const R = rules();

      return ok({
        decision: {
          ...decisionCard(db, d, asOf),
          whyItMatters: d.why_it_matters,
          rationale: d.rationale,
          reasoningSource: d.reasoning_source,
          reasoningError: d.reasoning_error,
          model: d.model,
          createdAt: d.created_at,
          updatedAt: d.updated_at,
          resolvedAt: d.resolved_at,
          dismissedReason: d.dismissed_reason,
          statusBeforeSnooze: d.status_before_snooze,
          allowedNext: D.TRANSITIONS[d.status] ?? [],
        },
        account: account
          ? {
              ...account,
              tenureDays: account.created_at ? daysBetween(account.created_at, asOf) : null,
              daysToRenewal: account.renewal_date ? daysBetween(asOf, account.renewal_date) : null,
              contacts: db.prepare("SELECT * FROM contact WHERE account_id = ?").all(account.id),
            }
          : null,
        evidence: evidence.map((e) => ({ ...e, cited: true })),
        allSignals: allSignals.map((s) => ({
          ...s,
          detail: s.detail_json ? JSON.parse(s.detail_json) : {},
          cited: citedIds.has(s.id),
          label: R.signals[s.kind]?.label ?? s.kind,
          threshold: R.signals[s.kind]?.bands?.[0] ?? null,
        })),
        hypotheses,
        events,
        actions,
        outcome,
        businessContext: settings.businessContext || null,
        outcomes: D.OUTCOMES,
        owners: settings.owners ?? [],
        statusLabels: D.STATUS_LABELS,
        asOf,
      });
    });
  },

  // --- changing decisions --------------------------------------------------

  async decisionsUpdate({ body }) {
    if (!body?.id) return bad("which decision?");
    return withDb((db) => {
      let out = { ok: true };
      if (body.owner !== undefined) out = D.setOwner(db, body.id, body.owner);
      if (out.ok && body.dueAt !== undefined) out = D.setDue(db, body.id, body.dueAt);
      if (out.ok && body.status) {
        // Accepting with no due date should not leave one unset: a decision
        // with no date can never be overdue, which is the whole follow-up loop.
        const d = D.getDecision(db, body.id);
        out = D.setStatus(db, body.id, body.status);
        if (out.ok && body.status === "accepted" && d && !d.due_at) {
          D.setDue(db, body.id, D.suggestedDue(d.severity, asOfFor(db)));
        }
      }
      return out.ok ? ok({ decision: D.getDecision(db, body.id) }) : out;
    });
  },

  async decisionsSnooze({ body }) {
    if (!body?.id) return bad("which decision?");
    return withDb((db) => D.snooze(db, body.id, body.until));
  },
  async decisionsDismiss({ body }) {
    if (!body?.id) return bad("which decision?");
    return withDb((db) => D.dismiss(db, body.id, body.reason));
  },
  async decisionsResolve({ body }) {
    if (!body?.id) return bad("which decision?");
    return withDb((db) => D.resolve(db, body.id, { result: body.result, note: body.note, arrAfter: body.arrAfter }));
  },
  async decisionsReopen({ body }) {
    if (!body?.id) return bad("which decision?");
    return withDb((db) => D.reopen(db, body.id));
  },
  async decisionsNote({ body }) {
    if (!body?.id) return bad("which decision?");
    return withDb((db) => D.addNote(db, body.id, body.text));
  },

  // --- actions -------------------------------------------------------------

  async decisionsActionPrepare({ body }) {
    if (!body?.id) return bad("which decision?");
    if (body.kind === "task") {
      return withDb((db) => A.prepareTask(db, body.id, body.task ?? {}));
    }
    return withDbAsync(async (db) => A.prepareDraftEmail(db, body.id, { force: body.force === true }));
  },

  async decisionsActionUpdate({ body }) {
    if (!body?.actionId) return bad("which action?");
    return withDb((db) => A.updateAction(db, body.actionId, { status: body.status, payload: body.payload }));
  },

  // --- customers -----------------------------------------------------------

  async decisionsCustomers({ query }) {
    return withDb((db) => {
      const asOf = asOfFor(db);
      const lastRun = db.prepare("SELECT id FROM run ORDER BY started_at DESC LIMIT 1").get()?.id ?? null;
      const q = String(query?.q ?? "").trim().toLowerCase();
      const rows = db.prepare("SELECT * FROM account").all();
      const labels = new Map(
        lastRun ? db.prepare("SELECT account_id, label, tenure_days FROM account_run_state WHERE run_id = ?").all(lastRun).map((r) => [r.account_id, r]) : [],
      );
      const openCounts = new Map(
        db.prepare(`SELECT account_id, COUNT(*) n FROM decision WHERE ${OPEN_SQL} GROUP BY account_id`).all().map((r) => [r.account_id, r.n]),
      );
      const watchCounts = new Map(
        lastRun ? db.prepare("SELECT account_id, COUNT(*) n FROM watch WHERE run_id = ? GROUP BY account_id").all(lastRun).map((r) => [r.account_id, r.n]) : [],
      );
      const stale = new Set(
        lastRun ? db.prepare("SELECT DISTINCT account_id FROM signal WHERE run_id = ? AND kind = 'data_stale'").all(lastRun).map((r) => r.account_id) : [],
      );

      let out = rows.map((a) => ({
        id: a.id,
        name: a.name,
        arr: a.arr,
        arrLabel: money(a.arr, getSettings(db).currency),
        plan: a.plan,
        owner: a.owner,
        renewalDate: a.renewal_date,
        daysToRenewal: a.renewal_date ? daysBetween(asOf, a.renewal_date) : null,
        label: labels.get(a.id)?.label ?? null,
        labelText: LABELS[labels.get(a.id)?.label] ?? null,
        openDecisions: openCounts.get(a.id) ?? 0,
        watching: watchCounts.get(a.id) ?? 0,
        staleData: stale.has(a.id),
      }));
      if (q) out = out.filter((a) => a.name.toLowerCase().includes(q) || a.id.toLowerCase().includes(q));
      if (query?.label && query.label !== "all") out = out.filter((a) => a.label === query.label);
      const sort = query?.sort ?? "arr";
      out.sort((a, b) => (sort === "renewal" ? (a.daysToRenewal ?? 9999) - (b.daysToRenewal ?? 9999) : b.arr - a.arr));
      return ok({ customers: out, total: out.length, labels: LABELS, hasRun: !!lastRun });
    });
  },

  async decisionsCustomer({ query }) {
    if (!query?.id) return bad("which customer?");
    return withDb((db) => {
      const a = db.prepare("SELECT * FROM account WHERE id = ?").get(query.id);
      if (!a) return bad("that customer is not in the imported data");
      const asOf = asOfFor(db);
      const lastRun = db.prepare("SELECT id FROM run ORDER BY started_at DESC LIMIT 1").get()?.id ?? null;
      const R = rules();
      const signals = lastRun
        ? db.prepare("SELECT * FROM signal WHERE run_id = ? AND account_id = ? ORDER BY band DESC").all(lastRun, a.id)
        : [];
      const watchIds = new Set(
        lastRun ? db.prepare("SELECT signal_id FROM watch WHERE run_id = ? AND account_id = ?").all(lastRun, a.id).map((r) => r.signal_id) : [],
      );
      const state = lastRun ? db.prepare("SELECT * FROM account_run_state WHERE run_id = ? AND account_id = ?").get(lastRun, a.id) : null;
      const decisions = db.prepare("SELECT * FROM decision WHERE account_id = ? ORDER BY updated_at DESC").all(a.id);
      const usageDays = db.prepare("SELECT MAX(day) d, COUNT(*) n FROM metric_daily WHERE account_id = ? AND metric = 'active_users'").get(a.id);

      return ok({
        account: {
          ...a,
          arrLabel: money(a.arr, getSettings(db).currency),
          tenureDays: a.created_at ? daysBetween(a.created_at, asOf) : null,
          daysToRenewal: a.renewal_date ? daysBetween(asOf, a.renewal_date) : null,
          label: state?.label ?? null,
          labelText: LABELS[state?.label] ?? null,
        },
        contacts: db.prepare("SELECT * FROM contact WHERE account_id = ? ORDER BY is_champion DESC").all(a.id).map((c) => ({
          ...c,
          quietDays: c.last_active_at ? daysBetween(c.last_active_at, asOf) : null,
        })),
        signals: signals.map((s) => ({
          ...s,
          detail: s.detail_json ? JSON.parse(s.detail_json) : {},
          label: R.signals[s.kind]?.label ?? s.kind,
          isWatch: watchIds.has(s.id),
          threshold: R.signals[s.kind]?.bands?.[0] ?? null,
        })),
        decisions: decisions.map((d) => decisionCard(db, d, asOf)),
        data: {
          lastUsageDay: usageDays?.d ?? null,
          usageRows: usageDays?.n ?? 0,
          tickets: db.prepare("SELECT COUNT(*) n FROM ticket WHERE account_id = ?").get(a.id).n,
          invoices: db.prepare("SELECT COUNT(*) n FROM invoice WHERE account_id = ?").get(a.id).n,
          events: db.prepare("SELECT COUNT(*) n FROM event WHERE account_id = ?").get(a.id).n,
        },
        asOf,
      });
    });
  },

  // --- segments ------------------------------------------------------------
  //
  // 🔴 EVERY ROUTE BELOW TAKES CRITERIA WRITTEN BY THE USER. None of them ever
  // sees a field name, an operator or a value except through
  // `S.compileCriteria`, which checks both against a fixed allowlist and binds
  // every value with `?`. A route here must never assemble SQL of its own.

  /**
   * Every saved segment, with its live count, plus the field vocabulary.
   *
   * The vocabulary rides along because the page builds its field and operator
   * menus from it. Two copies of that list - one in the browser deciding what to
   * offer, one on the server deciding what to accept - is how a page ends up
   * offering a rule the server refuses.
   */
  async decisionsSegments() {
    return withDb((db) => {
      const asOf = asOfFor(db);
      const currency = getSettings(db).currency ?? "USD";
      const hasRun = !!db.prepare("SELECT id FROM run ORDER BY started_at DESC LIMIT 1").get();
      return ok({
        segments: S.listSegments(db, { asOf, currency }),
        ...S.fieldVocabulary(),
        choices: S.groundingFor(db),
        total: db.prepare("SELECT COUNT(*) n FROM account").get().n,
        currency,
        hasRun,
        asOf,
      });
    });
  },

  /**
   * Count a rule and show who matches, WITHOUT saving it.
   *
   * A rule you cannot try is a rule you cannot trust, so this is the route the
   * builder calls on every edit. It is also the only way the count on screen and
   * the count a saved segment reports can be guaranteed to be the same number:
   * both come from `S.previewCriteria`.
   */
  async decisionsSegmentPreview({ body }) {
    return withDb((db) => {
      const asOf = asOfFor(db);
      const r = S.previewCriteria(db, body?.groups ?? [], {
        asOf,
        currency: getSettings(db).currency ?? "USD",
        limit: body?.limit,
      });
      if (!r.ok) return bad(r.error);
      const { ok: _ignored, ...rest } = r;
      return ok({ ...rest, asOf });
    });
  },

  async decisionsSegmentCreate({ body }) {
    return withDb((db) => S.createSegment(db, { name: body?.name, groups: body?.groups }));
  },

  /** Rename, re-rule, or both: the page's rename path sends only a name. */
  async decisionsSegmentUpdate({ body }) {
    if (!body?.id) return bad("which segment?");
    return withDb((db) => S.updateSegment(db, body.id, { name: body.name, groups: body.groups }));
  },

  async decisionsSegmentDelete({ body }) {
    if (!body?.id) return bad("which segment?");
    return withDb((db) => S.deleteSegment(db, body.id));
  },

  /**
   * Turn a sentence into criteria the user then confirms or edits.
   *
   * ⭐ NOTHING IS APPLIED HERE. The reply is a proposal: rules, the words it did
   * not use, and notes about what it refused to guess. `source` says whether a
   * model read it or the offline phrase list did, so nobody is left believing a
   * model was involved when there was none.
   */
  async decisionsSegmentDescribe({ body }) {
    return withDbAsync(async (db) => {
      const r = await S.describeSegment({
        db,
        text: body?.text,
        vocab: S.groundingFor(db),
        // The page offers this so a user who does not want a model call can
        // still use the box. Absent, a model is tried and falls back on its own.
        useModel: body?.useModel !== false,
      });
      return r.ok ? ok(r) : bad(r.error);
    });
  },

  // --- ask -----------------------------------------------------------------

  /**
   * Turn one typed question into an answer, or into an explicit refusal.
   *
   * 🔴 THIS IS NOT TEXT-TO-SQL, AND THE DIFFERENCE IS THE PRODUCT. The model
   * names one entry in the fixed catalogue in ask.mjs and fills its declared
   * parameters; nothing it returns reaches SQLite. `src/decisions/ask.mjs`
   * carries the measurement that argues for it.
   *
   * POST rather than GET for two reasons that both matter: the question is the
   * person's own words and does not belong in a URL that lands in logs, and the
   * call writes an `llm_call` audit row.
   *
   * `noModel` mirrors `decisionsRun`: it forces the keyword path, which is how
   * the offline behaviour is exercised without a gateway.
   */
  async decisionsAsk({ body }) {
    const question = String(body?.question ?? "").trim();
    if (!question) return bad("type a question first");
    // The catalogue is matched on words, so a wall of text is never a better
    // match than a sentence - it just costs tokens and fills the audit row.
    if (question.length > 400) return bad("that question is too long to match against the catalogue (400 characters at most)");
    return withDbAsync(async (db) => {
      const r = await answerQuestion(db, { question, noModel: body?.noModel === true });
      return ok({
        result: r.result,
        source: r.source,
        intent: r.intent,
        model: r.model,
        asOf: r.asOf,
        // What CAN be asked, so a refusing page never has to hardcode the list
        // and drift from the server that decides it.
        catalogue: CATALOGUE.map((i) => ({ id: i.id, question: i.question, counts: i.counts })),
      });
    });
  },

  // --- activity ------------------------------------------------------------

  async decisionsActivity({ query }) {
    return withDb((db) => {
      const filter = query?.filter ?? "all";
      const limitN = Math.min(Number(query?.limit) || 120, 400);
      const events = db
        .prepare(
          `SELECT e.*, d.title, d.account_id FROM decision_event e
           JOIN decision d ON d.id = e.decision_id
           ${filter === "system" ? "WHERE e.actor = 'system'" : filter === "me" ? "WHERE e.actor = 'user'" : ""}
           ORDER BY e.at DESC LIMIT ?`,
        )
        .all(limitN)
        .map((e) => ({
          at: e.at,
          actor: e.actor,
          kind: e.kind,
          decisionId: e.decision_id,
          title: e.title,
          data: e.data_json ? JSON.parse(e.data_json) : null,
        }));

      const runs =
        filter === "me"
          ? []
          : db
              .prepare("SELECT * FROM run ORDER BY started_at DESC LIMIT 20")
              .all()
              .map((r) => ({
                at: r.finished_at ?? r.started_at,
                actor: "system",
                kind: "run",
                data: {
                  accounts: r.accounts,
                  candidates: r.candidates,
                  created: r.decisions_created,
                  updated: r.decisions_updated,
                  reasoned: r.reasoned,
                  cached: r.cached,
                  calls: r.llm_calls,
                  failures: r.llm_failures,
                  tokens: (r.input_tokens ?? 0) + (r.output_tokens ?? 0),
                  model: r.model,
                  status: r.status,
                  error: r.error,
                },
              }));

      const all = [...events, ...runs].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limitN);
      return ok({ entries: all });
    });
  },

  // --- settings ------------------------------------------------------------

  async decisionsSettingsGet() {
    return withDb((db, id) => {
      const settings = getSettings(db);
      return ok({
        settings,
        workspace: { id, name: workspace.info(id)?.name ?? "" },
        thresholds: editableThresholds(settings),
        limits: rules().limits,
        asOf: asOfFor(db),
        dataDir: workspace.dirFor(id),
        contract: CONTRACT,
        variants: VARIANTS,
      });
    });
  },

  async decisionsSettingsSet({ body }) {
    if (!body || typeof body !== "object") return bad("nothing to change");
    return withDb((db) => {
      const patch = {};
      if (Array.isArray(body.owners)) patch.owners = body.owners.map((o) => String(o).trim()).filter(Boolean).slice(0, 40);
      if (body.businessContext !== undefined) {
        patch.businessContext = String(body.businessContext).slice(0, rules().limits.businessContextMaxChars);
      }
      if (body.pseudonymise !== undefined) patch.pseudonymise = !!body.pseudonymise;
      if (body.demoMode !== undefined) patch.demoMode = !!body.demoMode;
      if (Number.isFinite(Number(body.maxReasonedPerRun))) {
        patch.maxReasonedPerRun = Math.max(1, Math.min(50, Math.round(Number(body.maxReasonedPerRun))));
      }
      if (Number.isFinite(Number(body.seatPriceMonthly))) patch.seatPriceMonthly = Number(body.seatPriceMonthly);
      if (body.thresholds && typeof body.thresholds === "object") {
        const clean = {};
        for (const [k, v] of Object.entries(body.thresholds)) {
          if (Number.isFinite(Number(v))) clean[k] = Number(v);
        }
        patch.thresholds = clean;
      }
      const next = setSettings(db, patch);
      return ok({ settings: next });
    });
  },

  /** Demo only: move the clock so a reminder can be seen without waiting. */
  async decisionsClockAdvance({ body }) {
    return withDb((db) => {
      const settings = getSettings(db);
      if (!settings.demoMode) return bad("the clock can only be moved in demo mode (Settings > Demo)");
      const days = Math.max(1, Math.min(120, Math.round(Number(body?.days) || 7)));
      const next = addDays(asOfFor(db), days);
      setMeta(db, "as_of", next);
      const r = tick(db);
      return ok({ asOf: next, followUp: r });
    });
  },

  async decisionsRules() {
    return withDb((db) => ok({ rules: rules(), thresholds: editableThresholds(getSettings(db)) }));
  },
};

/** Seed the two "previously dismissed" demo decisions. */
function seedDismissed(db, data, asOf) {
  const rows = data.scenarios.filter((s) => s.scenario.startsWith("dismissed_"));
  for (const s of rows) {
    const id = `dec_seed${s.account_id.replace(/\W/g, "")}`;
    const when = addDays(asOf, -10) + "T09:00:00.000Z";
    db.prepare(
      `INSERT OR REPLACE INTO decision (id, account_id, fingerprint, kind, title, severity, status, reasoning_source,
         impact_basis, currency, created_at, updated_at, dismissed_reason)
       VALUES (?, ?, ?, 'churn_risk', ?, ?, 'dismissed', 'rule_only', 'annual contract value at risk', 'USD', ?, ?, ?)`,
      // Seeded at HIGH deliberately. Suppression compares the new severity with
      // the dismissed one, so a low seed would let the unchanged account raise a
      // fresh decision and the scenario would test nothing.
    ).run(id, s.account_id, `${s.account_id}:churn_risk`, `${s.name}: churn risk`, "high", when, when, s.scenario === "dismissed_unchanged" ? "Seasonal dip, confirmed with the customer" : "Thought it was a seasonal dip");
    D.logEvent(db, id, "user", "dismissed", { reason: "seeded for the demo" });
  }
}

export default decisionRoutes;
