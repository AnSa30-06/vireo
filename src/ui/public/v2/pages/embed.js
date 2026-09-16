// v2 / Embed — the keys and data scopes behind the embeddable widget.
//
// TWO SURFACES, ONE FILE, ON PURPOSE. This module is both the management screen
// (loaded by the shell as pages/embed.js) and the widget's own script (loaded by
// /v2/embed-widget.html, which is a separate document with no shell around it).
// They share the fetch helper, the refusal renderer and the answer renderer, and
// sharing them is the point: the widget must render exactly what the preview on
// this screen renders, or the preview is a lie. The widget half boots itself at
// the very bottom, and ONLY when the host document says so.
//
// 🔴 WHAT THIS SCREEN IS ACTUALLY FOR, and the failure it is built around. An
// embed key is a secret you hand to somebody else's web page. The product this
// mechanism is modelled on documents a leak in its own docs: deleting a data
// scope leaves every key that used it alive with NO scope, so the widget quietly
// starts answering about the whole workspace. Nothing errors.
//
// So on this screen:
//   1. DELETING A SCOPE IN USE IS REFUSED, and the refusal names the keys. The
//      only way past it is a second, explicit button that says how many keys it
//      is about to revoke.
//   2. A KEY WHOSE SCOPE HAS GONE IS SHOWN AS ORPHANED, in red, saying it reads
//      nothing. It is never shown as "no scope" — that is the leak, written as a
//      label.
//   3. THE SECRET IS SHOWN ONCE. The server stores a hash and a 12-character
//      prefix, so no screen and no route can ever print it again.
//
// ⚠️ WHAT THE SNIPPET HONESTLY IS. Ledgerline's server is a loopback server with a
// per-launch token, so the embed works while Ledgerline is running on the machine
// that opens the page, and the token in the snippet changes every launch. The
// key is what decides WHAT the widget can read; the token is what decides
// whether it can reach Ledgerline at all. Both facts are printed next to the snippet
// rather than left for somebody to discover.
//
// Every string reaches the DOM through textContent. Customer names, scope names
// and server errors all pass through here; innerHTML is never used.

export const title = "Embed";

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

function field(labelText, control) {
  const wrap = el("label", "eb-field");
  wrap.append(el("span", "eb-lab", labelText));
  wrap.append(control);
  return wrap;
}

function input(value, placeholder, onInput, type = "text") {
  const i = el("input", "eb-in");
  i.type = type;
  i.value = value == null ? "" : String(value);
  if (placeholder) i.placeholder = placeholder;
  if (onInput) i.addEventListener("input", () => onInput(i.value));
  return i;
}

function select(options, value, onChange) {
  const s = el("select", "eb-sel");
  for (const [v, label] of options) {
    const o = el("option", null, label);
    o.value = v;
    s.append(o);
  }
  s.value = value == null ? "" : String(value);
  if (onChange) s.addEventListener("change", () => onChange(s.value));
  return s;
}

function checkbox(labelText, checked, onChange) {
  const wrap = el("label", "eb-check");
  const box = el("input");
  box.type = "checkbox";
  box.checked = !!checked;
  box.addEventListener("change", () => onChange(box.checked));
  wrap.append(box);
  wrap.append(el("span", null, labelText));
  return wrap;
}

/** A route that answered ok:false, or threw, said one of these. Never invent a third. */
const reasonFrom = (res, err) =>
  err ? String(err?.message ?? err) : String(res?.error ?? "the server did not say what went wrong");

/** The .err box: prose in a <strong>, then the server's own words verbatim. */
function errorBox(what, detail) {
  const box = el("div", "err");
  box.append(el("strong", null, what));
  if (detail) box.append(el("code", null, detail));
  return box;
}

function emptyBox(heading, body, action) {
  const box = el("div", "empty");
  box.append(el("h3", null, heading));
  box.append(el("p", null, body));
  if (action) box.append(action);
  return box;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ══ THE BACKEND ═══════════════════════════════════════════════════════════
 *
 * 🔴 EVERY ROUTE NAME IS A QUOTED LITERAL INSIDE ITS OWN api(...) CALL, never a
 * variable handed to a helper. tests/unit/v2-ui.test.mjs proves the routes this
 * file calls exist by reading this source for quoted names in api() calls; a
 * name routed through a variable slips past that check, and the first sign of a
 * typo would be an empty panel rather than a failing test.
 *
 * The server parses a request body only for POST, so every write and every
 * preview goes out as POST. The one read with no arguments stays a GET.
 */
function backend(api) {
  const post = (body) => ({ method: "POST", body });
  return {
    overview: () => api("decisionsEmbedOverview"),
    previewScope: (groups, intents) => api("decisionsEmbedScopePreview", post({ groups, intents })),
    createScope: (s) => api("decisionsEmbedScopeCreate", post({ name: s.name, groups: s.groups, intents: s.intents })),
    updateScope: (s) => api("decisionsEmbedScopeUpdate", post({ id: s.id, name: s.name, groups: s.groups, intents: s.intents })),
    deleteScope: (id, revokeKeys) => api("decisionsEmbedScopeDelete", post({ id, revokeKeys })),
    createKey: (k) =>
      api("decisionsEmbedKeyCreate", post({
        name: k.name,
        scopeId: k.scopeId,
        origins: k.origins,
        expiresAt: k.expiresAt,
        ratePerMinute: k.ratePerMinute,
      })),
    revokeKey: (id, reason) => api("decisionsEmbedKeyRevoke", post({ id, reason })),
    deleteKey: (id) => api("decisionsEmbedKeyDelete", post({ id })),
  };
}

/** The widget's own two calls. Same literal rule, same reason. */
function widgetBackend(api) {
  const post = (body) => ({ method: "POST", body });
  return {
    info: (args) => api("decisionsEmbedInfo", post(args)),
    ask: (args) => api("decisionsEmbedAsk", post(args)),
  };
}

/* ══ STYLES ════════════════════════════════════════════════════════════════
 *
 * One stylesheet, injected once, everything scoped under .eb so it cannot reach
 * the shell or a sibling page. CSP allows this (style-src 'self' 'unsafe-inline').
 * Every colour is a token or a color-mix over a token: a browser that cannot mix
 * drops the tint and the border still carries the meaning.
 */
const STYLE_ID = "v2-embed-style";
const CSS = `
.eb { display: flex; flex-direction: column; gap: var(--s4); max-width: 1120px; }
.eb-head h2 { margin: 0; }
.eb-muted { color: var(--muted); font-size: var(--fs-sm); }
.eb-grow { flex: 1 1 auto; }
.eb-row { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }

.eb-card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); }
.eb-card > header { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap;
  padding: var(--s3) var(--s4); border-bottom: 1px solid var(--border); }
.eb-card > header h3 { font-size: var(--fs-md); margin: 0; }
.eb-body { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.eb-body.flush { padding: 0; }

.eb-item { border-top: 1px solid var(--border-soft); padding: var(--s3) var(--s4);
  display: flex; flex-direction: column; gap: 6px; }
.eb-item:first-child { border-top: 0; }
.eb-item h4 { font-size: var(--fs-md); margin: 0; }
.eb-item.dead { opacity: .62; }
.eb-facts { display: flex; flex-wrap: wrap; gap: var(--s1) var(--s3);
  color: var(--muted); font-size: var(--fs-xs); }
.eb-facts b { color: var(--text); font-weight: 600; }

.eb-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); }
.eb-lab { color: var(--muted); font-size: var(--fs-xs);
  font-variant-caps: all-small-caps; letter-spacing: .07em; font-weight: 650; }
.eb-in, .eb-sel, .eb-ta { background: var(--bg); border: 1px solid var(--border); color: var(--text);
  border-radius: var(--radius-sm); padding: 6px 9px; font-size: var(--fs-sm); font-family: inherit; }
.eb-in:focus, .eb-sel:focus, .eb-ta:focus { border-color: var(--muted); }
.eb-ta { width: 100%; min-height: 58px; resize: vertical; }
.eb-grid { display: flex; flex-wrap: wrap; gap: var(--s3); }
.eb-grid > .eb-field { flex: 1 1 190px; }

.eb-check { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-sm); }
.eb-checks { display: flex; flex-direction: column; gap: 5px;
  border: 1px solid var(--border-soft); border-radius: var(--radius); padding: var(--s3); }

.eb-rule { display: flex; gap: var(--s2); align-items: center; flex-wrap: wrap; }
.eb-x { background: transparent; border: 0; color: var(--muted); font-size: var(--fs-md);
  line-height: 1; padding: 4px 7px; border-radius: var(--radius-sm); }
.eb-x:hover { color: var(--danger); background: color-mix(in srgb, var(--danger) 12%, transparent); }

/* Amber: nothing is broken, something is absent or about to be irreversible. */
.eb-warn { border: 1px solid color-mix(in srgb, var(--warn) 45%, var(--border));
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  border-radius: var(--radius); padding: var(--s3) var(--s4); font-size: var(--fs-sm);
  display: flex; flex-direction: column; gap: var(--s2); }
.eb-warn b { color: var(--warn); font-weight: 650; }
/* Red: a key that is dead, or a deletion that will kill keys. */
.eb-danger { border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--border));
  background: color-mix(in srgb, var(--danger) 10%, transparent);
  border-radius: var(--radius); padding: var(--s3) var(--s4); font-size: var(--fs-sm);
  display: flex; flex-direction: column; gap: var(--s2); }
.eb-danger b { color: var(--danger); font-weight: 650; }
/* Green: the one moment worth celebrating — a key that exists, once. */
.eb-secret { border: 1px solid color-mix(in srgb, var(--accent) 50%, var(--border));
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-radius: var(--radius); padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3); }
.eb-secret b { color: var(--accent); font-weight: 650; }

.eb-code { font-family: var(--mono); font-size: var(--fs-xs); background: var(--panel-2);
  border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--s3);
  white-space: pre-wrap; word-break: break-all; margin: 0; }

.eb-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.eb-q { font-size: var(--fs-xs); color: var(--muted); background: var(--panel-2);
  border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 2px 9px; }

/* ── the widget, which has no shell around it ───────────────────────────── */
.ew { padding: var(--s4); display: flex; flex-direction: column; gap: var(--s3);
  font-family: var(--font); color: var(--text); background: var(--bg); min-height: 100vh; }
.ew-top { display: flex; align-items: baseline; gap: var(--s2); flex-wrap: wrap; }
.ew-top h1 { font-size: var(--fs-lg); margin: 0; }
.ew-ask { display: flex; gap: var(--s2); }
.ew-ask .eb-in { flex: 1 1 auto; }
.ew-value { font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -0.01em; }
.ew-unit { color: var(--muted); font-size: var(--fs-sm); }
.ew-sentence { font-size: var(--fs-sm); line-height: var(--lh-body); }
.ew-table { width: 100%; border-collapse: collapse; font-size: var(--fs-xs); }
.ew-table th { text-align: left; color: var(--muted); font-weight: 600;
  padding: 5px 8px; border-bottom: 1px solid var(--border); }
.ew-table td { padding: 5px 8px; border-bottom: 1px solid var(--border-soft); }
.ew-scroll { overflow-x: auto; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.append(s);
}

/* ══ THE SNIPPET ═══════════════════════════════════════════════════════════ */

const WIDGET_PATH = "/v2/embed-widget.html";

/**
 * The <iframe> to paste into another page.
 *
 * Built from `location.origin` so no address is ever hard-coded here — the port
 * changes on every launch, and a snippet carrying yesterday's port is a support
 * ticket nobody can diagnose from the screenshot.
 */
function snippetFor({ secret, scopeId, token }) {
  const url = new URL(WIDGET_PATH, location.origin);
  if (token) url.searchParams.set("t", token);
  url.searchParams.set("key", secret ?? "PASTE-YOUR-EMBED-KEY-HERE");
  if (scopeId) url.searchParams.set("scope", scopeId);
  return `<iframe\n  src="${url.toString()}"\n  title="Ledgerline"\n  width="100%"\n  height="460"\n  style="border:1px solid #e1e3e8;border-radius:10px"\n  loading="lazy"></iframe>`;
}

/* ══ THE RULE BUILDER ══════════════════════════════════════════════════════
 *
 * Deliberately flatter than the Segments builder: every rule is its own AND
 * group, so a scope reads "customers where A and B and C" with no brackets. A
 * scope decides who somebody else can see, and a rule with OR in it is exactly
 * the rule people misread.
 */

const fieldById = (view, id) => view.fields.find((f) => f.id === id) ?? null;
const opsFor = (view, f) => view.ops[f?.type] ?? view.ops.text ?? [];
const opEntry = (view, f, op) => opsFor(view, f).find(([v]) => v === op) ?? null;
const needsValue = (view, f, op) => opEntry(view, f, op)?.[2] === true;

function choicesFor(view, f) {
  const bag = view.choices?.[f?.choices];
  if (!bag) return null;
  if (Array.isArray(bag)) return bag.map((v) => [v, v]);
  return Object.entries(bag).map(([k, label]) => [k, String(label)]);
}

/** draft.rules is a flat list; the server is sent one group per rule. */
const groupsFrom = (rules) => rules.filter((r) => r.field).map((r) => ({ rules: [{ ...r }] }));

const rulesFrom = (groups) =>
  (Array.isArray(groups) ? groups : []).flatMap((g) => (Array.isArray(g?.rules) ? g.rules : [])).map((r) => ({
    field: String(r?.field ?? ""),
    op: String(r?.op ?? ""),
    value: r?.value == null ? "" : String(r.value),
  }));

function paintRules(mount, view, draft, onChange) {
  mount.replaceChildren();
  if (!draft.rules.length) {
    mount.append(el("p", "eb-muted", "No filter yet — this scope would let the widget see every customer in the workspace."));
  }
  draft.rules.forEach((rule, i) => {
    const row = el("div", "eb-rule");
    row.append(el("span", "eb-lab", i === 0 ? "where" : "and"));

    const f = fieldById(view, rule.field);
    row.append(
      select(
        view.fields.map((x) => [x.id, x.label]),
        rule.field,
        (v) => {
          rule.field = v;
          const next = fieldById(view, v);
          rule.op = opsFor(view, next)[0]?.[0] ?? "is";
          rule.value = "";
          onChange();
        },
      ),
    );
    row.append(
      select(
        opsFor(view, f).map(([id, label]) => [id, label]),
        rule.op,
        (v) => {
          rule.op = v;
          onChange();
        },
      ),
    );

    if (needsValue(view, f, rule.op)) {
      const choices = choicesFor(view, f);
      if (choices) {
        row.append(select([["", "choose…"], ...choices], rule.value, (v) => {
          rule.value = v;
          onChange();
        }));
      } else {
        row.append(
          input(rule.value, f?.type === "date" ? "YYYY-MM-DD" : "value", (v) => {
            rule.value = v;
            onChange();
          }, f?.type === "date" ? "date" : "text"),
        );
      }
    }

    if (f?.needsRun) row.append(el("span", "eb-muted", "needs an analysis run"));

    row.append(
      button("×", "eb-x", () => {
        draft.rules.splice(i, 1);
        onChange();
      }),
    );
    mount.append(row);
  });

  mount.append(
    button("Add a condition", "btn tiny", () => {
      const first = view.fields[0];
      draft.rules.push({ field: first?.id ?? "", op: opsFor(view, first)[0]?.[0] ?? "is", value: "" });
      onChange();
    }),
  );
}

/* ══ THE SCOPE FORM ════════════════════════════════════════════════════════ */

function paintScopeForm(mount, view, draft, reload, onDone) {
  mount.replaceChildren();
  const card = el("section", "eb-card");
  const head = el("header");
  head.append(el("h3", null, draft.id ? "Edit data scope" : "New data scope"));
  card.append(head);

  const body = el("div", "eb-body");
  card.append(body);
  mount.append(card);

  body.append(
    field(
      "Name",
      input(draft.name, "What this slice is, in your words", (v) => {
        draft.name = v;
      }),
    ),
  );

  body.append(el("p", "eb-muted", "Which customers the widget may see. Every condition must be true of a customer."));
  const rulesMount = el("div", "eb-body flush");
  body.append(rulesMount);

  const reach = el("p", "eb-muted", "");
  body.append(reach);

  body.append(el("p", "eb-muted", "Which questions it may ask. Leave every box clear to allow all of them."));
  const checks = el("div", "eb-checks");
  for (const entry of view.catalogue) {
    checks.append(
      checkbox(entry.question, draft.intents.includes(entry.id), (on) => {
        if (on && !draft.intents.includes(entry.id)) draft.intents.push(entry.id);
        if (!on) draft.intents = draft.intents.filter((x) => x !== entry.id);
        refresh();
      }),
    );
  }
  body.append(checks);

  const status = el("div");
  body.append(status);

  const actions = el("div", "eb-row");
  actions.append(
    button(draft.id ? "Save changes" : "Create scope", "btn primary", async () => {
      status.replaceChildren();
      const payload = { id: draft.id, name: draft.name, groups: groupsFrom(draft.rules), intents: draft.intents };
      let res;
      try {
        res = draft.id ? await view.api.updateScope(payload) : await view.api.createScope(payload);
      } catch (err) {
        status.append(errorBox("The scope could not be saved", reasonFrom(null, err)));
        return;
      }
      if (!res?.ok) {
        status.append(errorBox("The scope could not be saved", reasonFrom(res)));
        return;
      }
      onDone();
      await reload();
    }),
  );
  actions.append(button("Cancel", "btn ghost", () => onDone()));
  body.append(actions);

  /** Re-count on every edit. The number under the builder is the server's. */
  async function refresh() {
    paintRules(rulesMount, view, draft, refresh);
    reach.textContent = "counting…";
    let res;
    try {
      res = await view.api.previewScope(groupsFrom(draft.rules), draft.intents);
    } catch (err) {
      reach.textContent = reasonFrom(null, err);
      return;
    }
    if (!res?.ok) {
      reach.textContent = reasonFrom(res);
      return;
    }
    const questions = res.allQuestions ? "every question" : plural(res.questions.length, "question", "questions");
    reach.textContent = `${plural(res.accounts, "customer", "customers")} of ${res.total}, answering ${questions}. Tables read: ${res.tables.join(", ") || "none"}.`;
  }
  refresh();
}

/* ══ THE SCOPE LIST ════════════════════════════════════════════════════════ */

function paintScopes(mount, view, reload, onEdit) {
  mount.replaceChildren();
  const card = el("section", "eb-card");
  const head = el("header");
  head.append(el("h3", null, "Data scopes"));
  head.append(el("span", "eb-grow"));
  head.append(button("New scope", "btn tiny", () => onEdit(null)));
  card.append(head);
  mount.append(card);

  if (!view.scopes.length) {
    const body = el("div", "eb-body");
    body.append(
      emptyBox(
        "No data scopes yet",
        "A data scope is a named slice of this workspace: which customers a widget may see, and which questions it may ask. A key with no scope reads everything, so make the scope first.",
        button("New scope", "btn primary", () => onEdit(null)),
      ),
    );
    card.append(body);
    return;
  }

  const list = el("div", "eb-body flush");
  card.append(list);

  for (const scope of view.scopes) {
    const item = el("div", "eb-item");
    const top = el("div", "eb-row");
    top.append(el("h4", null, scope.name));
    if (scope.allAccounts) top.append(el("span", "chip warn", "every customer"));
    top.append(el("span", "eb-grow"));
    top.append(button("Edit", "btn tiny", () => onEdit(scope)));
    const del = button("Delete", "btn tiny danger", () => askDelete(item, scope));
    top.append(del);
    item.append(top);

    const facts = el("div", "eb-facts");
    const reach = scope.error ? "count unavailable" : `${plural(scope.accounts, "customer", "customers")}`;
    facts.append(el("span", null, reach));
    facts.append(el("span", null, scope.allQuestions ? "every question" : plural(scope.questions.length, "question", "questions")));
    facts.append(el("span", null, `tables: ${scope.tables.join(", ") || "none"}`));
    facts.append(el("span", null, `${plural(scope.liveKeys, "live key", "live keys")}`));
    item.append(facts);

    if (scope.error) item.append(errorBox("This scope's filter cannot be run", scope.error));

    const pills = el("div", "eb-pills");
    for (const q of scope.questions.slice(0, 6)) pills.append(el("span", "eb-q", q));
    if (scope.questions.length > 6) pills.append(el("span", "eb-q", `+${scope.questions.length - 6} more`));
    item.append(pills);

    list.append(item);
  }

  /**
   * 🔴 THE FIX FOR THE DOCUMENTED LEAK, on screen. The first click asks the
   * server, which REFUSES while keys point at the scope and names them. Only
   * then does a second button appear, and it says out loud how many keys it is
   * about to kill. There is no path from one click to a widened key.
   */
  async function askDelete(item, scope) {
    const old = item.querySelector(".eb-danger");
    if (old) old.remove();
    let res;
    try {
      res = await view.api.deleteScope(scope.id, false);
    } catch (err) {
      item.append(errorBox("The scope could not be deleted", reasonFrom(null, err)));
      return;
    }
    if (res?.ok) {
      await reload();
      return;
    }
    const box = el("div", "eb-danger");
    box.append(el("b", null, "This scope is in use"));
    box.append(el("p", null, reasonFrom(res)));
    if (res?.needsRevoke) {
      box.append(
        el(
          "p",
          null,
          "Revoking them is the safe outcome: a revoked key stops answering immediately. Ledgerline never lets a key outlive its scope, because a key with no scope reads the whole workspace.",
        ),
      );
      const row = el("div", "eb-row");
      row.append(
        button(`Revoke ${plural(res.keys?.length ?? 0, "key", "keys")} and delete the scope`, "btn danger", async () => {
          let done;
          try {
            done = await view.api.deleteScope(scope.id, true);
          } catch (err) {
            box.append(errorBox("The scope could not be deleted", reasonFrom(null, err)));
            return;
          }
          if (!done?.ok) {
            box.append(errorBox("The scope could not be deleted", reasonFrom(done)));
            return;
          }
          await reload();
        }),
      );
      row.append(button("Keep it", "btn ghost", () => box.remove()));
      box.append(row);
    }
    item.append(box);
  }
}

/* ══ THE KEY LIST AND THE KEY FORM ═════════════════════════════════════════ */

function keyFacts(view, key) {
  const facts = el("div", "eb-facts");
  facts.append(el("span", null, `${key.prefix}…`));
  facts.append(el("span", null, `${key.ratePerMinute}/min`));
  facts.append(el("span", null, key.origins.length ? key.origins.join(", ") : "any site"));
  facts.append(el("span", null, key.expiresAt ? `expires ${String(key.expiresAt).slice(0, 10)}` : "no expiry"));
  facts.append(el("span", null, `${plural(key.uses, "question", "questions")} answered`));
  if (key.refusals) facts.append(el("span", null, `${plural(key.refusals, "request", "requests")} refused`));
  return facts;
}

function paintKeys(mount, view, reload, onSecret) {
  mount.replaceChildren();
  const card = el("section", "eb-card");
  const head = el("header");
  head.append(el("h3", null, "Embed keys"));
  head.append(el("span", "eb-grow"));
  card.append(head);
  mount.append(card);

  const list = el("div", "eb-body flush");
  card.append(list);

  if (!view.keys.length) {
    const body = el("div", "eb-body");
    body.append(emptyBox("No embed keys yet", "A key is the secret inside the iframe. It is shown once, when you create it, and only a hash of it is stored."));
    list.append(body);
  }

  for (const key of view.keys) {
    const item = el("div", key.revokedAt ? "eb-item dead" : "eb-item");
    const top = el("div", "eb-row");
    top.append(el("h4", null, key.name));

    if (key.revokedAt) top.append(el("span", "pill dismissed", "revoked"));
    else if (key.scopeMissing) top.append(el("span", "pill overdue", "scope missing"));
    else if (key.scopeId) top.append(el("span", "chip accent", key.scopeName));
    else top.append(el("span", "chip warn", "whole workspace"));

    top.append(el("span", "eb-grow"));
    if (!key.revokedAt) {
      top.append(
        button("Revoke", "btn tiny danger", async () => {
          const res = await view.api.revokeKey(key.id, "revoked from the Embed screen").catch((err) => ({ ok: false, error: reasonFrom(null, err) }));
          if (!res?.ok) item.append(errorBox("The key could not be revoked", reasonFrom(res)));
          else await reload();
        }),
      );
    } else {
      top.append(
        button("Delete", "btn tiny ghost", async () => {
          const res = await view.api.deleteKey(key.id).catch((err) => ({ ok: false, error: reasonFrom(null, err) }));
          if (!res?.ok) item.append(errorBox("The key could not be deleted", reasonFrom(res)));
          else await reload();
        }),
      );
    }
    item.append(top);

    // 🔴 Never labelled "no scope". An orphaned key reads NOTHING, and saying so
    // in red is the whole difference between this and the leak it replaces.
    if (key.scopeMissing) {
      const box = el("div", "eb-danger");
      box.append(el("b", null, "The data scope this key was issued for is gone"));
      box.append(
        el(
          "p",
          null,
          "The key reads nothing at all and every request through it is refused. It has NOT fallen back to the whole workspace. Revoke it and issue a new one against a scope that exists.",
        ),
      );
      item.append(box);
    }
    if (key.revokedAt && key.revokedReason) item.append(el("p", "eb-muted", key.revokedReason));

    item.append(keyFacts(view, key));

    if (!key.revokedAt) {
      const snip = el("details");
      snip.append(el("summary", "eb-muted", "Show the embed snippet"));
      snip.append(el("p", "eb-muted", "The key itself is not stored, so paste it into the snippet where it says so."));
      snip.append(el("pre", "eb-code", snippetFor({ secret: null, scopeId: key.scopeId, token: view.token })));
      item.append(snip);
    }
    list.append(item);
  }

  /* ── the form ─────────────────────────────────────────────────────────── */
  const form = el("div", "eb-body");
  card.append(form);
  form.append(el("h4", null, "Create a key"));

  const draft = { name: "", scopeId: "", origins: "", expiresAt: "", ratePerMinute: String(view.defaultRatePerMinute) };
  const grid = el("div", "eb-grid");
  grid.append(field("Name", input(draft.name, "Who this key is for", (v) => { draft.name = v; })));

  const scopeOptions = [["", "Whole workspace — no scope"], ...view.scopes.map((s) => [s.id, s.name])];
  grid.append(field("Data scope", select(scopeOptions, draft.scopeId, (v) => { draft.scopeId = v; paintScopeWarning(); })));
  grid.append(field("Expires", input(draft.expiresAt, "", (v) => { draft.expiresAt = v; }, "date")));
  grid.append(
    field(
      `Questions a minute (1–${view.maxRatePerMinute})`,
      input(draft.ratePerMinute, "", (v) => { draft.ratePerMinute = v; }, "number"),
    ),
  );
  form.append(grid);

  const origins = el("textarea", "eb-ta");
  origins.placeholder = "One web address a line. Leave blank to allow any site.";
  origins.addEventListener("input", () => {
    draft.origins = origins.value;
  });
  form.append(field("Sites allowed to embed it", origins));
  form.append(
    el(
      "p",
      "eb-muted",
      "This list is checked against the address the widget reports about itself, so it catches a key pasted into the wrong page. It is not a defence against somebody who has the key and is willing to lie — the data scope is.",
    ),
  );

  const warning = el("div");
  form.append(warning);
  const status = el("div");
  form.append(status);

  form.append(
    button("Create key", "btn primary", async () => {
      status.replaceChildren();
      let res;
      try {
        res = await view.api.createKey({
          name: draft.name,
          scopeId: draft.scopeId || undefined,
          origins: draft.origins,
          expiresAt: draft.expiresAt,
          ratePerMinute: draft.ratePerMinute,
        });
      } catch (err) {
        status.append(errorBox("The key could not be created", reasonFrom(null, err)));
        return;
      }
      if (!res?.ok) {
        status.append(errorBox("The key could not be created", reasonFrom(res)));
        return;
      }
      onSecret(res);
      await reload();
    }),
  );

  function paintScopeWarning() {
    warning.replaceChildren();
    if (draft.scopeId) return;
    const box = el("div", "eb-warn");
    box.append(el("b", null, "This key will read the whole workspace"));
    box.append(el("p", null, "Every customer, every question. Choose a data scope unless the page you are embedding into is one you control."));
    warning.append(box);
  }
  paintScopeWarning();
}

/** The one moment the secret exists. Shown once, with the snippet already built. */
function paintSecret(mount, view, made) {
  mount.replaceChildren();
  const box = el("div", "eb-secret");
  box.append(el("b", null, `"${made.key.name}" is ready — copy it now`));
  box.append(
    el(
      "p",
      null,
      "Ledgerline stores a hash of this key and nothing else, so this is the only time it can be shown. If it is lost, revoke it and create another.",
    ),
  );
  box.append(el("pre", "eb-code", made.secret));
  box.append(el("p", null, "Paste this where you want the widget:"));
  box.append(el("pre", "eb-code", snippetFor({ secret: made.secret, scopeId: made.key.scopeId, token: view.token })));
  box.append(
    el(
      "p",
      "eb-muted",
      "Ledgerline runs on this machine only, so the widget answers while Ledgerline is open on whichever computer loads the page. The t= value changes every time Ledgerline starts, so copy the snippet again after a restart.",
    ),
  );
  box.append(button("I have copied it", "btn", () => mount.replaceChildren()));
  mount.append(box);
}

/* ══ THE PAGE ══════════════════════════════════════════════════════════════ */

export async function render(root, ctx) {
  ensureStyles();
  root.replaceChildren();

  const page = el("div", "eb");
  root.append(page);

  const loading = el("div");
  for (let i = 0; i < 3; i++) loading.append(el("div", "skeleton block"));
  page.append(loading);

  const api = backend((name, opts) => ctx.api(name, opts));
  let data;
  try {
    data = await api.overview();
  } catch (err) {
    loading.remove();
    page.append(errorBox("The embed settings could not be read", reasonFrom(null, err)));
    return;
  }
  loading.remove();

  if (!data?.ok) {
    page.append(errorBox(data?.needsWorkspace ? "No workspace is open" : "The embed settings could not be read", reasonFrom(data)));
    return;
  }

  const view = {
    ctx,
    api,
    token: new URL(location.href).searchParams.get("t") ?? "",
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    keys: Array.isArray(data.keys) ? data.keys : [],
    catalogue: Array.isArray(data.catalogue) ? data.catalogue : [],
    fields: Array.isArray(data.fields) ? data.fields : [],
    ops: data.ops && typeof data.ops === "object" ? data.ops : {},
    choices: data.choices && typeof data.choices === "object" ? data.choices : {},
    total: Number(data.total) || 0,
    defaultRatePerMinute: Number(data.defaultRatePerMinute) || 30,
    maxRatePerMinute: Number(data.maxRatePerMinute) || 600,
    asOf: data.asOf ?? null,
  };

  if (!view.fields.length || !view.catalogue.length) {
    page.append(errorBox("The embed settings could not be read", "the server returned no questions and no fields to build a scope from"));
    return;
  }

  const head = el("div", "eb-head");
  head.append(el("h2", null, "Embed"));
  head.append(
    el(
      "p",
      "eb-muted",
      "Put a question box on another page. The key inside the iframe decides what it can read; the address cannot change that.",
    ),
  );
  page.append(head);

  if (!view.total) {
    page.append(
      emptyBox(
        "No customers to share yet",
        "An embed answers questions about your customer list, and this workspace has not imported one. Load a folder of CSVs or seed the demo data first.",
        button("Go to Data", "btn", () => ctx.go("data")),
      ),
    );
    return;
  }

  const secretMount = el("div");
  const scopeFormMount = el("div");
  const scopesMount = el("div");
  const keysMount = el("div");
  page.append(secretMount, scopeFormMount, scopesMount, keysMount);

  const reload = async () => {
    let fresh;
    try {
      fresh = await api.overview();
    } catch (err) {
      keysMount.append(errorBox("The embed settings could not be re-read", reasonFrom(null, err)));
      return;
    }
    if (!fresh?.ok) {
      keysMount.append(errorBox("The embed settings could not be re-read", reasonFrom(fresh)));
      return;
    }
    view.scopes = Array.isArray(fresh.scopes) ? fresh.scopes : [];
    view.keys = Array.isArray(fresh.keys) ? fresh.keys : [];
    paintScopes(scopesMount, view, reload, openScopeForm);
    paintKeys(keysMount, view, reload, (made) => paintSecret(secretMount, view, made));
  };

  function openScopeForm(scope) {
    if (scope === undefined) return;
    if (scope === null && scopeFormMount.firstChild) {
      scopeFormMount.replaceChildren();
      return;
    }
    const draft = scope
      ? { id: scope.id, name: scope.name, rules: rulesFrom(scope.groups), intents: [...(scope.intents ?? [])] }
      : { id: null, name: "", rules: [], intents: [] };
    paintScopeForm(scopeFormMount, view, draft, reload, () => scopeFormMount.replaceChildren());
    scopeFormMount.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  paintScopes(scopesMount, view, reload, openScopeForm);
  paintKeys(keysMount, view, reload, (made) => paintSecret(secretMount, view, made));
}

/* ══ THE WIDGET ════════════════════════════════════════════════════════════
 *
 * Everything below runs ONLY inside /v2/embed-widget.html, which sets
 * data-ledgerline-embed-widget on its <html> element. The shell's dynamic import of
 * this module lands in a document that does not, so the management page above
 * never triggers any of it.
 *
 * The widget answers through decisionsEmbedAsk, which runs the SAME ask
 * catalogue the Ask screen uses — against a database built from the key's scope.
 * There is no second answering engine here and there must never be one: a
 * second one would be the one that disagrees.
 */

function widgetApi(token) {
  return async (name, { method = "GET", body, query } = {}) => {
    const qs = new URLSearchParams({ t: token, ...(query ?? {}) });
    const res = await fetch(`/x/${name}?${qs.toString()}`, {
      method,
      headers: { "content-type": "application/json", "x-omni-token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return res.json();
  };
}

/** The evidence table an answer carries, as a real table with real headers. */
function recordsTable(records) {
  const scroll = el("div", "ew-scroll");
  const table = el("table", "ew-table");
  const thead = el("thead");
  const hrow = el("tr");
  for (const c of records.columns ?? []) hrow.append(el("th", null, c));
  thead.append(hrow);
  table.append(thead);
  const tbody = el("tbody");
  for (const row of records.rows ?? []) {
    const tr = el("tr");
    for (const cell of row.cells ?? []) tr.append(el("td", null, cell));
    tbody.append(tr);
  }
  table.append(tbody);
  scroll.append(table);
  return scroll;
}

function paintAnswer(mount, payload) {
  mount.replaceChildren();
  const result = payload.result ?? {};

  if (result.kind === "refusal") {
    const box = el("div", "eb-warn");
    box.append(el("b", null, "Not answered"));
    box.append(el("p", null, String(result.reason ?? "")));
    for (const line of result.checked ?? []) box.append(el("p", "eb-muted", String(line)));
    if ((result.suggestions ?? []).length) {
      box.append(el("p", "eb-muted", "You can ask:"));
      const pills = el("div", "eb-pills");
      for (const s of result.suggestions) pills.append(el("span", "eb-q", s));
      box.append(pills);
    }
    mount.append(box);
    return;
  }

  const card = el("section", "eb-card");
  const body = el("div", "eb-body");
  card.append(body);
  body.append(el("div", "ew-value", result.value ?? "—"));
  if (result.unit) body.append(el("div", "ew-unit", result.unit));
  if (result.sentence) body.append(el("p", "ew-sentence", result.sentence));
  if (result.records?.columns?.length) body.append(recordsTable(result.records));
  if (result.records?.note) body.append(el("p", "eb-muted", result.records.note));
  if (result.definition) {
    const how = el("details");
    how.append(el("summary", "eb-muted", "How this number is worked out"));
    how.append(el("p", "ew-sentence", result.definition));
    how.append(el("p", "eb-muted", `Answered as of ${payload.asOf ?? "—"}${payload.model ? ` · ${payload.model}` : " · no model"}.`));
    how.append(el("p", "eb-muted", `Scope: ${payload.scope?.name ?? "the whole workspace"}.`));
    card.append(how);
  }
  mount.append(card);
}

async function bootWidget() {
  ensureStyles();
  const params = new URL(location.href).searchParams;
  const token = params.get("t") ?? "";
  const key = params.get("key") ?? "";
  const scopeId = params.get("scope") ?? "";
  // 🔴 Whatever the parent page really is. Reported, not trusted: the server
  // treats it as a mis-embed check and says so on the Embed screen.
  const origin = (location.ancestorOrigins && location.ancestorOrigins[0]) || document.referrer || location.origin;

  const api = widgetBackend(widgetApi(token));
  const page = el("div", "ew");
  document.body.replaceChildren(page);

  const top = el("div", "ew-top");
  const heading = el("h1", null, "Ask about your account");
  top.append(heading);
  const sub = el("span", "eb-muted", "");
  top.append(sub);
  page.append(top);

  const answerMount = el("div");

  let info;
  try {
    info = await api.info({ key, scopeId: scopeId || undefined, origin });
  } catch (err) {
    page.append(errorBox("This widget could not reach Ledgerline", reasonFrom(null, err)));
    return;
  }
  if (!info?.ok) {
    page.append(errorBox("This widget is not able to answer", reasonFrom(info)));
    return;
  }

  heading.textContent = info.name;
  sub.textContent = info.allAccounts
    ? `every customer · as of ${info.asOf}`
    : `${plural(info.accounts ?? 0, "customer", "customers")} · as of ${info.asOf}`;

  const box = input("", "Ask a question about your account…");
  const row = el("div", "ew-ask");
  row.append(box);
  const send = button("Ask", "btn primary", () => submit());
  row.append(send);
  page.append(row);

  const pills = el("div", "eb-pills");
  for (const q of info.questions ?? []) {
    pills.append(
      button(q, "eb-q", () => {
        box.value = q;
        submit();
      }),
    );
  }
  page.append(pills);
  page.append(answerMount);

  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  async function submit() {
    const question = box.value.trim();
    if (!question) return;
    send.disabled = true;
    answerMount.replaceChildren(el("div", "skeleton block"));
    let res;
    try {
      res = await api.ask({ key, scopeId: scopeId || undefined, origin, question });
    } catch (err) {
      answerMount.replaceChildren(errorBox("That question could not be sent", reasonFrom(null, err)));
      send.disabled = false;
      return;
    }
    send.disabled = false;
    if (!res?.ok) {
      answerMount.replaceChildren(errorBox("Not answered", reasonFrom(res)));
      return;
    }
    paintAnswer(answerMount, res);
  }
}

if (typeof document !== "undefined" && document.documentElement?.dataset?.ledgerlineEmbedWidget === "1") {
  bootWidget().catch((err) => {
    const box = errorBox("This widget failed to start", String(err?.message ?? err));
    document.body.replaceChildren(box);
  });
}
