// The manual, inside the app.
//
// 🔴 WHY THIS PAGE EXISTS. The v2 interface shipped without it. The manual was
// written once and wired into the OLDER Decisions page, so moving the app to v2
// would have silently dropped a whole feature - the reader would have had no way
// to find out what any of the ten screens did, from inside the product.
//
// ⭐ IT IMPORTS THE DATA, NOT THE RENDERER. `renderManual()` in the old file
// builds markup for the old stylesheet - classes like `block`, `pill-row` and
// `act` that tokens.css has never heard of. Importing it would have produced an
// unstyled page. `MANUAL` is plain data and belongs to neither interface, so it
// is imported and drawn again here with v2's own elements. One source of words,
// two renderers.
//
// No network, no model. This page is the thing you read when neither works.
import { MANUAL } from "../../decisions/help.js";

export const title = "Help";

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

/**
 * One block of a manual section.
 *
 * The shapes come from the MANUAL data: p, warn, callout+items, steps, table,
 * fact, head, kinds. An unknown shape is skipped rather than rendered as
 * "[object Object]", because a future block type must not be able to print
 * rubbish onto the page.
 */
function block(b) {
  if (b.p) return el("p", "hp-p", b.p);

  if (b.warn) {
    const d = el("div", "hp-warn");
    d.append(el("span", null, b.warn));
    return d;
  }

  if (b.fact) return el("p", "hp-fact", b.fact);

  if (b.head) return el("h4", "hp-head", b.head);

  if (b.callout) {
    const box = el("div", "hp-callout");
    box.append(el("div", "hp-callout-h", b.callout));
    if (Array.isArray(b.items) && b.items.length) {
      const ul = el("ul", "hp-list");
      for (const item of b.items) ul.append(el("li", null, item));
      box.append(ul);
    }
    return box;
  }

  if (Array.isArray(b.steps)) {
    const ol = el("ol", "hp-steps");
    for (const s of b.steps) {
      // A step is [title, body], but tolerate a bare string.
      const [head, body] = Array.isArray(s) ? s : [s, null];
      const li = el("li");
      li.append(el("strong", null, String(head)));
      if (body) li.append(el("span", null, " " + String(body)));
      ol.append(li);
    }
    return ol;
  }

  if (Array.isArray(b.table) && b.table.length) {
    const wrap = el("div", "hp-scroll");
    const t = el("table", "hp-table");
    // thead and tbody are built into variables and appended separately.
    // Node.append() returns undefined, so chaining off it throws - that broke a
    // page in this codebase once already.
    const thead = el("thead");
    const hr = el("tr");
    for (const cell of b.table[0]) hr.append(el("th", null, String(cell)));
    thead.append(hr);
    const tbody = el("tbody");
    for (const row of b.table.slice(1)) {
      const tr = el("tr");
      for (const cell of row) tr.append(el("td", null, String(cell)));
      tbody.append(tr);
    }
    t.append(thead);
    t.append(tbody);
    wrap.append(t);
    return wrap;
  }

  if (Array.isArray(b.kinds) && b.kinds.length) {
    const row = el("div", "hp-chips");
    for (const k of b.kinds) row.append(el("span", "chip", String(k)));
    return row;
  }

  return null;
}

export async function render(root, ctx) {
  root.replaceChildren(styles());

  const wrap = el("div", "hp-wrap");

  const head = el("header", "hp-top");
  head.append(el("h1", null, "How to use this"));
  head.append(el("p", "hp-sub", "The whole product on one page. It works with no internet and no model."));
  wrap.append(head);

  // Contents. Selecting an entry scrolls to its section.
  const toc = el("nav", "hp-toc");
  toc.setAttribute("aria-label", "Contents");
  for (const s of MANUAL) {
    const b = el("button", "chip hp-tocitem", s.title);
    b.type = "button";
    b.onclick = () => {
      const target = document.getElementById(`hp-${s.id}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    toc.append(b);
  }
  wrap.append(toc);

  for (const section of MANUAL) {
    const box = el("section", "panel hp-section");
    box.id = `hp-${section.id}`;
    box.append(el("h2", "hp-h2", section.title));
    if (section.blurb) box.append(el("p", "hp-blurb", section.blurb));
    for (const b of section.blocks ?? []) {
      const node = block(b);
      if (node) box.append(node);
    }
    wrap.append(box);
  }

  const foot = el("footer", "hp-foot");
  foot.append(el("p", null, `${MANUAL.length} sections. Nothing on this page is fetched, so it reads the same offline.`));
  wrap.append(foot);

  root.append(wrap);
}

function styles() {
  return el(
    "style",
    null,
    `
.hp-wrap { display:flex; flex-direction:column; gap:var(--s3); padding-bottom:var(--s6); max-width:78ch; }
.hp-top h1 { font-size:26px; font-weight:700; letter-spacing:-.02em; }
.hp-sub { color:var(--muted); margin-top:6px; }
.hp-toc { display:flex; flex-wrap:wrap; gap:8px; }
.hp-tocitem { cursor:pointer; }
.hp-tocitem:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.hp-section { padding:var(--s3); display:flex; flex-direction:column; gap:10px; }
.hp-h2 { font-size:17px; font-weight:600; }
.hp-blurb { color:var(--muted); }
.hp-p { line-height:1.65; }
.hp-fact { color:var(--muted); }
.hp-head { font-size:14px; font-weight:600; margin-top:4px; }
.hp-warn { border-left:3px solid var(--warn); padding:10px 12px; background:var(--bg); border-radius:var(--radius-sm); }
.hp-callout { border:1px solid var(--border); border-radius:var(--radius-sm); padding:12px; }
.hp-callout-h { font-weight:600; margin-bottom:6px; }
.hp-list, .hp-steps { padding-left:1.2em; display:flex; flex-direction:column; gap:6px; }
.hp-steps li strong { color:var(--text); }
.hp-steps li span { color:var(--muted); }
.hp-chips { display:flex; flex-wrap:wrap; gap:6px; }
.hp-scroll { overflow-x:auto; }
.hp-table { border-collapse:collapse; width:100%; font-size:13.5px; }
.hp-table th, .hp-table td { border:1px solid var(--border); padding:7px 9px; text-align:left; vertical-align:top; }
.hp-table th { color:var(--muted); font-weight:600; }
.hp-foot { color:var(--subtle); font-size:13px; }
`,
  );
}
