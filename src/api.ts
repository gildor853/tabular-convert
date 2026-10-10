import { attemptAsync, attempt, fail, type Result, show } from "./errors.js";
import { detectFormat, type Format, FORMATS, isFormat, type TextFormat } from "./detect.js";
import { opts } from "./input.js";
import type { Table } from "./table.js";
import { type CsvReadOptions, type CsvWriteOptions, readCsv, readTsv, writeCsv, writeTsv } from "./formats/csv.js";
import { type HtmlWriteOptions, readHtml, writeHtml } from "./formats/html.js";
import { type JsonReadOptions, type JsonWriteOptions, readJson, readNdjson, writeJson, writeNdjson } from "./formats/json.js";
import { type MarkdownWriteOptions, readMarkdown, writeMarkdown } from "./formats/markdown.js";
import { readSql, type SqlReadOptions, type SqlWriteOptions, writeSql } from "./formats/sql.js";
import { listSheetsImpl, readXlsxImpl, type XlsxReadOptions } from "./xlsx/read.js";
import { type XlsxSheet, type XlsxWriteOptions, writeXlsxImpl } from "./xlsx/write.js";
import { listXlsSheetsImpl, looksLikeCfb, readXlsImpl, type XlsReadOptions } from "./xlsx/xls.js";
import type { Input } from "./input.js";

/** Options accepted by {@link read}: the format-specific reader options, merged. */
export type ReaderOptions = CsvReadOptions & JsonReadOptions & SqlReadOptions & XlsxReadOptions;

/** Options accepted by {@link write}: the format-specific writer options, merged. */
export type WriterOptions = CsvWriteOptions & JsonWriteOptions & SqlWriteOptions & MarkdownWriteOptions & HtmlWriteOptions & XlsxWriteOptions;

export interface ReadOptions extends ReaderOptions {
  /** Input format. Default: detected from `filename`, then from the content. */
  readonly format?: Format;
  /** File name used for format detection by extension. */
  readonly filename?: string;
}

export interface ConvertOptions<To extends Format = Format> {
  /** Input format. Default: detected from `filename`, then from the content. */
  readonly from?: Format;
  /** Output format. */
  readonly to: To;
  /** Input file name, used for format detection by extension. */
  readonly filename?: string;
  /** Options for the reader. */
  readonly read?: ReaderOptions;
  /** Options for the writer. */
  readonly write?: WriterOptions;
}

/** Output of a writer: bytes for `xlsx`, text otherwise. */
export type Output<F extends Format> = F extends "xlsx" ? Uint8Array : string;

/** Reads an XLSX workbook sheet (asynchronous because decompression uses the platform's streams). */
export function readXlsx(input: Input, options?: XlsxReadOptions): Promise<Table> {
  return readXlsxImpl(input, options);
}

/** Writes an XLSX workbook from one table or several `{ name, table }` sheets. */
export function writeXlsx(input: Table | readonly XlsxSheet[], options?: XlsxWriteOptions): Promise<Uint8Array> {
  return writeXlsxImpl(input, options);
}

/** Reads a legacy Excel 97–2003 (.xls, BIFF8) worksheet. Read-only; synchronous. */
export function readXls(input: Input, options?: XlsReadOptions): Table {
  return readXlsImpl(input, options);
}

/** Sheet names of an XLSX or XLS workbook, in workbook order. */
export async function listSheets(input: Input, options?: { readonly limits?: XlsxReadOptions["limits"] }): Promise<string[]> {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (bytes instanceof Uint8Array && looksLikeCfb(bytes)) return listXlsSheetsImpl(bytes, options);
  return listSheetsImpl(input, options);
}

function formatOf(value: unknown, name: string): Format {
  if (!isFormat(value)) fail("UnsupportedFormat", `Unknown ${name} format ${show(value)}; supported: ${FORMATS.join(", ")}.`);
  return value as Format;
}

function readerFor(format: Format): ((input: Input, options: unknown) => Table) | undefined {
  switch (format) {
    case "csv":
      return readCsv as (input: Input, options: unknown) => Table;
    case "tsv":
      return readTsv as (input: Input, options: unknown) => Table;
    case "json":
      return readJson as (input: Input, options: unknown) => Table;
    case "ndjson":
      return readNdjson as (input: Input, options: unknown) => Table;
    case "sql":
      return readSql as (input: Input, options: unknown) => Table;
    case "markdown":
      return readMarkdown as (input: Input, options: unknown) => Table;
    case "html":
      return readHtml as (input: Input, options: unknown) => Table;
    case "xls":
      return readXlsImpl;
    default:
      return undefined;
  }
}

function writerFor(format: Format): ((table: Table, options: unknown) => string) | undefined {
  switch (format) {
    case "csv":
      return writeCsv as (table: Table, options: unknown) => string;
    case "tsv":
      return writeTsv as (table: Table, options: unknown) => string;
    case "json":
      return writeJson as (table: Table, options: unknown) => string;
    case "ndjson":
      return writeNdjson as (table: Table, options: unknown) => string;
    case "sql":
      return writeSql as (table: Table, options: unknown) => string;
    case "markdown":
      return writeMarkdown as (table: Table, options: unknown) => string;
    case "html":
      return writeHtml as (table: Table, options: unknown) => string;
    default:
      return undefined;
  }
}

function readParts(options: unknown): { format: Format | undefined; filename: string | undefined; rest: Record<string, unknown> } {
  const { format, filename, ...rest } = opts(options);
  if (filename !== undefined && typeof filename !== "string") fail("InvalidOption", `Option "filename" must be a string, got ${show(filename)}.`);
  return { format: format === undefined ? undefined : formatOf(format, "input"), filename: filename as string | undefined, rest };
}

/** Reads any supported format into a table; the format is detected unless given. */
export async function read(input: Input, options?: ReadOptions): Promise<Table> {
  const p = readParts(options);
  const f = p.format ?? detectFormat(input, p.filename);
  if (f === "xlsx") return readXlsxImpl(input, p.rest);
  return (readerFor(f) as (input: Input, options: unknown) => Table)(input, p.rest);
}

/** Synchronous {@link read} for every format except `xlsx`. */
export function readSync(input: Input, options?: ReadOptions): Table {
  const p = readParts(options);
  const reader = readerFor(p.format ?? detectFormat(input, p.filename));
  if (!reader) return fail("UnsupportedFormat", "Reading XLSX is asynchronous; use read() or readXlsx().");
  return reader(input, p.rest);
}

/** Writes a table in any writable format (`xlsx` gives bytes, the others text). */
export async function write<F extends Format>(table: Table, format: F, options?: WriterOptions): Promise<Output<F>> {
  const f = formatOf(format, "output");
  if (f === "xlsx") return (await writeXlsxImpl(table, options)) as Output<F>;
  return writeSync(table, f as TextFormat, options) as Output<F>;
}

/** Synchronous {@link write} for the text formats. */
export function writeSync(table: Table, format: TextFormat, options?: WriterOptions): string {
  const f = formatOf(format, "output");
  if (f === "xls") fail("UnsupportedFormat", "XLS is read-only; write XLSX instead.");
  const writer = writerFor(f);
  if (!writer) return fail("UnsupportedFormat", "Writing XLSX is asynchronous; use write() or writeXlsx().");
  return writer(table, options);
}

function convertParts(options: unknown): { from: Format | undefined; to: Format; filename: string | undefined; read: unknown; write: unknown } {
  const o = opts(options);
  if (o.to === undefined) fail("InvalidOption", 'Option "to" (the output format) is required.');
  const to = formatOf(o.to, "output");
  const from = o.from === undefined ? undefined : formatOf(o.from, "input");
  if (o.filename !== undefined && typeof o.filename !== "string") fail("InvalidOption", `Option "filename" must be a string, got ${show(o.filename)}.`);
  return { from, to, filename: o.filename as string | undefined, read: opts(o.read), write: opts(o.write) };
}

/** Converts between formats: `convert(csvText, { to: "xlsx" })`. */
export async function convert<To extends Format>(input: Input, options: ConvertOptions<To>): Promise<Output<To>> {
  const p = convertParts(options);
  if (p.to === "xls") fail("UnsupportedFormat", "XLS is read-only; write XLSX instead.");
  const table = await read(input, { ...(p.read as ReaderOptions), ...(p.from ? { format: p.from } : {}), ...(p.filename !== undefined ? { filename: p.filename } : {}) });
  return write(table, p.to as To, p.write as WriterOptions);
}

/** Synchronous {@link convert} between the formats that do not involve XLSX. */
export function convertSync(input: Input, options: ConvertOptions<TextFormat>): string {
  const p = convertParts(options);
  const table = readSync(input, { ...(p.read as ReaderOptions), ...(p.from ? { format: p.from } : {}), ...(p.filename !== undefined ? { filename: p.filename } : {}) });
  return writeSync(table, p.to as TextFormat, p.write as WriterOptions);
}

/** {@link read} that returns a `Result` instead of throwing a `TabularError`. */
export function tryRead(input: Input, options?: ReadOptions): Promise<Result<Table>> {
  return attemptAsync(() => read(input, options));
}

/** {@link convert} that returns a `Result` instead of throwing a `TabularError`. */
export function tryConvert<To extends Format>(input: Input, options: ConvertOptions<To>): Promise<Result<Output<To>>> {
  return attemptAsync(() => convert(input, options));
}

/** {@link convertSync} that returns a `Result` instead of throwing a `TabularError`. */
export function tryConvertSync(input: Input, options: ConvertOptions<TextFormat>): Result<string> {
  return attempt(() => convertSync(input, options));
}
