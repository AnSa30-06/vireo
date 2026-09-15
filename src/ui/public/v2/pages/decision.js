// One decision, in full, with the evidence that produced it.
//
// The epistemic split is the whole layout, and it is deliberate:
//
//   LEFT  — what the SYSTEM says. The title, the state, who owns it, the
//           model's reasoning, the recommended action, and every control that
//           moves the decision along.
//   RIGHT — what the DATA says. The evidence rail: the cited statements, the
//           raw signal behind each one, the threshold the rule fired at, and
//           every other signal we looked at and did NOT use.
//
// The rail exists because of a measured failure in this category: a single
// plausible-looking wrong number erodes more trust than ten correct answers
// build. So no number on this page is allowed to stand alone. Every figure is
// rendered next to the signal id, the reading, the baseline and the threshold
// that produced it, and the uncited signals are one <details> click away rather
// than hidden — an operator must be able to see what we ignored, not just what
// we chose.
//
// 🔴 EVERY STRING FROM THE API IS INSERTED WITH textContent. Nothing here uses
// innerHTML. Customer names and model-written prose are untrusted text.

// The charts belong to another file in this surface. A static `import` would
// read better, but a missing module — or a missing named export — is a
// LINK-time failure in ESM: the whole page would fail to load and the evidence
// rail, which is the point of this screen, would render nothing at all. So the
// charts are pulled in lazily and every one of them degrades to the plain text
// line printed beside it.
let charts = null;
const chartsReady = import("../components/charts.js")
  .then((m) => {
    charts = m;
  })
  .catch(() => {
    charts = null;
  });

export const title = "Decision";

/* ── tiny DOM helpers ───────────────────────────────────────────────────── */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const button = (label, cls, onClick) => {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
};

const field = (parent, label, node, hint) => {
  const l = el("label", "f");
  l.append(el("span", "f-l", label), node);
  if (hint) l.append(el("div", "hint", hint));
  parent.append(l);
  return node;
};

const select = (options, value) => {
  const s = el("select");
  for (const [v, t] of options) {
    const o = el("option", null, t);
    o.value = v;
    if (v === value) o.selected = true;
    s.append(o);
  }
  return s;
};

const panel = (heading, sub) => {
  const p = el("section", "panel");
  if (heading) p.append(el("h2", null, heading));
  if (sub) p.append(el("p", "hint", sub));
  return p;
};

const kv = (dl, key, value) => {
  dl.append(el("dt", null, key), el("dd", null, value == null || value === "" ? "—" : String(value)));
};

/* ── vocabulary that comes from the engine, not from us ─────────────────── */

const BAND_WORD = ["", "notable", "significant", "severe"];

// Units for the rule thresholds, read off config/decisions/rules.json. The
// signals table stores a bare number, and a bare number is exactly the kind of
// figure this page must never show: "-40" means nothing, "-40%" is a fact.
const SIGNAL_UNIT = {
  usage_drop_30d: "%",
  usage_rise_30d: "%",
  usage_drop_7d: "%",
  tickets_up_30d: "%",
  seat_util_low: "%",
  seat_util_high: "%",
  renewal_near: " days",
  champion_inactive: " days",
  data_stale: " days",
  payment_failed: "",
  pricing_interest: "",
};

// Labels for the transitions the state machine offers. The engine sends the bare
// status token in decision.allowedNext; only tokens present there are drawn, so
// a control that would be rejected is never painted.
const NEXT_LABEL = {
  new: "Put back to new",
  accepted: "Accept",
  in_progress: "Start work",
  waiting: "Waiting on the customer",
  snoozed: "Snooze",
  resolved: "Resolve with an outcome",
  dismissed: "Dismiss",
};

// The event payload shape is not part of the route contract — decisionsGet
// promises only `data:object|null`. These keys are taken from the events the
// engine actually writes, but an older or unknown event would otherwise
// interpolate the literal word "undefined" into the trail, which is exactly the
// kind of confident-looking wrong text this page must never print. `some()`
// turns a missing value into a dash at the point it is read.
const some = (v, fallback = "—") => (v == null || v === "" ? fallback : String(v));

function describeEvent(e) {
  const d = e.data ?? {};
  switch (e.kind) {
    case "created":
      return `Raised as ${some(d.severity)}${d.source === "rule_only" ? " (from the rules; no model brief)" : ""}`;
    case "updated":
      return `Updated — severity ${some(d.from)} to ${some(d.to)}`;
    case "escalated":
      return `Got worse — severity ${some(d.from)} to ${some(d.to)}`;
    case "status":
      return `Status: ${some(d.from)} to ${some(d.to)}${d.because ? ` (${d.because})` : ""}`;
    case "owner":
      return `Owner set to ${some(d.to, "nobody")}`;
    case "due":
      return `Due date set to ${some(d.to, "none")}`;
    case "snoozed":
      return `Snoozed until ${some(d.until)}`;
    case "unsnoozed":
      return `Came back — ${some(d.reason)}`;
    case "dismissed":
      return `Dismissed: ${some(d.reason)}`;
    case "resolved":
      return `Resolved: ${some(d.result)}`;
    case "outcome":
      return `Outcome recorded: ${some(d.result)}`;
    case "reminder":
      return d.daysOverdue != null ? `Reminder — ${d.daysOverdue} days overdue` : `Reminder — waiting ${d.waitingDays} days`;
    case "action_prepared":
      return `${d.kind === "task" ? "Task created" : "Email drafted"}${d.source === "template" ? " (standard wording; the model was not available)" : ""}`;
    case "action_done":
      return `${d.kind === "task" ? "Task" : "Email"} marked done`;
    case "action_cancelled":
      return `${d.kind === "task" ? "Task" : "Email"} cancelled`;
    case "note":
      return some(d.text, "Note");
    default:
      return e.kind;
  }
}

/* ── scoped styling ─────────────────────────────────────────────────────── */

// Everything is namespaced under .v2-dec and lives inside the root this page
// owns, so re-rendering replaces the rules instead of stacking them and nothing
// here can reach another page's markup. Colours come from tokens.css only.
//
// NOT named CSS: that identifier is the global CSS object, and shadowing it
// would silently disable CSS.escape() in cssEscape() below.
const STYLE = `
.v2-dec{color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Inter,Roboto,sans-serif;}
.v2-dec *{box-sizing:border-box;}
.v2-dec .cols{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:18px;align-items:start;}
@media (max-width:1000px){.v2-dec .cols{grid-template-columns:minmax(0,1fr);}}
.v2-dec .col{display:flex;flex-direction:column;gap:14px;min-width:0;}
.v2-dec .panel{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:14px 16px;min-width:0;}
.v2-dec .panel h2{margin:0 0 8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;}
.v2-dec h1{margin:6px 0 10px;font-size:22px;line-height:1.3;font-weight:650;}
.v2-dec p{margin:0 0 10px;}
.v2-dec p:last-child{margin-bottom:0;}
.v2-dec .hint{color:var(--muted);font-size:12.5px;margin:0 0 8px;}
.v2-dec .crumbs{display:flex;align-items:center;gap:8px;color:var(--muted);font-size:12.5px;flex-wrap:wrap;}
.v2-dec .chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:12px;}
.v2-dec .chip{border:1px solid var(--border);border-radius:999px;padding:2px 9px;font-size:12px;color:var(--muted);white-space:nowrap;}
.v2-dec .chip.sev-critical,.v2-dec .chip.sev-high{border-color:var(--danger);color:var(--danger);}
.v2-dec .chip.sev-medium{border-color:var(--warn);color:var(--warn);}
.v2-dec .chip.on{border-color:var(--accent);color:var(--accent);}
.v2-dec .chip.warn{border-color:var(--warn);color:var(--warn);}
.v2-dec .chip.bad{border-color:var(--danger);color:var(--danger);}
.v2-dec button{font:inherit;}
.v2-dec .btn{background:transparent;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 11px;cursor:pointer;}
.v2-dec .btn:hover{border-color:var(--muted);}
.v2-dec .btn:disabled{opacity:.5;cursor:default;}
.v2-dec .btn.primary{border-color:var(--accent);color:var(--accent);}
.v2-dec .btn.danger{border-color:var(--danger);color:var(--danger);}
.v2-dec .btn.link{border:0;padding:0;color:var(--muted);text-decoration:underline;cursor:pointer;background:none;}
.v2-dec .btn.link:hover{color:var(--text);}
.v2-dec .row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}
.v2-dec .grow{flex:1 1 auto;}
.v2-dec input,.v2-dec select,.v2-dec textarea{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 9px;width:100%;font:inherit;}
.v2-dec textarea{min-height:76px;resize:vertical;}
.v2-dec .f{display:block;margin:0 0 10px;}
.v2-dec .f-l{display:block;font-size:12px;color:var(--muted);margin-bottom:4px;}
.v2-dec dl.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 14px;margin:0;}
.v2-dec dl.kv dt{color:var(--muted);font-size:12.5px;}
.v2-dec dl.kv dd{margin:0;font-size:13px;overflow-wrap:anywhere;}
.v2-dec .ev{border:1px solid var(--border);border-radius:var(--radius);padding:10px 12px;margin-bottom:10px;}
.v2-dec .ev.uncited{opacity:.72;border-style:dashed;}
.v2-dec .ev.flash{border-color:var(--accent);}
.v2-dec .ev-top{display:flex;gap:8px;align-items:baseline;margin-bottom:6px;}
.v2-dec .ref{font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:5px;padding:0 5px;flex:0 0 auto;}
.v2-dec button.ref{background:transparent;cursor:pointer;}
.v2-dec button.ref:hover{color:var(--text);border-color:var(--muted);}
.v2-dec .ev-st{font-size:13.5px;}
.v2-dec .ev-num{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin-top:8px;font-size:12.5px;color:var(--muted);}
.v2-dec .ev-num b{color:var(--text);font-weight:600;}
.v2-dec .spark{margin-top:8px;}
.v2-dec .hyp{border-left:2px solid var(--border);padding-left:10px;margin-bottom:12px;}
.v2-dec .tl{display:flex;flex-direction:column;gap:9px;max-height:360px;overflow-y:auto;}
.v2-dec .tl-row{display:grid;grid-template-columns:96px 1fr;gap:10px;font-size:13px;}
.v2-dec .tl-row .when{color:var(--muted);font-size:12px;}
.v2-dec .tl-row .who{color:var(--muted);font-size:11.5px;}
.v2-dec pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 10px;margin:8px 0 0;font-size:12.5px;}
.v2-dec details{margin-top:8px;}
.v2-dec summary{cursor:pointer;color:var(--muted);font-size:12.5px;}
.v2-dec .skel{height:60px;border:1px solid var(--border);border-radius:var(--radius);background:var(--panel);margin-bottom:12px;}
.v2-dec .notice{border:1px solid var(--warn);border-radius:var(--radius);padding:10px 12px;font-size:13px;}
.v2-dec .overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:18px;z-index:60;}
.v2-dec .dialog{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:16px 18px;width:min(520px,100%);max-height:88vh;overflow-y:auto;}
.v2-dec .dialog h3{margin:0 0 10px;font-size:15px;}
.v2-dec .dialog-acts{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:12px;}
.v2-dec .toasts{position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;gap:8px;z-index:70;}
.v2-dec .toast{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;max-width:340px;}
.v2-dec .toast.good{border-color:var(--accent);}
.v2-dec .toast.bad{border-color:var(--danger);}
`;

/* ── entry point ────────────────────────────────────────────────────────── */

export async function render(root, ctx) {
  root.replaceChildren();
  const style = el("style");
  style.textContent = STYLE;
  const host = el("div", "v2-dec");
  root.append(style, host);

  const toasts = el("div", "toasts");
  host.append(toasts);
  const toast = (message, kind = "") => {
    const t = el("div", `toast ${kind}`, message);
    toasts.append(t);
    setTimeout(() => t.remove(), 5200);
  };

  const body = el("div");
  host.append(body);

  const go = (route) => {
    if (typeof ctx?.go === "function") ctx.go(route);
  };

  // A body always means a mutation, and the dispatcher only parses a body on
  // POST/PATCH/PUT/DELETE — a GET would hand the handler {} and the write would
  // silently do nothing. So the method is pinned here rather than left to the
  // shell's default.
  const call = async (name, opts = {}) => {
    try {
      const out = await ctx.api(name, opts.body !== undefined ? { method: "POST", ...opts } : opts);
      if (out && typeof out === "object") return out;
      return { ok: false, error: `${name} returned nothing` };
    } catch (err) {
      return { ok: false, error: `${name} could not be reached${err?.message ? `: ${err.message}` : ""}` };
    }
  };

  // ctx.fmt belongs to the shell. It is called defensively because this page and
  // that shell are separate files: a missing or throwing formatter must degrade
  // to the raw value, never blank the field it was meant to describe.
  const when = (iso) => {
    if (!iso) return "";
    try {
      return ctx?.fmt?.date?.(iso) ?? new Date(iso).toLocaleString();
    } catch {
      return String(iso);
    }
  };

  const money = (n) => {
    if (n == null || n === "") return null;
    try {
      return ctx?.fmt?.money?.(n) ?? String(n);
    } catch {
      return String(n);
    }
  };

  const refresh = () => render(root, ctx);

  /* ── dialogs, scoped to this page's own root ──────────────────────────── */

  const openDialog = (heading) => {
    const overlay = el("div", "overlay");
    const box = el("div", "dialog");
    box.append(el("h3", null, heading));
    overlay.append(box);
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    host.append(overlay);
    return {
      box,
      close: () => overlay.remove(),
      acts(primaryLabel, onPrimary) {
        const row = el("div", "dialog-acts");
        row.append(button("Cancel", "btn", () => overlay.remove()));
        const p = button(primaryLabel, "btn primary", async () => {
          p.disabled = true;
          try {
            await onPrimary();
          } finally {
            p.disabled = false;
          }
        });
        row.append(p);
        box.append(row);
        return p;
      },
    };
  };

  /* ── which decision? ──────────────────────────────────────────────────── */

  // The module contract fixes render(root, ctx) and does not say where a route
  // parameter arrives, so every plausible carrier is tried before falling back
  // to the address bar. Reading the URL is the one source that cannot be wrong.
  const id = idFor(ctx);
  if (!id) {
    body.append(
      errorPanel("No decision was chosen", "This page needs a decision id in the route, for example decisions/d1.", "Back to decisions", () =>
        go("decisions"),
      ),
    );
    return;
  }

  /* ── load ─────────────────────────────────────────────────────────────── */

  body.append(el("div", "skel"), el("div", "skel"), el("div", "skel"));

  // decisionsRules is fetched alongside the decision purely to give the rail the
  // full band ladder for each signal — "notable at -25%, significant at -40%".
  // It is optional: if it fails the rail still shows the single threshold that
  // decisionsGet already carries.
  const [r, rulesRes] = await Promise.all([call("decisionsGet", { query: { id } }), call("decisionsRules")]);
  await chartsReady;

  body.replaceChildren();

  if (!r.ok) {
    if (r.needsWorkspace) {
      body.append(
        errorPanel(
          "No workspace is open",
          "Create or choose a workspace before opening a decision. Nothing can be read until then.",
          "Back to decisions",
          () => go("decisions"),
        ),
      );
      return;
    }
    body.append(errorPanel("This decision could not be loaded", r.error ?? "The server gave no reason.", "Try again", refresh));
    return;
  }

  const d = r.decision;
  const ruleSignals = rulesRes?.ok ? (rulesRes.rules?.signals ?? {}) : {};
  const statusLabels = r.statusLabels ?? {};
  const allSignals = Array.isArray(r.allSignals) ? r.allSignals : [];
  const cited = Array.isArray(r.evidence) ? r.evidence : [];

  // A stable reference for each signal, assigned in rail order. The hypotheses
  // on the left cite raw signal ids; these refs are what turn an id into
  // something a person can find on the page. Built up here, before anything is
  // drawn, because the left column reads it before the rail is built.
  const refOf = new Map();
  allSignals.forEach((s, i) => refOf.set(s.id, `E${i + 1}`));
  cited.forEach((e, i) => {
    if (!refOf.has(e.signal_id)) refOf.set(e.signal_id, `C${i + 1}`);
  });

  function evidenceRef(signalId) {
    const label = refOf.get(signalId) ?? signalId;
    return button(label, "ref", () => {
      const target = host.querySelector(`[data-sig="${cssEscape(signalId)}"]`);
      if (!target) return toast("That signal is not on this page.", "bad");
      // An uncited signal lives inside a collapsed <details>; scrolling to a
      // hidden element would look like the button did nothing.
      const folded = target.closest("details");
      if (folded) folded.open = true;
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.classList.add("flash");
      setTimeout(() => target.classList.remove("flash"), 1600);
    });
  }

  /* ── header ───────────────────────────────────────────────────────────── */

  const crumbs = el("div", "crumbs");
  crumbs.append(button("Decisions", "btn link", () => go("decisions")));
  crumbs.append(el("span", null, "/"));
  if (d.accountId) {
    crumbs.append(button(d.accountName, "btn link", () => go(`customers/${d.accountId}`)));
  } else {
    // accountName is the literal "Company-wide" for a cohort decision; there is
    // no customer page to link to, so it is plain text.
    crumbs.append(el("span", null, d.accountName));
  }
  body.append(crumbs);
  body.append(el("h1", null, d.title));

  const chips = el("div", "chips");
  chips.append(el("span", `chip sev-${d.severity}`, d.severity));
  chips.append(el("span", "chip", d.statusLabel ?? statusLabels[d.status] ?? d.status));
  if (d.kind) chips.append(el("span", "chip", d.kind.replace(/_/g, " ")));
  if (d.overdueDays != null) chips.append(el("span", "chip bad", `${d.overdueDays} day${d.overdueDays === 1 ? "" : "s"} overdue`));
  if (d.snoozedUntil) chips.append(el("span", "chip", `back on ${d.snoozedUntil}`));
  if (d.signalsEased) chips.append(el("span", "chip warn", "the signals have eased"));
  if (d.ruleOnly) chips.append(el("span", "chip warn", "no model brief"));
  if (d.ageDays != null) chips.append(el("span", "chip", d.ageDays === 0 ? "raised today" : `raised ${d.ageDays} days ago`));
  if (r.asOf) chips.append(el("span", "chip", `as of ${r.asOf}`));
  body.append(chips);

  const cols = el("div", "cols");
  const main = el("div", "col");
  const rail = el("div", "col");
  cols.append(main, rail);
  body.append(cols);

  /* ══ LEFT: what the system says ═══════════════════════════════════════ */

  // 1. Provenance, before anything the model wrote. A reader must know which
  //    sentences on this page were computed and which were generated, and must
  //    know it before reading them rather than after.
  const prov = panel("How this brief was made");
  const pdl = el("dl", "kv");
  kv(pdl, "Figures", "computed from your imported data");
  kv(
    pdl,
    "Words",
    d.reasoningSource === "model" ? "written by a model" : d.reasoningSource === "rule_only" ? "not written — the rules only" : (d.reasoningSource ?? "unknown"),
  );
  if (d.model) kv(pdl, "Model", d.model);
  if (d.confidence) kv(pdl, "Model confidence", d.confidence);
  kv(pdl, "Evidence cited", `${cited.length} of ${allSignals.length || cited.length} signal${(allSignals.length || cited.length) === 1 ? "" : "s"}`);
  prov.append(pdl);
  if (d.reasoningSource !== "model") {
    const n = el("div", "notice");
    n.append(
      el(
        "p",
        null,
        d.reasoningError
          ? `No model brief was written for this decision: ${d.reasoningError}`
          : "No model brief was written for this decision. The rules raised it and every number below is still computed from your data.",
      ),
    );
    n.append(button("Ask the model again", "btn", (e) => rereason(e.currentTarget)));
    prov.append(n);
  } else {
    prov.append(button("Ask the model again", "btn", (e) => rereason(e.currentTarget)));
  }
  main.append(prov);

  async function rereason(btn) {
    btn.disabled = true;
    btn.textContent = "Asking…";
    const out = await call("decisionsRereason", { body: { id } });
    // decisionsRereason returns only { ok, model } — the new prose is not in the
    // response, so the page must be re-fetched rather than patched.
    if (!out.ok) {
      toast(out.error, "bad");
      btn.disabled = false;
      btn.textContent = "Ask the model again";
      return;
    }
    toast("The brief was rewritten.", "good");
    refresh();
  }

  // 2. The reasoning.
  const why = panel("Why this matters");
  if (d.whyItMatters) {
    why.append(el("p", null, d.whyItMatters));
  } else {
    why.append(el("p", "hint", "Nothing was written for this decision. The evidence on the right still stands on its own."));
  }
  main.append(why);

  if (r.hypotheses?.length) {
    const hyp = panel("What might be causing it", "These are guesses, not findings. Each one names the signals it rests on; click a reference to jump to it.");
    for (const h of r.hypotheses) {
      const box = el("div", "hyp");
      box.append(el("div", "chip", `${h.confidence ?? "unknown"} confidence`));
      box.append(el("p", null, h.text));
      if (h.evidence?.length) {
        const refs = el("div", "row");
        refs.append(el("span", "hint", "rests on"));
        for (const sid of h.evidence) refs.append(evidenceRef(sid));
        box.append(refs);
      }
      hyp.append(box);
    }
    main.append(hyp);
  }

  // 3. The recommended action, and the two things the app can actually prepare.
  const rec = panel("Recommended action");
  rec.append(el("p", null, d.recommendation ?? "No action was recommended."));
  if (d.rationale) rec.append(el("p", "hint", d.rationale));
  if (r.businessContext) {
    const det = el("details");
    det.append(el("summary", null, "The business context the model was given"));
    det.append(el("p", "hint", r.businessContext));
    rec.append(det);
  }
  const recActs = el("div", "row");
  recActs.append(button("Draft an email", "btn primary", () => draftDialog(false)));
  recActs.append(button("Create a task", "btn", () => taskDialog()));
  rec.append(recActs);
  rec.append(el("div", "hint", "This app never sends anything. A draft is written here for you to send yourself."));
  main.append(rec);

  // 4. Actions already prepared against this decision.
  const actsPanel = panel("Prepared actions");
  if (r.actions?.length) {
    for (const a of r.actions) {
      const box = el("div", "ev");
      const top = el("div", "row");
      top.append(el("b", null, a.kind === "draft_email" ? "Email draft" : "Task"));
      top.append(el("span", `chip${a.status === "done" ? " on" : ""}`, a.status));
      top.append(el("span", "grow"));
      if (a.status === "prepared") {
        if (a.kind === "draft_email") top.append(button("Open", "btn", () => showDraft(a)));
        top.append(button("Mark done", "btn", () => updateAction(a.id, "done")));
        top.append(button("Cancel", "btn danger", () => updateAction(a.id, "cancelled")));
      }
      box.append(top);
      const p = a.payload ?? {};
      box.append(
        el(
          "pre",
          null,
          a.kind === "draft_email"
            ? `${p.subject ?? ""}\n\n${p.body ?? ""}`
            : [p.title ?? "", p.owner ? `Owner: ${p.owner}` : "", p.dueAt ? `By: ${p.dueAt}` : "", p.note ?? ""].filter(Boolean).join("\n"),
        ),
      );
      actsPanel.append(box);
    }
  } else {
    actsPanel.append(el("p", "hint", "Nothing prepared yet."));
  }
  main.append(actsPanel);

  // 5. The state machine, drawn from decision.allowedNext only. A button that
  //    the engine would refuse is never painted — the API is the source of
  //    truth about what can happen next, not this file.
  const moves = panel("Move this decision on");
  const moveRow = el("div", "row");
  const reopenable = d.status === "resolved" || d.status === "dismissed";
  for (const next of d.allowedNext ?? []) {
    // A resolved or dismissed decision offers exactly one move — back to
    // accepted — and decisionsReopen is the route that performs it. Drawing
    // both would be two buttons doing one thing.
    if (reopenable && next === "accepted") continue;
    if (next === "snoozed") {
      moveRow.append(button("Snooze", "btn", () => snoozeDialog()));
    } else if (next === "dismissed") {
      moveRow.append(button("Dismiss", "btn danger", () => dismissDialog()));
    } else if (next === "resolved") {
      moveRow.append(button("Resolve with an outcome", "btn", () => resolveDialog()));
    } else {
      moveRow.append(
        button(NEXT_LABEL[next] ?? next, next === "accepted" ? "btn primary" : "btn", async (e) => {
          const b = e.currentTarget;
          b.disabled = true;
          const out = await call("decisionsUpdate", { body: { id, status: next } });
          // The mutation routes answer with the RAW sqlite row (due_at, not
          // dueAt). Nothing is read off it here on purpose; the page re-fetches
          // so every field on screen keeps one shape.
          if (!out.ok) {
            b.disabled = false;
            return toast(out.allowed?.length ? `${out.error} (allowed: ${out.allowed.join(", ")})` : out.error, "bad");
          }
          toast(next === "accepted" ? "Accepted. A due date was suggested for you." : "Moved.", "good");
          refresh();
        }),
      );
    }
  }
  if (reopenable) {
    moveRow.append(
      button("Reopen", "btn primary", async (e) => {
        e.currentTarget.disabled = true;
        const out = await call("decisionsReopen", { body: { id } });
        if (!out.ok) return toast(out.error, "bad");
        toast("Reopened.", "good");
        refresh();
      }),
    );
  }
  if (!moveRow.childElementCount) moveRow.append(el("span", "hint", "There is nowhere for this decision to move from here."));
  moves.append(moveRow);

  const ownerSel = select([["", "Nobody yet"], ...(r.owners ?? []).map((o) => [o, o])], d.owner ?? "");
  ownerSel.onchange = async () => {
    const out = await call("decisionsUpdate", { body: { id, owner: ownerSel.value } });
    toast(out.ok ? "Owner saved." : out.error, out.ok ? "good" : "bad");
  };
  field(moves, "Owner", ownerSel, (r.owners ?? []).length ? null : "There are no owners yet. Add names in Settings.");

  const dueIn = Object.assign(el("input"), { type: "date", value: d.dueAt ?? "" });
  dueIn.onchange = async () => {
    const out = await call("decisionsUpdate", { body: { id, dueAt: dueIn.value } });
    toast(out.ok ? "Date saved." : out.error, out.ok ? "good" : "bad");
  };
  field(moves, "Handle it by", dueIn);
  main.append(moves);

  // 6. The trail. Everything that ever happened to this decision, plus a note.
  const hist = panel("History");
  if (r.events?.length) {
    const tl = el("div", "tl");
    for (const e of r.events) {
      const row = el("div", "tl-row");
      row.append(el("div", "when", when(e.at)));
      const what = el("div");
      what.append(el("div", null, describeEvent(e)));
      what.append(el("div", "who", e.actor === "system" ? "by the system" : "by you"));
      row.append(what);
      tl.append(row);
    }
    hist.append(tl);
  } else {
    hist.append(el("p", "hint", "Nothing has happened to this decision yet."));
  }
  const noteRow = el("div", "row");
  noteRow.style.marginTop = "10px";
  const noteIn = Object.assign(el("input"), { type: "text", placeholder: "Add a note…" });
  noteIn.style.flex = "1 1 200px";
  const addNote = async () => {
    const out = await call("decisionsNote", { body: { id, text: noteIn.value } });
    // decisionsNote returns { ok:true } and nothing else, so the timeline can
    // only be refreshed by re-reading it.
    if (!out.ok) return toast(out.error, "bad");
    refresh();
  };
  noteIn.onkeydown = (e) => {
    if (e.key === "Enter") addNote();
  };
  noteRow.append(noteIn, button("Add note", "btn", addNote));
  hist.append(noteRow);
  main.append(hist);

  /* ══ RIGHT: the evidence rail ═════════════════════════════════════════ */

  const coverage = panel("Evidence");
  coverage.append(
    el(
      "p",
      "hint",
      allSignals.length
        ? "Every signal computed for this customer in the last analysis. The solid ones are what the recommendation used; the rest are shown so you can see what was passed over."
        : "The cited statements for this decision.",
    ),
  );
  if (allSignals.length) {
    const filled = allSignals.filter((s) => s.cited).length;
    const caption = `${filled} of ${allSignals.length} signals cited`;
    const grid = chartOrText(() => charts.dotGrid({ filled, total: allSignals.length, caption }), caption);
    if (grid) coverage.append(grid);
  } else if (!d.accountId) {
    coverage.append(el("p", "hint", "This decision is company-wide, so there are no per-customer signals behind it."));
  } else {
    // An account with no signals means the run that raised this has been
    // replaced by a later one. Say that, rather than leave a silent gap where
    // the coverage figure should be.
    coverage.append(el("p", "hint", "The latest analysis holds no signals for this customer, so the cited statements below cannot be checked against their source."));
  }
  rail.append(coverage);

  // Cited first, in rank order, because these are the sentences the
  // recommendation actually rests on.
  const citedPanel = panel("Cited");
  if (cited.length) {
    for (const e of cited) citedPanel.append(evidenceCard(e.statement, allSignals.find((s) => s.id === e.signal_id) ?? null, e.signal_id, false));
  } else {
    citedPanel.append(el("p", "hint", "No evidence was recorded against this decision. That is unusual — treat the recommendation above with care."));
  }
  rail.append(citedPanel);

  const uncited = allSignals.filter((s) => !s.cited);
  if (uncited.length) {
    const others = panel("Looked at, not used");
    const det = el("details");
    det.append(el("summary", null, `${uncited.length} other signal${uncited.length === 1 ? "" : "s"} on this customer`));
    for (const s of uncited) det.append(evidenceCard(s.statement, s, s.id, true));
    others.append(det);
    rail.append(others);
  }

  // The customer's own figures, so the money on the left can be checked against
  // the row it was computed from.
  const impact = panel("Money at stake");
  const idl = el("dl", "kv");
  kv(idl, "Estimate", d.impactLabel ?? "not estimated");
  kv(idl, "How it was worked out", d.impactBasis);
  if (d.currency) kv(idl, "Currency", d.currency);
  impact.append(idl);
  impact.append(el("div", "hint", "Taken from your imported data. It is an amount at stake, not a forecast."));
  rail.append(impact);

  if (r.account) {
    const a = r.account;
    const cust = panel("The customer");
    const cdl = el("dl", "kv");
    // The account row keeps its raw sqlite column names — renewal_date, not
    // renewalDate. Reading the camelCase spelling here would render undefined.
    kv(cdl, "Name", a.name);
    // decisionsGet.account carries the raw `arr` number and no arrLabel — that
    // pre-formatted field belongs to decisionsCustomer. A bare 50000 on screen
    // is the kind of unqualified figure this page exists to avoid.
    kv(cdl, "ARR", money(a.arr));
    kv(cdl, "Plan", a.plan);
    kv(cdl, "Seats bought", a.seats_purchased);
    kv(cdl, "Renewal", a.renewal_date ? `${a.renewal_date}${a.daysToRenewal != null ? ` (${a.daysToRenewal} days)` : ""}` : null);
    kv(cdl, "Customer since", a.created_at ? `${a.created_at}${a.tenureDays != null ? ` (${a.tenureDays} days)` : ""}` : null);
    kv(cdl, "Owner", a.owner);
    kv(cdl, "Segment", a.segment);
    cust.append(cdl);
    if (a.contacts?.length) {
      const det = el("details");
      det.append(el("summary", null, `${a.contacts.length} contact${a.contacts.length === 1 ? "" : "s"}`));
      for (const c of a.contacts) {
        det.append(el("div", "hint", `${c.name}${c.role ? ` — ${c.role}` : ""}${c.is_champion ? " (champion)" : ""}${c.last_active_at ? ` — last seen ${c.last_active_at}` : ""}`));
      }
      cust.append(det);
    }
    cust.append(button("Open this customer", "btn", () => go(`customers/${a.id}`)));
    rail.append(cust);
  }

  if (r.outcome) {
    const out = panel("Outcome");
    out.append(el("p", null, `${r.outcomes?.[r.outcome.result] ?? r.outcome.result}${r.outcome.note ? ` — ${r.outcome.note}` : ""}`));
    if (r.outcome.arr_after != null) out.append(el("div", "hint", `Their ARR afterwards: ${money(r.outcome.arr_after)}`));
    out.append(el("div", "hint", `Recorded ${when(r.outcome.recorded_at)}.`));
    rail.append(out);
  }

  /* ── an evidence card ─────────────────────────────────────────────────── */

  // The trust argument in one function. A statement alone is a claim; a
  // statement next to its reading, its baseline, the threshold that fired and
  // the band ladder it was judged on is something an operator can check.
  function evidenceCard(statement, signal, signalId, isUncited) {
    const card = el("div", `ev${isUncited ? " uncited" : ""}`);
    if (signalId) card.dataset.sig = signalId;

    const top = el("div", "ev-top");
    top.append(el("span", "ref", refOf.get(signalId) ?? "—"));
    top.append(el("div", "ev-st", statement));
    card.append(top);

    if (!signal) {
      // Cited evidence whose signal is gone: the run that produced it has been
      // replaced. Say so rather than showing a statement with no backing.
      card.append(el("div", "hint", "The signal behind this statement is not in the latest analysis."));
      return card;
    }

    const unit = SIGNAL_UNIT[signal.kind] ?? "";
    const nums = el("div", "ev-num");
    const pair = (k, v) => {
      if (v == null || v === "") return;
      nums.append(el("span", null, k));
      const b = el("span");
      b.append(el("b", null, String(v)));
      nums.append(b);
    };
    pair("signal", signal.label ?? signal.kind);
    if (signal.band != null) pair("severity band", `${BAND_WORD[signal.band] ?? signal.band} (${signal.band} of 3)`);
    if (Number.isFinite(signal.value)) pair("reading now", round(signal.value));
    if (Number.isFinite(signal.baseline)) pair("baseline", round(signal.baseline));
    if (Number.isFinite(signal.change_pct)) pair("change", `${round(signal.change_pct)}%`);
    if (signal.window_days != null) pair("window", `${signal.window_days} days`);
    // decisionsGet sends the signal's FIRST band, which is the lowest rung the
    // rule reacts to at all — not the rung this reading landed on. The label
    // has to say that, or it reads as "this is why it fired" and overstates.
    if (signal.threshold != null) pair("rule starts flagging at", `${signal.threshold}${unit}`);
    if (signal.direction) pair("direction", signal.direction);
    card.append(nums);

    // The band ladder shows the whole scale the number was judged against, not
    // just the rung it landed on. Only available when decisionsRules loaded.
    const bands = ruleSignals[signal.kind]?.bands;
    if (Array.isArray(bands)) {
      const ladder = bands
        .map((b, i) => (b == null ? null : `${BAND_WORD[i + 1]} at ${b}${unit}`))
        .filter(Boolean)
        .join(" · ");
      if (ladder) card.append(el("div", "hint", `the rule's scale: ${ladder}`));
    }

    // Two readings is not a trend, and drawing it as one would be exactly the
    // plausible-looking wrong picture this page exists to avoid. The caption
    // says what the two points are, and the same numbers are printed above.
    if (Number.isFinite(signal.baseline) && Number.isFinite(signal.value)) {
      const spark = chartOrText(() => charts.sparkline({ values: [signal.baseline, signal.value] }), "");
      if (spark) {
        const box = el("div", "spark");
        box.append(spark);
        box.append(el("div", "hint", `two readings only: baseline ${round(signal.baseline)} → now ${round(signal.value)}`));
        card.append(box);
      }
    }

    if (signal.detail && Object.keys(signal.detail).length) {
      const det = el("details");
      det.append(el("summary", null, "raw detail"));
      det.append(el("pre", null, safeJson(signal.detail)));
      card.append(det);
    }
    return card;
  }

  /* ── the dialogs ──────────────────────────────────────────────────────── */

  function snoozeDialog() {
    const dlg = openDialog("Snooze this decision");
    dlg.box.append(el("p", "hint", "It comes back on the date you choose, and earlier if the situation gets worse."));
    // The engine's own clock, not the browser's — the workspace can be pinned to
    // a demo date, and a snooze picked from the wrong "today" lands wrong.
    const today = r.asOf ?? new Date().toISOString().slice(0, 10);
    const plus = (n) => {
      const x = new Date(`${today}T00:00:00Z`);
      x.setUTCDate(x.getUTCDate() + n);
      return x.toISOString().slice(0, 10);
    };
    const whenIn = field(dlg.box, "Bring it back on", Object.assign(el("input"), { type: "date", value: plus(7) }));
    const quick = el("div", "row");
    for (const [label, days] of [
      ["In 3 days", 3],
      ["In a week", 7],
      ["In a month", 30],
    ]) {
      quick.append(button(label, "btn", () => (whenIn.value = plus(days))));
    }
    dlg.box.append(quick);
    dlg.acts("Snooze", async () => {
      const out = await call("decisionsSnooze", { body: { id, until: whenIn.value } });
      if (!out.ok) return toast(out.allowed?.length ? `${out.error} (allowed: ${out.allowed.join(", ")})` : out.error, "bad");
      dlg.close();
      toast(`Snoozed until ${whenIn.value}.`, "good");
      refresh();
    });
  }

  function dismissDialog() {
    const dlg = openDialog("Dismiss this decision");
    dlg.box.append(el("p", "hint", "Your reason is kept and shown to the model next time, so it does not raise the same thing again."));
    const reason = field(dlg.box, "Why are you dismissing it?", el("textarea"));
    reason.placeholder = "We already know; they are mid-migration and it is expected.";
    dlg.acts("Dismiss", async () => {
      const out = await call("decisionsDismiss", { body: { id, reason: reason.value } });
      if (!out.ok) return toast(out.allowed?.length ? `${out.error} (allowed: ${out.allowed.join(", ")})` : out.error, "bad");
      dlg.close();
      toast("Dismissed.", "good");
      refresh();
    });
  }

  function resolveDialog() {
    const dlg = openDialog("Record what happened");
    dlg.box.append(el("p", "hint", "This is what makes the next decision better. Say what actually happened, not what you hoped."));
    const outcomes = r.outcomes ?? {};
    const result = field(dlg.box, "Outcome", select(Object.entries(outcomes), Object.keys(outcomes)[0] ?? ""));
    const note = field(dlg.box, "Notes (optional)", el("textarea"));
    const arr = field(dlg.box, "Their ARR now (optional)", Object.assign(el("input"), { type: "number" }));
    dlg.acts("Resolve", async () => {
      const out = await call("decisionsResolve", {
        body: { id, result: result.value, note: note.value, arrAfter: arr.value === "" ? null : Number(arr.value) },
      });
      if (!out.ok) return toast(out.allowed?.length ? `${out.error} (allowed: ${out.allowed.join(", ")})` : out.error, "bad");
      dlg.close();
      toast("Resolved. It is in the record now.", "good");
      refresh();
    });
  }

  function taskDialog() {
    const dlg = openDialog("Create a task");
    const t = field(dlg.box, "What needs doing?", Object.assign(el("input"), { type: "text", value: d.recommendation ?? "" }));
    const owner = field(dlg.box, "Who is doing it?", select([["", "Nobody yet"], ...(r.owners ?? []).map((o) => [o, o])], d.owner ?? ""));
    const due = field(dlg.box, "By when?", Object.assign(el("input"), { type: "date", value: d.dueAt ?? "" }));
    const note = field(dlg.box, "Notes (optional)", el("textarea"));
    dlg.box.append(el("div", "hint", "The task is kept in this decision's history. It is not sent to another system."));
    dlg.acts("Create task", async () => {
      const out = await call("decisionsActionPrepare", {
        body: { id, kind: "task", task: { title: t.value, owner: owner.value, dueAt: due.value, note: note.value } },
      });
      if (!out.ok) return toast(out.error, "bad");
      dlg.close();
      toast("Task created.", "good");
      refresh();
    });
  }

  async function draftDialog(force) {
    const dlg = openDialog("Draft an email");
    dlg.box.append(el("p", "hint", "Writing the draft. This asks the model and can take a few seconds…"));
    const out = await call("decisionsActionPrepare", { body: { id, kind: "draft_email", force } });
    if (!out.ok) {
      if (out.conflict) {
        // The cooldown guard: an email to this customer already exists. The
        // engine hands back which one, so the operator is offered the real
        // choice rather than a dead end.
        dlg.box.replaceChildren(el("h3", null, "There is already an email for this customer"));
        dlg.box.append(el("p", "hint", out.error));
        const row = el("div", "dialog-acts");
        row.append(button("Cancel", "btn", dlg.close));
        if (out.decisionId) {
          row.append(
            button("Open that decision", "btn", () => {
              dlg.close();
              go(`decisions/${out.decisionId}`);
            }),
          );
        }
        row.append(
          button("Write one anyway", "btn primary", () => {
            dlg.close();
            draftDialog(true);
          }),
        );
        dlg.box.append(row);
        return;
      }
      dlg.close();
      return toast(out.error, "bad");
    }
    dlg.close();
    showDraft(out.action);
  }

  function showDraft(action) {
    const dlg = openDialog("Draft an email");
    const p = action.payload ?? {};
    dlg.box.append(
      el(
        "p",
        "hint",
        p.source === "template"
          ? "The model was not available, so this is the standard wording. Read it before you send it."
          : "Written by the model from this decision only. Read it before you send it.",
      ),
    );
    const to = field(dlg.box, "To", Object.assign(el("input"), { type: "text", value: p.to ?? "", placeholder: "their email address" }));
    const subject = field(dlg.box, "Subject", Object.assign(el("input"), { type: "text", value: p.subject ?? "" }));
    const bodyIn = field(dlg.box, "Message", el("textarea"));
    bodyIn.value = p.body ?? "";
    bodyIn.style.minHeight = "200px";

    const save = (status) =>
      call("decisionsActionUpdate", {
        body: { actionId: action.id, status, payload: { to: to.value, subject: subject.value, body: bodyIn.value } },
      });

    const row = el("div", "dialog-acts");
    row.append(
      button("Copy", "btn", async () => {
        try {
          await navigator.clipboard.writeText(`${subject.value}\n\n${bodyIn.value}`);
        } catch {
          return toast("This window would not let the text be copied.", "bad");
        }
        await save("prepared");
        toast("Copied.");
      }),
    );
    row.append(
      button("Open in my mail app", "btn", async () => {
        await save("prepared");
        location.href = `mailto:${encodeURIComponent(to.value)}?subject=${encodeURIComponent(subject.value)}&body=${encodeURIComponent(bodyIn.value)}`;
      }),
    );
    row.append(
      button("Mark as sent", "btn primary", async () => {
        const out = await save("done");
        if (!out.ok) return toast(out.error, "bad");
        dlg.close();
        toast("Marked as sent.", "good");
        refresh();
      }),
    );
    dlg.box.append(row);
    dlg.box.append(el("div", "hint", "Nothing here sends an email. This app has no way to send one."));
  }

  async function updateAction(actionId, status) {
    const out = await call("decisionsActionUpdate", { body: { actionId, status } });
    if (!out.ok) return toast(out.error, "bad");
    refresh();
  }

  /* ── small bits used above ────────────────────────────────────────────── */

  function errorPanel(heading, message, ctaLabel, onCta) {
    const p = panel(heading);
    p.append(el("p", null, message));
    if (ctaLabel) p.append(button(ctaLabel, "btn primary", onCta));
    return p;
  }

  // A chart is a nicety; the number beside it is the product. If the charts
  // module did not load, or throws on this input, the text line stands alone.
  function chartOrText(build, fallbackText) {
    const wrap = el("div");
    let svg = null;
    if (charts) {
      try {
        svg = build();
      } catch {
        svg = null;
      }
    }
    if (svg instanceof Element) wrap.append(svg);
    if (fallbackText) wrap.append(el("div", "hint", fallbackText));
    return wrap.childElementCount ? wrap : null;
  }
}

/* ── module-level helpers ───────────────────────────────────────────────── */

// The shell may hand the route parameter over on ctx in one of several shapes,
// or not at all. The address bar is checked last because it is the only source
// that is always right, whatever the router chose to pass.
function idFor(ctx) {
  const direct =
    ctx?.params?.id ?? ctx?.param ?? ctx?.state?.decisionId ?? ctx?.state?.params?.id ?? ctx?.state?.route?.id ?? ctx?.id ?? null;
  if (typeof direct === "string" && direct) return direct;

  const path = `${location.hash || ""} ${location.pathname || ""}`;
  const m = path.match(/decisions?\/([^/?#\s]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function round(n) {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function safeJson(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// CSS.escape is not guaranteed in every embedded webview this ships into, and a
// signal id is attacker-adjacent data (it comes from imported files).
function cssEscape(value) {
  const s = String(value);
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(s) : s.replace(/["\\]/g, "\\$&");
}
