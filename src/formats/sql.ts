import { fail, show } from "../errors.js";
import { applyInfer, type InferOptions } from "../infer.js";
import { bool, type Input, int, oneOf, opts, toText } from "../input.js";
import { type Limits, limitError, resolveLimits } from "../limits.js";
import { type Cell, checkTable, isDateOnly, makeTable, type Table, typeOfColumn } from "../table.js";

/** SQL dialects for {@link writeSql} (and string-escape rules for {@link readSql}). */
export type SqlDialect = "postgres" | "mysql" | "sqlite" | "mssql";

export const SQL_DIALECTS: readonly SqlDialect[] = Object.freeze(["postgres", "mysql", "sqlite", "mssql"]);

export interface SqlWriteOptions {
  /** Default `"postgres"`. */
  readonly dialect?: SqlDialect;
  /** Target table name (quoted as one identifier). Default `"data"`. */
  readonly tableName?: string;
  /** Optional schema name, quoted separately (`"schema"."table"`). */
  readonly schema?: string;
  /** Emit `CREATE TABLE` with column types guessed from the cells. Default `false`. */
  readonly createTable?: boolean;
  /** Rows per `INSERT` statement. Default 500 (SQL Server allows at most 1000). */
  readonly batchSize?: number;
}

export interface SqlReadOptions {
  readonly encoding?: string;
  /** Which table's INSERTs to read when the input has several. */
  readonly table?: string;
  /**
   * Backslash escapes in strings: `"mysql"` honours them, other dialects do
   * not. Default: MySQL rules if the input uses backtick identifiers.
   */
  readonly dialect?: SqlDialect;
  readonly infer?: boolean | InferOptions;
  readonly decimalComma?: boolean;
  readonly limits?: Partial<Limits>;
}

// ---------------------------------------------------------------------------
// Writing

/** @internal Quotes an identifier for a dialect. */
export function quoteIdent(name: string, dialect: SqlDialect): string {
  if (name.includes("\0")) fail("InvalidInput", `Identifier ${show(name)} contains a NUL character.`);
  if (name === "") fail("InvalidInput", "Identifiers must not be empty.");
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  if (dialect === "mssql") return `[${name.replace(/]/g, "]]")}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

/** @internal Quotes a string literal for a dialect. */
export function quoteString(text: string, dialect: SqlDialect): string {
  if (dialect === "mysql") {
    // default sql_mode: backslash is an escape character
    return `'${text.replace(/[\\'\0\x1a]/g, (c) => (c === "\\" ? "\\\\" : c === "'" ? "''" : c === "\0" ? "\\0" : "\\Z"))}'`;
  }
  if (text.includes("\0")) fail("InvalidInput", `Strings with NUL characters cannot be written as ${dialect} literals.`);
  const body = text.replace(/'/g, "''");
  return dialect === "mssql" ? `N'${body}'` : `'${body}'`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** @internal Date literal text (UTC): `YYYY-MM-DD` or `YYYY-MM-DD HH:MM:SS[.mmm]`. */
export function sqlDateText(d: Date): string {
  const y = d.getUTCFullYear();
  if (y < 0 || y > 9999) fail("InvalidInput", `Date ${show(d)} is outside the years 0000–9999.`);
  const date = `${String(y).padStart(4, "0")}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  if (isDateOnly(d)) return date;
  const ms = d.getUTCMilliseconds();
  return `${date} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}${ms ? `.${String(ms).padStart(3, "0")}` : ""}`;
}

/** @internal SQL literal for a cell. */
export function sqlLiteral(cell: Cell, dialect: SqlDialect): string {
  if (cell === null) return "NULL";
  if (typeof cell === "string") return quoteString(cell, dialect);
  if (typeof cell === "bigint") return cell.toString();
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) fail("InvalidInput", `Cannot write the non-finite number ${cell} as SQL.`);
    return Object.is(cell, -0) ? "0" : String(cell);
  }
  if (typeof cell === "boolean") return dialect === "postgres" || dialect === "mysql" ? (cell ? "TRUE" : "FALSE") : cell ? "1" : "0";
  return quoteString(sqlDateText(cell), dialect);
}

const TYPES: Record<SqlDialect, Record<"int" | "decimal" | "float" | "bool" | "date" | "datetime" | "text", string>> = {
  postgres: { int: "BIGINT", decimal: "NUMERIC", float: "DOUBLE PRECISION", bool: "BOOLEAN", date: "DATE", datetime: "TIMESTAMP(3)", text: "TEXT" },
  mysql: { int: "BIGINT", decimal: "DECIMAL(65,0)", float: "DOUBLE", bool: "BOOLEAN", date: "DATE", datetime: "DATETIME(3)", text: "LONGTEXT" },
  sqlite: { int: "INTEGER", decimal: "NUMERIC", float: "REAL", bool: "INTEGER", date: "TEXT", datetime: "TEXT", text: "TEXT" },
  mssql: { int: "BIGINT", decimal: "DECIMAL(38,0)", float: "FLOAT", bool: "BIT", date: "DATE", datetime: "DATETIME2(3)", text: "NVARCHAR(MAX)" },
};

const INT64_MAX = 2n ** 63n - 1n;

/** @internal Column SQL type guessed from the cells. */
function columnSqlType(table: Table, c: number, dialect: SqlDialect): string {
  const t = TYPES[dialect];
  const type = typeOfColumn(table.rows, c);
  if (type === "boolean") return t.bool;
  if (type === "date") return table.rows.every((r) => !(r[c] instanceof Date) || isDateOnly(r[c] as Date)) ? t.date : t.datetime;
  if (type === "number" || type === "bigint") {
    let integer = true;
    let wide = false;
    for (const r of table.rows) {
      const v = r[c];
      if (typeof v === "number" && !Number.isInteger(v)) integer = false;
      if (typeof v === "bigint" && (v > INT64_MAX || v < -INT64_MAX - 1n)) wide = true;
    }
    if (!integer) return t.float;
    return wide ? t.decimal : t.int;
  }
  return t.text;
}

/**
 * Writes SQL: optional `CREATE TABLE` plus batched `INSERT … VALUES`
 * statements. Identifiers are quoted and strings escaped for the dialect;
 * dates are written as UTC literals. Nothing is executed.
 */
export function writeSql(table: Table, options?: SqlWriteOptions): string {
  checkTable(table);
  const o = opts(options);
  const dialect = oneOf(o, "dialect", SQL_DIALECTS, "postgres");
  const tableName = o.tableName ?? "data";
  if (typeof tableName !== "string") fail("InvalidOption", `Option "tableName" must be a string, got ${show(tableName)}.`);
  if (o.schema !== undefined && typeof o.schema !== "string") fail("InvalidOption", `Option "schema" must be a string, got ${show(o.schema)}.`);
  const batch = int(o, "batchSize", 500, 1, dialect === "mssql" ? 1000 : 100_000);
  if (table.columns.length === 0) fail("InvalidInput", "Cannot write SQL for a table without columns.");
  const target = (o.schema === undefined ? "" : `${quoteIdent(o.schema as string, dialect)}.`) + quoteIdent(tableName, dialect);
  const cols = table.columns.map((c) => quoteIdent(c.name, dialect));
  const out: string[] = [];
  if (bool(o, "createTable", false)) {
    const defs = table.columns.map((_, c) => `  ${cols[c]} ${columnSqlType(table, c, dialect)}`);
    out.push(`CREATE TABLE ${target} (\n${defs.join(",\n")}\n);\n`);
  }
  const head = `INSERT INTO ${target} (${cols.join(", ")}) VALUES\n`;
  for (let start = 0; start < table.rows.length; start += batch) {
    const rows = table.rows.slice(start, start + batch).map((r) => `  (${table.columns.map((_, c) => sqlLiteral(r[c] ?? null, dialect)).join(", ")})`);
    out.push(`${head}${rows.join(",\n")};\n`);
  }
  return out.join("");
}

// ---------------------------------------------------------------------------
// Reading

type TokKind = "word" | "ident" | "str" | "num" | "punct";
interface Tok {
  readonly k: TokKind;
  readonly v: string;
  readonly line: number;
}

const BACKSLASH: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  "0": "\0",
  b: "\b",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\x1a",
});

const NUM = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

/** @internal Linear SQL tokenizer (comments skipped). */
function tokenize(sql: string, backslash: boolean, limits: Limits): Tok[] {
  const toks: Tok[] = [];
  const n = sql.length;
  let i = 0;
  let line = 1;
  const countLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (sql.charCodeAt(k) === 10) line++;
  };
  const quoted = (close: string, escapes: boolean): string => {
    const startLine = line;
    const parts: string[] = [];
    let start = ++i;
    for (;;) {
      if (i >= n) fail("ParseError", `Unterminated quoted text starting on line ${startLine}.`);
      const ch = sql[i];
      if (escapes && ch === "\\" && i + 1 < n) {
        parts.push(sql.slice(start, i));
        const e = sql[i + 1] as string;
        parts.push(BACKSLASH[e] ?? e);
        i += 2;
        start = i;
        continue;
      }
      if (ch === close) {
        if (sql[i + 1] === close) {
          parts.push(sql.slice(start, i + 1));
          i += 2;
          start = i;
          continue;
        }
        parts.push(sql.slice(start, i));
        i++;
        break;
      }
      if (ch === "\n") line++;
      i++;
    }
    const text = parts.join("");
    if (text.length > limits.maxCellLength) limitError("Cell length", limits.maxCellLength);
    return text;
  };
  while (i < n) {
    const ch = sql[i] as string;
    if (ch === "\n") {
      line++;
      i++;
    } else if (ch === " " || ch === "\t" || ch === "\r" || ch === "\f") i++;
    else if (ch === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      i = e < 0 ? n : e;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      const end = e < 0 ? n : e + 2;
      countLines(i, end);
      i = end;
    } else if (ch === "'") {
      const l = line;
      toks.push({ k: "str", v: quoted("'", backslash), line: l });
    } else if ((ch === "N" || ch === "n" || ch === "E" || ch === "e") && sql[i + 1] === "'") {
      const l = line;
      i++;
      toks.push({ k: "str", v: quoted("'", backslash || ch === "E" || ch === "e"), line: l });
    } else if ((ch === "X" || ch === "x" || ch === "B" || ch === "b") && sql[i + 1] === "'") {
      fail("UnsupportedFormat", `Hex and bit string literals are not supported (line ${line}).`);
    } else if (ch === '"') {
      toks.push({ k: "ident", v: quoted('"', false), line });
    } else if (ch === "`") {
      toks.push({ k: "ident", v: quoted("`", false), line });
    } else if (ch === "[") {
      toks.push({ k: "ident", v: quoted("]", false), line });
    } else if (ch === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i, i + 64))) {
      const tag = (/^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64)) as RegExpExecArray)[0];
      const e = sql.indexOf(tag, i + tag.length);
      if (e < 0) fail("ParseError", `Unterminated dollar-quoted string on line ${line}.`);
      const l = line;
      countLines(i, e);
      toks.push({ k: "str", v: sql.slice(i + tag.length, e), line: l });
      i = e + tag.length;
    } else if (/[0-9.]/.test(ch) && ((NUM.lastIndex = i), NUM.test(sql))) {
      toks.push({ k: "num", v: sql.slice(i, NUM.lastIndex), line });
      i = NUM.lastIndex;
    } else if (/[A-Za-z_\u0080-\uffff]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[j] as string)) j++;
      toks.push({ k: "word", v: sql.slice(i, j), line });
      i = j;
    } else {
      toks.push({ k: "punct", v: ch, line });
      i++;
    }
  }
  return toks;
}

interface InsertBlock {
  readonly table: string;
  readonly columns: string[] | undefined;
  readonly rows: Cell[][];
}

const INSERT_MODIFIERS = new Set(["LOW_PRIORITY", "DELAYED", "HIGH_PRIORITY", "IGNORE", "OR", "REPLACE", "ROLLBACK", "ABORT", "FAIL"]);
const CONSTRAINT_WORDS = new Set(["CONSTRAINT", "PRIMARY", "UNIQUE", "FOREIGN", "CHECK", "KEY", "INDEX", "FULLTEXT", "SPATIAL", "EXCLUDE", "PERIOD"]);

/**
 * Reads the rows of `INSERT INTO t (cols) VALUES (…), (…)` statements. Only
 * literal values are supported (strings, numbers, `TRUE`/`FALSE`, `NULL`);
 * other statements are skipped, and column names are taken from the
 * `INSERT` column list or a preceding `CREATE TABLE`. Nothing is executed.
 */
export function readSql(input: Input, options?: SqlReadOptions): Table {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  const sql = toText(input, limits, o.encoding);
  const dialect = o.dialect === undefined ? undefined : oneOf(o, "dialect", SQL_DIALECTS, "postgres");
  if (o.table !== undefined && typeof o.table !== "string") fail("InvalidOption", `Option "table" must be a string, got ${show(o.table)}.`);
  const backslash = dialect === undefined ? sql.includes("`") : dialect === "mysql";
  const toks = tokenize(sql, backslash, limits);
  const created = new Map<string, string[]>();
  const blocks: InsertBlock[] = [];
  let rowCount = 0;
  let p = 0;
  const peek = () => toks[p];
  const isWord = (t: Tok | undefined, w: string) => t !== undefined && t.k === "word" && t.v.toUpperCase() === w;
  const isPunct = (t: Tok | undefined, c: string) => t !== undefined && t.k === "punct" && t.v === c;
  const where = () => `line ${(toks[p] ?? toks[toks.length - 1])?.line ?? 1}`;
  const skipStatement = () => {
    while (p < toks.length && !isPunct(toks[p], ";")) p++;
    p++;
  };
  const name = (): string => {
    let last = "";
    for (;;) {
      const t = peek();
      if (!t || (t.k !== "word" && t.k !== "ident")) fail("ParseError", `Expected a table name at ${where()}.`);
      last = t.v;
      p++;
      if (!isPunct(peek(), ".")) return last;
      p++;
    }
  };
  const identList = (): string[] => {
    const out: string[] = [];
    p++; // (
    for (;;) {
      const t = peek();
      if (!t || (t.k !== "word" && t.k !== "ident")) fail("ParseError", `Expected a column name at ${where()}.`);
      out.push(t.v);
      p++;
      if (isPunct(peek(), ",")) p++;
      else if (isPunct(peek(), ")")) {
        p++;
        return out;
      } else fail("ParseError", `Expected "," or ")" in the column list at ${where()}.`);
    }
  };
  const value = (): Cell => {
    let t = peek();
    let sign = "";
    if (isPunct(t, "-") || isPunct(t, "+")) {
      sign = (t as Tok).v === "-" ? "-" : "";
      p++;
      t = peek();
      if (!t || t.k !== "num") fail("ParseError", `Expected a number after a sign at ${where()}.`);
    }
    if (!t) return fail("ParseError", "Unexpected end of input inside VALUES.");
    p++;
    if (t.k === "str") return t.v;
    if (t.k === "num") {
      const text = sign + t.v;
      if (/^-?\d+$/.test(text)) {
        const num = Number(text);
        return Number.isSafeInteger(num) ? num : BigInt(text);
      }
      const num = Number(text);
      return Number.isFinite(num) ? num : fail("ParseError", `Number ${show(text)} is out of range (${where()}).`);
    }
    if (t.k === "word") {
      const w = t.v.toUpperCase();
      // MySQL character set introducers: _utf8mb4'text', _binary 'bytes'
      if (w.startsWith("_") && peek()?.k === "str") return (toks[p++] as Tok).v;
      if (w === "NULL" || w === "DEFAULT") return null;
      if (w === "TRUE") return true;
      if (w === "FALSE") return false;
    }
    p--;
    return fail("UnsupportedFormat", `Only literal values are supported in VALUES, found ${show(t.v)} at ${where()}.`);
  };
  const createTable = () => {
    p++; // TABLE
    while (isWord(peek(), "IF") || isWord(peek(), "NOT") || isWord(peek(), "EXISTS")) p++;
    const table = name();
    if (!isPunct(peek(), "(")) return skipStatement();
    p++;
    const cols: string[] = [];
    let depth = 0;
    let atStart = true;
    while (p < toks.length) {
      const t = toks[p] as Tok;
      if (depth === 0 && atStart) {
        if ((t.k === "word" && !CONSTRAINT_WORDS.has(t.v.toUpperCase())) || t.k === "ident") cols.push(t.v);
        atStart = false;
      }
      p++;
      if (t.k !== "punct") continue;
      if (t.v === "(") depth++;
      else if (t.v === ")") {
        if (depth === 0) break;
        depth--;
      } else if (t.v === "," && depth === 0) atStart = true;
    }
    created.set(table.toLowerCase(), cols);
    skipStatement();
  };
  const insert = () => {
    while (p < toks.length && toks[p]?.k === "word" && INSERT_MODIFIERS.has((toks[p] as Tok).v.toUpperCase())) p++;
    if (isWord(peek(), "INTO")) p++;
    const table = name();
    const columns = isPunct(peek(), "(") ? identList() : undefined;
    if (!isWord(peek(), "VALUES") && !isWord(peek(), "VALUE")) {
      fail("UnsupportedFormat", `Only INSERT … VALUES statements are supported (${where()}).`);
    }
    p++;
    const rows: Cell[][] = [];
    for (;;) {
      if (!isPunct(peek(), "(")) fail("ParseError", `Expected "(" to start a row at ${where()}.`);
      p++;
      const row: Cell[] = [];
      if (!isPunct(peek(), ")")) {
        for (;;) {
          row.push(value());
          if (row.length > limits.maxColumns) limitError("Number of columns", limits.maxColumns);
          if (isPunct(peek(), ",")) p++;
          else if (isPunct(peek(), ")")) break;
          else fail("ParseError", `Expected "," or ")" in a row at ${where()}.`);
        }
      }
      p++; // )
      if (columns && row.length !== columns.length) fail("ParseError", `Row has ${row.length} values but the column list has ${columns.length} (${where()}).`);
      rows.push(row);
      if (++rowCount > limits.maxRows) limitError("Number of rows", limits.maxRows);
      if (isPunct(peek(), ",")) p++;
      else break;
    }
    blocks.push({ table, columns, rows });
    skipStatement(); // ON CONFLICT / RETURNING / … up to ";"
  };
  while (p < toks.length) {
    const t = toks[p] as Tok;
    if (isWord(t, "INSERT")) {
      p++;
      insert();
    } else if (isWord(t, "CREATE") && isWord(toks[p + 1], "TABLE")) {
      p++;
      createTable();
    } else if (isWord(t, "CREATE") && (isWord(toks[p + 1], "TEMPORARY") || isWord(toks[p + 1], "TEMP")) && isWord(toks[p + 2], "TABLE")) {
      p += 2;
      createTable();
    } else skipStatement();
  }
  if (blocks.length === 0) fail("ParseError", "No INSERT … VALUES statements found.");
  const tables = [...new Set(blocks.map((b) => b.table))];
  let chosen: string;
  if (o.table !== undefined) {
    const want = (o.table as string).toLowerCase();
    const match = tables.find((t) => t.toLowerCase() === want);
    if (match === undefined) fail("InvalidOption", `No INSERTs for table ${show(o.table)}; found ${tables.map((t) => show(t)).join(", ")}.`);
    chosen = match;
  } else if (tables.length > 1) {
    return fail("InvalidOption", `The input has INSERTs for several tables (${tables.map((t) => show(t)).join(", ")}); choose one with the "table" option.`);
  } else chosen = tables[0] as string;
  const mine = blocks.filter((b) => b.table === chosen);
  // union of column names in first-seen order
  const index = new Map<string, number>();
  const fallback = created.get(chosen.toLowerCase());
  const blockCols = mine.map((b) => {
    const cols = b.columns ?? (fallback && b.rows.every((r) => r.length === fallback.length) ? fallback : undefined);
    if (cols) for (const c of cols) if (!index.has(c)) index.set(c, index.size);
    return cols;
  });
  const anyNamed = index.size > 0;
  if (anyNamed && blockCols.some((c) => c === undefined)) fail("ParseError", `Some INSERTs into ${show(chosen)} have a column list and some do not.`);
  if (index.size > limits.maxColumns) limitError("Number of columns", limits.maxColumns);
  let table: Table;
  if (anyNamed) {
    const width = index.size;
    const rows: Cell[][] = [];
    mine.forEach((b, k) => {
      const map = (blockCols[k] as string[]).map((c) => index.get(c) as number);
      for (const r of b.rows) {
        const out: Cell[] = new Array<Cell>(width).fill(null);
        r.forEach((v, c) => {
          out[map[c] as number] = v;
        });
        rows.push(out);
      }
    });
    table = makeTable([...index.keys()], rows);
  } else {
    table = makeTable(undefined, mine.flatMap((b) => b.rows));
  }
  return applyInfer(table, o);
}
