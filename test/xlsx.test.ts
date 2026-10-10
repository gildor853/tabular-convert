import { describe, expect, it } from "vitest";
import { listSheets, readXlsx, type Table, writeXlsx } from "../src/index.js";
import { dateToSerial, isDateFormat, serialToDate } from "../src/xlsx/dates.js";
import { checkSheetName, columnName } from "../src/xlsx/write.js";
import { openZip, writeZip } from "../src/xlsx/zip.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { fixture, names, rejectsCode, table, throwsCode, utf8 } from "./helpers/index.js";

const D = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s));

describe("Excel date serials", () => {
  it("follows the 1900 system including the leap-year bug", () => {
    expect(serialToDate(1, false)).toEqual(D(1900, 1, 1));
    expect(serialToDate(59, false)).toEqual(D(1900, 2, 28));
    expect(serialToDate(60, false)).toBeUndefined(); // the phantom 1900-02-29
    expect(serialToDate(60.5, false)).toBeUndefined();
    expect(serialToDate(61, false)).toEqual(D(1900, 3, 1));
    expect(serialToDate(46304, false)).toEqual(D(2026, 10, 9));
    expect(serialToDate(46304.5213541667, false)).toEqual(D(2026, 10, 9, 12, 30, 45));
    expect(serialToDate(2958465, false)).toEqual(D(9999, 12, 31));
    expect(serialToDate(2958466, false)).toBeUndefined();
    expect(serialToDate(-1, false)).toBeUndefined();
    expect(serialToDate(Number.NaN, false)).toBeUndefined();
  });

  it("follows the 1904 system", () => {
    expect(serialToDate(0, true)).toEqual(D(1904, 1, 1));
    expect(serialToDate(44842, true)).toEqual(D(2026, 10, 9));
    expect(serialToDate(2957003, true)).toEqual(D(9999, 12, 31));
    expect(serialToDate(2957004, true)).toBeUndefined();
  });

  it("converts dates back to serials", () => {
    expect(dateToSerial(D(1900, 1, 1))).toBe(1);
    expect(dateToSerial(D(1900, 2, 28))).toBe(59);
    expect(dateToSerial(D(1900, 3, 1))).toBe(61);
    expect(dateToSerial(D(2026, 10, 9, 12))).toBe(46304.5);
    expect(dateToSerial(D(1899, 12, 31))).toBeUndefined();
    expect(dateToSerial(D(10000, 1, 1))).toBeUndefined();
    for (const s of [1, 59, 61, 1000.25, 46304.75]) expect(dateToSerial(serialToDate(s, false) as Date)).toBe(s);
  });

  it("recognises date number formats", () => {
    for (const id of [14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]) expect(isDateFormat(id, undefined)).toBe(true);
    for (const id of [0, 1, 2, 9, 10, 11, 49]) expect(isDateFormat(id, undefined)).toBe(false);
    expect(isDateFormat(164, "yyyy\\-mm\\-dd")).toBe(true);
    expect(isDateFormat(164, "[$-405]d\\.\\ mmmm\\ yyyy")).toBe(true);
    expect(isDateFormat(164, "hh:mm")).toBe(true);
    expect(isDateFormat(164, '#,##0.00\\ "Kč"')).toBe(false);
    expect(isDateFormat(164, '0.00 "days"')).toBe(false);
    expect(isDateFormat(164, "[Red]0.00")).toBe(false);
    expect(isDateFormat(164, "#,##0_);(#,##0)")).toBe(false);
    expect(isDateFormat(164, "General")).toBe(false);
    expect(isDateFormat(164, "0.00E+00")).toBe(false);
    expect(isDateFormat(164, "@")).toBe(false);
  });
});

describe("readXlsx: LibreOffice fixture", () => {
  it("reads typed cells, formulas' cached values and long shared strings", async () => {
    const t = await readXlsx(fixture("libreoffice.xlsx"));
    expect(names(t)).toEqual(["text", "integer", "decimal", "date", "datetime", "bool", "formula", "formula_text", "formula_bool"]);
    expect(t.rows.slice(0, 4)).toEqual([
      ["Ahoj", 1, 1.5, D(2026, 10, 9), D(2026, 10, 9, 12, 30, 45), true, 2, "Ahoj!", true],
      // LibreOffice writes dates before 1900-03-01 without Excel's leap-year bug, so Excel (and we) see them one day later
      ["Žluťoučký kůň", -42, 0.1, D(1900, 1, 2), D(1999, 12, 31, 23, 59, 59), false, -84, "Žluťoučký kůň!", false],
      ["日本語 😀", 123456789, -0.000123, 60, D(2000, 2, 29, 0, 0, 1), null, 246913578, "日本語 😀!", true],
      ["", 9007199254740991, 3.14159265358979, D(1900, 3, 1), D(2026, 1, 1), true, 0, "", false],
    ]);
    expect((t.rows[4]?.[0] as string).length).toBe(10800);
    expect((t.rows[5]?.[0] as string).startsWith("Příliš žluťoučký kůň")).toBe(true);
  });

  it("lists and selects sheets by name or index", async () => {
    const bytes = fixture("libreoffice.xlsx");
    expect(await listSheets(bytes)).toEqual(["Data", "Second sheet", "Offset"]);
    expect(await readXlsx(bytes, { sheet: "Second sheet" })).toEqual(table(["id", "label"], [[1, "one"], [2, "two"]]));
    expect(await readXlsx(bytes, { sheet: "second SHEET" })).toEqual(table(["id", "label"], [[1, "one"], [2, "two"]]));
    expect(names(await readXlsx(bytes, { sheet: 1 }))).toEqual(["id", "label"]);
    await rejectsCode(readXlsx(bytes, { sheet: 3 }), "InvalidOption", /out of range.*"Data", "Second sheet", "Offset"/);
    await rejectsCode(readXlsx(bytes, { sheet: "Nope" }), "InvalidOption", /No sheet named "Nope"/);
    await rejectsCode(readXlsx(bytes, { sheet: 1.5 }), "InvalidOption");
    await rejectsCode(readXlsx(bytes, { sheet: true as unknown as string }), "InvalidOption");
  });

  it("starts at the first used row and column, and handles empty rows", async () => {
    const bytes = fixture("libreoffice.xlsx");
    expect(await readXlsx(bytes, { sheet: "Offset" })).toEqual(table(["a", "b"], [[1, "x"], [3, "z"]]));
    expect((await readXlsx(bytes, { sheet: "Offset", skipEmptyRows: false })).rows).toEqual([[1, "x"], [null, null], [3, "z"]]);
    expect((await readXlsx(bytes, { sheet: "Offset", header: false })).rows[0]).toEqual(["a", "b"]);
  });
});

describe("readXlsx: openpyxl fixtures", () => {
  it("reads openpyxl output (merged cells ignored, _x escapes, special characters)", async () => {
    const t = await readXlsx(fixture("openpyxl.xlsx"));
    expect(names(t)).toEqual(["name", "age", "joined", "active", "score"]);
    expect(t.rows).toEqual([
      ["Alice", 30, D(2020, 5, 17, 8, 15), true, 9.5],
      ["Bob", null, D(1999, 12, 31), false, -1],
      ["Čeněk & <Co>", 41, D(1900, 1, 1), true, 1e-7],
      // openpyxl writes the literal text "_x0041_ literal" unescaped, which OOXML defines as an escape for "A"
      ["A literal", 0, null, null, 12345678901],
      ["merged", null, null, null, null],
    ]);
    expect(await listSheets(fixture("openpyxl.xlsx"))).toEqual(["People", "Other"]);
  });

  it("reads the 1904 date system", async () => {
    expect((await readXlsx(fixture("openpyxl-1904.xlsx"))).rows).toEqual([[D(2026, 10, 9, 6)], [D(1904, 1, 2)]]);
  });
});

/** Builds a minimal workbook by hand to exercise reader paths that LibreOffice/openpyxl do not produce. */
async function handmade(sheetXml: string, extra: { name: string; data: string }[] = [], workbookPr = ""): Promise<Uint8Array> {
  const files = [
    { name: "_rels/.rels", data: '<Relationships xmlns="r"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/xl/workbook.xml"/></Relationships>' },
    {
      name: "xl/workbook.xml",
      data: `<workbook xmlns:r="r">${workbookPr}<sheets><sheet name="S" sheetId="1" r:id="rId1"/><sheet name="Chart" sheetId="2" r:id="rId9"/></sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/../worksheets/./s1.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chartsheet" Target="c.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="ss.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="st.xml"/><Relationship Id="rId4" Type="x" Target="http://example.com" TargetMode="External"/></Relationships>',
    },
    { name: "xl/worksheets/s1.xml", data: sheetXml },
    ...extra,
  ];
  return writeZip(files.map((f) => ({ name: f.name, data: utf8(f.data) })));
}

describe("readXlsx: hand-made workbooks", () => {
  it("reads inline strings, str/e/d/b cells, rich text and phonetic runs", async () => {
    const ss = '<sst><si><r><t>Rich </t></r><r><rPr><b/></rPr><t xml:space="preserve">text</t></r><rPh><t>ignored</t></rPh></si><si><t>plain_x000D_</t></si></sst>';
    const st = '<styleSheet><numFmts><numFmt numFmtId="200" formatCode="d/m/yyyy"/></numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="200"/><xf numFmtId="14"/><xf numFmtId="2"/></cellXfs></styleSheet>';
    const sheet = `<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>h1</t></is></c><c t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c><c r="D1"><v>1</v></c></row>
<row r="2"><c r="A2" t="str"><f>A1</f><v>calc</v></c><c r="B2" t="e"><v>#DIV/0!</v></c><c r="C2" t="d"><v>2026-10-09T10:00:00Z</v></c><c r="D2" t="b"><v>1</v></c></row>
<row><c r="A3" s="1"><v>46304</v></c><c r="B3" s="2"><v>46304.25</v></c><c r="C3" s="3"><v>1.5</v></c><c r="D3" t="d"><v>not a date</v></c></row>
<row r="4"><c r="A4"><f>1+1</f></c><c r="AA4" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c></row>
</sheetData></worksheet>`;
    const bytes = await handmade(sheet, [
      { name: "xl/ss.xml", data: ss },
      { name: "xl/st.xml", data: st },
    ]);
    expect(await listSheets(bytes)).toEqual(["S"]);
    const t = await readXlsx(bytes, { header: false });
    expect(t.rows[0]).toEqual(["h1", "Rich text", "plain\r", 1, ...new Array(23).fill(null)]);
    expect(t.rows[1]?.slice(0, 4)).toEqual(["calc", "#DIV/0!", D(2026, 10, 9, 10), true]);
    expect(t.rows[2]?.slice(0, 4)).toEqual([D(2026, 10, 9), D(2026, 10, 9, 6), 1.5, "not a date"]);
    expect(t.rows[3]?.[0]).toBeNull();
    expect(t.rows[3]?.[26]).toBe("ab");
  });

  it("handles a 1904 workbook flag and a missing styles/shared strings part", async () => {
    const bytes = await handmade('<worksheet><sheetData><row><c><v>1</v></c></row></sheetData></worksheet>', [], '<workbookPr date1904="true"/>');
    expect((await readXlsx(bytes, { header: false })).rows).toEqual([[1]]);
  });

  it("rejects corrupt cells", async () => {
    await rejectsCode(readXlsx(await handmade('<worksheet><sheetData><row><c t="s"><v>7</v></c></row></sheetData></worksheet>')), "ParseError", /shared string index/);
    await rejectsCode(readXlsx(await handmade("<worksheet><sheetData><row><c><v>abc</v></c></row></sheetData></worksheet>")), "ParseError", /Invalid number/);
  });

  it("enforces limits on rows, columns and cell length", async () => {
    const sheet = '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>abcdef</t></is></c><c r="C1"><v>1</v></c></row><row r="5"><c><v>2</v></c></row></sheetData></worksheet>';
    const bytes = await handmade(sheet);
    await rejectsCode(readXlsx(bytes, { limits: { maxCellLength: 3 } }), "LimitExceeded", /Cell length/);
    await rejectsCode(readXlsx(bytes, { limits: { maxColumns: 2 } }), "LimitExceeded", /columns/);
    await rejectsCode(readXlsx(bytes, { limits: { maxRows: 3 } }), "LimitExceeded", /rows/);
    await rejectsCode(readXlsx(bytes, { limits: { maxDepth: 2 } }), "LimitExceeded", /nesting/);
    const ss = await handmade('<worksheet><sheetData><row><c t="s"><v>0</v></c></row></sheetData></worksheet>', [{ name: "xl/ss.xml", data: "<sst><si><t>abcdef</t></si></sst>" }]);
    await rejectsCode(readXlsx(ss, { limits: { maxCellLength: 3 } }), "LimitExceeded");
  });

  it("explains non-workbook ZIP files", async () => {
    const z = (name: string) => writeZip([{ name, data: utf8("<x/>") }]);
    await rejectsCode(readXlsx(await z("word/document.xml")), "UnsupportedFormat", /Word/);
    await rejectsCode(readXlsx(await z("content.xml")), "UnsupportedFormat", /OpenDocument/);
    await rejectsCode(readXlsx(await z("other.xml")), "ParseError", /Not an XLSX/);
    const noSheets = await writeZip([{ name: "xl/workbook.xml", data: utf8("<workbook><sheets/></workbook>") }]);
    await rejectsCode(readXlsx(noSheets), "ParseError", /no worksheets/);
    const missingPart = await writeZip([
      { name: "xl/workbook.xml", data: utf8('<workbook xmlns:r="r"><sheets><sheet name="A" r:id="rId1"/></sheets></workbook>') },
      { name: "xl/_rels/workbook.xml.rels", data: utf8('<Relationships><Relationship Id="rId1" Type="http://x/worksheet" Target="sheet1.xml"/></Relationships>') },
    ]);
    await rejectsCode(readXlsx(missingPart), "ParseError", /missing the part/);
    await rejectsCode(readXlsx("text" as unknown as Uint8Array), "InvalidInput", /binary input/);
  });
});

describe("writeXlsx", () => {
  const t: Table = table(["text", "int", "float", "bool", "date", "datetime", "big", "safeBig", "empty"], [
    ["Ahoj & <svět>", 1, 1.25, true, D(2026, 10, 9), D(2026, 10, 9, 12, 30), 2n ** 64n, 42n, null],
    ["  spaces  ", -0, 1e-10, false, D(1900, 1, 1), D(1899, 12, 31), -(2n ** 60n), -1n, null],
    ["ctrl\u0001\r\nline", 9007199254740991, -1e300, null, D(1900, 2, 28), D(9999, 12, 31, 23, 59, 59), 0n, 0n, null],
  ]);

  it("round-trips through the reader", async () => {
    const bytes = await writeXlsx(t);
    const back = await readXlsx(bytes);
    expect(names(back)).toEqual(names(t));
    expect(back.rows).toEqual([
      ["Ahoj & <svět>", 1, 1.25, true, D(2026, 10, 9), D(2026, 10, 9, 12, 30), "18446744073709551616", 42, null],
      ["  spaces  ", 0, 1e-10, false, D(1900, 1, 1), "1899-12-31", "-1152921504606846976", -1, null],
      ["ctrl\u0001\r\nline", 9007199254740991, -1e300, null, D(1900, 2, 28), D(9999, 12, 31, 23, 59, 59), 0, 0, null],
    ]);
  });

  it("writes bold headers, date styles, widths and a frozen header", async () => {
    const bytes = await writeXlsx(t, { columnWidths: "auto", freezeHeader: true, sheetName: "Data" });
    const z = openZip(bytes, DEFAULT_LIMITS);
    expect(z.names).toEqual(["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml", "xl/sharedStrings.xml"]);
    const sheet = await z.text("xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="A1" t="s" s="1"><v>0</v></c>');
    expect(sheet).toContain('<c r="E2" s="2"><v>46304</v></c>');
    expect(sheet).toContain('<c r="F2" s="3"><v>46304.520833333336</v></c>');
    expect(sheet).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(sheet).toContain('<col min="1" max="1" width="15" customWidth="1"/>');
    expect(sheet).toContain('<dimension ref="A1:I4"/>');
    expect(await z.text("xl/workbook.xml")).toContain('<sheet name="Data" sheetId="1" r:id="rId1"/>');
    const sst = await z.text("xl/sharedStrings.xml");
    expect(sst).toContain('<si><t xml:space="preserve">  spaces  </t></si>');
    expect(sst).toContain("<si><t>ctrl_x0001__x000D_\nline</t></si>");
    const fixed = openZip(await writeXlsx(table(["a", "b"], [[1, 2]]), { columnWidths: [10, 20.5], header: false }), DEFAULT_LIMITS);
    const fx = await fixed.text("xl/worksheets/sheet1.xml");
    expect(fx).toContain('<col min="2" max="2" width="20.5" customWidth="1"/>');
    expect(fx).toContain('<row r="1"><c r="A1"><v>1</v></c>');
  });

  it("writes several sheets", async () => {
    const bytes = await writeXlsx([
      { name: "One", table: table(["a"], [["x"]]) },
      { name: "Two & más", table: table(["b"], [["x"], ["y"]]) },
    ]);
    expect(await listSheets(bytes)).toEqual(["One", "Two & más"]);
    expect(await readXlsx(bytes, { sheet: "Two & más" })).toEqual(table(["b"], [["x"], ["y"]]));
  });

  it("writes an empty table and column letters correctly", async () => {
    expect(await readXlsx(await writeXlsx({ columns: [], rows: [] }))).toEqual({ columns: [], rows: [] });
    expect([0, 25, 26, 51, 52, 701, 702, 16383].map(columnName)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA", "XFD"]);
  });

  it("validates sheet names", () => {
    expect(checkSheetName("Data 2026")).toBe("Data 2026");
    for (const bad of ["", "x".repeat(32), "a/b", "a[1]", "a:b", "a*", "a?", "a\\b", "'quoted'", "History", "tab\there", 5]) throwsCode(() => checkSheetName(bad), "InvalidInput");
  });

  it("validates input", async () => {
    await rejectsCode(writeXlsx([]), "InvalidInput", /at least one sheet/);
    await rejectsCode(writeXlsx([{ name: "A", table: table(["a"], []) }, { name: "a", table: table(["a"], []) }]), "InvalidInput", /Duplicate/);
    await rejectsCode(writeXlsx([null as never]), "InvalidInput", /must be \{ name, table \}/);
    await rejectsCode(writeXlsx(table(["a"], [[Number.NaN]])), "InvalidInput", /non-finite/);
    await rejectsCode(writeXlsx(table(["a"], [["x".repeat(32_768)]])), "InvalidInput", /32767/);
    await rejectsCode(writeXlsx({ columns: Array.from({ length: 16_385 }, (_, i) => ({ name: `c${i}` })), rows: [] }), "InvalidInput", /16384 columns/);
    await rejectsCode(writeXlsx({ columns: [{ name: "a" }], rows: new Array(1_048_576).fill([1]) }), "InvalidInput", /1048576 rows/);
    await rejectsCode(writeXlsx(table(["a"], []), { columnWidths: [1, 2] }), "InvalidOption", /has 2 entries/);
    await rejectsCode(writeXlsx(table(["a"], []), { columnWidths: [0] }), "InvalidOption");
    await rejectsCode(writeXlsx(table(["a"], []), { columnWidths: "wide" as "auto" }), "InvalidOption");
    await rejectsCode(writeXlsx(table(["a"], []), { sheetName: "a/b" }), "InvalidInput");
  });
});
