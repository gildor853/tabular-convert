/**
 * Small non-validating XML parser for OOXML parts. Linear in the input size,
 * no DTDs (any `<!DOCTYPE` / `<!ENTITY` is rejected, so no XXE or entity
 * expansion), only the five predefined and numeric character references.
 */
import { fail } from "../errors.js";

/** @internal Attribute map keyed by local name (prefix dropped). */
export type Attrs = Map<string, string>;

/** @internal */
export interface XmlHandlers {
  open?(name: string, attrs: Attrs): void;
  close?(name: string): void;
  text?(text: string): void;
}

const NAME = /[A-Za-z_:\u00c0-\uffff][-A-Za-z0-9_:.\u00b7-\uffff]*/y;
const ATTR = /\s+([^\s=/>]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;
const END_TAG = /<\/([^\s>]+)\s*>/y;

const PREDEFINED: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
});

function decode(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&([^;&]{0,10});?/g, (m, ref: string) => {
    if (!m.endsWith(";")) return fail("ParseError", "Invalid XML: unescaped '&'.");
    const named = PREDEFINED[ref];
    if (named !== undefined) return named;
    const num = /^#(?:(\d{1,7})|x([0-9a-fA-F]{1,6}))$/.exec(ref);
    if (num) {
      const cp = num[1] !== undefined ? Number.parseInt(num[1], 10) : Number.parseInt(num[2] as string, 16);
      if (cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return String.fromCodePoint(cp);
    }
    return fail("ParseError", `Invalid XML: unsupported entity reference "&${ref};".`);
  });
}

function local(name: string): string {
  const i = name.indexOf(":");
  return i < 0 ? name : name.slice(i + 1);
}

/** @internal Parses `xml`, calling the handlers with local names. */
export function parseXml(xml: string, handlers: XmlHandlers, maxDepth: number): void {
  const n = xml.length;
  const stack: string[] = [];
  let i = 0;
  let seenRoot = false;
  const bad = (msg: string): never => fail("ParseError", `Invalid XML: ${msg}.`);
  while (i < n) {
    const lt = xml.indexOf("<", i);
    const end = lt < 0 ? n : lt;
    if (end > i) {
      const raw = xml.slice(i, end);
      if (stack.length > 0) handlers.text?.(decode(raw.replace(/\r\n?/g, "\n")));
      else if (raw.trim() !== "") bad("text outside the root element");
    }
    if (lt < 0) break;
    i = lt;
    const next = xml[i + 1];
    if (next === "?") {
      const e = xml.indexOf("?>", i + 2);
      if (e < 0) bad("unterminated processing instruction");
      i = e + 2;
    } else if (next === "!") {
      if (xml.startsWith("<!--", i)) {
        const e = xml.indexOf("-->", i + 4);
        if (e < 0) bad("unterminated comment");
        i = e + 3;
      } else if (xml.startsWith("<![CDATA[", i)) {
        const e = xml.indexOf("]]>", i + 9);
        if (e < 0) bad("unterminated CDATA section");
        if (stack.length === 0) bad("CDATA outside the root element");
        handlers.text?.(xml.slice(i + 9, e).replace(/\r\n?/g, "\n"));
        i = e + 3;
      } else {
        return bad("DOCTYPE and entity declarations are not allowed");
      }
    } else if (next === "/") {
      END_TAG.lastIndex = i;
      const m = END_TAG.exec(xml);
      if (!m) return bad("malformed end tag");
      const name = local(m[1] as string);
      if (stack.pop() !== name) bad(`unexpected </${m[1]}>`);
      handlers.close?.(name);
      i = END_TAG.lastIndex;
    } else {
      NAME.lastIndex = i + 1;
      const nm = NAME.exec(xml);
      if (!nm) return bad("malformed start tag");
      if (stack.length === 0 && seenRoot) bad("more than one root element");
      seenRoot = true;
      const name = local(nm[0]);
      const attrs: Attrs = new Map();
      let p = NAME.lastIndex;
      for (;;) {
        ATTR.lastIndex = p;
        const a = ATTR.exec(xml);
        if (!a) break;
        attrs.set(local(a[1] as string), decode((a[2] ?? a[3] ?? "").replace(/[\t\n\r]/g, " ")));
        p = ATTR.lastIndex;
      }
      TAG_END.lastIndex = p;
      const te = TAG_END.exec(xml);
      if (!te) return bad(`malformed tag <${nm[0]}>`);
      i = TAG_END.lastIndex;
      if (stack.length >= maxDepth) fail("LimitExceeded", `XML nesting exceeds the limit of ${maxDepth} (raise it with the "limits" option).`);
      handlers.open?.(name, attrs);
      if (te[1] === "/") handlers.close?.(name);
      else stack.push(name);
    }
  }
  if (stack.length > 0) bad(`unclosed <${stack[stack.length - 1]}>`);
  if (!seenRoot) bad("no root element");
}

/** @internal Escapes XML text / attribute content. */
export function escapeXml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"));
}

/** @internal Decodes OOXML `_xHHHH_` escapes. */
export function decodeOoxml(text: string): string {
  if (!text.includes("_x")) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** @internal Encodes characters XML cannot carry (and literal `_xHHHH_`) as OOXML `_xHHHH_` escapes. */
export function encodeOoxml(text: string): string {
  return text.replace(
    /_(?=x[0-9A-Fa-f]{4}_)|[\u0000-\u0008\u000b-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g,
    (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`,
  );
}
