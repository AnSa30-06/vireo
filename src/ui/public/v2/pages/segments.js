// v2 / Segments — saved customer groups, and the rule behind every one of them.
//
// WHY THIS SCREEN IS BUILT THE WAY IT IS
//
// The competitor meters "saved segments" and "create segments with AI" on every pricing
// tier, so this is core surface. But the thing they meter is also the thing that goes
// wrong quietly: a group built from a sentence, stored as opaque criteria, and then used
// for months by people who never saw the rule. A segment whose rule you cannot see is a
// segment you cannot trust — so on this screen the rule is never hidden:
//
//   1. THE RULE IS ALWAYS ON SCREEN, in English, above the count it produced. Not behind
//      an "edit" click. The sentence and the number are read together or not at all.
//   2. THE COUNT IS PREVIEWED BEFORE SAVING. You see who matches while you are still
//      editing, and you see the matching customers by name, not just a total.
//   3. A DESCRIPTION BECOMES EDITABLE CRITERIA, NEVER A SAVED SEGMENT. Typed text lands
//      in the builder as a proposal with a Use / Discard choice, and the reader says
//      which of your words it did not use. Nothing is applied invisibly.
//
// 🔴 WHERE THE MATCHING HAPPENS, AND WHY IT IS NOT HERE. Every count, every sample and
// every saved rule on this page is produced by src/decisions/segments.mjs, through the
// six decisionsSegment* routes. This file does no matching of its own. An earlier build
// matched locally, which meant two implementations of the same rule — the one that
// counted while you typed and the one that would eventually be stored. Two of them can
// only drift, and a segment whose preview disagrees with its saved count is the exact
// failure this screen exists to prevent. The count under the builder and the count beside
// the saved row now come from one function on the server.
//
// WHAT THE SERVER OWNS, so this file cannot contradict it:
//   * THE FIELD LIST AND THE OPERATORS. Fetched from decisionsSegments, never written
//     here. A menu offering a rule the server would refuse is a dead end the user finds
//     by hitting it.
//   * THE GROUNDED VALUES. Plans, owners and states come from the imported data, so the
//     builder cannot offer a plan this workspace does not have.
//   * THE DESCRIPTION READER. decisionsSegmentDescribe uses a model when one is connected
//     and an offline phrase list when none is, and says which it used. This page prints
//     that answer rather than deciding it.
//
// Every string reaches the DOM through textContent. Customer names pass through this
// page; innerHTML is never used, the same rule as app.js, decisions.js and the rest of v2.

export const title = "Segments";

/* ══ THE BACKEND ═══════════════════════════════════════════════════════════
 *
 * The single seam between this screen and the server. Every route it names is
 * real; a failure comes back as {ok:false, error} and is printed in the server's
 * own words rather than being turned into a friendlier sentence that says less.
 */
function backend(ctx) {
  // 🔴 EVERY ROUTE NAME IS A LITERAL INSIDE ITS OWN ctx.api(...) CALL, never a
  // variable passed to a helper. tests/unit/v2-ui.test.mjs checks that the
  // routes this page calls exist by reading this source for quoted route names
  // in api() calls. A name routed through a helper slips past that check, and
  // the first sign of a typo would be an empty section on screen, not a failing
  // test. (That scan reads comments too, so this one quotes no route name.)
  //
  // The server only parses a request body for POST, so every write and the
  // preview go out as POST. A read with no arguments stays a GET.
  const post = (body) => ({ method: "POST", body });
  return {
    list: () => ctx.api("decisionsSegments"),
    preview: (groups, limit) => ctx.api("decisionsSegmentPreview", post({ groups, limit })),
    create: (segment) => ctx.api("decisionsSegmentCreate", post({ name: segment.name, groups: segment.groups })),
    update: (segment) =>
      ctx.api("decisionsSegmentUpdate", post({ id: segment.id, name: segment.name, groups: segment.groups })),
    rename: (id, name) => ctx.api("decisionsSegmentUpdate", post({ id, name })),
    remove: (id) => ctx.api("decisionsSegmentDelete", post({ id })),
    describe: (text) => ctx.api("decisionsSegmentDescribe", post({ text })),
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

function select(options, value, onChange) {
  const s = el("select", "sg-sel");
  for (const [v, label] of options) {
    const o = el("option", null, label);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value));
  return s;
}

/**
 * ctx.fmt is written by a sibling agent in this same build, so every call is guarded:
 * a missing or throwing helper degrades to a readable fallback rather than taking the
 * page down. money() takes a currency because the workspace is not always in dollars.
 */
function money(ctx, amount, currency) {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  const fn = ctx?.fmt?.money;
  if (typeof fn === "function") {
    try {
      const out = fn(Number(amount), currency);
      if (out != null && out !== "") return String(out);
    } catch {
      /* fall through to the plain number */
    }
  }
  return Math.round(Number(amount)).toLocaleString("en-US");
}

function dateText(ctx, iso) {
  if (!iso) return "";
  const fn = ctx?.fmt?.date;
  if (typeof fn === "function") {
    try {
      const out = fn(iso);
      if (out != null && out !== "") return String(out);
    } catch {
      /* fall through */
    }
  }
  return String(iso);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * Wait for typing to stop, then run.
 *
 * ⚠️ THE SEQUENCE NUMBER IS NOT DECORATION. Two previews can be in flight at
 * once, and the slower one can land last. Without the token the screen would
 * settle on the count for a rule the user has already edited away — the one
 * thing a preview must never do.
 */
function debounced(ms, fn) {
  let timer = null;
  let issued = 0;
  return (...args) => {
    clearTimeout(timer);
    const mine = ++issued;
    timer = setTimeout(() => fn(() => mine === issued, ...args), ms);
  };
}

/* ══ THE VOCABULARY, AS THE SERVER DESCRIBES IT ════════════════════════════
 *
 * `view.fields` and `view.ops` arrive from decisionsSegments. Nothing below
 * hardcodes a field id or an operator: a field added on the server appears here
 * with no change to this file, and one removed stops being offered.
 */

const fieldById = (view, id) => view.fields.find((f) => f.id === id) ?? null;
const opsFor = (view, field) => view.ops[field?.type] ?? view.ops.text ?? [];
const opEntry = (view, field, op) => opsFor(view, field).find(([v]) => v === op) ?? null;
const opLabel = (view, field, op) => opEntry(view, field, op)?.[1] ?? op;
/** The server says which operators take a value; blank/notblank/true/false do not. */
const needsValue = (view, field, op) => opEntry(view, field, op)?.[2] === true;

/** The values a choices field may take, as [value, label] pairs. */
function choicesFor(view, field) {
  const bag = view.choices?.[field?.choices];
  if (!bag) return [];
  if (Array.isArray(bag)) return bag.map((v) => [v, v]);
  return Object.entries(bag).map(([k, label]) => [k, String(label)]);
}

/** A rule the server would count. Incomplete rules are previewed as absent. */
function isComplete(view, rule) {
  const f = fieldById(view, rule?.field);
  if (!f) return false;
  if (!needsValue(view, f, rule.op)) return true;
  return String(rule.value ?? "").trim() !== "";
}

function activeGroups(view, seg) {
  return (seg?.groups ?? []).map((g) => (g?.rules ?? []).filter((r) => isComplete(view, r))).filter((g) => g.length > 0);
}

function countIncomplete(view, seg) {
  let n = 0;
  for (const g of seg?.groups ?? []) for (const r of g?.rules ?? []) if (!isComplete(view, r)) n++;
  return n;
}

/* ══ THE RULE, IN ENGLISH ══════════════════════════════════════════════════ */

function ruleWords(view, rule) {
  const f = fieldById(view, rule.field);
  if (!f) return `${rule.field} ?`;
  const op = opLabel(view, f, rule.op);
  if (!needsValue(view, f, rule.op)) return `${f.label} ${op}`;
  const raw = String(rule.value ?? "").trim();
  if (raw === "") return `${f.label} ${op} …`;
  if (f.type === "money") return `${f.label} ${op} ${money(view.ctx, Number(raw), view.currency)}`;
  if (f.type === "date") return `${f.label} ${op} ${dateText(view.ctx, raw)}`;
  if (f.choices === "labels") return `${f.label} ${op} ${view.choices?.labels?.[raw] ?? raw}`;
  return `${f.label} ${op} ${raw}`;
}

/**
 * The sentence above the count. Built as text nodes, never as markup: a plan or
 * an owner name is customer data and goes in through textContent like everything
 * else.
 */
function ruleSentence(view, seg) {
  const line = el("div", "sg-sentence");
  const groups = activeGroups(view, seg);

  if (!groups.length) {
    line.append(el("span", "sg-muted", "No rules yet — this matches every customer."));
    return line;
  }

  groups.forEach((rules, gi) => {
    if (gi > 0) line.append(el("span", "sg-join", "AND"));
    const wrap = el("span", "sg-grp");
    if (rules.length > 1) wrap.append(el("span", "sg-paren", "("));
    rules.forEach((r, ri) => {
      if (ri > 0) wrap.append(el("span", "sg-join or", "or"));
      wrap.append(el("span", "sg-rule", ruleWords(view, r)));
    });
    if (rules.length > 1) wrap.append(el("span", "sg-paren", ")"));
    line.append(wrap);
  });
  return line;
}

/* ══ STYLES ════════════════════════════════════════════════════════════════
 *
 * One stylesheet, injected once, everything scoped under .sg so it cannot reach
 * the shell or a sibling page. CSP allows this (style-src 'self' 'unsafe-inline').
 * Colours come only from tokens.css; the tints are color-mix over those same
 * tokens, so a browser that cannot mix drops the fill and the border still reads.
 */
const STYLE_ID = "v2-segments-style";
const CSS = `
.sg { display: flex; flex-direction: column; gap: var(--s4); max-width: 1120px; }
.sg-head { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.sg-head h2 { margin: 0; }
.sg-muted { color: var(--muted); font-size: var(--fs-sm); }
.sg-grow { flex: 1 1 auto; }

.sg-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.sg-card > header { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap;
  padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
.sg-card > header h3 { font-size: var(--fs-md); }
.sg-body { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.sg-body.flush { padding: 0; }

/* Amber, not red: nothing is broken, a thing is absent or not yet done. */
.sg-warn { display: flex; gap: var(--s3); align-items: flex-start;
  border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border-radius: var(--radius); padding: var(--s3) var(--s4); font-size: var(--fs-sm); }
.sg-warn b { color: var(--warn); font-weight: 650; }
.sg-warn p { margin: 0 0 6px; }
.sg-warn p:last-child { margin-bottom: 0; }
.sg-warn code { display: inline-block; color: var(--muted); word-break: break-word; }

/* Rule sentence: the load-bearing line on this screen, so it is never small. */
.sg-sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
  font-size: var(--fs-md); line-height: 1.7; }
.sg-grp { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sg-rule { background: var(--panel-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 2px 8px; }
.sg-join { font-size: var(--fs-xs); font-variant-caps: all-small-caps; letter-spacing: .07em;
  font-weight: 650; color: var(--muted); }
.sg-join.or { color: var(--accent); }
.sg-paren { color: var(--muted); }

.sg-count { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.sg-big { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.01em; }
.sg-stat { color: var(--muted); font-size: var(--fs-sm); }
.sg-stat b { color: var(--text); font-weight: 600; }
/* While a preview is in flight the old number is dimmed, never left looking current. */
.sg-count.pending { opacity: .45; }

/* Builder rows. A group is a bordered block; its rules stack inside it. */
.sg-group { border: 1px solid var(--border-soft); border-radius: var(--radius);
  padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.sg-andline { display: flex; align-items: center; gap: var(--s2); color: var(--muted); }
.sg-andline hr { flex: 1; border: 0; border-top: 1px solid var(--border-soft); margin: 0; }
.sg-row { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.sg-row .sg-orlead { width: 34px; flex: 0 0 34px; text-align: right; }

.sg-sel, .sg-in { background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 6px 9px; font-size: var(--fs-sm); }
.sg-sel:focus, .sg-in:focus { border-color: var(--muted); }
.sg-in { min-width: 150px; }
.sg-in.wide { flex: 1 1 220px; }
.sg-x { background: transparent; border: 0; color: var(--muted); font-size: var(--fs-md);
  line-height: 1; padding: 4px 7px; border-radius: var(--radius-sm); }
.sg-x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

.sg-ta { background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 9px 11px; font: inherit; font-size: var(--fs-sm);
  width: 100%; min-height: 66px; resize: vertical; }
.sg-ta:focus { border-color: var(--muted); }

/* Matching customers. A plain list of rows, not a table: two of the four columns
   are empty for most workspaces and an empty table cell reads as a bug. */
.sg-list { display: flex; flex-direction: column; }
.sg-item { display: flex; align-items: center; gap: var(--s3); padding: 9px var(--s4);
  border-top: 1px solid var(--border-soft); font-size: var(--fs-sm); text-align: left;
  background: transparent; border-left: 0; border-right: 0; border-bottom: 0; width: 100%; color: inherit; }
.sg-item:first-child { border-top: 0; }
.sg-item:hover { background: var(--panel-2); }
.sg-item .sg-nm { font-weight: 550; }
.sg-item .sg-meta { color: var(--muted); font-size: var(--fs-xs); }
.sg-item .sg-amt { margin-left: auto; font-variant-numeric: tabular-nums; }

.sg-seg { border-top: 1px solid var(--border-soft); padding: var(--s3) var(--s4);
  display: flex; flex-direction: column; gap: var(--s2); }
.sg-seg:first-child { border-top: 0; }
.sg-segtop { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
.sg-segtop h4 { font-size: var(--fs-md); }
.sg-tag { font-size: var(--fs-xs); border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
  color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-radius: var(--radius-pill); padding: 1px 9px; white-space: nowrap; }
.sg-actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }

.sg-prop { border: 1px dashed color-mix(in srgb, var(--accent) 50%, var(--border));
  background: color-mix(in srgb, var(--accent) 7%, transparent);
  border-radius: var(--radius); padding: var(--s3); display: flex; flex-direction: column; gap: var(--s2); }
.sg-prop h4 { font-size: var(--fs-sm); }
.sg-words { display: flex; flex-wrap: wrap; gap: 5px; }
.sg-word { font-size: var(--fs-xs); border: 1px solid var(--border); border-radius: var(--radius-pill);
  padding: 1px 8px; color: var(--muted); }
.sg-inline-err { color: var(--danger); font-size: var(--fs-sm); }
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
 * The saved segments live in the workspace database now, so nothing about them
 * is held here. The half-built draft still is: a trip to Customers and back
 * should not throw away a rule that was never saved.
 */

const blankSegment = () => ({ id: null, name: "", groups: [{ rules: [] }] });

/** Structured clone without the risk of a shared reference between list and draft. */
const cloneSeg = (s) => ({
  id: s.id ?? null,
  name: s.name ?? "",
  createdAt: s.createdAt,
  groups: (s.groups ?? []).map((g) => ({ rules: (g.rules ?? []).map((r) => ({ ...r })) })),
});

/* ══ RENDER ════════════════════════════════════════════════════════════════ */

export async function render(root, ctx) {
  ensureStyles();
  root.replaceChildren();

  const page = el("div", "sg");
  root.append(page);

  const loading = el("div", null);
  for (let i = 0; i < 3; i++) loading.append(el("div", "skeleton block"));
  page.append(loading);

  // One call: the saved segments with their live counts, the field vocabulary
  // the builder offers, and the values a rule may name. Its failure ends the
  // page, because without the vocabulary there is no builder to show.
  const api = backend(ctx);
  let data;
  try {
    data = await api.list();
  } catch (err) {
    loading.remove();
    page.append(errorBox("Segments could not be read", reasonFrom(null, err)));
    return;
  }
  loading.remove();

  if (!data?.ok) {
    // needsWorkspace is normally caught by the shell, but a direct #/segments hit
    // can still land here before status has been read.
    page.append(
      errorBox(data?.needsWorkspace ? "No workspace is open" : "Segments could not be read", reasonFrom(data)),
    );
    return;
  }

  // Everything the sub-renderers need, in one bag, so no function reaches for a
  // closure two levels up.
  const view = {
    ctx,
    api,
    fields: Array.isArray(data.fields) ? data.fields : [],
    ops: data.ops && typeof data.ops === "object" ? data.ops : {},
    choices: data.choices && typeof data.choices === "object" ? data.choices : {},
    currency: data.currency ?? "USD",
    total: Number(data.total) || 0,
    hasRun: data.hasRun === true,
    asOf: data.asOf ?? null,
    segments: Array.isArray(data.segments) ? data.segments : [],
  };

  if (!view.fields.length) {
    page.append(errorBox("Segments could not be read", "the server returned no fields to build a rule from"));
    return;
  }

  if (!view.total) {
    const box = el("div", "empty");
    box.append(el("h3", null, "No customers to group yet"));
    box.append(el("p", null, "A segment is a rule over your customer list, and this workspace has not imported one. Load a folder of CSVs or seed the demo data first."));
    box.append(button("Go to Data", "btn", () => ctx.go("data")));
    page.append(header(view), box);
    return;
  }

  page.append(header(view));
  if (!view.hasRun) page.append(noRunBanner());

  const savedMount = el("div");
  const builderMount = el("div");
  page.append(savedMount, builderMount);

  if (!ctx.state.segmentDraft) ctx.state.segmentDraft = blankSegment();

  /** Re-read the saved list from the server. The server is the only copy. */
  const reloadSaved = async () => {
    try {
      const fresh = await api.list();
      if (fresh?.ok) view.segments = Array.isArray(fresh.segments) ? fresh.segments : [];
      else view.notice = reasonFrom(fresh);
    } catch (err) {
      view.notice = reasonFrom(null, err);
    }
    paintSaved(savedMount, view, reloadSaved, editDraft);
  };

  function editDraft(seg) {
    ctx.state.segmentDraft = cloneSeg(seg);
    paintBuilder(builderMount, view, reloadSaved);
    builderMount.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  paintSaved(savedMount, view, reloadSaved, editDraft);
  paintBuilder(builderMount, view, reloadSaved);
}

/* ── header and banners ─────────────────────────────────────────────────── */

function header(view) {
  const h = el("div", "sg-head");
  h.append(el("h2", null, "Segments"));
  const bits = [plural(view.total, "customer", "customers")];
  if (view.asOf) bits.push(`as of ${dateText(view.ctx, view.asOf)}`);
  h.append(el("span", "sg-muted", bits.join(" · ")));
  return h;
}

function noRunBanner() {
  const box = el("div", "sg-warn");
  const body = el("div");
  const p = el("p");
  p.append(el("b", null, "No analysis has run in this workspace. "));
  p.append(
    document.createTextNode(
      "State, Watch items and Data is stale are empty for every customer until one does, so a rule on those three fields will match nobody. Name, ARR, Plan, Owner, renewal and Open decisions all work now.",
    ),
  );
  body.append(p);
  box.append(body);
  return box;
}

/** Always says WHAT failed, in the server's own words. .err styles its own <code>. */
function errorBox(heading, detail) {
  const box = el("div", "err");
  box.append(el("strong", null, heading));
  box.append(el("code", null, detail));
  return box;
}

/* ── saved segments ─────────────────────────────────────────────────────── */

function paintSaved(mount, view, reload, onEdit) {
  mount.replaceChildren();

  // A message left by the last action that the server refused. Shown once, then
  // cleared, so it never outlives the thing it describes.
  if (view.notice) {
    const note = el("div", "sg-warn");
    note.append(el("div", null, view.notice));
    mount.append(note);
    view.notice = "";
  }

  const card = el("div", "sg-card");
  const head = el("header");
  head.append(el("h3", null, "Your segments"));
  head.append(el("span", "sg-grow"));
  head.append(el("span", "sg-muted", view.segments.length ? plural(view.segments.length, "segment", "segments") : "none yet"));
  card.append(head);

  if (!view.segments.length) {
    const body = el("div", "sg-body");
    body.append(el("p", "sg-muted", "Build a rule below and save it. Saved segments are kept in this workspace and their counts are recomputed from your data every time this page opens."));
    card.append(body);
    mount.append(card);
    return;
  }

  const body = el("div", "sg-body flush");
  for (const seg of view.segments) body.append(segmentRow(seg, view, reload, onEdit));
  card.append(body);
  mount.append(card);
}

function segmentRow(seg, view, reload, onEdit) {
  const wrap = el("div", "sg-seg");

  const top = el("div", "sg-segtop");
  top.append(el("h4", null, seg.name || "Untitled segment"));
  // A stored rule the server can no longer run. It is named rather than hidden:
  // a segment silently reporting nothing is worse than one reporting a fault.
  if (seg.error) top.append(el("span", "sg-tag", "Cannot be run"));
  top.append(el("span", "sg-grow"));

  const actions = el("div", "sg-actions");
  const listMount = el("div");
  let open = false;
  const shut = seg.count == null ? "No count" : `${seg.count} matching`;
  const toggle = button(shut, "btn tiny", async () => {
    open = !open;
    toggle.textContent = open ? "Hide list" : shut;
    listMount.replaceChildren();
    if (!open) return;
    // Fetched only when asked for: a page of saved segments must not pull a
    // customer list for each of them before anybody has looked.
    listMount.append(el("div", "sg-item sg-muted", "Reading…"));
    let res;
    try {
      res = await view.api.preview(seg.groups, 60);
    } catch (err) {
      res = null;
      listMount.replaceChildren(errorBox("That segment could not be counted", reasonFrom(null, err)));
      return;
    }
    listMount.replaceChildren();
    if (!res?.ok) listMount.append(errorBox("That segment could not be counted", reasonFrom(res)));
    else listMount.append(matchedList(res, view));
  });
  actions.append(toggle);
  actions.append(button("Edit", "btn tiny", () => onEdit(seg)));
  actions.append(
    button("Delete", "btn tiny danger", async () => {
      let res;
      try {
        res = await view.api.remove(seg.id);
      } catch (err) {
        res = null;
        view.notice = `“${seg.name || "Untitled segment"}” was not deleted: ${reasonFrom(null, err)}`;
      }
      if (res && !res.ok) view.notice = `“${seg.name || "Untitled segment"}” was not deleted: ${reasonFrom(res)}`;
      // Reloaded either way, so the list on screen is what the workspace holds
      // rather than what this page assumed would happen.
      await reload();
    }),
  );
  top.append(actions);

  wrap.append(top);
  wrap.append(ruleSentence(view, seg));

  if (seg.error) {
    wrap.append(el("div", "sg-inline-err", seg.error));
    return wrap;
  }

  const stats = el("div", "sg-count");
  const n = el("span", "sg-stat");
  n.append(el("b", null, String(seg.count ?? 0)));
  n.append(document.createTextNode(` of ${view.total} customers`));
  stats.append(n);
  const a = el("span", "sg-stat");
  a.append(el("b", null, seg.arrLabel ?? money(view.ctx, seg.arr, view.currency)));
  a.append(document.createTextNode(" ARR in this group"));
  stats.append(a);
  wrap.append(stats, listMount);

  return wrap;
}

/**
 * The matching customers, by name. A count nobody can open is a count nobody
 * checks. `res` is a preview reply: its sample is a slice of the very set it
 * counted, so the names and the number here cannot disagree.
 */
function matchedList(res, view) {
  const box = el("div", "sg-card");
  const list = el("div", "sg-list");
  const sample = Array.isArray(res.sample) ? res.sample : [];
  for (const c of sample) {
    const row = el("button", "sg-item");
    row.type = "button";
    const left = el("div");
    left.append(el("div", "sg-nm", c.name ?? c.id));
    const meta = [c.plan, c.owner ? `owner ${c.owner}` : "", c.labelText ?? ""].filter(Boolean).join(" · ");
    if (meta) left.append(el("div", "sg-meta", meta));
    row.append(left);
    // arrLabel is the server's own formatting, in the workspace currency. Using
    // it instead of reformatting arr is what stops this row and the Customers
    // page disagreeing about the same amount.
    row.append(el("span", "sg-amt", c.arrLabel ?? money(view.ctx, c.arr, view.currency)));
    row.addEventListener("click", () => view.ctx.go(`customers/${c.id}`));
    list.append(row);
  }
  box.append(list);
  if (res.truncated) box.append(el("div", "sg-item sg-muted", `Showing the first ${sample.length} of ${res.count}.`));
  if (!sample.length) box.append(el("div", "sg-item sg-muted", "No customer matches this rule."));
  return box;
}

/* ── the builder ────────────────────────────────────────────────────────── */

function paintBuilder(mount, view, reloadSaved) {
  const ctx = view.ctx;
  const draft = ctx.state.segmentDraft;

  mount.replaceChildren();

  const card = el("div", "sg-card");
  const head = el("header");
  head.append(el("h3", null, draft.id ? "Edit segment" : "New segment"));
  head.append(el("span", "sg-grow"));
  head.append(
    button("Clear", "btn tiny ghost", () => {
      ctx.state.segmentDraft = blankSegment();
      paintBuilder(mount, view, reloadSaved);
    }),
  );
  card.append(head);

  const body = el("div", "sg-body");

  // name ---------------------------------------------------------------------
  const nameRow = el("div", "sg-row");
  const nameIn = el("input", "sg-in wide");
  nameIn.type = "text";
  nameIn.placeholder = "Name this segment";
  nameIn.value = draft.name ?? "";
  // Typing the name must not rebuild the rows underneath, or the caret jumps.
  nameIn.addEventListener("input", () => {
    draft.name = nameIn.value;
  });
  nameRow.append(nameIn);
  body.append(nameRow);

  // description box ----------------------------------------------------------
  const proposalMount = el("div");
  body.append(describeBox(view, proposalMount, () => rebuildRules()), proposalMount);

  // rules --------------------------------------------------------------------
  const rulesMount = el("div");
  body.append(rulesMount);

  // preview ------------------------------------------------------------------
  const previewMount = el("div");
  body.append(previewMount);

  // save ---------------------------------------------------------------------
  const saveRow = el("div", "sg-row");
  const saveErr = el("div", "sg-inline-err");
  saveErr.hidden = true;
  const fail = (text) => {
    saveErr.textContent = text;
    saveErr.hidden = false;
  };
  const saveBtn = button(draft.id ? "Update segment" : "Save segment", "btn-primary", async () => {
    saveErr.hidden = true;
    const name = String(draft.name ?? "").trim();
    // Checked here so the common mistakes answer instantly, and checked again on
    // the server, which is the only check that decides what gets stored.
    if (!name) {
      fail("Give the segment a name first.");
      nameIn.focus();
      return;
    }
    if (!activeGroups(view, draft).length) {
      fail("Add at least one complete rule — a segment with no rule is the whole customer list.");
      return;
    }

    const seg = cloneSeg(draft);
    seg.name = name;
    saveBtn.disabled = true;
    let res;
    try {
      res = seg.id ? await view.api.update(seg) : await view.api.create(seg);
    } catch (err) {
      saveBtn.disabled = false;
      fail(reasonFrom(null, err));
      return;
    }
    saveBtn.disabled = false;
    if (!res?.ok) {
      // The server's refusal is shown word for word and the draft is kept, so
      // the work is still on screen to fix rather than thrown away.
      fail(reasonFrom(res));
      return;
    }

    ctx.state.segmentDraft = blankSegment();
    await reloadSaved();
    paintBuilder(mount, view, reloadSaved);
  });
  saveRow.append(saveBtn, el("span", "sg-grow"));
  body.append(saveRow, saveErr);

  card.append(body);
  mount.append(card);

  /** Redraw the rule rows and the preview. Called whenever the rule shape changes. */
  function rebuildRules() {
    rulesMount.replaceChildren();
    draft.groups ??= [{ rules: [] }];
    if (!draft.groups.length) draft.groups.push({ rules: [] });

    draft.groups.forEach((group, gi) => {
      if (gi > 0) {
        const line = el("div", "sg-andline");
        line.append(el("hr"));
        line.append(el("span", "sg-join", "AND"));
        line.append(el("hr"));
        rulesMount.append(line);
      }
      rulesMount.append(groupBlock(group, gi));
    });

    const add = el("div", "sg-row");
    add.append(
      button("+ AND another condition", "btn tiny", () => {
        draft.groups.push({ rules: [newRule(view)] });
        rebuildRules();
      }),
    );
    rulesMount.append(add);

    // The ceiling, stated where the fields are chosen rather than in a README.
    // A user who goes looking for "industry" should find out why it is missing
    // here, not conclude the field list is arbitrary.
    const ceiling = el("p", "sg-muted");
    ceiling.textContent =
      "These are every field the customer list returns. Industry, segment, seat count, tenure and contacts exist on a customer but only one customer at a time, so counting a rule on them would need one request per customer and they are left out rather than guessed at.";
    rulesMount.append(ceiling);

    requestPreview();
  }

  function groupBlock(group, gi) {
    const box = el("div", "sg-group");
    group.rules ??= [];

    if (!group.rules.length) {
      const row = el("div", "sg-row");
      row.append(
        button("+ Add a rule", "btn tiny", () => {
          group.rules.push(newRule(view));
          rebuildRules();
        }),
      );
      if (draft.groups.length > 1) {
        row.append(el("span", "sg-grow"));
        row.append(
          button("Remove", "btn tiny ghost", () => {
            draft.groups.splice(gi, 1);
            rebuildRules();
          }),
        );
      }
      box.append(row);
      return box;
    }

    group.rules.forEach((rule, ri) => box.append(ruleRow(group, rule, ri)));

    const foot = el("div", "sg-row");
    foot.append(
      button("+ OR", "btn tiny", () => {
        group.rules.push(newRule(view));
        rebuildRules();
      }),
    );
    box.append(foot);
    return box;
  }

  function ruleRow(group, rule, ri) {
    const row = el("div", "sg-row");
    row.append(el("span", "sg-orlead sg-join or", ri === 0 ? "" : "or"));

    const field = fieldById(view, rule.field) ?? view.fields[0];

    row.append(
      select(
        view.fields.map((f) => [f.id, f.needsRun && !view.hasRun ? `${f.label} (needs a run)` : f.label]),
        field.id,
        (v) => {
          // The operator list and the value control both depend on the field, so
          // the row is rebuilt rather than patched. Resetting to the first legal
          // operator avoids "Plan is at least".
          const nf = fieldById(view, v);
          rule.field = v;
          rule.op = opsFor(view, nf)[0]?.[0] ?? "is";
          rule.value = "";
          rebuildRules();
        },
      ),
    );

    row.append(
      select(opsFor(view, field), rule.op, (v) => {
        rule.op = v;
        if (!needsValue(view, field, v)) rule.value = "";
        rebuildRules();
      }),
    );

    if (needsValue(view, field, rule.op)) row.append(valueControl(field, rule));

    row.append(el("span", "sg-grow"));
    const x = button("✕", "sg-x", () => {
      group.rules.splice(ri, 1);
      // A group emptied of rules disappears unless it is the last one — an empty
      // bordered box with nothing in it is a rule the user cannot read.
      if (!group.rules.length && draft.groups.length > 1) {
        draft.groups.splice(draft.groups.indexOf(group), 1);
      }
      rebuildRules();
    });
    x.title = "Remove this rule";
    row.append(x);
    return row;
  }

  function valueControl(field, rule) {
    // The value is edited live, so the preview must update WITHOUT redrawing this
    // input — otherwise the caret jumps on every keystroke. Only the preview runs.
    const options = choicesFor(view, field);
    if (options.length && (rule.op === "is" || rule.op === "isnot")) {
      if (!rule.value) rule.value = options[0][0];
      return select(options, rule.value, (v) => {
        rule.value = v;
        requestPreview();
      });
    }
    if (field.choices === "labels" && !options.length) return el("span", "sg-muted", "no states available");

    const input = el("input", "sg-in");
    input.type = field.type === "money" || field.type === "number" ? "number" : field.type === "date" ? "date" : "text";
    if (field.type === "money") input.placeholder = "50000";
    if (field.type === "number") input.placeholder = "0";
    input.value = rule.value ?? "";
    input.addEventListener("input", () => {
      rule.value = input.value;
      requestPreview();
    });
    return input;
  }

  /* ── the preview ────────────────────────────────────────────────────────
   *
   * The count, before saving. This is the reason the screen exists, and it is
   * the SERVER's count: the same function that will count the segment once it
   * is saved, so what you try is what you get.
   */

  let lastPreview = null;

  const runPreview = debounced(220, async (stillWanted) => {
    let res;
    try {
      res = await view.api.preview(draft.groups, 8);
    } catch (err) {
      res = { ok: false, error: reasonFrom(null, err) };
    }
    // A reply for a rule the user has already edited away must never land.
    if (!stillWanted()) return;
    lastPreview = res;
    paintPreview(false);
  });

  function requestPreview() {
    paintPreview(true);
    runPreview();
  }

  function paintPreview(pending) {
    previewMount.replaceChildren();

    const panel = el("div", "sg-card");
    const body2 = el("div", "sg-body");

    body2.append(el("div", "col-head", "This rule reads"));
    body2.append(ruleSentence(view, draft));

    const res = lastPreview;
    if (res && !res.ok) {
      body2.append(errorBox("This rule could not be counted", reasonFrom(res)));
      panel.append(body2);
      previewMount.append(panel);
      return;
    }

    const count = el("div", pending ? "sg-count pending" : "sg-count");
    count.append(el("span", "sg-big", res ? String(res.count) : "…"));
    count.append(el("span", "sg-stat", `of ${view.total} customers match`));
    const a = el("span", "sg-stat");
    a.append(el("b", null, res ? (res.arrLabel ?? money(ctx, res.arr, view.currency)) : "—"));
    a.append(document.createTextNode(" ARR"));
    count.append(a);
    const o = el("span", "sg-stat");
    o.append(el("b", null, res ? String(res.openDecisions ?? 0) : "—"));
    o.append(document.createTextNode(" open decisions"));
    count.append(o);
    body2.append(count);

    const incomplete = countIncomplete(view, draft);
    if (incomplete) {
      body2.append(
        el(
          "div",
          "sg-inline-err",
          `${plural(incomplete, "rule", "rules")} still need${incomplete === 1 ? "s" : ""} a value, so ${incomplete === 1 ? "it is" : "they are"} not being counted.`,
        ),
      );
    }

    panel.append(body2);
    // Eight is enough to recognise the group and short enough to read without
    // scrolling past the controls that produced it.
    if (res?.ok) panel.append(matchedList(res, view));
    previewMount.append(panel);
  }

  rebuildRules();
}

/** The row a "+ OR" or "+ AND" button starts from: the first field, first operator. */
function newRule(view) {
  const f = view.fields.find((x) => x.id === "arr") ?? view.fields[0];
  return { field: f.id, op: opsFor(view, f)[0]?.[0] ?? "is", value: "" };
}

/* ── the description box ────────────────────────────────────────────────── */

function describeBox(view, proposalMount, afterApply) {
  const box = el("div", "sg-card");
  const head = el("header");
  head.append(el("h3", null, "Describe the group"));
  head.append(el("span", "sg-grow"));
  head.append(el("span", "sg-muted", "never applied on its own"));
  box.append(head);

  const body = el("div", "sg-body");
  const ta = el("textarea", "sg-ta");
  ta.placeholder = "e.g. at risk customers over $50k renewing in 60 days";
  ta.setAttribute("aria-label", "Describe the group in plain English");
  body.append(ta);

  const row = el("div", "sg-row");
  const read = button("Read this", "btn", async () => {
    proposalMount.replaceChildren();
    const text = ta.value.trim();
    if (!text) return;

    read.disabled = true;
    proposalMount.append(el("p", "sg-muted", "Reading…"));
    let res;
    try {
      res = await view.api.describe(text);
    } catch (err) {
      res = { ok: false, error: reasonFrom(null, err) };
    }
    read.disabled = false;
    proposalMount.replaceChildren();
    if (!res?.ok) {
      proposalMount.append(errorBox("That description could not be read", reasonFrom(res)));
      return;
    }
    proposalMount.append(await proposalCard(res, view, afterApply));
  });
  row.append(read);
  body.append(row);

  const help = el("p", "sg-muted");
  help.textContent =
    "A model reads this when one is connected. When none is, a fixed list of phrases reads it in the workspace instead — and the answer says which of the two it was. Either way it only writes a plan, an owner or a state that already exists in your data, it tells you which of your words it did not use, and nothing is applied until you press Use.";
  body.append(help);

  box.append(body);
  return box;
}

async function proposalCard(read, view, afterApply) {
  const box = el("div", "sg-prop");
  const rules = Array.isArray(read.rules) ? read.rules : [];
  const notes = Array.isArray(read.notes) ? read.notes : [];
  const ignored = Array.isArray(read.ignored) ? read.ignored : [];

  // WHO read it, stated before what it found. A user who thinks a model wrote
  // these rules judges them differently from one who knows a phrase list did.
  const who = el("div", "sg-muted");
  if (read.source === "model") {
    who.append(el("b", null, "Read by a model"));
    if (read.model) who.append(document.createTextNode(` (${read.model})`));
    who.append(document.createTextNode(". Every rule below was checked against your own data before it was offered."));
  } else {
    who.append(el("b", null, "Read offline, without a model"));
    who.append(
      document.createTextNode(
        read.modelError
          ? `. The model could not be used: ${read.modelError} A fixed list of phrases read it instead.`
          : ". A fixed list of phrases in this workspace read it.",
      ),
    );
  }
  box.append(who);

  if (!rules.length) {
    box.append(el("h4", null, "Nothing in that sentence matched a field"));
    box.append(
      el(
        "p",
        "sg-muted",
        "No rule was made, and nothing was changed. The reader understands amounts (over $50k), renewal windows (renewing in 60 days), the customer states in the State field, plan and owner names that exist in your data, open decisions and stale data.",
      ),
    );
    for (const note of notes) box.append(el("div", "sg-muted", note));
    if (ignored.length) box.append(ignoredWords(ignored));
    return box;
  }

  box.append(el("h4", null, `Proposed: ${plural(rules.length, "rule", "rules")}`));

  // The proposal is shown as the same sentence the saved segment will show, and
  // counted by the same route, so what is confirmed here and what appears in the
  // list are the same rule measured the same way.
  const proposed = { groups: rules.map((r) => ({ rules: [r] })) };
  box.append(ruleSentence(view, proposed));

  const countLine = el("div", "sg-stat", "Counting…");
  box.append(countLine);
  try {
    // Only the count is read here, so the smallest sample the route will give.
    const res = await view.api.preview(proposed.groups, 1);
    countLine.textContent = res?.ok
      ? `${res.count} of ${view.total} customers would match.`
      : `This could not be counted: ${reasonFrom(res)}`;
  } catch (err) {
    countLine.textContent = `This could not be counted: ${reasonFrom(null, err)}`;
  }

  for (const note of notes) box.append(el("div", "sg-muted", note));
  if (ignored.length) box.append(ignoredWords(ignored));

  const actions = el("div", "sg-actions");
  actions.append(
    button("Use these rules", "btn-primary", () => {
      const draft = view.ctx.state.segmentDraft;
      // Each rule becomes its own AND group. "at risk over $50k" is read the way
      // a person reads it — both, not either — and every one of them is now an
      // ordinary editable row.
      const existing = (draft.groups ?? []).filter((g) => (g.rules ?? []).some((r) => isComplete(view, r)));
      draft.groups = existing.concat(rules.map((r) => ({ rules: [{ ...r }] })));
      box.remove();
      afterApply();
    }),
  );
  actions.append(
    button("Discard", "btn ghost", () => {
      box.remove();
    }),
  );
  box.append(actions);

  return box;
}

function ignoredWords(words) {
  const wrap = el("div");
  wrap.append(el("div", "col-head", "Words I did not use"));
  const list = el("div", "sg-words");
  for (const w of words) list.append(el("span", "sg-word", w));
  wrap.append(list);
  return wrap;
}
