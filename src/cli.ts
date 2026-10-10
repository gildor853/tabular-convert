#!/usr/bin/env node
/** Node.js entry point for the `tabular-convert` command. */
import { type CliIo, main } from "./cli-main.js";

interface NodeStream {
  write(chunk: Uint8Array | string, callback?: (err?: Error | null) => void): boolean;
}
interface NodeProcess {
  argv: string[];
  exitCode?: number;
  stdin: AsyncIterable<Uint8Array>;
  stdout: NodeStream;
  stderr: NodeStream;
}
interface NodeFs {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
}

const proc = (globalThis as unknown as { process: NodeProcess }).process;
const fsName = "node:fs/promises";
let fsModule: Promise<NodeFs> | undefined;
const fs = () => (fsModule ??= import(/* @vite-ignore */ fsName) as Promise<NodeFs>);

const write = (stream: NodeStream, data: Uint8Array | string) =>
  new Promise<void>((resolve, reject) => {
    stream.write(data, (err) => (err ? reject(err) : resolve()));
  });

const io: CliIo = {
  readFile: async (path) => new Uint8Array(await (await fs()).readFile(path)),
  writeFile: async (path, data) => (await fs()).writeFile(path, data),
  readStdin: async () => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of proc.stdin) {
      chunks.push(chunk);
      total += chunk.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  },
  stdout: (data) => write(proc.stdout, data),
  stderr: (text) => {
    proc.stderr.write(text);
  },
};

main(proc.argv.slice(2), io).then(
  (code) => {
    proc.exitCode = code;
  },
  (err: unknown) => {
    proc.stderr.write(`tabular-convert: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    proc.exitCode = 1;
  },
);
