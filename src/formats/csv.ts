import { fail } from "../errors.js";
import { applyInfer, type InferOptions } from "../infer.js";
import { bool, char, type Input, oneOf, opts, toText } from "../input.js";
import { type Limits, limitError, resolveLimits } from "../limits.js";
import { type Cell, cellText, checkTable, makeTable, type Table } from "../table.js";

/** Options shared by the text readers. */
export interface TextReadOptions {
  /** Text encoding for binary input without a BOM (any WHATWG label, e.g. `"windows-1250"`). Default UTF-8. */
  readonly encoding?: string;
  /** First row is the header. Default `true`. */
  readonly header?: boolean;
  /** Convert text to numbers, booleans, dates and `null` (see `inferTypes`). Default `false`. */
  readonly infer?: boolean | InferOptions;
  /** With `infer: true`, read `1,5` as 1.5 (Czech and other decimal-comma locales). Default `false`. */
  readonly decimalComma?: boolean;
  readonly limits?: Partial<Limits>;
}

export interface CsvReadOptions extends TextReadOptions {
  /** Field delimiter, or `"auto"` (default) to detect `,` `;` tab or `|`. */
  readonly delimiter?: string;
  /** Quote character. Default `"`. */
  readonly quote?: string;
  /** Escape character inside quoted fields. Default: the quote character (RFC 4180 `""`). */
  readonly escape?: string;
  /** Throw on malformed quoting and on records whose field count differs from the first record, instead of reading leniently. Default `false`. */
  readonly strict?: boolean;
  /** Skip completely empty lines. Default `true`. */
  readonly skipEmptyLines?: boolean;
  /** Trim spaces around unquoted fields. Default `false`. */
  readonly trim?: boolean;
}

export interface CsvWriteOptions {
  /** Default `,` (`\t` for `writeTsv`). */
  readonly delimiter?: string;
  readonly quote?: string;
  readonly escape?: string;
  /** Write the header row. Default `true`. */
  readonly header?: boolean;
  /** `"minimal"` (default) quotes only fields that need it; `"all"` quotes every field. */
  readonly quoting?: "minimal" | "all";
  /** Default `"\r\n"` (RFC 4180). */
  readonly lineEnding?: "\r\n" | "\n";
  /** Write numbers with a decimal comma (`1,5`). Default `false`. */
  readonly decimalComma?: boolean;
  /**
   * Neutralise spreadsheet formulas (CSV injection, OWASP): text cells starting
   * with `=`, `+`, `-`, `@`, tab or CR get a leading `'` and are quoted.
   * Default `false` (output stays lossless); enable it for files that people
   * will open in a spreadsheet.
   */
  readonly escapeFormulas?: boolean;
  /** Start with a UTF-8 BOM (helps Excel detect UTF-8). Default `false`. */
  readonly bom?: boolean;
}

const CANDIDATES = [",", ";", "\t", "|"];

/** Detects the delimiter from up to 20 records: the candidate with the most consistent non-zero count per line. */
export function detectDelimiter(text: string, quote = '"'): string {
  const counts = new Map<string, number[]>(CANDIDATES.map((c) => [c, []]));
  const current = new Map<string, number>(CANDIDATES.map((c) => [c, 0]));
  let inQuotes = false;
  let lineLength = 0;
  let lines = 0;
  for (let i = 0; i <= text.length && lines < 20; i++) {
    const ch = i < text.length ? (text[i] as string) : "\n";
    if (ch === quote) {
      inQuotes = !inQuotes;
      lineLength++;
      continue;
    }
    if (inQuotes) continue;
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      if (lineLength > 0) {
        for (const c of CANDIDATES) (counts.get(c) as number[]).push(current.get(c) as number);
        lines++;
      }
      for (const c of CANDIDATES) current.set(c, 0);
      lineLength = 0;
      continue;
    }
    lineLength++;
    const k = current.get(ch);
    if (k !== undefined) current.set(ch, k + 1);
  }
  let best = ",";
  let bestFreq = 0;
  let bestCount = 0;
  for (const c of CANDIDATES) {
    const freq = new Map<number, number>();
    for (const n of counts.get(c) as number[]) if (n > 0) freq.set(n, (freq.get(n) ?? 0) + 1);
    for (const [n, f] of freq) {
      if (f > bestFreq || (f === bestFreq && n > bestCount)) {
        best = c;
        bestFreq = f;
        bestCount = n;
      }
    }
  }
  return best;
}

/** @internal Parses delimited text into raw records. Linear in the input size. */
export function parseDelimited(text: string, o: Record<string, unknown>, limits: Limits): string[][] {
  const quote = char(o, "quote", '"');
  const escape = char(o, "escape", quote);
  const strict = bool(o, "strict", false);
  const skipEmpty = bool(o, "skipEmptyLines", true);
  const trim = bool(o, "trim", false);
  const delimiter = o.delimiter === undefined || o.delimiter === "auto" ? detectDelimiter(text, quote) : char(o, "delimiter", ",");
  if (delimiter === quote) fail("InvalidOption", "The delimiter and the quote character must differ.");
  const records: string[][] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  let row: string[] = [];
  let rowQuoted = false; // a line holding just "" is a record with one empty field, not a blank line
  const pushField = (value: string) => {
    if (value.length > limits.maxCellLength) limitError("Cell length", limits.maxCellLength);
    row.push(value);
    if (row.length > limits.maxColumns) limitError("Number of columns", limits.maxColumns);
  };
  const endRow = () => {
    if (!(skipEmpty && row.length === 1 && row[0] === "" && !rowQuoted)) {
      records.push(row);
      if (records.length > limits.maxRows + 1) limitError("Number of rows", limits.maxRows);
    }
    row = [];
    rowQuoted = false;
  };
  const isSpace = (ch: string | undefined) => ch === " " || (ch === "\t" && delimiter !== "\t");
  while (i <= n) {
    let value: string;
    if (trim && isSpace(text[i])) {
      let j = i;
      while (isSpace(text[j])) j++;
      if (text[j] === quote) i = j;
    }
    if (i < n && text[i] === quote) {
      const startLine = line;
      rowQuoted = true;
      const parts: string[] = [];
      let start = ++i;
      for (;;) {
        if (i >= n) fail("ParseError", `Unclosed quoted field starting on line ${startLine}.`);
        const ch = text[i];
        if (ch === escape && escape !== quote && i + 1 < n) {
          parts.push(text.slice(start, i));
          start = i + 1;
          i += 2;
          continue;
        }
        if (ch === quote) {
          if (escape === quote && text[i + 1] === quote) {
            parts.push(text.slice(start, i + 1));
            i += 2;
            start = i;
            continue;
          }
          parts.push(text.slice(start, i));
          i++;
          break;
        }
        if (ch === "\n" || (ch === "\r" && text[i + 1] !== "\n")) line++;
        i++;
      }
      value = parts.join("");
      // characters between the closing quote and the next delimiter
      let j = i;
      while (j < n && text[j] !== delimiter && text[j] !== "\n" && text[j] !== "\r") j++;
      if (j > i && trim && text.slice(i, j).trim() === "") i = j;
      if (j > i) {
        if (strict) fail("ParseError", `Unexpected characters after a closing quote on line ${line}.`);
        value += text.slice(i, j);
        i = j;
      }
    } else {
      let j = i;
      while (j < n && text[j] !== delimiter && text[j] !== "\n" && text[j] !== "\r") j++;
      value = text.slice(i, j);
      if (strict && value.includes(quote)) fail("ParseError", `Quote character inside an unquoted field on line ${line}.`);
      if (trim) value = value.trim();
      i = j;
    }
    pushField(value);
    if (i >= n) {
      endRow();
      break;
    }
    const ch = text[i];
    if (ch === delimiter) {
      i++;
      continue;
    }
    // newline
    i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
    line++;
    endRow();
    if (i >= n) break;
  }
  return records;
}

/** @internal Shared tail of the text readers: header handling and inference. */
export function finishTable(records: string[][], o: Record<string, unknown>, limits: Limits): Table {
  const header = bool(o, "header", true);
  const head = header ? records.shift() : undefined;
  if (records.length > limits.maxRows) limitError("Number of rows", limits.maxRows);
  const table = makeTable(head, records as Cell[][]);
  return applyInfer(table, o);
}

/** Reads CSV / TSV / any single-character-delimited text (RFC 4180 quoting). */
export function readCsv(input: Input, options?: CsvReadOptions): Table {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  const text = toText(input, limits, o.encoding);
  const records = parseDelimited(text, o, limits);
  if (bool(o, "strict", false)) {
    const width = records[0]?.length ?? 0;
    const bad = records.findIndex((r) => r.length !== width);
    if (bad >= 0) fail("ParseError", `Record ${bad + 1} has ${(records[bad] as string[]).length} fields; expected ${width} like the first record.`);
  }
  return finishTable(records, o, limits);
}

/** {@link readCsv} with a tab delimiter. */
export function readTsv(input: Input, options?: CsvReadOptions): Table {
  return readCsv(input, { ...opts(options), delimiter: "\t" });
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Writes CSV (RFC 4180: CRLF line endings, `""` inside quoted fields by default). */
export function writeCsv(table: Table, options?: CsvWriteOptions): string {
  checkTable(table);
  const o = opts(options);
  const delimiter = char(o, "delimiter", ",");
  const quote = char(o, "quote", '"');
  const escape = char(o, "escape", quote);
  if (delimiter === quote) fail("InvalidOption", "The delimiter and the quote character must differ.");
  const quoteAll = oneOf(o, "quoting", ["minimal", "all"], "minimal") === "all";
  const eol = oneOf(o, "lineEnding", ["\r\n", "\n"], "\r\n");
  const decimalComma = bool(o, "decimalComma", false);
  const escapeFormulas = bool(o, "escapeFormulas", false);
  const field = (cell: Cell): string => {
    let s = cellText(cell, decimalComma);
    let force = quoteAll;
    if (escapeFormulas && typeof cell === "string" && FORMULA_START.test(s)) {
      s = `'${s}`;
      force = true;
    }
    if (!force && !s.includes(delimiter) && !s.includes(quote) && !s.includes("\n") && !s.includes("\r") && !(escape !== quote && s.includes(escape))) {
      return s;
    }
    let body = escape === quote ? s.split(quote).join(quote + quote) : s.split(escape).join(escape + escape).split(quote).join(escape + quote);
    return quote + body + quote;
  };
  const lines: string[] = [];
  const width = table.columns.length;
  // A record with one empty field would be an empty line, which readers skip: quote it instead.
  const record = (fields: string[]): string => (fields.length === 1 && fields[0] === "" ? quote + quote : fields.join(delimiter));
  if (width > 0 && bool(o, "header", true)) lines.push(record(table.columns.map((c) => field(c.name))));
  if (width > 0) {
    for (const row of table.rows) {
      const out: string[] = [];
      for (let c = 0; c < width; c++) out.push(field(row[c] ?? null));
      lines.push(record(out));
    }
  }
  const text = lines.length === 0 ? "" : lines.join(eol) + eol;
  return bool(o, "bom", false) ? `\ufeff${text}` : text;
}

/** {@link writeCsv} with a tab delimiter. */
export function writeTsv(table: Table, options?: CsvWriteOptions): string {
  return writeCsv(table, { ...opts(options), delimiter: "\t" });
}
