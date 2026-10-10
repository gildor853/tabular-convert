// Regression tests for issues found in the pre-release self-audit.
import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli-main.js";
import { detectFormat, inferTypes, readCsv, readJson, readSql, readXls, readXlsx, writeCsv, writeJson, writeXlsx } from "../src/index.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { openZip } from "../src/xlsx/zip.js";
import { BOF_SHEET, cfb, EOF, label, number, rec, u32, workbookStream, xlString } from "./helpers/biff.js";
import { table, text, throwsCode } from "./helpers/index.js";

describe("self-audit regressions", () => {
  it("CSV: a single-column record with an empty field is not dropped as a blank line", () => {
    const t = table(["note"], [["a"], [null], [""], ["b"]]);
    const csv = writeCsv(t);
    expect(csv).toBe('note\r\na\r\n""\r\n""\r\nb\r\n');
    expect(readCsv(csv).rows).toEqual([["a"], [""], [""], ["b"]]);
    expect(readCsv(csv, { infer: true }).rows).toEqual([["a"], [null], [null], ["b"]]);
    // multi-column rows of empty fields were already fine
    expect(writeCsv(table(["a", "b"], [[null, null]]))).toBe("a,b\r\n,\r\n");
  });

  it("CSV: a table without columns writes nothing", () => {
    expect(writeCsv({ columns: [], rows: [[], []] })).toBe("");
  });

  it("dates outside years 0–9999 keep the full ISO form instead of a truncated one", () => {
    const far = new Date(Date.UTC(10000, 0, 1));
    expect(writeCsv(table(["d"], [[far]]))).toBe("d\r\n+010000-01-01T00:00:00.000Z\r\n");
    expect(writeJson(table(["d"], [[new Date(Date.UTC(-1, 0, 1))]]))).toContain('"-000001-01-01T00:00:00.000Z"');
  });

  it("inference keeps years 0–99 instead of mapping them to the 1900s", () => {
    const t = inferTypes(table(["d"], [["0050-03-01"], ["0001-01-01T12:00:00Z"]]));
    expect((t.rows[0]?.[0] as Date).toISOString()).toBe("0050-03-01T00:00:00.000Z");
    expect((t.rows[1]?.[0] as Date).toISOString()).toBe("0001-01-01T12:00:00.000Z");
  });

  it("JSON: a flattened key colliding with a literal dotted key is an error, not silent data loss", () => {
    throwsCode(() => readJson('[{"a.b": 1, "a": {"b": 2}}]'), "ParseError", /"a\.b" appears twice/);
    expect(readJson('[{"a.b": 1, "a": {"b": 2}}]', { flatten: false }).columns.map((c) => c.name)).toEqual(["a.b", "a"]);
  });

  it("detects a single-line JSON object as NDJSON (one record)", () => {
    expect(detectFormat('{"a": 1}\n')).toBe("ndjson");
    expect(detectFormat('{"columns": ["a"], "rows": [[1]]}')).toBe("json");
    expect(detectFormat("[1, 2]")).toBe("json");
  });

  it("CLI: delimiter names cannot resolve to Object.prototype members", () => {
    expect(() => parseArgs(["in.csv", "--delimiter", "constructor"])).toThrow(/Invalid delimiter/);
    expect(() => parseArgs(["in.csv", "--delimiter", "toString"])).toThrow(/Invalid delimiter/);
    expect(parseArgs(["in.csv", "--delimiter", "Tab"]).read.delimiter).toBe("\t");
  });

  it("XLSX: numbers use Excel's upper-case exponent", async () => {
    const zip = openZip(await writeXlsx(table(["n"], [[1e-7], [1e21], [1.5]])), DEFAULT_LIMITS);
    const xml = text(await zip.read("xl/worksheets/sheet1.xml"));
    expect(xml).toContain("<v>1E-7</v>");
    expect(xml).toContain("<v>1E+21</v>");
    expect((await readXlsx(await writeXlsx(table(["n"], [[1e-7], [1e21]])))).rows).toEqual([[1e-7], [1e21]]);
  });

  it("SQL: MySQL character set introducers are accepted", () => {
    const t = readSql("INSERT INTO t (a, b) VALUES (_utf8mb4'caf\\u00e9', _binary 'x');".replace("\\u00e9", "\u00e9"));
    expect(t.rows).toEqual([["caf\u00e9", "x"]]);
    throwsCode(() => readSql("INSERT INTO t VALUES (_utf8mb4);"), "UnsupportedFormat");
  });

  it("XLS: records inside an embedded chart substream are skipped", async () => {
    const chart = [BOF_SHEET, number(0, 0, 999), EOF];
    const stream = workbookStream([rec(0x00fc, u32(1), u32(1), xlString("x"))], [{ name: "S", records: [label(0, 0, "h"), number(1, 0, 1), ...chart, number(2, 0, 2)] }]);
    const t = await readXls(cfb("Workbook", stream));
    expect(t.rows).toEqual([[1], [2]]);
  });
});
