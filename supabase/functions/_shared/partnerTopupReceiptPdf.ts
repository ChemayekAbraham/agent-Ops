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

// Palette mirrored from the receipt HTML template
const PURPLE = rgb(0.545, 0.173, 0.961); // #8B2CF5
const PURPLE_SOFT = rgb(0.565, 0.38, 0.851); // #9061D9
const INK = rgb(0.09, 0.106, 0.173); // #171B2C
const SLATE = rgb(0.2, 0.255, 0.333); // #334155
const MUTED = rgb(0.42, 0.447, 0.502); // #6B7280
const FAINT = rgb(0.58, 0.639, 0.722); // #94A3B8
const LINE = rgb(0.937, 0.937, 0.957); // #EFEFF4
const DASH = rgb(0.85, 0.867, 0.906); // #D9DDE7
const CARD_BORDER = rgb(0.906, 0.914, 0.937); // #E7E9EF
const HERO_BG = rgb(0.984, 0.976, 1); // #FBF9FF
const FOOTER_BG = rgb(0.98, 0.98, 0.988); // #FAFAFC
const GREEN = rgb(0.082, 0.502, 0.239); // #15803D
const GREEN_BG = rgb(0.925, 0.992, 0.961); // #ECFDF5
const GREEN_BORDER = rgb(0.655, 0.953, 0.816); // #A7F3D0
const PAGE_BG = rgb(0.965, 0.969, 0.98); // #F6F7FA
const WHITE = rgb(1, 1, 1);

const PAGE_W = 460;
const PAGE_H = 648;
const CARD_X = 14;
const CARD_W = PAGE_W - CARD_X * 2;
const PAD = 22;
const LEFT = CARD_X + PAD;
const RIGHT = CARD_X + CARD_W - PAD;
const COL2 = CARD_X + CARD_W / 2 + 4;

const amount = (value: number) => Math.round(Number(value) || 0).toLocaleString("en-US");
const clean = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;

function fit(text: string, font: any, size: number, maxWidth: number): string {
  let out = text;
  while (out.length > 4 && font.widthOfTextAtSize(out, size) > maxWidth) {
    out = out.slice(0, -1);
  }
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

export async function renderPartnershipTopupReceipt(data: PartnerTopupReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    font: any,
    color = INK,
  ) => page.drawText(value, { x, y, size, font, color });

  const centered = (value: string, y: number, size: number, font: any, color = INK) => {
    const w = font.widthOfTextAtSize(value, size);
    page.drawText(value, { x: CARD_X + (CARD_W - w) / 2, y, size, font, color });
  };

  const hLine = (y: number, color = LINE, dashed = false) =>
    page.drawLine({
      start: { x: LEFT, y },
      end: { x: RIGHT, y },
      thickness: 1,
      color,
      ...(dashed ? { dashArray: [2, 2] } : {}),
    });

  const sectionTitle = (label: string, y: number) => text(label.toUpperCase(), LEFT, y, 7.5, bold, FAINT);

  const field = (label: string, value: string, x: number, y: number, opts: { color?: any; size?: number } = {}) => {
    const maxWidth = CARD_W / 2 - PAD - 6;
    text(label, x, y, 7.5, regular, FAINT);
    const size = opts.size ?? 10;
    text(fit(value, bold, size, maxWidth), x, y - 13, size, bold, opts.color ?? INK);
  };

  // Page + card
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: PAGE_H, color: PAGE_BG });
  page.drawRectangle({
    x: CARD_X,
    y: 14,
    width: CARD_W,
    height: PAGE_H - 28,
    color: WHITE,
    borderColor: CARD_BORDER,
    borderWidth: 1,
  });

  let y = PAGE_H - 46;

  // 1. Header
  text("WELILE", LEFT, y, 17, bold, PURPLE);
  const badgeLabel = "Top-Up Approved";
  const badgeW = bold.widthOfTextAtSize(badgeLabel, 8) + 22;
  page.drawRectangle({
    x: RIGHT - badgeW,
    y: y - 4,
    width: badgeW,
    height: 20,
    color: GREEN_BG,
    borderColor: GREEN_BORDER,
    borderWidth: 1,
  });
  text(badgeLabel, RIGHT - badgeW + 11, y + 2, 8, bold, GREEN);

  y -= 26;
  text("Partner Top-Up Receipt", LEFT, y, 15, bold, INK);
  y -= 15;
  text(
    `Receipt No. ${clean(data.receiptNumber)}  ·  ${clean(data.effectiveAt)}`,
    LEFT,
    y,
    8.5,
    regular,
    MUTED,
  );

  y -= 14;
  hLine(y);

  // 2. Hero
  const heroTop = y - 4;
  const heroH = 128;
  page.drawRectangle({ x: CARD_X + 1, y: heroTop - heroH, width: CARD_W - 2, height: heroH, color: HERO_BG });
  let hy = heroTop - 26;
  centered("TOP-UP AMOUNT ADDED", hy, 8, bold, PURPLE_SOFT);

  hy -= 34;
  const amountStr = amount(data.topupAmount);
  const curW = bold.widthOfTextAtSize("UGX ", 15);
  const amtW = bold.widthOfTextAtSize(amountStr, 30);
  const startX = CARD_X + (CARD_W - (curW + amtW)) / 2;
  text("UGX ", startX, hy + 4, 15, bold, PURPLE);
  text(amountStr, startX + curW, hy, 30, bold, PURPLE);

  hy -= 20;
  centered(`Added to portfolio ${clean(data.portfolioId)}`, hy, 9.5, regular, MUTED);

  hy -= 26;
  const pillText = `Previous: UGX ${amount(data.previousPrincipal)}   >   New Total: UGX ${amount(
    data.newTotalPrincipal,
  )}`;
  const pillTextW = regular.widthOfTextAtSize(pillText, 8.5);
  const pillW = pillTextW + 26;
  page.drawRectangle({
    x: CARD_X + (CARD_W - pillW) / 2,
    y: hy - 6,
    width: pillW,
    height: 22,
    color: WHITE,
    borderColor: rgb(0.914, 0.859, 1),
    borderWidth: 1,
  });
  centered(pillText, hy, 8.5, regular, SLATE);

  y = heroTop - heroH;
  hLine(y);

  // 3. Detail sections
  y -= 22;
  sectionTitle("1. Partner & Portfolio Attachment", y);

  y -= 22;
  field("Partner Name", clean(data.partnerName), LEFT, y);
  field("Partner ID", clean(data.partnerId), COL2, y);
  y -= 22;
  hLine(y, DASH, true);

  y -= 20;
  field("Parent Portfolio ID", clean(data.portfolioId), LEFT, y, { color: PURPLE });
  field(
    "Portfolios Topped Up",
    `${data.portfoliosToppedUpCount || 1} Active Portfolio${(data.portfoliosToppedUpCount || 1) > 1 ? "s" : ""}`,
    COL2,
    y,
  );
  y -= 22;
  hLine(y, DASH, true);

  y -= 20;
  text("Portfolio Title", LEFT, y, 7.5, regular, FAINT);
  const titleLines = wrap(clean(data.portfolioName), bold, 10, RIGHT - LEFT).slice(0, 2);
  let ty = y - 13;
  for (const line of titleLines) {
    text(line, LEFT, ty, 10, bold, SLATE);
    ty -= 12;
  }
  y = ty - 4;
  hLine(y, DASH, true);

  y -= 24;
  sectionTitle("2. Timing & Processing", y);
  y -= 22;
  field("Effective Date & Time", clean(data.effectiveAt), LEFT, y, { size: 9 });
  field("Created / Updated", clean(data.createdAt), COL2, y, { size: 9, color: MUTED });
  y -= 22;
  hLine(y, DASH, true);

  y -= 24;
  sectionTitle("3. Treasury Verification & Approval", y);
  y -= 22;
  field("Reviewed By", `${clean(data.reviewedBy, "System")} (Partner Operations)`, LEFT, y, { size: 9 });
  field("Review Notes", "Top-up funds", COL2, y, { size: 9, color: SLATE });

  // 4. Footer
  const footerH = 112;
  const footerTop = 14 + footerH;
  page.drawRectangle({ x: CARD_X + 1, y: 15, width: CARD_W - 2, height: footerH, color: FOOTER_BG });
  hLine(footerTop, LINE);

  let fy = footerTop - 22;
  const noteLines = wrap(
    "This official receipt confirms capital top-up for your portfolio. Returns accrue per the Master Partnership Agreement.",
    regular,
    8.5,
    RIGHT - LEFT,
  );
  for (const line of noteLines) {
    centered(line, fy, 8.5, regular, MUTED);
    fy -= 12;
  }

  fy -= 20;
  page.drawRectangle({
    x: LEFT,
    y: fy - 14,
    width: RIGHT - LEFT,
    height: 34,
    color: WHITE,
    borderColor: CARD_BORDER,
    borderWidth: 1,
  });
  text("Receipt Reference", LEFT + 12, fy + 8, 8.5, bold, INK);
  text(`${clean(data.receiptNumber)} · Verified partnership record`, LEFT + 12, fy - 3, 7.5, regular, FAINT);

  centered("© 2026 Welile Technologies Limited · Entebbe, Uganda", 26, 7.5, regular, FAINT);

  return pdf.save({ useObjectStreams: true });
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
