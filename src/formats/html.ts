import { fail } from "../errors.js";
import { bool, type Input, opts, toText } from "../input.js";
import { limitError, resolveLimits } from "../limits.js";
import { cellText, checkTable, type Table } from "../table.js";
import { finishTable, type TextReadOptions } from "./csv.js";

export type HtmlReadOptions = TextReadOptions;

export interface HtmlWriteOptions {
  /** Write the header row in `<thead>`. Default `true`. */
  readonly header?: boolean;
  /** Optional `<caption>` text. */
  readonly caption?: string;
}

const NAMED: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "\u00a9",
  reg: "\u00ae",
  euro: "\u20ac",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  laquo: "\u00ab",
  raquo: "\u00bb",
  bdquo: "\u201e",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  sbquo: "\u201a",
  deg: "\u00b0",
  times: "\u00d7",
  shy: "\u00ad",
});

/** @internal Decodes HTML character references (named subset + numeric); unknown names stay literal. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (m, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name] ?? m;
    const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex as string, 16);
    return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? "\ufffd" : String.fromCodePoint(cp);
  });
}

const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

/**
 * Reads the first `<table>` of an HTML document with a small, linear tag
 * scanner (no DOM). `<th>`/`<td>` text is extracted with tags stripped,
 * whitespace collapsed and `<br>` turned into a newline. `colspan` / `rowspan`
 * are ignored and nested tables are rejected.
 */
export function readHtml(input: Input, options?: HtmlReadOptions): Table {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  const html = toText(input, limits, o.encoding);
  const n = html.length;
  const records: string[][] = [];
  let i = 0;
  let inTable = false;
  let done = false;
  let row: string[] | null = null;
  let cell: string[] | null = null; // text pieces; "\n" pieces come from <br>
  const closeCell = () => {
    if (cell && row) {
      const text = cell
        .join("")
        .split("\n")
        .map((part) => decodeEntities(part.replace(/[ \t\r\n\f]+/g, " ").trim()))
        .join("\n");
      if (text.length > limits.maxCellLength) limitError("Cell length", limits.maxCellLength);
      row.push(text);
      if (row.length > limits.maxColumns) limitError("Number of columns", limits.maxColumns);
    }
    cell = null;
  };
  const closeRow = () => {
    closeCell();
    if (row) {
      records.push(row);
      if (records.length > limits.maxRows + 1) limitError("Number of rows", limits.maxRows);
    }
    row = null;
  };
  while (i < n && !done) {
    const lt = html.indexOf("<", i);
    const textEnd = lt < 0 ? n : lt;
    if (cell && textEnd > i) (cell as string[]).push(html.slice(i, textEnd).replace(/\n/g, " "));
    if (lt < 0) break;
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (html[i + 1] === "!" || html[i + 1] === "?") {
      const end = html.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/.exec(html.slice(i, i + 64));
    if (!m) {
      if (cell) (cell as string[]).push("<");
      i++;
      continue;
    }
    // find the end of the tag, skipping quoted attribute values
    let j = i + m[0].length;
    let q = "";
    while (j < n) {
      const ch = html[j];
      if (q) {
        if (ch === q) q = "";
      } else if (ch === '"' || ch === "'") q = ch;
      else if (ch === ">") break;
      j++;
    }
    const closing = m[1] === "/";
    const name = (m[2] as string).toLowerCase();
    i = j + 1;
    if (!closing && RAW_TEXT.has(name)) {
      const re = new RegExp(`</${name}`, "gi");
      re.lastIndex = i;
      const end = re.exec(html);
      i = end ? end.index : n;
      continue;
    }
    if (name === "table") {
      if (closing) {
        if (inTable) {
          closeRow();
          done = true;
        }
      } else if (inTable) {
        fail("ParseError", "Nested <table> elements are not supported.");
      } else inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (name === "tr") {
      closeRow();
      if (!closing) row = [];
    } else if (name === "td" || name === "th") {
      closeCell();
      if (!closing) {
        if (!row) row = [];
        cell = [];
      }
    } else if (name === "br" && cell) {
      (cell as string[]).push("\n");
    } else if (name === "thead" || name === "tbody" || name === "tfoot") {
      closeRow();
    }
  }
  if (!inTable) fail("ParseError", "No <table> found in the HTML input.");
  closeRow();
  return finishTable(records, o, limits);
}

/** @internal Escapes text for HTML element content and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"));
}

const cellHtml = (text: string) => escapeHtml(text).replace(/\r\n|\r|\n/g, "<br>");

/** Writes an HTML `<table>` (escaped; newlines become `<br>`). */
export function writeHtml(table: Table, options?: HtmlWriteOptions): string {
  checkTable(table);
  const o = opts(options);
  const caption = o.caption;
  if (caption !== undefined && typeof caption !== "string") fail("InvalidOption", 'Option "caption" must be a string.');
  const out = ["<table>"];
  if (caption) out.push(`  <caption>${cellHtml(caption)}</caption>`);
  if (bool(o, "header", true)) {
    out.push("  <thead>", `    <tr>${table.columns.map((c) => `<th>${cellHtml(c.name)}</th>`).join("")}</tr>`, "  </thead>");
  }
  out.push("  <tbody>");
  for (const row of table.rows) out.push(`    <tr>${table.columns.map((_, c) => `<td>${cellHtml(cellText(row[c] ?? null))}</td>`).join("")}</tr>`);
  out.push("  </tbody>", "</table>");
  return `${out.join("\n")}\n`;
}
