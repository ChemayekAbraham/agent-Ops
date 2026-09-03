import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

export interface PartnerTopupReceiptData {
  receiptNumber: string;
  effectiveAt: string;
  topupAmount: number;
  portfolioId: string;
  portfolioName: string;
  previousPrincipal: number;
  newTotalPrincipal: number;
  partnerName: string;
  partnerId: string;
  portfoliosToppedUpCount: number;
  createdAt: string;
  reviewedBy: string;
}

// The receipt is deliberately rendered on A4 so its proportions match the supplied HTML/PDF reference.
const PURPLE = rgb(0.545, 0.173, 0.961);
const PURPLE_DARK = rgb(0.36, 0.09, 0.61);
const PURPLE_SOFT = rgb(0.565, 0.38, 0.851);
const INK = rgb(0.09, 0.106, 0.173);
const SLATE = rgb(0.2, 0.255, 0.333);
const MUTED = rgb(0.42, 0.447, 0.502);
const FAINT = rgb(0.42, 0.447, 0.502);
const LINE = rgb(0.937, 0.937, 0.957);
const DASH = rgb(0.85, 0.867, 0.906);
const CARD_BORDER = rgb(0.906, 0.914, 0.937);
const HERO_BG = rgb(0.984, 0.976, 1);
const FOOTER_BG = rgb(0.98, 0.98, 0.988);
const GREEN = rgb(0.082, 0.502, 0.239);
const GREEN_BG = rgb(0.925, 0.992, 0.961);
const GREEN_BORDER = rgb(0.655, 0.953, 0.816);
const PAGE_BG = rgb(0.965, 0.969, 0.98);
const WHITE = rgb(1, 1, 1);

const PAGE_W = 595;
const PAGE_H = 842;
const CARD_X = 29;
const CARD_Y = 30;
const CARD_W = 537;
const CARD_H = 782;
const PAD = 27;
const LEFT = CARD_X + PAD;
const RIGHT = CARD_X + CARD_W - PAD;
const COL2 = CARD_X + CARD_W / 2 + 28;

const amount = (value: number) => Math.round(Number(value) || 0).toLocaleString("en-US");
const clean = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;

function fit(text: string, font: any, size: number, maxWidth: number): string {
  let out = text;
  while (out.length > 4 && font.widthOfTextAtSize(out, size) > maxWidth) out = out.slice(0, -1);
  return out === text ? text : `${out.trimEnd()}…`;
}

function wrap(text: string, font: any, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["—"];
}

function roundedRectPath(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height / 2);
  return [
    `M ${x + r} ${y}`,
    `L ${x + width - r} ${y}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `L ${x + width} ${y + height - r}`,
    `Q ${x + width} ${y + height} ${x + width - r} ${y + height}`,
    `L ${x + r} ${y + height}`,
    `Q ${x} ${y + height} ${x} ${y + height - r}`,
    `L ${x} ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    "Z",
  ].join(" ");
}

function drawQrMark(page: any, x: number, y: number, size: number, color: any) {
  const cell = size / 11;
  const modules = [
    "11111110001",
    "10000010101",
    "10111010001",
    "10111010111",
    "10111010001",
    "10000010101",
    "11111110111",
    "00000000000",
    "11010110101",
    "00101101010",
    "11100011101",
  ];
  for (let row = 0; row < modules.length; row += 1) {
    for (let column = 0; column < modules[row].length; column += 1) {
      if (modules[row][column] === "1") {
        page.drawRectangle({ x: x + column * cell, y: y + (10 - row) * cell, width: cell, height: cell, color });
      }
    }
  }
}

export async function renderPartnershipTopupReceipt(data: PartnerTopupReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const text = (value: string, x: number, y: number, size: number, font: any, color = INK) =>
    page.drawText(value, { x, y, size, font, color });
  const centered = (value: string, y: number, size: number, font: any, color = INK) => {
    const width = font.widthOfTextAtSize(value, size);
    text(value, CARD_X + (CARD_W - width) / 2, y, size, font, color);
  };
  const hLine = (y: number, color = LINE, dashed = false) => page.drawLine({
    start: { x: LEFT, y }, end: { x: RIGHT, y }, thickness: 0.8, color,
    ...(dashed ? { dashArray: [2, 2] } : {}),
  });
  const sectionTitle = (label: string, y: number) => text(label.toUpperCase(), LEFT, y, 8, bold, SLATE);
  const field = (label: string, value: string, x: number, y: number, color = INK, size = 10) => {
    const maxWidth = CARD_W / 2 - PAD - 12;
    text(label, x, y, 8.5, regular, MUTED);
    text(fit(value, bold, size, maxWidth), x, y - 17, size, bold, color);
  };

  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAGE_BG });
  page.drawSvgPath(roundedRectPath(CARD_X, CARD_Y, CARD_W, CARD_H, 11), {
    color: WHITE, borderColor: CARD_BORDER, borderWidth: 0.8,
  });

  // Header — logo, approval badge, title and receipt metadata.
  text("Welile", LEFT, 764, 19, bold, PURPLE);
  const badgeLabel = "Top-Up Approved";
  const badgeW = bold.widthOfTextAtSize(badgeLabel, 9) + 31;
  page.drawSvgPath(roundedRectPath(RIGHT - badgeW, 765, badgeW, 20, 10), {
    color: WHITE, borderColor: GREEN_BORDER, borderWidth: 0.9,
  });
  text("OK", RIGHT - badgeW + 8, 771, 8, bold, GREEN);
  text(badgeLabel, RIGHT - badgeW + 24, 771, 9, bold, GREEN);

  text("Partner Top-Up Receipt", LEFT, 716, 16, bold, INK);
  text(`Receipt No. ${clean(data.receiptNumber)}  ·  ${clean(data.effectiveAt)}`, LEFT, 697, 10, regular, INK);
  hLine(675);

  // Amount hero — soft lavender block and rounded before/after pill.
  page.drawRectangle({ x: CARD_X + 1, y: 552, width: CARD_W - 2, height: 123, color: HERO_BG });
  centered("TOP-UP AMOUNT ADDED", 644, 9, bold, PURPLE_DARK);
  const amountText = amount(data.topupAmount);
  const currencyWidth = bold.widthOfTextAtSize("UGX ", 16);
  const amountWidth = bold.widthOfTextAtSize(amountText, 34);
  const amountX = CARD_X + (CARD_W - currencyWidth - amountWidth) / 2;
  text("UGX ", amountX, 603, 16, bold, PURPLE_DARK);
  text(amountText, amountX + currencyWidth, 598, 34, bold, PURPLE_DARK);
  centered(`Added to portfolio ${clean(data.portfolioId)}`, 578, 10, regular, INK);

  const previous = `Previous: UGX ${amount(data.previousPrincipal)}`;
  const next = `New Total: UGX ${amount(data.newTotalPrincipal)}`;
  const pill = `${previous}   >   ${next}`;
  const pillW = regular.widthOfTextAtSize(pill, 10) + 30;
  page.drawSvgPath(roundedRectPath(CARD_X + (CARD_W - pillW) / 2, 548, pillW, 27, 14), {
    color: WHITE, borderColor: rgb(0.89, 0.84, 0.96), borderWidth: 0.9,
  });
  const pillX = CARD_X + (CARD_W - regular.widthOfTextAtSize(pill, 10)) / 2;
  text(previous, pillX, 557, 10, regular, SLATE);
  const arrowX = pillX + regular.widthOfTextAtSize(previous, 10) + 12;
  text(">", arrowX, 557, 11, bold, PURPLE_DARK);
  text(next, arrowX + 18, 557, 10, regular, SLATE);
  hLine(552);

  // Detail rows — the same three numbered sections as the reference.
  let y = 527;
  sectionTitle("1. Partner & Portfolio Attachment", y);
  y -= 32;
  field("Partner Name", clean(data.partnerName), LEFT, y);
  field("Partner ID", clean(data.partnerId), COL2, y);
  y -= 35;
  hLine(y, DASH, true);
  y -= 27;
  field("Parent Portfolio ID", clean(data.portfolioId), LEFT, y, PURPLE_DARK);
  field("Portfolios Topped Up", `${data.portfoliosToppedUpCount || 1} Active Portfolio${(data.portfoliosToppedUpCount || 1) > 1 ? "s" : ""}`, COL2, y);
  y -= 35;
  hLine(y, DASH, true);
  y -= 27;
  text("Portfolio Facility Title", LEFT, y, 8.5, regular, MUTED);
  text(fit(clean(data.portfolioName), bold, 10, RIGHT - LEFT), LEFT, y - 17, 10, bold, SLATE);
  y -= 35;
  hLine(y, DASH, true);

  y -= 28;
  sectionTitle("2. Timing & Processing", y);
  y -= 32;
  field("Effective Date & Time", clean(data.effectiveAt), LEFT, y, INK, 10);
  field("Created / Updated", clean(data.createdAt), COL2, y, INK, 10);
  y -= 35;
  hLine(y, DASH, true);

  y -= 28;
  sectionTitle("3. Treasury Verification & Approval", y);
  y -= 32;
  field("Reviewed By", `${clean(data.reviewedBy, "System")} (Partner Operations)`, LEFT, y, INK, 10);
  field("Review Notes", "Top-up funds", COL2, y, SLATE, 10);

  // Footer — explanatory note and the same verification box/QR treatment as the reference.
  page.drawRectangle({ x: CARD_X + 1, y: 31, width: CARD_W - 2, height: 117, color: FOOTER_BG });
  hLine(148);
  centered("This official receipt confirms capital top-up for your portfolio. Returns accrue per the Master Partnership Agreement.", 128, 9, regular, INK);

  page.drawSvgPath(roundedRectPath(LEFT, 60, RIGHT - LEFT, 51, 11), {
    color: WHITE, borderColor: CARD_BORDER, borderWidth: 0.9,
  });
  drawQrMark(page, LEFT + 12, 68, 35, INK);
  text("Scan to Verify Receipt", LEFT + 57, 91, 9.5, bold, INK);
  text("Cryptographic Authenticated", LEFT + 57, 76, 8.5, regular, MUTED);
  text("welile.com/verify", RIGHT - 88, 80, 9, bold, PURPLE_DARK);
  centered("© 2026 Welile Technologies Limited · Entebbe, Uganda", 42, 8.5, regular, INK);

  return pdf.save({ useObjectStreams: true });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  return btoa(binary);
}
