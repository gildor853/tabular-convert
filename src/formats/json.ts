import { fail, show } from "../errors.js";
import { applyInfer, type InferOptions } from "../infer.js";
import { bool, type Input, int, oneOf, opts, toText } from "../input.js";
import { type Limits, limitError, resolveLimits } from "../limits.js";
import { type Cell, checkTable, dateText, makeTable, type Table, uniqueNames } from "../table.js";
import { type JsonValue, parseJson, stringifyJson } from "./json-text.js";

export interface JsonReadOptions {
  readonly encoding?: string;
  /** Arrays of arrays: the first row is the header. Default `true`. */
  readonly header?: boolean;
  /** Nested objects become `a.b` columns. Default `true`; when `false` they (like arrays) are kept as JSON text. */
  readonly flatten?: boolean;
  /** Convert string cells (see `inferTypes`). Default `false`. */
  readonly infer?: boolean | InferOptions;
  readonly limits?: Partial<Limits>;
}

/** `objects`: `[{"a":1}]`; `arrays`: `[["a"],[1]]`; `columns`: `{"columns":["a"],"rows":[[1]]}`. */
export type JsonShape = "objects" | "arrays" | "columns";

export interface JsonWriteOptions {
  /** Default `"objects"`. */
  readonly shape?: JsonShape;
  /** Spaces of indentation (0–10). Default 2 for JSON. */
  readonly indent?: number;
  /** Turn `a.b` columns back into nested objects (`objects` shape). Default `false`. */
  readonly unflatten?: boolean;
}

/** @internal JSON value → cell (nested values flattened or stringified by the caller). */
function toCell(v: JsonValue): Cell {
  if (v === null || typeof v !== "object") return v;
  return stringifyJson(v, 0);
}

/** @internal Flattens one object into ordered [path, cell] pairs. */
function flattenInto(obj: Map<string, JsonValue>, prefix: string, flatten: boolean, out: Map<string, Cell>): void {
  for (const [key, v] of obj) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (flatten && v instanceof Map && v.size > 0) flattenInto(v, path, flatten, out);
    else if (out.has(path)) fail("ParseError", `Key ${show(path)} appears twice in one object after flattening nested objects; rename it or use flatten: false.`);
    else out.set(path, toCell(v));
  }
}

/** @internal Rows of JSON values (objects / arrays / primitives) → table. */
export function tableFromValues(values: JsonValue[], o: Record<string, unknown>, limits: Limits, what: string): Table {
  const flatten = bool(o, "flatten", true);
  if (values.length > limits.maxRows + 1) limitError("Number of rows", limits.maxRows);
  let table: Table;
  if (values.length === 0) table = { columns: [], rows: [] };
  else if (values.every((v) => v instanceof Map)) {
    const names = new Map<string, number>();
    const flat = values.map((v) => {
      const m = new Map<string, Cell>();
      flattenInto(v as Map<string, JsonValue>, "", flatten, m);
      for (const k of m.keys()) if (!names.has(k)) names.set(k, names.size);
      if (names.size > limits.maxColumns) limitError("Number of columns", limits.maxColumns);
      return m;
    });
    const keys = [...names.keys()];
    const rows = flat.map((m) => keys.map((k) => (m.has(k) ? (m.get(k) as Cell) : null)));
    table = { columns: keys.map((name) => ({ name })), rows };
  } else if (values.every(Array.isArray)) {
    const arrays = values as JsonValue[][];
    for (const a of arrays) if (a.length > limits.maxColumns) limitError("Number of columns", limits.maxColumns);
    const header = bool(o, "header", true) ? arrays.shift()?.map((v) => (v === null ? "" : String(toCell(v)))) : undefined;
    table = makeTable(header, arrays.map((a) => a.map(toCell)));
  } else if (values.every((v) => v === null || typeof v !== "object")) {
    table = { columns: [{ name: "value" }], rows: values.map((v) => [v as Cell]) };
  } else {
    return fail("ParseError", `${what} mixes objects, arrays and plain values; expected rows of one kind.`);
  }
  return applyInfer(table, o);
}

/**
 * Reads JSON: an array of objects, an array of arrays (first row = header),
 * an array of plain values, or `{ "columns": [...], "rows": [[...]] }`.
 * Integers outside the safe range become `bigint`.
 */
export function readJson(input: Input, options?: JsonReadOptions): Table {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  const value = parseJson(toText(input, limits, o.encoding), limits);
  if (Array.isArray(value)) return tableFromValues(value, o, limits, "The JSON array");
  if (value instanceof Map && Array.isArray(value.get("columns")) && Array.isArray(value.get("rows"))) {
    const cols = value.get("columns") as JsonValue[];
    const names = cols.map((c) => (typeof c === "string" ? c : c instanceof Map && typeof c.get("name") === "string" ? (c.get("name") as string) : fail("ParseError", `Invalid column ${show(c)}; expected a name or { "name": … }.`)));
    const rows = value.get("rows") as JsonValue[];
    if (rows.length > limits.maxRows) limitError("Number of rows", limits.maxRows);
    if (names.length > limits.maxColumns) limitError("Number of columns", limits.maxColumns);
    const cells = rows.map((r, k) => (Array.isArray(r) ? r.map(toCell) : fail("ParseError", `Row ${k + 1} of "rows" is not an array.`)));
    const table = makeTable(names, cells);
    return applyInfer(table, o);
  }
  return fail("ParseError", 'Expected a JSON array or an object with "columns" and "rows" arrays.');
}

/** @internal Cell → JSON value. */
function jsonCell(cell: Cell): JsonValue {
  if (cell instanceof Date) return dateText(cell);
  if (typeof cell === "number" && !Number.isFinite(cell)) return fail("InvalidInput", `Cannot write the non-finite number ${cell} as JSON.`);
  return cell;
}

/** @internal Builds nested maps from dot paths. */
function unflattenRow(names: readonly string[], row: readonly Cell[]): Map<string, JsonValue> {
  const root = new Map<string, JsonValue>();
  names.forEach((name, c) => {
    const parts = name.split(".");
    let node = root;
    for (let k = 0; k < parts.length - 1; k++) {
      const key = parts[k] as string;
      let next = node.get(key);
      if (next === undefined) {
        next = new Map();
        node.set(key, next);
      } else if (!(next instanceof Map)) {
        fail("InvalidInput", `Cannot unflatten column "${name}": "${parts.slice(0, k + 1).join(".")}" is also a plain value.`);
      }
      node = next;
    }
    const leaf = parts[parts.length - 1] as string;
    if (node.has(leaf)) fail("InvalidInput", `Cannot unflatten column "${name}": it conflicts with another column.`);
    node.set(leaf, jsonCell(row[c] ?? null));
  });
  return root;
}

/** @internal Table → array of JSON row values in the requested shape. */
export function jsonRows(table: Table, o: Record<string, unknown>): JsonValue[] {
  const shape = oneOf(o, "shape", ["objects", "arrays", "columns"], "objects");
  const names = table.columns.map((c) => c.name);
  if (shape === "arrays") return [names, ...table.rows.map((r) => names.map((_, c) => jsonCell(r[c] ?? null)))];
  if (bool(o, "unflatten", false)) return table.rows.map((r) => unflattenRow(names, r));
  const unique = uniqueNames(names, names.length);
  return table.rows.map((r) => new Map(unique.map((n, c) => [n, jsonCell(r[c] ?? null)])));
}

/** Writes JSON in the chosen shape. Dates become ISO 8601 strings (`YYYY-MM-DD` at UTC midnight); bigints are written as plain numbers. */
export function writeJson(table: Table, options?: JsonWriteOptions): string {
  checkTable(table);
  const o = opts(options);
  const indent = int(o, "indent", 2, 0, 10);
  const shape = oneOf(o, "shape", ["objects", "arrays", "columns"], "objects");
  if (shape === "columns") {
    const doc = new Map<string, JsonValue>([
      ["columns", table.columns.map((c) => c.name)],
      ["rows", table.rows.map((r) => table.columns.map((_, c) => jsonCell(r[c] ?? null)))],
    ]);
    return `${stringifyJson(doc, indent)}\n`;
  }
  return `${stringifyJson(jsonRows(table, o), indent)}\n`;
}

/** Reads NDJSON / JSON Lines: one object (or array) per line; blank lines are skipped. */
export function readNdjson(input: Input, options?: JsonReadOptions): Table {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  const text = toText(input, limits, o.encoding);
  const values: JsonValue[] = [];
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo++;
    if (line.trim() === "") continue;
    values.push(parseJson(line, limits, ` on line ${lineNo}`));
    if (values.length > limits.maxRows + 1) limitError("Number of rows", limits.maxRows);
  }
  return tableFromValues(values, o, limits, "The NDJSON input");
}

/** Writes NDJSON: one compact JSON object per line (or arrays with `shape: "arrays"`). */
export function writeNdjson(table: Table, options?: Omit<JsonWriteOptions, "indent">): string {
  checkTable(table);
  const o = opts(options);
  if (o.shape === "columns") fail("InvalidOption", 'NDJSON supports the "objects" and "arrays" shapes.');
  const rows = jsonRows(table, o);
  return rows.map((r) => `${stringifyJson(r, 0)}\n`).join("");
}

