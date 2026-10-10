/**
 * Machine-readable reasons why a call failed.
 *
 * - `ParseError`: the input is not valid for its format (unclosed quote, bad JSON, corrupt ZIP, DOCTYPE in XML, …).
 * - `UnsupportedFormat`: unknown format name, undetectable input, or a feature of the format that is not supported (encrypted or ZIP64 workbooks, …).
 * - `InvalidInput`: a `Table` (or a value in it) that cannot be written, e.g. a non-finite number or an invalid sheet name.
 * - `InvalidOption`: an option has a wrong type or value.
 * - `LimitExceeded`: an input-size, row, column, cell or decompression limit was hit (see `limits`).
 */
export type ErrorCode = "ParseError" | "UnsupportedFormat" | "InvalidInput" | "InvalidOption" | "LimitExceeded";

/** The single error class thrown by this library. Branch on `code`. */
export class TabularError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "TabularError";
    this.code = code;
  }
}

/** Result object returned by every `try*` function. Never throws for invalid input. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TabularError };

/** Narrowing helper: `true` when `err` is a {@link TabularError}. */
export function isTabularError(err: unknown): err is TabularError {
  return err instanceof TabularError;
}

/** @internal */
export function fail(code: ErrorCode, message: string): never {
  throw new TabularError(code, message);
}

/** @internal Wraps a throwing function into a `Result`. */
export function attempt<T>(fn: () => T): Result<T> {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    if (err instanceof TabularError) return { ok: false, error: err };
    throw err;
  }
}

/** @internal Async variant of {@link attempt}. */
export async function attemptAsync<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof TabularError) return { ok: false, error: err };
    throw err;
  }
}

/** @internal Short description of an untrusted value for error messages; never throws. */
export function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === "bigint") {
    const s = value.toString();
    return s.length > 40 ? `${s.slice(0, 40)}…n` : `${s}n`;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  return Object.prototype.toString.call(value);
}
