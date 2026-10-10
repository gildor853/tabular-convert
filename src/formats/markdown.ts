import { fail } from "../errors.js";
import { bool, type Input, opts, toText } from "../input.js";
import { resolveLimits } from "../limits.js";
import { cellText, checkTable, type Table } from "../table.js";
import { finishTable, type TextReadOptions } from "./csv.js";

export type MarkdownReadOptions = TextReadOptions;

export type Alignment = "left" | "right" | "center" | "none";

export interface MarkdownWriteOptions {
  /** `"auto"` (default) right-aligns number columns; or one alignment for all columns, or one per column. */
  readonly align?: "auto" | Alignment | readonly Alignment[];
  /** Pad cells so the columns line up in plain text (by string length). Default `true`. */
  readonly pad?: boolean;
}

/** Splits a table line on unescaped pipes (leading/trailing pipe optional). */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === "\\" && i + 1 < s.length) {
      cur += ch + (s[i + 1] as string);
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "" || !s.endsWith("|")) cells.push(cur);
  return cells.map((c) => unescapeCell(c.trim()));
}

function unescapeCell(c: string): string {
  return c.replace(/\\([\\|])|<br\s*\/?>/gi, (m, esc: string | undefined) => esc ?? "\n");
}

const DELIM_CELL = /^:?-+:?$/;

/** @internal */
export function isDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

/**
 * Reads the first GitHub-flavored Markdown table in the text. `\|` and `\\`
 * are unescaped and `<br>` becomes a newline; inline Markdown is kept as is.
 */
export function readMarkdown(input: Input, options?: MarkdownReadOptions): Table {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  const lines = toText(input, limits, o.encoding).split(/\r?\n/);
  let start = -1;
  for (let i = 0; i + 1 < lines.length; i++) {
    if ((lines[i] as string).includes("|") && isDelimiterRow(lines[i + 1] as string)) {
      start = i;
      break;
    }
  }
  if (start < 0) fail("ParseError", "No Markdown table found (a header row followed by a | --- | delimiter row).");
  const header = splitRow(lines[start] as string);
  const records: string[][] = [header];
  for (let i = start + 2; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === "" || !line.includes("|")) break;
    const cells = splitRow(line).slice(0, header.length);
    while (cells.length < header.length) cells.push("");
    records.push(cells);
  }
  return finishTable(records, o, limits);
}

function escapeCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

/** Writes a GitHub-flavored Markdown table. */
export function writeMarkdown(table: Table, options?: MarkdownWriteOptions): string {
  checkTable(table);
  const o = opts(options);
  const width = table.columns.length;
  if (width === 0) return "";
  const pad = bool(o, "pad", true);
  const alignOpt = o.align ?? "auto";
  let aligns: Alignment[];
  const ALIGNS = ["left", "right", "center", "none"];
  if (alignOpt === "auto") {
    aligns = table.columns.map((_, c) => {
      let numeric = false;
      for (const row of table.rows) {
        const v = row[c] ?? null;
        if (v === null) continue;
        if (typeof v !== "number" && typeof v !== "bigint") return "none";
        numeric = true;
      }
      return numeric ? "right" : "none";
    });
  } else if (typeof alignOpt === "string" && ALIGNS.includes(alignOpt)) {
    aligns = table.columns.map(() => alignOpt as Alignment);
  } else if (Array.isArray(alignOpt) && alignOpt.length === width && alignOpt.every((a) => ALIGNS.includes(a))) {
    aligns = [...alignOpt] as Alignment[];
  } else {
    return fail("InvalidOption", `Option "align" must be "auto", an alignment, or an array of ${width} alignments.`);
  }
  const body = [table.columns.map((c) => escapeCell(c.name)), ...table.rows.map((r) => table.columns.map((_, c) => escapeCell(cellText(r[c] ?? null))))];
  const widths = table.columns.map((_, c) => (pad ? Math.max(3, ...body.map((r) => (r[c] as string).length)) : 3));
  const fit = (s: string, c: number) => {
    if (!pad) return s;
    const w = widths[c] as number;
    return aligns[c] === "right" ? s.padStart(w) : aligns[c] === "center" ? s.padStart((w + s.length) >> 1).padEnd(w) : s.padEnd(w);
  };
  const delim = aligns.map((a, c) => {
    const w = widths[c] as number;
    if (a === "left") return `:${"-".repeat(w - 1)}`;
    if (a === "right") return `${"-".repeat(w - 1)}:`;
    if (a === "center") return `:${"-".repeat(w - 2)}:`;
    return "-".repeat(w);
  });
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const out = [line((body[0] as string[]).map(fit)), line(delim), ...body.slice(1).map((r) => line(r.map(fit)))];
  return `${out.join("\n")}\n`;
}
