import { describe, expect, it } from "vitest";
import {
  columnTypes,
  convert,
  convertSync,
  detectFormat,
  FORMATS,
  formatFromFilename,
  inferTypes,
  isFormat,
  isTable,
  read,
  readSync,
  TabularError,
  tryConvert,
  tryConvertSync,
  tryRead,
  write,
  writeCsv,
  writeSync,
  writeXlsx,
} from "../src/index.js";
import { fixture, rejectsCode, table, text, throwsCode, utf8 } from "./helpers/index.js";

describe("format detection", () => {
  it("uses the file extension first", () => {
    expect(formatFromFilename("data.CSV")).toBe("csv");
    expect(formatFromFilename("/x/y.jsonl")).toBe("ndjson");
    expect(formatFromFilename("a.tab")).toBe("tsv");
    expect(formatFromFilename("a.htm")).toBe("html");
    expect(formatFromFilename("a.md")).toBe("markdown");
    expect(formatFromFilename("a.xlsm")).toBe("xlsx");
    expect(formatFromFilename("a.txt")).toBeUndefined();
    expect(formatFromFilename("noext")).toBeUndefined();
    expect(formatFromFilename(5)).toBeUndefined();
    expect(detectFormat("a,b", "x.json")).toBe("json");
  });

  it("falls back to the content", async () => {
    expect(detectFormat(await writeXlsx(table(["a"], [])))).toBe("xlsx");
    expect(detectFormat(fixture("libreoffice.xls"))).toBe("xls");
    expect(detectFormat(fixture("libreoffice.xls").buffer as ArrayBuffer)).toBe("xls");
    expect(detectFormat('  [{"a":1}]')).toBe("json");
    expect(detectFormat('{"columns":[],\n"rows":[]}')).toBe("json");
    expect(detectFormat('{"a":1}\n{"a":2}\n')).toBe("ndjson");
    expect(detectFormat('[1,\n2]')).toBe("json");
    expect(detectFormat("<html><body><table><tr><td>1</td></tr></table>")).toBe("html");
    expect(detectFormat("<html><body>no table</body></html>")).toBe("html");
    expect(detectFormat("-- dump\n\nINSERT INTO t VALUES (1);")).toBe("sql");
    expect(detectFormat("create table t (a int);")).toBe("sql");
    expect(detectFormat("Intro\n\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe("markdown");
    expect(detectFormat("a\tb\n1\t2")).toBe("tsv");
    expect(detectFormat("a;b\n1;2")).toBe("csv");
    expect(detectFormat(utf8("\ufeffa,b"))).toBe("csv");
    expect(detectFormat("")).toBe("csv");
    throwsCode(() => detectFormat(42), "InvalidInput");
  });

  it("isFormat never throws", () => {
    expect(FORMATS.every(isFormat)).toBe(true);
    for (const v of ["CSV", "xlsb", "", null, 1, {}]) expect(isFormat(v)).toBe(false);
  });
});

describe("read / write / convert", () => {
  const t = table(["a", "b"], [[1, "x"]]);

  it("reads and writes every format", async () => {
    for (const f of ["csv", "tsv", "json", "ndjson", "sql", "markdown", "html"] as const) {
      const out = await write(t, f);
      expect(typeof out).toBe("string");
      expect(await read(out, { format: f, infer: true })).toEqual({ columns: [{ name: "a", type: "number" }, { name: "b", type: "string" }], rows: [[1, "x"]] });
      expect(readSync(out, { format: f, infer: true }).rows).toEqual([[1, "x"]]);
      expect(writeSync(t, f)).toBe(out);
    }
    const x = await write(t, "xlsx");
    expect(x).toBeInstanceOf(Uint8Array);
    expect(await read(x)).toEqual(t);
    expect(readSync(fixture("libreoffice.xls"), { sheet: 1 }).rows[0]).toEqual([1, "one"]);
  });

  it("converts with options for both sides", async () => {
    const csv = "name;cena\nA;1,5\nB;2\n";
    expect(await convert(csv, { to: "json", read: { infer: true, decimalComma: true }, write: { indent: 0 } })).toBe('[{"name":"A","cena":1.5},{"name":"B","cena":2}]\n');
    expect(convertSync(csv, { from: "csv", to: "markdown", write: { pad: false } })).toBe("| name | cena |\n| --- | --- |\n| A | 1,5 |\n| B | 2 |\n");
    const xlsx = await convert(csv, { to: "xlsx", read: { infer: true, decimalComma: true } });
    expect(await convert(xlsx, { to: "csv", write: { lineEnding: "\n" } })).toBe("name,cena\nA,1.5\nB,2\n");
    expect(await convert(utf8("a\n1"), { to: "ndjson", filename: "in.csv" })).toBe('{"a":"1"}\n');
  });

  it("returns Results from try* functions", async () => {
    expect(await tryRead("a\n1")).toEqual({ ok: true, value: table(["a"], [["1"]]) });
    const bad = await tryRead("[1,", { format: "json" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toBeInstanceOf(TabularError);
      expect(bad.error.code).toBe("ParseError");
    }
    expect((await tryConvert("a\n1", { to: "html" })).ok).toBe(true);
    expect(tryConvertSync("a\n1", { to: "nope" as "csv" })).toMatchObject({ ok: false, error: { code: "UnsupportedFormat" } });
  });

  it("explains unsupported combinations", async () => {
    await rejectsCode(write(t, "xls" as "csv"), "UnsupportedFormat", /read-only/);
    await rejectsCode(convert("a", { to: "xls" as "csv" }), "UnsupportedFormat", /read-only/);
    await rejectsCode(write(t, "pdf" as "csv"), "UnsupportedFormat", /Unknown output format "pdf"/);
    await rejectsCode(read("a", { format: "pdf" as "csv" }), "UnsupportedFormat", /Unknown input format/);
    await rejectsCode(convert("a", {} as { to: "csv" }), "InvalidOption", /"to"/);
    await rejectsCode(convert("a", { to: "csv", filename: 1 as unknown as string }), "InvalidOption", /filename/);
    await rejectsCode(read("a", { filename: 1 as unknown as string }), "InvalidOption", /filename/);
    throwsCode(() => readSync(fixture("openpyxl.xlsx")), "UnsupportedFormat", /asynchronous/);
    throwsCode(() => writeSync(t, "xlsx" as "csv"), "UnsupportedFormat", /asynchronous/);
    throwsCode(() => writeSync(t, "xls" as "csv"), "UnsupportedFormat", /read-only/);
    await rejectsCode(read("a", "csv" as never), "InvalidOption");
  });
});

describe("tables", () => {
  it("validates tables with isTable (never throws)", () => {
    expect(isTable(table(["a"], [[1], ["x"], [true], [null], [1n], [new Date(0)]]))).toBe(true);
    expect(isTable({ columns: [{ name: "a" }], rows: [[]] })).toBe(true);
    for (const bad of [null, 1, {}, { columns: [], rows: {} }, { columns: [{}], rows: [] }, { columns: [], rows: [[1]] }, { columns: [{ name: "a" }], rows: [[{}]] }, { columns: [{ name: "a" }], rows: [[new Date(Number.NaN)]] }, { columns: [{ name: "a" }], rows: [1] }, { columns: [{ name: "a" }], rows: [[undefined]] }]) {
      expect(isTable(bad)).toBe(false);
    }
  });

  it("computes column types", () => {
    expect(columnTypes(table(["a", "b", "c", "d", "e", "f"], [[1, 1n, "x", true, null, new Date(0)], [2n, 2, 1, false, null, null]]))).toEqual(["number", "number", "mixed", "boolean", "empty", "date"]);
  });

  it("infers types column by column", () => {
    const t = inferTypes(table(["n", "mixed", "big", "neg0"], [["1", "1", "123456789012345678901", "-0"], ["2.5", "x", "-5", "0"]]));
    expect(t.rows).toEqual([[1, "1", 123456789012345678901n, -0], [2.5, "x", -5, 0]]);
    expect(t.columns.map((c) => c.type)).toEqual(["number", "string", "number", "number"]);
    expect(inferTypes(table(["d"], [["2026-02-30"]])).rows).toEqual([["2026-02-30"]]);
    expect(inferTypes(table(["d"], [["2026-10-09"]]), { dates: false }).rows).toEqual([["2026-10-09"]]);
    expect(inferTypes(table(["b"], [["true"]]), { booleans: false }).rows).toEqual([["true"]]);
    expect(inferTypes(table(["x"], [["1e999"]])).rows).toEqual([["1e999"]]);
    expect(writeCsv(inferTypes(table(["a"], [["1"]])))).toBe("a\r\n1\r\n");
  });
});

describe("misc", () => {
  it("decodes ArrayBuffer input", async () => {
    expect((await read(utf8("a\n1").buffer as ArrayBuffer, { format: "csv" })).rows).toEqual([["1"]]);
    expect(text(utf8("x"))).toBe("x");
  });
});
