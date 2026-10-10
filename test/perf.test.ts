import { describe, expect, it } from "vitest";
import { inferTypes, readCsv, readHtml, readJson, readMarkdown, readSql, readXlsx, type Table, writeCsv, writeJson, writeSql, writeXlsx } from "../src/index.js";
import { detectFormat } from "../src/detect.js";

const time = async (fn: () => unknown) => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

const N = 100_000;
const big: Table = {
  columns: ["id", "name", "price", "active", "day"].map((name) => ({ name })),
  rows: Array.from({ length: N }, (_, i) => [i, `name ${i}, "quoted"`, i / 7, i % 2 === 0, new Date(Date.UTC(2026, 0, 1 + (i % 365)))]),
};

// Generous bounds: they catch accidental O(n²) behaviour, not micro-regressions.
describe("performance on large-ish inputs", () => {
  it(`CSV: ${N} rows write + read + infer`, async () => {
    let csv = "";
    expect(await time(() => (csv = writeCsv(big)))).toBeLessThan(5000);
    let back: Table = { columns: [], rows: [] };
    expect(await time(() => (back = readCsv(csv, { infer: true })))).toBeLessThan(8000);
    expect(back.rows.length).toBe(N);
    expect(back.rows[N - 1]?.[1]).toBe(`name ${N - 1}, "quoted"`);
  });

  it(`JSON: ${N} rows write + read`, async () => {
    let json = "";
    expect(await time(() => (json = writeJson(big, { indent: 0 })))).toBeLessThan(5000);
    expect(await time(() => readJson(json))).toBeLessThan(5000);
  });

  it("XLSX: 50 000 rows write + read", async () => {
    const half = { columns: big.columns, rows: big.rows.slice(0, 50_000) };
    let bytes: Uint8Array = new Uint8Array();
    expect(await time(async () => (bytes = await writeXlsx(half)))).toBeLessThan(10_000);
    let back: Table = { columns: [], rows: [] };
    expect(await time(async () => (back = await readXlsx(bytes)))).toBeLessThan(10_000);
    expect(back.rows.length).toBe(50_000);
  });

  it("SQL: 50 000 rows write + read", async () => {
    const half = { columns: big.columns, rows: big.rows.slice(0, 50_000) };
    let sql = "";
    expect(await time(() => (sql = writeSql(half)))).toBeLessThan(5000);
    expect(await time(() => readSql(sql))).toBeLessThan(8000);
  });
});

describe("no quadratic blow-up on hostile inputs", () => {
  const M = 1 << 20;
  it.each([
    ["CSV: one huge quoted field full of escaped quotes", () => readCsv(`a\n"${'""'.repeat(M / 2)}"`)],
    ["CSV: many delimiters on one line", () => readCsv(",".repeat(M), { header: false, limits: { maxColumns: M + 1 } })],
    ["CSV: unclosed quote at the start", () => readCsv(`"${"x\n".repeat(M / 2)}`)],
    ["CSV: delimiter detection on a huge line", () => detectFormat("a;".repeat(M))],
    ["JSON: long string with many escapes", () => readJson(`["${"\\n".repeat(M / 2)}"]`)],
    ["JSON: many small values", () => readJson(`[${"[1],".repeat(M / 8)}[1]]`, { header: false })],
    ["Markdown: many pipes", () => readMarkdown(`|a|\n|-|\n${"|".repeat(M)}`)],
    ["HTML: many unmatched <", () => readHtml(`<table><tr><td>${"<".repeat(M)}`)],
    ["HTML: many unclosed quotes in tags", () => readHtml(`<table>${'<td x="'.repeat(M / 8)}`)],
    ["HTML: many raw-text tags", () => readHtml(`<table><tr><td>x${"<script></script>".repeat(M / 32)}`)],
    ["SQL: long string with many quotes", () => readSql(`INSERT INTO t VALUES ('${"''".repeat(M / 2)}')`)],
    ["SQL: many tokens", () => readSql(`INSERT INTO t VALUES ${"(1),".repeat(M / 8)}(1)`)],
    ["infer: long non-numeric strings", () => inferTypes({ columns: [{ name: "a" }], rows: Array.from({ length: 1000 }, () => [`${"1".repeat(1000)}x`]) })],
  ])("%s", async (_, fn) => {
    const ms = await time(() => {
      try {
        fn();
      } catch {
        // errors are fine here; only time matters
      }
    });
    expect(ms).toBeLessThan(4000);
  });
});
