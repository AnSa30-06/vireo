// Reading spreadsheets people actually made.
//
// Every fixture below is a shape the PREVIOUS reader got wrong, silently. That
// is the point of the file: each test names a real defect rather than exercising
// a happy path that already worked.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readWorkbook, detectHeaderRow, normaliseHeaders, coerce } from "../../src/tools/spreadsheet.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vireo-xlsx-"));

/** Build a real .xlsx from a 2D array so the fixtures go through ExcelJS itself. */
async function makeSheet(name, rows, { merges = [] } = {}) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  rows.forEach((r) => ws.addRow(r));
  for (const m of merges) ws.mergeCells(m);
  const file = path.join(tmp, name);
  await wb.xlsx.writeFile(file);
  return file;
}

test("a title row above the headers does not shift every record", async () => {
  // 🔴 THE DEFECT THIS PINS. The old reader used row 0 as headers
  // unconditionally, so this sheet produced columns named "Q3 Customer Export"
  // and undefined, and every record was off by one row. It threw no error.
  const file = await makeSheet("title.xlsx", [
    ["Q3 Customer Export"],
    [],
    ["account", "arr", "renewed"],
    ["Acme", 50000, new Date(Date.UTC(2026, 0, 15))],
    ["Northwind", 12000, new Date(Date.UTC(2026, 1, 2))],
  ]);
  const { sheets } = await readWorkbook(file);
  const s = sheets[0];

  assert.deepEqual(s.headers, ["account", "arr", "renewed"]);
  assert.equal(s.records.length, 2);
  assert.equal(s.records[0].account, "Acme");
  assert.equal(s.report.headerRow, 3, "the header row must be reported as row 3, the way Excel numbers it");
  assert.ok(
    s.report.skippedRows.some((x) => x.why.includes("above the detected header row")),
    "the rows above the headers must be reported, not dropped in silence",
  );
});

test("types survive: a number stays a number and a date stays a Date", async () => {
  // The old reader called String() on every cell, so a date arrived as
  // "Thu Jan 15 2026 ..." and never compared equal to anything.
  const file = await makeSheet("types.xlsx", [
    ["account", "arr", "renewed", "active"],
    ["Acme", 50000, new Date(Date.UTC(2026, 0, 15)), true],
  ]);
  const { sheets } = await readWorkbook(file);
  const r = sheets[0].records[0];

  assert.equal(typeof r.arr, "number", "a currency column must stay numeric or it sorts as text");
  assert.ok(r.renewed instanceof Date, "a date must stay a Date - Decisions compares dates constantly");
  assert.equal(r.renewed.getUTCFullYear(), 2026);
  assert.equal(typeof r.account, "string");
});

test("a merged header spanning columns is filled, not left blank", async () => {
  // ExcelJS returns a merged range's value only on its master cell. The old
  // reader therefore saw one name and two nulls.
  const file = await makeSheet(
    "merged.xlsx",
    [
      ["region", "region", "arr"],
      ["EMEA", "EMEA", 100],
    ],
    { merges: ["A1:B1", "A2:B2"] },
  );
  const { sheets } = await readWorkbook(file);
  const s = sheets[0];

  // Both halves of the merge carry the value, so the second becomes region_2
  // rather than an unusable empty key.
  assert.ok(s.headers.includes("region"), "the merged header must be present");
  assert.ok(
    !s.headers.some((h) => h === ""),
    "a merged cell must never produce an empty column name",
  );
  assert.equal(s.report.mergedRanges, 2, "the number of merged ranges must be reported");
});

test("duplicate and blank headers are renamed, and the rename is reported", async () => {
  // Two columns called "Total" used to overwrite each other, losing one
  // entirely with no error at all.
  const file = await makeSheet("dupes.xlsx", [
    ["Total", "Total", null, "name"],
    [1, 2, 3, "Acme"],
  ]);
  const { sheets } = await readWorkbook(file);
  const s = sheets[0];

  assert.equal(new Set(s.headers).size, s.headers.length, "every column name must be unique");
  assert.equal(s.records[0].Total, 1);
  assert.equal(s.records[0].Total_2, 2, "the second Total must survive under its own name");
  assert.ok(s.headers.includes("column_3"), "a blank header must get a usable name");
  assert.equal(s.report.renamedHeaders.length, 2, "both renames must be reported");
});

test("truncation is reported, never silent", async () => {
  // 🔴 The old reader stopped at 5,000 rows and said nothing, so a partial
  // import was indistinguishable from a complete one.
  const rows = [["n"]];
  for (let i = 1; i <= 50; i++) rows.push([i]);
  const file = await makeSheet("big.xlsx", rows);

  const { sheets } = await readWorkbook(file, { maxRows: 10 });
  const s = sheets[0];

  assert.equal(s.records.length, 10);
  assert.equal(s.report.truncated, true, "truncation must be flagged");
  assert.ok(
    s.report.skippedRows.some((x) => x.why.includes("row limit")),
    "the report must say the limit was the reason and how many rows were left",
  );
});

test("entirely empty rows are skipped and counted", async () => {
  const file = await makeSheet("gaps.xlsx", [
    ["a", "b"],
    ["x", 1],
    [],
    [],
    ["y", 2],
  ]);
  const { sheets } = await readWorkbook(file);
  const s = sheets[0];
  assert.equal(s.records.length, 2, "blank rows must not become empty records");
  assert.ok(s.report.skippedRows.some((x) => x.why.includes("entirely empty")));
});

test("a formula cell yields its result, and an error cell yields null", () => {
  assert.equal(coerce({ formula: "SUM(A1:A2)", result: 42 }), 42);
  assert.equal(coerce({ error: "#DIV/0!" }), null, "#DIV/0! must not land in a numeric column as text");
  assert.equal(coerce({ richText: [{ text: "Ac" }, { text: "me" }] }), "Acme");
  assert.equal(coerce(null), null);
});

test("header detection reports low confidence rather than pretending", () => {
  // A sheet that is all numbers has no header row. Saying so is the point:
  // a guess presented as a fact is how records got shifted silently before.
  const rows = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  const found = detectHeaderRow(rows);
  assert.ok(["low", "none"].includes(found.confidence), `expected low/none confidence, got ${found.confidence}`);
});

test("normaliseHeaders is stable for already-clean headers", () => {
  const { headers, renamed } = normaliseHeaders(["account", "arr", "renewed"]);
  assert.deepEqual(headers, ["account", "arr", "renewed"]);
  assert.deepEqual(renamed, [], "a clean sheet must produce no rename noise");
});
