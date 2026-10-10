import { describe, expect, it } from "vitest";
import { listSheets, readXls, readXlsx } from "../src/index.js";
import { cfbStream } from "../src/xlsx/xls.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import {
  BOF_GLOBALS,
  boolErr,
  bytes,
  cfb,
  chars,
  formulaNum,
  formulaSpecial,
  format,
  label,
  labelSst,
  number,
  rec,
  rkRec,
  type SheetSpec,
  u8,
  u16,
  u32,
  workbookStream,
  xf,
  xlString,
} from "./helpers/biff.js";
import { fixture, names, rejectsCode, table, throwsCode } from "./helpers/index.js";

const D = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s));

const sst = (strings: string[]) => rec(0x00fc, u32(strings.length), u32(strings.length), ...strings.map((s) => xlString(s)));
const xls = (globals: Uint8Array[], sheets: SheetSpec[], opts?: { bof?: Uint8Array; name?: string; loop?: boolean }) =>
  cfb(opts?.name ?? "Workbook", workbookStream(globals, sheets, opts?.bof), opts?.loop ? { loop: true } : {});

describe("readXls: LibreOffice fixture", () => {
  it("reads the same values as the XLSX export (verified against xlrd)", async () => {
    const bytes = fixture("libreoffice.xls");
    expect(await listSheets(bytes)).toEqual(["Data", "Second sheet", "Offset"]);
    const t = readXls(bytes);
    expect(names(t)).toEqual(["text", "integer", "decimal", "date", "datetime", "bool", "formula", "formula_text", "formula_bool"]);
    expect(t.rows.slice(0, 4)).toEqual([
      // LibreOffice's .xls export stores 0 as the cached result of text formulas (xlrd reads 0.0 too)
      ["Ahoj", 1, 1.5, D(2026, 10, 9), D(2026, 10, 9, 12, 30, 45), true, 2, 0, true],
      ["Žluťoučký kůň", -42, 0.1, D(1900, 1, 2), D(1999, 12, 31, 23, 59, 59), false, -84, 0, false],
      ["日本語 😀", 123456789, -0.000123, 60, D(2000, 2, 29, 0, 0, 1), null, 246913578, 0, true],
      ["", 9007199254740991, 3.14159265358979, D(1900, 3, 1), D(2026, 1, 1), true, 0, "", false],
    ]);
    // long strings span SST CONTINUE records (compressed and 16-bit)
    const x = await readXlsx(fixture("libreoffice.xlsx"));
    expect(t.rows[4]?.[0]).toBe(x.rows[4]?.[0]);
    expect(t.rows[5]?.[0]).toBe(x.rows[5]?.[0]);
    expect(readXls(bytes, { sheet: "Offset" })).toEqual(table(["a", "b"], [[1, "x"], [3, "z"]]));
    expect(readXls(bytes, { sheet: "offset", skipEmptyRows: false }).rows).toEqual([[1, "x"], [null, null], [3, "z"]]);
    expect(names(readXls(bytes, { sheet: 1 }))).toEqual(["id", "label"]);
  });
});

describe("readXls: synthetic BIFF8", () => {
  it("reads every supported cell record", () => {
    const globals = [
      rec(0x0022, u16(0)),
      format(164, "yyyy-mm-dd"),
      format(165, '"TRUE";"TRUE";"FALSE"'),
      xf(0),
      xf(164),
      xf(165),
      xf(14),
      sst(["shared", "žluť"]),
    ];
    const cells = [
      labelSst(0, 0, 0),
      labelSst(0, 1, 1),
      label(0, 2, "inline"),
      rec(0x00d6, u16(0), u16(3), u16(0), xlString("rich"), u16(1), u8(0, 0, 0, 0)),
      number(1, 0, 1.5),
      rkRec(1, 1, (123 << 2) | 2), // integer RK
      rkRec(1, 2, ((-7 << 2) | 3) >>> 0), // integer ×100 → -0.07
      rkRec(1, 3, 0x3ff00000), // float RK: 1.0
      rkRec(1, 4, 0x3ff00000 | 1), // float RK ×100: 0.01
      rec(0x00bd, u16(2), u16(0), u16(1), u32((46304 << 2) | 2), u16(3), u32((46305 << 2) | 2), u16(4)), // MULRK with date styles
      boolErr(3, 0, 1, false),
      boolErr(3, 1, 0x07, true),
      boolErr(3, 2, 0x99, true),
      number(3, 3, 1, 2), // number with a boolean format
      formulaNum(4, 0, 42),
      formulaSpecial(4, 1, 1, 1),
      formulaSpecial(4, 2, 2, 0x2a),
      formulaSpecial(4, 3, 3),
      formulaSpecial(4, 4, 0),
      rec(0x0207, xlString("formula text")),
      rec(0x0201, u16(5), u16(0), u16(0)), // BLANK: ignored
    ];
    const bytes = xls(globals, [{ name: "Cells", records: cells }, { name: "Chart", records: [], type: 2 }]);
    const t = readXls(bytes, { header: false });
    expect(t.rows).toEqual([
      ["shared", "žluť", "inline", "rich", null],
      [1.5, 123, -0.07, 1, 0.01],
      [D(2026, 10, 9), D(2026, 10, 10), null, null, null],
      [true, "#DIV/0!", "#ERROR", true, null],
      [42, true, "#N/A", "", "formula text"],
    ]);
    expect(readXls(bytes, { header: false, sheet: "cells" }).rows.length).toBe(5);
  });

  it("reads SST strings continued across CONTINUE records with a changing high-byte flag", () => {
    const head = xlString("ab").subarray(0, 3); // cch=2, compressed
    const first = rec(0x00fc, u32(2), u32(2), u16(5), u8(0), u8(0x61, 0x62)); // "ab" of 5 chars, continues
    const cont = rec(0x003c, u8(1), u8(0x0d, 0x01, 0x3e, 0x01, 0x61, 0x00), xlString("next")); // 16-bit "čľa", then a new string
    expect(head.length).toBe(3);
    const bytes = xls([first, cont], [{ name: "S", records: [labelSst(0, 0, 0), labelSst(0, 1, 1)] }]);
    expect(readXls(bytes, { header: false }).rows).toEqual([["abčľa", "next"]]);
  });

  it("reads rich/extended SST strings and STRING records with CONTINUE", () => {
    const rich = rec(0x00fc, u32(1), u32(1), u16(3), u8(0x0c), u16(1), u32(2), u8(0x61, 0x62, 0x63), u8(0, 0, 0, 0), u8(9, 9));
    const str = rec(0x0207, u16(4), u8(0), u8(0x77, 0x78));
    const strCont = rec(0x003c, u8(0), u8(0x79, 0x7a));
    const bytes = xls([rich], [{ name: "S", records: [labelSst(0, 0, 0), formulaSpecial(0, 1, 0), str, strCont] }]);
    expect(readXls(bytes, { header: false }).rows).toEqual([["abc", "wxyz"]]);
  });

  it("uses the 1904 date system when DATEMODE says so", () => {
    const bytes = xls([rec(0x0022, u16(1)), xf(0), xf(14)], [{ name: "S", records: [number(0, 0, 0, 1)] }]);
    expect(readXls(bytes, { header: false }).rows).toEqual([[D(1904, 1, 1)]]);
  });

  it("reads small workbooks stored in the mini stream", () => {
    const bytes = xls([], [{ name: "S", records: [label(0, 0, "mini")] }]);
    expect(bytes.length).toBeLessThan(4096);
    expect(readXls(bytes, { header: false }).rows).toEqual([["mini"]]);
  });

  it("reads large workbooks stored in regular sectors", () => {
    const rows = Array.from({ length: 400 }, (_, r) => number(r, 0, r));
    const bytes = xls([], [{ name: "S", records: rows }]);
    const t = readXls(bytes, { header: false });
    expect(t.rows.length).toBe(400);
    expect(t.rows[399]).toEqual([399]);
  });

  it("rejects unsupported and corrupt files", async () => {
    const cell = [{ name: "S", records: [label(0, 0, "x")] }];
    throwsCode(() => readXls(xls([rec(0x002f, u16(0))], cell)), "UnsupportedFormat", /Encrypted/);
    throwsCode(() => readXls(xls([], cell, { bof: rec(0x0809, u16(0x0500), u16(5)) })), "UnsupportedFormat", /BIFF8/);
    throwsCode(() => readXls(xls([], cell, { name: "Book" })), "UnsupportedFormat", /Excel 5\/95/);
    throwsCode(() => readXls(xls([], cell, { name: "WordDocument" })), "UnsupportedFormat", /no Excel workbook stream/);
    throwsCode(() => readXls(xls([], [])), "ParseError", /no worksheets/);
    throwsCode(() => readXls(xls([], [{ name: "S", records: [labelSst(0, 0, 5)] }])), "ParseError", /shared string 5/);
    throwsCode(() => readXls(xls([], [{ name: "S", records: [rec(0x0203, u16(0))] }])), "ParseError", /too short/);
    const big = Array.from({ length: 400 }, (_, r) => number(r, 0, r));
    throwsCode(() => readXls(xls([], [{ name: "S", records: big }], { loop: true })), "ParseError", /chain/);
    throwsCode(() => readXls(xls([], [{ name: "S", records: [label(0, 0, "x"), label(0, 1, "y")] }], { loop: true })), "ParseError");
    throwsCode(() => readXls(new Uint8Array(600)), "ParseError", /compound-file/);
    const truncated = xls([], cell).subarray(0, 520);
    throwsCode(() => readXls(truncated), "ParseError");
    throwsCode(() => readXls(xls([], cell), { sheet: 2 }), "InvalidOption", /out of range/);
    throwsCode(() => readXls(xls([], cell), { sheet: "Nope" }), "InvalidOption", /No sheet/);
    throwsCode(() => readXls(xls([], cell), { sheet: {} as string }), "InvalidOption");
    throwsCode(() => readXls(xls([], [{ name: "S", records: [label(0, 0, "toolong")] }]), { limits: { maxCellLength: 3 } }), "LimitExceeded");
    throwsCode(() => readXls(xls([], [{ name: "S", records: [number(5, 0, 1)] }]), { limits: { maxRows: 3 } }), "LimitExceeded");
    throwsCode(() => readXls(xls([], [{ name: "S", records: [number(0, 5, 1)] }]), { limits: { maxColumns: 3 } }), "LimitExceeded");
    // a broken record length
    const broken = xls([], [{ name: "S", records: [u8(0x03, 0x02, 0xff, 0x00)] }]);
    throwsCode(() => readXls(broken), "ParseError", /past the end/);
    // a sheet offset that points nowhere
    const badOffset = cfb("Workbook", bytes([BOF_GLOBALS, rec(0x0085, u32(99999), u8(0, 0, 1, 0), chars("S").data), rec(0x000a)]));
    throwsCode(() => readXls(badOffset), "ParseError", /offset/);
    await rejectsCode(listSheets(xls([rec(0x002f, u16(0))], cell)), "UnsupportedFormat");
  });

  it("extracts streams from a compound file", () => {
    const data = new Uint8Array(5000).map((_, i) => i & 0xff);
    const file = cfb("Workbook", data);
    expect(cfbStream(file, ["workbook"], DEFAULT_LIMITS)).toEqual(data);
    expect(cfbStream(file, ["Other"], DEFAULT_LIMITS)).toBeUndefined();
    throwsCode(() => cfbStream(file, ["Workbook"], { ...DEFAULT_LIMITS, maxInputBytes: 100 }), "LimitExceeded");
  });
});
