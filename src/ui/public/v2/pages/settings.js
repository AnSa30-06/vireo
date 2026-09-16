// Settings — thresholds, business definitions, the demo clock and privacy.
//
// This screen is where the product's claim is either true or a slogan: the
// engine runs on definitions a person set, not on a black box. So every number
// the engine actually uses is on this page, each one next to the value it
// SHIPPED with, so a user can see what they changed and put it back.
//
// Four routes, and nothing else exists:
//   decisionsSettingsGet    settings, the 3 editable thresholds, limits, asOf
//   decisionsRules          the whole rules.json — the other 8 signals, the
//                           situations, the severity ladder (all read-only)
//   decisionsSettingsSet    the ONLY writer. It accepts exactly seven keys
//   decisionsClockAdvance   the ONLY clock control, and it only moves forward
//
// Everything this page cannot change is shown read-only and SAID to be
// read-only. Drawing an input over a field the API ignores would be a lie that
// only shows up as "I saved it and it did nothing".
//
// 🔴 Nothing here uses innerHTML. Business definitions and owner names are text
// a person typed and the threshold labels come from a config file; all of it
// goes in with textContent.

export const title = "Settings";

/* ── tiny DOM helpers ───────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, cls, onClick) {
  const b = el("button", `sx-btn ${cls ?? ""}`.trim(), label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

function input(type, value, attrs) {
  const n = el("input", "sx-input");
  n.type = type;
  if (value != null) n.value = String(value);
  for (const [k, v] of Object.entries(attrs ?? {})) n.setAttribute(k, String(v));
  return n;
}

/** A label + control pair. The label is a real <label>, so the hit area works. */
function labelled(text, control) {
  const wrap = el("label", "sx-field");
  wrap.append(el("span", "sx-field-t", text), control);
  return wrap;
}

function dateText(ctx, iso) {
  if (!iso) return "";
  const f = ctx.fmt?.date;
  if (typeof f === "function") {
    const out = f(iso);
    if (out) return String(out);
  }
  return String(iso);
}

/* ── dates ──────────────────────────────────────────────────────────────── */

// The server's own "what day is it" is `new Date().toISOString().slice(0,10)`
// (run.mjs asOfFor). Matching it exactly matters: a locale-formatted date here
// would disagree with the pinned one by a day near midnight and the banner
// would accuse a healthy install of being pinned.
const realToday = () => new Date().toISOString().slice(0, 10);

const DAY = 86400000;

/** Whole days from one YYYY-MM-DD to another. Null if either will not parse. */
function daysApart(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / DAY);
}

function addDays(iso, n) {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t)) return String(iso);
  return new Date(t + n * DAY).toISOString().slice(0, 10);
}

/* ── business definitions: the record format ────────────────────────────── */
//
// THE ONE PLACE THIS PAGE BENDS THE API. The brief wants definitions as
// separate records with their own edit history; the backend has exactly one
// field for them — settings.businessContext, a single string capped at
// limits.businessContextMaxChars — and there is no route that stores anything
// else. So the records are kept AS the string, one per line:
//
//     Enterprise account (set 2026-09-15): 50 seats or more on an annual plan.
//
// Two properties make this safe rather than clever. It round-trips (the page
// re-parses whatever the server hands back after a save, so a mangled record
// is visible immediately, not next week). And it stays readable prose, which
// is what the field is for: packet.mjs sends it to the model verbatim as
// `business_context` and prompts.mjs tells the model to use it for
// interpretation and never as a source of numbers.
//
// The stored text is shown on screen exactly as it will be stored. Nothing
// about this encoding is hidden from the person typing it.

const WITH_DATE = /^\s*(?:[-•*]\s+)?(.+?)\s*\(set (\d{4}-\d{2}-\d{2})\)\s*:\s*(.*)$/;
// A bare "Term: body" line, which is what an older free-text note looks like
// after someone wrote it in the old Settings screen. The term is kept short and
// full-stop-free so an ordinary sentence containing a colon is NOT torn in half
// and relabelled as a definition.
const PLAIN = /^\s*(?:[-•*]\s+)?([^:.!?]{1,48}?)\s*:\s*(\S.*)$/;

function parseDefinitions(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    const dated = WITH_DATE.exec(line);
    if (dated) {
      out.push({ term: dated[1].trim(), body: dated[3].trim(), changed: dated[2], dirty: false });
      continue;
    }
    const plain = PLAIN.exec(line);
    if (plain) {
      out.push({ term: plain[1].trim(), body: plain[2].trim(), changed: null, dirty: false });
      continue;
    }
    // Anything else survives as an unlabelled note. Text a person typed is
    // never dropped just because it does not fit the shape.
    out.push({ term: "", body: line.trim(), changed: null, dirty: false });
  }
  return out;
}

function serializeDefinitions(defs) {
  return defs
    .map((d) => {
      // A colon in the term, or the literal "(set ", would break the line on
      // the way back in. Neutralised here rather than rejected, so a save never
      // fails over punctuation.
      const term = String(d.term).replace(/[:\n]/g, " ").replace(/\(\s*set\s/gi, "(").trim();
      // One record is one line. A newline typed into the body would split the
      // record in two on re-read.
      const body = String(d.body).replace(/\s+/g, " ").trim();
      if (!term && !body) return "";
      if (!term) return body;
      return `${term}${d.changed ? ` (set ${d.changed})` : ""}: ${body}`;
    })
    .filter(Boolean)
    .join("\n");
}

/* ── thresholds ─────────────────────────────────────────────────────────── */

/**
 * Show a threshold as a magnitude, store it with the sign the engine needs.
 *
 * usage_drop_30d ships at -25, and signals.mjs fires it with `value <= band`.
 * Type 25 into a raw number box and the rule becomes "any change at or below
 * +25%", which fires on almost every account including ones that GREW. The
 * sign is not a user's problem, so the field asks for "falls by 25%" and the
 * sign is taken from the shipped default — generically, so a future rules.json
 * that flips a sign does not silently break this.
 */
const signOf = (shipped) => (Number(shipped) < 0 ? -1 : 1);

function unitText(n, unit) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return unit === "days" ? `${Math.abs(Number(n))} days` : `${Math.abs(Number(n))}%`;
}

// The verb each editable threshold reads best with. The API's own `help` string
// is shown underneath in full; this is only the line the input sits inside, and
// it is keyed on the id so an unknown id falls back to a neutral phrasing
// rather than to a wrong one.
const THRESHOLD_PHRASE = {
  usage_drop_30d: ["Counts as a signal when usage falls by at least", "over 30 days"],
  renewal_near: ["Counts as a signal when the renewal is within", "from today"],
  tickets_up_30d: ["Counts as a signal when support tickets rise by at least", "over 30 days"],
};

/* ── render ─────────────────────────────────────────────────────────────── */

export async function render(root, ctx) {
  root.replaceChildren(styles(), loadingBox());

  let got, rulesRes;
  try {
    // Two calls, in parallel, because neither needs the other's answer and the
    // page is unusable until both have been tried.
    [got, rulesRes] = await Promise.all([ctx.api("decisionsSettingsGet"), ctx.api("decisionsRules")]);
  } catch (err) {
    return root.replaceChildren(styles(), errorBox("Settings could not be loaded", err?.message ?? String(err), ctx));
  }

  if (!got?.ok) {
    if (got?.needsWorkspace) {
      return root.replaceChildren(
        styles(),
        emptyBox("No workspace is open", "Settings belong to one workspace. Choose or create one in the sidebar first."),
      );
    }
    return root.replaceChildren(
      styles(),
      errorBox("Settings could not be loaded", got?.error ?? "the server gave no reason", ctx),
    );
  }

  // Mutable page state. `S` is always the newest settings object the server has
  // confirmed — decisionsSettingsSet returns the full merged settings, so every
  // save replaces this rather than patching a local copy that could drift.
  const st = {
    S: got.settings ?? {},
    thresholdRows: Array.isArray(got.thresholds) ? got.thresholds : [],
    limits: got.limits ?? {},
    asOf: got.asOf ?? realToday(),
    workspace: got.workspace ?? null,
    dataDir: got.dataDir ?? "",
    // decisionsRules goes through withDb too, so it can fail on its own. When
    // it does, the editable half of the page still works and only the
    // read-only catalogue says why it is missing.
    rules: rulesRes?.ok ? rulesRes.rules : null,
    rulesError: rulesRes?.ok ? null : (rulesRes?.error ?? "the rules file could not be read"),
  };

  /** One save. Returns the new settings, or null after showing why not. */
  async function put(patch, note) {
    note.className = "sx-note";
    note.textContent = "Saving…";
    let r;
    try {
      r = await ctx.api("decisionsSettingsSet", { method: "POST", body: patch });
    } catch (err) {
      note.className = "sx-note sx-bad";
      note.textContent = `Not saved — ${err?.message ?? err}`;
      return null;
    }
    if (!r?.ok) {
      note.className = "sx-note sx-bad";
      note.textContent = `Not saved — ${r?.error ?? "the server refused the change"}`;
      return null;
    }
    st.S = r.settings ?? st.S;
    note.className = "sx-note sx-good";
    note.textContent = "Saved.";
    return st.S;
  }

  // Panels are rebuilt whole rather than patched in place. Each builder reads
  // st, so repainting one after a save cannot leave a stale number behind.
  const mounted = new Map();
  function mount(key, build) {
    const node = build();
    mounted.set(key, node);
    return node;
  }
  function repaint(key, build) {
    const old = mounted.get(key);
    if (!old?.isConnected) return;
    const next = build();
    mounted.set(key, next);
    old.replaceWith(next);
  }

  const wrap = el("div", "sx-wrap");
  wrap.append(mount("head", () => buildHead(st)));
  wrap.append(mount("clock", () => buildClock(ctx, st, put, repaint)));
  wrap.append(mount("thresholds", () => buildThresholds(ctx, st, put, repaint)));
  wrap.append(buildSignalCatalogue(st));
  wrap.append(buildSituations(st));
  wrap.append(mount("defs", () => buildDefinitions(ctx, st, put, repaint)));
  wrap.append(mount("privacy", () => buildPrivacy(st, put)));
  wrap.append(mount("owners", () => buildOwners(st, put, repaint)));
  wrap.append(buildLimits(st, put));
  wrap.append(buildWhere(st));

  root.replaceChildren(styles(), wrap);
}

/* ── the three states ───────────────────────────────────────────────────── */

function loadingBox() {
  const w = el("div", "sx-wrap");
  for (let i = 0; i < 4; i++) w.append(el("div", "skeleton block"));
  return w;
}

function emptyBox(heading, message) {
  const box = el("div", "empty sx-state");
  box.append(el("h3", null, heading));
  box.append(el("p", null, message));
  return box;
}

/** An error always carries the server's own words, unparaphrased. */
function errorBox(heading, message, ctx) {
  const box = el("div", "err sx-state");
  box.append(el("strong", null, heading));
  box.append(el("code", null, String(message)));
  if (ctx) box.append(button("Try again", "", () => ctx.go("#/settings")));
  return box;
}

function panel(heading, help) {
  const p = el("section", "sx-panel");
  const h = el("div", "sx-panel-h");
  h.append(el("h2", null, heading));
  p.append(h);
  if (help) p.append(el("p", "sx-help", help));
  return p;
}

/* ── head ───────────────────────────────────────────────────────────────── */

function buildHead(st) {
  const head = el("header", "sx-head");
  head.append(el("h1", null, "Settings"));
  const sub = el("p", "sx-sub");
  sub.append(document.createTextNode("Workspace "));
  sub.append(el("b", null, st.workspace?.name || "—"));
  sub.append(document.createTextNode(` · the app's date is ${st.asOf}`));
  head.append(sub);
  return head;
}

/* ── the demo clock ─────────────────────────────────────────────────────── */

/**
 * Demo mode and the clock.
 *
 * The server pins the date only when BOTH demo mode is on and a date has been
 * stored (run.mjs asOfFor). The clock route refuses outright unless demo mode
 * is on, and it only ever moves FORWARD, by 1 to 120 days. There is no route
 * that sets an arbitrary date, so the date box here converts the date a person
 * picks into that number of days and says so — it is the same call either way.
 */
function buildClock(ctx, st, put, repaint) {
  const on = !!st.S.demoMode;
  const today = realToday();
  const drifted = on && st.asOf !== today;

  const p = panel(
    "Demo clock",
    "Demo mode freezes the app's idea of today so a follow-up, a snooze or an overdue date can be seen without waiting for real time to pass.",
  );
  p.classList.add("sx-clock");
  if (drifted) p.classList.add("sx-pinned");

  // The warning the brief asks for, and it earns its loudness: a pinned clock
  // makes every date on every other screen look wrong, and the person who
  // pinned it a week ago has no reason to connect the two.
  if (drifted) {
    const warn = el("div", "sx-warn");
    warn.append(el("strong", null, "The clock is pinned."));
    warn.append(
      el(
        "span",
        null,
        `Ledgerline is treating ${st.asOf} as today. The real date is ${today}. Every due date, age and "days ago" on every screen is counted from the pinned date — nothing is broken.`,
      ),
    );
    p.append(warn);
  }

  const gap = daysApart(today, st.asOf);
  const now = el("div", "sx-now");
  now.append(el("div", "sx-now-k", "The app's today"));
  now.append(el("div", "sx-now-v", dateText(ctx, st.asOf)));
  now.append(
    el(
      "div",
      "sx-now-s",
      drifted && gap != null
        ? `${Math.abs(gap)} days ${gap > 0 ? "ahead of" : "behind"} the real date (${today})`
        : `Real date (${today})`,
    ),
  );
  p.append(now);

  const note = el("div", "sx-note");

  const toggle = input("checkbox");
  toggle.checked = on;
  toggle.className = "sx-check";
  toggle.onchange = async () => {
    toggle.disabled = true;
    const next = await put({ demoMode: toggle.checked }, note);
    toggle.disabled = false;
    if (!next) {
      toggle.checked = on; // the server said no; the switch must not claim otherwise
      return;
    }
    // Turning demo mode OFF hands the date back to the real clock; turning it
    // ON hands it back to whatever date was stored last, which may be months
    // old. Only a fresh read of asOf can say which, and only Settings/Status
    // return it — so re-read rather than guess.
    await refreshAsOf(ctx, st);
    await ctx.refresh?.();
    repaint("head", () => buildHead(st));
    repaint("clock", () => buildClock(ctx, st, put, repaint));
  };
  const row = el("div", "sx-row");
  const lab = el("label", "sx-switch");
  lab.append(toggle, el("span", null, "Demo mode is on"));
  row.append(lab);
  p.append(row);

  const controls = el("div", "sx-clock-ctl");
  if (!on) {
    controls.append(el("p", "sx-help", "The clock can only be moved while demo mode is on. That is the server's rule, not this screen's."));
  } else {
    const advance = async (days, btn) => {
      if (!Number.isFinite(days) || days < 1) {
        note.className = "sx-note sx-bad";
        note.textContent = "Pick a whole number of days, 1 or more.";
        return;
      }
      if (days > 120) {
        note.className = "sx-note sx-bad";
        note.textContent = `The clock moves at most 120 days at a time. That is ${days} days away — move it twice.`;
        return;
      }
      if (btn) btn.disabled = true;
      note.className = "sx-note";
      note.textContent = "Moving the clock…";
      let r;
      try {
        r = await ctx.api("decisionsClockAdvance", { method: "POST", body: { days } });
      } catch (err) {
        note.className = "sx-note sx-bad";
        note.textContent = `The clock did not move — ${err?.message ?? err}`;
        if (btn) btn.disabled = false;
        return;
      }
      if (btn) btn.disabled = false;
      if (!r?.ok) {
        note.className = "sx-note sx-bad";
        note.textContent = `The clock did not move — ${r.error ?? "the server refused"}`;
        return;
      }
      st.asOf = r.asOf ?? st.asOf;
      const f = r.followUp ?? {};
      note.className = "sx-note sx-good";
      note.textContent =
        `Today is now ${st.asOf}. ` +
        `${f.unsnoozed ?? 0} came back from snooze, ${f.overdue ?? 0} are overdue, ${f.waiting ?? 0} are waiting.`;
      await ctx.refresh?.();
      repaint("head", () => buildHead(st));
      // The clock panel is rebuilt last, and it takes the note's text with it
      // so the result of the move is still on screen after the repaint.
      repaint("clock", () => {
        const fresh = buildClock(ctx, st, put, repaint);
        const slot = fresh.querySelector(".sx-note");
        if (slot) {
          slot.className = note.className;
          slot.textContent = note.textContent;
        }
        return fresh;
      });
    };

    const quick = el("div", "sx-row");
    quick.append(el("span", "sx-inline-t", "Move forward"));
    for (const n of [1, 7, 30]) {
      const b = button(`+${n} ${n === 1 ? "day" : "days"}`, "", () => advance(n, b));
      quick.append(b);
    }
    controls.append(quick);

    const custom = el("div", "sx-row");
    const dayBox = input("number", "", { min: "1", max: "120", step: "1" });
    dayBox.classList.add("sx-num");
    const goDays = button("Move", "", () => advance(Math.round(Number(dayBox.value)), goDays));
    custom.append(el("span", "sx-inline-t", "Or move"), dayBox, el("span", "sx-inline-t", "days"), goDays);
    controls.append(custom);

    const pick = el("div", "sx-row");
    const dateBox = input("date", "", { min: addDays(st.asOf, 1), max: addDays(st.asOf, 120) });
    const goDate = button("Move to this date", "", () => {
      const days = daysApart(st.asOf, dateBox.value);
      if (days == null) {
        note.className = "sx-note sx-bad";
        note.textContent = "Pick a date first.";
        return;
      }
      if (days < 1) {
        note.className = "sx-note sx-bad";
        note.textContent = `The clock only moves forward. Pick a date after ${st.asOf}.`;
        return;
      }
      advance(days, goDate);
    });
    pick.append(el("span", "sx-inline-t", "Or set the date to"), dateBox, goDate);
    controls.append(pick);
    controls.append(
      el("p", "sx-help", "A date is turned into that many days forward, because moving forward is the only thing the server can do. The clock never goes back."),
    );
  }
  p.append(controls);
  p.append(note);
  return p;
}

/** Re-read asOf and settings after something outside this page changed them. */
async function refreshAsOf(ctx, st) {
  try {
    const r = await ctx.api("decisionsSettingsGet");
    if (r?.ok) {
      st.asOf = r.asOf ?? st.asOf;
      st.S = r.settings ?? st.S;
      if (Array.isArray(r.thresholds)) st.thresholdRows = r.thresholds;
    }
  } catch {
    // Not fatal: the panel simply keeps the date it already had. The next full
    // render corrects it, and the banner is computed from whatever is here.
  }
}

/* ── thresholds ─────────────────────────────────────────────────────────── */

function buildThresholds(ctx, st, put, repaint) {
  const p = panel(
    "Thresholds",
    "The numbers that decide when something counts as a signal at all. Three of them are yours to set; the rest ship with the app and are listed underneath.",
  );

  if (!st.thresholdRows.length) {
    p.append(emptyBox("No editable thresholds", "The rules file exposes none. Nothing on this screen can change that."));
    return p;
  }

  const note = el("div", "sx-note");
  const boxes = new Map();

  for (const row of st.thresholdRows) {
    const sign = signOf(row.shipped);
    const shippedMag = Math.abs(Number(row.shipped));
    // `current` already carries the override. Re-deriving it from st.S keeps
    // the row right after a save without a round trip to the list route.
    const override = st.S.thresholds?.[row.id];
    const currentMag = Math.abs(Number(Number.isFinite(Number(override)) ? override : row.current));

    const item = el("div", "sx-th");
    const top = el("div", "sx-th-top");
    top.append(el("b", null, row.label ?? row.id));
    if (currentMag !== shippedMag) top.append(el("span", "sx-tag", "changed"));
    top.append(el("code", "sx-id", row.id));
    item.append(top);
    item.append(el("p", "sx-help", row.help ?? ""));

    const [before, after] = THRESHOLD_PHRASE[row.id] ?? ["Counts as a signal at", ""];
    const box = input("number", currentMag, { min: "1", step: "1" });
    box.classList.add("sx-num");
    boxes.set(row.id, { box, sign, shippedMag });

    const ctl = el("div", "sx-th-ctl");
    ctl.append(el("span", "sx-inline-t", before), box, el("span", "sx-inline-t", row.unit === "days" ? "days" : "%"));
    if (after) ctl.append(el("span", "sx-inline-t", after));
    item.append(ctl);

    const foot = el("div", "sx-th-foot");
    foot.append(el("span", "sx-was", `Ships at ${unitText(row.shipped, row.unit)}`));
    // Never disabled, even when the field already holds the default: a user who
    // has just typed 40 into it needs this button most.
    foot.append(
      button("Use the default", "sx-link", () => {
        box.value = String(shippedMag);
        note.className = "sx-note";
        note.textContent = "Not saved yet.";
      }),
    );

    // The two harsher bands are deliberately not editable: rules.mjs only
    // overrides band 1, so an input here would change nothing. Showing them
    // read-only is what makes the first number mean something.
    const bands = st.rules?.signals?.[row.id]?.bands;
    if (Array.isArray(bands)) {
      const ramp = bands
        .map((b, i) => (b == null ? null : `${i + 1}: ${unitText(i === 0 ? sign * currentMag : b, row.unit)}`))
        .filter(Boolean)
        .join("  ·  ");
      foot.append(el("span", "sx-was", `Severity bands — ${ramp} (2 and 3 ship with the app)`));
    }
    item.append(foot);
    p.append(item);
  }

  const save = button("Save thresholds", "primary", async () => {
    // The whole thresholds object is REPLACED by setSettings, not merged, so
    // this has to send every override that should survive — including any key
    // for a signal this screen does not show, which would otherwise be deleted
    // by a save that only knew about three.
    const next = { ...(st.S.thresholds ?? {}) };
    for (const [id, { box, sign, shippedMag }] of boxes) {
      const v = Number(box.value);
      if (!Number.isFinite(v) || v <= 0) {
        note.className = "sx-note sx-bad";
        note.textContent = `${id} needs a number above zero.`;
        return;
      }
      // Matching the shipped value drops the override rather than storing a
      // copy of it, so the workspace follows any future change to the default.
      if (Math.round(v) === shippedMag) delete next[id];
      else next[id] = sign * Math.round(v);
    }
    save.disabled = true;
    const done = await put({ thresholds: next }, note);
    save.disabled = false;
    if (done) repaint("thresholds", () => buildThresholds(ctx, st, put, repaint));
  });

  const row = el("div", "sx-row sx-actions");
  row.append(save);
  p.append(row, note);
  p.append(
    el(
      "p",
      "sx-help",
      "A threshold changes what the next analysis finds. It does not rewrite decisions that already exist.",
    ),
  );
  return p;
}

/* ── the rest of the signal catalogue (read-only) ───────────────────────── */

function buildSignalCatalogue(st) {
  const p = panel(
    "The other signals",
    "Every other thing the engine looks for. These thresholds ship with the app and no route can change them, so they are shown here rather than pretended to be editable.",
  );

  if (!st.rules) {
    p.append(errorBox("The rules file could not be read", st.rulesError ?? "no reason given"));
    return p;
  }

  const editable = new Set(st.thresholdRows.map((r) => r.id));
  const signals = Object.entries(st.rules.signals ?? {}).filter(([id]) => !editable.has(id));
  if (!signals.length) {
    p.append(emptyBox("Nothing else is defined", "Every signal in the rules file is editable above."));
    return p;
  }

  const list = el("div", "sx-cat");
  for (const [id, s] of signals) {
    const item = el("div", "sx-cat-row");
    const left = el("div", "sx-cat-l");
    left.append(el("b", null, s.label ?? id));
    left.append(el("code", "sx-id", id));
    item.append(left);
    const meta = el("div", "sx-cat-r");
    const bands = (s.bands ?? []).filter((b) => b != null);
    if (bands.length) meta.append(el("span", "sx-was", `Bands ${bands.join(" · ")}`));
    if (s.window) meta.append(el("span", "sx-was", `over ${s.window} days`));
    item.append(meta);
    list.append(item);
  }
  p.append(list);
  return p;
}

/* ── situations: what actually raises a decision ────────────────────────── */

function buildSituations(st) {
  const p = panel(
    "What raises a decision",
    "A signal on its own is never a decision. These are the combinations that are, and the score each one has to reach.",
  );

  if (!st.rules) {
    p.append(el("p", "sx-help", "Not available — the rules file could not be read."));
    return p;
  }

  const labelFor = (sigId) => st.rules.signals?.[sigId]?.label ?? sigId;

  for (const [id, sit] of Object.entries(st.rules.situations ?? {})) {
    const item = el("div", "sx-sit");
    const top = el("div", "sx-th-top");
    top.append(el("b", null, sit.label ?? id));
    top.append(el("code", "sx-id", id));
    item.append(top);

    const lines = [];
    if (Array.isArray(sit.requiresAll) && sit.requiresAll.length) {
      lines.push(`Needs all of: ${sit.requiresAll.map(labelFor).join(", ")}`);
    }
    if (Array.isArray(sit.requiresAny) && sit.requiresAny.length) {
      lines.push(`And at least one of: ${sit.requiresAny.map(labelFor).join(", ")}`);
    }
    if (sit.minScore != null) lines.push(`Score must reach ${sit.minScore}`);
    if (sit.minShare != null) lines.push(`At least ${Math.round(sit.minShare * 100)}% of accounts moving the same way`);
    if (sit.minAccounts != null) lines.push(`and at least ${sit.minAccounts} accounts`);
    for (const line of lines) item.append(el("div", "sx-sit-line", line));
    p.append(item);
  }

  const sev = st.rules.severity ?? {};
  if (sev.critical != null) {
    p.append(
      el(
        "p",
        "sx-help",
        `Score is the sum of the bands of the signals that matched. ${sev.critical} or more is critical, ${sev.high} or more is high, ${sev.medium} or more is medium, and anything lower is low.`,
      ),
    );
  }
  return p;
}

/* ── business definitions ───────────────────────────────────────────────── */

function buildDefinitions(ctx, st, put, repaint) {
  const max = Number(st.limits.businessContextMaxChars) || 1000;
  const p = panel(
    "Business definitions",
    "What the words mean in your company — what counts as an enterprise account, which dips are seasonal, who a renewal belongs to. The model is given these to interpret the signals with. It is told never to take a number from them.",
  );

  const defs = parseDefinitions(st.S.businessContext);
  const note = el("div", "sx-note");
  const list = el("div", "sx-defs");
  const preview = el("pre", "sx-preview");
  const count = el("div", "sx-count");

  // Exactly the string a save would send, stamps included. The preview and the
  // character count have to be built from THIS and not from the unstamped
  // records: a stamp is 17 characters, and a counter that ignored six of them
  // would read "under the limit" on a save the server would silently truncate.
  const pendingText = () => serializeDefinitions(defs.map((d) => (d.dirty ? { ...d, changed: st.asOf } : d)));

  function refreshPreview() {
    const text = pendingText();
    preview.textContent = text || "(nothing yet)";
    count.textContent = `${text.length} of ${max} characters`;
    count.className = text.length > max ? "sx-count sx-bad" : "sx-count";
  }

  function drawRow(d, i) {
    const row = el("div", "sx-def");

    const term = input("text", d.term, { placeholder: "The term", maxlength: "48" });
    term.classList.add("sx-def-term");
    term.oninput = () => {
      d.term = term.value;
      d.dirty = true;
      refreshPreview();
    };

    const body = el("textarea", "sx-def-body");
    body.rows = 2;
    body.value = d.body;
    body.placeholder = "What it means here";
    body.oninput = () => {
      d.body = body.value;
      d.dirty = true;
      refreshPreview();
    };

    const foot = el("div", "sx-def-foot");
    const when = d.dirty
      ? `Changed now — not saved yet`
      : d.changed
        ? `Last changed ${dateText(ctx, d.changed)}`
        : "Last changed — not recorded";
    foot.append(el("span", "sx-was", when));
    foot.append(
      button("Remove", "sx-link sx-danger", () => {
        defs.splice(i, 1);
        redraw();
      }),
    );

    row.append(term, body, foot);
    return row;
  }

  function redraw() {
    list.replaceChildren();
    if (!defs.length) {
      list.append(
        emptyBox(
          "No definitions yet",
          "Without these the model only has the numbers. One line about what a word means in your company changes what it writes.",
        ),
      );
    } else {
      defs.forEach((d, i) => list.append(drawRow(d, i)));
    }
    refreshPreview();
  }

  const add = button("Add a definition", "", () => {
    defs.push({ term: "", body: "", changed: null, dirty: true });
    redraw();
  });

  const save = button("Save definitions", "primary", async () => {
    const text = pendingText();
    if (text.length > max) {
      // The server truncates with .slice() and still reports success, so the
      // tail would vanish silently. Refuse here instead.
      note.className = "sx-note sx-bad";
      note.textContent = `${text.length - max} characters too long. The server stores only the first ${max} and says nothing about the rest, so this is not being sent.`;
      return;
    }
    save.disabled = true;
    const done = await put({ businessContext: text }, note);
    save.disabled = false;
    // Rebuilt from what the server actually stored, not from the local array:
    // if the encoding lost a record, it is visible now rather than next week.
    if (done) repaint("defs", () => buildDefinitions(ctx, st, put, repaint));
  });

  const discard = button("Discard changes", "", () => repaint("defs", () => buildDefinitions(ctx, st, put, repaint)));

  p.append(list);
  const actions = el("div", "sx-row sx-actions");
  actions.append(add, save, discard, el("span", "sx-grow"), count);
  p.append(actions, note);

  const det = el("details", "sx-det");
  det.append(el("summary", null, "What gets stored and sent to the model"));
  det.append(
    el(
      "p",
      "sx-help",
      "The backend has one field for all of this, so the definitions are stored as one line each, exactly as shown. Nothing else is added.",
    ),
  );
  det.append(preview);
  p.append(det);

  redraw();
  return p;
}

/* ── privacy ────────────────────────────────────────────────────────────── */

function buildPrivacy(st, put) {
  const p = panel("Privacy", null);
  const on = st.S.pseudonymise !== false;
  const note = el("div", "sx-note");

  const toggle = input("checkbox");
  toggle.className = "sx-check";
  toggle.checked = on;
  toggle.onchange = async () => {
    toggle.disabled = true;
    const done = await put({ pseudonymise: toggle.checked }, note);
    toggle.disabled = false;
    if (!done) toggle.checked = on;
    else {
      state.textContent = stateText(toggle.checked);
      state.className = toggle.checked ? "sx-state-line sx-good" : "sx-state-line sx-bad";
    }
  };

  const lab = el("label", "sx-switch");
  lab.append(toggle, el("span", null, "Replace customer names before anything is sent to the model"));
  p.append(lab);

  // Said plainly, and said completely. "Names are pseudonymised" is true and
  // still misleading on its own: the plan, the industry, the owner's name and
  // every signal statement go either way, and a person reading only the
  // headline would assume otherwise.
  function stateText(pseudo) {
    return pseudo
      ? "On. A customer is sent as a reference like A-17. Their name never leaves this machine."
      : "Off. The customer's real name is sent to the model with the fact sheet.";
  }
  const state = el("div", on ? "sx-state-line sx-good" : "sx-state-line sx-bad", stateText(on));
  p.append(state);

  p.append(
    el(
      "p",
      "sx-help",
      "Either way, the fact sheet still carries the plan, segment, industry, the internal owner's name, the money at risk, the renewal date and every signal statement. This setting changes the customer's name and nothing else.",
    ),
  );
  p.append(note);
  return p;
}

/* ── owners ─────────────────────────────────────────────────────────────── */

function buildOwners(st, put, repaint) {
  const p = panel("Owners", "The names a decision can be assigned to. Up to 40; anything past that is dropped by the server.");
  const owners = Array.isArray(st.S.owners) ? [...st.S.owners] : [];
  const note = el("div", "sx-note");

  const list = el("div", "sx-chips");
  if (!owners.length) list.append(el("span", "sx-was", "Nobody yet. Every decision stays unassigned until there is a name here."));
  owners.forEach((name, i) => {
    const chip = el("span", "sx-chip");
    chip.append(el("span", null, name));
    const x = button("×", "sx-x", async () => {
      const next = owners.filter((_, j) => j !== i);
      x.disabled = true;
      const done = await put({ owners: next }, note);
      x.disabled = false;
      if (done) repaint("owners", () => buildOwners(st, put, repaint));
    });
    x.title = `Remove ${name}`;
    chip.append(x);
    list.append(chip);
  });
  p.append(list);

  const box = input("text", "", { placeholder: "Name" });
  const add = button("Add owner", "", async () => {
    const name = box.value.trim();
    if (!name) {
      note.className = "sx-note sx-bad";
      note.textContent = "Type a name first.";
      return;
    }
    if (owners.some((o) => o.toLowerCase() === name.toLowerCase())) {
      note.className = "sx-note sx-bad";
      note.textContent = `${name} is already on the list.`;
      return;
    }
    add.disabled = true;
    const done = await put({ owners: [...owners, name] }, note);
    add.disabled = false;
    if (done) repaint("owners", () => buildOwners(st, put, repaint));
  });
  box.onkeydown = (e) => {
    if (e.key === "Enter") add.click();
  };

  const row = el("div", "sx-row");
  row.append(box, add);
  p.append(row, note);
  return p;
}

/* ── run limits and money ───────────────────────────────────────────────── */

function buildLimits(st, put) {
  const p = panel("Analysis and money", "What one run is allowed to cost, and the one price the impact estimate needs.");
  const note = el("div", "sx-note");

  const maxShipped = st.limits.maxReasonedPerRun;
  const maxBox = input("number", st.S.maxReasonedPerRun ?? maxShipped ?? "", { min: "1", max: "50", step: "1" });
  maxBox.classList.add("sx-num");
  p.append(
    labelled("Model calls allowed in one analysis", maxBox),
  );
  p.append(
    el(
      "p",
      "sx-help",
      `Ships at ${maxShipped ?? "—"}. The server clamps this between 1 and 50. Each call has its own 60 second timeout, so a high number is a long run, not a failed one.`,
    ),
  );

  const priceBox = input("number", st.S.seatPriceMonthly ?? "", { min: "0", step: "0.01", placeholder: "not set" });
  priceBox.classList.add("sx-num");
  p.append(labelled(`Price of one seat per month (${st.S.currency ?? "USD"})`, priceBox));
  p.append(
    el(
      "p",
      "sx-help",
      "Used to estimate what an expansion is worth. Leave it blank to keep it unset — once a price is saved there is no route that can clear it again, only change it. The currency comes from the imported workspace file and cannot be set here.",
    ),
  );

  const save = button("Save", "primary", async () => {
    const patch = {};
    const m = Number(maxBox.value);
    if (!Number.isFinite(m) || m < 1) {
      note.className = "sx-note sx-bad";
      note.textContent = "Model calls must be a whole number, 1 or more.";
      return;
    }
    patch.maxReasonedPerRun = Math.round(m);
    // An empty box is left out of the patch entirely. Number("") is 0 and the
    // server treats 0 as a real value, so sending it would set the seat price
    // to zero rather than leaving it alone.
    if (priceBox.value.trim() !== "") {
      const v = Number(priceBox.value);
      if (!Number.isFinite(v) || v < 0) {
        note.className = "sx-note sx-bad";
        note.textContent = "A seat price cannot be negative.";
        return;
      }
      patch.seatPriceMonthly = v;
    }
    save.disabled = true;
    await put(patch, note);
    save.disabled = false;
  });
  const row = el("div", "sx-row sx-actions");
  row.append(save);
  p.append(row, note);

  // Four more limits are stored per workspace and read by the engine, and
  // decisionsSettingsSet accepts none of them. Listed rather than hidden,
  // because a person hunting for "why did this get nudged after a week" should
  // find the seven, not an empty screen.
  const ro = el("div", "sx-ro");
  ro.append(el("div", "sx-ro-h", "Set when the app was built. No route on this screen can change them."));
  const rows = [
    ["Model failures before a run gives up", st.S.maxLlmFailuresPerRun, st.limits.maxLlmFailuresPerRun],
    ["Days in Waiting before a nudge", st.S.waitingNudgeDays, st.limits.waitingNudgeDays],
    ["Days a dismissed decision stays quiet", st.S.dismissedSuppressDays, st.limits.dismissedSuppressDays],
    ["Days between two prepared emails to one customer", st.S.outreachCooldownDays, st.limits.outreachCooldownDays],
  ];
  for (const [label, value, shipped] of rows) {
    const r = el("div", "sx-ro-row");
    r.append(el("span", null, label));
    r.append(el("b", null, value != null ? String(value) : shipped != null ? String(shipped) : "—"));
    ro.append(r);
  }
  p.append(ro);
  return p;
}

/* ── where the data lives ───────────────────────────────────────────────── */

function buildWhere(st) {
  const p = panel("Where this workspace lives", "Every setting on this page is stored in this folder, on this machine.");
  const box = el("div", "sx-ro");
  const row = el("div", "sx-ro-row");
  row.append(el("span", null, "Folder"));
  row.append(el("code", "sx-path", st.dataDir || "—"));
  box.append(row);
  const idRow = el("div", "sx-ro-row");
  idRow.append(el("span", null, "Workspace id"));
  idRow.append(el("code", "sx-path", st.workspace?.id || "—"));
  box.append(idRow);
  p.append(box);
  return p;
}

/* ── styles ─────────────────────────────────────────────────────────────── */

// Scoped to sx- and shipped inside the page, because this file owns no
// stylesheet and must not reach into one another agent wrote. The CSP allows a
// <style> element and forbids an inline <script>. Colours are tokens only:
// there is not a hex literal in here.
function styles() {
  return el(
    "style",
    null,
    `
.sx-wrap { display:flex; flex-direction:column; gap:14px; max-width:860px; padding-bottom:48px; }
.sx-state { max-width:640px; }
.sx-grow { flex:1 1 auto; }

.sx-head h1 { margin:0; font-size:24px; line-height:1.2; letter-spacing:-0.01em; }
.sx-sub { margin:4px 0 0; font-size:13px; color:var(--muted); }
.sx-sub b { color:var(--text); font-weight:600; }

.sx-panel { background:var(--panel); border:1px solid var(--border); border-radius:var(--radius); padding:18px 20px; }
.sx-panel-h { display:flex; align-items:baseline; gap:10px; }
.sx-panel-h h2 { margin:0; font-size:15px; font-weight:600; }
.sx-help { margin:6px 0 0; font-size:12.5px; line-height:1.55; color:var(--muted); max-width:70ch; }
.sx-panel > .sx-help:last-child { margin-bottom:0; }

.sx-row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; margin-top:12px; }
.sx-actions { margin-top:16px; }
.sx-inline-t { font-size:12.5px; color:var(--muted); }

.sx-btn { font:inherit; font-size:12.5px; font-weight:550; padding:7px 13px; border-radius:var(--radius-sm);
  color:var(--text); background:var(--panel-2); border:1px solid var(--border); cursor:pointer; white-space:nowrap; }
.sx-btn:hover { border-color:var(--muted); }
.sx-btn:disabled { opacity:.45; cursor:default; }
.sx-btn:disabled:hover { border-color:var(--border); }
.sx-btn.primary { background:var(--accent); border-color:var(--accent); color:var(--bg); }
.sx-btn.sx-link { background:none; border-color:transparent; color:var(--muted); padding:4px 6px; text-decoration:underline;
  text-underline-offset:2px; }
.sx-btn.sx-link:hover { color:var(--text); }
.sx-btn.sx-danger:hover { color:var(--danger); }
.sx-btn.sx-x { padding:0 6px; line-height:1.4; background:none; border:0; color:var(--muted); font-size:14px; }
.sx-btn.sx-x:hover { color:var(--danger); }

.sx-input { font:inherit; font-size:13px; padding:7px 10px; border-radius:var(--radius-sm); color:var(--text);
  background:var(--bg); border:1px solid var(--border); min-width:200px; }
.sx-input:focus { outline:none; border-color:var(--muted); }
.sx-input.sx-num { min-width:0; width:86px; text-align:right; font-variant-numeric:tabular-nums; }
.sx-input[type="date"] { min-width:0; width:160px; }
.sx-check { min-width:0; width:16px; height:16px; accent-color:var(--accent); }
.sx-switch { display:flex; align-items:center; gap:9px; font-size:13px; cursor:pointer; }
.sx-field { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-top:14px; }
.sx-field-t { font-size:13px; }

.sx-note:empty { display:none; }
.sx-note { margin-top:10px; font-size:12.5px; color:var(--muted); }
.sx-note.sx-good { color:var(--accent); }
.sx-note.sx-bad { color:var(--danger); }
.sx-count { font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; }
.sx-count.sx-bad { color:var(--danger); }

/* ── clock ── */
.sx-clock.sx-pinned { border-color:var(--warn); }
.sx-warn { display:flex; flex-direction:column; gap:4px; margin-top:12px; padding:11px 13px; border-radius:var(--radius-sm);
  border:1px solid var(--warn); border-left-width:3px; background:color-mix(in srgb, var(--warn) 10%, transparent);
  font-size:12.5px; line-height:1.5; }
.sx-warn strong { color:var(--warn); font-weight:650; }
.sx-now { margin-top:14px; padding:12px 14px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--bg); }
.sx-now-k { font-size:10.5px; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); }
.sx-now-v { font-size:22px; font-weight:600; letter-spacing:-0.01em; margin-top:2px; font-variant-numeric:tabular-nums; }
.sx-now-s { font-size:12px; color:var(--muted); margin-top:2px; }
.sx-clock-ctl { margin-top:4px; }

/* ── thresholds ── */
.sx-th, .sx-sit { margin-top:14px; padding-top:14px; border-top:1px solid var(--border-soft); }
.sx-th-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sx-th-top b { font-size:13.5px; font-weight:600; }
.sx-id { font-size:11px; color:var(--muted); }
.sx-tag { font-size:10.5px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:var(--accent);
  border:1px solid color-mix(in srgb, var(--accent) 40%, transparent); border-radius:999px; padding:1px 7px; }
.sx-th-ctl { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:10px; font-size:13px; }
.sx-th-foot { display:flex; align-items:center; gap:14px; flex-wrap:wrap; margin-top:8px; }
.sx-was { font-size:11.5px; color:var(--muted); font-variant-numeric:tabular-nums; }

.sx-cat { margin-top:6px; }
.sx-cat-row { display:flex; align-items:center; gap:12px; padding:8px 0; border-bottom:1px solid var(--border-soft); }
.sx-cat-row:last-child { border-bottom:0; }
.sx-cat-l { display:flex; align-items:baseline; gap:8px; flex:1 1 auto; min-width:0; }
.sx-cat-l b { font-size:13px; font-weight:550; }
.sx-cat-r { display:flex; gap:12px; flex:0 0 auto; }
.sx-sit-line { font-size:12.5px; color:var(--muted); margin-top:4px; }

/* ── definitions ── */
.sx-defs { display:flex; flex-direction:column; gap:10px; margin-top:14px; }
.sx-def { border:1px solid var(--border); border-radius:var(--radius-sm); padding:10px 12px; background:var(--bg); }
.sx-def-term { width:100%; min-width:0; font-weight:600; }
.sx-def-body { font:inherit; font-size:13px; line-height:1.5; width:100%; margin-top:7px; padding:7px 10px; resize:vertical;
  color:var(--text); background:var(--bg); border:1px solid var(--border); border-radius:var(--radius-sm); }
.sx-def-body:focus, .sx-def-term:focus { outline:none; border-color:var(--muted); }
.sx-def-foot { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-top:7px; }
.sx-det { margin-top:14px; font-size:12.5px; color:var(--muted); }
.sx-det summary { cursor:pointer; }
.sx-preview { margin:10px 0 0; padding:11px 13px; border:1px solid var(--border); border-radius:var(--radius-sm);
  background:var(--bg); color:var(--text); font-size:12px; line-height:1.6; white-space:pre-wrap; word-break:break-word; }

/* ── chips, read-only rows ── */
.sx-chips { display:flex; flex-wrap:wrap; gap:7px; align-items:center; margin-top:12px; }
.sx-chip { display:inline-flex; align-items:center; gap:4px; font-size:12.5px; padding:3px 6px 3px 11px;
  border:1px solid var(--border); border-radius:999px; }
.sx-state-line { margin-top:8px; font-size:13px; }
.sx-state-line.sx-good { color:var(--accent); }
.sx-state-line.sx-bad { color:var(--warn); }

.sx-ro { margin-top:16px; padding-top:14px; border-top:1px solid var(--border-soft); }
.sx-ro-h { font-size:11.5px; color:var(--muted); margin-bottom:8px; }
.sx-ro-row { display:flex; align-items:baseline; justify-content:space-between; gap:14px; padding:6px 0;
  border-bottom:1px solid var(--border-soft); font-size:12.5px; }
.sx-ro-row:last-child { border-bottom:0; }
.sx-ro-row span { color:var(--muted); }
.sx-ro-row b { font-weight:600; font-variant-numeric:tabular-nums; }
.sx-path { font-size:11.5px; color:var(--text); word-break:break-all; text-align:right; }
`,
  );
}
