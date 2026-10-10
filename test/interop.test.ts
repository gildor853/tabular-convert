// Validates XLSX output with independent implementations: LibreOffice
// (headless XLSX → CSV) and openpyxl. Skipped when they are not installed
// (e.g. in CI); run locally before releases.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCsv, type Table, writeXlsx } from "../src/index.js";

const has = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0;
};
const soffice = has("soffice", ["--version"]);
const openpyxl = has("python3", ["-c", "import openpyxl"]);

const D = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s));
const sample: Table = {
  columns: ["text", "int", "float", "bool", "date", "datetime", "big", "empty"].map((name) => ({ name })),
  rows: [
    ["Ahoj & <svět> \"q\"", 1, 1.25, true, D(2026, 10, 9), D(2026, 10, 9, 12, 30, 15), 2n ** 64n, null],
    ["Žluťoučký kůň 😀", -42, -0.001, false, D(1900, 3, 1), D(1999, 12, 31, 23, 59, 59), 7n, null],
    ["multi\nline", 9007199254740991, 1e21, null, D(2000, 2, 29), D(2000, 1, 1, 0, 0, 1), -1n, null],
  ],
};

describe.skipIf(!soffice)("interop: LibreOffice", () => {
  it("opens our XLSX and exports the same values", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-lo-"));
    writeFileSync(join(dir, "out.xlsx"), await writeXlsx([{ name: "Data", table: sample }, { name: "Second", table: { columns: [{ name: "x" }], rows: [[1]] } }]));
    const r = spawnSync("soffice", ["--headless", "--convert-to", "csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,false,false,false,-1", "--outdir", dir, join(dir, "out.xlsx")], { encoding: "utf8" });
    expect(r.status).toBe(0);
    // with sheet = -1 LibreOffice writes one CSV per sheet: out-Data.csv, out-Second.csv
    const data = readCsv(readFileSync(join(dir, "out-Data.csv")), { infer: true });
    expect(data.columns.map((c) => c.name)).toEqual(sample.columns.map((c) => c.name));
    expect(data.rows).toEqual([
      ["Ahoj & <svět> \"q\"", 1, 1.25, true, D(2026, 10, 9), D(2026, 10, 9, 12, 30, 15), 18446744073709551616n, null],
      ["Žluťoučký kůň 😀", -42, -0.001, false, D(1900, 3, 1), D(1999, 12, 31, 23, 59, 59), 7, null],
      ["multi\nline", 9007199254740991, 1e21, null, D(2000, 2, 29), D(2000, 1, 1, 0, 0, 1), -1, null],
    ]);
    expect(readCsv(readFileSync(join(dir, "out-Second.csv"))).rows).toEqual([["1"]]);
  }, 60_000);
});

describe.skipIf(!openpyxl)("interop: openpyxl", () => {
  it("loads our XLSX with the right types and styles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-py-"));
    const file = join(dir, "out.xlsx");
    writeFileSync(file, await writeXlsx(sample, { sheetName: "Data", columnWidths: "auto" }));
    const script = `
import json, sys, datetime, openpyxl
wb = openpyxl.load_workbook(sys.argv[1])
ws = wb["Data"]
def conv(v):
    if isinstance(v, datetime.datetime): return {"dt": v.isoformat()}
    return v
rows = [[conv(c.value) for c in r] for r in ws.iter_rows()]
print(json.dumps({"sheets": wb.sheetnames, "rows": rows, "bold": ws["A1"].font.b, "fmt": [ws["E2"].number_format, ws["F2"].number_format], "width": ws.column_dimensions["A"].width}))
`;
    const r = spawnSync("python3", ["-c", script, file], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    const out = JSON.parse(r.stdout);
    expect(out.sheets).toEqual(["Data"]);
    expect(out.bold).toBe(true);
    expect(out.fmt).toEqual(["yyyy\\-mm\\-dd", "yyyy\\-mm\\-dd\\ hh:mm:ss"]);
    expect(out.width).toBeGreaterThan(8);
    expect(out.rows[1]).toEqual(["Ahoj & <svět> \"q\"", 1, 1.25, true, { dt: "2026-10-09T00:00:00" }, { dt: "2026-10-09T12:30:15" }, "18446744073709551616", null]);
    expect(out.rows[3]).toEqual(["multi\nline", 9007199254740991, 1e21, null, { dt: "2000-02-29T00:00:00" }, { dt: "2000-01-01T00:00:01" }, -1, null]);
  }, 60_000);
});
