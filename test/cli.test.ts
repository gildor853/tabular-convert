import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, main, parseArgs, USAGE } from "../src/cli-main.js";
import { readXlsx } from "../src/index.js";
import { fixture, text, utf8 } from "./helpers/index.js";

function memoryIo(files: Record<string, Uint8Array | string> = {}, stdin = "") {
  const out: (Uint8Array | string)[] = [];
  let err = "";
  const written: Record<string, Uint8Array | string> = {};
  const io: CliIo = {
    readFile: async (p) => {
      const f = files[p];
      if (f === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: "ENOENT" });
      return typeof f === "string" ? utf8(f) : f;
    },
    writeFile: async (p, d) => {
      written[p] = d;
    },
    readStdin: async () => utf8(stdin),
    stdout: async (d) => {
      out.push(d);
    },
    stderr: (t) => {
      err += t;
    },
  };
  return { io, out: () => out.map((d) => (typeof d === "string" ? d : text(d))).join(""), err: () => err, written };
}

describe("CLI (in memory)", () => {
  it("converts files, inferring formats from extensions", async () => {
    const m = memoryIo({ "in.csv": "a;b\n1;x\n" });
    expect(await main(["in.csv", "out.json", "--infer"], m.io)).toBe(0);
    expect(m.written["out.json"]).toBe('[\n  {\n    "a": 1,\n    "b": "x"\n  }\n]\n');
    expect(m.err()).toBe("");
  });

  it("reads stdin and writes stdout with --to", async () => {
    const m = memoryIo({}, "a,b\n1,2\n");
    expect(await main(["-", "--to", "markdown"], m.io)).toBe(0);
    expect(m.out()).toBe("| a   | b   |\n| --- | --- |\n| 1   | 2   |\n");
    const n = memoryIo({}, '{"a":1}\n{"a":2}\n');
    expect(await main(["-", "-", "--to=csv", "--from=jsonl"], n.io)).toBe(0);
    expect(n.out()).toBe("a\r\n1\r\n2\r\n");
  });

  it("passes reader and writer options", async () => {
    const m = memoryIo({ "in.txt": "x|y\n1,5|'a'\n" });
    expect(
      await main(["in.txt", "-", "--from", "csv", "--to", "sql", "--delimiter", "pipe", "--infer", "--decimal-comma", "--dialect", "mysql", "--table-name", "t", "--create-table"], m.io),
    ).toBe(0);
    expect(m.out()).toBe("CREATE TABLE `t` (\n  `x` DOUBLE,\n  `y` LONGTEXT\n);\nINSERT INTO `t` (`x`, `y`) VALUES\n  (1.5, '''a''');\n");
    const c = memoryIo({ "in.csv": "a\n=cmd\n1.5\n" });
    expect(await main(["in.csv", "-", "--to", "csv", "--escape-formulas", "--out-delimiter", ";", "--out-decimal-comma", "--infer", "--no-header"], c.io)).toBe(0);
    expect(c.out()).toBe("column_1\r\na\r\n\"'=cmd\"\r\n1.5\r\n");
    const j = memoryIo({ "in.csv": "a.b,c\n1,2\n" });
    expect(await main(["in.csv", "-", "--to", "json", "--unflatten", "--json-shape", "objects"], j.io)).toBe(0);
    expect(JSON.parse(j.out())).toEqual([{ a: { b: "1" }, c: "2" }]);
    const e = memoryIo({ "in.csv": new Uint8Array([0x9a, 0x0a, 0x31]) });
    expect(await main(["in.csv", "-", "--to", "ndjson", "--encoding", "windows-1250"], e.io)).toBe(0);
    expect(e.out()).toBe('{"š":"1"}\n');
  });

  it("selects sheets by name or index and writes XLSX", async () => {
    const m = memoryIo({ "book.xlsx": fixture("libreoffice.xlsx"), "old.xls": fixture("libreoffice.xls") });
    expect(await main(["book.xlsx", "-", "--to", "csv", "--sheet", "Second sheet"], m.io)).toBe(0);
    expect(await main(["old.xls", "-", "--to", "csv", "--sheet", "2"], m.io)).toBe(0);
    expect(m.out()).toBe("id,label\r\n1,one\r\n2,two\r\na,b\r\n1,x\r\n3,z\r\n");
    const w = memoryIo({ "in.csv": "a\n1\n" });
    expect(await main(["in.csv", "out.xlsx", "--sheet-name", "Mine", "--infer"], w.io)).toBe(0);
    expect(await readXlsx(w.written["out.xlsx"] as Uint8Array, { sheet: "Mine" })).toEqual({ columns: [{ name: "a" }], rows: [[1]] });
  });

  it("prefers a sheet whose name is a number", async () => {
    const { writeXlsx } = await import("../src/index.js");
    const book = await writeXlsx([
      { name: "2025", table: { columns: [{ name: "y" }], rows: [[2025]] } },
      { name: "1", table: { columns: [{ name: "y" }], rows: [[1]] } },
    ]);
    const m = memoryIo({ "b.xlsx": book });
    expect(await main(["b.xlsx", "-", "--to", "csv", "--sheet", "1"], m.io)).toBe(0);
    expect(await main(["b.xlsx", "-", "--to", "csv", "--sheet", "0"], m.io)).toBe(0);
    expect(m.out()).toBe("y\r\n1\r\ny\r\n2025\r\n");
  });

  it("prints help and version", async () => {
    const h = memoryIo();
    expect(await main(["--help"], h.io)).toBe(0);
    expect(h.out()).toBe(`${USAGE}\n`);
    const v = memoryIo();
    expect(await main(["-v"], v.io)).toBe(0);
    expect(v.out()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.each([
    [[], /Missing input/],
    [["a.csv"], /needs --to/],
    [["a.csv", "out.txt"], /Cannot tell the output format/],
    [["a.csv", "out.xls"], /read-only/],
    [["a.csv", "-", "--to", "pdf"], /Unknown format for --to: "pdf"/],
    [["a.csv", "-", "--to"], /Missing value for --to/],
    [["a.csv", "-", "--to", "csv", "--bogus"], /Unknown option --bogus/],
    [["a.csv", "b.csv", "c.csv"], /Too many arguments/],
    [["a.csv", "-", "--to", "csv", "--delimiter", "ab"], /Invalid delimiter/],
    [["a.csv", "-", "--to", "json", "--json-shape", "x"], /--json-shape/],
    [["a.csv", "-", "--to", "sql", "--dialect", "oracle"], /--dialect/],
    [["a.csv", "-", "--to", "csv", "--max-input-bytes", "-1"], /--max-input-bytes/],
  ])("exits with 2 on usage error %j", async (args, msg) => {
    const m = memoryIo({ "a.csv": "a\n1" });
    expect(await main(args as string[], m.io)).toBe(2);
    expect(m.err()).toMatch(msg as RegExp);
  });

  it("exits with 2 when --sheet is used with a non-workbook", async () => {
    const m = memoryIo({ "a.csv": "a\n1" });
    expect(await main(["a.csv", "-", "--to", "csv", "--sheet", "x"], m.io)).toBe(2);
  });

  it("exits with 1 on conversion and I/O errors", async () => {
    const m = memoryIo({ "bad.json": "[1,", "big.csv": "a\n123456" });
    expect(await main(["bad.json", "-", "--to", "csv"], m.io)).toBe(1);
    expect(m.err()).toMatch(/Invalid JSON.*\[ParseError\]/);
    expect(await main(["missing.csv", "-", "--to", "csv"], m.io)).toBe(1);
    expect(m.err()).toMatch(/ENOENT/);
    expect(await main(["big.csv", "-", "--to", "csv", "--max-input-bytes", "4"], m.io)).toBe(1);
    expect(m.err()).toMatch(/LimitExceeded/);
  });

  it("rethrows unexpected errors", async () => {
    const m = memoryIo();
    m.io.readFile = async () => {
      throw new TypeError("boom");
    };
    await expect(main(["x.csv", "-", "--to", "csv"], m.io)).rejects.toThrow("boom");
  });

  it("parses delimiter names", () => {
    expect(parseArgs(["--delimiter", "tab", "--out-delimiter", "semicolon"]).read.delimiter).toBe("\t");
    expect(parseArgs(["--delimiter", "\\t"]).read.delimiter).toBe("\t");
    expect(parseArgs(["--delimiter", "comma"]).read.delimiter).toBe(",");
    expect(parseArgs(["--from", "md"]).from).toBe("markdown");
  });
});

const cli = new URL("../dist/cli.js", import.meta.url);

describe.skipIf(!existsSync(cli))("CLI (built binary)", () => {
  const run = (args: string[], input?: string) => spawnSync(process.execPath, [cli.pathname, ...args], { input, encoding: "utf8" });

  it("converts between files and pipes with proper exit codes", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-"));
    writeFileSync(join(dir, "in.csv"), "name,qty\nA,1\nB,2\n");
    let r = run([join(dir, "in.csv"), join(dir, "out.xlsx"), "--infer"]);
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "out.xlsx")).subarray(0, 2).toString()).toBe("PK");
    r = run([join(dir, "out.xlsx"), "--to", "json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([{ name: "A", qty: 1 }, { name: "B", qty: 2 }]);
    r = run(["-", "--to", "tsv"], "a,b\n1,2\n");
    expect(r.stdout).toBe("a\tb\r\n1\t2\r\n");
    r = run(["-", "--to", "json"], "[1,");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ParseError/);
    r = run(["--nope"]);
    expect(r.status).toBe(2);
    r = run(["--version"]);
    expect(r.stdout.trim()).toBe(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  });
});
