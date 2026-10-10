import { fail, show } from "../errors.js";
import { applyInfer, type InferOptions, parseIsoDate } from "../infer.js";
import { bool, type Input, opts, toBytes } from "../input.js";
import { type Limits, limitError, resolveLimits } from "../limits.js";
import { type Cell, cellText, makeTable, type Table } from "../table.js";
import { type NumberKind, numberKind, serialToDate } from "./dates.js";
import { type Attrs, decodeOoxml, parseXml } from "./xml.js";
import { openZip, type ZipArchive } from "./zip.js";

export interface XlsxReadOptions {
  /** Sheet name or 0-based index. Default: the first sheet. */
  readonly sheet?: string | number;
  /** First row is the header. Default `true`. */
  readonly header?: boolean;
  /** Leave out rows without any value. Default `true`. */
  readonly skipEmptyRows?: boolean;
  /** Convert text cells (see `inferTypes`). Default `false`; numbers, booleans and dates are typed already. */
  readonly infer?: boolean | InferOptions;
  readonly decimalComma?: boolean;
  readonly limits?: Partial<Limits>;
}

/** @internal Sheet entry of a workbook. */
export interface SheetInfo {
  readonly name: string;
  readonly path: string;
}

interface Workbook {
  readonly zip: ZipArchive;
  readonly sheets: SheetInfo[];
  readonly date1904: boolean;
  readonly sharedStrings: string | undefined;
  readonly styles: string | undefined;
}

const REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

function resolvePath(base: string, target: string): string {
  const parts = target.startsWith("/") ? [] : base.split("/").slice(0, -1);
  for (const seg of target.replace(/^\/+/, "").split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function relsPath(part: string): string {
  const k = part.lastIndexOf("/");
  return `${part.slice(0, k + 1)}_rels/${part.slice(k + 1)}.rels`;
}

async function readRels(zip: ZipArchive, part: string, limits: Limits): Promise<Map<string, { type: string; target: string }>> {
  const rels = new Map<string, { type: string; target: string }>();
  const path = relsPath(part);
  if (!zip.has(path)) return rels;
  parseXml(
    await zip.text(path),
    {
      open(name, a) {
        if (name === "Relationship" && a.get("TargetMode") !== "External") {
          rels.set(a.get("Id") ?? "", { type: a.get("Type") ?? "", target: resolvePath(part, a.get("Target") ?? "") });
        }
      },
    },
    limits.maxDepth,
  );
  return rels;
}

async function openWorkbook(input: Input, limits: Limits): Promise<Workbook> {
  const bytes = toBytes(input, limits);
  const zip = openZip(bytes, limits);
  const root = await readRels(zip, "", limits);
  let wbPath = [...root.values()].find((r) => r.type.endsWith("/officeDocument"))?.target ?? "xl/workbook.xml";
  if (!zip.has(wbPath)) {
    if (zip.has("xl/workbook.xml")) wbPath = "xl/workbook.xml";
    else if (zip.has("word/document.xml") || zip.has("ppt/presentation.xml")) fail("UnsupportedFormat", "This is a Word or PowerPoint file, not a spreadsheet.");
    else if (zip.has("content.xml")) fail("UnsupportedFormat", "OpenDocument spreadsheets (.ods) are not supported; save as .xlsx.");
    else fail("ParseError", "Not an XLSX workbook (no workbook part).");
  }
  const rels = await readRels(zip, wbPath, limits);
  const sheets: SheetInfo[] = [];
  let date1904 = false;
  parseXml(
    await zip.text(wbPath),
    {
      open(name, a) {
        if (name === "workbookPr") date1904 = a.get("date1904") === "1" || a.get("date1904") === "true";
        else if (name === "sheet") {
          const rel = rels.get(a.get("id") ?? "");
          if (rel?.type === `${REL_BASE}worksheet` || rel?.type.endsWith("/worksheet")) sheets.push({ name: a.get("name") ?? `Sheet${sheets.length + 1}`, path: rel.target });
        }
      },
    },
    limits.maxDepth,
  );
  const find = (suffix: string) => [...rels.values()].find((r) => r.type.endsWith(suffix))?.target;
  return { zip, sheets, date1904, sharedStrings: find("/sharedStrings"), styles: find("/styles") };
}

async function sharedStrings(wb: Workbook, limits: Limits): Promise<string[]> {
  const out: string[] = [];
  if (!wb.sharedStrings || !wb.zip.has(wb.sharedStrings)) return out;
  let parts: string[] | null = null;
  let inT = false;
  let phonetic = 0;
  parseXml(
    await wb.zip.text(wb.sharedStrings),
    {
      open(name) {
        if (name === "si") parts = [];
        else if (name === "t") inT = true;
        else if (name === "rPh") phonetic++;
      },
      close(name) {
        if (name === "si" && parts) {
          const s = decodeOoxml(parts.join(""));
          if (s.length > limits.maxCellLength) limitError("Cell length", limits.maxCellLength);
          out.push(s);
          parts = null;
        } else if (name === "t") inT = false;
        else if (name === "rPh") phonetic--;
      },
      text(t) {
        if (inT && phonetic === 0 && parts) parts.push(t);
      },
    },
    limits.maxDepth,
  );
  return out;
}

async function numberStyles(wb: Workbook, limits: Limits): Promise<NumberKind[]> {
  const isDate: NumberKind[] = [];
  if (!wb.styles || !wb.zip.has(wb.styles)) return isDate;
  const codes = new Map<number, string>();
  const xfs: number[] = [];
  let inCellXfs = false;
  parseXml(
    await wb.zip.text(wb.styles),
    {
      open(name, a) {
        if (name === "numFmt") codes.set(Number(a.get("numFmtId")), a.get("formatCode") ?? "");
        else if (name === "cellXfs") inCellXfs = true;
        else if (name === "xf" && inCellXfs) xfs.push(Number(a.get("numFmtId") ?? 0));
      },
      close(name) {
        if (name === "cellXfs") inCellXfs = false;
      },
    },
    limits.maxDepth,
  );
  for (const id of xfs) isDate.push(numberKind(id, codes.get(id)));
  return isDate;
}

/** Column index (0-based) of an A1 reference, or -1. */
function columnOf(ref: string): number {
  let col = 0;
  let k = 0;
  for (; k < ref.length && k < 4; k++) {
    const c = ref.charCodeAt(k) | 0x20;
    if (c < 0x61 || c > 0x7a) break;
    col = col * 26 + (c - 0x60);
  }
  return k === 0 ? -1 : col - 1;
}

function pickSheet(wb: Workbook, sheet: unknown): SheetInfo {
  if (wb.sheets.length === 0) fail("ParseError", "The workbook has no worksheets.");
  if (sheet === undefined) return wb.sheets[0] as SheetInfo;
  const names = wb.sheets.map((s) => show(s.name)).join(", ");
  if (typeof sheet === "number") {
    const s = Number.isInteger(sheet) ? wb.sheets[sheet] : undefined;
    return s ?? fail("InvalidOption", `Sheet index ${sheet} is out of range; the workbook has ${wb.sheets.length} sheet(s): ${names}.`);
  }
  if (typeof sheet === "string") {
    return wb.sheets.find((s) => s.name === sheet) ?? wb.sheets.find((s) => s.name.toLowerCase() === sheet.toLowerCase()) ?? fail("InvalidOption", `No sheet named ${show(sheet)}; sheets: ${names}.`);
  }
  return fail("InvalidOption", `Option "sheet" must be a name or a 0-based index, got ${show(sheet)}.`);
}

/** @internal Parses one worksheet into a dense grid. */
function sheetGrid(xml: string, strings: readonly string[], kinds: readonly NumberKind[], date1904: boolean, limits: Limits): { index: number; row: Cell[] }[] {
  const rows: { index: number; row: Cell[] }[] = [];
  let rowIndex = -1;
  let row: Cell[] | null = null;
  let col = -1;
  let type = "n";
  let style = 0;
  let value: string[] | null = null;
  let inline: string[] | null = null;
  let inV = false;
  let inT = false;
  let phonetic = 0;
  const finishCell = () => {
    let cell: Cell = null;
    if (type === "inlineStr") cell = inline ? decodeOoxml(inline.join("")) : null;
    else if (value !== null) {
      const v = value.join("");
      if (type === "s") {
        const idx = Number(v);
        const s = Number.isInteger(idx) ? strings[idx] : undefined;
        if (s === undefined) fail("ParseError", `Invalid shared string index ${show(v)}.`);
        cell = s;
      } else if (type === "str" || type === "e") cell = decodeOoxml(v);
      else if (type === "b") cell = v.trim() === "1" || v.trim() === "true";
      else if (type === "d") cell = parseIsoDate(v.trim()) ?? v;
      else if (v.trim() !== "") {
        const num = Number(v);
        if (!Number.isFinite(num)) fail("ParseError", `Invalid number ${show(v)} in a cell.`);
        const kind = kinds[style];
        cell = kind === "date" ? (serialToDate(num, date1904) ?? num) : kind === "boolean" ? num !== 0 : num;
      }
    }
    if (typeof cell === "string" && cell.length > limits.maxCellLength) limitError("Cell length", limits.maxCellLength);
    if (cell !== null && row) {
      if (col >= limits.maxColumns) limitError("Number of columns", limits.maxColumns);
      while (row.length < col) row.push(null);
      row[col] = cell;
    }
  };
  const handlers = {
    open(name: string, a: Attrs) {
      if (name === "row") {
        const r = Number(a.get("r"));
        rowIndex = Number.isInteger(r) && r > rowIndex + 1 ? r - 1 : rowIndex + 1;
        if (rowIndex >= limits.maxRows + 1) limitError("Number of rows", limits.maxRows);
        row = [];
        col = -1;
      } else if (name === "c") {
        const ref = a.get("r");
        const c = ref === undefined ? -1 : columnOf(ref);
        col = c > col ? c : col + 1;
        type = a.get("t") ?? "n";
        style = Number(a.get("s") ?? 0);
        value = null;
        inline = null;
      } else if (name === "v") {
        inV = true;
        value = [];
      } else if (name === "is") inline = [];
      else if (name === "t") inT = true;
      else if (name === "rPh") phonetic++;
    },
    close(name: string) {
      if (name === "v") inV = false;
      else if (name === "t") inT = false;
      else if (name === "rPh") phonetic--;
      else if (name === "c") finishCell();
      else if (name === "row" && row) {
        if (row.length > 0) rows.push({ index: rowIndex, row });
        row = null;
      }
    },
    text(t: string) {
      if (inV && value) value.push(t);
      else if (inT && inline && phonetic === 0) inline.push(t);
    },
  };
  parseXml(xml, handlers, limits.maxDepth);
  return rows;
}

/** @internal Reads a workbook sheet into a table. */
export async function readXlsxImpl(input: Input, options: unknown): Promise<Table> {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  bool(o, "header", true);
  bool(o, "skipEmptyRows", true);
  const wb = await openWorkbook(input, limits);
  const info = pickSheet(wb, o.sheet);
  if (!wb.zip.has(info.path)) fail("ParseError", `The workbook is missing the part for sheet ${show(info.name)}.`);
  const [strings, kinds] = await Promise.all([sharedStrings(wb, limits), numberStyles(wb, limits)]);
  const sparse = sheetGrid(await wb.zip.text(info.path), strings, kinds, wb.date1904, limits);
  return finishGrid(sparse, o, limits);
}

/** @internal Sparse rows (document order) → table: header, empty-row handling, start at the first used row and column. */
export function finishGrid(sparse: readonly { index: number; row: Cell[] }[], o: Record<string, unknown>, limits: Limits): Table {
  const header = bool(o, "header", true);
  const skipEmpty = bool(o, "skipEmptyRows", true);
  let grid: Cell[][];
  if (skipEmpty || sparse.length === 0) grid = sparse.map((r) => r.row);
  else {
    grid = [];
    const first = (sparse[0] as { index: number }).index;
    for (const { index, row } of sparse) {
      while (grid.length < index - first) grid.push([]);
      grid.push(row);
    }
  }
  if (grid.length > limits.maxRows + 1) limitError("Number of rows", limits.maxRows);
  let minCol = Number.POSITIVE_INFINITY;
  for (const r of grid) {
    const k = r.findIndex((c) => c !== null && c !== undefined);
    if (k >= 0 && k < minCol) minCol = k;
  }
  if (minCol > 0 && minCol !== Number.POSITIVE_INFINITY) grid = grid.map((r) => r.slice(minCol));
  grid = grid.map((r) => Array.from(r, (c) => c ?? null));
  const head = header ? grid.shift()?.map((c) => (c === null ? "" : cellText(c))) : undefined;
  return applyInfer(makeTable(head, grid), o);
}

/** @internal Sheet names of a workbook. */
export async function listSheetsImpl(input: Input, options: unknown): Promise<string[]> {
  const o = opts(options);
  const wb = await openWorkbook(input, resolveLimits(o.limits));
  return wb.sheets.map((s) => s.name);
}
