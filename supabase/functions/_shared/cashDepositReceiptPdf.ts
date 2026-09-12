import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

export interface CashDepositReceiptData {
  depositorName: string;
  amount: number;
  newBalance?: number | null;
  depositedAt: string;
  referenceNumber: string;
  maskedDepositCode: string;
  facilitatedRentVolume?: number | null;
  platformServiceFees?: number | null;
  transactionExpenses?: number | null;
}

const PURPLE = rgb(0.482, 0.098, 0.831);
const PURPLE_DARK = rgb(0.24, 0.047, 0.408);
const PURPLE_SOFT = rgb(0.973, 0.957, 0.992);
const INK = rgb(0.059, 0.09, 0.165);
const SLATE = rgb(0.2, 0.255, 0.333);
const MUTED = rgb(0.392, 0.455, 0.545);
const LINE = rgb(0.886, 0.91, 0.941);
const PAGE_BG = rgb(0.969, 0.976, 0.988);
const WHITE = rgb(1, 1, 1);
const GREEN = rgb(0.063, 0.478, 0.255);
const GREEN_BG = rgb(0.925, 0.992, 0.961);

const A4 = { width: 595.28, height: 841.89 };
const CARD = { x: 34, y: 42, width: 527.28, height: 758 };
const LEFT = 68;
const RIGHT = A4.width - 68;

const formatUGX = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value)
    ? `UGX ${Math.round(value).toLocaleString("en-US")}`
    : "Not available";

function kampalaDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Not available";
  return `${parsed.toLocaleString("en-GB", {
    timeZone: "Africa/Kampala",
    day: "2-digit",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })} EAT`;
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

export function cashDepositReceiptFilename(referenceNumber: string): string {
  const safeReference = String(referenceNumber || "cash-deposit")
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "CASH-DEPOSIT";
  return `Welile-Cash-Deposit-Receipt-${safeReference}.pdf`;
}

export async function renderCashDepositReceipt(data: CashDepositReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Welile cash deposit receipt ${data.referenceNumber}`);
  pdf.setAuthor("Welile Technologies Limited");
  pdf.setSubject("Cash deposit wallet credit confirmation");

  const page = pdf.addPage([A4.width, A4.height]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const text = (value: string, x: number, y: number, size: number, font = regular, color = INK) =>
    page.drawText(value, { x, y, size, font, color });
  const line = (y: number) => page.drawLine({
    start: { x: LEFT, y },
    end: { x: RIGHT, y },
    thickness: 0.8,
    color: LINE,
  });
  const centered = (value: string, y: number, size: number, font = regular, color = INK) => {
    const width = font.widthOfTextAtSize(value, size);
    text(value, (A4.width - width) / 2, y, size, font, color);
  };

  page.drawRectangle({ x: 0, y: 0, width: A4.width, height: A4.height, color: PAGE_BG });
  page.drawSvgPath(roundedRectPath(CARD.x, CARD.y, CARD.width, CARD.height, 10), {
    color: WHITE,
    borderColor: LINE,
    borderWidth: 1,
  });
  page.drawRectangle({ x: CARD.x, y: CARD.y + CARD.height - 7, width: CARD.width, height: 7, color: PURPLE });

  text("Welile", LEFT, 750, 24, bold, PURPLE);
  text("WELILE TECHNOLOGIES LIMITED", LEFT, 731, 8.5, bold, MUTED);
  const badge = "DEPOSIT CONFIRMED";
  const badgeWidth = bold.widthOfTextAtSize(badge, 8.5) + 24;
  page.drawSvgPath(roundedRectPath(RIGHT - badgeWidth, 733, badgeWidth, 24, 12), { color: GREEN_BG });
  text(badge, RIGHT - badgeWidth + 12, 741, 8.5, bold, GREEN);

  text("Cash Deposit Receipt", LEFT, 682, 22, bold, INK);
  text(`Reference ${data.referenceNumber}`, LEFT, 659, 10.5, regular, MUTED);
  line(638);

  page.drawSvgPath(roundedRectPath(LEFT, 510, RIGHT - LEFT, 99, 8), { color: PURPLE_SOFT });
  centered("AMOUNT CREDITED", 579, 9, bold, PURPLE_DARK);
  centered(formatUGX(data.amount), 543, 29, bold, PURPLE_DARK);
  centered("Successfully added to your Welile Wallet", 521, 10, regular, SLATE);

  text("RECORDED BREAKDOWN", LEFT, 478, 9, bold, PURPLE_DARK);
  const breakdown = (label: string, value: number | null | undefined, x: number) => {
    text(label, x, 454, 8, bold, MUTED);
    text(formatUGX(value), x, 435, 10.5, bold, INK);
  };
  breakdown("FACILITATED RENT VOLUME", data.facilitatedRentVolume, LEFT);
  breakdown("PLATFORM SERVICE FEES", data.platformServiceFees, 235);
  breakdown("TRANSACTION EXPENSES", data.transactionExpenses, 403);
  line(416);

  text("RECEIPT DETAILS", LEFT, 389, 9, bold, PURPLE_DARK);
  const detail = (label: string, value: string, y: number) => {
    text(label, LEFT, y, 8.5, bold, MUTED);
    text(value, LEFT, y - 20, 11.5, bold, INK);
    line(y - 38);
  };
  detail("DEPOSITOR", data.depositorName || "Welile customer", 363);
  detail("TRANSACTION DATE & TIME", kampalaDateTime(data.depositedAt), 308);
  detail("DEPOSIT CODE", data.maskedDepositCode || "Not available", 253);
  detail("AVAILABLE WALLET BALANCE", formatUGX(data.newBalance), 198);

  centered("Breakdown values are shown only when recorded against this deposit.", 129, 9, regular, SLATE);
  centered("Keep this receipt and reference number for your records.", 112, 9, regular, SLATE);
  centered("welileapp.com  |  support: +256 708 257 899", 80, 9, bold, PURPLE_DARK);
  centered("Turning rent into an asset.", 62, 8.5, regular, MUTED);

  return pdf.save({ useObjectStreams: true });
}