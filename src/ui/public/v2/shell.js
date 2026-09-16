// v2 shell: sidebar, hash router, ctx, error boundary, workspace switcher.
//
// This file owns the chrome and nothing else. Every screen lives in
// ./pages/<name>.js and exports exactly two things:
//
//     export const title = "Today";
//     export async function render(root, ctx) { ... }
//
// The pages are written by other hands and some of them may not exist yet, so
// the router imports them lazily and turns a failed import into a readable
// panel rather than a white screen.
//
// Everything visible is styled by tokens.css (.panel .btn .chip .empty .err
// .skeleton) plus the shell chrome in index.html. Nothing is styled here.
//
// 🔴 EVERY STRING FROM THE MODEL OR FROM IMPORTED CUSTOMER DATA IS INSERTED
// WITH textContent. Nothing here uses innerHTML. Same rule as app.js and
// decisions.js, and it is not negotiable.

/* ── backend ────────────────────────────────────────────────────────────── */

// Copied verbatim from app.js (line 12) and decisions.js (line 19). The token
// rides in the page URL: /v2/?t=<token>. Open the page without it and every
// /x/ call comes back 401.
const TOKEN = new URL(location.href).searchParams.get("t") ?? "";

async function api(name, { method = "GET", body, query } = {}) {
  const qs = new URLSearchParams({ t: TOKEN, ...(query ?? {}) });
  const r = await fetch(`/x/${name}?${qs}`, {
    method,
    headers: { "content-type": "application/json", "x-omni-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return r.json();
}

/* ── tiny DOM helpers ───────────────────────────────────────────────────── */

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

function button(label, cls, onClick) {
  const b = el("button", cls, label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

const SVG_NS = "http://www.w3.org/2000/svg";

/** An inline icon drawn from path data. No icon font, no CDN, no network. */
function icon(paths, size = 18) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const p = document.createElementNS(SVG_NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

/* ── formatting ─────────────────────────────────────────────────────────── */

// These mirror src/decisions/format.mjs on purpose. The same amount must read
// identically whether the screen formats it or the backend sent it already
// formatted as impactLabel - two formatters drift, and then a card says
// "$50,000" beside an evidence line that says "$50,000.00".
const fmt = {
  /** Whole money with a thousands separator. Never invents a currency symbol. */
  money(amount, currency = "USD") {
    if (amount == null || !Number.isFinite(amount)) return "—";
    const symbol = { USD: "$", GBP: "£", EUR: "€", AED: "AED ", INR: "₹" }[currency] ?? `${currency} `;
    return symbol + Math.round(amount).toLocaleString("en-US");
  },
  /** "2026-10-19", or a full ISO timestamp, -> "19 Oct 2026". */
  date(iso) {
    const day = String(iso ?? "").slice(0, 10);
    const d = new Date(day + "T00:00:00Z");
    if (!day || Number.isNaN(d.getTime())) return String(iso ?? "");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  },
  /** A day count as words: 0 -> "today", 3 -> "3 days ago", -4 -> "in 4 days". */
  days(n) {
    if (n == null || !Number.isFinite(n)) return "";
    if (n === 0) return "today";
    if (n > 0) return n === 1 ? "1 day ago" : `${n} days ago`;
    const ahead = Math.abs(n);
    return ahead === 1 ? "in 1 day" : `in ${ahead} days`;
  },
  /** A percentage the API already expressed as one (change_pct: -35 -> "-35%"). */
  pct(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    return `${Math.round(n)}%`;
  },
};

/* ── sidebar contents ───────────────────────────────────────────────────── */

const NAV = [
  { id: "today", label: "Today", paths: ["M4 6.5h16v13.5H4z", "M8 3.5v4", "M16 3.5v4", "M4 10.5h16"] },
  { id: "decisions", label: "Decisions", paths: ["M4 7h9", "M4 12h9", "M4 17h6", "M15.5 16.2l2 2 4-4.2"] },
  {
    id: "customers",
    label: "Customers",
    paths: [
      "M9 11.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
      "M2.5 20a6.5 6.5 0 0 1 13 0",
      "M16.5 11.5a3 3 0 1 0 0-6",
      "M17 14.2A5.8 5.8 0 0 1 21.5 20",
    ],
  },
  { id: "ask", label: "Ask", paths: ["M20 15a3 3 0 0 1-3 3H9l-4.5 3V6a3 3 0 0 1 3-3h9.5a3 3 0 0 1 3 3z"] },
  { id: "segments", label: "Segments", paths: ["M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9z", "M12 3v9h9"] },
  // Saved analysis. These sit after Segments because they are things you build
  // from the data rather than things the app hands you.
  { id: "dashboards", label: "Dashboards", paths: ["M4 4h7v7H4z", "M13 4h7v4.5h-7z", "M13 10.5h7V20h-7z", "M4 13h7v7H4z"] },
  { id: "stories", label: "Stories", paths: ["M5 4.5h11a2 2 0 0 1 2 2V21l-3.5-2.5L11 21l-3.5-2.5L4 21V6.5a2 2 0 0 1 1-2z", "M8 9h7", "M8 13h5"] },
  { id: "embed", label: "Embed", paths: ["M9 8.5L4.5 12 9 15.5", "M15 8.5L19.5 12 15 15.5", "M13.5 5l-3 14"] },
  // The manual. Last in the list because it is where you go when a screen above
  // has not explained itself, and it must be present: this interface shipped
  // once with no way at all to find out what anything did.
  { id: "help", label: "How to use this", paths: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.8-.9 1.4v.6", "M12 17h.01"] },
  {
    id: "data",
    label: "Data",
    paths: [
      "M4 6c0-1.66 3.58-3 8-3s8 1.34 8 3-3.58 3-8 3-8-1.34-8-3z",
      "M4 6v6c0 1.66 3.58 3 8 3s8-1.34 8-3V6",
      "M4 12v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6",
    ],
  },
  {
    id: "settings",
    label: "Settings",
    paths: [
      "M4 7.5h7.5",
      "M16.5 7.5h3.5",
      "M4 16.5h3.5",
      "M12.5 16.5h7.5",
      "M16 7.5a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0z",
      "M12 16.5a2.2 2.2 0 1 1-4.4 0 2.2 2.2 0 0 1 4.4 0z",
    ],
  },
];

/* ── shell state and ctx ────────────────────────────────────────────────── */

// The plain shared object page modules get as ctx.state. The shell writes
// `status` and `route`; everything else in here belongs to the pages.
const state = { status: null, statusError: null, route: null };

const ctx = {
  api,
  go,
  state,
  fmt,
  // Beyond the four-key contract, and additive so nothing breaks. A detail page
  // (#/decisions/d1) has no other way to learn its id: render(root, ctx) takes
  // no route argument. Both carriers are filled because the pages are written
  // in parallel and each checks a different one first.
  get route() {
    return state.route;
  },
  get params() {
    const r = state.route;
    if (!r) return {};
    const p = { ...r.params };
    if (r.id) p.id = r.id;
    return p;
  },
  // A page that has just changed the workspace - imported data, run an
  // analysis, flipped demo mode - calls this so the sidebar and the as-of chip
  // stop showing the old answer.
  refresh: refreshStatus,
};

/* ── layout ─────────────────────────────────────────────────────────────── */

const ui = {};

function buildShell() {
  const app = document.getElementById("app") ?? document.body;
  app.replaceChildren();

  const side = el("aside", "v2-side");

  const brand = el("div", "v2-brand");
  const mark = el("span", "v2-mark");
  // The wordmark: a green V, drawn here rather than loaded. The CSP forbids
  // remote assets, and ../logo.svg is the chat app's mark, not this surface's.
  mark.append(icon(["M4.5 5.5 12 19.5l7.5-14"], 22));
  brand.append(mark, el("b", null, "Vireo"));
  side.append(brand);

  side.append(buildWorkspaceSwitcher());

  const nav = el("nav", "v2-nav");
  ui.navItems = new Map();
  for (const item of NAV) {
    const b = el("button", "v2-nav-item");
    b.type = "button";
    b.append(icon(item.paths), el("span", null, item.label));
    b.onclick = () => go(`#/${item.id}`);
    nav.append(b);
    ui.navItems.set(item.id, b);
  }
  side.append(nav);

  const foot = el("div", "v2-side-foot");
  // decisions/index.html uses a plain <a href="../">, which drops the token and
  // boots the chat app with TOKEN = "" - every /x/ call then 401s. Carry it.
  foot.append(
    button("← Back to Vireo", "btn ghost block", () => {
      location.href = "../?t=" + encodeURIComponent(TOKEN);
    }),
  );
  side.append(foot);

  const main = el("main", "v2-main");
  const top = el("header", "v2-top");
  ui.title = el("h1", null, "Vireo");
  ui.chip = el("span", "chip warn");
  ui.chip.hidden = true;
  top.append(ui.title, ui.chip, el("div", "v2-grow"));
  ui.content = el("section", "v2-content");
  main.append(top, ui.content);

  app.append(side, main);
}

/* ── workspace switcher ─────────────────────────────────────────────────── */

function buildWorkspaceSwitcher() {
  const wrap = el("div", "v2-ws");

  const btn = el("button", "v2-ws-btn");
  btn.type = "button";
  btn.title = "Workspace";
  ui.wsName = el("span", "v2-ws-name", "Loading…");
  btn.append(ui.wsName, el("span", "v2-ws-caret", "▾"));
  btn.onclick = (e) => {
    e.stopPropagation();
    toggleWorkspacePanel();
  };

  ui.wsPanel = el("div", "v2-ws-panel");
  ui.wsPanel.hidden = true;
  ui.wsPanel.onclick = (e) => e.stopPropagation();

  // Click-away and Escape close it. Registered once, at build time.
  document.addEventListener("click", () => {
    ui.wsPanel.hidden = true;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") ui.wsPanel.hidden = true;
  });

  wrap.append(btn, ui.wsPanel);
  return wrap;
}

function toggleWorkspacePanel() {
  if (!ui.wsPanel.hidden) {
    ui.wsPanel.hidden = true;
    return;
  }
  paintWorkspacePanel();
  ui.wsPanel.hidden = false;
}

function paintWorkspacePanel() {
  const panel = ui.wsPanel;
  panel.replaceChildren();

  const list = state.status?.workspaces ?? [];
  const currentId = state.status?.workspace?.id ?? null;

  if (state.statusError) panel.append(el("div", "err", state.statusError));
  else if (!list.length) panel.append(el("small", null, "No workspaces yet."));

  for (const w of list) {
    const b = el("button", `v2-ws-item${w.id === currentId ? " current" : ""}`);
    b.type = "button";
    b.append(el("span", null, w.name), el("small", null, w.id === currentId ? "Open now" : "Switch to this one"));
    b.onclick = async () => {
      panel.hidden = true;
      const r = await api("decisionsWorkspaceSelect", { method: "POST", body: { id: w.id } });
      if (!r.ok) return showError(new Error(r.error ?? "that workspace could not be opened"));
      await refreshStatus();
      go("#/today");
    };
    panel.append(b);
  }

  panel.append(el("div", "v2-ws-sep"));

  const row = el("div", "v2-ws-new");
  const input = el("input", "v2-input");
  input.type = "text";
  input.placeholder = "New workspace";
  // One error node, reused, so a second failed attempt replaces the first
  // message instead of stacking another one under it.
  const err = el("div", "err");
  err.hidden = true;
  const create = button("Add", "btn", async () => {
    create.disabled = true;
    const r = await api("decisionsWorkspaceCreate", { method: "POST", body: { name: input.value } });
    create.disabled = false;
    // This route answers straight from workspace.create(): a bad name comes
    // back as { ok:false, error } with no needsWorkspace field.
    if (!r.ok) {
      err.textContent = r.error ?? "the workspace could not be created";
      err.hidden = false;
      return;
    }
    panel.hidden = true;
    await refreshStatus();
    go("#/today");
  });
  input.onkeydown = (e) => {
    if (e.key === "Enter") create.click();
  };
  row.append(input, create);
  panel.append(row, err);
}

/** Read decisionsStatus and repaint everything the sidebar and top bar show. */
async function refreshStatus() {
  let r;
  try {
    r = await api("decisionsStatus");
  } catch (err) {
    state.statusError = `The app did not answer: ${err?.message ?? err}`;
    state.status = null;
    ui.wsName.textContent = "Unavailable";
    ui.chip.hidden = true;
    return null;
  }

  if (!r?.ok) {
    // decisionsStatus does not go through withDb, so this is a real failure and
    // not the ordinary "no workspace yet" case - that one arrives as ok:true
    // with needsWorkspace:true and no asOf/hasData/lastRun keys at all.
    state.statusError = r?.error ?? "status unavailable";
    state.status = null;
    ui.wsName.textContent = "Unavailable";
    ui.chip.hidden = true;
    return r;
  }

  state.statusError = null;
  state.status = r;
  ui.wsName.textContent = r.workspace?.name ?? "No workspace";

  if (r.demoMode && r.asOf) {
    ui.chip.textContent = `Demo mode — today is ${r.asOf}`;
    ui.chip.hidden = false;
  } else {
    ui.chip.hidden = true;
  }
  return r;
}

/* ── routing ────────────────────────────────────────────────────────────── */

/** Parse "#/decisions/d1?owner=sam" into its parts. */
function parseRoute() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [pathPart, queryPart] = raw.split("?");
  const parts = pathPart.split("/").filter(Boolean);
  return {
    page: parts[0] || "today",
    id: parts[1] ?? null,
    parts,
    params: Object.fromEntries(new URLSearchParams(queryPart ?? "")),
    // A page that looks for its id by regex on ctx.route must see a path, not
    // "[object Object]". Cheap, and it is the difference between a detail view
    // opening and silently falling back to its list.
    toString() {
      return "/" + parts.join("/");
    },
  };
}

function go(route) {
  const s = String(route);
  const hash = s.startsWith("#") ? s : `#/${s.replace(/^\/+/, "")}`;
  if (location.hash === hash) renderRoute();
  else location.hash = hash;
}

// A module that failed once is not retried on every navigation; the cache holds
// the Error as well as the module.
const modules = new Map();

async function loadPage(name) {
  if (modules.has(name)) {
    const hit = modules.get(name);
    if (hit instanceof Error) throw hit;
    return hit;
  }
  try {
    const mod = await import(`./pages/${name}.js`);
    modules.set(name, mod);
    return mod;
  } catch (err) {
    // A missing file arrives as a TypeError ("Failed to fetch dynamically
    // imported module"); a file that exists but is broken arrives as a
    // SyntaxError. Both are cached and both are shown with their real message,
    // but only the missing one may fall back to another module - masking a
    // syntax error behind the list view would hide a real bug.
    const e = new Error(`./pages/${name}.js could not be loaded — ${err?.message ?? err}`);
    e.missing = err?.name === "TypeError";
    modules.set(name, e);
    throw e;
  }
}

/**
 * Which module renders this route.
 *
 * A detail route (#/decisions/d1) prefers the singular module and falls back to
 * the plural one, because either split is a reasonable way to write the pages -
 * pages/decision.js renders one decision, pages/customers.js renders both the
 * list and a customer.
 *
 * The name is matched against a strict pattern first: the hash is user-editable
 * and "./pages/" + an unchecked string would import whatever "../.." walks to.
 */
async function resolvePage(route) {
  if (!/^[a-z][a-z0-9-]*$/.test(route.page)) {
    const e = new Error(`"${route.page}" is not a page in this app.`);
    e.missing = true;
    throw e;
  }
  const names = [];
  if (route.id && route.page.endsWith("s")) names.push(route.page.slice(0, -1));
  names.push(route.page);

  let first = null;
  for (const name of names) {
    try {
      return { name, mod: await loadPage(name) };
    } catch (err) {
      first ??= err;
      if (!err.missing) throw err;
    }
  }
  throw first;
}

// Two navigations in quick succession race: the slower import can land after
// the newer view has drawn. Each render takes a token and checks it still owns
// the screen before touching the DOM.
let renderToken = 0;

async function renderRoute() {
  const route = parseRoute();
  state.route = route;

  for (const [id, node] of ui.navItems) node.classList.toggle("active", id === route.page);

  const token = ++renderToken;
  ui.title.textContent = NAV.find((n) => n.id === route.page)?.label ?? "Vireo";
  showLoading();

  // needsWorkspace is not an error: 25 of the 31 routes cannot answer anything
  // until a workspace is selected, so the shell asks for one here instead of
  // letting every page render its own 400.
  if (state.status?.needsWorkspace) return showWorkspaceOnboarding();
  if (state.statusError) return showError(new Error(state.statusError), { heading: "Vireo could not be reached" });

  let resolved;
  try {
    resolved = await resolvePage(route);
  } catch (err) {
    if (token !== renderToken) return;
    return err.missing ? showMissingPage(route, err) : showError(err);
  }
  if (token !== renderToken) return;

  const { mod, name } = resolved;
  if (typeof mod.render !== "function") {
    return showError(new Error(`./pages/${name}.js has no render(root, ctx) export.`));
  }
  if (typeof mod.title === "string" && mod.title) ui.title.textContent = mod.title;

  const root = el("div", "v2-page");
  ui.content.replaceChildren(root);
  try {
    await mod.render(root, ctx);
  } catch (err) {
    // The boundary. A page that throws must leave something readable behind,
    // and the half-drawn DOM it left is not it.
    if (token !== renderToken) return;
    showError(err);
  }
}

/* ── the three states the shell itself draws ────────────────────────────── */

function showLoading() {
  const wrap = el("div", "v2-state");
  for (let i = 0; i < 3; i++) wrap.append(el("div", "skeleton block"));
  ui.content.replaceChildren(wrap);
}

function emptyBox(heading, message) {
  const box = el("div", "empty v2-state");
  box.append(el("h3", null, heading));
  if (message) box.append(el("p", null, message));
  return box;
}

/** The error boundary's box. Always says WHAT failed, in the server's words. */
/**
 * Show a failure with a Retry that can actually succeed.
 *
 * 🔴 THE BUG THIS FIXES. Retry used to be `() => renderRoute()`. For the
 * commonest failure - decisionsStatus not answering - renderRoute() re-reads
 * the STALE `state.statusError` near the top and returns this same screen, so
 * the button could never clear the error however many times it was pressed.
 * Fixing the backend and pressing Retry still showed the old message; only a
 * full page reload recovered. A retry that cannot retry is worse than no
 * button, because it tells the reader the app is still broken when it is not.
 *
 * Clearing the flag and re-reading the status first is what makes it a retry
 * rather than a repaint. It is safe for page-render failures too: re-fetching
 * the status before re-rendering costs one request and keeps the sidebar honest.
 */
function showError(err, { heading = "Something went wrong" } = {}) {
  const box = el("div", "err v2-state");
  box.append(el("strong", null, heading));
  box.append(el("code", null, String(err?.message ?? err)));
  const retry = button("Retry", "btn", async () => {
    retry.disabled = true;
    retry.textContent = "Retrying…";
    state.statusError = null;
    await refreshStatus();
    renderRoute();
  });
  box.append(retry);
  ui.content.replaceChildren(box);
}

function showMissingPage(route, err) {
  const box = emptyBox(
    `The ${route.page} page is not built yet`,
    "This part of the new interface has not landed. The rest of the app still works.",
  );
  box.append(el("code", null, String(err?.message ?? err)));
  box.append(button("Go to Today", "btn", () => go("#/today")));
  ui.content.replaceChildren(box);
}

/** Shown when decisionsStatus says needsWorkspace. Not an error state. */
function showWorkspaceOnboarding() {
  const existing = state.status?.workspaces ?? [];
  const box = emptyBox(
    "Create a workspace",
    existing.length
      ? "Nothing is open at the moment. Choose one of your workspaces, or start a new one."
      : "A workspace holds one company's customer data, decisions and settings.",
  );

  for (const w of existing) {
    box.append(
      button(w.name, "btn", async () => {
        const r = await api("decisionsWorkspaceSelect", { method: "POST", body: { id: w.id } });
        if (!r.ok) return showError(new Error(r.error ?? "that workspace could not be opened"));
        await refreshStatus();
        renderRoute();
      }),
    );
  }

  const row = el("div", "v2-ws-new");
  const input = el("input", "v2-input");
  input.type = "text";
  input.placeholder = "Company name";
  const err = el("div", "err");
  err.hidden = true;
  const create = button("Create workspace", "btn primary", async () => {
    create.disabled = true;
    const r = await api("decisionsWorkspaceCreate", { method: "POST", body: { name: input.value } });
    create.disabled = false;
    if (!r.ok) {
      err.textContent = r.error ?? "the workspace could not be created";
      err.hidden = false;
      return;
    }
    await refreshStatus();
    renderRoute();
  });
  input.onkeydown = (e) => {
    if (e.key === "Enter") create.click();
  };
  row.append(input, create);
  box.append(row, err);

  ui.content.replaceChildren(box);
}

/* ── boot ───────────────────────────────────────────────────────────────── */

async function boot() {
  buildShell();
  window.addEventListener("hashchange", renderRoute);
  // Set the default route without firing hashchange, so the first paint is one
  // render and not two. location.search carries the token; keep it.
  if (!location.hash) history.replaceState(null, "", location.pathname + location.search + "#/today");
  await refreshStatus();
  await renderRoute();
}

boot();
