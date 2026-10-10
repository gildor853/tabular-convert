import { fail, show } from "../errors.js";
import { bool, opts } from "../input.js";
import { utf8 } from "../platform.js";
import { type Cell, cellText, checkTable, isDateOnly, type Table } from "../table.js";
import { dateToSerial } from "./dates.js";
import { encodeOoxml, escapeXml } from "./xml.js";
import { writeZip } from "./zip.js";

export interface XlsxSheet {
  readonly name: string;
  readonly table: Table;
}

export interface XlsxWriteOptions {
  /** Name of the sheet when writing a single table. Default `"Sheet1"`. */
  readonly sheetName?: string;
  /** Write the header row (in bold). Default `true`. */
  readonly header?: boolean;
  /** `"auto"` sizes columns to their content; or widths in characters, one per column. Default: spreadsheet default. */
  readonly columnWidths?: "auto" | readonly number[];
  /** Freeze the header row. Default `false`. */
  readonly freezeHeader?: boolean;
}

export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;
export const MAX_CELL_CHARS = 32_767;

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const STYLE_BOLD = 1;
const STYLE_DATE = 2;
const STYLE_DATETIME = 3;

const STYLES = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\
<numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd\\ hh:mm:ss"/></numFmts>\
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>\
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>\
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>\
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>\
<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>\
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>\
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>\
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>\
</styleSheet>`;

/** @internal A1 column letters for a 0-based index. */
export function columnName(index: number): string {
  let s = "";
  let n = index + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** @internal Checks a sheet name against Excel's rules. */
export function checkSheetName(name: unknown): string {
  if (typeof name !== "string" || name === "") return fail("InvalidInput", `Sheet names must be non-empty strings, got ${show(name)}.`);
  if (name.length > 31) fail("InvalidInput", `Sheet name ${show(name)} is longer than 31 characters.`);
  if (/[[\]:*?/\\\u0000-\u001f]/.test(name)) fail("InvalidInput", `Sheet name ${show(name)} contains a character that is not allowed ([ ] : * ? / \\ or a control character).`);
  if (name.startsWith("'") || name.endsWith("'")) fail("InvalidInput", `Sheet name ${show(name)} must not start or end with an apostrophe.`);
  if (name.toLowerCase() === "history") fail("InvalidInput", 'The sheet name "History" is reserved by Excel.');
  return name;
}

class SharedStrings {
  readonly list: string[] = [];
  readonly index = new Map<string, number>();
  count = 0;

  add(s: string): number {
    this.count++;
    let k = this.index.get(s);
    if (k === undefined) {
      k = this.list.length;
      this.list.push(s);
      this.index.set(s, k);
    }
    return k;
  }

  xml(): string {
    const items = this.list.map((s) => {
      const text = escapeXml(encodeOoxml(s));
      return /^\s|\s$/.test(s) ? `<si><t xml:space="preserve">${text}</t></si>` : `<si><t>${text}</t></si>`;
    });
    return `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.count}" uniqueCount="${this.list.length}">${items.join("")}</sst>`;
  }
}

function sheetXml(table: Table, header: boolean, widths: "auto" | readonly number[] | undefined, freeze: boolean, sst: SharedStrings): string {
  const width = table.columns.length;
  const rowCount = table.rows.length + (header ? 1 : 0);
  if (width > MAX_COLUMNS) fail("InvalidInput", `XLSX sheets hold at most ${MAX_COLUMNS} columns; the table has ${width}.`);
  if (rowCount > MAX_ROWS) fail("InvalidInput", `XLSX sheets hold at most ${MAX_ROWS} rows; the table needs ${rowCount}.`);
  const letters = table.columns.map((_, c) => columnName(c));
  const out: string[] = [];
  const lengths = new Array<number>(width).fill(0);
  const str = (s: string, ref: string, style: number) => {
    if (s.length > MAX_CELL_CHARS) fail("InvalidInput", `Cell ${ref} has ${s.length} characters; XLSX cells hold at most ${MAX_CELL_CHARS}.`);
    return `<c r="${ref}" t="s"${style ? ` s="${style}"` : ""}><v>${sst.add(s)}</v></c>`;
  };
  const cell = (v: Cell, ref: string, c: number): string => {
    if (v === null) return "";
    let text: string;
    if (typeof v === "string") {
      text = v;
      lengths[c] = Math.max(lengths[c] as number, v.length);
      return str(v, ref, 0);
    }
    if (typeof v === "boolean") {
      lengths[c] = Math.max(lengths[c] as number, 5);
      return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`;
    }
    if (v instanceof Date) {
      const serial = dateToSerial(v);
      const dateOnly = isDateOnly(v);
      lengths[c] = Math.max(lengths[c] as number, dateOnly ? 10 : 19);
      if (serial === undefined) return str(cellText(v), ref, 0);
      return `<c r="${ref}" s="${dateOnly ? STYLE_DATE : STYLE_DATETIME}"><v>${serial}</v></c>`;
    }
    if (typeof v === "bigint") {
      text = v.toString();
      lengths[c] = Math.max(lengths[c] as number, text.length);
      // beyond 2^53 a spreadsheet number would lose digits: keep the exact text
      if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) return str(text, ref, 0);
      return `<c r="${ref}"><v>${text}</v></c>`;
    }
    if (!Number.isFinite(v)) fail("InvalidInput", `Cell ${ref} holds the non-finite number ${v}, which XLSX cannot store.`);
    text = Object.is(v, -0) ? "0" : String(v).replace("e", "E"); // Excel writes 1E-7
    lengths[c] = Math.max(lengths[c] as number, text.length);
    return `<c r="${ref}"><v>${text}</v></c>`;
  };
  let r = 0;
  if (header) {
    r++;
    out.push(`<row r="1">${table.columns.map((col, c) => {
      lengths[c] = Math.max(lengths[c] as number, col.name.length);
      return str(col.name, `${letters[c]}1`, STYLE_BOLD);
    }).join("")}</row>`);
  }
  for (const row of table.rows) {
    r++;
    const cells: string[] = [];
    for (let c = 0; c < width; c++) cells.push(cell(row[c] ?? null, `${letters[c]}${r}`, c));
    out.push(`<row r="${r}">${cells.join("")}</row>`);
  }
  let cols = "";
  if (widths !== undefined && width > 0) {
    const w = widths === "auto" ? lengths.map((n) => Math.min(60, Math.max(8, n + 2))) : widths;
    cols = `<cols>${w.map((x, c) => `<col min="${c + 1}" max="${c + 1}" width="${x}" customWidth="1"/>`).join("")}</cols>`;
  }
  const dim = width > 0 && r > 0 ? `<dimension ref="A1:${letters[width - 1]}${r}"/>` : "";
  const view = freeze && header ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' : "";
  return `${XML_HEAD}<worksheet ${NS}>${dim}${view}${cols}<sheetData>${out.join("")}</sheetData></worksheet>`;
}

/** @internal Writes a workbook with one or more sheets. */
export async function writeXlsxImpl(input: Table | readonly XlsxSheet[], options: unknown): Promise<Uint8Array> {
  const o = opts(options);
  const header = bool(o, "header", true);
  const freeze = bool(o, "freezeHeader", false);
  let sheets: XlsxSheet[];
  if (Array.isArray(input)) {
    if (input.length === 0) fail("InvalidInput", "A workbook needs at least one sheet.");
    sheets = input.map((s: unknown, k) => {
      if (typeof s !== "object" || s === null || !("table" in s)) return fail("InvalidInput", `Sheet ${k + 1} must be { name, table }, got ${show(s)}.`);
      const sheet = s as { name?: unknown; table: unknown };
      return { name: checkSheetName(sheet.name), table: checkTable(sheet.table) };
    });
  } else {
    sheets = [{ name: checkSheetName(o.sheetName ?? "Sheet1"), table: checkTable(input) }];
  }
  const seen = new Set<string>();
  for (const s of sheets) {
    const key = s.name.toLowerCase();
    if (seen.has(key)) fail("InvalidInput", `Duplicate sheet name ${show(s.name)} (names are case-insensitive).`);
    seen.add(key);
  }
  const widths = o.columnWidths;
  if (widths !== undefined && widths !== "auto") {
    const ok = Array.isArray(widths) && widths.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0 && w <= 255);
    if (!ok) fail("InvalidOption", 'Option "columnWidths" must be "auto" or an array of widths between 0 and 255.');
  }
  const sst = new SharedStrings();
  const sheetFiles = sheets.map((s, k) => {
    if (Array.isArray(widths) && widths.length !== s.table.columns.length) {
      fail("InvalidOption", `Option "columnWidths" has ${widths.length} entries but sheet ${show(s.name)} has ${s.table.columns.length} columns.`);
    }
    return { name: `xl/worksheets/sheet${k + 1}.xml`, data: utf8(sheetXml(s.table, header, widths as "auto" | number[] | undefined, freeze, sst)) };
  });
  const contentTypes = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\
<Default Extension="xml" ContentType="application/xml"/>\
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\
${sheets.map((_, k) => `<Override PartName="/xl/worksheets/sheet${k + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}\
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>\
</Types>`;
  const rootRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\
</Relationships>`;
  const workbook = `${XML_HEAD}<workbook ${NS}><bookViews><workbookView/></bookViews><sheets>\
${sheets.map((s, k) => `<sheet name="${escapeXml(s.name)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join("")}\
</sheets></workbook>`;
  const n = sheets.length;
  const wbRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\
${sheets.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join("")}\
<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\
<Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>\
</Relationships>`;
  return writeZip([
    { name: "[Content_Types].xml", data: utf8(contentTypes) },
    { name: "_rels/.rels", data: utf8(rootRels) },
    { name: "xl/workbook.xml", data: utf8(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: utf8(wbRels) },
    { name: "xl/styles.xml", data: utf8(STYLES) },
    ...sheetFiles,
    { name: "xl/sharedStrings.xml", data: utf8(sst.xml()) },
  ]);
}
