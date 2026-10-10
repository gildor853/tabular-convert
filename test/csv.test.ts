import { describe, expect, it } from "vitest";
import { detectDelimiter, readCsv, readTsv, writeCsv, writeTsv } from "../src/index.js";
import { names, table, throwsCode, utf8 } from "./helpers/index.js";

describe("readCsv: RFC 4180", () => {
  it("reads the RFC 4180 examples (section 2)", () => {
    // 2.1 / 2.2: CRLF-separated records, optional final line break
    expect(readCsv("aaa,bbb,ccc\r\nzzz,yyy,xxx\r\n", { header: false }).rows).toEqual([
      ["aaa", "bbb", "ccc"],
      ["zzz", "yyy", "xxx"],
    ]);
    expect(readCsv("aaa,bbb,ccc\r\nzzz,yyy,xxx", { header: false }).rows).toEqual([
      ["aaa", "bbb", "ccc"],
      ["zzz", "yyy", "xxx"],
    ]);
    // 2.3: header line
    const t = readCsv("field_name,field_name2,field_name3\r\naaa,bbb,ccc\r\n");
    expect(names(t)).toEqual(["field_name", "field_name2", "field_name3"]);
    // 2.5: quoted fields
    expect(readCsv('"aaa","bbb","ccc"\r\nzzz,yyy,xxx', { header: false }).rows[0]).toEqual(["aaa", "bbb", "ccc"]);
    // 2.6: line breaks, double quotes and commas inside quotes
    expect(readCsv('"aaa","b\r\nbb","ccc"\r\nzzz,yyy,xxx', { header: false }).rows[0]).toEqual(["aaa", "b\r\nbb", "ccc"]);
    // 2.7: escaped double quote
    expect(readCsv('"aaa","b""bb","ccc"', { header: false }).rows[0]).toEqual(["aaa", 'b"bb', "ccc"]);
  });

  it("accepts LF, CRLF and lone CR line endings", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      expect(readCsv(`a,b${eol}1,2${eol}3,4`).rows).toEqual([
        ["1", "2"],
        ["3", "4"],
      ]);
    }
  });

  it("keeps empty fields and trailing delimiters", () => {
    expect(readCsv("a,b,c\n,,\n1,,3\n").rows).toEqual([
      ["", "", ""],
      ["1", "", "3"],
    ]);
    expect(readCsv('a,b\n"",x').rows).toEqual([["", "x"]]);
  });

  it("skips empty lines by default and keeps them on request", () => {
    expect(readCsv("a\n\n1\n\n2\n").rows).toEqual([["1"], ["2"]]);
    expect(readCsv("a,b\n\n1,2", { skipEmptyLines: false }).rows).toEqual([
      ["", null],
      ["1", "2"],
    ]);
  });

  it("pads short rows with null and adds columns for long rows (strict mode rejects both)", () => {
    expect(readCsv("a,b,c\n1\n").rows).toEqual([["1", null, null]]);
    const wide = readCsv("a\n1,2");
    expect(names(wide)).toEqual(["a", "column_2"]);
    expect(wide.rows).toEqual([["1", "2"]]);
    throwsCode(() => readCsv("a\n1,2", { strict: true }), "ParseError", /Record 2 has 2 fields/);
    throwsCode(() => readCsv("a,b\n1", { strict: true }), "ParseError", /expected 2/);
  });

  it("names missing and duplicate header cells", () => {
    expect(names(readCsv(",a,a,\n1,2,3,4"))).toEqual(["column_1", "a", "a_2", "column_4"]);
  });

  it("reads multi-line quoted fields and reports the line of an unclosed quote", () => {
    expect(readCsv('id,text\n1,"line 1\nline 2\n""quoted"""\n2,x').rows).toEqual([
      ["1", 'line 1\nline 2\n"quoted"'],
      ["2", "x"],
    ]);
    throwsCode(() => readCsv('a\n1\n"open\n\n'), "ParseError", /line 3/);
  });

  it("is lenient with stray quotes by default and strict on request", () => {
    expect(readCsv('a,b\n"x"y,1\nab"c,2').rows).toEqual([
      ["xy", "1"],
      ['ab"c', "2"],
    ]);
    throwsCode(() => readCsv('a\n"x"y', { strict: true }), "ParseError", /after a closing quote/);
    throwsCode(() => readCsv('a\nab"c', { strict: true }), "ParseError", /inside an unquoted field/);
  });

  it("supports custom quote and escape characters", () => {
    expect(readCsv("a;b\n'x;y';'it''s'", { delimiter: ";", quote: "'" }).rows).toEqual([["x;y", "it's"]]);
    expect(readCsv('a,b\n"x\\"y","back\\\\slash"', { escape: "\\" }).rows).toEqual([['x"y', "back\\slash"]]);
    throwsCode(() => readCsv("a", { delimiter: '"' }), "InvalidOption", /must differ/);
    throwsCode(() => readCsv("a", { quote: "ab" }), "InvalidOption", /single character/);
    throwsCode(() => readCsv("a", { delimiter: "\n" }), "InvalidOption");
  });

  it("trims unquoted fields on request", () => {
    expect(readCsv("a , b\n 1 , \" 2 \"", { trim: true }).rows).toEqual([["1", " 2 "]]);
    expect(names(readCsv("a , b\n1,2", { trim: true }))).toEqual(["a", "b"]);
  });

  it("handles a UTF-8 BOM, UTF-16 BOMs and explicit encodings", () => {
    expect(names(readCsv("\ufeffa,b\n1,2"))).toEqual(["a", "b"]);
    expect(names(readCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8("é,b\n1,2")])))).toEqual(["é", "b"]);
    const le = new Uint8Array([0xff, 0xfe, ...[..."č,x\n1,2"].flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])]);
    expect(names(readCsv(le))).toEqual(["č", "x"]);
    const be = new Uint8Array([0xfe, 0xff, ...[..."č,x\n1,2"].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])]);
    expect(names(readCsv(be))).toEqual(["č", "x"]);
    // windows-1250: 0x9A = š, 0xE8 = č
    expect(names(readCsv(new Uint8Array([0x9a, 0x2c, 0xe8, 0x0a]), { encoding: "windows-1250" }))).toEqual(["š", "č"]);
    expect(names(readCsv(new Uint8Array([0x61, 0x0a]).buffer))).toEqual(["a"]);
    throwsCode(() => readCsv(new Uint8Array([0x61]), { encoding: "klingon" }), "InvalidOption", /encoding/);
    throwsCode(() => readCsv("a", { encoding: 5 as unknown as string }), "InvalidOption");
  });

  it("reads an empty input as an empty table", () => {
    expect(readCsv("")).toEqual({ columns: [], rows: [] });
    expect(readCsv("a,b")).toEqual({ columns: [{ name: "a" }, { name: "b" }], rows: [] });
    expect(readCsv("x", { header: false }).columns).toEqual([{ name: "column_1" }]);
  });
});

describe("delimiter detection", () => {
  it.each([
    [",", "a,b,c\n1,2,3\n4,5,6"],
    [";", "a;b;c\n1,5;2,5;3\n4;5;6"],
    ["\t", "a\tb\n1,000\t2"],
    ["|", "a|b|c\n1|2|3"],
    [",", 'name,note\n"x; y; z",1\n"p; q",2'],
    [",", "single"],
    [",", ""],
  ])("detects %j", (d, text) => {
    expect(detectDelimiter(text)).toBe(d);
  });

  it("ignores delimiters inside quoted fields and looks at consistency", () => {
    expect(detectDelimiter('"a;b;c;d";x\n"e;f";y\n"g";z')).toBe(";");
    expect(readCsv("a;b\n1;2").rows).toEqual([["1", "2"]]);
  });

  it("readTsv always uses a tab", () => {
    expect(readTsv("a,b\tc\n1,2\t3").rows).toEqual([["1,2", "3"]]);
  });
});

describe("type inference", () => {
  it("is off by default", () => {
    expect(readCsv("a\n1").rows).toEqual([["1"]]);
  });

  it("converts numbers, booleans, dates and empty cells", () => {
    const t = readCsv("n,b,d,s,e\n1,true,2026-10-09,007,\n-2.5e3,FALSE,2026-10-09T08:00:00+02:00,x,", { infer: true });
    expect(t.rows).toEqual([
      [1, true, new Date(Date.UTC(2026, 9, 9)), "007", null],
      [-2500, false, new Date(Date.UTC(2026, 9, 9, 6)), "x", null],
    ]);
    expect(t.columns.map((c) => c.type)).toEqual(["number", "boolean", "date", "string", "empty"]);
  });

  it("supports the Czech decimal comma", () => {
    const t = readCsv("cena;počet\n1,5;2\n-0,25;3", { infer: true, decimalComma: true });
    expect(t.rows).toEqual([
      [1.5, 2],
      [-0.25, 3],
    ]);
    expect(readCsv("a\n1.5", { infer: { decimalComma: true } }).rows).toEqual([["1.5"]]);
  });

  it("validates the infer option", () => {
    throwsCode(() => readCsv("a\n1", { infer: 1 as unknown as boolean }), "InvalidOption", /infer/);
  });
});

describe("writeCsv", () => {
  const t = table(["name", "note"], [
    ["Smith, J.", 'says "hi"'],
    ["multi\nline", null],
    [1.5, true],
  ]);

  it("quotes only when needed and uses CRLF", () => {
    expect(writeCsv(t)).toBe('name,note\r\n"Smith, J.","says ""hi"""\r\n"multi\nline",\r\n1.5,true\r\n');
  });

  it("supports quoting all, LF, no header, delimiters and a BOM", () => {
    expect(writeCsv(t, { quoting: "all", lineEnding: "\n", header: false })).toBe('"Smith, J.","says ""hi"""\n"multi\nline",""\n"1.5","true"\n');
    expect(writeTsv(table(["a", "b"], [["x\ty", 1]]))).toBe('a\tb\r\n"x\ty"\t1\r\n');
    expect(writeCsv(table(["a"], [["x"]]), { bom: true })).toBe("\ufeffa\r\nx\r\n");
    expect(writeCsv(table(["a", "b"], [["1,5", 2.5]]), { delimiter: ";", decimalComma: true })).toBe("a;b\r\n1,5;2,5\r\n");
  });

  it("supports a separate escape character", () => {
    const out = writeCsv(table(["a"], [['x"y\\z']]), { escape: "\\" });
    expect(out).toBe('a\r\n"x\\"y\\\\z"\r\n');
    expect(readCsv(out, { escape: "\\" }).rows).toEqual([['x"y\\z']]);
  });

  it("writes dates, bigints and -0", () => {
    expect(writeCsv(table(["d", "t", "b", "z"], [[new Date(Date.UTC(2026, 9, 9)), new Date(Date.UTC(2026, 9, 9, 1, 2, 3)), 2n ** 64n, -0]]))).toBe(
      "d,t,b,z\r\n2026-10-09,2026-10-09T01:02:03.000Z,18446744073709551616,0\r\n",
    );
  });

  it("rejects non-finite numbers and bad tables", () => {
    throwsCode(() => writeCsv(table(["a"], [[Number.NaN]])), "InvalidInput", /non-finite/);
    throwsCode(() => writeCsv({ columns: [], rows: [[1]] }), "InvalidInput");
    throwsCode(() => writeCsv(null as unknown as never), "InvalidInput");
    throwsCode(() => writeCsv(t, { quoting: "some" as "all" }), "InvalidOption");
  });

  it("neutralises formulas only when asked (OWASP CSV injection)", () => {
    const evil = table(["v"], [["=1+1"], ["+cmd"], ["-2"], ["@SUM(A1)"], ["\tx"], ["\rx"], ["ok"], [-5]]);
    expect(writeCsv(evil, { lineEnding: "\n" })).toBe('v\n=1+1\n+cmd\n-2\n@SUM(A1)\n\tx\n"\rx"\nok\n-5\n');
    expect(writeCsv(evil, { escapeFormulas: true, lineEnding: "\n" })).toBe("v\n\"'=1+1\"\n\"'+cmd\"\n\"'-2\"\n\"'@SUM(A1)\"\n\"'\tx\"\n\"'\rx\"\nok\n-5\n");
  });

  it("writes an empty table as an empty string", () => {
    expect(writeCsv({ columns: [], rows: [] }, { header: false })).toBe("");
  });

  it("round-trips awkward values", () => {
    const weird = table(["a,b", 'q"', "nl\r\n"], [
      ["", " lead", "trail "],
      ["\r", "\n", '"'],
      ["žluťoučký 😀", ",", ";"],
    ]);
    for (const delimiter of [",", ";", "\t", "|"]) {
      const back = readCsv(writeCsv(weird, { delimiter }), { delimiter, skipEmptyLines: false });
      expect(back).toEqual(weird);
    }
  });
});
