import { describe, expectTypeOf, it } from "vitest";
import {
  type Cell,
  convert,
  convertSync,
  type Format,
  read,
  readCsv,
  readXls,
  readXlsx,
  type Result,
  type Table,
  tryConvert,
  write,
  writeCsv,
  writeXlsx,
} from "../src/index.js";

// Compile-time checks only: the bodies are type-checked by `npm run typecheck` but never executed.
const typecheckOnly = (_fn: () => void) => undefined;

describe("types", () => {
  it("cells and tables", () => {
    typecheckOnly(() => {
    expectTypeOf<Cell>().toEqualTypeOf<string | number | boolean | bigint | Date | null>();
    expectTypeOf(readCsv("a")).toEqualTypeOf<Table>();
    expectTypeOf(readXls(new Uint8Array())).toEqualTypeOf<Table>();
    expectTypeOf(readXlsx(new Uint8Array())).toEqualTypeOf<Promise<Table>>();
    });
  });

  it("output type follows the target format", () => {
    typecheckOnly(() => {
    expectTypeOf(convert("a", { to: "xlsx" })).toEqualTypeOf<Promise<Uint8Array>>();
    expectTypeOf(convert("a", { to: "csv" })).toEqualTypeOf<Promise<string>>();
    expectTypeOf(convert("a", { to: "json" as Format })).toEqualTypeOf<Promise<string | Uint8Array>>();
    expectTypeOf(write({ columns: [], rows: [] }, "xlsx")).toEqualTypeOf<Promise<Uint8Array>>();
    expectTypeOf(write({ columns: [], rows: [] }, "markdown")).toEqualTypeOf<Promise<string>>();
    expectTypeOf(convertSync("a", { to: "html" })).toEqualTypeOf<string>();
    expectTypeOf(tryConvert("a", { to: "xlsx" })).toEqualTypeOf<Promise<Result<Uint8Array>>>();
    expectTypeOf(writeXlsx({ columns: [], rows: [] })).toEqualTypeOf<Promise<Uint8Array>>();
    expectTypeOf(writeCsv({ columns: [], rows: [] })).toEqualTypeOf<string>();
    });
  });

  it("rejects invalid options at compile time", () => {
    typecheckOnly(() => {
    // @ts-expect-error XLSX cannot be converted synchronously
    convertSync("a", { to: "xlsx" });
    // @ts-expect-error unknown format
    void convert("a", { to: "pdf" });
    // @ts-expect-error quoting must be "minimal" or "all"
    writeCsv({ columns: [], rows: [] }, { quoting: "some" });
    // @ts-expect-error cells cannot be objects
    writeCsv({ columns: [{ name: "a" }], rows: [[{}]] });
    // @ts-expect-error sheet is a name or index
    void readXlsx(new Uint8Array(), { sheet: true });
    void read("a", { format: "csv", delimiter: ";", sheet: 0, dialect: "mysql" });
    });
  });
});
