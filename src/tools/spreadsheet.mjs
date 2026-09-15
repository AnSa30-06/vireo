// Reading a real spreadsheet, as opposed to a well-formed one.
//
// The previous reader did four things that are fine for a file you exported
// yourself and wrong for a file a person made:
//
//   1. It took row 0 as the headers, always. One title row above the headers -
//      the single most common shape of a human spreadsheet - named every column
//      after a fragment of the title and shifted every record by one row. The
//      failure is silent: you get records, they are just all wrong.
//   2. It stringified every cell, so a date became "Mon Sep 15 2026 01:00:00
//      GMT+0530" and a number became a string that sorts as text.
//   3. It stopped at 5,000 rows and said nothing. A silent cap reads as
//      "imported everything" when it did not.
//   4. It ignored merged cells, so a merged header spanning three columns
//      produced one name and two blanks.
//
// Everything here reports what it did. `readWorkbook` returns a `report` per
// sheet naming the header row it chose, the headers it had to rename, the rows
// it dropped and why, and whether it truncated. The rule is that nothing is
// skipped invisibly.
import { logger } from "../util/log.mjs";

const log = logger("spreadsheet");

/** How far down to look for a header row before giving up and using row 0. */
const HEADER_SCAN_ROWS = 25;

/**
 * Turn one ExcelJS cell value into a JavaScript value, keeping its type.
 *
 * ExcelJS hands back six different shapes depending on what the cell holds, and
 * the old reader's `String(v)` flattened all of them. Dates in particular matter
 * here: Decisions compares dates constantly, and a date that arrives as a string
 * is a date that silently never matches.
 */
export function coerce(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v !== "object") return v; // number, string, boolean

  // A formula cell carries both the formula and its last computed result. The
  // result is the value; the formula is not data.
  if ("result" in v) return coerce(v.result);
  // An error cell (#DIV/0!) is not a value and must not become the string
  // "#DIV/0!" sitting in a numeric column.
  if ("error" in v) return null;
  // Rich text: concatenate the runs, discard the formatting.
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  // A hyperlink cell: the text is what was displayed, the target is metadata.
  if ("text" in v) return v.text;
  if ("hyperlink" in v) return v.hyperlink;
  return String(v);
}

/** Is this cell empty for the purposes of shape detection? */
const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

/**
 * Read a worksheet into a dense 2D array with merged cells filled in.
 *
 * ExcelJS gives a merged range's value ONLY on its master cell; every other cell
 * in the range reads as null. For a header merged across three columns that
 * produces one name and two blanks, and for a merged label down a column it
 * produces one row that looks populated and several that look empty. Filling the
 * range is what makes the grid match what a person sees on screen.
 */
export function gridOf(ws) {
  const rows = [];
  const height = ws.rowCount || 0;
  const width = ws.columnCount || 0;
  for (let r = 1; r <= height; r++) {
    const row = [];
    for (let c = 1; c <= width; c++) {
      const cell = ws.getCell(r, c);
      // `master` is the top-left cell of the merge; for an unmerged cell it is
      // the cell itself, so this is safe to call unconditionally.
      const source = cell.isMerged && cell.master ? cell.master : cell;
      row.push(coerce(source.value));
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Work out which row holds the column names.
 *
 * There is no marker in the file that says "these are the headers", so this
 * scores candidates. A header row is: fully or almost fully populated, made of
 * short text rather than numbers or dates, free of duplicates, and - the
 * strongest signal - followed by a row whose types DIFFER from it. A row of
 * text above a row of numbers is a header; a row of text above more text is
 * probably just data.
 *
 * ⚠️ It returns a CONFIDENCE alongside the index, and `readWorkbook` reports
 * both. A guess presented as a fact is how the old reader shifted every record
 * by one without telling anyone.
 */
export function detectHeaderRow(rows) {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  let best = { index: 0, score: -Infinity };

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    const filled = row.filter((c) => !blank(c));
    if (filled.length < 2) continue; // a single-cell row is a title, not headers

    let score = 0;
    // Densely populated.
    score += (filled.length / Math.max(row.length, 1)) * 40;
    // Made of text.
    const textish = filled.filter((c) => typeof c === "string" && c.trim().length <= 60);
    score += (textish.length / filled.length) * 30;
    // Numbers and dates in a candidate row argue against it being headers.
    const valueish = filled.filter((c) => typeof c === "number" || c instanceof Date);
    score -= (valueish.length / filled.length) * 40;
    // Distinct names.
    const names = filled.map((c) => String(c).trim().toLowerCase());
    score += (new Set(names).size / names.length) * 15;
    // The row below should look like data, not like more headers.
    const next = rows[i + 1];
    if (next) {
      const nextFilled = next.filter((c) => !blank(c));
      if (nextFilled.length) {
        const nextValueish = nextFilled.filter((c) => typeof c === "number" || c instanceof Date);
        score += (nextValueish.length / nextFilled.length) * 25;
      } else {
        score -= 20; // headers with nothing under them are not headers
      }
    }
    // Prefer the earliest good row; later rows need to be clearly better.
    score -= i * 1.5;

    if (score > best.score) best = { index: i, score };
  }

  if (best.score === -Infinity) return { index: 0, confidence: "none" };
  const confidence = best.score >= 70 ? "high" : best.score >= 45 ? "medium" : "low";
  return { index: best.index, confidence };
}

/**
 * Make a usable, unique key for every column, and say what was changed.
 *
 * Blank and duplicate headers both used to fail silently: a blank produced the
 * key "" and duplicates overwrote each other, so a sheet with two columns called
 * "Total" lost one of them entirely with no error.
 */
export function normaliseHeaders(raw) {
  const renamed = [];
  const seen = new Map();
  const headers = raw.map((h, i) => {
    let name = blank(h) ? "" : String(h).trim().replace(/\s+/g, " ");
    if (!name) {
      name = `column_${i + 1}`;
      renamed.push({ index: i, from: "(blank)", to: name, why: "the header cell was empty" });
    }
    const lower = name.toLowerCase();
    if (seen.has(lower)) {
      const n = seen.get(lower) + 1;
      seen.set(lower, n);
      const unique = `${name}_${n}`;
      renamed.push({ index: i, from: name, to: unique, why: "another column already had this name" });
      name = unique;
    } else {
      seen.set(lower, 1);
    }
    return name;
  });
  return { headers, renamed };
}

/**
 * Read every sheet of a workbook, with a report of what happened to each.
 *
 * @param {string} abs  absolute path to an .xlsx file
 * @param {{maxRows?: number, sheet?: string}} [opts]
 */
export async function readWorkbook(abs, { maxRows = 100000, sheet } = {}) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);

  const sheets = [];
  wb.eachSheet((ws) => {
    if (sheet && ws.name !== sheet) return;

    const grid = gridOf(ws);
    const report = {
      sheet: ws.name,
      headerRow: null,
      headerConfidence: "none",
      renamedHeaders: [],
      skippedRows: [],
      truncated: false,
      totalRows: grid.length,
      mergedRanges: (ws.model && ws.model.merges ? ws.model.merges.length : 0),
    };

    if (!grid.length) {
      sheets.push({ name: ws.name, rowCount: 0, headers: [], records: [], report });
      return;
    }

    const found = detectHeaderRow(grid);
    report.headerRow = found.index + 1; // 1-based, matching what Excel shows
    report.headerConfidence = found.confidence;

    const { headers, renamed } = normaliseHeaders(grid[found.index] ?? []);
    report.renamedHeaders = renamed;

    // Anything above the header row is a title, a logo caption or a note. It is
    // reported rather than dropped in silence, because a misdetected header row
    // shows up here as "12 rows skipped" and is immediately obvious.
    if (found.index > 0) {
      report.skippedRows.push({
        rows: `1-${found.index}`,
        count: found.index,
        why: "above the detected header row",
      });
    }

    const records = [];
    let blankRun = 0;
    let dropped = 0;
    for (let r = found.index + 1; r < grid.length; r++) {
      if (records.length >= maxRows) {
        report.truncated = true;
        report.skippedRows.push({
          rows: `${r + 1}-${grid.length}`,
          count: grid.length - r,
          why: `the row limit of ${maxRows} was reached`,
        });
        break;
      }
      const row = grid[r];
      if (row.every(blank)) {
        blankRun++;
        dropped++;
        continue;
      }
      blankRun = 0;
      const rec = {};
      headers.forEach((h, i) => {
        rec[h] = row[i] === undefined ? null : row[i];
      });
      records.push(rec);
    }
    if (dropped) {
      report.skippedRows.push({ rows: "scattered", count: dropped, why: "the row was entirely empty" });
    }

    sheets.push({ name: ws.name, rowCount: records.length, headers, records, report });
  });

  if (sheet && !sheets.length) throw new Error("sheet not found: " + sheet);
  log.info("workbook read", { file: abs, sheets: sheets.length });
  return { kind: "xlsx", sheetCount: sheets.length, sheets };
}
