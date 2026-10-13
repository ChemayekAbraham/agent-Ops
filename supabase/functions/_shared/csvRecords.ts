// CSV helpers for the table-by-table backup. Pure functions, no I/O.

const LF = 0x0a;
const QUOTE = 0x22;

/**
 * Number of data records in a standalone CSV page (header excluded).
 * Newlines inside quoted fields do not count. PostgREST quotes fields
 * with embedded newlines/commas and doubles inner quotes ("" toggles
 * twice, so a plain toggle on every quote byte is correct).
 */
export function countCsvDataRecords(bytes: Uint8Array): number {
  let inQuotes = false;
  let lines = 0;
  let lastByte = -1;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === QUOTE) inQuotes = !inQuotes;
    else if (b === LF && !inQuotes) lines++;
    lastByte = b;
  }
  if (bytes.length > 0 && lastByte !== LF) lines++; // final line without newline
  return Math.max(0, lines - 1); // minus header
}

/** CSV without its first (header) line; empty if there is no data line. */
export function stripCsvHeader(bytes: Uint8Array): Uint8Array {
  const nl = bytes.indexOf(LF);
  return nl < 0 ? new Uint8Array() : bytes.subarray(nl + 1);
}

/** Header line including its trailing newline, or null. */
export function csvHeaderLine(bytes: Uint8Array): Uint8Array | null {
  const nl = bytes.indexOf(LF);
  return nl < 0 ? null : bytes.slice(0, nl + 1);
}
