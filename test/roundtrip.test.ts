import { describe, expect, it } from "vitest";
import { convert, type Format, read, type Table, WRITABLE_FORMATS, write } from "../src/index.js";
import { fixture, table } from "./helpers/index.js";

const D = (y: number, m: number, d: number, h = 0, mi = 0, s = 0) => new Date(Date.UTC(y, m - 1, d, h, mi, s));

// Values every format can carry losslessly once types are inferred again on read.
const base: Table = table(["id", "name", "price", "active", "day", "at", "note"], [
  [1, "Žluťoučký kůň", 1.5, true, D(2026, 10, 9), D(2026, 10, 9, 12, 30), "a, b; c | d"],
  [2, "O'Brien \"Q\"", -0.25, false, D(1999, 12, 31), D(2000, 2, 29, 23, 59, 59), "<b>&amp;</b>"],
  [3, "日本語 😀", 1e21, null, null, null, null],
  [9007199254740993n, "big id", 0, true, D(1900, 3, 1), D(2026, 1, 1, 0, 0, 1), "multi\nline"],
]);

const expected = (to: Format): Table["rows"] =>
  base.rows.map((r) =>
    r.map((c, k) => {
      // XLSX stores unsafe integers as text (a spreadsheet number would lose digits)
      if (to === "xlsx" && typeof c === "bigint" && k === 0) return "9007199254740993";
      return c;
    }),
  );

describe("round trips between every pair of writable formats", () => {
  for (const from of WRITABLE_FORMATS) {
    for (const to of WRITABLE_FORMATS) {
      it(`${from} → ${to}`, async () => {
        const source = await write(base, from);
        const converted = await convert(source, { from, to, read: { infer: true } });
        // XLSX cells are typed already; text formats need inference to get types back
        const back = await read(converted, { format: to, infer: to !== "xlsx" });
        expect(back.columns.map((c) => c.name)).toEqual(base.columns.map((c) => c.name));
        // the unsafe integer becomes text in XLSX; text formats infer it back to a bigint
        expect(back.rows).toEqual(to === "xlsx" ? expected("xlsx") : expected(to));
      });
    }
  }
});

describe("XLS and XLSX fixtures convert to every format", () => {
  for (const name of ["libreoffice.xls", "libreoffice.xlsx", "openpyxl.xlsx"]) {
    for (const to of WRITABLE_FORMATS) {
      it(`${name} → ${to}`, async () => {
        const original = await read(fixture(name), { filename: name });
        const out = await convert(fixture(name), { to, filename: name });
        const back = await read(out, { format: to, infer: to !== "xlsx" });
        expect(back.columns.map((c) => c.name)).toEqual(original.columns.map((c) => c.name));
        expect(back.rows.length).toBe(original.rows.length);
        if (to === "xlsx") expect(back.rows).toEqual(original.rows);
      });
    }
  }
});
