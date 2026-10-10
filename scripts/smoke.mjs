// Runtime smoke test of the built package (ESM entry and CLI), run by CI on
// Node versions the test runner no longer supports. No dependencies, no network.
// The bare specifier resolves to ./dist through the package's "exports" map.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convert, convertSync, detectFormat, listSheets, readCsv, readXls, readXlsx, writeSql, writeXlsx } from "tabular-convert";

const table = readCsv("name;qty;when\nŽluť;1,5;2026-10-09\n", { infer: true, decimalComma: true });
assert.deepEqual(table.rows, [["Žluť", 1.5, new Date(Date.UTC(2026, 9, 9))]]);
assert.equal(convertSync("a,b\n1,2\n", { to: "json", write: { indent: 0 } }), '[{"a":"1","b":"2"}]\n');
assert.equal(writeSql(table, { dialect: "mssql" }), "INSERT INTO [data] ([name], [qty], [when]) VALUES\n  (N'Žluť', 1.5, N'2026-10-09');\n");

// XLSX round trip through the platform's DEFLATE
const xlsx = await writeXlsx([{ name: "Data", table }]);
assert.equal(detectFormat(xlsx), "xlsx");
assert.deepEqual(await listSheets(xlsx), ["Data"]);
assert.deepEqual((await readXlsx(xlsx)).rows, table.rows);
assert.equal(await convert(xlsx, { to: "csv", write: { lineEnding: "\n" } }), "name,qty,when\nŽluť,1.5,2026-10-09\n");

// legacy XLS fixture
const xls = new Uint8Array(readFileSync(new URL("../test/fixtures/libreoffice.xls", import.meta.url)));
assert.deepEqual(readXls(xls, { sheet: "Second sheet" }).rows, [[1, "one"], [2, "two"]]);

// CLI
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "tabular-convert-smoke-"));
writeFileSync(join(dir, "in.csv"), "a,b\n1,x\n");
let r = spawnSync(process.execPath, [cli, join(dir, "in.csv"), join(dir, "out.xlsx"), "--infer"], { encoding: "utf8" });
assert.equal(r.status, 0, r.stderr);
r = spawnSync(process.execPath, [cli, join(dir, "out.xlsx"), "--to", "ndjson"], { encoding: "utf8" });
assert.equal(r.stdout, '{"a":1,"b":"x"}\n');
r = spawnSync(process.execPath, [cli, "-", "--to", "markdown"], { input: "a\n1\n", encoding: "utf8" });
assert.equal(r.stdout, "| a   |\n| --- |\n| 1   |\n");
r = spawnSync(process.execPath, [cli, "-", "--to", "json"], { input: "[1,", encoding: "utf8" });
assert.equal(r.status, 1);
r = spawnSync(process.execPath, [cli, "--bogus"], { encoding: "utf8" });
assert.equal(r.status, 2);

console.log(`ESM + CLI smoke test passed on Node ${process.version}`);
