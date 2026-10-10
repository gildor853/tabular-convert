/**
 * Excel date serials. The 1900 date system counts 1900-01-01 as day 1 and
 * includes the non-existent 1900-02-29 (day 60, Lotus 1-2-3 compatibility);
 * the 1904 system counts 1904-01-01 as day 0.
 */
const DAY = 86_400_000;
const EPOCH_1900_EARLY = Date.UTC(1899, 11, 31); // serials 1..59
const EPOCH_1900 = Date.UTC(1899, 11, 30); // serials ≥ 61
const EPOCH_1904 = Date.UTC(1904, 0, 1);
const MAX_SERIAL_1900 = 2_958_465; // 9999-12-31
const MAX_SERIAL_1904 = MAX_SERIAL_1900 - 1462;

function fromSerial(serial: number, epoch: number): Date {
  const days = Math.floor(serial);
  const ms = Math.round((serial - days) * DAY);
  return new Date(epoch + days * DAY + ms);
}

/**
 * @internal Serial → Date (UTC), or `undefined` when the serial is not a
 * representable date (negative, beyond 9999-12-31, or the phantom 1900-02-29).
 */
export function serialToDate(serial: number, date1904: boolean): Date | undefined {
  if (!Number.isFinite(serial) || serial < 0) return undefined;
  if (date1904) return serial >= MAX_SERIAL_1904 + 1 ? undefined : fromSerial(serial, EPOCH_1904);
  if (serial >= MAX_SERIAL_1900 + 1) return undefined;
  const day = Math.floor(serial);
  if (day === 60) return undefined;
  return fromSerial(serial, day < 60 ? EPOCH_1900_EARLY : EPOCH_1900);
}

/** @internal Date → 1900-system serial, or `undefined` before 1900-01-01 or after 9999-12-31. */
export function dateToSerial(date: Date): number | undefined {
  const ms = date.getTime();
  if (ms < Date.UTC(1900, 0, 1) || ms >= Date.UTC(10000, 0, 1)) return undefined;
  return ms < Date.UTC(1900, 2, 1) ? (ms - EPOCH_1900_EARLY) / DAY : (ms - EPOCH_1900) / DAY;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

/** @internal Whether a number format shows a date or time. */
export function isDateFormat(id: number, code: string | undefined): boolean {
  if (code === undefined) return BUILTIN_DATE_FORMATS.has(id);
  // drop quoted text, escaped characters, [colour]/[locale]/[h] sections and _x / *x padding
  const stripped = code.replace(/"[^"]*"|\\.|\[[^\]]*\]|[_*]./g, "");
  // first section only (positive numbers)
  const first = stripped.split(";")[0] ?? "";
  return /[dmyhs]/i.test(first) && !/^\s*general\s*$/i.test(first);
}

/** @internal Number formats that display booleans (`"TRUE";"TRUE";"FALSE"`, as LibreOffice writes them). */
export function isBooleanFormat(code: string | undefined): boolean {
  return code !== undefined && /^"TRUE";"TRUE";"FALSE"$/i.test(code.trim());
}

/** @internal How a number cell with this format should be read. */
export type NumberKind = "number" | "date" | "boolean";

/** @internal */
export function numberKind(id: number, code: string | undefined): NumberKind {
  if (isBooleanFormat(code)) return "boolean";
  return isDateFormat(id, code) ? "date" : "number";
}
