import { fail, show } from "./errors.js";
import { bool, opts } from "./input.js";
import { type Cell, checkTable, type Table, typeOfColumn } from "./table.js";

/** Options for {@link inferTypes} and the readers' `infer` option. */
export interface InferOptions {
  /** Read `1,5` as 1.5 (and not `1.5`). Default `false`. */
  readonly decimalComma?: boolean;
  /** Convert ISO 8601 dates (`2026-10-09`, `2026-10-09T12:30:00Z`) to `Date`. Default `true`. */
  readonly dates?: boolean;
  /** Convert `true` / `false` (any case) to booleans. Default `true`. */
  readonly booleans?: boolean;
}

const NUMBER = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMBER_COMMA = /^[+-]?(?:0|[1-9]\d*)(?:,\d+)?$/;
const INTEGER = /^[+-]?\d+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

/** @internal Parses an ISO 8601 date/datetime (UTC unless an offset is given), or undefined. */
export function parseIsoDate(text: string): Date | undefined {
  const m = DATE.exec(text);
  if (!m) return undefined;
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", zone] = m as unknown as string[];
  const ms = Math.floor(Number(`0.${frac || "0"}`) * 1000 + 1e-9);
  const check = new Date(0);
  check.setUTCFullYear(Number(y), Number(mo) - 1, Number(d)); // unlike Date.UTC, keeps years 0–99
  check.setUTCHours(Number(h), Number(mi), Number(s), ms);
  const t = check.getTime();
  if (
    check.getUTCFullYear() !== Number(y) ||
    check.getUTCMonth() !== Number(mo) - 1 ||
    check.getUTCDate() !== Number(d) ||
    Number(h) > 23 ||
    Number(mi) > 59 ||
    Number(s) > 59
  ) {
    return undefined;
  }
  let offset = 0;
  if (zone !== undefined && zone !== "Z") {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(-2));
    if (zh > 23 || zm > 59) return undefined;
    offset = (zone[0] === "-" ? -1 : 1) * (zh * 60 + zm) * 60_000;
  }
  return new Date(t - offset);
}

function toNumber(text: string, decimalComma: boolean): number | bigint | undefined {
  if (!(decimalComma ? NUMBER_COMMA : NUMBER).test(text)) return undefined;
  if (INTEGER.test(text)) {
    const n = Number(text);
    return Number.isSafeInteger(n) ? n : BigInt(text);
  }
  const n = Number(decimalComma ? text.replace(",", ".") : text);
  return Number.isFinite(n) ? n : undefined;
}

type Kind = "boolean" | "number" | "date";

/**
 * Converts string cells to numbers, bigints, booleans and dates, column by
 * column: a column is converted only if every non-empty string cell in it
 * parses as the same kind; otherwise its strings are kept. Empty strings
 * become `null`. Integers with leading zeros (`007`) are kept as text.
 * Sets each column's `type`.
 */
export function inferTypes(table: Table, options?: InferOptions): Table {
  checkTable(table);
  const o = opts(options);
  const decimalComma = bool(o, "decimalComma", false);
  const dates = bool(o, "dates", true);
  const booleans = bool(o, "booleans", true);
  const rows = table.rows.map((row) => table.columns.map((_, c) => (row[c] === "" || row[c] === undefined ? null : (row[c] as Cell))));
  const columns = table.columns.map((col, c) => {
    let kind: Kind | null | undefined; // undefined: no string seen; null: not convertible
    for (const row of rows) {
      const v = row[c];
      if (typeof v !== "string") continue;
      const k: Kind | null =
        booleans && /^(?:true|false)$/i.test(v) ? "boolean" : toNumber(v, decimalComma) !== undefined ? "number" : dates && parseIsoDate(v) ? "date" : null;
      if (kind === undefined) kind = k;
      else if (kind !== k) kind = null;
      if (kind === null) break;
    }
    if (kind) {
      for (const row of rows) {
        const v = row[c];
        if (typeof v !== "string") continue;
        row[c] = kind === "boolean" ? v.toLowerCase() === "true" : kind === "number" ? (toNumber(v, decimalComma) as number | bigint) : (parseIsoDate(v) as Date);
      }
    }
    return { name: col.name, type: typeOfColumn(rows, c) };
  });
  return { columns, rows };
}

/** @internal Applies the `infer` read option (`true` honours a top-level `decimalComma`). */
export function applyInfer(table: Table, o: Record<string, unknown>): Table {
  const infer = o.infer;
  if (infer === undefined || infer === false) return table;
  if (infer === true) return inferTypes(table, { decimalComma: bool(o, "decimalComma", false) });
  if (typeof infer !== "object" || infer === null || Array.isArray(infer)) fail("InvalidOption", `Option "infer" must be a boolean or an options object, got ${show(infer)}.`);
  return inferTypes(table, infer as InferOptions);
}
