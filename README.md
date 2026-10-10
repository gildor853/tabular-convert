# tabular-convert

[![CI](https://github.com/gildor853/tabular-convert/actions/workflows/ci.yml/badge.svg)](https://github.com/gildor853/tabular-convert/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
![dependencies: 0](https://img.shields.io/badge/dependencies-0-brightgreen.svg)

Provided as is, without warranty — see [DISCLAIMER.md](./DISCLAIMER.md).

Zero-dependency TypeScript library and command-line tool that **converts
tabular data** between CSV / TSV, JSON, NDJSON, XLSX, XLS (read-only), SQL,
Markdown and HTML. Every reader produces the same small `Table` model and
every writer consumes it, so any input format can be written as any output
format. The XLSX reader and writer (including the ZIP container) and the
legacy XLS reader are written from scratch; compression uses the platform
(`node:zlib`, or `CompressionStream` in browsers).

## Why

- **One model, nine formats**: `{ columns, rows }` with typed cells
  (`string | number | boolean | bigint | Date | null`). Convert with one call,
  or read, transform and write yourself.
- **Real spreadsheets**: XLSX shared and inline strings, dates through number
  formats (1900 system with its leap-year bug, and 1904), several sheets, bold
  headers and column widths; Excel 97–2003 `.xls` (BIFF8) for reading. Output
  is checked against LibreOffice and openpyxl.
- **Correct text formats**: RFC 4180 CSV (quotes, embedded newlines, CRLF/LF,
  BOM, delimiter detection), opt-in type inference including the Czech
  decimal comma, SQL for PostgreSQL, MySQL, SQLite and SQL Server, GitHub
  Markdown tables, HTML tables.
- **Safe with untrusted files**: size limits everywhere, zip-bomb checks, no
  DTDs in XML (no XXE), no prototype pollution, linear-time parsers, nothing
  is ever executed. One error class with machine-readable codes.
- **Small**: no runtime dependencies, ESM + CJS, runs in Node.js 18+,
  browsers and edge runtimes.

## Install

Not published to npm yet. Install a tagged release from GitHub (npm builds
the package during installation):

```sh
npm install github:gildor853/tabular-convert#v1.0.0
```

Requires Node.js 18+, or any modern browser / edge runtime with `bigint`,
`TextDecoder` and (for XLSX outside Node.js) `CompressionStream` with
`"deflate-raw"` support.

The published package has no runtime dependencies and is verified on
Node.js 18 and 20 by a runtime smoke test in CI. Development (tests) needs
Node.js 22.12+, as required by vitest 5.

## Formats

| Format | Read | Write | Notes |
| --- | :-: | :-: | --- |
| CSV / DSV | ✓ | ✓ | RFC 4180; delimiter `,` `;` tab `\|` auto-detected or any single character |
| TSV | ✓ | ✓ | CSV with a tab delimiter |
| JSON | ✓ | ✓ | array of objects, array of arrays, `{ columns, rows }`; nested objects ↔ `a.b` columns |
| NDJSON / JSON Lines | ✓ | ✓ | one object (or array) per line |
| XLSX | ✓ | ✓ | asynchronous (decompression); one or more sheets |
| XLS (Excel 97–2003) | ✓ | – | BIFF8 cell values only; legacy format, write XLSX instead |
| SQL | ✓ | ✓ | writes `CREATE TABLE` + batched `INSERT`; reads `INSERT … VALUES` only |
| Markdown | ✓ | ✓ | GitHub-flavored tables |
| HTML | ✓ | ✓ | first `<table>` of a document; no DOM needed |

Not supported: OpenDocument (`.ods`), binary `.xlsb`, encrypted workbooks,
formulas (only their cached results are read; none are written), cell
styles beyond a bold header and date formats, and streaming (inputs are
processed in memory, within the configured [limits](#limits)).

## Quick start

```ts
import { convert, convertSync, readCsv, writeMarkdown } from "tabular-convert";

const csv = "name;price;in stock\nTea;3,50;true\nCoffee;12;false\n";

// CSV → typed table → Markdown
const table = readCsv(csv, { infer: true, decimalComma: true });
table.rows; // [["Tea", 3.5, true], ["Coffee", 12, false]]
writeMarkdown(table); // "| name   | price | in stock |\n| ------ | ----: | -------- |\n| Tea    |   3.5 | true     |\n| Coffee |    12 | false    |\n"

// one call; the input format is detected
convertSync(csv, { to: "json", read: { infer: true, decimalComma: true }, write: { indent: 0 } }); // "[{\"name\":\"Tea\",\"price\":3.5,\"in stock\":true},{\"name\":\"Coffee\",\"price\":12,\"in stock\":false}]\n"

// XLSX is binary and asynchronous
const xlsx = await convert(csv, { to: "xlsx", read: { infer: true, decimalComma: true } });
xlsx instanceof Uint8Array; // true
await convert(xlsx, { to: "csv", write: { lineEnding: "\n" } }); // "name,price,in stock\nTea,3.5,true\nCoffee,12,false\n"
```

In Node.js, read and write files yourself; the library only sees strings and
bytes:

<!-- readme-check: skip (writes files) -->
```ts
import { readFile, writeFile } from "node:fs/promises";
import { convert } from "tabular-convert";

const bytes = await readFile("report.xlsx");
await writeFile("report.csv", await convert(bytes, { to: "csv", filename: "report.xlsx", read: { sheet: "Q3" } }));
```

## Command line

```sh
npx tabular-convert in.csv out.xlsx --infer
tabular-convert report.xlsx report.json --sheet "Q3"
tabular-convert data.xls --to csv --sheet 1 > data.csv
cat dump.sql | tabular-convert - --to markdown
tabular-convert in.csv out.sql --dialect mysql --table-name orders --create-table
```

```text
Usage: tabular-convert <input> [output] [options]

  --from <format>          input format (csv, tsv, json, ndjson, xlsx, xls, sql, markdown, html)
  --to <format>            output format (required when writing to stdout)
  --sheet <name|index>     XLSX/XLS sheet to read (default: the first)
  --delimiter <d>          input delimiter: a character, or comma|semicolon|tab|pipe
  --out-delimiter <d>      output delimiter for CSV
  --no-header              the input has no header row
  --infer                  convert input text to numbers, booleans, dates, null
  --decimal-comma          with --infer, read 1,5 as 1.5
  --out-decimal-comma      write numbers with a decimal comma (CSV)
  --encoding <label>       input text encoding (default UTF-8, BOM honoured)
  --escape-formulas        protect CSV/TSV output against formula injection
  --json-shape <shape>     objects | arrays | columns (JSON output)
  --unflatten              turn a.b columns into nested JSON objects
  --dialect <d>            SQL dialect: postgres, mysql, sqlite, mssql (default postgres)
  --table-name <name>      SQL table to write (default "data") or to read
  --create-table           emit CREATE TABLE before the INSERTs
  --sheet-name <name>      XLSX sheet name (default "Sheet1")
  --max-input-bytes <n>    input size limit (default 268435456)
  -h, --help / -v, --version
```

`-` means stdin (input) or stdout (output); without an output file the result
goes to stdout. Formats come from file extensions (`.csv .tsv .tab .json
.ndjson .jsonl .xlsx .xlsm .xls .sql .md .html .htm`) or are detected from the
content. A numeric `--sheet` selects a sheet by 0-based index unless a sheet
has exactly that name. Exit codes: `0` success, `1` conversion or I/O error,
`2` usage error.

## The table model

```ts
import { columnTypes, isTable, type Table } from "tabular-convert";

const t: Table = {
  columns: [{ name: "id" }, { name: "when" }],
  rows: [
    [1, new Date(Date.UTC(2026, 9, 9))],
    [2n ** 64n, null],
  ],
};
isTable(t); // true
columnTypes(t); // ["number", "date"]
```

- `columns[i].name` is the header text; readers make names unique (`a`,
  `a_2`) and name empty headers `column_1`, `column_2`, …
  `columns[i].type` is set by `inferTypes` / the `infer` option.
- Rows shorter than the header are padded with `null`; readers add
  `column_N` columns for longer rows (CSV `strict: true` rejects both).
- Dates are JavaScript `Date`s in **UTC**. Text formats write midnight-UTC
  dates as `YYYY-MM-DD` and others as ISO 8601 timestamps.
- Integers beyond `Number.MAX_SAFE_INTEGER` are `bigint` when read from
  JSON, SQL or inferred text, so ids do not lose digits.

## API reference

### Reading and writing

Readers take a string, `Uint8Array` (e.g. a Node.js `Buffer`) or
`ArrayBuffer`. Byte input is decoded as UTF-8 unless a BOM (UTF-8, UTF-16
LE/BE) or the `encoding` option (any WHATWG label, e.g. `"windows-1250"`)
says otherwise.

| Function | Returns |
| --- | --- |
| `readCsv`, `readTsv`, `readJson`, `readNdjson`, `readSql`, `readMarkdown`, `readHtml`, `readXls` | `Table` |
| `readXlsx(input, options?)` | `Promise<Table>` |
| `writeCsv`, `writeTsv`, `writeJson`, `writeNdjson`, `writeSql`, `writeMarkdown`, `writeHtml` | `string` |
| `writeXlsx(table \| { name, table }[], options?)` | `Promise<Uint8Array>` |
| `listSheets(xlsxOrXls)` | `Promise<string[]>` |
| `read(input, { format?, filename?, ...readerOptions })` / `readSync` | `Promise<Table>` / `Table` |
| `write(table, format, writerOptions?)` / `writeSync` | `Promise<string \| Uint8Array>` / `string` |
| `convert(input, { from?, to, filename?, read?, write? })` / `convertSync` | output of `write` |
| `tryRead`, `tryConvert`, `tryConvertSync` | `Result` instead of throwing |
| `detectFormat(input, filename?)`, `formatFromFilename`, `isFormat`, `FORMATS`, `WRITABLE_FORMATS` | format helpers |
| `inferTypes(table, options?)`, `columnTypes(table)`, `isTable(value)` | table helpers |

The `*Sync` variants work for every format except XLSX. The return type of
`write` / `convert` follows the target: `Uint8Array` for `"xlsx"`, `string`
otherwise.

### Common read options

| Option | Default | Formats |
| --- | --- | --- |
| `header` | `true` | all: first row is the header |
| `infer` | `false` | all: `true` or `{ decimalComma, dates, booleans }`, see below |
| `decimalComma` | `false` | with `infer: true`: read `1,5` as 1.5 |
| `encoding` | UTF-8 | text formats |
| `limits` | see [Limits](#limits) | all |

### CSV / TSV

Read options: `delimiter` (`"auto"` default, detects `,` `;` tab `|`), `quote`
(`"`), `escape` (default: the quote, i.e. `""`), `strict` (`false`),
`skipEmptyLines` (`true`), `trim` (`false`). Write options: `delimiter`,
`quote`, `escape`, `header`, `quoting` (`"minimal"` | `"all"`), `lineEnding`
(`"\r\n"` | `"\n"`, default CRLF per RFC 4180), `decimalComma`, `bom`,
`escapeFormulas`. In a one-column table an empty cell is written as `""`, so
the record is not mistaken for a blank line (which readers skip).

```ts
import { detectDelimiter, readCsv, writeCsv } from "tabular-convert";

detectDelimiter("a;b;c\n1,5;2;3"); // ";"
readCsv('id,text\n1,"multi\nline, with ""quotes"""\n').rows; // [["1", "multi\nline, with \"quotes\""]]
readCsv("1\t2", { header: false, delimiter: "\t" }).rows; // [["1", "2"]]
writeCsv({ columns: [{ name: "a" }], rows: [["x,y"], [null]] }, { lineEnding: "\n" }); // "a\n\"x,y\"\n\"\"\n"
```

**CSV injection.** A cell such as `=HYPERLINK(...)` is a formula when the
file is opened in a spreadsheet. `escapeFormulas: true` (CLI:
`--escape-formulas`) follows the OWASP recommendation: text cells starting
with `=`, `+`, `-`, `@`, tab or carriage return get a leading `'` and are
quoted. It is **off by default** because it changes the data (a value like
`-5` stored as text, or `@user`, would no longer round-trip); turn it on for
CSV files that people will open in Excel or LibreOffice. Numbers are never
changed. XLSX output does not need it: strings are always written as text,
never as formulas.

```ts
import { writeCsv } from "tabular-convert";

const t = { columns: [{ name: "v" }], rows: [["=1+1"], ["@SUM(A1)"], [-5]] };
writeCsv(t, { lineEnding: "\n" }); // "v\n=1+1\n@SUM(A1)\n-5\n"
writeCsv(t, { lineEnding: "\n", escapeFormulas: true }); // "v\n\"'=1+1\"\n\"'@SUM(A1)\"\n-5\n"
```

### Type inference

Off by default: text formats give strings, exactly as written. With `infer`
(or `inferTypes(table)`), each column is converted only if **every**
non-empty text cell in it parses as the same kind: numbers (no leading zeros,
so `007` stays text; unsafe integers become `bigint`), `true` / `false` (any
case), and ISO 8601 dates (`2026-10-09`, `2026-10-09T12:30:00Z`, with an
offset or without, read as UTC). Empty text becomes `null`.

```ts
import { readCsv } from "tabular-convert";

const t = readCsv("zip,amount,paid,due\n01234,\"1 000\",TRUE,2026-10-09\n60200,15.5,false,\n", { infer: true });
t.rows[1]; // ["60200", "15.5", false, null]
(t.rows[0]?.[3] as Date).toISOString(); // "2026-10-09T00:00:00.000Z"
t.columns.map((c) => c.type); // ["string", "string", "boolean", "date"]
```

### JSON and NDJSON

Read: an array of objects (keys in first-seen order), an array of arrays
(first row is the header unless `header: false`), an array of plain values
(one `value` column) or `{ "columns": [...], "rows": [[...]] }`. Nested
objects become dot-path columns (`flatten: false` keeps them as JSON text);
arrays inside objects are kept as JSON text. Write options: `shape`
(`"objects"` default, `"arrays"`, `"columns"`), `indent` (2; NDJSON is
always compact) and `unflatten` (turn `a.b` columns back into nested objects).

```ts
import { readJson, writeJson, writeNdjson } from "tabular-convert";

const t = readJson('[{"id":1,"user":{"name":"Ann","city":"Brno"},"tags":["a"]},{"id":12345678901234567890}]');
t.columns.map((c) => c.name); // ["id", "user.name", "user.city", "tags"]
t.rows[1]; // [12345678901234567890n, null, null, null]
writeJson(t, { unflatten: true, indent: 0 }); // "[{\"id\":1,\"user\":{\"name\":\"Ann\",\"city\":\"Brno\"},\"tags\":\"[\\\"a\\\"]\"},{\"id\":12345678901234567890,\"user\":{\"name\":null,\"city\":null},\"tags\":null}]\n"
writeNdjson(t); // "{\"id\":1,\"user.name\":\"Ann\",\"user.city\":\"Brno\",\"tags\":\"[\\\"a\\\"]\"}\n{\"id\":12345678901234567890,\"user.name\":null,\"user.city\":null,\"tags\":null}\n"
```

Keys such as `__proto__` and `constructor` are ordinary column names: the
parser builds `Map`s, never plain objects, so nothing reaches
`Object.prototype`.

### XLSX

`readXlsx(input, { sheet?, header?, skipEmptyRows?, infer?, limits? })`:
`sheet` is a name (exact, then case-insensitive) or a 0-based index, default
the first sheet. The table starts at the first used row and column; rows
without values are skipped unless `skipEmptyRows: false`. Shared, inline and
rich-text strings, numbers, booleans, errors (as text such as `#N/A`) and
cached formula results are read; dates are recognised through the cell's
number format (built-in date formats and custom codes with `d m y h s`
outside quotes and brackets). Merged cells are not expanded: the value stays
in the top-left cell.

`writeXlsx(tableOrSheets, { sheetName?, header?, columnWidths?, freezeHeader? })`
writes one sheet, or several from `[{ name, table }]`. The header row is bold;
dates get a `yyyy-mm-dd` or `yyyy-mm-dd hh:mm:ss` format; `columnWidths` is
`"auto"` or an array of widths in characters. Integers beyond 2^53 are
written as text so no digits are lost; dates before 1900 (not representable
in Excel) are written as ISO text.

```ts
import { listSheets, readXlsx, writeXlsx } from "tabular-convert";

const bytes = await writeXlsx(
  [
    { name: "Orders", table: { columns: [{ name: "id" }, { name: "date" }], rows: [[1, new Date(Date.UTC(2026, 9, 9))]] } },
    { name: "Notes", table: { columns: [{ name: "text" }], rows: [["Žluťoučký kůň"]] } },
  ],
  { columnWidths: "auto", freezeHeader: true },
);
await listSheets(bytes); // ["Orders", "Notes"]
const [[id, date]] = (await readXlsx(bytes, { sheet: "Orders" })).rows as [[number, Date]];
[id, date.toISOString()]; // [1, "2026-10-09T00:00:00.000Z"]
(await readXlsx(bytes, { sheet: 1 })).rows; // [["Žluťoučký kůň"]]
```

Excel's **1900 date system** counts 1900-02-29, a day that did not exist
(compatibility with Lotus 1-2-3). Serials from 61 on are therefore offset by
one day, serials below 60 are not, and serial 60 itself has no real date: it
is returned as the number `60`. Workbooks using the **1904 system** (flag in
the workbook) are handled too. LibreOffice does not reproduce the 1900 bug,
so dates before 1900-03-01 that it writes appear one day later in Excel and
in this library.

### XLS (Excel 97–2003, read-only)

`readXls(input, options)` takes the same options as `readXlsx` and is
synchronous. It reads the compound-file container and the BIFF8 records for
cell values: shared strings (including strings continued across records),
inline labels, numbers (`NUMBER`, `RK`, `MULRK`), booleans and errors, and
the cached results of formulas. Dates are recognised through number formats
and the workbook's 1900/1904 setting. Encrypted files and the older BIFF5
format (Excel 5/95) are rejected with an explanation. Note that LibreOffice's
`.xls` export stores `0` as the cached result of text formulas; that is what
the file contains, and what `xlrd` reads as well.

### SQL

`writeSql(table, { dialect?, tableName?, schema?, createTable?, batchSize? })`
writes optional `CREATE TABLE` (column types guessed from the cells) and
`INSERT` statements with up to `batchSize` rows (default 500; SQL Server
allows 1000). Identifiers are quoted (`"x"`, `` `x` ``, `[x]`), strings
escaped for the dialect (`''`; MySQL also escapes backslashes, assuming the
default `sql_mode`; PostgreSQL output assumes `standard_conforming_strings`,
on by default since 9.1; SQL Server uses `N'…'`), booleans are `TRUE`/`FALSE`
(PostgreSQL, MySQL) or `1`/`0` (SQLite, SQL Server), and dates are UTC
literals (`'2026-10-09'`, `'2026-10-09 12:30:00'`).

```ts
import { readSql, writeSql } from "tabular-convert";

const t = { columns: [{ name: "id" }, { name: "name" }, { name: "ok" }], rows: [[1, "O'Brien", true]] };
writeSql(t, { dialect: "postgres", tableName: "people", createTable: true }); // "CREATE TABLE \"people\" (\n  \"id\" BIGINT,\n  \"name\" TEXT,\n  \"ok\" BOOLEAN\n);\nINSERT INTO \"people\" (\"id\", \"name\", \"ok\") VALUES\n  (1, 'O''Brien', TRUE);\n"
writeSql(t, { dialect: "mssql" }); // "INSERT INTO [data] ([id], [name], [ok]) VALUES\n  (1, N'O''Brien', 1);\n"
readSql("INSERT INTO `people` (`id`, `name`) VALUES (1, 'O\\'Brien'), (2, NULL);").rows; // [[1, "O'Brien"], [2, null]]
```

`readSql` is deliberately limited: it reads the literal values of
`INSERT … VALUES` statements (strings, numbers, `TRUE`/`FALSE`, `NULL`) and
skips every other statement; column names come from the `INSERT` column list
or a preceding `CREATE TABLE`. If the input inserts into several tables,
pick one with `table`. Backslash escapes are honoured for MySQL (`dialect:
"mysql"`, or automatically when the input uses backtick identifiers).
Nothing is ever executed.

### Markdown and HTML

```ts
import { readHtml, readMarkdown, writeHtml, writeMarkdown } from "tabular-convert";

const t = { columns: [{ name: "a|b" }, { name: "n" }], rows: [["x<y", 1]] };
writeMarkdown(t, { pad: false }); // "| a\\|b | n |\n| --- | --: |\n| x<y | 1 |\n"
writeHtml(t); // "<table>\n  <thead>\n    <tr><th>a|b</th><th>n</th></tr>\n  </thead>\n  <tbody>\n    <tr><td>x&lt;y</td><td>1</td></tr>\n  </tbody>\n</table>\n"
readMarkdown("Intro\n\n| a | b |\n|:--|--:|\n| 1 | 2 |\n").rows; // [["1", "2"]]
readHtml("<p>…</p><table><tr><th>a</th></tr><tr><td>x &amp; <b>y</b></td></tr></table>").rows; // [["x & y"]]
```

Markdown: the first GFM table of the text is read; `\|` and `\\` are
unescaped and `<br>` becomes a newline (and vice versa on write, so cells
can contain pipes and newlines; a literal `<br>` in the data therefore reads
back as a newline). Write options: `align` (`"auto"` right-aligns
number columns; or `"left"`, `"right"`, `"center"`, `"none"`, or one per
column) and `pad` (`true`).

HTML: the first `<table>` is read with a small linear scanner, without a DOM:
text of `<th>`/`<td>` with tags stripped, entities decoded, whitespace
collapsed as a browser would and `<br>` as a newline. `<script>`, `<style>`
and comments are skipped; `colspan` / `rowspan` are ignored and nested
tables rejected. The writer escapes `& < > " '`; options `header` and
`caption`.

## Limits

Every reader accepts `limits` (all optional, positive integers):

| Limit | Default | Applies to |
| --- | --- | --- |
| `maxInputBytes` | 268 435 456 (256 MiB) | input size (characters for strings) |
| `maxRows` | 2 000 000 | rows read |
| `maxColumns` | 16 384 | columns read |
| `maxCellLength` | 1 048 576 | characters per cell |
| `maxZipEntries` | 10 000 | XLSX: entries in the ZIP container |
| `maxUncompressedBytes` | 1 073 741 824 (1 GiB) | XLSX: total inflated size |
| `maxCompressionRatio` | 1 000 | XLSX: per entry larger than 1 MiB |
| `maxDepth` | 256 | JSON and XML nesting |

Exceeding one throws `LimitExceeded` with the option to raise. Inflation is
capped at each entry's declared size, so a lying ZIP header cannot expand
further. `DEFAULT_LIMITS` exports the defaults.

```ts
import { readCsv, tryRead } from "tabular-convert";

const r = await tryRead("a\n1\n2\n3", { format: "csv", limits: { maxRows: 2 } });
r.ok ? r.value : r.error.code; // "LimitExceeded"
readCsv("a\n1\n2\n3", { limits: { maxRows: 3 } }).rows.length; // 3
```

## Error handling

All throwing functions throw `TabularError` with a `code`:

| Code | Meaning |
| --- | --- |
| `ParseError` | The input is not valid for its format (unclosed quote, bad JSON, corrupt ZIP or XLS, DOCTYPE in XML, …). |
| `UnsupportedFormat` | Unknown format name, or a feature outside the scope (ODS, encrypted or ZIP64 workbooks, BIFF5, non-literal SQL values, …). |
| `InvalidInput` | A table or value that cannot be written (non-finite number, invalid sheet name, too many rows for XLSX, …), or a wrongly typed input. |
| `InvalidOption` | An option has a wrong type or value. |
| `LimitExceeded` | A size, row, column, cell, nesting or decompression limit was hit. |

```ts
import { isTabularError, readJson, tryConvertSync } from "tabular-convert";

try {
  readJson('[{"a": 1}');
} catch (err) {
  if (isTabularError(err)) console.log(err.code); // "ParseError"
}

const r = tryConvertSync("a\n1", { to: "pdf" as "csv" });
r.ok ? r.value : r.error.code; // "UnsupportedFormat"
```

`try*` functions return `{ ok: true, value }` or `{ ok: false, error }` and
never throw for bad input; `is*` functions return a boolean and never throw.

## Security

The library is meant for untrusted files:

- **Bounded work**: every reader enforces the [limits](#limits); parsers are
  hand-written, single-pass state machines or use only linear regular
  expressions, and the tests include hostile inputs (1 MiB of `""`, unclosed
  quotes, millions of pipes or `<`) with time bounds.
- **ZIP**: entry count, total and per-entry inflated size and compression
  ratio are checked before anything is inflated; inflation stops at the
  declared size; CRC-32 is verified; ZIP64, encryption and unknown methods
  are rejected.
- **XML**: a small non-validating parser that rejects any `<!DOCTYPE` or
  `<!ENTITY`, knows only the five predefined and numeric entities, and limits
  nesting. No external entities, no entity expansion.
- **No prototype pollution**: JSON objects are parsed into `Map`s, lookup
  tables use `Object.create(null)`, and `__proto__` in data is just a name.
- **Nothing is executed**: SQL is tokenized, never run; formulas are never
  written and only cached results are read.
- **CSV injection**: optional OWASP-style escaping, see [CSV](#csv--tsv).

Report vulnerabilities privately, see [SECURITY.md](./SECURITY.md).

## Interoperability testing

XLSX and XLS behaviour is checked against independent implementations:

- `test/fixtures` holds workbooks generated by **LibreOffice** (from a flat
  ODS source, exported as `.xlsx` and `.xls`) and by **openpyxl** (including
  a 1904-date workbook), regenerated with `scripts/make-fixtures.sh`. The
  tests read them and compare every cell; the `.xls` values were
  cross-checked with `xlrd`.
- `test/interop.test.ts` writes XLSX files with this library and opens them
  with LibreOffice (headless conversion to CSV) and openpyxl, checking
  values, types, date formats, bold headers and column widths. It runs when
  `soffice` and `python3 -c "import openpyxl"` are available and is skipped
  otherwise (as in CI).
- Synthetic BIFF8 files built in the tests cover XLS records that
  LibreOffice does not emit (formula string results, rich strings, `RK`
  variants, encryption and BIFF5 rejection).
- Before the release, larger files were checked by hand: a 20 MB
  LibreOffice `.xls` (780 000 cells, a FAT long enough to need DIFAT
  sectors, shared strings spread over many `CONTINUE` records) read
  cell-for-cell equal to its CSV source, and an 8 MB XLSX written by this
  library read back equal in openpyxl.

## Sources

- [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180): CSV format and the
  `text/csv` media type.
- [ECMA-376](https://ecma-international.org/publications-and-standards/standards/ecma-376/)
  Office Open XML, Part 1 (SpreadsheetML, number formats, `_xHHHH_`
  escaping) and Part 2 (Open Packaging Conventions).
- [PKWARE APPNOTE.TXT](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT):
  ZIP file format.
- [MS-CFB](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/)
  Compound File Binary format and
  [MS-XLS](https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/)
  Excel binary file format (BIFF8).
- [Excel 1900 date system and the leap-year bug](https://learn.microsoft.com/en-us/troubleshoot/microsoft-365-apps/excel/wrongly-assumes-1900-is-leap-year).
- [OWASP: CSV Injection](https://owasp.org/www-community/attacks/CSV_Injection).
- [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259) (JSON),
  [JSON Lines](https://jsonlines.org/),
  [GitHub Flavored Markdown tables](https://github.github.com/gfm/#tables-extension-),
  [HTML named character references](https://html.spec.whatwg.org/multipage/named-characters.html)
  (a common subset is decoded).

## Limitations

- Everything happens in memory; there is no streaming API. Limits keep
  memory use bounded, but a 200 MB CSV needs a few times that in RAM.
- XLSX/XLS: values only. No formulas (cached results are read), no styles
  beyond a bold header and date formats, no merged-cell expansion, no
  hidden-sheet handling (all worksheets are listed; chart sheets are not).
  `.xlsb`, `.ods`, encrypted and ZIP64 files are not supported.
- XLS is read-only and BIFF8 only (Excel 97 and later).
- SQL reading covers `INSERT … VALUES` with literal values; `COPY`,
  `INSERT … SELECT`, functions and expressions are rejected or skipped.
- HTML reading takes the first table and ignores `colspan` / `rowspan`;
  whitespace is collapsed, so leading/trailing spaces in cells are lost.
  Markdown trims cell whitespace as well.
- Dates are handled in UTC. Spreadsheet date-times have no time zone; they
  are read as if they were UTC.
- The HTML entity decoder knows the common named entities (`&nbsp;`,
  `&euro;`, quotes, dashes, …) and all numeric ones; others are left as
  written.

## Disclaimer

**Use at your own risk.** This software is provided as is, without warranty of any kind. Conversions can lose data or fidelity — keep originals and verify outputs. See the full legal text in [DISCLAIMER.md](./DISCLAIMER.md).

## Contributing

This repository is maintained by a single author and does not accept external
contributions; issues and pull requests are limited to collaborators.

Security problems can be reported privately, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) © 2026 Gildor
