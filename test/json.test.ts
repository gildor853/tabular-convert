import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, readJson, readNdjson, writeJson, writeNdjson } from "../src/index.js";
import { parseJson, stringifyJson } from "../src/formats/json-text.js";
import { names, table, throwsCode } from "./helpers/index.js";

describe("JSON parser", () => {
  it("parses standard JSON like JSON.parse", () => {
    const docs = ['{"a":[1,2.5,-3e2,true,false,null,"x\\u00e9\\n\\"\\\\\\/"]}', "[]", "{}", ' \n[ "a" , { } ] ', '"\\ud83d\\ude00"', "0", "-0.5"];
    for (const d of docs) {
      const ours = parseJson(d, DEFAULT_LIMITS);
      const toPlain = (v: unknown): unknown => (v instanceof Map ? Object.fromEntries([...v].map(([k, x]) => [k, toPlain(x)])) : Array.isArray(v) ? v.map(toPlain) : v);
      expect(toPlain(ours)).toEqual(JSON.parse(d));
    }
  });

  it("keeps big integers exact and key order as written", () => {
    expect(parseJson("12345678901234567890", DEFAULT_LIMITS)).toBe(12345678901234567890n);
    expect(parseJson("-9007199254740993", DEFAULT_LIMITS)).toBe(-9007199254740993n);
  });

  it.each(["", "[", "[1,]", "{a:1}", '{"a" 1}', "01", "1.", "-", "tru", "[1] x", '"\\x"', '"a\nb"', '"\\u12"', '{"a":1,}', "NaN"])("rejects %j", (bad) => {
    throwsCode(() => parseJson(bad, DEFAULT_LIMITS), "ParseError", /Invalid JSON/);
  });

  it("rejects numbers out of range and deep nesting", () => {
    throwsCode(() => parseJson("1e400", DEFAULT_LIMITS), "ParseError", /out of range/);
    throwsCode(() => parseJson("[".repeat(300) + "]".repeat(300), DEFAULT_LIMITS), "LimitExceeded", /nesting/);
    throwsCode(() => parseJson('"' + "x".repeat(20) + '"', { ...DEFAULT_LIMITS, maxCellLength: 10 }), "LimitExceeded");
  });

  it("reports line and column", () => {
    throwsCode(() => parseJson('[\n  1,\n  x]', DEFAULT_LIMITS), "ParseError", /line 3, column 3/);
  });

  it("serializes like JSON.stringify", () => {
    const v = new Map<string, never>([["a", [1, "x", null, true] as never], ["b", new Map() as never], ["c", [] as never]]);
    expect(stringifyJson(v, 2)).toBe(JSON.stringify({ a: [1, "x", null, true], b: {}, c: [] }, null, 2));
    expect(stringifyJson(v, 0)).toBe(JSON.stringify({ a: [1, "x", null, true], b: {}, c: [] }));
    expect(stringifyJson(2n ** 70n, 0)).toBe("1180591620717411303424");
  });
});

describe("readJson", () => {
  it("reads an array of objects (union of keys, first-seen order)", () => {
    const t = readJson('[{"a":1,"b":"x"},{"b":"y","c":true},{}]');
    expect(names(t)).toEqual(["a", "b", "c"]);
    expect(t.rows).toEqual([
      [1, "x", null],
      [null, "y", true],
      [null, null, null],
    ]);
  });

  it("flattens nested objects to dot paths and keeps arrays as JSON text", () => {
    const t = readJson('[{"id":1,"user":{"name":"A","address":{"city":"Praha"}},"tags":["x","y"],"empty":{}}]');
    expect(names(t)).toEqual(["id", "user.name", "user.address.city", "tags", "empty"]);
    expect(t.rows[0]).toEqual([1, "A", "Praha", '["x","y"]', "{}"]);
    const flat = readJson('[{"user":{"name":"A"}}]', { flatten: false });
    expect(flat.rows[0]).toEqual(['{"name":"A"}']);
  });

  it("reads an array of arrays with or without a header", () => {
    expect(readJson('[["a","b"],[1,2],[3]]')).toEqual(table(["a", "b"], [[1, 2], [3, null]]));
    expect(readJson("[[1,2]]", { header: false })).toEqual(table(["column_1", "column_2"], [[1, 2]]));
    expect(names(readJson("[[null, 5]]"))).toEqual(["column_1", "5"]);
  });

  it("reads {columns, rows} and arrays of plain values", () => {
    expect(readJson('{"columns":["a",{"name":"b","type":"number"}],"rows":[[1,2]]}')).toEqual(table(["a", "b"], [[1, 2]]));
    expect(readJson("[1,\"x\",null]")).toEqual(table(["value"], [[1], ["x"], [null]]));
    expect(readJson("[]")).toEqual({ columns: [], rows: [] });
    throwsCode(() => readJson('{"columns":[1],"rows":[]}'), "ParseError", /Invalid column/);
    throwsCode(() => readJson('{"columns":["a"],"rows":[1]}'), "ParseError", /not an array/);
    throwsCode(() => readJson('{"a":1}'), "ParseError", /Expected a JSON array/);
    throwsCode(() => readJson('[1,{"a":1}]'), "ParseError", /mixes/);
  });

  it("is safe with __proto__ and other special keys", () => {
    const t = readJson('[{"__proto__":{"polluted":1},"constructor":2,"toString":3}]');
    expect(names(t)).toEqual(["__proto__.polluted", "constructor", "toString"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const out = writeJson(t, { unflatten: true, indent: 0 });
    expect(out).toBe('[{"__proto__":{"polluted":1},"constructor":2,"toString":3}]\n');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(JSON.parse(out)[0].constructor).toBe(2);
  });

  it("applies inference to string cells on request", () => {
    expect(readJson('[{"a":"1","b":"2026-10-09","c":5}]', { infer: true }).rows[0]).toEqual([1, new Date(Date.UTC(2026, 9, 9)), 5]);
  });

  it("keeps unsafe integers as bigint", () => {
    expect(readJson('[{"id":9007199254740993}]').rows[0]).toEqual([9007199254740993n]);
  });

  it("enforces row and column limits", () => {
    throwsCode(() => readJson("[[1],[2],[3]]", { limits: { maxRows: 1 } }), "LimitExceeded", /rows/);
    throwsCode(() => readJson('[{"a":1,"b":2}]', { limits: { maxColumns: 1 } }), "LimitExceeded", /columns/);
    throwsCode(() => readJson("[[1,2]]", { limits: { maxColumns: 1 } }), "LimitExceeded");
    throwsCode(() => readJson('{"columns":["a"],"rows":[[1],[2]]}', { limits: { maxRows: 1 } }), "LimitExceeded");
    throwsCode(() => readJson('{"columns":["a","b"],"rows":[]}', { limits: { maxColumns: 1 } }), "LimitExceeded");
    throwsCode(() => readJson("[]", { limits: { maxRows: 0 } }), "InvalidOption");
    throwsCode(() => readJson("[1]", { limits: { maxInputBytes: 2 } }), "LimitExceeded", /Input size/);
  });
});

describe("writeJson", () => {
  const t = table(["id", "user.name", "user.city", "when", "big"], [[1, "A", "Praha", new Date(Date.UTC(2026, 9, 9)), 2n ** 64n]]);

  it("writes objects, arrays and columns shapes", () => {
    expect(writeJson(t, { indent: 0 })).toBe('[{"id":1,"user.name":"A","user.city":"Praha","when":"2026-10-09","big":18446744073709551616}]\n');
    expect(writeJson(t, { shape: "arrays", indent: 0 })).toBe('[["id","user.name","user.city","when","big"],[1,"A","Praha","2026-10-09",18446744073709551616]]\n');
    expect(writeJson(t, { shape: "columns", indent: 0 })).toBe(
      '{"columns":["id","user.name","user.city","when","big"],"rows":[[1,"A","Praha","2026-10-09",18446744073709551616]]}\n',
    );
    expect(writeJson(table(["a"], [[1]]))).toBe('[\n  {\n    "a": 1\n  }\n]\n');
  });

  it("unflattens dot paths and rejects conflicts", () => {
    expect(writeJson(t, { unflatten: true, indent: 0 })).toBe('[{"id":1,"user":{"name":"A","city":"Praha"},"when":"2026-10-09","big":18446744073709551616}]\n');
    throwsCode(() => writeJson(table(["a", "a.b"], [[1, 2]]), { unflatten: true }), "InvalidInput", /plain value/);
    throwsCode(() => writeJson(table(["a.b", "a"], [[1, 2]]), { unflatten: true }), "InvalidInput", /conflicts/);
  });

  it("makes duplicate names unique for objects", () => {
    expect(writeJson({ columns: [{ name: "a" }, { name: "a" }], rows: [[1, 2]] }, { indent: 0 })).toBe('[{"a":1,"a_2":2}]\n');
  });

  it("validates options and values", () => {
    throwsCode(() => writeJson(t, { indent: 11 }), "InvalidOption");
    throwsCode(() => writeJson(t, { shape: "rows" as "arrays" }), "InvalidOption");
    throwsCode(() => writeJson(table(["a"], [[Number.POSITIVE_INFINITY]])), "InvalidInput", /non-finite/);
  });
});

describe("NDJSON", () => {
  it("reads one object per line, skipping blank lines and CRLF", () => {
    const t = readNdjson('{"a":1}\r\n\n{"a":2,"b":{"c":3}}\n');
    expect(names(t)).toEqual(["a", "b.c"]);
    expect(t.rows).toEqual([
      [1, null],
      [2, 3],
    ]);
    expect(readNdjson('["a","b"]\n[1,2]').rows).toEqual([[1, 2]]);
    expect(readNdjson("")).toEqual({ columns: [], rows: [] });
  });

  it("reports the failing line", () => {
    throwsCode(() => readNdjson('{"a":1}\n{"a":}\n'), "ParseError", /on line 2/);
    throwsCode(() => readNdjson('{"a":1}\n{"a":2}\n{"a":3}', { limits: { maxRows: 1 } }), "LimitExceeded");
  });

  it("writes compact lines", () => {
    const t = table(["a", "b.c"], [[1, "x"], [null, true]]);
    expect(writeNdjson(t)).toBe('{"a":1,"b.c":"x"}\n{"a":null,"b.c":true}\n');
    expect(writeNdjson(t, { unflatten: true })).toBe('{"a":1,"b":{"c":"x"}}\n{"a":null,"b":{"c":true}}\n');
    expect(writeNdjson(t, { shape: "arrays" })).toBe('["a","b.c"]\n[1,"x"]\n[null,true]\n');
    throwsCode(() => writeNdjson(t, { shape: "columns" as "arrays" }), "InvalidOption");
  });
});
