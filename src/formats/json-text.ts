/**
 * Minimal, linear JSON parser and serializer used by the JSON and NDJSON
 * formats. Differences from the built-ins: objects are `Map`s (key order kept,
 * no prototype involvement), integers outside the safe range become `bigint`,
 * and nesting depth is limited.
 */
import { fail } from "../errors.js";
import type { Limits } from "../limits.js";

export type JsonValue = null | boolean | number | bigint | string | JsonValue[] | Map<string, JsonValue>;

const WS = /[ \t\n\r]*/y;
const ESCAPES: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
});
const NUM = /-?(?:0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/y;

/** @internal */
export function parseJson(text: string, limits: Limits, where = ""): JsonValue {
  let i = 0;
  const err = (msg: string): never => {
    const before = text.slice(0, i);
    const line = before.split("\n").length;
    return fail("ParseError", `Invalid JSON${where}: ${msg} at line ${line}, column ${i - before.lastIndexOf("\n")}.`);
  };
  const ws = () => {
    WS.lastIndex = i;
    WS.exec(text);
    i = WS.lastIndex;
  };
  const str = (): string => {
    i++; // opening quote
    const parts: string[] = [];
    let start = i;
    for (;;) {
      if (i >= text.length) return err("unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        parts.push(text.slice(start, i));
        i++;
        break;
      }
      if (c < 0x20) return err("control character in string");
      if (c !== 0x5c) {
        i++;
        continue;
      }
      parts.push(text.slice(start, i));
      const e = text[i + 1];
      const simple = e === undefined ? undefined : ESCAPES[e];
      if (simple !== undefined) {
        parts.push(simple);
        i += 2;
      } else if (e === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        parts.push(String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16)));
        i += 6;
      } else {
        return err("bad escape");
      }
      start = i;
    }
    const out = parts.join("");
    if (out.length > limits.maxCellLength) fail("LimitExceeded", `String length exceeds the limit of ${limits.maxCellLength} (raise it with the "limits" option).`);
    return out;
  };
  const value = (depth: number): JsonValue => {
    if (depth > limits.maxDepth) fail("LimitExceeded", `JSON nesting exceeds the limit of ${limits.maxDepth} (raise it with the "limits" option).`);
    ws();
    const ch = text[i];
    if (ch === "{") {
      i++;
      const map = new Map<string, JsonValue>();
      ws();
      if (text[i] === "}") {
        i++;
        return map;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') return err("expected a property name");
        const key = str();
        ws();
        if (text[i] !== ":") return err('expected ":"');
        i++;
        map.set(key, value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return map;
        }
        return err('expected "," or "}"');
      }
    }
    if (ch === "[") {
      i++;
      const arr: JsonValue[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        return err('expected "," or "]"');
      }
    }
    if (ch === '"') return str();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    NUM.lastIndex = i;
    const m = NUM.exec(text);
    if (m) {
      i = NUM.lastIndex;
      if (m[1] === undefined && m[2] === undefined) {
        const n = Number(m[0]);
        return Number.isSafeInteger(n) ? n : BigInt(m[0]);
      }
      const n = Number(m[0]);
      return Number.isFinite(n) ? n : err("number out of range");
    }
    return err(ch === undefined ? "unexpected end of input" : `unexpected character ${JSON.stringify(ch)}`);
  };
  const result = value(0);
  ws();
  if (i < text.length) err("unexpected data after the value");
  return result;
}

/** @internal Serializes like `JSON.stringify(value, null, indent)`, with bigint and Map support. */
export function stringifyJson(value: JsonValue, indent: number): string {
  const out: string[] = [];
  const nl = indent > 0;
  const pad = (depth: number) => (nl ? `\n${" ".repeat(indent * depth)}` : "");
  const write = (v: JsonValue, depth: number) => {
    if (v === null) out.push("null");
    else if (typeof v === "string") out.push(JSON.stringify(v));
    else if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") out.push(String(v));
    else if (Array.isArray(v)) {
      if (v.length === 0) return void out.push("[]");
      out.push("[");
      v.forEach((item, k) => {
        if (k > 0) out.push(",");
        out.push(pad(depth + 1));
        write(item, depth + 1);
      });
      out.push(pad(depth), "]");
    } else {
      if (v.size === 0) return void out.push("{}");
      out.push("{");
      let k = 0;
      for (const [key, item] of v) {
        if (k++ > 0) out.push(",");
        out.push(pad(depth + 1), JSON.stringify(key), nl ? ": " : ":");
        write(item, depth + 1);
      }
      out.push(pad(depth), "}");
    }
  };
  write(value, 0);
  return out.join("");
}
