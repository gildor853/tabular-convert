// Mutation fuzzing: corrupted inputs must either parse or fail with a TabularError,
// never with another exception and never by hanging.
import { describe, expect, it } from "vitest";
import { isTabularError, read, readSync, type Format } from "../src/index.js";
import { DEFAULT_LIMITS } from "../src/limits.js";
import { openZip, writeZip } from "../src/xlsx/zip.js";
import { fixture, utf8 } from "./helpers/index.js";

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(src: Uint8Array, rand: () => number): Uint8Array {
  const b = src.slice();
  const kind = Math.floor(rand() * 4);
  if (kind === 0) return b.subarray(0, Math.floor(rand() * b.length)); // truncate
  const n = 1 + Math.floor(rand() * 8);
  for (let k = 0; k < n; k++) {
    const i = Math.floor(rand() * b.length);
    if (kind === 1) b[i] = Math.floor(rand() * 256);
    else if (kind === 2) b[i] = (b[i] as number) ^ (1 << Math.floor(rand() * 8));
    else b[i] = [0x00, 0xff, 0x22, 0x2c, 0x0a, 0x3c, 0x7b, 0x27][Math.floor(rand() * 8)] as number;
  }
  return b;
}

const SCALE = Number(process.env.FUZZ_SCALE ?? 1); // e.g. FUZZ_SCALE=50 for a long local run

const unexpected = (format: string, err: unknown) => `${format}: ${err instanceof Error ? err.stack : String(err)}`;

describe("mutation fuzzing", () => {
  const binary: [Format, Uint8Array][] = [
    ["xlsx", fixture("libreoffice.xlsx")],
    ["xlsx", fixture("openpyxl.xlsx")],
    ["xls", fixture("libreoffice.xls")],
  ];
  it.each(binary.map(([f, b], k) => [f, k, b] as const))("%s fixture %i", async (format, k, bytes) => {
    const rand = rng(1000 + k + SCALE);
    for (let n = 0; n < 300 * SCALE; n++) {
      const input = mutate(bytes, rand);
      try {
        await read(input, { format });
      } catch (err) {
        expect(isTabularError(err), unexpected(format, err)).toBe(true);
      }
    }
  });

  it.each(["libreoffice.xlsx", "openpyxl.xlsx", "openpyxl-1904.xlsx"])("XML parts inside %s", async (name) => {
    const zip = openZip(fixture(name), DEFAULT_LIMITS);
    const parts = await Promise.all(zip.names.map(async (n) => ({ name: n, data: await zip.read(n) })));
    const rand = rng(name.length + SCALE);
    for (let n = 0; n < 150 * SCALE; n++) {
      const victim = Math.floor(rand() * parts.length);
      const files = parts.map((p, k) => (k === victim ? { name: p.name, data: mutate(p.data, rand) } : p));
      const input = await writeZip(files);
      try {
        await read(input, { format: "xlsx", infer: n % 2 === 0 });
      } catch (err) {
        expect(isTabularError(err), unexpected(`${name} ${parts[victim]?.name}`, err)).toBe(true);
      }
    }
  });

  const texts: [Format, string][] = [
    ["csv", 'id,name,note\r\n1,"A, B","say ""hi"""\r\n2,C,"multi\nline"\r\n'],
    ["json", '[{"a": 1, "b": {"c": [1, 2], "d": "x\\u00e9"}}, {"a": -1.5e3, "e": null, "f": true}]'],
    ["ndjson", '{"a": 1}\n{"a": 2, "b": "x"}\n'],
    ["sql", "CREATE TABLE t (a INT, b TEXT);\nINSERT INTO t (a, b) VALUES (1, 'x''y'), (-2.5, NULL), (3, E'\\n');\n"],
    ["markdown", "| a | b |\n|:--|--:|\n| 1 | x \\| y |\n| 2 | <br> |\n"],
    ["html", "<table><caption>c</caption><tr><th>a</th><th>b</th></tr><tr><td>1 &amp; 2</td><td><b>x</b><br>y</td></tr></table>"],
  ];
  it.each(texts)("%s", (format, src) => {
    const rand = rng(format.length * 7919 + SCALE);
    const bytes = utf8(src);
    for (let n = 0; n < 500 * SCALE; n++) {
      const input = mutate(bytes, rand);
      try {
        readSync(input, { format, infer: n % 2 === 0 });
      } catch (err) {
        expect(isTabularError(err), unexpected(format, err)).toBe(true);
      }
    }
  });
});
