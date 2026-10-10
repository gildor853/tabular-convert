// Minimal BIFF8 + Compound File writer for synthetic .xls test inputs.
const cat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
export const u8 = (...xs: number[]) => new Uint8Array(xs);
export const u16 = (x: number) => u8(x & 0xff, (x >> 8) & 0xff);
export const u32 = (x: number) => u8(x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff);
export const f64 = (x: number) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, x, true);
  return b;
};
export const bytes = cat;

export function rec(type: number, ...parts: Uint8Array[]): Uint8Array {
  const data = cat(parts);
  return cat([u16(type), u16(data.length), data]);
}

/** Character bytes of a string, compressed (1 byte) when possible. */
export function chars(s: string, wide = [...s].some((c) => c.charCodeAt(0) > 0xff)): { flag: number; data: Uint8Array } {
  if (!wide) return { flag: 0, data: u8(...[...s].map((c) => c.charCodeAt(0))) };
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    b[i * 2] = s.charCodeAt(i) & 0xff;
    b[i * 2 + 1] = s.charCodeAt(i) >> 8;
  }
  return { flag: 1, data: b };
}

/** XLUnicodeString (16-bit length). */
export function xlString(s: string, wide?: boolean): Uint8Array {
  const c = chars(s, wide);
  return cat([u16(s.length), u8(c.flag), c.data]);
}

export const BOF_GLOBALS = rec(0x0809, u16(0x0600), u16(0x0005), u16(0), u16(0), u32(0), u32(0));
export const BOF_SHEET = rec(0x0809, u16(0x0600), u16(0x0010), u16(0), u16(0), u32(0), u32(0));
export const EOF = rec(0x000a);

export const labelSst = (r: number, c: number, idx: number, xf = 0) => rec(0x00fd, u16(r), u16(c), u16(xf), u32(idx));
export const label = (r: number, c: number, s: string, xf = 0) => rec(0x0204, u16(r), u16(c), u16(xf), xlString(s));
export const number = (r: number, c: number, v: number, xf = 0) => rec(0x0203, u16(r), u16(c), u16(xf), f64(v));
export const rkRec = (r: number, c: number, rk: number, xf = 0) => rec(0x027e, u16(r), u16(c), u16(xf), u32(rk));
export const boolErr = (r: number, c: number, v: number, isError: boolean, xf = 0) => rec(0x0205, u16(r), u16(c), u16(xf), u8(v, isError ? 1 : 0));
export const formulaNum = (r: number, c: number, v: number, xf = 0) => rec(0x0006, u16(r), u16(c), u16(xf), f64(v), u16(0), u32(0), u16(0));
export const formulaSpecial = (r: number, c: number, kind: number, value = 0, xf = 0) =>
  rec(0x0006, u16(r), u16(c), u16(xf), u8(kind, 0, value, 0, 0, 0, 0xff, 0xff), u16(0), u32(0), u16(0));
export const xf = (fmt: number) => rec(0x00e0, u16(0), u16(fmt), u16(0), u8(...new Array(14).fill(0)));
export const format = (id: number, code: string) => rec(0x041e, u16(id), xlString(code));

export interface SheetSpec {
  readonly name: string;
  readonly records: Uint8Array[];
  readonly type?: number; // 0 worksheet, 2 chart
}

/** Workbook stream: globals (BOF, extra records, BOUNDSHEET8s, EOF) followed by sheet substreams. */
export function workbookStream(globals: Uint8Array[], sheets: SheetSpec[], bof = BOF_GLOBALS): Uint8Array {
  const sheetStreams = sheets.map((s) => cat([BOF_SHEET, ...s.records, EOF]));
  const boundLen = (s: SheetSpec) => 4 + 8 + chars(s.name).data.length;
  const globalsLen = bof.length + globals.reduce((n, g) => n + g.length, 0) + sheets.reduce((n, s) => n + boundLen(s), 0) + EOF.length;
  let offset = globalsLen;
  const bounds = sheets.map((s, k) => {
    const c = chars(s.name);
    const r = rec(0x0085, u32(offset), u8(0, s.type ?? 0, s.name.length, c.flag), c.data);
    offset += (sheetStreams[k] as Uint8Array).length;
    return r;
  });
  return cat([bof, ...globals, ...bounds, EOF, ...sheetStreams]);
}

const END = 0xfffffffe;
const FREE = 0xffffffff;

function dirEntry(name: string, type: number, start: number, size: number, child = FREE): Uint8Array {
  const e = new Uint8Array(128);
  const v = new DataView(e.buffer);
  for (let i = 0; i < name.length; i++) v.setUint16(i * 2, name.charCodeAt(i), true);
  v.setUint16(0x40, name.length ? (name.length + 1) * 2 : 0, true);
  e[0x42] = type;
  v.setUint32(0x44, FREE, true);
  v.setUint32(0x48, FREE, true);
  v.setUint32(0x4c, child, true);
  v.setUint32(0x74, start, true);
  v.setUint32(0x78, size, true);
  return e;
}

/**
 * Compound file (v3, 512-byte sectors) with one stream. Streams shorter than
 * 4096 bytes go to the mini stream unless `padTo` makes them longer.
 */
export function cfb(streamName: string, data: Uint8Array, options: { loop?: boolean } = {}): Uint8Array {
  const S = 512;
  const mini = data.length < 4096;
  const sectors: Uint8Array[] = [];
  const fatEntries: number[] = [];
  const addChain = (payload: Uint8Array): number => {
    const n = Math.max(1, Math.ceil(payload.length / S));
    const start = sectors.length;
    for (let k = 0; k < n; k++) {
      const s = new Uint8Array(S);
      s.set(payload.subarray(k * S, (k + 1) * S));
      sectors.push(s);
      fatEntries.push(k === n - 1 ? END : start + k + 1);
    }
    return start;
  };
  let rootStart = END;
  let rootSize = 0;
  let miniFatStart = END;
  let streamStart: number;
  if (mini) {
    const n = Math.ceil(data.length / 64);
    const container = new Uint8Array(n * 64);
    container.set(data);
    rootStart = addChain(container);
    rootSize = container.length;
    const miniFat = new Uint8Array(S).fill(0xff);
    const mv = new DataView(miniFat.buffer);
    for (let k = 0; k < n; k++) mv.setUint32(k * 4, k === n - 1 ? END : k + 1, true);
    if (options.loop && n > 1) mv.setUint32((n - 1) * 4, 0, true);
    miniFatStart = addChain(miniFat);
    streamStart = 0;
  } else {
    streamStart = addChain(data);
    if (options.loop) fatEntries[sectors.length - 1] = streamStart;
  }
  const dir = new Uint8Array(S);
  dir.set(dirEntry("Root Entry", 5, rootStart, rootSize, 1), 0);
  dir.set(dirEntry(streamName, 2, streamStart, data.length), 128);
  const dirStart = addChain(dir);
  // FAT sectors at the end
  const fatCount = Math.ceil((fatEntries.length + 1) / (S / 4));
  const fatStart = sectors.length;
  for (let k = 0; k < fatCount; k++) fatEntries.push(0xfffffffd);
  const fatBytes = new Uint8Array(fatCount * S).fill(0xff);
  const fv = new DataView(fatBytes.buffer);
  fatEntries.forEach((e, k) => fv.setUint32(k * 4, e, true));
  for (let k = 0; k < fatCount; k++) sectors.push(fatBytes.subarray(k * S, (k + 1) * S));
  const header = new Uint8Array(S);
  const hv = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  hv.setUint16(0x18, 0x3e, true);
  hv.setUint16(0x1a, 3, true);
  hv.setUint16(0x1c, 0xfffe, true);
  hv.setUint16(0x1e, 9, true);
  hv.setUint16(0x20, 6, true);
  hv.setUint32(0x2c, fatCount, true);
  hv.setUint32(0x30, dirStart, true);
  hv.setUint32(0x38, 4096, true);
  hv.setUint32(0x3c, miniFatStart, true);
  hv.setUint32(0x40, mini ? 1 : 0, true);
  hv.setUint32(0x44, END, true);
  hv.setUint32(0x48, 0, true);
  for (let k = 0; k < 109; k++) hv.setUint32(0x4c + k * 4, k < fatCount ? fatStart + k : FREE, true);
  return cat([header, ...sectors]);
}
