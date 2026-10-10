import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { USAGE } from "../src/cli-main.js";
import { DEFAULT_LIMITS, FORMATS } from "../src/index.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

describe("README", () => {
  it("install snippet references the current tag", () => {
    expect(readme).toContain(`npm install github:gildor853/tabular-convert#v${pkg.version}`);
  });

  it("documents every CLI option", () => {
    for (const flag of USAGE.match(/--[a-z-]+/g) ?? []) expect(readme, flag).toContain(flag);
  });

  it("lists every format in the matrix", () => {
    for (const f of FORMATS) expect(readme.toLowerCase()).toContain(f === "ndjson" ? "| ndjson / json lines |" : f === "xls" ? "| xls (excel 97–2003) |" : `| ${f}`);
  });

  it("states the default limits", () => {
    const fmt = (n: number) => n.toLocaleString("en-US").replace(/,/g, " ");
    for (const [key, value] of Object.entries(DEFAULT_LIMITS)) expect(readme, key).toMatch(new RegExp(`\\| \`${key}\` \\| ${fmt(value)}`));
  });
});
