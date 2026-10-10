import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, readXlsx } from "../src/index.js";
import { crc32 } from "../src/xlsx/crc32.js";
import { deflateBackend, setDeflateBackend, webBackend } from "../src/xlsx/deflate.js";
import { decodeOoxml, encodeOoxml, escapeXml, parseXml } from "../src/xlsx/xml.js";
import { openZip, writeZip } from "../src/xlsx/zip.js";
import { rejectsCode, text, throwsCode, utf8 } from "./helpers/index.js";

function events(xml: string, depth = 64): string[] {
  const out: string[] = [];
  parseXml(xml, { open: (n, a) => out.push(`<${n}${[...a].map(([k, v]) => ` ${k}=${v}`).join("")}>`), close: (n) => out.push(`</${n}>`), text: (t) => out.push(t) }, depth);
  return out;
}

describe("XML parser", () => {
  it("parses elements, attributes, text, CDATA, comments and PIs", () => {
    expect(events('<?xml version="1.0"?>\n<!-- c --><x:a xmlns:x="u" x:b=\'1\' c="&lt;&amp;&#65;&#x42;"><b/>t&gt;<![CDATA[<raw>]]></x:a>\n')).toEqual([
      "<a x=u b=1 c=<&AB>",
      "<b>",
      "</b>",
      "t>",
      "<raw>",
      "</a>",
    ]);
    expect(events('<a v="x\ny\tz">l1\r\nl2\rl3</a>')).toEqual(["<a v=x y z>", "l1\nl2\nl3", "</a>"]);
  });

  it.each([
    ['<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', /DOCTYPE/],
    ['<a><!ENTITY x "y"></a>', /DOCTYPE/],
    ["<a>&x;</a>", /unsupported entity/],
    ["<a>& b</a>", /unescaped/],
    ["<a>&#0;</a>", /unsupported entity/],
    ["<a></b>", /unexpected/],
    ["<a>", /unclosed/],
    ["<a/><b/>", /more than one root/],
    ["text<a/>", /outside the root/],
    ["", /no root/],
    ["<a b=1/>", /malformed tag/],
    ["<a b='<'/>", /malformed tag/],
    ["<1a/>", /malformed start tag/],
    ["<a></ a>", /malformed end tag/],
    ["<a><!-- x</a>", /unterminated comment/],
    ["<a><![CDATA[x</a>", /unterminated CDATA/],
    ["<?xml x", /processing instruction/],
    ["<![CDATA[x]]><a/>", /CDATA outside/],
  ])("rejects %j", (xml, msg) => {
    throwsCode(() => events(xml), "ParseError", msg);
  });

  it("limits nesting depth", () => {
    throwsCode(() => events("<a><a><a></a></a></a>", 2), "LimitExceeded", /nesting/);
  });

  it("is linear on adversarial input", () => {
    const start = performance.now();
    events(`<a>${"<b x='1' y=\"2\">&amp;</b>".repeat(100_000)}</a>`);
    expect(performance.now() - start).toBeLessThan(3000);
  });

  it("encodes and decodes OOXML _xHHHH_ escapes", () => {
    const s = "a\u0001b\u000bc\rd\ue000_x0041_\ud800x\udc00\ufffe";
    const enc = encodeOoxml(s);
    expect(enc).toBe("a_x0001_b_x000B_c_x000D_d\ue000_x005F_x0041__xD800_x_xDC00__xFFFE_");
    expect(decodeOoxml(enc)).toBe(s);
    expect(encodeOoxml("😀\t\n")).toBe("😀\t\n");
    expect(escapeXml('<a b="c">&')).toBe("&lt;a b=&quot;c&quot;&gt;&amp;");
  });
});

describe("CRC32", () => {
  it("matches known values", () => {
    expect(crc32(utf8(""))).toBe(0);
    expect(crc32(utf8("123456789"))).toBe(0xcbf43926);
    expect(crc32(utf8("The quick brown fox jumps over the lazy dog"))).toBe(0x414fa339);
  });
});

/** Builds a ZIP by hand (for malformed / hostile archives). */
function rawZip(entries: { name: string; data: Uint8Array; method?: number; size?: number; crc?: number; flags?: number }[], eocdPatch?: (v: DataView) => void): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const e of entries) {
    const name = utf8(e.name);
    const method = e.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, method, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, e.crc ?? crc32(e.data), true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, e.size ?? e.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, off, true);
    c.set(name, 46);
    parts.push(local, body);
    central.push(c);
    off += local.length + body.length;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, off, true);
  eocdPatch?.(ev);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((s, p) => s + p.length, 0));
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

describe("ZIP", () => {
  afterEach(() => setDeflateBackend(undefined));

  it("round-trips stored and deflated entries", async () => {
    const big = utf8("abc".repeat(10_000));
    const zip = await writeZip([
      { name: "a.txt", data: utf8("hello") },
      { name: "dir/big.txt", data: big },
      { name: "empty", data: new Uint8Array(0) },
      { name: "žluť.xml", data: utf8("<x/>") },
    ]);
    expect(zip.length).toBeLessThan(big.length);
    const z = openZip(zip, DEFAULT_LIMITS);
    expect(z.names).toEqual(["a.txt", "dir/big.txt", "empty", "žluť.xml"]);
    expect(await z.text("a.txt")).toBe("hello");
    expect(await z.read("dir/big.txt")).toEqual(big);
    expect((await z.read("empty")).length).toBe(0);
    expect(await z.text("žluť.xml")).toBe("<x/>");
    await rejectsCode(z.read("missing"), "ParseError", /no entry/);
  });

  it("reads archives written by other tools (stored entries, leading slash)", async () => {
    const z = openZip(rawZip([{ name: "/s.txt", data: utf8("stored"), method: 0 }]), DEFAULT_LIMITS);
    expect(await z.text("s.txt")).toBe("stored");
  });

  it("works with the CompressionStream backend", async () => {
    const web = webBackend();
    expect(web).toBeDefined();
    setDeflateBackend(web);
    expect((await deflateBackend()).name).toBe("CompressionStream");
    const data = utf8("web ".repeat(5000));
    const zip = await writeZip([{ name: "w", data }]);
    expect(await openZip(zip, DEFAULT_LIMITS).read("w")).toEqual(data);
    // a lying declared size is caught while streaming
    const liar = rawZip([{ name: "x", data, size: 100 }]);
    await rejectsCode(openZip(liar, DEFAULT_LIMITS).read("x"), "LimitExceeded");
    const corrupt = rawZip([{ name: "x", data: utf8("zz"), method: 8 }]);
    corrupt[30 + 1] = 0xff;
    corrupt[30 + 2] = 0xff;
    await expect(openZip(corrupt, DEFAULT_LIMITS).read("x")).rejects.toThrow();
  });

  it("uses node:zlib by default in Node.js", async () => {
    expect((await deflateBackend()).name).toBe("node:zlib");
  });

  it("rejects zip bombs", async () => {
    const zeros = new Uint8Array(4 << 20); // 4 MiB of zeros compresses ~1000:1
    const bomb = rawZip([{ name: "x", data: zeros }]);
    throwsCode(() => openZip(bomb, DEFAULT_LIMITS), "LimitExceeded", /Compression ratio/);
    // total declared size
    throwsCode(() => openZip(bomb, { ...DEFAULT_LIMITS, maxCompressionRatio: 1e9, maxUncompressedBytes: 1 << 20 }), "LimitExceeded", /uncompressed/);
    // a lying size field is caught during inflation
    const liar = rawZip([{ name: "x", data: zeros, size: 1000 }]);
    await rejectsCode(openZip(liar, DEFAULT_LIMITS).read("x"), "LimitExceeded", /declared size/);
    // many entries
    const many = rawZip(Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, data: utf8("x"), method: 0 })));
    throwsCode(() => openZip(many, { ...DEFAULT_LIMITS, maxZipEntries: 10 }), "LimitExceeded", /entries/);
    // the inflated size is also counted across reads (re-reading an entry counts again)
    const two = rawZip([{ name: "a", data: utf8("x".repeat(600)) }, { name: "b", data: utf8("y".repeat(600)) }]);
    const z = openZip(two, { ...DEFAULT_LIMITS, maxUncompressedBytes: 1200 });
    await z.read("a");
    await z.read("a");
    await rejectsCode(z.read("b"), "LimitExceeded");
  });

  it("rejects malformed and unsupported archives", async () => {
    throwsCode(() => openZip(utf8("not a zip at all, definitely not"), DEFAULT_LIMITS), "ParseError", /end-of-central-directory/);
    throwsCode(() => openZip(rawZip([{ name: "x", data: utf8("a"), flags: 1 }]), DEFAULT_LIMITS), "UnsupportedFormat", /Encrypted/);
    throwsCode(() => openZip(rawZip([{ name: "x", data: utf8("a"), method: 12 }]), DEFAULT_LIMITS), "UnsupportedFormat", /method 12/);
    throwsCode(() => openZip(rawZip([{ name: "x", data: utf8("a") }], (v) => v.setUint16(10, 0xffff, true)), DEFAULT_LIMITS), "UnsupportedFormat", /ZIP64/);
    throwsCode(() => openZip(rawZip([{ name: "x", data: utf8("a") }], (v) => v.setUint16(4, 1, true)), DEFAULT_LIMITS), "UnsupportedFormat", /Multi-disk/);
    throwsCode(() => openZip(rawZip([{ name: "x", data: utf8("a") }], (v) => v.setUint32(16, 5000, true)), DEFAULT_LIMITS), "ParseError", /central directory/);
    throwsCode(() => openZip(rawZip([{ name: "x", data: utf8("a"), method: 0, size: 5 }]), DEFAULT_LIMITS), "ParseError", /stored/);
    throwsCode(() => openZip(rawZip([{ name: "x", data: utf8("a"), size: 0xffffffff }]), DEFAULT_LIMITS), "UnsupportedFormat", /ZIP64/);
    throwsCode(() => openZip(new Uint8Array(10), DEFAULT_LIMITS), "ParseError");
    throwsCode(() => openZip(new Uint8Array(100), { ...DEFAULT_LIMITS, maxInputBytes: 50 }), "LimitExceeded");
    const badCrc = rawZip([{ name: "x", data: utf8("abc"), crc: 1 }]);
    await rejectsCode(openZip(badCrc, DEFAULT_LIMITS).read("x"), "ParseError", /CRC/);
    const short = rawZip([{ name: "x", data: utf8("abc"), size: 2 }]);
    await rejectsCode(openZip(short, DEFAULT_LIMITS).read("x"), "LimitExceeded");
    const long = rawZip([{ name: "x", data: utf8("abc"), size: 10 }]);
    await rejectsCode(openZip(long, DEFAULT_LIMITS).read("x"), "ParseError", /declared size/);
    const garbage = rawZip([{ name: "x", data: utf8("abc") }]);
    garbage[30 + 1] = 0xff; // corrupt deflate stream
    garbage[30 + 2] = 0xff;
    await rejectsCode(openZip(garbage, DEFAULT_LIMITS).read("x"), "ParseError");
    const badLocal = rawZip([{ name: "x", data: utf8("abc") }]);
    badLocal[0] = 0;
    await rejectsCode(openZip(badLocal, DEFAULT_LIMITS).read("x"), "ParseError", /local header/);
  });

  it("rejects XLSX parts with a DOCTYPE (XXE)", async () => {
    const zip = await writeZip([
      { name: "_rels/.rels", data: utf8('<?xml version="1.0"?><!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><Relationships>&xxe;</Relationships>') },
    ]);
    await rejectsCode(readXlsx(zip), "ParseError", /DOCTYPE/);
    expect(text(utf8("ok"))).toBe("ok");
  });
});
