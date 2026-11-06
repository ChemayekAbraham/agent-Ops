/**
 * Safe client-side file & photo parser for Zoe (Part C item 1, with Section 3.1 File-Upload Defence).
 *
 * Defences enforced before any content reaches the model:
 * 1. Size & count limits: max 10 MB per file, max 5 files per chat.
 * 2. Archive / Zip-Bomb budget for .docx and .xlsx containers:
 *    - MAX_ZIP_DEPTH = 3 (rejects nested archives and deep directory trees)
 *    - MAX_ZIP_ENTRIES = 60
 *    - MAX_UNCOMPRESSED_BYTES = 25 * 1024 * 1024 (25 MB)
 *    - MAX_COMPRESSION_RATIO = 40
 *    - MAX_EXTRACTION_TIME_MS = 2500 (2.5 seconds)
 *    Any archive exceeding this budget is rejected outright (never skipped silently).
 * 3. PDF hidden-text / script / invisible-layer stripping:
 *    - Rejects PDFs containing active `/JavaScript`, `/JS`, `/Launch`, or `/RichMedia` actions.
 *    - Strips invisible text rendering blocks (`3 Tr`), zero-point font blocks (`0 Tf`),
 *      and white-on-white text blocks (`1 1 1 rg` / `1 g`) before extracting text.
 * 4. Prompt-injection wrapper:
 *    - Every extracted word is wrapped in `<UNTRUSTED_FILE_ATTACHMENT>` tags and stripped of
 *      instruction-override markers.
 * 5. PII warning detector:
 *    - Warns the staff member when a file contains phone numbers, Uganda NINs, or email addresses.
 */

export const MAX_ZOE_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_ZOE_FILES_PER_CHAT = 5;

export const ARCHIVE_SAFETY_BUDGET = {
  MAX_ZIP_DEPTH: 3,
  MAX_ZIP_ENTRIES: 60,
  MAX_UNCOMPRESSED_BYTES: 25 * 1024 * 1024, // 25 MB
  MAX_COMPRESSION_RATIO: 40,
  MAX_EXTRACTION_TIME_MS: 2500,
} as const;

export type ZoeAttachmentKind = "pdf" | "word" | "spreadsheet" | "image" | "text";

export interface ZoeParsedAttachment {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  kind: ZoeAttachmentKind;
  extracted_text: string;
  wrapped_prompt_block: string;
  image_data_url?: string;
  pii_warning?: string;
  storage_path?: string;
}

export interface ZipEntryMetadata {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ArchiveValidationResult {
  ok: boolean;
  reason?:
    | "too_many_entries"
    | "max_depth_exceeded"
    | "nested_archive_detected"
    | "uncompressed_size_exceeded"
    | "compression_ratio_exceeded"
    | "extraction_timeout"
    | "corrupt_archive";
  error?: string;
  entryCount?: number;
  totalUncompressedBytes?: number;
  maxDepthSeen?: number;
}

const NESTED_ARCHIVE_EXT_RE = /\.(zip|rar|7z|tar|gz|bz2|xz|tgz|jar|war|ear|iso|cab)$/i;

/**
 * Inspects a ZIP central directory / local file headers (used by `.docx` and `.xlsx`)
 * and enforces the strict archive safety budget before any decompression occurs.
 */
export function inspectZipArchiveSafety(
  bytes: Uint8Array,
  elapsedMs = 0,
  budget = ARCHIVE_SAFETY_BUDGET,
): ArchiveValidationResult {
  if (elapsedMs > budget.MAX_EXTRACTION_TIME_MS) {
    return {
      ok: false,
      reason: "extraction_timeout",
      error: `Archive extraction exceeded the ${budget.MAX_EXTRACTION_TIME_MS} ms time limit.`,
    };
  }

  // Check PK\x03\x04 signature
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    return {
      ok: false,
      reason: "corrupt_archive",
      error: "File is not a valid Office/ZIP container.",
    };
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let offset = 0;
  let entryCount = 0;
  let totalUncompressedBytes = 0;
  let maxDepthSeen = 0;
  const startedAt = Date.now();

  // Walk Local File Headers (0x04034b50) and Central Directory Headers (0x02014b50)
  while (offset + 30 <= bytes.length) {
    if (Date.now() - startedAt + elapsedMs > budget.MAX_EXTRACTION_TIME_MS) {
      return {
        ok: false,
        reason: "extraction_timeout",
        error: `Archive inspection exceeded the ${budget.MAX_EXTRACTION_TIME_MS} ms safety budget.`,
      };
    }

    const sig = view.getUint32(offset, true);
    if (sig === 0x04034b50) {
      entryCount += 1;
      if (entryCount > budget.MAX_ZIP_ENTRIES) {
        return {
          ok: false,
          reason: "too_many_entries",
          error: `Archive contains more than ${budget.MAX_ZIP_ENTRIES} entries and was rejected.`,
          entryCount,
        };
      }

      const compressedSize = view.getUint32(offset + 18, true);
      const uncompressedSize = view.getUint32(offset + 22, true);
      const fileNameLen = view.getUint16(offset + 26, true);
      const extraLen = view.getUint16(offset + 28, true);

      const nameStart = offset + 30;
      const nameEnd = Math.min(bytes.length, nameStart + fileNameLen);
      const entryName = decoder.decode(bytes.subarray(nameStart, nameEnd));

      if (NESTED_ARCHIVE_EXT_RE.test(entryName)) {
        return {
          ok: false,
          reason: "nested_archive_detected",
          error: `Nested archive entry ("${entryName}") is not allowed inside uploaded documents.`,
        };
      }

      const segments = entryName.split("/").filter(Boolean);
      const depth = segments.length;
      if (depth > maxDepthSeen) maxDepthSeen = depth;
      if (depth > budget.MAX_ZIP_DEPTH || entryName.includes("..")) {
        return {
          ok: false,
          reason: "max_depth_exceeded",
          error: `Archive entry "${entryName}" exceeds maximum directory depth (${budget.MAX_ZIP_DEPTH}).`,
          maxDepthSeen: depth,
        };
      }

      totalUncompressedBytes += uncompressedSize;
      if (totalUncompressedBytes > budget.MAX_UNCOMPRESSED_BYTES) {
        return {
          ok: false,
          reason: "uncompressed_size_exceeded",
          error: `Archive uncompressed size (${Math.round(totalUncompressedBytes / (1024 * 1024))} MB) exceeds the 25 MB safety limit.`,
          totalUncompressedBytes,
        };
      }

      if (compressedSize > 0 && uncompressedSize / compressedSize > budget.MAX_COMPRESSION_RATIO) {
        return {
          ok: false,
          reason: "compression_ratio_exceeded",
          error: `Archive compression ratio (${Math.round(uncompressedSize / compressedSize)}:1) exceeds the ${budget.MAX_COMPRESSION_RATIO}:1 zip-bomb limit.`,
        };
      }

      const nextOffset = nameStart + fileNameLen + extraLen + compressedSize;
      if (nextOffset <= offset) break;
      offset = nextOffset;
    } else {
      break;
    }
  }

  return {
    ok: true,
    entryCount,
    totalUncompressedBytes,
    maxDepthSeen,
  };
}

/**
 * Strips hidden PDF text layers, scripts, macros, and invisible rendering operators
 * (`3 Tr` invisible text, `0 Tf` zero-size font, `1 1 1 rg` white fill) before reading text.
 */
export function sanitizeAndExtractPdfText(rawPdfText: string): {
  ok: boolean;
  error?: string;
  extractedText: string;
  strippedHiddenConstructs: number;
} {
  if (/\/(?:JavaScript|JS|Launch|RichMedia|SubmitForm|ImportData)\b/i.test(rawPdfText)) {
    return {
      ok: false,
      error:
        "PDF contains active scripts or launch actions (/JavaScript, /Launch) and was rejected for safety.",
      extractedText: "",
      strippedHiddenConstructs: 1,
    };
  }

  let strippedCount = 0;
  let cleaned = rawPdfText;

  // Strip BT ... ET text blocks that use invisible rendering mode `3 Tr`, zero font size `0 Tf`, or white text `1 1 1 rg` / `1 g`
  cleaned = cleaned.replace(/BT[\s\S]*?ET/g, (block) => {
    if (
      /\b3\s+Tr\b/.test(block) ||
      /\b0(?:\.0+)?\s+Tf\b/.test(block) ||
      /\b1(?:\.0+)?\s+1(?:\.0+)?\s+1(?:\.0+)?\s+rg\b/i.test(block) ||
      /\b1(?:\.0+)?\s+g\b/.test(block) ||
      /-\d{4,}\s+-\d{4,}\s+Td\b/.test(block)
    ) {
      strippedCount += 1;
      return " ";
    }
    return block;
  });

  // Extract parenthesized literal strings `(text)` from remaining safe PDF text blocks or plain text
  const literalMatches = [...cleaned.matchAll(/\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*Tj/g)].map((m) =>
    m[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, " ")
      .replace(/\\t/g, " ")
      .replace(/\\\(/g, "(")
      .replace(/\\\)/g, ")"),
  );

  const rawExtracted =
    literalMatches.length > 0
      ? literalMatches.join(" ")
      : cleaned
          .replace(/<<[\s\S]*?>>/g, " ")
          .replace(/stream[\s\S]*?endstream/g, " ")
          .replace(/[^\x20-\x7E\n\t]/g, " ");

  const normalized = rawExtracted.replace(/\s+/g, " ").trim().slice(0, 32000);
  return {
    ok: true,
    extractedText: normalized,
    strippedHiddenConstructs: strippedCount,
  };
}

/**
 * Wraps extracted file text in `<UNTRUSTED_FILE_ATTACHMENT>` tags and neutralizes any
 * embedded closing tags or prompt-override markers.
 */
export function wrapUntrustedFileContent(
  fileName: string,
  kind: ZoeAttachmentKind,
  extractedText: string,
): string {
  const safeName = fileName.replace(/["<>]/g, "").trim() || "attachment";
  const neutralized = (extractedText ?? "")
    .replace(/<\s*\/?\s*UNTRUSTED_FILE_ATTACHMENT[^>]*>/gi, "[redacted-tag]")
    .replace(/<\s*\/?\s*UNTRUSTED_TOOL_DATA[^>]*>/gi, "[redacted-tag]")
    .replace(/<\s*\/?\s*UNTRUSTED_WEB_PAGE_DATA[^>]*>/gi, "[redacted-tag]")
    .slice(0, 32000);

  return `<UNTRUSTED_FILE_ATTACHMENT name="${safeName}" kind="${kind}">\n${neutralized}\n</UNTRUSTED_FILE_ATTACHMENT>`;
}

/**
 * Scans extracted text for phone numbers, Uganda NINs, and email addresses so Zoe can
 * show a visible warning banner before the file is sent.
 */
export function detectFilePiiWarning(text: string): string | undefined {
  if (!text) return undefined;
  const hasPhone = /(?:\+?256|0)\s*7\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/.test(text);
  const hasNin = /\bC[FM][0-9A-Z]{12}\b/i.test(text);
  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text);

  const found: string[] = [];
  if (hasPhone) found.push("phone numbers");
  if (hasNin) found.push("National ID numbers (NIN)");
  if (hasEmail) found.push("email addresses");

  if (found.length === 0) return undefined;
  return `This file contains ${found.join(" and ")}. Uploaded files stay private to your chat (deleted with the chat and after 90 days) and are never added to the Knowledge Base.`;
}

/**
 * Parses a CSV or TSV text string into a clean Markdown table summary + row count.
 */
export function parseCsvToTableSummary(csvText: string, maxPreviewRows = 25): string {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return "(Empty spreadsheet)";

  const parseRow = (line: string): string[] =>
    line
      .split(",")
      .map((cell) => cell.replace(/^"|"$/g, "").trim())
      .slice(0, 16);

  const headers = parseRow(lines[0]);
  const dataRows = lines.slice(1, 1 + maxPreviewRows).map(parseRow);
  const totalRows = Math.max(0, lines.length - 1);

  const headerLine = `| ${headers.join(" | ")} |`;
  const sepLine = `| ${headers.map(() => "---").join(" | ")} |`;
  const bodyLines = dataRows.map((r) => `| ${headers.map((_, i) => r[i] ?? "").join(" | ")} |`);

  return [
    `Spreadsheet summary: ${totalRows} data row(s), ${headers.length} column(s) (${headers.join(", ")}).`,
    headerLine,
    sepLine,
    ...bodyLines,
    totalRows > maxPreviewRows ? `*(Showing first ${maxPreviewRows} of ${totalRows} rows)*` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function inferAttachmentKind(fileName: string, mimeType: string): ZoeAttachmentKind | null {
  const lower = fileName.toLowerCase();
  const mime = mimeType.toLowerCase();
  if (lower.endsWith(".pdf") || mime === "application/pdf") return "pdf";
  if (
    lower.endsWith(".docx") ||
    lower.endsWith(".doc") ||
    mime.includes("wordprocessingml") ||
    mime === "application/msword"
  ) {
    return "word";
  }
  if (
    lower.endsWith(".xlsx") ||
    lower.endsWith(".xls") ||
    lower.endsWith(".csv") ||
    mime.includes("spreadsheetml") ||
    mime === "text/csv" ||
    mime === "application/vnd.ms-excel"
  ) {
    return "spreadsheet";
  }
  if (
    mime.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif|heic)$/i.test(lower)
  ) {
    return "image";
  }
  if (mime.startsWith("text/") || /\.(txt|md)$/i.test(lower)) {
    return "text";
  }
  return null;
}

/**
 * Parses a user-selected `File` in the browser with all Section 3.1 safety defences.
 */
export async function parseZoeFileAttachment(file: File): Promise<
  | { ok: true; attachment: ZoeParsedAttachment }
  | { ok: false; error: string }
> {
  if (file.size > MAX_ZOE_FILE_SIZE_BYTES) {
    return {
      ok: false,
      error: `"${file.name}" is ${(file.size / (1024 * 1024)).toFixed(1)} MB. Each file must be 10 MB or smaller.`,
    };
  }

  const kind = inferAttachmentKind(file.name, file.type);
  if (!kind) {
    return {
      ok: false,
      error: `"${file.name}" is not a supported file type. Attach PDF, Word (.docx), Excel/CSV, or an image/photo.`,
    };
  }

  const startedAt = Date.now();
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Check ZIP-based Office files (.docx, .xlsx) against the zip-bomb / depth / entry / time budget
  const isZipContainer =
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04;

  if ((kind === "word" || kind === "spreadsheet") && isZipContainer) {
    const zipSafety = inspectZipArchiveSafety(bytes, Date.now() - startedAt);
    if (!zipSafety.ok) {
      return {
        ok: false,
        error: zipSafety.error ?? "Office archive failed safety validation.",
      };
    }
  }

  let extractedText = "";
  let imageDataUrl: string | undefined;

  if (kind === "image") {
    imageDataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(new Error("Could not read image file."));
      reader.readAsDataURL(file);
    });
    extractedText = `[Uploaded image/photo: ${file.name} (${Math.round(file.size / 1024)} KB)]`;
  } else if (kind === "pdf") {
    const rawText = new TextDecoder("latin1").decode(bytes);
    const pdfRes = sanitizeAndExtractPdfText(rawText);
    if (!pdfRes.ok) {
      return { ok: false, error: pdfRes.error ?? "PDF failed safety check." };
    }
    extractedText =
      pdfRes.extractedText ||
      `[PDF document: ${file.name} (${Math.round(file.size / 1024)} KB) — no selectable text layer]`;
  } else if (kind === "spreadsheet") {
    if (file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv") {
      const csvText = new TextDecoder("utf-8").decode(bytes);
      extractedText = parseCsvToTableSummary(csvText);
    } else {
      // Extract sharedStrings / XML text nodes from verified .xlsx container within time budget
      const rawXml = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
      const cellValues = [...rawXml.matchAll(/<t[^>]*>([^<]{1,200})<\/t>/g)]
        .map((m) => m[1].trim())
        .filter(Boolean)
        .slice(0, 400);
      extractedText =
        cellValues.length > 0
          ? `Spreadsheet (${file.name}) values:\n${cellValues.join(" | ")}`
          : `Spreadsheet (${file.name}, ${Math.round(file.size / 1024)} KB)`;
    }
  } else if (kind === "word") {
    const rawXml = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const paragraphs = [...rawXml.matchAll(/<w:t[^>]*>([^<]{1,400})<\/w:t>/g)]
      .map((m) => m[1])
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    extractedText =
      paragraphs ||
      new TextDecoder("utf-8", { fatal: false })
        .decode(bytes)
        .replace(/[^\x20-\x7E\n\t]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 24000);
  } else {
    extractedText = new TextDecoder("utf-8", { fatal: false }).decode(bytes).slice(0, 24000);
  }

  if (Date.now() - startedAt > ARCHIVE_SAFETY_BUDGET.MAX_EXTRACTION_TIME_MS * 2) {
    return {
      ok: false,
      error: `Reading "${file.name}" took too long and was stopped for safety.`,
    };
  }

  const piiWarning = detectFilePiiWarning(extractedText);
  const wrappedPromptBlock = wrapUntrustedFileContent(file.name, kind, extractedText);

  return {
    ok: true,
    attachment: {
      id: crypto.randomUUID(),
      name: file.name,
      mime_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      kind,
      extracted_text: extractedText,
      wrapped_prompt_block: wrappedPromptBlock,
      image_data_url: imageDataUrl,
      pii_warning: piiWarning,
    },
  };
}
