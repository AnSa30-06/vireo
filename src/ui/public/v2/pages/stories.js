// v2 / Stories — a saved report you can run again, and a run that never changes
// its mind afterwards.
//
// WHY THIS SCREEN IS BUILT THE WAY IT IS
//
// The competitor meters "Stories per month", "weekly scheduled Stories" and "PDF
// export", and documents none of the three. So there is nothing to copy, and the
// only thing worth building is the honest version of the idea. The honest
// version rests on one property, and this screen is arranged so that property is
// visible rather than claimed:
//
//   1. A RUN IS DATED AND FROZEN. Every report on screen is a stored snapshot
//      with the day it was taken printed at the top of it. Opening a run from
//      March shows March's numbers, because the server hands back the bytes it
//      stored in March and does not go near today's decision table. There is no
//      "refresh" on a run — running the story again writes a NEW one, and both
//      stay in the history.
//   2. EVERY FIGURE SAYS WHAT IT COUNTED. Under each block of numbers is the
//      table and the date column they came from, and under that is the list of
//      records themselves. A number you cannot trace is a number you end up
//      defending in a meeting with nothing behind it.
//   3. A TOTAL OVER PART OF THE SET SAYS SO. "Impact named" counts only the
//      decisions that carry an impact figure, and the line under it says how
//      many of how many. Same for a list that stops at the cap: the total above
//      it still counts everything, and the note says so.
//
// EXPORT IS HTML, NOT PDF, AND THE SCREEN SAYS SO. There is no PDF library in
// this app; adding a dependency for one button is out of proportion, and a
// bundled renderer that fails on an offline machine would be worse than no
// button. The export is one self-contained HTML file with a print stylesheet —
// no link, no font, no script, no image — and the browser turns it into a PDF in
// two clicks. An export that works beats a dependency that might not.
//
// 🔴 THIS FILE COMPUTES NOTHING. Every number on it was worked out by
// src/decisions/stories.mjs at the moment the run happened and has been stored
// since. The page reads a snapshot and lays it out. If it did arithmetic of its
// own there would be two versions of the same report — the one that was stored
// and the one being displayed — and they could only drift apart.
//
// Every string reaches the DOM through textContent. Customer names, notes and
// decision titles all pass through here; innerHTML is never used, the same rule
// as every other page in v2.

export const title = "Stories";

/* ══ THE BACKEND ═══════════════════════════════════════════════════════════
 *
 * The single seam between this screen and the server.
 *
 * 🔴 EVERY ROUTE NAME IS A QUOTED LITERAL INSIDE ITS OWN api(...) CALL, never a
 * variable handed to a helper. tests/unit/v2-ui.test.mjs finds the routes a page
 * calls by reading this source for quoted names, so a name routed through a
 * helper slips past the check and the first sign of a typo would be an empty
 * section on screen rather than a failing test.
 *
 * The server only parses a request body for POST, so every write goes out as a
 * POST and the two reads that take an id go out as GETs with a query string.
 */
function backend(ctx) {
  const post = (body) => ({ method: "POST", body });
  return {
    list: () => ctx.api("decisionsStories"),
    create: (s) => ctx.api("decisionsStoryCreate", post({ name: s.name, sections: s.sections, periodDays: s.periodDays, schedule: s.schedule })),
    update: (s) => ctx.api("decisionsStoryUpdate", post({ id: s.id, name: s.name, sections: s.sections, periodDays: s.periodDays, schedule: s.schedule })),
    setSchedule: (id, schedule) => ctx.api("decisionsStoryUpdate", post({ id, schedule })),
    remove: (id) => ctx.api("decisionsStoryDelete", post({ id })),
    run: (id) => ctx.api("decisionsStoryRun", post({ id })),
    history: (id) => ctx.api("decisionsStoryHistory", { query: { id } }),
    snapshot: (id) => ctx.api("decisionsStorySnapshot", { query: { id } }),
    exportRun: (id) => ctx.api("decisionsStoryExport", post({ id })),
  };
}

/** A route that answered ok:false, or threw, said one of these. Never invent a third. */
const reasonFrom = (res, err) =>
  err ? String(err?.message ?? err) : String(res?.error ?? "the server did not say what went wrong");

/* ══ tiny DOM helpers ══════════════════════════════════════════════════════ */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = String(text);
  return n;
};

function button(text, cls, onClick) {
  const b = el("button", cls, text);
  b.type = "button";
  b.addEventListener("click", onClick);
  return b;
}

/**
 * A button that says what it is doing and cannot be pressed twice.
 * Running a story writes a row, so a double press writes two.
 */
function busyButton(text, busyText, cls, onClick) {
  const b = button(text, cls, async () => {
    if (b.disabled) return;
    b.disabled = true;
    const was = b.textContent;
    b.textContent = busyText;
    try {
      await onClick();
    } finally {
      b.disabled = false;
      b.textContent = was;
    }
  });
  return b;
}

function select(options, value, onChange) {
  const s = el("select", "st-sel");
  for (const [v, label] of options) {
    const o = el("option", null, label);
    o.value = String(v);
    s.append(o);
  }
  s.value = String(value);
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

function checkbox(checked, onChange) {
  const c = el("input", "st-check");
  c.type = "checkbox";
  c.checked = !!checked;
  c.addEventListener("change", () => onChange(c.checked));
  return c;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * ctx.fmt is written by a sibling agent in this same build, so every call is
 * guarded: a missing or throwing helper degrades to something readable rather
 * than taking the page down.
 */
function dateText(ctx, iso) {
  if (!iso) return "";
  const fn = ctx?.fmt?.date;
  if (typeof fn === "function") {
    try {
      const out = fn(String(iso).slice(0, 10));
      if (out != null && out !== "") return String(out);
    } catch {
      /* fall through to the raw day */
    }
  }
  return String(iso).slice(0, 10);
}

function errorBox(headline, detail) {
  const box = el("div", "err");
  box.append(el("strong", null, headline));
  // The server's own words, never paraphrased: a friendlier sentence says less,
  // and the person reading it is the one who has to fix whatever it names.
  if (detail) box.append(el("code", null, detail));
  return box;
}

/** A path the user can copy. Same shape as the one on the Data screen. */
function pathField(value) {
  const wrap = el("div", "st-pathrow");
  const input = el("input", "st-in st-path");
  input.type = "text";
  input.readOnly = true;
  input.value = String(value);
  input.addEventListener("focus", () => input.select());
  const said = el("span", "st-hint");
  const copy = button("Copy", "btn tiny", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      said.textContent = "Copied.";
    } catch {
      // Clipboard access can be refused; selecting the text leaves a working
      // Ctrl+C rather than a button that did nothing.
      input.focus();
      input.select();
      said.textContent = "Could not copy — the path is selected, press Ctrl+C.";
    }
  });
  wrap.append(input, copy, said);
  return wrap;
}

/* ══ STYLES ════════════════════════════════════════════════════════════════
 *
 * Page-local, injected once, every selector under the .st- prefix so it cannot
 * reach the shell or a sibling page. Every colour is a token or a color-mix over
 * one — no literal hex anywhere, so light mode needs no second copy of any rule.
 */

const STYLE_ID = "v2-stories-style";
const CSS = `
.st { display: flex; flex-direction: column; gap: var(--s4); max-width: 1120px; }
.st-head { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.st-head h2 { margin: 0; }
.st-muted { color: var(--muted); font-size: var(--fs-sm); }
.st-grow { flex: 1 1 auto; }

.st-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.st-card > header { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap;
  padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
.st-card > header h3 { font-size: var(--fs-md); margin: 0; }
.st-body { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.st-body.flush { padding: 0; }

/* Amber, not red: nothing is broken, something is absent. */
.st-warn { border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border-radius: var(--radius); padding: var(--s3) var(--s4); font-size: var(--fs-sm); }
.st-warn b { color: var(--warn); font-weight: 650; }
.st-warn p { margin: 0 0 6px; }
.st-warn p:last-child { margin-bottom: 0; }

/* A saved story. The rule of the screen: the schedule and the last run are read
   together with the name, never behind a click. */
.st-row { border-top: 1px solid var(--border-soft); padding: var(--s3) var(--s4);
  display: flex; flex-direction: column; gap: 6px; }
.st-row:first-child { border-top: 0; }
.st-row.on { background: color-mix(in srgb, var(--accent) 6%, transparent); }
.st-rowtop { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.st-rowtop h4 { font-size: var(--fs-md); margin: 0; }
.st-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.st-sub { color: var(--muted); font-size: var(--fs-xs); }

.st-sel, .st-in { background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 6px 9px; font: inherit; font-size: var(--fs-sm); }
.st-sel:focus, .st-in:focus { border-color: var(--muted); }
.st-in { min-width: 200px; }
.st-in.wide { flex: 1 1 260px; }
.st-path { flex: 1 1 320px; font-family: var(--mono); font-size: var(--fs-xs); }
.st-pathrow { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.st-hint { color: var(--muted); font-size: var(--fs-xs); }
.st-field { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.st-label { font-size: var(--fs-sm); color: var(--muted); min-width: 86px; }

/* The section pickers. The basis line sits under each one, because choosing a
   section is choosing which records get counted. */
.st-picks { display: flex; flex-direction: column; gap: var(--s2); }
.st-pick { display: flex; gap: var(--s2); align-items: flex-start;
  border: 1px solid var(--border-soft); border-radius: var(--radius); padding: var(--s2) var(--s3); }
.st-pick.on { border-color: color-mix(in srgb, var(--accent) 50%, var(--border)); }
.st-pick label { font-size: var(--fs-sm); font-weight: 550; cursor: pointer; }
.st-pick .st-sub { display: block; margin-top: 2px; }
.st-check { margin-top: 3px; accent-color: var(--accent); }

/* The report itself. */
.st-report { display: flex; flex-direction: column; gap: var(--s3); }
.st-repmeta { display: flex; flex-wrap: wrap; gap: var(--s4); font-size: var(--fs-xs); color: var(--muted); }
.st-repmeta b { color: var(--text); font-weight: 600; display: block; font-size: var(--fs-sm); }
.st-sec { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.st-sec h4 { font-size: var(--fs-md); margin: 0; }
.st-basis { color: var(--muted); font-size: var(--fs-xs); margin: 2px 0 0; }
.st-figs { display: flex; flex-wrap: wrap; gap: var(--s5); }
.st-fig { min-width: 104px; }
.st-fig .v { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.01em; }
.st-fig .l { color: var(--muted); font-size: var(--fs-xs); font-variant-caps: all-small-caps;
  letter-spacing: .07em; }
.st-fig .n { color: var(--muted); font-size: var(--fs-xs); margin-top: 2px; max-width: 240px; }

/* A table is the only place in this design that may be wider than the page, and
   it scrolls inside its own box rather than pushing the page sideways. */
.st-scroll { overflow-x: auto; }
.st-tbl { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.st-tbl th { text-align: left; color: var(--muted); font-size: var(--fs-xs);
  font-variant-caps: all-small-caps; letter-spacing: .07em; font-weight: 650;
  border-bottom: 1px solid var(--border); padding: 6px 8px; white-space: nowrap; }
.st-tbl td { padding: 6px 8px; border-bottom: 1px solid var(--border-soft); vertical-align: top; }
.st-tbl tr:last-child td { border-bottom: 0; }
.st-tbl .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.st-open { background: transparent; border: 0; padding: 0; color: var(--text); font: inherit;
  text-align: left; cursor: pointer; border-bottom: 1px solid var(--border); }
.st-open:hover { color: var(--accent); border-bottom-color: var(--accent); }
.st-trunc { color: var(--warn); font-size: var(--fs-xs); margin: 0; }
.st-none { color: var(--muted); font-size: var(--fs-sm); margin: 0; }
.st-inline-err { color: var(--danger); font-size: var(--fs-sm); }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

/* ══ DRAFT ═════════════════════════════════════════════════════════════════
 *
 * The saved stories live in the workspace database. The half-built one does not,
 * so it is parked on the shared state object: a trip to Decisions and back
 * should not throw away a story that was never saved.
 */

const blankStory = (defaults) => ({
  id: null,
  name: "",
  sections: [...(defaults ?? [])],
  periodDays: 7,
  schedule: "off",
});

const cloneStory = (s) => ({
  id: s.id ?? null,
  name: s.name ?? "",
  sections: [...(s.sections ?? [])],
  periodDays: Number(s.periodDays) || 7,
  schedule: s.schedule ?? "off",
});

/* ══ RENDER ════════════════════════════════════════════════════════════════ */

export async function render(root, ctx) {
  ensureStyles();
  root.replaceChildren();

  const page = el("div", "st");
  root.append(page);

  const loading = el("div", null);
  for (let i = 0; i < 3; i++) loading.append(el("div", "skeleton block"));
  page.append(loading);

  // One call: the saved stories with their run counts, the section vocabulary
  // the builder offers, and what this workspace actually holds. Its failure ends
  // the page, because without the vocabulary there is no builder to show.
  const api = backend(ctx);
  let data;
  try {
    data = await api.list();
  } catch (err) {
    loading.remove();
    page.append(errorBox("Stories could not be read", reasonFrom(null, err)));
    return;
  }
  loading.remove();

  if (!data?.ok) {
    // needsWorkspace is normally caught by the shell, but a direct #/stories hit
    // can land here before status has been read.
    page.append(errorBox(data?.needsWorkspace ? "No workspace is open" : "Stories could not be read", reasonFrom(data)));
    return;
  }

  // Everything the sub-renderers need, in one bag, so no function reaches for a
  // closure two levels up.
  const view = {
    ctx,
    api,
    stories: Array.isArray(data.stories) ? data.stories : [],
    sectionKinds: Array.isArray(data.sectionKinds) ? data.sectionKinds : [],
    periods: Array.isArray(data.periods) && data.periods.length ? data.periods : [7, 30],
    defaultSections: Array.isArray(data.defaultSections) ? data.defaultSections : [],
    weeklyDays: Number(data.weeklyDays) || 7,
    accounts: Number(data.accounts) || 0,
    decisions: Number(data.decisions) || 0,
    asOf: data.asOf ?? null,
    notice: null,
  };

  if (!view.sectionKinds.length) {
    page.append(errorBox("Stories could not be read", "the server returned no sections to build a story from"));
    return;
  }

  page.append(header(view));
  if (!view.decisions) page.append(noDataBanner(view));

  const listMount = el("div");
  const builderMount = el("div");
  const reportMount = el("div");
  page.append(listMount, builderMount, reportMount);

  if (!ctx.state.storyDraft) ctx.state.storyDraft = blankStory(view.defaultSections);

  /** Re-read the saved list. The server is the only copy. */
  const reload = async () => {
    try {
      const fresh = await api.list();
      if (fresh?.ok) view.stories = Array.isArray(fresh.stories) ? fresh.stories : [];
      else view.notice = reasonFrom(fresh);
    } catch (err) {
      view.notice = reasonFrom(null, err);
    }
    paintList(listMount, view, handlers);
  };

  const handlers = {
    reload,
    /** Put a saved story into the builder. Never edits in place. */
    edit(story) {
      ctx.state.storyDraft = cloneStory(story);
      paintBuilder(builderMount, view, handlers);
      builderMount.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    /** Show one stored run. Nothing is recomputed to do it. */
    showRun(story, run, snapshot) {
      view.shownStoryId = story?.id ?? null;
      paintReport(reportMount, view, { story, run, snapshot });
      paintList(listMount, view, handlers);
      reportMount.scrollIntoView({ block: "start", behavior: "smooth" });
    },
    clearReport() {
      view.shownStoryId = null;
      reportMount.replaceChildren();
      paintList(listMount, view, handlers);
    },
  };

  paintList(listMount, view, handlers);
  paintBuilder(builderMount, view, handlers);
}

/* ── header and banners ─────────────────────────────────────────────────── */

function header(view) {
  const h = el("div", "st-head");
  h.append(el("h2", null, "Stories"));
  const bits = [plural(view.stories.length, "saved story", "saved stories")];
  if (view.asOf) bits.push(`as of ${dateText(view.ctx, view.asOf)}`);
  h.append(el("span", "st-muted", bits.join(" · ")));
  h.append(el("span", "st-grow"));
  h.append(
    el(
      "span",
      "st-muted",
      "A story is a report you can run again. Each run is stored with its date and never changes afterwards.",
    ),
  );
  return h;
}

function noDataBanner(view) {
  const box = el("div", "st-warn");
  const p1 = el("p");
  p1.append(el("b", null, "There are no decisions to report on yet. "));
  p1.append(
    document.createTextNode(
      view.accounts
        ? "This workspace has customers but no analysis has produced a decision, so every section of a story would be empty."
        : "This workspace has no imported data, so every section of a story would be empty.",
    ),
  );
  box.append(p1);
  box.append(el("p", null, "You can still save a story now — it will report honestly, and it will have something to say after the first run."));
  return box;
}

/* ── the saved list ─────────────────────────────────────────────────────── */

function paintList(mount, view, h) {
  mount.replaceChildren();

  if (view.notice) {
    mount.append(errorBox("The last action did not go through", view.notice));
    view.notice = null;
  }

  if (!view.stories.length) {
    const box = el("div", "empty");
    box.append(el("h3", null, "No stories yet"));
    box.append(
      el(
        "p",
        null,
        "A story is a set of sections over a period — what opened, what closed, what changed, who moved and what the outcome was. Build one below, run it, and the run is kept.",
      ),
    );
    mount.append(box);
    return;
  }

  const card = el("div", "st-card");
  const head = el("header");
  head.append(el("h3", null, "Saved stories"));
  head.append(el("span", "st-grow"));
  head.append(el("span", "st-muted", `a weekly story runs itself every ${view.weeklyDays} days`));
  card.append(head);

  const body = el("div", "st-body flush");
  for (const story of view.stories) body.append(storyRow(story, view, h));
  card.append(body);
  mount.append(card);
}

function storyRow(story, view, h) {
  const row = el("div", "st-row" + (view.shownStoryId === story.id ? " on" : ""));

  const top = el("div", "st-rowtop");
  top.append(el("h4", null, story.name));
  const sched = el("span", "pill " + (story.schedule === "weekly" ? "accepted" : "new"), story.schedule === "weekly" ? "Weekly" : "On demand");
  top.append(sched);
  if (story.due) top.append(el("span", "chip warn", "due now"));
  if (story.unknownSections?.length) {
    top.append(el("span", "chip danger", `${plural(story.unknownSections.length, "section", "sections")} this build does not know`));
  }
  top.append(el("span", "st-grow"));

  const actions = el("div", "st-actions");
  const slot = el("div");

  actions.append(
    busyButton("Run now", "Running…", "btn primary", async () => {
      slot.replaceChildren();
      let r;
      try {
        r = await view.api.run(story.id);
      } catch (err) {
        slot.append(errorBox("The story could not be run", reasonFrom(null, err)));
        return;
      }
      if (!r?.ok) {
        slot.append(errorBox("The story could not be run", reasonFrom(r)));
        return;
      }
      await h.reload();
      h.showRun(story, r.run, r.snapshot);
    }),
  );

  actions.append(
    busyButton("History", "Reading…", "btn", async () => {
      slot.replaceChildren();
      let r;
      try {
        r = await view.api.history(story.id);
      } catch (err) {
        slot.append(errorBox("The history could not be read", reasonFrom(null, err)));
        return;
      }
      if (!r?.ok) {
        slot.append(errorBox("The history could not be read", reasonFrom(r)));
        return;
      }
      slot.replaceChildren(historyList(story, r.runs ?? [], view, h));
    }),
  );

  actions.append(button("Edit", "btn", () => h.edit(story)));
  actions.append(
    button("Delete", "btn danger", () => {
      slot.replaceChildren(confirmDelete(story, view, h));
    }),
  );
  top.append(actions);
  row.append(top);

  const sectionLabels = story.sections
    .map((k) => view.sectionKinds.find((s) => s.kind === k)?.label ?? k)
    .join(", ");
  const bits = [`${story.periodDays} days`, sectionLabels || "no sections"];
  bits.push(story.runs ? plural(story.runs, "run", "runs") : "never run");
  if (story.lastRun) bits.push(`last run ${dateText(view.ctx, story.lastRun.at)}`);
  row.append(el("div", "st-sub", bits.join(" · ")));

  row.append(slot);
  return row;
}

function confirmDelete(story, view, h) {
  const box = el("div", "st-warn");
  const p = el("p");
  p.append(el("b", null, "Delete this story? "));
  p.append(
    document.createTextNode(
      story.runs === 0
        ? "It has no stored runs. This cannot be undone."
        : story.runs === 1
          ? "Its one stored run goes with it, and nothing here can be undone."
          : `Its ${story.runs} stored runs go with it, and nothing here can be undone.`,
    ),
  );
  box.append(p);
  const row = el("div", "st-actions");
  row.append(
    busyButton("Delete it", "Deleting…", "btn danger", async () => {
      try {
        const r = await view.api.remove(story.id);
        if (!r?.ok) view.notice = reasonFrom(r);
      } catch (err) {
        view.notice = reasonFrom(null, err);
      }
      if (view.shownStoryId === story.id) h.clearReport();
      await h.reload();
    }),
  );
  row.append(button("Keep it", "btn ghost", () => box.replaceChildren()));
  box.append(row);
  return box;
}

function historyList(story, runs, view, h) {
  const card = el("div", "st-card");
  const head = el("header");
  head.append(el("h3", null, `Past runs of "${story.name}"`));
  card.append(head);

  if (!runs.length) {
    const body = el("div", "st-body");
    body.append(el("p", "st-none", "This story has never been run, so there is nothing stored yet."));
    card.append(body);
    return card;
  }

  const body = el("div", "st-body flush");
  for (const run of runs) {
    const row = el("div", "st-row");
    const top = el("div", "st-rowtop");
    top.append(el("span", null, run.periodLabel ?? `${run.periodFrom} to ${run.periodTo}`));
    top.append(el("span", "chip", run.trigger === "schedule" ? "weekly schedule" : "run by hand"));
    top.append(el("span", "st-grow"));
    top.append(
      busyButton("Open", "Reading…", "btn tiny", async () => {
        let r;
        try {
          r = await view.api.snapshot(run.id);
        } catch (err) {
          row.append(errorBox("That run could not be read", reasonFrom(null, err)));
          return;
        }
        if (!r?.ok) {
          row.append(errorBox("That run could not be read", reasonFrom(r)));
          return;
        }
        h.showRun(story, r.run, r.snapshot);
      }),
    );
    row.append(top);
    row.append(el("div", "st-sub", `run on ${dateText(view.ctx, run.at)}`));
    body.append(row);
  }
  card.append(body);
  return card;
}

/* ── the builder ────────────────────────────────────────────────────────── */

function paintBuilder(mount, view, h) {
  mount.replaceChildren();
  const draft = view.ctx.state.storyDraft;

  const card = el("div", "st-card");
  const head = el("header");
  head.append(el("h3", null, draft.id ? "Edit story" : "New story"));
  head.append(el("span", "st-grow"));
  if (draft.id) {
    head.append(
      button("Start a new one instead", "btn tiny ghost", () => {
        view.ctx.state.storyDraft = blankStory(view.defaultSections);
        paintBuilder(mount, view, h);
      }),
    );
  }
  card.append(head);

  const body = el("div", "st-body");

  const nameRow = el("div", "st-field");
  nameRow.append(el("span", "st-label", "Name"));
  const nameIn = el("input", "st-in wide");
  nameIn.type = "text";
  nameIn.value = draft.name;
  nameIn.placeholder = "Weekly review";
  nameIn.addEventListener("input", () => {
    draft.name = nameIn.value;
  });
  nameRow.append(nameIn);
  body.append(nameRow);

  const periodRow = el("div", "st-field");
  periodRow.append(el("span", "st-label", "Covers"));
  periodRow.append(
    select(
      view.periods.map((d) => [d, `the last ${d} days`]),
      view.periods.includes(draft.periodDays) ? draft.periodDays : view.periods[0],
      (v) => {
        draft.periodDays = Number(v);
      },
    ),
  );
  periodRow.append(el("span", "st-hint", "counted back from the workspace's as-of day, including it"));
  body.append(periodRow);

  const schedRow = el("div", "st-field");
  schedRow.append(el("span", "st-label", "Schedule"));
  const schedBox = checkbox(draft.schedule === "weekly", (on) => {
    draft.schedule = on ? "weekly" : "off";
  });
  const schedLabel = el("label", null, `run it every ${view.weeklyDays} days on its own`);
  // The box goes before the words, so the label reads as a sentence rather than
  // as a caption sitting under a control.
  schedLabel.prepend(schedBox);
  schedRow.append(schedLabel);
  body.append(schedRow);

  const picks = el("div", "st-picks");
  for (const kind of view.sectionKinds) {
    const on = draft.sections.includes(kind.kind);
    const pick = el("div", "st-pick" + (on ? " on" : ""));
    const box = checkbox(on, (checked) => {
      draft.sections = checked
        ? [...draft.sections, kind.kind]
        : draft.sections.filter((k) => k !== kind.kind);
      pick.className = "st-pick" + (checked ? " on" : "");
    });
    pick.append(box);
    const text = el("div");
    const label = el("label", null, kind.label);
    label.addEventListener("click", () => box.click());
    text.append(label);
    text.append(el("span", "st-sub", `counted from ${kind.basis}`));
    pick.append(text);
    picks.append(pick);
  }
  body.append(el("span", "st-label", "Sections"), picks);

  const errSlot = el("div");
  body.append(errSlot);

  const actions = el("div", "st-actions");
  actions.append(
    busyButton(draft.id ? "Save changes" : "Save story", "Saving…", "btn primary", async () => {
      errSlot.replaceChildren();
      let r;
      try {
        r = draft.id ? await view.api.update(draft) : await view.api.create(draft);
      } catch (err) {
        errSlot.append(errorBox("The story could not be saved", reasonFrom(null, err)));
        return;
      }
      if (!r?.ok) {
        errSlot.append(el("p", "st-inline-err", reasonFrom(r)));
        return;
      }
      view.ctx.state.storyDraft = blankStory(view.defaultSections);
      paintBuilder(mount, view, h);
      await h.reload();
    }),
  );
  if (draft.id) {
    actions.append(
      button("Cancel", "btn ghost", () => {
        view.ctx.state.storyDraft = blankStory(view.defaultSections);
        paintBuilder(mount, view, h);
      }),
    );
  }
  body.append(actions);

  card.append(body);
  mount.append(card);
}

/* ── the report ─────────────────────────────────────────────────────────── */

/**
 * One stored run, laid out.
 *
 * 🔴 Everything here comes out of `snapshot`. There is no second fetch and no
 * arithmetic — if this function computed a total, the screen and the stored
 * report could disagree, and the stored one is the one that was acted on.
 */
function paintReport(mount, view, { story, run, snapshot }) {
  mount.replaceChildren();
  if (!snapshot || !Array.isArray(snapshot.sections)) {
    mount.append(errorBox("That run could not be shown", "the server returned a run with no sections in it"));
    return;
  }

  const card = el("div", "st-card");
  const head = el("header");
  head.append(el("h3", null, snapshot.storyName ?? story?.name ?? "Story"));
  head.append(el("span", "chip", snapshot.trigger === "schedule" ? "weekly schedule" : "run by hand"));
  head.append(el("span", "st-grow"));
  head.append(button("Close", "btn tiny ghost", () => mount.replaceChildren()));
  card.append(head);

  const body = el("div", "st-body");

  const meta = el("div", "st-repmeta");
  const metaBit = (label, value) => {
    const d = el("div");
    d.append(el("b", null, value));
    d.append(el("span", null, label));
    return d;
  };
  meta.append(metaBit("period covered", snapshot.periodLabel ?? `${snapshot.periodFrom} to ${snapshot.periodTo}`));
  meta.append(metaBit("days", String(snapshot.periodDays ?? "")));
  // The label was frozen into the snapshot when it was taken, so it says the
  // same thing here as it does in the exported file.
  meta.append(metaBit("run on", snapshot.generatedLabel ?? dateText(view.ctx, snapshot.generatedAt)));
  if (snapshot.workspaceName) meta.append(metaBit("workspace", snapshot.workspaceName));
  body.append(meta);

  body.append(
    el(
      "p",
      "st-muted",
      "This is the run exactly as it was stored. Running the story again writes a new one and leaves this untouched.",
    ),
  );

  body.append(exportRow(view, run));

  const report = el("div", "st-report");
  for (const sec of snapshot.sections) report.append(sectionBlock(sec, view));
  body.append(report);

  card.append(body);
  mount.append(card);
}

function exportRow(view, run) {
  const box = el("div");
  const slot = el("div");
  const row = el("div", "st-actions");
  row.append(
    busyButton("Export this run", "Writing…", "btn", async () => {
      slot.replaceChildren();
      if (!run?.id) {
        slot.append(errorBox("This run cannot be exported", "the server did not say which run this is"));
        return;
      }
      let r;
      try {
        r = await view.api.exportRun(run.id);
      } catch (err) {
        slot.append(errorBox("The file could not be written", reasonFrom(null, err)));
        return;
      }
      if (!r?.ok) {
        slot.append(errorBox("The file could not be written", reasonFrom(r)));
        return;
      }
      const out = el("div");
      out.append(
        el(
          "p",
          "st-hint",
          "Written as one self-contained HTML file. Open it in your browser and choose Print, then \"Save as PDF\" — that is how it becomes a PDF. It carries no fonts, images or scripts, so it opens with no internet.",
        ),
      );
      out.append(pathField(r.file));
      slot.replaceChildren(out);
    }),
  );
  row.append(el("span", "st-hint", "an HTML file that prints to PDF from your browser"));
  box.append(row, slot);
  return box;
}

function sectionBlock(sec, view) {
  const block = el("div", "st-sec");
  block.append(el("h4", null, sec.label ?? sec.kind));

  if (sec.error) {
    block.append(el("p", "st-inline-err", sec.error));
    return block;
  }
  if (sec.basis) block.append(el("p", "st-basis", `Counted from ${sec.basis}.`));

  if (Array.isArray(sec.figures) && sec.figures.length) {
    const figs = el("div", "st-figs");
    for (const f of sec.figures) {
      const fig = el("div", "st-fig");
      fig.append(el("div", "v", f.display));
      fig.append(el("div", "l", f.label));
      if (f.note) fig.append(el("div", "n", f.note));
      figs.append(fig);
    }
    block.append(figs);
  }

  if (!Array.isArray(sec.rows) || !sec.rows.length) {
    block.append(el("p", "st-none", sec.empty ?? "Nothing to list."));
    return block;
  }

  const columns = Array.isArray(sec.columns) ? sec.columns : [];
  const linkKey = sec.link === "customer" ? "name" : sec.link === "decision" ? "title" : null;
  const linkAt = linkKey ? columns.findIndex((c) => c.key === linkKey) : -1;

  const scroll = el("div", "st-scroll");
  const tbl = el("table", "st-tbl");
  const thead = el("thead");
  const hrow = el("tr");
  for (const c of columns) hrow.append(el("th", c.numeric ? "num" : null, c.label));
  thead.append(hrow);
  tbl.append(thead);

  const tbody = el("tbody");
  for (const r of sec.rows) {
    const tr = el("tr");
    (r.cells ?? []).forEach((cell, i) => {
      const td = el("td", columns[i]?.numeric ? "num" : null);
      if (i === linkAt && r.id) {
        // The one clickable thing in a row, so a row can be read without being
        // a target. It goes to the record the figure was counted from.
        td.append(
          button(String(cell ?? ""), "st-open", () => {
            view.ctx.go(sec.link === "customer" ? `customers/${r.id}` : `decisions/${r.id}`);
          }),
        );
      } else {
        td.textContent = String(cell ?? "");
      }
      tr.append(td);
    });
    tbody.append(tr);
  }
  tbl.append(tbody);
  scroll.append(tbl);
  block.append(scroll);

  if (Number(sec.rowsTotal) > sec.rows.length) {
    block.append(
      el(
        "p",
        "st-trunc",
        `Showing the ${sec.rows.length} most recent of ${sec.rowsTotal}. The figures above count all ${sec.rowsTotal}.`,
      ),
    );
  }
  return block;
}
