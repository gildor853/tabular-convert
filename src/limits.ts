import { fail, show } from "./errors.js";

/**
 * Safety limits for untrusted input. Every reader accepts `limits` with any
 * subset of these; the defaults suit files up to a few hundred megabytes.
 */
export interface Limits {
  /** Largest input, in bytes (binary input) or UTF-16 code units (strings). Default 256 MiB. */
  readonly maxInputBytes: number;
  /** Most data rows (header excluded). Default 2,000,000. */
  readonly maxRows: number;
  /** Most columns. Default 16,384 (the XLSX limit). */
  readonly maxColumns: number;
  /** Longest single cell, in characters. Default 1,048,576. */
  readonly maxCellLength: number;
  /** XLSX: most ZIP entries. Default 10,000. */
  readonly maxZipEntries: number;
  /** XLSX: total uncompressed size of the entries that are read, in bytes. Default 1 GiB. */
  readonly maxUncompressedBytes: number;
  /** XLSX: largest compression ratio for entries over 1 MiB. Default 1000. */
  readonly maxCompressionRatio: number;
  /** JSON / XML: deepest nesting. Default 256. */
  readonly maxDepth: number;
}

export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxInputBytes: 256 * 1024 * 1024,
  maxRows: 2_000_000,
  maxColumns: 16_384,
  maxCellLength: 1_048_576,
  maxZipEntries: 10_000,
  maxUncompressedBytes: 1024 * 1024 * 1024,
  maxCompressionRatio: 1000,
  maxDepth: 256,
});

/** @internal Validates and merges user limits with the defaults. */
export function resolveLimits(user: unknown): Limits {
  if (user === undefined || user === null) return DEFAULT_LIMITS;
  if (typeof user !== "object") fail("InvalidOption", `Option "limits" must be an object, got ${show(user)}.`);
  const out: Record<string, number> = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS)) {
    const v = (user as Record<string, unknown>)[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) fail("InvalidOption", `Limit "${key}" must be a positive integer, got ${show(v)}.`);
    out[key] = v;
  }
  return out as unknown as Limits;
}

/** @internal */
export function limitError(what: string, limit: number): never {
  return fail("LimitExceeded", `${what} exceeds the limit of ${limit} (raise it with the "limits" option).`);
}
