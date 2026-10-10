// Runtime smoke test of the built package (CommonJS entry).
const assert = require("node:assert/strict");
const { readCsv, writeMarkdown, writeXlsx, readXlsx, isTable, TabularError, tryConvertSync } = require("tabular-convert");

const t = readCsv("a,b\n1,true\n", { infer: true });
assert.deepEqual(t.rows, [[1, true]]);
assert.equal(isTable(t), true);
assert.equal(writeMarkdown(t, { pad: false }), "| a | b |\n| --: | --- |\n| 1 | true |\n");
const bad = tryConvertSync("[1,", { from: "json", to: "csv" });
assert.equal(bad.ok, false);
assert.ok(bad.error instanceof TabularError);
writeXlsx(t)
  .then((bytes) => readXlsx(bytes))
  .then((back) => {
    assert.deepEqual(back.rows, [[1, true]]);
    console.log(`CJS smoke test passed on Node ${process.version}`);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
