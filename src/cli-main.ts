/** Command-line front end (`tabular-convert in.csv out.xlsx`), independent of Node.js I/O for testing. */
import { convert, listSheets, type ReaderOptions, type WriterOptions } from "./api.js";
import { detectFormat, type Format, FORMATS, formatFromFilename, isFormat } from "./detect.js";
import { isTabularError } from "./errors.js";
import { SQL_DIALECTS } from "./formats/sql.js";

/** @internal I/O used by the CLI. */
export interface CliIo {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  readStdin(): Promise<Uint8Array>;
  stdout(data: Uint8Array | string): Promise<void>;
  stderr(text: string): void;
}

declare const __VERSION__: string | undefined;

export const USAGE = `Usage: tabular-convert <input> [output] [options]

Converts tabular data between CSV, TSV, JSON, NDJSON, XLSX, XLS (read-only),
SQL, Markdown and HTML. Use "-" for stdin / stdout; without an output file the
result goes to stdout. Formats are detected from file extensions, then content.

Options:
  --from <format>          input format (${FORMATS.join(", ")})
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
  --dialect <d>            SQL dialect: ${SQL_DIALECTS.join(", ")} (default postgres)
  --table-name <name>      SQL table to write (default "data") or to read
  --create-table           emit CREATE TABLE before the INSERTs
  --sheet-name <name>      XLSX sheet name (default "Sheet1")
  --max-input-bytes <n>    input size limit (default 268435456)
  -h, --help               show this help
  -v, --version            show the version

Exit codes: 0 success, 1 conversion or I/O error, 2 usage error.`;

class UsageError extends Error {}

const DELIMITERS: ReadonlyMap<string, string> = new Map([
  ["comma", ","],
  ["semicolon", ";"],
  ["tab", "\t"],
  ["pipe", "|"],
  ["\\t", "\t"],
]);

function delimiter(value: string): string {
  const d = DELIMITERS.get(value.toLowerCase()) ?? value;
  if (d.length !== 1) throw new UsageError(`Invalid delimiter "${value}": use a single character or comma, semicolon, tab, pipe.`);
  return d;
}

function format(value: string, flag: string): Format {
  const f = value.toLowerCase() === "md" ? "markdown" : value.toLowerCase() === "jsonl" ? "ndjson" : value.toLowerCase();
  if (!isFormat(f)) throw new UsageError(`Unknown format for ${flag}: "${value}". Supported: ${FORMATS.join(", ")}.`);
  return f;
}

interface Parsed {
  input?: string;
  output?: string;
  from?: Format;
  to?: Format;
  sheet?: string;
  read: Record<string, unknown>;
  write: Record<string, unknown>;
  help: boolean;
  version: boolean;
}

const VALUE_FLAGS = new Set(["--from", "--to", "--sheet", "--delimiter", "--out-delimiter", "--encoding", "--json-shape", "--dialect", "--table-name", "--sheet-name", "--max-input-bytes"]);

/** @internal */
export function parseArgs(argv: readonly string[]): Parsed {
  const p: Parsed = { read: {}, write: {}, help: false, version: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i] as string;
    let value: string | undefined;
    if (arg.startsWith("--") && arg.includes("=")) {
      value = arg.slice(arg.indexOf("=") + 1);
      arg = arg.slice(0, arg.indexOf("="));
    }
    if (VALUE_FLAGS.has(arg) && value === undefined) {
      value = argv[++i];
      if (value === undefined) throw new UsageError(`Missing value for ${arg}.`);
    }
    switch (arg) {
      case "-h":
      case "--help":
        p.help = true;
        break;
      case "-v":
      case "--version":
        p.version = true;
        break;
      case "--from":
        p.from = format(value as string, arg);
        break;
      case "--to":
        p.to = format(value as string, arg);
        break;
      case "--sheet":
        p.sheet = value as string;
        break;
      case "--delimiter":
        p.read.delimiter = delimiter(value as string);
        break;
      case "--out-delimiter":
        p.write.delimiter = delimiter(value as string);
        break;
      case "--no-header":
        p.read.header = false;
        break;
      case "--infer":
        p.read.infer = true;
        break;
      case "--decimal-comma":
        p.read.decimalComma = true;
        break;
      case "--out-decimal-comma":
        p.write.decimalComma = true;
        break;
      case "--encoding":
        p.read.encoding = value;
        break;
      case "--escape-formulas":
        p.write.escapeFormulas = true;
        break;
      case "--json-shape":
        if (!["objects", "arrays", "columns"].includes(value as string)) throw new UsageError(`Invalid --json-shape "${value}": use objects, arrays or columns.`);
        p.write.shape = value;
        break;
      case "--unflatten":
        p.write.unflatten = true;
        break;
      case "--dialect":
        if (!(SQL_DIALECTS as readonly string[]).includes(value as string)) throw new UsageError(`Invalid --dialect "${value}": use ${SQL_DIALECTS.join(", ")}.`);
        p.write.dialect = value;
        break;
      case "--table-name":
        p.write.tableName = value;
        p.read.table = value;
        break;
      case "--create-table":
        p.write.createTable = true;
        break;
      case "--sheet-name":
        p.write.sheetName = value;
        break;
      case "--max-input-bytes": {
        const n = Number(value);
        if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError(`Invalid --max-input-bytes "${value}": use a positive integer.`);
        p.read.limits = { maxInputBytes: n };
        break;
      }
      default:
        if (arg.startsWith("-") && arg !== "-") throw new UsageError(`Unknown option ${arg}. See --help.`);
        positional.push(arg);
    }
  }
  if (positional.length > 2) throw new UsageError(`Too many arguments: ${positional.slice(2).join(" ")}.`);
  if (positional[0] !== undefined) p.input = positional[0];
  if (positional[1] !== undefined) p.output = positional[1];
  return p;
}

/** @internal Runs the CLI; resolves to the exit code. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
    if (p.help) {
      await io.stdout(`${USAGE}\n`);
      return 0;
    }
    if (p.version) {
      await io.stdout(`${typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev"}\n`);
      return 0;
    }
    if (p.input === undefined) throw new UsageError("Missing input file (use - for stdin).");
    const toStdout = p.output === undefined || p.output === "-";
    const to = p.to ?? (toStdout ? undefined : formatFromFilename(p.output));
    if (to === undefined) throw new UsageError(toStdout ? "Writing to stdout needs --to <format>." : `Cannot tell the output format from "${p.output}"; use --to.`);
    if (to === "xls") throw new UsageError("XLS is read-only; write xlsx instead.");
    p.to = to;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`tabular-convert: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  try {
    const data = p.input === "-" ? await io.readStdin() : await io.readFile(p.input);
    const from = p.from ?? detectFormat(data, p.input === "-" ? undefined : p.input);
    if (p.sheet !== undefined) {
      if (from !== "xlsx" && from !== "xls") throw new UsageError("--sheet only applies to xlsx and xls input.");
      let sheet: string | number = p.sheet;
      if (/^\d+$/.test(p.sheet)) {
        const names = await listSheets(data, p.read as ReaderOptions);
        if (!names.includes(p.sheet)) sheet = Number(p.sheet);
      }
      p.read.sheet = sheet;
    }
    const out = await convert(data, { from, to: p.to as Format, read: p.read as ReaderOptions, write: p.write as WriterOptions });
    if (p.output === undefined || p.output === "-") await io.stdout(out);
    else await io.writeFile(p.output, out);
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr(`tabular-convert: ${err.message}\n`);
      return 2;
    }
    if (isTabularError(err)) {
      io.stderr(`tabular-convert: ${err.message} [${err.code}]\n`);
      return 1;
    }
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e?.code === "string" && /^E[A-Z]+$/.test(e.code)) {
      io.stderr(`tabular-convert: ${String(e.message)}\n`);
      return 1;
    }
    throw err;
  }
}
