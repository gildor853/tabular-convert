import { fail, show } from "./errors.js";
import { DEFAULT_LIMITS } from "./limits.js";
import { fromUtf8 } from "./platform.js";
import { detectDelimiter } from "./formats/csv.js";
import { parseJson } from "./formats/json-text.js";
import { isDelimiterRow } from "./formats/markdown.js";
import { looksLikeCfb } from "./xlsx/xls.js";
import { looksLikeZip } from "./xlsx/zip.js";

/** Supported format names. */
export type Format = "csv" | "tsv" | "json" | "ndjson" | "xlsx" | "xls" | "sql" | "markdown" | "html";

/** Formats whose writers produce text (everything except `xlsx`). */
export type TextFormat = Exclude<Format, "xlsx" | "xls">;

/** All format names. */
export const FORMATS: readonly Format[] = Object.freeze(["csv", "tsv", "json", "ndjson", "xlsx", "xls", "sql", "markdown", "html"]);

/** Formats that can be written (`xls` is read-only). */
export const WRITABLE_FORMATS: readonly Format[] = Object.freeze(["csv", "tsv", "json", "ndjson", "xlsx", "sql", "markdown", "html"]);

/** `true` when `value` is a supported format name. Never throws. */
export function isFormat(value: unknown): value is Format {
  return typeof value === "string" && (FORMATS as readonly string[]).includes(value);
}

const EXTENSIONS: Readonly<Record<string, Format>> = Object.assign(Object.create(null) as Record<string, Format>, {
  csv: "csv",
  dsv: "csv",
  psv: "csv",
  tsv: "tsv",
  tab: "tsv",
  json: "json",
  ndjson: "ndjson",
  jsonl: "ndjson",
  xlsx: "xlsx",
  xlsm: "xlsx",
  xls: "xls",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
});

/** Format implied by a file name's extension, or `undefined`. Never throws. */
export function formatFromFilename(filename: unknown): Format | undefined {
  if (typeof filename !== "string") return undefined;
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(filename);
  return m ? EXTENSIONS[(m[1] as string).toLowerCase()] : undefined;
}

/** @internal Format from content: binary signatures first, then text heuristics. */
export function formatFromContent(input: unknown): Format {
  let text: string;
  if (typeof input === "string") text = input.slice(0, 65_536);
  else if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (looksLikeZip(bytes)) return "xlsx";
    if (looksLikeCfb(bytes)) return "xls";
    text = fromUtf8(bytes.subarray(0, 65_536));
  } else {
    return fail("InvalidInput", `Expected a string, Uint8Array or ArrayBuffer, got ${show(input)}.`);
  }
  text = text.replace(/^\ufeff/, "");
  const trimmed = text.trimStart();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const lines = trimmed.split("\n").filter((l) => l.trim() !== "");
    try {
      const first = parseJson(lines[0] as string, DEFAULT_LIMITS);
      // Several values one per line, or a single object that is not a {columns, rows} document.
      if (lines.length > 1 ? typeof first === "object" && first !== null : first instanceof Map && !(first.has("columns") && first.has("rows"))) return "ndjson";
    } catch {
      // not a complete value on its own line: a multi-line JSON document
    }
    return "json";
  }
  if (trimmed.startsWith("<") && /<table[\s>]/i.test(text)) return "html";
  const lines = text.split(/\r?\n/);
  const firstCode = lines.find((l) => l.trim() !== "" && !l.trimStart().startsWith("--"));
  if (firstCode !== undefined && /^\s*(?:INSERT|CREATE|DROP|BEGIN|SET|USE|START|PRAGMA)\b/i.test(firstCode)) return "sql";
  for (let i = 0; i + 1 < lines.length && i < 200; i++) {
    if ((lines[i] as string).includes("|") && isDelimiterRow(lines[i + 1] as string)) return "markdown";
  }
  if (trimmed.startsWith("<") && /<html[\s>]/i.test(text)) return "html";
  return detectDelimiter(text) === "\t" ? "tsv" : "csv";
}

/**
 * Detects the format of an input: from the file name's extension when given,
 * otherwise from the content (ZIP → xlsx, compound file → xls, JSON / NDJSON,
 * HTML table, SQL, Markdown table, else CSV or TSV).
 */
export function detectFormat(input: unknown, filename?: string): Format {
  return formatFromFilename(filename) ?? formatFromContent(input);
}
