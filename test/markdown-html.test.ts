import { describe, expect, it } from "vitest";
import { readHtml, readMarkdown, writeHtml, writeMarkdown } from "../src/index.js";
import { decodeEntities } from "../src/formats/html.js";
import { names, table, throwsCode } from "./helpers/index.js";

const t = table(["name", "qty", "note"], [
  ["a|b", 3, "back\\slash"],
  ["multi\nline", 10.5, null],
  ["x", null, "*keep* `md`"],
]);

describe("Markdown", () => {
  it("writes an aligned GFM table with escaping", () => {
    expect(writeMarkdown(t)).toBe(
      [
        "| name          |  qty | note        |",
        "| ------------- | ---: | ----------- |",
        "| a\\|b          |    3 | back\\\\slash |",
        "| multi<br>line | 10.5 |             |",
        "| x             |      | *keep* `md` |",
        "",
      ].join("\n"),
    );
  });

  it("supports explicit alignment and no padding", () => {
    expect(writeMarkdown(table(["a", "b", "c", "d"], [[1, 2, 3, 4]]), { align: ["left", "center", "right", "none"], pad: false })).toBe(
      "| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |\n",
    );
    expect(writeMarkdown(table(["a"], [["x"]]), { align: "center" })).toBe("|  a  |\n| :-: |\n|  x  |\n");
    expect(writeMarkdown(table(["a"], [[" x"]]), { align: "center", pad: true })).toContain("|  x  |");
    throwsCode(() => writeMarkdown(t, { align: ["left"] }), "InvalidOption");
    throwsCode(() => writeMarkdown(t, { align: "middle" as "left" }), "InvalidOption");
    expect(writeMarkdown({ columns: [], rows: [] })).toBe("");
  });

  it("reads back what it writes", () => {
    const back = readMarkdown(writeMarkdown(t), { infer: true });
    expect(back.rows).toEqual([
      ["a|b", 3, "back\\slash"],
      ["multi\nline", 10.5, null],
      ["x", null, "*keep* `md`"],
    ]);
  });

  it("finds the first table in a document and stops at its end", () => {
    const doc = `# Title

Some text | with a pipe.

name | value
:--- | ---:
a | 1
b | 2 |
c

| other | table |
| --- | --- |
| x | y |
`;
    const r = readMarkdown(doc);
    expect(names(r)).toEqual(["name", "value"]);
    expect(r.rows).toEqual([
      ["a", "1"],
      ["b", "2"],
    ]);
  });

  it("pads short rows, drops extra cells and supports header: false", () => {
    expect(readMarkdown("|a|b|\n|-|-|\n|1|\n|1|2|3|").rows).toEqual([
      ["1", ""],
      ["1", "2"],
    ]);
    expect(readMarkdown("|a|b|\n|-|-|\n|1|2|", { header: false }).rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
    expect(readMarkdown("| a | |\n|---|---|\n| 1 | |").rows).toEqual([["1", ""]]);
  });

  it("rejects text without a table", () => {
    throwsCode(() => readMarkdown("just | text\nno delimiter"), "ParseError", /No Markdown table/);
  });
});

describe("HTML", () => {
  it("writes an escaped table", () => {
    expect(writeHtml(table(["a<b", "c"], [["x & y", '"q" \'s\''], ["l1\nl2", null]]), { caption: "Cap & <b>" })).toBe(
      `<table>
  <caption>Cap &amp; &lt;b&gt;</caption>
  <thead>
    <tr><th>a&lt;b</th><th>c</th></tr>
  </thead>
  <tbody>
    <tr><td>x &amp; y</td><td>&quot;q&quot; &#39;s&#39;</td></tr>
    <tr><td>l1<br>l2</td><td></td></tr>
  </tbody>
</table>
`,
    );
    expect(writeHtml(table(["a"], [[1]]), { header: false })).not.toContain("<thead>");
    throwsCode(() => writeHtml(t, { caption: 1 as unknown as string }), "InvalidOption");
  });

  it("reads back what it writes", () => {
    expect(readHtml(writeHtml(t), { infer: true }).rows).toEqual([
      ["a|b", 3, "back\\slash"],
      ["multi\nline", 10.5, null],
      ["x", null, "*keep* `md`"],
    ]);
  });

  it("reads the first table of a messy document", () => {
    const html = `<!doctype html><html><head><title>Not <table></title>
<style>td { color: red } /* <table> */</style>
<script>document.write("<table><tr><td>evil</td></tr></table>")</script></head>
<body><!-- <table><tr><td>commented</td></tr></table> -->
<p>Intro</p>
<TABLE class="data" data-x='a > b'>
  <caption>Ignored caption</caption>
  <tr><th>Name</th><th>Amount&nbsp;(CZK)</th></tr>
  <tr><td><b>Žluť</b>  &amp;
      kůň</td><td align=right>1&#160;234,5</td>
  <tr><td>line<br/>break</td><td>&#x1F600; &unknown; &lt;</td></tr>
</TABLE>
<table><tr><td>second</td></tr></table></body></html>`;
    const r = readHtml(html);
    expect(names(r)).toEqual(["Name", "Amount\u00a0(CZK)"]);
    expect(r.rows).toEqual([
      ["Žluť & kůň", "1\u00a0234,5"],
      ["line\nbreak", "😀 &unknown; <"],
    ]);
  });

  it("ignores colspan, handles thead/tbody/tfoot and implicit closes", () => {
    const r = readHtml("<table><thead><tr><th>a<th>b</thead><tbody><tr><td colspan=2>wide<tr><td>1<td>2</tbody><tfoot><tr><td>s<td>t</tfoot></table>");
    expect(r.rows).toEqual([
      ["wide", null],
      ["1", "2"],
      ["s", "t"],
    ]);
  });

  it("rejects nested tables and documents without a table", () => {
    throwsCode(() => readHtml("<table><tr><td><table></table></td></tr></table>"), "ParseError", /Nested/);
    throwsCode(() => readHtml("<p>no table</p>"), "ParseError", /No <table>/);
  });

  it("copes with unterminated constructs", () => {
    expect(readHtml("<table><tr><td>a<td>b").rows).toEqual([]);
    expect(readHtml("<table><tr><td>a < b <!-- open").columns.map((c) => c.name)).toEqual(["a < b"]);
    expect(readHtml('<table><tr><td x="unclosed>a').columns).toEqual([{ name: "column_1" }]);
    expect(readHtml("<table><tr><td>x</td></tr><script>").columns.map((c) => c.name)).toEqual(["x"]);
    expect(readHtml("<table><tr><td>x<?pi?><!x></td></tr></table>").columns.map((c) => c.name)).toEqual(["x"]);
  });

  it("decodes entities safely", () => {
    expect(decodeEntities("&#0;&#xD800;&#1114112;&#65;&euro;&amp;amp;")).toBe("\ufffd\ufffd\ufffdA€&amp;");
  });

  it("enforces limits", () => {
    throwsCode(() => readHtml("<table><tr><td>abcdef</td></tr></table>", { limits: { maxCellLength: 3 } }), "LimitExceeded");
    throwsCode(() => readHtml("<table><tr><td>1<td>2<td>3</table>", { limits: { maxColumns: 2 } }), "LimitExceeded");
    throwsCode(() => readHtml("<table><tr><td>1<tr><td>2<tr><td>3</table>", { limits: { maxRows: 1 } }), "LimitExceeded");
  });
});
