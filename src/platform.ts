/** Minimal typings for the web-platform globals used here (the build has no DOM lib). */
import { fail } from "./errors.js";

interface TextDecoderLike {
  decode(bytes: Uint8Array): string;
}
type TextDecoderCtor = new (label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) => TextDecoderLike;
interface TextEncoderLike {
  encode(text: string): Uint8Array;
}

/** @internal Throws InvalidOption for an unknown label. */
export function textDecoder(label: string, options: { fatal?: boolean; ignoreBOM?: boolean } = {}): TextDecoderLike {
  const C = (globalThis as { TextDecoder?: TextDecoderCtor }).TextDecoder;
  if (typeof C !== "function") return fail("UnsupportedFormat", "TextDecoder is not available in this environment.");
  try {
    return new C(label, options);
  } catch {
    return fail("InvalidOption", `Unsupported encoding ${JSON.stringify(label)}.`);
  }
}

let encoder: TextEncoderLike | undefined;

/** @internal UTF-8 encode. */
export function utf8(text: string): Uint8Array {
  if (!encoder) {
    const C = (globalThis as { TextEncoder?: new () => TextEncoderLike }).TextEncoder;
    if (typeof C !== "function") return fail("UnsupportedFormat", "TextEncoder is not available in this environment.");
    encoder = new C();
  }
  return encoder.encode(text);
}

let utf8Decoder: TextDecoderLike | undefined;

/** @internal UTF-8 decode (lenient, BOM kept). */
export function fromUtf8(bytes: Uint8Array): string {
  utf8Decoder ??= textDecoder("utf-8", { ignoreBOM: true });
  return utf8Decoder.decode(bytes);
}
