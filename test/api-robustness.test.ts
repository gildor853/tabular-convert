import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";

// The non-throwing API (`try*` returns a Result, `is*` returns a boolean) must
// not throw for any input, including wrongly typed values from plain
// JavaScript callers and `null` options.
const ODD: unknown[] = [
  undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, true, 10n, Symbol("x"),
  "", " ", "constructor", "__proto__", "toString", "\u212A", "x".repeat(10_000),
  {}, [], [null], Object.create(null), new Uint8Array(3), new Date(Number.NaN),
];
const SKIP = new Set<string>([]);
const TABLE = { columns: [{ name: "a" }], rows: [["x"]] };

const fns = Object.entries(api).filter(
  ([name, fn]) => /^(try|is)[A-Z]/.test(name) && typeof fn === "function" && !SKIP.has(name),
) as Array<[string, (...args: unknown[]) => unknown]>;

const show = (v: unknown): string => (typeof v === "string" ? JSON.stringify(v.slice(0, 20)) : typeof v === "symbol" ? "symbol" : Object.prototype.toString.call(v));

describe("non-throwing API", () => {
  it.each(fns)("%s never throws", async (name, fn) => {
    for (const a of ODD) {
      for (const b of [undefined, ...ODD]) {
        const r = await fn(a, b);
        if (name.startsWith("is")) expect(typeof r, `${name}(${show(a)}, ${show(b)})`).toBe("boolean");
        else expect(typeof (r as { ok: unknown }).ok, `${name}(${show(a)}, ${show(b)})`).toBe("boolean");
      }
    }
  });
});

// The throwing API must only ever throw TabularError (never a raw TypeError
// or RangeError) for wrongly typed input.
const SYNC = ["readCsv", "readTsv", "readJson", "readNdjson", "readSql", "readMarkdown", "readHtml", "readXls", "readSync", "convertSync", "detectFormat", "inferTypes", "columnTypes"] as const;
const WRITERS = ["writeCsv", "writeTsv", "writeJson", "writeNdjson", "writeSql", "writeMarkdown", "writeHtml", "writeSync"] as const;
const ASYNC = ["read", "readXlsx", "convert", "listSheets", "writeXlsx", "write"] as const;
const SOME: unknown[] = [...ODD, "a,b\n1,2", TABLE, { to: "csv" }, { to: "xlsx" }, { format: "json" }, { delimiter: "ab" }, { limits: { maxRows: -1 } }, { infer: 3 }, { sheet: {} }, "csv", "xlsx"];

const fn = (name: string) => (api as unknown as Record<string, (...args: unknown[]) => unknown>)[name] as (...args: unknown[]) => unknown;

describe("throwing API", () => {
  it.each([...SYNC, ...WRITERS])("%s throws only TabularError", (name) => {
    for (const a of SOME) {
      for (const b of SOME) {
        try {
          fn(name)(a, b, b);
        } catch (err) {
          expect(err, `${name}(${show(a)}, ${show(b)})`).toBeInstanceOf(api.TabularError);
        }
      }
    }
  });

  it.each(ASYNC)("%s rejects only with TabularError", async (name) => {
    for (const a of SOME) {
      for (const b of SOME) {
        try {
          await fn(name)(a, b, b);
        } catch (err) {
          expect(err, `${name}(${show(a)}, ${show(b)})`).toBeInstanceOf(api.TabularError);
        }
      }
    }
  });
});
