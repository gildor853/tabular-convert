/**
 * Read-only support for legacy Excel 97–2003 workbooks (BIFF8 inside a
 * Compound File Binary container). Cell values only: shared and inline
 * strings, numbers (NUMBER / RK / MULRK), booleans and errors, and the cached
 * results of formulas. Dates are recognised through the cell's number format.
 */
import { fail, show } from "../errors.js";
import { type Input, opts, toBytes } from "../input.js";
import { type Limits, limitError, resolveLimits } from "../limits.js";
import { textDecoder } from "../platform.js";
import type { Cell, Table } from "../table.js";
import { type NumberKind, numberKind, serialToDate } from "./dates.js";
import { finishGrid, type XlsxReadOptions } from "./read.js";

export type XlsReadOptions = XlsxReadOptions;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;

/** @internal True when the bytes start with the CFB signature. */
export function looksLikeCfb(b: Uint8Array): boolean {
  return b.length >= 8 && SIGNATURE.every((x, i) => b[i] === x);
}

const corrupt = (what: string): never => fail("ParseError", `Corrupt XLS file: ${what}.`);

/** @internal Extracts one stream (by name, case-insensitive) from a compound file. */
export function cfbStream(b: Uint8Array, names: readonly string[], limits: Limits): Uint8Array | undefined {
  if (!looksLikeCfb(b) || b.length < 512) return corrupt("bad header");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const shift = v.getUint16(0x1e, true);
  if (shift !== 9 && shift !== 12) corrupt("unsupported sector size");
  const size = 1 << shift;
  const miniShift = v.getUint16(0x20, true);
  if (miniShift !== 6) corrupt("unsupported mini sector size");
  const sectorCount = Math.floor((b.length - size) / size) + (b.length % size ? 1 : 0);
  const fatSectors = v.getUint32(0x2c, true);
  const firstDir = v.getUint32(0x30, true);
  const cutoff = v.getUint32(0x38, true);
  const firstMiniFat = v.getUint32(0x3c, true);
  let difatSector = v.getUint32(0x44, true);
  const difatCount = v.getUint32(0x48, true);
  if (fatSectors > sectorCount) corrupt("FAT larger than the file");
  const offsetOf = (sid: number) => {
    const off = (sid + 1) * size;
    if (sid >= sectorCount || off + size > b.length + size) corrupt(`sector ${sid} is out of range`);
    return off;
  };
  // FAT sector list from the header DIFAT and the DIFAT chain
  const fatList: number[] = [];
  for (let k = 0; k < 109 && fatList.length < fatSectors; k++) fatList.push(v.getUint32(0x4c + k * 4, true));
  for (let d = 0; d < difatCount && fatList.length < fatSectors; d++) {
    if (difatSector === END_OF_CHAIN || difatSector === FREE) break;
    const off = offsetOf(difatSector);
    const per = size / 4 - 1;
    for (let k = 0; k < per && fatList.length < fatSectors; k++) fatList.push(v.getUint32(off + k * 4, true));
    difatSector = v.getUint32(off + per * 4, true);
  }
  const fat = new Uint32Array(fatList.length * (size / 4));
  fatList.forEach((sid, k) => {
    const off = offsetOf(sid);
    for (let j = 0; j < size / 4; j++) fat[k * (size / 4) + j] = off + j * 4 + 4 <= b.length ? v.getUint32(off + j * 4, true) : FREE;
  });
  const chain = (start: number, table: Uint32Array, limit: number): number[] => {
    const out: number[] = [];
    let sid = start;
    while (sid !== END_OF_CHAIN) {
      if (sid >= table.length || out.length > limit) corrupt("broken sector chain");
      out.push(sid);
      sid = table[sid] as number;
    }
    return out;
  };
  const readChain = (start: number, length: number | undefined): Uint8Array => {
    const sids = chain(start, fat, sectorCount);
    const total = length ?? sids.length * size;
    if (total > sids.length * size) corrupt("stream shorter than its declared size");
    const out = new Uint8Array(total);
    let pos = 0;
    for (const sid of sids) {
      if (pos >= total) break;
      const off = offsetOf(sid);
      const part = b.subarray(off, Math.min(off + size, off + total - pos, b.length));
      out.set(part, pos);
      pos += part.length;
    }
    if (pos < total) corrupt("stream runs past the end of the file");
    return out;
  };
  const dir = readChain(firstDir, undefined);
  const dv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  const utf16 = textDecoder("utf-16le");
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = Math.min(dv.getUint16(off + 0x40, true), 64);
    const name = utf16.decode(dir.subarray(off, off + Math.max(0, nameLen - 2)));
    entries.push({ name, type: dir[off + 0x42] as number, start: dv.getUint32(off + 0x74, true), size: dv.getUint32(off + 0x78, true) });
  }
  const root = entries[0];
  if (!root || root.type !== 5) return corrupt("missing root entry");
  const wanted = names.map((n) => n.toLowerCase());
  const entry = entries.find((e) => e.type === 2 && wanted.includes(e.name.toLowerCase()));
  if (!entry) return undefined;
  if (entry.size > limits.maxInputBytes) limitError("Workbook stream size", limits.maxInputBytes);
  if (entry.size >= cutoff) return readChain(entry.start, entry.size);
  // small stream: lives in the mini stream (root entry's chain), indexed by the mini FAT
  const miniStream = readChain(root.start, root.size);
  const miniFatBytes = firstMiniFat === END_OF_CHAIN ? new Uint8Array(0) : readChain(firstMiniFat, undefined);
  const miniFat = new Uint32Array(miniFatBytes.length / 4);
  const mv = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  for (let k = 0; k < miniFat.length; k++) miniFat[k] = mv.getUint32(k * 4, true);
  const sids = chain(entry.start, miniFat, miniFat.length);
  if (entry.size > sids.length * 64) corrupt("mini stream shorter than its declared size");
  const out = new Uint8Array(entry.size);
  let pos = 0;
  for (const sid of sids) {
    if (pos >= entry.size) break;
    const off = sid * 64;
    if (off + 64 > miniStream.length + 64) corrupt("mini sector out of range");
    const part = miniStream.subarray(off, Math.min(off + 64, off + entry.size - pos));
    out.set(part, pos);
    pos += part.length;
  }
  if (pos < entry.size) corrupt("mini stream runs past its end");
  return out;
}

/** @internal "Compressed" BIFF8 text: UTF-16 code units with a zero high byte (true ISO-8859-1, not windows-1252). */
function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

interface Rec {
  readonly type: number;
  readonly data: Uint8Array;
}

/** @internal Reads strings that may continue across CONTINUE records (each continuation re-states the high-byte flag). */
class SegmentReader {
  readonly #segs: readonly Uint8Array[];
  #seg = 0;
  #off = 0;
  readonly #utf16 = textDecoder("utf-16le");

  constructor(segs: readonly Uint8Array[]) {
    this.#segs = segs;
  }

  #current(): Uint8Array {
    for (;;) {
      const s = this.#segs[this.#seg];
      if (!s) return corrupt("string runs past its record");
      if (this.#off < s.length) return s;
      this.#seg++;
      this.#off = 0;
    }
  }

  u8(): number {
    const s = this.#current();
    return s[this.#off++] as number;
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(n: number): void {
    while (n > 0) {
      const s = this.#current();
      const k = Math.min(n, s.length - this.#off);
      this.#off += k;
      n -= k;
    }
  }

  get atEnd(): boolean {
    for (let k = this.#seg; k < this.#segs.length; k++) if ((k === this.#seg ? this.#off : 0) < (this.#segs[k] as Uint8Array).length) return false;
    return true;
  }

  /** XLUnicodeRichExtendedString (also covers XLUnicodeString when the flags have no rich/ext bits). */
  string(maxLength: number): string {
    const cch = this.u16();
    let flags = this.u8();
    const runs = flags & 0x08 ? this.u16() : 0;
    const ext = flags & 0x04 ? this.u32() : 0;
    if (cch > maxLength) limitError("Cell length", maxLength);
    const parts: string[] = [];
    let left = cch;
    let first = true;
    while (left > 0) {
      if (!first) {
        // a continued string starts its CONTINUE record with a fresh flags byte
        this.#current();
        flags = this.u8();
      }
      first = false;
      const s = this.#current();
      const wide = flags & 0x01 ? 2 : 1;
      const avail = Math.floor((s.length - this.#off) / wide);
      const take = Math.min(left, avail);
      if (take === 0) {
        this.#seg++;
        this.#off = 0;
        continue;
      }
      const bytes = s.subarray(this.#off, this.#off + take * wide);
      parts.push(wide === 2 ? this.#utf16.decode(bytes) : latin1(bytes));
      this.#off += take * wide;
      left -= take;
      if (left > 0) {
        this.#seg++;
        this.#off = 0;
      }
    }
    this.skip(runs * 4 + ext);
    return parts.join("");
  }
}

function records(stream: Uint8Array, start: number): Rec[] {
  const out: Rec[] = [];
  let p = start;
  let depth = 0;
  while (p + 4 <= stream.length) {
    const type = (stream[p] as number) | ((stream[p + 1] as number) << 8);
    const len = (stream[p + 2] as number) | ((stream[p + 3] as number) << 8);
    if (p + 4 + len > stream.length) corrupt("record runs past the end of the stream");
    p += 4 + len;
    // Embedded substreams (charts) sit between their own BOF and EOF: skip them.
    if (type === 0x0809 && out.length > 0) depth++;
    else if (type === 0x000a && depth > 0) depth--;
    else if (depth === 0) {
      out.push({ type, data: stream.subarray(p - len, p) });
      if (type === 0x000a) break; // EOF
    }
  }
  return out;
}

const ERRORS: Readonly<Record<number, string>> = { 0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!", 0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A" };

function rk(value: number): number {
  let n: number;
  if (value & 0x02) n = value >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, value & 0xfffffffc, true);
    n = buf.getFloat64(0, true);
  }
  return value & 0x01 ? n / 100 : n;
}

interface Globals {
  readonly date1904: boolean;
  readonly kinds: NumberKind[];
  readonly sst: string[];
  readonly sheets: { name: string; offset: number }[];
}

function readGlobals(stream: Uint8Array, limits: Limits): Globals {
  const recs = records(stream, 0);
  const bof = recs[0];
  if (!bof || (bof.type !== 0x0809 && bof.type !== 0x0409 && bof.type !== 0x0209 && bof.type !== 0x0009)) corrupt("missing BOF record");
  const version = (bof as Rec).data.length >= 2 ? ((bof as Rec).data[0] as number) | (((bof as Rec).data[1] as number) << 8) : 0;
  if ((bof as Rec).type !== 0x0809 || version !== 0x0600) fail("UnsupportedFormat", "Only Excel 97–2003 (BIFF8) .xls files are supported; this one is older.");
  let date1904 = false;
  const formats = new Map<number, string>();
  const xfFormats: number[] = [];
  let sst: string[] = [];
  const sheets: { name: string; offset: number }[] = [];
  for (let k = 1; k < recs.length; k++) {
    const r = recs[k] as Rec;
    const d = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    switch (r.type) {
      case 0x002f:
        fail("UnsupportedFormat", "Encrypted (password-protected) .xls files are not supported.");
        break;
      case 0x0022:
        date1904 = r.data.length >= 2 && d.getUint16(0, true) === 1;
        break;
      case 0x041e: {
        if (r.data.length < 5) break;
        const reader = new SegmentReader([r.data.subarray(2)]);
        formats.set(d.getUint16(0, true), reader.string(limits.maxCellLength));
        break;
      }
      case 0x00e0:
        if (r.data.length >= 4) xfFormats.push(d.getUint16(2, true));
        break;
      case 0x0085: {
        if (r.data.length < 8) break;
        const offset = d.getUint32(0, true);
        const dt = r.data[5];
        const cch = r.data[6] as number;
        const wide = (r.data[7] as number) & 1;
        const bytes = r.data.subarray(8, 8 + cch * (wide ? 2 : 1));
        const name = wide ? textDecoder("utf-16le").decode(bytes) : latin1(bytes);
        if (dt === 0) sheets.push({ name, offset });
        break;
      }
      case 0x00fc: {
        const segs = [r.data.subarray(8)];
        while (recs[k + 1]?.type === 0x003c) segs.push((recs[++k] as Rec).data);
        const unique = r.data.length >= 8 ? d.getUint32(4, true) : 0;
        const reader = new SegmentReader(segs);
        sst = [];
        for (let s = 0; s < unique && !reader.atEnd; s++) sst.push(reader.string(limits.maxCellLength));
        break;
      }
    }
  }
  return { date1904, kinds: xfFormats.map((id) => numberKind(id, formats.get(id))), sst, sheets };
}

function readSheet(stream: Uint8Array, offset: number, g: Globals, limits: Limits): { index: number; row: Cell[] }[] {
  if (offset >= stream.length) corrupt("sheet offset out of range");
  const recs = records(stream, offset);
  if (recs[0]?.type !== 0x0809) corrupt("sheet does not start with BOF");
  const rows = new Map<number, Cell[]>();
  const put = (r: number, c: number, cell: Cell) => {
    if (c >= limits.maxColumns) limitError("Number of columns", limits.maxColumns);
    if (r >= limits.maxRows + 1) limitError("Number of rows", limits.maxRows);
    let row = rows.get(r);
    if (!row) {
      row = [];
      rows.set(r, row);
    }
    while (row.length < c) row.push(null);
    row[c] = cell;
  };
  const num = (ixfe: number, n: number): Cell => {
    const kind = g.kinds[ixfe];
    return kind === "date" ? (serialToDate(n, g.date1904) ?? n) : kind === "boolean" ? n !== 0 : n;
  };
  let pendingString: { r: number; c: number } | undefined;
  for (let k = 1; k < recs.length; k++) {
    const rec = recs[k] as Rec;
    const data = rec.data;
    const d = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const need = (n: number) => {
      if (data.length < n) corrupt(`record 0x${rec.type.toString(16)} is too short`);
    };
    switch (rec.type) {
      case 0x00fd: {
        need(10);
        const idx = d.getUint32(6, true);
        const s = g.sst[idx];
        if (s === undefined) corrupt(`shared string ${idx} does not exist`);
        put(d.getUint16(0, true), d.getUint16(2, true), s as string);
        break;
      }
      case 0x0204:
      case 0x00d6: {
        need(9);
        put(d.getUint16(0, true), d.getUint16(2, true), new SegmentReader([data.subarray(6)]).string(limits.maxCellLength));
        break;
      }
      case 0x0203:
        need(14);
        put(d.getUint16(0, true), d.getUint16(2, true), num(d.getUint16(4, true), d.getFloat64(6, true)));
        break;
      case 0x027e:
        need(10);
        put(d.getUint16(0, true), d.getUint16(2, true), num(d.getUint16(4, true), rk(d.getUint32(6, true))));
        break;
      case 0x00bd: {
        need(6);
        const r = d.getUint16(0, true);
        const first = d.getUint16(2, true);
        const count = Math.floor((data.length - 6) / 6);
        for (let j = 0; j < count; j++) put(r, first + j, num(d.getUint16(4 + j * 6, true), rk(d.getUint32(6 + j * 6, true))));
        break;
      }
      case 0x0205: {
        need(8);
        const value = data[6] as number;
        put(d.getUint16(0, true), d.getUint16(2, true), data[7] ? (ERRORS[value] ?? "#ERROR") : value !== 0);
        break;
      }
      case 0x0006: {
        need(20);
        const r = d.getUint16(0, true);
        const c = d.getUint16(2, true);
        if (d.getUint16(12, true) === 0xffff) {
          const kind = data[6];
          if (kind === 0) pendingString = { r, c };
          else if (kind === 1) put(r, c, data[8] !== 0);
          else if (kind === 2) put(r, c, ERRORS[data[8] as number] ?? "#ERROR");
          else if (kind === 3) put(r, c, "");
        } else {
          put(r, c, num(d.getUint16(4, true), d.getFloat64(6, true)));
        }
        break;
      }
      case 0x0207: {
        const segs = [data];
        while (recs[k + 1]?.type === 0x003c) segs.push((recs[++k] as Rec).data);
        const s = new SegmentReader(segs).string(limits.maxCellLength);
        if (pendingString) put(pendingString.r, pendingString.c, s);
        pendingString = undefined;
        break;
      }
    }
  }
  return [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([index, row]) => ({ index, row }));
}

function openXls(input: Input, limits: Limits): { stream: Uint8Array; globals: Globals } {
  const bytes = toBytes(input, limits);
  if (!looksLikeCfb(bytes)) fail("ParseError", "Not an XLS file (no compound-file signature).");
  const stream = cfbStream(bytes, ["Workbook"], limits);
  if (!stream) {
    if (cfbStream(bytes, ["Book"], limits)) fail("UnsupportedFormat", "Only Excel 97–2003 (BIFF8) .xls files are supported; this one is Excel 5/95 or older.");
    return fail("UnsupportedFormat", "This compound file has no Excel workbook stream (is it a Word or other Office 97 file?).");
  }
  return { stream, globals: readGlobals(stream, limits) };
}

/** @internal */
export function readXlsImpl(input: Input, options: unknown): Table {
  const o = opts(options);
  const limits = resolveLimits(o.limits);
  const { stream, globals } = openXls(input, limits);
  if (globals.sheets.length === 0) fail("ParseError", "The workbook has no worksheets.");
  const names = globals.sheets.map((s) => show(s.name)).join(", ");
  const sel = o.sheet;
  let sheet: { name: string; offset: number } | undefined;
  if (sel === undefined) sheet = globals.sheets[0];
  else if (typeof sel === "number") {
    sheet = Number.isInteger(sel) ? globals.sheets[sel] : undefined;
    if (!sheet) fail("InvalidOption", `Sheet index ${sel} is out of range; the workbook has ${globals.sheets.length} sheet(s): ${names}.`);
  } else if (typeof sel === "string") {
    sheet = globals.sheets.find((s) => s.name === sel) ?? globals.sheets.find((s) => s.name.toLowerCase() === sel.toLowerCase());
    if (!sheet) fail("InvalidOption", `No sheet named ${show(sel)}; sheets: ${names}.`);
  } else fail("InvalidOption", `Option "sheet" must be a name or a 0-based index, got ${show(sel)}.`);
  return finishGrid(readSheet(stream, (sheet as { offset: number }).offset, globals, limits), o, limits);
}

/** @internal */
export function listXlsSheetsImpl(input: Input, options: unknown): string[] {
  const o = opts(options);
  return openXls(input, resolveLimits(o.limits)).globals.sheets.map((s) => s.name);
}
