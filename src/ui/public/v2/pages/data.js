// Data — getting customer data into Ledgerline, and the workspaces that hold it.
//
// THE HONEST CLAIM THIS SCREEN HAS TO CARRY.
// There is exactly one way in: a FOLDER on this computer holding CSV files with
// six exact names. That is not a limitation this page hides behind a grid of
// greyed-out logos — it is the whole surface area, so it is written out in full,
// with the required columns for every file, taken from the parser's own contract
// (decisionsSettingsGet.contract) rather than retyped here where it could drift.
//
// THE DRAG-AND-DROP CONSTRAINT, WHICH IS REAL AND IS NOT WORKED AROUND.
// The import route takes `{ path: "C:\\...\\folder" }` — a path the SERVER opens.
// A browser never tells a page where a dropped file lives on disk: File carries a
// name, a size and bytes, and no path. There is no route that accepts file
// content. So a drop physically cannot start an import, and pretending otherwise
// would mean inventing a route.
//
// What a drop CAN do is everything that happens before the import, and that turns
// out to be the part that actually fails: wrong file names, a header row that is
// missing a column the parser requires, and — measured in this codebase — a CSV
// exported empty, with no header row at all, which the importer rejects only
// after you have gone and found the folder. So the drop zone runs the same
// checks the parser will run, in this window, against the parser's own contract,
// and says what is wrong BEFORE anything is imported.
//
// The drop then imports directly, through decisionsUpload. That route did not
// exist when this page was first written, and the note here used to say the
// Windows folder picker was "the only thing on this machine that can hand the
// server a real absolute path" - true at the time, because a dropped File
// deliberately reports C:\fakepath\... and carries no real path, so the bytes
// had nowhere to go. decisionsUpload takes the bytes instead of a path and
// hands the importer a folder, so dropping and picking now end in the same
// place. The picker is still here for a folder you would rather browse to.
//
// No innerHTML anywhere. Customer file names, server paths and rejection reasons
// are all untrusted text and every one of them goes in with textContent.

export const title = "Data";

/* ── dom helpers ────────────────────────────────────────────────────────── */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function button(label, cls, onClick) {
  const b = el("button", cls ?? "btn", label);
  b.type = "button";
  b.onclick = onClick;
  return b;
}

/**
 * A button that disables itself for the length of an await.
 *
 * Not decoration. decisionsImportPick blocks for as long as the user browses the
 * folder dialog, decisionsSeedDemo writes and re-imports ~48 accounts of CSV, and
 * a second click on either lands on a route that answers "a picker is already
 * open" or replaces the tables a second time.
 */
function busyButton(label, busyLabel, cls, fn) {
  const b = button(label, cls, async () => {
    b.disabled = true;
    b.textContent = busyLabel;
    try {
      await fn();
    } finally {
      // The page usually re-renders on success and this node is thrown away;
      // on failure it has to come back, so the reset is unconditional.
      b.disabled = false;
      b.textContent = label;
    }
  });
  return b;
}

function textInput(placeholder, value) {
  const i = el("input", "dx-input");
  i.type = "text";
  i.spellcheck = false;
  if (placeholder) i.placeholder = placeholder;
  if (value != null) i.value = value;
  return i;
}

/** An error box that always shows the server's own wording, never a paraphrase. */
function errBox(headline, detail) {
  const box = el("div", "err");
  box.append(el("strong", null, headline));
  if (detail) box.append(el("code", null, String(detail)));
  return box;
}

function panel(heading, sub) {
  const p = el("section", "panel dx-panel");
  if (heading) p.append(el("h3", null, heading));
  if (sub) p.append(el("p", "dx-sub", sub));
  return p;
}

function rowOf(...nodes) {
  const r = el("div", "dx-row");
  r.append(...nodes.filter(Boolean));
  return r;
}

/** A path, shown so it can be read AND copied — the two things a path is for. */
function pathField(value) {
  const wrap = el("div", "dx-row");
  const input = el("input", "dx-input dx-path");
  input.type = "text";
  input.readOnly = true;
  input.value = String(value);
  input.onfocus = () => input.select();
  const said = el("span", "dx-hint");
  wrap.append(
    input,
    button("Copy", "btn tiny", async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        said.textContent = "Copied.";
      } catch {
        // Clipboard access can be refused; selecting the text leaves the user a
        // working Ctrl+C rather than a button that did nothing.
        input.focus();
        input.select();
        said.textContent = "Could not copy — the path is selected, press Ctrl+C.";
      }
    }),
    said,
  );
  return wrap;
}

function fmtDate(ctx, iso) {
  const f = ctx.fmt?.date;
  if (typeof f === "function") {
    const out = f(iso);
    if (out) return String(out);
  }
  return String(iso ?? "");
}

/** A size read off the dropped File itself. Labelled as such wherever it shows. */
function fmtSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── the file contract ──────────────────────────────────────────────────── */

// Plain-English purpose only. The REQUIRED AND OPTIONAL COLUMNS ARE NEVER
// WRITTEN HERE — they come from the API's `contract`, so this screen cannot tell
// you a column is optional after the parser has started requiring it.
const FILE_PURPOSE = {
  "accounts.csv": "One row per customer.",
  "usage_daily.csv": "One row per customer per day.",
  "contacts.csv": "Who your contacts are, and when each was last active.",
  "tickets.csv": "Support tickets, opened and closed.",
  "invoices.csv": "Invoices, and whether they were paid.",
  "events.csv": "Notable moments: a pricing page view, a seat limit hit.",
};

// workspace.json is not part of the CSV contract and has no columns, but the
// importer does read it (currency, seat price, company name, as-of date) and the
// templates route writes one. A drop that contains it should not be told it is
// an unrecognised file.
const EXTRA_FILE = {
  "workspace.json": "Optional. Sets the currency, the seat price and the company name.",
};

const SPREADSHEET_EXT = /\.(xlsx|xlsm|xls|ods|numbers)$/i;

/* ── reading a dropped file, in this window ─────────────────────────────── */

// Only the first slice of each file is read. usage_daily.csv is the big one — it
// is one row per customer per day and can run to tens of megabytes — and the
// only thing this check needs from it is line one.
const HEADER_BYTES = 64 * 1024;

/**
 * Split one CSV line into fields.
 *
 * Deliberately the same shape as src/tools/documents.mjs parseCsv: comma is the
 * only delimiter it accepts, `""` inside quotes is an escaped quote. If this
 * disagreed with the parser the check would be worse than no check at all.
 */
function splitCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      out.push(field);
      field = "";
      continue;
    }
    field += c;
  }
  out.push(field);
  return out;
}

/** The header row as the importer will see it: BOM stripped, trimmed, lowercased. */
async function readHeaderRow(file) {
  let text = await file.slice(0, HEADER_BYTES).text();
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Excel writes a BOM; readCsvFile strips one too
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  if (!first.trim()) return [];
  return splitCsvLine(first).map((h) => h.trim().toLowerCase());
}

/**
 * Check a set of dropped files against the parser's contract.
 *
 * Returns only facts: which of the contract's files are here, what their header
 * rows contain, and which of the required columns are absent. Nothing is
 * imported and nothing is sent anywhere — the bytes never leave this window.
 */
async function inspectFiles(files, contract) {
  const known = [];
  const unknown = [];
  const byName = new Map();
  for (const f of files) byName.set(f.name.trim().toLowerCase(), f);

  for (const [name, spec] of Object.entries(contract)) {
    const file = byName.get(name);
    byName.delete(name);
    const entry = { name, required: !!spec.required, file: file ?? null, problems: [], note: "" };
    if (!file) {
      known.push(entry);
      continue;
    }
    let headers = [];
    try {
      headers = await readHeaderRow(file);
    } catch (err) {
      entry.problems.push(`The file could not be read in this window: ${err?.message ?? err}`);
      known.push(entry);
      continue;
    }
    if (!headers.length) {
      // THE MEASURED FAILURE. An empty export carries no header row, and the
      // importer rejects it with a missing-column error that reads as if the
      // data were wrong rather than absent.
      entry.problems.push("This file is empty — it has no header row, so the import will reject it.");
      known.push(entry);
      continue;
    }
    entry.headers = headers;
    const missing = (spec.req ?? []).filter((c) => !headers.includes(c));
    if (missing.length) {
      entry.problems.push(`The header row is missing: ${missing.join(", ")}`);
    }
    const allowed = new Set([...(spec.req ?? []), ...(spec.opt ?? [])]);
    const extra = headers.filter((h) => h && !allowed.has(h));
    if (extra.length) entry.note = `Columns Ledgerline will ignore: ${extra.join(", ")}`;
    known.push(entry);
  }

  for (const [lower, file] of byName) {
    if (EXTRA_FILE[lower]) {
      unknown.push({ name: file.name, kind: "extra", why: EXTRA_FILE[lower] });
    } else if (SPREADSHEET_EXT.test(lower)) {
      unknown.push({
        name: file.name,
        kind: "spreadsheet",
        why: "This is a spreadsheet, not a CSV. In Excel choose File, then Save As, then CSV — and give it one of the names above.",
      });
    } else if (lower.endsWith(".csv")) {
      unknown.push({
        name: file.name,
        kind: "csv",
        why: "Ledgerline matches on the exact file name. Rename it to one of the names above, or leave it out.",
      });
    } else {
      unknown.push({ name: file.name, kind: "other", why: "Not a CSV. Ledgerline will not open it." });
    }
  }

  return { known, unknown };
}

/* ── drag and drop plumbing ─────────────────────────────────────────────── */

// A file dropped anywhere on a Chromium window is opened IN that window by
// default, which replaces the running app with a text file and loses whatever
// was half-typed. The guard is installed once and never removed: it is correct
// for every screen, and the module contract gives a page no unmount hook to
// remove it in.
let dropGuardInstalled = false;
function installDropGuard() {
  if (dropGuardInstalled) return;
  dropGuardInstalled = true;
  // Bubble phase, so the drop zone's own handlers still run first.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
}

/** readEntries hands back at most 100 entries per call; keep asking until empty. */
function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        next();
      }, reject);
    next();
  });
}

const entryFile = (entry) => new Promise((resolve, reject) => entry.file(resolve, reject));

/**
 * Every file in a drop, plus the name of the folder if one was dropped.
 *
 * One level deep only: the contract is a flat folder of six files, so walking
 * further would collect files the importer will never look at.
 */
async function filesFromDrop(dt) {
  const files = [];
  let folderName = null;

  const items = dt?.items ? Array.from(dt.items) : [];
  const entries = items
    .filter((it) => it.kind === "file" && typeof it.webkitGetAsEntry === "function")
    .map((it) => it.webkitGetAsEntry())
    .filter(Boolean);

  if (entries.length) {
    for (const entry of entries) {
      if (entry.isDirectory) {
        folderName = folderName ?? entry.name;
        const children = await readAllEntries(entry.createReader());
        for (const child of children) {
          if (child.isFile) files.push(await entryFile(child));
        }
      } else if (entry.isFile) {
        files.push(await entryFile(entry));
      }
    }
    return { files, folderName };
  }

  // No entry API (or a source that does not provide it): plain files only.
  return { files: Array.from(dt?.files ?? []), folderName: null };
}

/** The folder name behind a <input webkitdirectory> selection, when there is one. */
function folderOfSelection(fileList) {
  for (const f of fileList) {
    const rel = f.webkitRelativePath ?? "";
    const top = rel.split("/")[0];
    if (top && top !== f.name) return top;
  }
  return null;
}

/* ── the check panel ────────────────────────────────────────────────────── */

function checkRow(entry) {
  const bad = entry.problems.length > 0;
  const missing = !entry.file;
  const state = missing ? (entry.required ? "bad" : "off") : bad ? "bad" : "ok";

  const row = el("div", `dx-check dx-${state}`);
  row.append(el("span", "dx-dot"));

  const main = el("div", "dx-check-main");
  const head = el("div", "dx-check-head");
  head.append(el("code", "dx-file", entry.name));
  head.append(el("span", "chip", entry.required ? "required" : "optional"));
  if (entry.file) head.append(el("span", "dx-hint", `${fmtSize(entry.file.size)} on this computer`));
  main.append(head);

  if (missing) {
    main.append(
      el(
        "div",
        "dx-check-line",
        entry.required
          ? "Not in what you dropped. The import will stop without it."
          : "Not in what you dropped. That is allowed — the import will run without it.",
      ),
    );
  } else {
    for (const p of entry.problems) main.append(el("div", "dx-check-line dx-bad-text", p));
    if (!entry.problems.length) main.append(el("div", "dx-check-line", "Every column the parser requires is in the header row."));
    if (entry.note) main.append(el("div", "dx-check-line dx-hint", entry.note));
  }

  row.append(main);
  return row;
}

function checkPanel(result, folderName) {
  const box = el("div", "dx-checks");

  const lead = el("div", "dx-lead");
  lead.append(
    el(
      "p",
      "dx-sub",
      folderName
        ? `Checked the folder "${folderName}" in this window. Nothing has been imported yet.`
        : "Checked in this window. Nothing has been imported yet.",
    ),
  );
  box.append(lead);

  const problems = result.known.filter((e) => e.problems.length || (!e.file && e.required)).length;
  box.append(
    el(
      "p",
      problems ? "dx-verdict dx-bad-text" : "dx-verdict dx-ok-text",
      problems
        ? `${problems} of these would stop the import. Fix them in the files, then import the folder.`
        : "These files pass the checks Ledgerline can run before reading them. Import the folder to load them.",
    ),
  );

  for (const entry of result.known) box.append(checkRow(entry));

  if (result.unknown.length) {
    box.append(el("h4", "dx-subhead", "Also dropped"));
    for (const u of result.unknown) {
      const row = el("div", `dx-check dx-${u.kind === "extra" ? "ok" : "off"}`);
      row.append(el("span", "dx-dot"));
      const main = el("div", "dx-check-main");
      const head = el("div", "dx-check-head");
      head.append(el("code", "dx-file", u.name));
      main.append(head);
      main.append(el("div", "dx-check-line", u.why));
      row.append(main);
      box.append(row);
    }
  }
  return box;
}

/* ── the import report ──────────────────────────────────────────────────── */

/**
 * What was read, what was skipped, and why — per file.
 *
 * Rejection reasons are written by the parser and counted per reason, and the
 * report carries up to three example rows for each. Those examples are raw lines
 * out of a customer's own CSV, so they go in as text, inside a <pre>.
 */
function reportTable(ctx, report) {
  const box = el("div", "dx-report");

  const meta = el("div", "dx-meta");
  if (report.at) meta.append(el("span", null, `Imported ${fmtDate(ctx, report.at)}`));
  if (Number.isFinite(report.accounts)) {
    meta.append(el("span", null, `${report.accounts} customer${report.accounts === 1 ? "" : "s"}`));
  }
  box.append(meta);
  if (report.folder) {
    box.append(el("div", "dx-hint", "Read from"));
    box.append(pathField(report.folder));
  }

  const table = el("table", "dx-table");
  const thead = el("thead");
  const hr = el("tr");
  for (const [h, cls] of [["File", ""], ["Rows read", "dx-num"], ["Used", "dx-num"], ["Skipped", "dx-num"]]) {
    hr.append(el("th", cls, h));
  }
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  for (const [name, f] of Object.entries(report.files ?? {})) {
    const tr = el("tr", f.present ? null : "dx-off-row");
    tr.append(el("td", null, name));
    if (!f.present) {
      const td = el("td", "dx-hint");
      td.colSpan = 3;
      td.textContent = "not in the folder";
      tr.append(td);
      tbody.append(tr);
      continue;
    }
    tr.append(el("td", "dx-num", String(f.read)));
    tr.append(el("td", "dx-num", String(f.accepted)));
    tr.append(el("td", `dx-num${f.rejected ? " dx-bad-text" : ""}`, String(f.rejected)));
    tbody.append(tr);

    // The reasons are the whole point of the report: "skipped 14" is useless,
    // "renewal_date is not a date (use YYYY-MM-DD) — 14 rows" is actionable.
    for (const [reason, n] of Object.entries(f.reasons ?? {})) {
      const rr = el("tr", "dx-reason-row");
      const td = el("td");
      td.colSpan = 4;
      td.append(el("span", "dx-reason", reason));
      td.append(el("span", "dx-hint", ` — ${n} row${n === 1 ? "" : "s"}`));
      rr.append(td);
      tbody.append(rr);
    }
    const examples = (f.examples ?? []).filter((e) => e && e.row);
    if (examples.length) {
      const er = el("tr", "dx-reason-row");
      const td = el("td");
      td.colSpan = 4;
      td.append(el("div", "dx-hint", `Example row${examples.length === 1 ? "" : "s"} that was skipped:`));
      for (const ex of examples) td.append(el("pre", "dx-example", String(ex.row)));
      er.append(td);
      tbody.append(er);
    }
  }
  table.append(tbody);
  const scroll = el("div", "dx-scroll");
  scroll.append(table);
  box.append(scroll);

  for (const w of report.warnings ?? []) {
    box.append(el("p", "dx-warn-line", w));
  }
  if (report.copiedTo) {
    box.append(el("div", "dx-hint", "A copy of the files as they were imported was kept here, so any number can be traced back:"));
    box.append(pathField(report.copiedTo));
  }
  return box;
}

/* ── import actions ─────────────────────────────────────────────────────── */

/**
 * The bytes of one File as base64, without blowing the stack.
 *
 * ⚠️ NOT String.fromCharCode(...bytes). Spreading a multi-megabyte Uint8Array
 * into an argument list throws "Maximum call stack size exceeded" somewhere
 * above a hundred thousand elements, and a CSV that size is ordinary here.
 * Chunking is what makes it survive a real spreadsheet.
 */
async function fileToBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Send dropped files to the server and import them.
 *
 * 🔴 WHY THIS EXISTS. A dropped File carries no real path - browsers report
 * C:\fakepath\... deliberately - so decisionsImport, which takes a server-side
 * folder, can never see it. Until decisionsUpload was added, a drop could be
 * CHECKED in this window but not imported, and the only way through was the
 * Windows folder picker.
 *
 * Batching is forced by the 8 MB request cap in server.mjs, and base64 inflates
 * bytes by about a third. The folder is cleared on the first batch only and the
 * import runs on the last, because the importer needs every file present at
 * once: accounts.csv on its own is a failed import.
 */
async function uploadFiles(ctx, files) {
  const list = Array.from(files ?? []);
  if (!list.length) return { ok: false, error: "no files were dropped" };

  // Comfortably under the 8 MB cap once base64 has added its third, with room
  // for the JSON envelope.
  const CAP = 4 * 1024 * 1024;
  const batches = [];
  let batch = [];
  let size = 0;
  for (const f of list) {
    if (batch.length && size + f.size > CAP) {
      batches.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(f);
    size += f.size;
  }
  if (batch.length) batches.push(batch);

  let last = null;
  for (let i = 0; i < batches.length; i++) {
    const encoded = [];
    for (const f of batches[i]) {
      encoded.push({ name: f.name, base64: await fileToBase64(f) });
    }
    last = await ctx.api("decisionsUpload", {
      method: "POST",
      body: { files: encoded, append: i > 0, final: i === batches.length - 1 },
    });
    // A failed batch stops the run: continuing would import a partial folder
    // and report success over the top of a real error.
    if (!last?.ok) return last;
  }
  return last;
}

/**
 * Run one of the two import routes and paint the outcome.
 *
 * Resolves true only when data actually landed, because the caller re-renders on
 * a true and must not re-render over an error the user still has to read.
 * decisionsImportPick has a third answer besides ok and not-ok: `cancelled`
 * arrives on an ok:true and means nothing happened at all.
 */
async function runImport(ctx, slot, call) {
  slot.replaceChildren(el("p", "dx-sub", "Reading the folder…"));
  let r;
  try {
    r = await call();
  } catch (err) {
    slot.replaceChildren(errBox("The import could not be started.", err?.message ?? err));
    return false;
  }
  if (r?.cancelled) {
    slot.replaceChildren(el("p", "dx-sub", "The folder picker was closed. Nothing was imported."));
    return false;
  }
  if (!r?.ok) {
    const box = el("div");
    box.append(
      errBox(
        r?.needsWorkspace ? "There is no workspace open to import into." : "The import did not work.",
        r?.error ?? "The app gave no reason.",
      ),
    );
    // A failed import still carries the part of the report it got through, and
    // that is what says WHICH file it stopped on.
    if (r?.report?.files) box.append(reportTable(ctx, r.report));
    slot.replaceChildren(box);
    return false;
  }
  return true;
}

function importPanel(ctx, page) {
  const box = panel("Import a folder");
  box.append(
    el(
      "p",
      "dx-sub",
      "Ledgerline opens the folder itself, so it needs the path. The picker is the only way to give it one — a browser is never told where a dropped file lives on this computer.",
    ),
  );

  // The outcome of an import is the thing a screen reader most needs told, and
  // it arrives without any focus moving.
  const slot = el("div", "dx-slot");
  slot.setAttribute("aria-live", "polite");

  const pathIn = textInput("C:\\Users\\you\\customer-data");
  pathIn.setAttribute("aria-label", "Folder path to import");
  page.pathInput = pathIn; // the templates panel prefills this after writing them

  const pick = busyButton("Choose the folder…", "The picker is open…", "btn btn-primary", async () => {
    const done = await runImport(ctx, slot, () => ctx.api("decisionsImportPick", { method: "POST" }));
    if (done) await page.reload("Imported.");
  });

  const typed = busyButton("Import this path", "Importing…", "btn", async () => {
    const p = pathIn.value.trim();
    if (!p) {
      slot.replaceChildren(errBox("Type a folder path first.", "Or use “Choose the folder…”, which fills it in for you."));
      return;
    }
    const done = await runImport(ctx, slot, () => ctx.api("decisionsImport", { method: "POST", body: { path: p } }));
    if (done) await page.reload("Imported.");
  });

  pathIn.onkeydown = (e) => {
    if (e.key === "Enter") typed.click();
  };

  box.append(rowOf(pick));
  box.append(el("div", "dx-orline", "or, if you already know the path"));
  box.append(rowOf(pathIn, typed));
  box.append(slot);
  box.append(
    el(
      "p",
      "dx-hint",
      "Importing replaces the customers, usage, tickets, invoices and events in this workspace. Decisions, notes and outcomes are kept.",
    ),
  );
  return box;
}

/* ── the drop zone ──────────────────────────────────────────────────────── */

function dropPanel(ctx, page) {
  const contract = page.contract;
  const box = panel("Check your files first");

  if (!contract) {
    box.append(
      el(
        "p",
        "dx-sub",
        "The list of files and columns comes from the app, and the app did not answer. The checks below cannot run until it does.",
      ),
    );
    return box;
  }

  box.append(
    el(
      "p",
      "dx-sub",
      "Drop the folder, or the CSV files, here. They are read in this window only — nothing is uploaded, nothing is imported, and nothing leaves this computer.",
    ),
  );

  const zone = el("div", "dx-zone");
  const inner = el("div", "dx-zone-inner");
  inner.append(el("div", "dx-zone-big", "Drop a folder or CSV files here"));
  inner.append(el("div", "dx-hint", "Several files at once is fine."));

  // Two hidden inputs, two real buttons. A file input styled away is invisible
  // to the keyboard, so the buttons carry the function and the inputs never take
  // focus — drag-only would leave this panel unusable without a mouse.
  const fileIn = el("input");
  fileIn.type = "file";
  fileIn.multiple = true;
  fileIn.accept = ".csv,.json,text/csv,application/json";
  fileIn.hidden = true;

  const dirIn = el("input");
  dirIn.type = "file";
  dirIn.hidden = true;
  // webkitdirectory is a property as well as an attribute, and Chromium wants it
  // set before the element is used. It still returns files, not a path.
  dirIn.webkitdirectory = true;
  dirIn.setAttribute("webkitdirectory", "");

  const actions = el("div", "dx-row");
  actions.append(button("Choose files…", "btn", () => fileIn.click()));
  actions.append(button("Choose a folder…", "btn", () => dirIn.click()));
  inner.append(actions);
  zone.append(inner);

  const slot = el("div", "dx-slot");
  slot.setAttribute("aria-live", "polite");

  async function check(files, folderName) {
    const list = Array.from(files ?? []);
    if (!list.length) {
      slot.replaceChildren(
        errBox(
          "Nothing was dropped that Ledgerline can read.",
          "Drop the folder that holds the CSV files, or the CSV files themselves.",
        ),
      );
      return;
    }
    slot.replaceChildren(el("p", "dx-sub", "Reading the header rows…"));
    try {
      const result = await inspectFiles(list, contract);
      page.lastCheck = { result, folderName }; // survives a re-render of this page
      const panel = checkPanel(result, folderName);

      // The drop can now import directly. Before decisionsUpload existed this
      // panel was a dead end that told you to go and find the folder yourself.
      const label = `Import ${list.length} file${list.length === 1 ? "" : "s"}`;
      const go = busyButton(label, "Importing…", "btn btn-primary", async () => {
        const done = await runImport(ctx, slot, () => uploadFiles(ctx, list));
        if (done) await page.reload("Imported.");
      });
      const row = el("div", "dx-actions");
      row.append(go);
      panel.append(row);

      slot.replaceChildren(panel);
    } catch (err) {
      slot.replaceChildren(errBox("Those files could not be read in this window.", err?.message ?? err));
    }
  }

  // dragleave fires every time the pointer crosses a child, so the highlight is
  // driven by a depth counter rather than by the last event seen.
  let depth = 0;
  const lift = (on) => zone.classList.toggle("dx-over", on);
  zone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    depth += 1;
    lift(true);
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    lift(true);
  });
  zone.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) lift(false);
  });
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    depth = 0;
    lift(false);
    let picked;
    try {
      picked = await filesFromDrop(e.dataTransfer);
    } catch (err) {
      slot.replaceChildren(errBox("That drop could not be read.", err?.message ?? err));
      return;
    }
    await check(picked.files, picked.folderName);
  });

  fileIn.onchange = () => check(fileIn.files, null);
  dirIn.onchange = () => check(dirIn.files, folderOfSelection(Array.from(dirIn.files ?? [])));

  box.append(zone, fileIn, dirIn, slot);

  // Repaint the last check when the page re-renders (after an import, say), so
  // the work of dropping is not silently thrown away.
  if (page.lastCheck) slot.replaceChildren(checkPanel(page.lastCheck.result, page.lastCheck.folderName));

  return box;
}

/* ── demo company ───────────────────────────────────────────────────────── */

function demoPanel(ctx, page) {
  const variants = page.status?.variants ?? {};
  const names = Object.keys(variants);
  const box = panel("Load the demo company");

  if (!names.length) {
    box.append(
      el(
        "p",
        "dx-sub",
        page.status
          ? "The app did not list any demo datasets, so there is nothing to load."
          : "The list of demo datasets comes from the app, and the app did not answer.",
      ),
    );
    return box;
  }

  box.append(
    el(
      "p",
      "dx-sub",
      "Invented customers, generated on this computer, for seeing what the product does before you bring your own data. Loading one replaces the customer data in this workspace and turns demo mode on.",
    ),
  );

  let chosen = names[0];
  const chips = el("div", "dx-variants");
  const buttons = [];
  for (const name of names) {
    const b = el("button", "dx-variant");
    b.type = "button";
    b.setAttribute("aria-pressed", String(name === chosen));
    b.append(el("span", "dx-variant-name", name));
    b.append(el("span", "dx-hint", String(variants[name])));
    b.onclick = () => {
      chosen = name;
      for (const other of buttons) other.setAttribute("aria-pressed", String(other === b));
    };
    buttons.push(b);
    chips.append(b);
  }
  box.append(chips);

  const slot = el("div", "dx-slot");
  box.append(
    rowOf(
      busyButton("Load this demo", "Generating…", "btn", async () => {
        slot.replaceChildren(el("p", "dx-sub", "Generating the customers and importing them…"));
        let r;
        try {
          r = await ctx.api("decisionsSeedDemo", { method: "POST", body: { variant: chosen } });
        } catch (err) {
          slot.replaceChildren(errBox("The demo could not be loaded.", err?.message ?? err));
          return;
        }
        if (!r?.ok) {
          const wrap = el("div");
          wrap.append(errBox("The demo could not be loaded.", r?.error ?? "The app gave no reason."));
          if (r?.report?.files) wrap.append(reportTable(ctx, r.report));
          slot.replaceChildren(wrap);
          return;
        }
        await page.reload(`Loaded ${r.accounts} demo customers.`);
      }),
    ),
  );
  box.append(slot);
  if (page.status?.demoMode) {
    box.append(el("p", "dx-warn-line", "Demo mode is on in this workspace. Turn it off in Settings once you import real data."));
  }
  return box;
}

/* ── templates and the contract ─────────────────────────────────────────── */

function contractTable(contract) {
  const table = el("table", "dx-table");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of ["File", "Needed", "Must have these columns", "May also have"]) hr.append(el("th", null, h));
  thead.append(hr);
  table.append(thead);

  const tbody = el("tbody");
  for (const [name, spec] of Object.entries(contract)) {
    const tr = el("tr");
    const first = el("td");
    first.append(el("code", "dx-file", name));
    const purpose = FILE_PURPOSE[name];
    if (purpose) first.append(el("div", "dx-hint", purpose));
    tr.append(first);
    tr.append(el("td", spec.required ? "dx-bad-text" : "dx-hint", spec.required ? "required" : "optional"));
    tr.append(el("td", "dx-cols", (spec.req ?? []).join(", ")));
    tr.append(el("td", "dx-cols dx-hint", (spec.opt ?? []).join(", ") || "—"));
    tbody.append(tr);
  }
  table.append(tbody);

  const wrap = el("div", "dx-scroll");
  wrap.append(table);
  return wrap;
}

function templatesPanel(ctx, page) {
  const box = panel("Blank templates, and what each file must contain");
  box.append(
    el(
      "p",
      "dx-sub",
      "This is the whole list. Ledgerline reads these files and nothing else — there is no connector to a CRM, a billing system or a warehouse, and this window cannot reach the internet.",
    ),
  );

  if (page.contract) box.append(contractTable(page.contract));
  else box.append(el("p", "dx-sub", "The column list comes from the app, and the app did not answer."));

  const slot = el("div", "dx-slot");
  box.append(
    rowOf(
      busyButton("Write blank templates", "Writing…", "btn", async () => {
        let r;
        try {
          r = await ctx.api("decisionsTemplates", { method: "POST" });
        } catch (err) {
          slot.replaceChildren(errBox("The templates could not be written.", err?.message ?? err));
          return;
        }
        if (!r?.ok) {
          slot.replaceChildren(errBox("The templates could not be written.", r?.error ?? "The app gave no reason."));
          return;
        }
        const out = el("div");
        out.append(
          el(
            "p",
            "dx-sub",
            `Written: ${(r.files ?? []).join(", ")}. Each one carries the header row and a single example row — fill it in, delete the example, then import the folder.`,
          ),
        );
        out.append(pathField(r.folder));
        slot.replaceChildren(out);
        // Save the walk back up the page: the path this just wrote is almost
        // always the path the import field wants next.
        if (page.pathInput) page.pathInput.value = r.folder;
      }),
    ),
  );
  box.append(slot);
  return box;
}

/* ── workspaces ─────────────────────────────────────────────────────────── */

function workspaceRow(ctx, page, w, currentId) {
  const row = el("div", `dx-ws${w.id === currentId ? " dx-ws-current" : ""}`);

  const head = el("div", "dx-ws-head");
  const name = el("div", "dx-ws-name");
  name.append(el("strong", null, w.name));
  if (w.id === currentId) name.append(el("span", "chip on", "open now"));
  head.append(name);

  const when = el("div", "dx-hint");
  const bits = [];
  if (w.createdAt) bits.push(`made ${fmtDate(ctx, w.createdAt)}`);
  bits.push(w.lastRunAt ? `last analysis ${fmtDate(ctx, w.lastRunAt)}` : "no analysis yet");
  when.textContent = bits.join(" · ");
  head.append(when);
  row.append(head);

  const slot = el("div", "dx-slot");
  const actions = el("div", "dx-row");

  if (w.id !== currentId) {
    actions.append(
      busyButton("Open", "Opening…", "btn", async () => {
        const r = await ctx.api("decisionsWorkspaceSelect", { method: "POST", body: { id: w.id } });
        if (!r?.ok) {
          slot.replaceChildren(errBox("That workspace could not be opened.", r?.error ?? "The app gave no reason."));
          return;
        }
        await page.reload(`Opened ${w.name}.`);
      }),
    );
  }

  actions.append(
    button("Rename", "btn", () => {
      const form = el("div", "dx-row");
      const input = textInput("New name", w.name);
      input.setAttribute("aria-label", `New name for ${w.name}`);
      const save = busyButton("Save name", "Saving…", "btn btn-primary", async () => {
        const r = await ctx.api("decisionsWorkspaceRename", { method: "POST", body: { id: w.id, name: input.value } });
        if (!r?.ok) {
          slot.replaceChildren(errBox("The workspace could not be renamed.", r?.error ?? "The app gave no reason."));
          return;
        }
        await page.reload("Renamed.");
      });
      input.onkeydown = (e) => {
        if (e.key === "Enter") save.click();
      };
      form.append(input, save, button("Cancel", "btn ghost", () => slot.replaceChildren()));
      slot.replaceChildren(form);
      input.focus();
      input.select();
    }),
  );

  actions.append(
    button("Delete…", "btn danger", () => {
      // Two steps, and the second one needs the name typed out. The route
      // enforces this too; doing it here as well is what makes the sentence
      // above the box get read.
      const wrap = el("div", "dx-danger");
      wrap.append(
        el(
          "p",
          "dx-bad-text",
          `Deleting "${w.name}" removes its customers, its decisions, every note and outcome on them, and the copies of the files that were imported into it. It is permanent — there is no bin and no undo.`,
        ),
      );
      const input = textInput(w.name);
      input.id = `dx-confirm-${w.id}`;
      const go = button("Delete permanently", "btn danger", async () => {
        go.disabled = true;
        go.textContent = "Deleting…";
        let r;
        try {
          r = await ctx.api("decisionsWorkspaceDelete", { method: "POST", body: { id: w.id, confirmName: input.value } });
        } catch (err) {
          go.disabled = false;
          go.textContent = "Delete permanently";
          wrap.append(errBox("The workspace could not be deleted.", err?.message ?? err));
          return;
        }
        if (!r?.ok) {
          go.disabled = false;
          go.textContent = "Delete permanently";
          slot.replaceChildren(errBox("The workspace was not deleted.", r?.error ?? "The app gave no reason."));
          return;
        }
        await page.reload(`Deleted ${w.name}.`);
      });
      go.disabled = true;
      const label = el("label", "dx-label", `Type ${w.name} to confirm`);
      label.htmlFor = input.id;
      input.oninput = () => {
        go.disabled = input.value.trim() !== w.name;
      };
      input.onkeydown = (e) => {
        if (e.key === "Enter" && !go.disabled) go.click();
      };
      wrap.append(label, rowOf(input, go, button("Cancel", "btn ghost", () => slot.replaceChildren())));
      slot.replaceChildren(wrap);
      input.focus();
    }),
  );

  row.append(actions, slot);
  return row;
}

function workspacesPanel(ctx, page) {
  const box = panel("Workspaces");
  box.append(el("p", "dx-sub", "One workspace holds one company's data, decisions and settings. They never mix."));

  const list = page.status?.workspaces ?? [];
  const currentId = page.status?.workspace?.id ?? null;

  // "None" and "the app did not answer" are different facts, and saying the
  // first when the second is true is how a screen starts lying quietly.
  if (!page.status) box.append(el("p", "dx-sub", "The list of workspaces could not be read, so none are shown. Creating one still works."));
  else if (!list.length) box.append(el("p", "dx-sub", "There are no workspaces yet."));
  for (const w of list) box.append(workspaceRow(ctx, page, w, currentId));

  const slot = el("div", "dx-slot");
  const input = textInput("New workspace name");
  input.setAttribute("aria-label", "Name for a new workspace");
  const create = busyButton("Create workspace", "Creating…", "btn", async () => {
    const r = await ctx.api("decisionsWorkspaceCreate", { method: "POST", body: { name: input.value } });
    if (!r?.ok) {
      slot.replaceChildren(errBox("The workspace was not created.", r?.error ?? "The app gave no reason."));
      return;
    }
    // create() also selects the new one, so the whole page has to repaint.
    await page.reload(`Created ${r.workspace?.name ?? "the workspace"}. It is open now.`);
  });
  input.onkeydown = (e) => {
    if (e.key === "Enter") create.click();
  };
  box.append(el("div", "dx-sep"));
  box.append(rowOf(input, create));
  box.append(slot);

  if (page.dataDir) {
    box.append(el("div", "dx-hint", "The open workspace keeps its database and its imported files here:"));
    box.append(pathField(page.dataDir));
  }
  return box;
}

/* ── the page ───────────────────────────────────────────────────────────── */

// render() can be called again on the same root while the first set of fetches
// is still in flight. The newest call wins, and every await checks it still owns
// the screen before it touches the DOM.
let epoch = 0;

export async function render(root, ctx) {
  const mine = ++epoch;
  const isStale = () => mine !== epoch;
  installDropGuard();

  // Kept on ctx.state, so a drop that has been checked survives an import, a
  // workspace switch, or a walk to another screen and back.
  ctx.state.data ??= {};
  const page = ctx.state.data;
  page.reload = async (flash) => {
    page.flash = flash ?? null;
    if (typeof ctx.refresh === "function") await ctx.refresh();
    await render(root, ctx);
  };

  const loading = el("div");
  for (let i = 0; i < 3; i++) loading.append(el("div", "skeleton block dx-skel"));
  root.replaceChildren(styles(), loading);

  // Three reads, in parallel. decisionsSettingsGet is here for one field —
  // `contract` — because it is the only route that returns the parser's column
  // list without writing template files to disk as a side effect.
  let status, last, settings;
  try {
    [status, last, settings] = await Promise.all([
      ctx.api("decisionsStatus"),
      ctx.api("decisionsImportReport"),
      ctx.api("decisionsSettingsGet"),
    ]);
  } catch (err) {
    if (isStale()) return;
    const box = el("div", "dx-wrap");
    box.append(errBox("This page could not reach the app.", err?.message ?? err));
    box.append(rowOf(button("Try again", "btn", () => render(root, ctx))));
    root.replaceChildren(styles(), box);
    return;
  }
  if (isStale()) return;

  page.status = status?.ok ? status : null;
  page.contract = settings?.ok ? settings.contract : null;
  page.dataDir = settings?.ok ? settings.dataDir : null;

  const wrap = el("div", "dx-wrap");
  root.replaceChildren(styles(), wrap);

  /* heading */
  const head = el("div", "dx-head");
  head.append(el("h1", null, "Data"));
  head.append(
    el(
      "p",
      "dx-sub dx-claim",
      "Ledgerline reads CSV files from a folder on this computer. That is the only way in, and this is the whole list of what it reads.",
    ),
  );
  wrap.append(head);

  if (page.flash) {
    wrap.append(el("div", "dx-flash", page.flash));
    page.flash = null;
  }

  // decisionsStatus answers ok:true even with no workspace, so a not-ok here is
  // a real failure and not the first-run state.
  if (!status?.ok) {
    wrap.append(errBox("The app could not say what state this workspace is in.", status?.error ?? "No reason was given."));
  } else if (status.needsWorkspace) {
    wrap.append(
      errBox(
        "No workspace is open, so there is nowhere to import into.",
        "Create one below. Everything else on this page needs a workspace first.",
      ),
    );
    wrap.append(workspacesPanel(ctx, page));
    return;
  } else {
    const facts = el("div", "dx-facts");
    const n = status.workspace?.accounts ?? 0;
    facts.append(el("span", "chip", `${n} customer${n === 1 ? "" : "s"} in ${status.workspace?.name ?? "this workspace"}`));
    if (status.asOf) facts.append(el("span", "chip", `today is ${status.asOf}`));
    if (status.demoMode) facts.append(el("span", "chip warn", "demo data"));
    if (status.lastRun?.at) facts.append(el("span", "chip", `last analysis ${fmtDate(ctx, status.lastRun.at)}`));
    wrap.append(facts);
  }

  // settingsGet is the one call that can come back needsWorkspace while status
  // still says a workspace is open — a workspace deleted in another window.
  if (!settings?.ok) {
    wrap.append(
      errBox(
        "The file contract could not be read, so the checks below are switched off.",
        `decisionsSettingsGet said: ${settings?.error ?? "no reason given"}`,
      ),
    );
  }

  wrap.append(dropPanel(ctx, page));
  wrap.append(importPanel(ctx, page));

  /* last import */
  const lastBox = panel("The last import");
  if (!last?.ok) {
    lastBox.append(errBox("The last import report could not be read.", last?.error ?? "The app gave no reason."));
  } else if (!last.report) {
    lastBox.append(
      el("p", "dx-sub", "Nothing has been imported into this workspace yet. A report appears here after the first import."),
    );
  } else {
    lastBox.append(reportTable(ctx, last.report));
  }
  wrap.append(lastBox);

  wrap.append(demoPanel(ctx, page));
  wrap.append(templatesPanel(ctx, page));
  wrap.append(workspacesPanel(ctx, page));
}

/* ── styles ─────────────────────────────────────────────────────────────── */

// Scoped to a dx- prefix and shipped inside the page: this file owns no
// stylesheet and must not reach into one another agent wrote. The shared classes
// (.panel .btn .chip .err .skeleton) come from tokens.css and are not restated.
// Colours are tokens only — there is no hex literal in here.
function styles() {
  return el(
    "style",
    null,
    `
.dx-wrap { display:flex; flex-direction:column; gap:var(--s3); max-width:960px; padding-bottom:48px; }
.dx-head h1 { font-size:var(--fs-2xl); }
.dx-sub { color:var(--muted); font-size:var(--fs-sm); margin:0 0 var(--s3); }
.dx-claim { max-width:68ch; margin-top:var(--s2); }
.dx-hint { color:var(--muted); font-size:var(--fs-xs); }
.dx-skel { margin-bottom:var(--s3); }
.dx-panel > h3 { margin-bottom:var(--s2); }
.dx-facts { display:flex; flex-wrap:wrap; gap:6px; }
.dx-flash {
  border:1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  background:color-mix(in srgb, var(--accent) 12%, transparent);
  color:var(--text); border-radius:var(--radius); padding:var(--s2) var(--s3); font-size:var(--fs-sm);
}
.dx-row { display:flex; flex-wrap:wrap; gap:var(--s2); align-items:center; }
.dx-row + .dx-row { margin-top:var(--s2); }
.dx-slot:empty { display:none; }
.dx-slot { margin-top:var(--s3); display:flex; flex-direction:column; gap:var(--s2); }
.dx-sep { height:1px; background:var(--border-soft); margin:var(--s3) 0; }
.dx-label { display:block; font-size:var(--fs-xs); color:var(--muted); margin-bottom:4px; }
.dx-orline { color:var(--muted); font-size:var(--fs-xs); margin:var(--s3) 0 var(--s2); }

.dx-input {
  background:var(--bg); border:1px solid var(--border); color:var(--text);
  border-radius:var(--radius-sm); padding:7px 10px; font-size:var(--fs-sm); min-width:0; flex:1 1 260px;
}
.dx-input:read-only { color:var(--muted); }
.dx-path { font-family:var(--mono); font-size:var(--fs-xs); flex:1 1 320px; }

/* ── drop zone ─────────────────────────────────────────────────────────── */
/* The dashed border is the system's one dashed line, borrowed from .empty: it
   reads as "a space waiting to be filled" rather than as a control. */
.dx-zone {
  border:1px dashed var(--border); border-radius:var(--radius);
  padding:var(--s6) var(--s4); text-align:center;
  transition:border-color .12s ease, background-color .12s ease;
}
.dx-zone-inner { display:flex; flex-direction:column; align-items:center; gap:var(--s2); }
.dx-zone-big { font-size:var(--fs-lg); font-weight:600; color:var(--text); }
/* The highlight has to be unmistakable while a file hovers, because the pointer
   is holding something and there is no click to confirm what will happen. */
.dx-zone.dx-over {
  border-color:var(--accent); border-style:solid;
  background:color-mix(in srgb, var(--accent) 10%, transparent);
}
.dx-zone.dx-over .dx-zone-big { color:var(--accent); }

/* ── per-file check ────────────────────────────────────────────────────── */
.dx-checks { display:flex; flex-direction:column; gap:var(--s2); }
.dx-lead { margin-bottom:var(--s1); }
.dx-verdict { font-size:var(--fs-sm); font-weight:600; margin:0 0 var(--s2); }
.dx-subhead { margin-top:var(--s3); color:var(--muted); font-size:var(--fs-sm); }
.dx-check { display:flex; gap:10px; align-items:flex-start; padding:var(--s2) 0; border-top:1px solid var(--border-soft); }
.dx-check-main { min-width:0; flex:1; }
.dx-check-head { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.dx-check-line { font-size:var(--fs-sm); color:var(--muted); margin-top:3px; }
.dx-file { font-family:var(--mono); font-size:var(--fs-sm); color:var(--text); }
/* One 8px dot carries the verdict, so a row is readable at a glance; the words
   next to it carry it for anyone who cannot see the colour. */
.dx-dot { width:8px; height:8px; border-radius:var(--radius-pill); margin-top:7px; flex:0 0 8px; background:var(--border); }
.dx-ok .dx-dot { background:var(--accent); }
.dx-bad .dx-dot { background:var(--danger); }
.dx-off .dx-dot { background:var(--border); }
.dx-ok-text { color:var(--accent); }
.dx-bad-text { color:var(--danger); }
.dx-warn-line { color:var(--warn); font-size:var(--fs-sm); margin:var(--s2) 0 0; }

/* ── tables ────────────────────────────────────────────────────────────── */
/* The contract table is wide and the window can be narrow; it scrolls on its
   own rather than pushing the page sideways. */
.dx-scroll { overflow-x:auto; margin-top:var(--s2); }
.dx-table { border-collapse:collapse; width:100%; font-size:var(--fs-sm); }
.dx-table th {
  text-align:left; font-size:var(--fs-xs); font-variant-caps:all-small-caps; letter-spacing:.06em;
  color:var(--muted); font-weight:600; padding:4px 10px 6px 0; border-bottom:1px solid var(--border);
}
.dx-table td { padding:6px 10px 6px 0; border-bottom:1px solid var(--border-soft); vertical-align:top; }
.dx-num { text-align:right; font-variant-numeric:tabular-nums; padding-right:var(--s4); }
.dx-table th.dx-num { text-align:right; }
.dx-off-row td { color:var(--muted); }
.dx-reason-row td { border-bottom:none; padding-top:0; }
.dx-reason { color:var(--warn); font-size:var(--fs-xs); }
.dx-cols { font-family:var(--mono); font-size:var(--fs-xs); }
.dx-example {
  margin:4px 0 0; padding:6px 8px; background:var(--bg); border:1px solid var(--border-soft);
  border-radius:var(--radius-sm); color:var(--muted); white-space:pre-wrap; word-break:break-word;
}
.dx-meta { display:flex; flex-wrap:wrap; gap:var(--s3); font-size:var(--fs-sm); margin-bottom:var(--s2); }
.dx-report { display:flex; flex-direction:column; gap:var(--s1); }

/* ── demo variants ─────────────────────────────────────────────────────── */
.dx-variants { display:flex; flex-direction:column; gap:6px; margin-bottom:var(--s3); }
.dx-variant {
  display:flex; flex-direction:column; align-items:flex-start; gap:2px; text-align:left;
  background:transparent; border:1px solid var(--border); border-radius:var(--radius-sm);
  padding:8px 10px; color:var(--text);
}
.dx-variant:hover { border-color:var(--muted); }
.dx-variant[aria-pressed="true"] { border-color:var(--accent); background:color-mix(in srgb, var(--accent) 10%, transparent); }
.dx-variant-name { font-family:var(--mono); font-size:var(--fs-sm); }

/* ── workspaces ────────────────────────────────────────────────────────── */
.dx-ws { border-top:1px solid var(--border-soft); padding:var(--s3) 0; }
.dx-ws-head { display:flex; flex-wrap:wrap; gap:var(--s2) var(--s3); align-items:baseline; margin-bottom:var(--s2); }
.dx-ws-name { display:flex; gap:var(--s2); align-items:center; }
.dx-ws-current { background:linear-gradient(90deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%); }
.dx-danger {
  border:1px solid color-mix(in srgb, var(--danger) 45%, transparent);
  border-radius:var(--radius); padding:var(--s3); display:flex; flex-direction:column; gap:var(--s2);
}
.dx-danger p { margin:0; font-size:var(--fs-sm); }
`,
  );
}
