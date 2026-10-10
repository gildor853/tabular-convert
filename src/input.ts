import { fail, show } from "./errors.js";
import { type Limits, limitError } from "./limits.js";
import { textDecoder } from "./platform.js";

/** Input accepted by readers: text, or bytes (`Uint8Array`, Node.js `Buffer`, `ArrayBuffer`). */
export type Input = string | Uint8Array | ArrayBuffer;

/** @internal Bytes of a binary input. */
export function toBytes(input: unknown, limits: Limits): Uint8Array {
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else return fail("InvalidInput", `Expected binary input (Uint8Array or ArrayBuffer), got ${show(input)}.`);
  if (bytes.length > limits.maxInputBytes) limitError("Input size", limits.maxInputBytes);
  return bytes;
}

/**
 * @internal Text of an input. Bytes are decoded with the BOM's encoding
 * (UTF-8, UTF-16 LE/BE) or `encoding` (default UTF-8); a leading BOM is removed.
 */
export function toText(input: unknown, limits: Limits, encoding?: unknown): string {
  if (encoding !== undefined && typeof encoding !== "string") fail("InvalidOption", `Option "encoding" must be a string, got ${show(encoding)}.`);
  let text: string;
  if (typeof input === "string") {
    if (input.length > limits.maxInputBytes) limitError("Input size", limits.maxInputBytes);
    text = input;
  } else {
    const bytes = toBytes(input, limits);
    let label = encoding ?? "utf-8";
    let start = 0;
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) [label, start] = ["utf-8", 3];
    else if (bytes[0] === 0xff && bytes[1] === 0xfe) [label, start] = ["utf-16le", 2];
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) [label, start] = ["utf-16be", 2];
    text = textDecoder(label, { ignoreBOM: true }).decode(bytes.subarray(start));
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** @internal Reads a string option restricted to a set of values. */
export function oneOf<T extends string>(options: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const v = options[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    fail("InvalidOption", `Option "${key}" must be one of ${allowed.map((a) => JSON.stringify(a)).join(", ")}, got ${show(v)}.`);
  }
  return v as T;
}

/** @internal Reads a boolean option. */
export function bool(options: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = options[key];
  if (v === undefined) return fallback;
  if (typeof v !== "boolean") fail("InvalidOption", `Option "${key}" must be a boolean, got ${show(v)}.`);
  return v;
}

/** @internal Reads a positive integer option. */
export function int(options: Record<string, unknown>, key: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const v = options[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) fail("InvalidOption", `Option "${key}" must be an integer from ${min} to ${max}, got ${show(v)}.`);
  return v;
}

/** @internal Reads a single-character option. */
export function char(options: Record<string, unknown>, key: string, fallback: string): string {
  const v = options[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string" || v.length !== 1 || v === "\n" || v === "\r") fail("InvalidOption", `Option "${key}" must be a single character other than CR/LF, got ${show(v)}.`);
  return v;
}

/** @internal Options object (null/undefined → empty). */
export function opts(options: unknown): Record<string, unknown> {
  if (options === undefined || options === null) return {};
  if (typeof options !== "object" || Array.isArray(options)) fail("InvalidOption", `Expected an options object, got ${show(options)}.`);
  return options as Record<string, unknown>;
}
