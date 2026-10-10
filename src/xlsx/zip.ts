/**
 * Minimal ZIP container support for OOXML: reads stored and deflated entries
 * (no ZIP64, no encryption, single disk) with zip-bomb limits, and writes
 * deflated archives.
 */
import { fail } from "../errors.js";
import { type Limits, limitError } from "../limits.js";
import { fromUtf8, utf8 } from "../platform.js";
import { crc32 } from "./crc32.js";
import { type DeflateBackend, deflateBackend } from "./deflate.js";

interface Entry {
  readonly name: string;
  readonly method: number;
  readonly crc: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly offset: number;
}

const RATIO_MIN_SIZE = 1 << 20;

/** @internal An opened ZIP archive; entries are decompressed on demand. */
export class ZipArchive {
  readonly #bytes: Uint8Array;
  readonly #entries: Map<string, Entry>;
  readonly #limits: Limits;
  #inflated = 0;

  constructor(bytes: Uint8Array, entries: Map<string, Entry>, limits: Limits) {
    this.#bytes = bytes;
    this.#entries = entries;
    this.#limits = limits;
  }

  get names(): string[] {
    return [...this.#entries.keys()];
  }

  has(name: string): boolean {
    return this.#entries.has(name);
  }

  async read(name: string, backend?: DeflateBackend): Promise<Uint8Array> {
    const e = this.#entries.get(name);
    if (!e) return fail("ParseError", `The ZIP archive has no entry "${name}".`);
    const b = this.#bytes;
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (e.offset + 30 > b.length || v.getUint32(e.offset, true) !== 0x04034b50) fail("ParseError", `Corrupt ZIP local header for "${name}".`);
    const start = e.offset + 30 + v.getUint16(e.offset + 26, true) + v.getUint16(e.offset + 28, true);
    if (start + e.compressedSize > b.length) fail("ParseError", `ZIP entry "${name}" extends past the end of the file.`);
    const raw = b.subarray(start, start + e.compressedSize);
    this.#inflated += e.size;
    if (this.#inflated > this.#limits.maxUncompressedBytes) limitError("Total uncompressed size", this.#limits.maxUncompressedBytes);
    let data: Uint8Array;
    if (e.method === 0) data = raw;
    else data = await (backend ?? (await deflateBackend())).inflate(raw, e.size);
    if (data.length !== e.size) fail("ParseError", `ZIP entry "${name}" does not match its declared size.`);
    if (crc32(data) !== e.crc) fail("ParseError", `CRC mismatch in ZIP entry "${name}".`);
    return data;
  }

  async text(name: string, backend?: DeflateBackend): Promise<string> {
    return fromUtf8(await this.read(name, backend));
  }
}

/** @internal True when the bytes start like a ZIP file. */
export function looksLikeZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6);
}

/** @internal Parses the central directory. */
export function openZip(b: Uint8Array, limits: Limits): ZipArchive {
  if (b.length > limits.maxInputBytes) limitError("Input size", limits.maxInputBytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i >= b.length - 22 - 0xffff; i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return fail("ParseError", "Not a ZIP file (no end-of-central-directory record).");
  const disk = v.getUint16(eocd + 4, true);
  const cdDisk = v.getUint16(eocd + 6, true);
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail("UnsupportedFormat", "ZIP64 archives are not supported.");
  if (disk !== 0 || cdDisk !== 0) fail("UnsupportedFormat", "Multi-disk ZIP archives are not supported.");
  if (count > limits.maxZipEntries) limitError("Number of ZIP entries", limits.maxZipEntries);
  if (cdOffset + cdSize > eocd) fail("ParseError", "Corrupt ZIP central directory.");
  const entries = new Map<string, Entry>();
  let p = cdOffset;
  let declared = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > eocd || v.getUint32(p, true) !== 0x02014b50) fail("ParseError", "Corrupt ZIP central directory entry.");
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const crc = v.getUint32(p + 16, true);
    const compressedSize = v.getUint32(p + 20, true);
    const size = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const offset = v.getUint32(p + 42, true);
    if (p + 46 + nameLen > eocd) fail("ParseError", "Corrupt ZIP central directory entry.");
    const name = fromUtf8(b.subarray(p + 46, p + 46 + nameLen)).replace(/^\/+/, "");
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) fail("UnsupportedFormat", "Encrypted ZIP entries (password-protected workbooks) are not supported.");
    if (compressedSize === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) fail("UnsupportedFormat", "ZIP64 archives are not supported.");
    if (method !== 0 && method !== 8) fail("UnsupportedFormat", `ZIP compression method ${method} is not supported (only stored and deflate).`);
    if (method === 0 && compressedSize !== size) fail("ParseError", `Corrupt stored ZIP entry "${name}".`);
    declared += size;
    if (declared > limits.maxUncompressedBytes) limitError("Total uncompressed size", limits.maxUncompressedBytes);
    if (size > RATIO_MIN_SIZE && size / Math.max(compressedSize, 1) > limits.maxCompressionRatio) limitError("Compression ratio", limits.maxCompressionRatio);
    if (!entries.has(name)) entries.set(name, { name, method, crc, compressedSize, size, offset });
  }
  return new ZipArchive(b, entries, limits);
}

/** @internal Writes a ZIP archive (deflate, or stored when that is smaller). */
export async function writeZip(files: readonly { readonly name: string; readonly data: Uint8Array }[], backend?: DeflateBackend): Promise<Uint8Array> {
  const deflater = backend ?? (await deflateBackend());
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name);
    const crc = crc32(file.data);
    let data = await deflater.deflate(file.data);
    let method = 8;
    if (data.length >= file.data.length) {
      data = file.data;
      method = 0;
    }
    if (file.data.length > 0xfffffffe || offset > 0xfffffffe) fail("LimitExceeded", "The workbook is too large for a ZIP file without ZIP64.");
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // 00:00
    lv.setUint16(12, 0x21, true); // 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, file.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, file.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}
