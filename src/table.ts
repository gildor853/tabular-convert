import { fail, show } from "./errors.js";

/** A cell value. `bigint` is used for integers outside the safe `number` range. */
export type Cell = string | number | boolean | bigint | Date | null;

/** Column type as reported by {@link columnTypes} / `infer`. `empty` means every cell is null; `mixed` means more than one type. */
export type ColumnType = "string" | "number" | "bigint" | "boolean" | "date" | "empty" | "mixed";

export interface Column {
  readonly name: string;
  readonly type?: ColumnType;
}

/** The format-independent model every reader produces and every writer consumes. */
export interface Table {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly Cell[])[];
}

/** `true` when `value` is a structurally valid {@link Table} (all cells of an allowed type). Never throws. */
export function isTable(value: unknown): value is Table {
  try {
    checkTable(value);
    return true;
  } catch {
    return false;
  }
}

/** @internal Type of one non-null cell. */
export function cellType(cell: Cell): ColumnType {
  if (cell === null) return "empty";
  if (cell instanceof Date) return "date";
  return typeof cell as "string" | "number" | "bigint" | "boolean";
}

/** @internal Type of column `c`: number and bigint together count as "number". */
export function typeOfColumn(rows: readonly (readonly Cell[])[], c: number): ColumnType {
  let type: ColumnType = "empty";
  for (const row of rows) {
    const t = cellType(row[c] ?? null);
    if (t === "empty" || t === type) continue;
    if (type === "empty") type = t;
    else if ((type === "number" && t === "bigint") || (type === "bigint" && t === "number")) type = "number";
    else return "mixed";
  }
  return type;
}

/**
 * Computes each column's type from its cells: `"empty"` if all are null,
 * `"mixed"` if kinds differ (numbers and bigints together count as `"number"`).
 */
export function columnTypes(table: Table): ColumnType[] {
  checkTable(table);
  return table.columns.map((_, c) => typeOfColumn(table.rows, c));
}

function isCell(v: unknown): v is Cell {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint" ||
    (v instanceof Date && !Number.isNaN(v.getTime()))
  );
}

/**
 * @internal Validates a table passed to a writer. Rows shorter than the
 * header are treated as padded with null; longer rows are an error.
 */
export function checkTable(value: unknown): Table {
  if (value === null || typeof value !== "object") fail("InvalidInput", `Expected a table { columns, rows }, got ${show(value)}.`);
  const t = value as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(t.columns)) fail("InvalidInput", 'Table "columns" must be an array.');
  if (!Array.isArray(t.rows)) fail("InvalidInput", 'Table "rows" must be an array.');
  for (const [i, col] of (t.columns as unknown[]).entries()) {
    if (col === null || typeof col !== "object" || typeof (col as Column).name !== "string") {
      fail("InvalidInput", `Column ${i + 1} must be an object with a string "name".`);
    }
  }
  const width = t.columns.length;
  for (const [r, row] of (t.rows as unknown[]).entries()) {
    if (!Array.isArray(row)) fail("InvalidInput", `Row ${r + 1} must be an array.`);
    if (row.length > width) fail("InvalidInput", `Row ${r + 1} has ${row.length} cells but the table has ${width} columns.`);
    for (let c = 0; c < row.length; c++) {
      if (!isCell(row[c])) {
        fail("InvalidInput", `Row ${r + 1}, column ${c + 1}: unsupported cell value ${show(row[c])} (allowed: string, number, boolean, bigint, valid Date, null).`);
      }
    }
  }
  return value as Table;
}

/**
 * @internal Builds a table from raw header names and rows: empty names
 * become `column_N`, duplicates get `_2`, `_3`, …; short rows are padded and
 * extra cells create extra columns.
 */
export function makeTable(header: readonly string[] | undefined, rows: Cell[][]): Table {
  let width = header?.length ?? 0;
  for (const row of rows) if (row.length > width) width = row.length;
  for (const row of rows) while (row.length < width) row.push(null);
  return { columns: uniqueNames(header ?? [], width).map((name) => ({ name })), rows };
}

/** @internal */
export function uniqueNames(names: readonly string[], width: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < width; i++) {
    const base = (names[i] ?? "").trim() === "" ? `column_${i + 1}` : (names[i] as string);
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base}_${n}`;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** @internal True when a Date has no time-of-day part (UTC midnight). */
export function isDateOnly(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

/** @internal ISO text for dates: `YYYY-MM-DD` at UTC midnight, otherwise the full ISO 8601 timestamp. */
export function dateText(d: Date): string {
  const iso = d.toISOString();
  const year = d.getUTCFullYear();
  return isDateOnly(d) && year >= 0 && year <= 9999 ? iso.slice(0, 10) : iso;
}

/** @internal Text form of a cell for text formats. */
export function cellText(cell: Cell, decimalComma = false): string {
  if (cell === null) return "";
  if (typeof cell === "string") return cell;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) fail("InvalidInput", `Cannot write the non-finite number ${cell}.`);
    const s = Object.is(cell, -0) ? "0" : String(cell);
    return decimalComma ? s.replace(".", ",") : s;
  }
  if (cell instanceof Date) return dateText(cell);
  return String(cell);
}
