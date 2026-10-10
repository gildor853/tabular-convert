/**
 * Raw DEFLATE through the platform: `node:zlib` in Node.js, otherwise the
 * `CompressionStream` / `DecompressionStream` web APIs ("deflate-raw").
 */
import { fail } from "../errors.js";

/** @internal */
export interface DeflateBackend {
  readonly name: string;
  deflate(data: Uint8Array): Promise<Uint8Array>;
  /** Inflates, failing with LimitExceeded / ParseError when the output would exceed `maxBytes`. */
  inflate(data: Uint8Array, maxBytes: number): Promise<Uint8Array>;
}

interface ReadResult {
  readonly done: boolean;
  readonly value?: Uint8Array;
}
interface StreamPair {
  readonly readable: { getReader(): { read(): Promise<ReadResult>; cancel(): Promise<void> } };
  readonly writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> } };
}

interface NodeZlib {
  deflateRawSync(data: Uint8Array, options?: { level?: number }): Uint8Array;
  inflateRawSync(data: Uint8Array, options?: { maxOutputLength?: number }): Uint8Array;
}

let override: DeflateBackend | undefined;
let nodeBackend: Promise<DeflateBackend | undefined> | undefined;

/** @internal Test hook: force a backend (or `undefined` for automatic). */
export function setDeflateBackend(backend: DeflateBackend | undefined): void {
  override = backend;
}

function tooLarge(maxBytes: number): never {
  return fail("LimitExceeded", `A ZIP entry inflates beyond its declared size or the limit (${maxBytes} bytes).`);
}

async function loadNode(): Promise<DeflateBackend | undefined> {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  if (typeof proc?.versions?.node !== "string") return undefined;
  const specifier = "node:zlib";
  let zlib: NodeZlib;
  try {
    zlib = (await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)) as NodeZlib;
  } catch {
    return undefined;
  }
  return {
    name: "node:zlib",
    deflate: async (data) => new Uint8Array(zlib.deflateRawSync(data, { level: 6 })),
    inflate: async (data, maxBytes) => {
      try {
        // maxOutputLength must be ≥ 1
        return new Uint8Array(zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) }));
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE") return tooLarge(maxBytes);
        return fail("ParseError", "Corrupt compressed data in the ZIP file.");
      }
    },
  };
}

async function pump(stream: StreamPair, data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = writer.write(data).then(() => writer.close());
  written.catch(() => undefined);
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    let r: ReadResult;
    try {
      r = await reader.read();
    } catch {
      return fail("ParseError", "Corrupt compressed data in the ZIP file.");
    }
    if (r.done || !r.value) break;
    total += r.value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLarge(maxBytes);
    }
    chunks.push(r.value);
  }
  try {
    await written;
  } catch {
    return fail("ParseError", "Corrupt compressed data in the ZIP file.");
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

type StreamCtor = new (format: string) => StreamPair;

/** @internal Backend built on CompressionStream / DecompressionStream, if available. */
export function webBackend(): DeflateBackend | undefined {
  const g = globalThis as { CompressionStream?: StreamCtor; DecompressionStream?: StreamCtor };
  const C = g.CompressionStream;
  const D = g.DecompressionStream;
  if (typeof C !== "function" || typeof D !== "function") return undefined;
  try {
    new D("deflate-raw");
  } catch {
    return undefined;
  }
  return {
    name: "CompressionStream",
    deflate: (data) => pump(new C("deflate-raw"), data, Number.MAX_SAFE_INTEGER),
    inflate: (data, maxBytes) => pump(new D("deflate-raw"), data, maxBytes),
  };
}

/** @internal The backend to use. */
export async function deflateBackend(): Promise<DeflateBackend> {
  if (override) return override;
  nodeBackend ??= loadNode();
  const backend = (await nodeBackend) ?? webBackend();
  if (!backend) return fail("UnsupportedFormat", "No DEFLATE implementation available (needs node:zlib or CompressionStream with \"deflate-raw\").");
  return backend;
}
