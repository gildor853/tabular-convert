import { readFileSync } from "node:fs";
import { expect } from "vitest";
import { isTabularError, type Table } from "../../src/index.js";

export const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
export const text = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Asserts that `fn` throws a TabularError with the given code (and optional message fragment). */
export function throwsCode(fn: () => unknown, code: string, message?: string | RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(isTabularError(caught), `expected a TabularError, got ${String(caught)}`).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
  if (message !== undefined) expect((caught as Error).message).toMatch(message);
}

export async function rejectsCode(p: Promise<unknown> | (() => Promise<unknown>), code: string, message?: string | RegExp): Promise<void> {
  let caught: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    caught = err;
  }
  expect(isTabularError(caught), `expected a TabularError, got ${String(caught)}`).toBe(true);
  expect((caught as { code: string }).code).toBe(code);
  if (message !== undefined) expect((caught as Error).message).toMatch(message);
}

export const names = (t: Table): string[] => t.columns.map((c) => c.name);

export const table = (header: string[], rows: Table["rows"]): Table => ({ columns: header.map((name) => ({ name })), rows });
