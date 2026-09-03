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

const PURPLE = rgb(0.42, 0.13, 0.77);
const INK = rgb(0.12, 0.10, 0.18);
const MUTED = rgb(0.39, 0.36, 0.45);
const BORDER = rgb(0.88, 0.85, 0.92);
const SOFT_PURPLE = rgb(0.96, 0.94, 0.99);
const WHITE = rgb(1, 1, 1);

const money = (value: number) => `UGX ${Math.round(Number(value) || 0).toLocaleString("en-US")}`;
const clean = (value: unknown, fallback = "—") => String(value ?? "").trim() || fallback;

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : ["—"];
}

function drawLabelValue(
  page: any,
  label: string,
  value: string,
  x: number,
  y: number,
  labelFont: any,
  valueFont: any,
) {
  page.drawText(label.toUpperCase(), { x, y, size: 7, font: labelFont, color: MUTED });
  const lines = wrapText(value, 34);
  page.drawText(lines[0] ?? "—", { x, y: y - 12, size: 10, font: valueFont, color: INK });
  return lines.length;
}

export async function renderPartnershipTopupReceipt(data: PartnerTopupReceiptData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([460, 650]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  page.drawRectangle({ x: 0, y: 0, width: 460, height: 650, color: WHITE });
  page.drawRectangle({ x: 0, y: 640, width: 460, height: 10, color: PURPLE });

  page.drawText("WELILE", { x: 32, y: 598, size: 22, font: bold, color: PURPLE });
  page.drawText("TECHNOLOGIES LIMITED", { x: 33, y: 583, size: 7, font: bold, color: MUTED });
  page.drawText("OFFICIAL RECEIPT", { x: 322, y: 595, size: 8, font: bold, color: MUTED });
  page.drawText(clean(data.receiptNumber), { x: 322, y: 581, size: 8, font: regular, color: INK });

  page.drawText("PARTNER TOP-UP RECEIPT", { x: 32, y: 535, size: 18, font: bold, color: INK });
  page.drawText("This receipt confirms capital added to your partnership portfolio.", {
    x: 32, y: 518, size: 9, font: regular, color: MUTED,
  });

  page.drawRectangle({ x: 32, y: 432, width: 396, height: 64, color: SOFT_PURPLE, borderColor: BORDER, borderWidth: 1 });
  page.drawText("TOP-UP AMOUNT", { x: 52, y: 474, size: 8, font: bold, color: MUTED });
  page.drawText(money(data.topupAmount), { x: 52, y: 448, size: 22, font: bold, color: PURPLE });
  page.drawText("Capital contribution received", { x: 300, y: 459, size: 8, font: regular, color: MUTED });
  page.drawText(clean(data.effectiveAt), { x: 300, y: 445, size: 8, font: bold, color: INK });

  page.drawText("PORTFOLIO DETAILS", { x: 32, y: 402, size: 9, font: bold, color: PURPLE });
  page.drawLine({ start: { x: 32, y: 394 }, end: { x: 428, y: 394 }, thickness: 1, color: BORDER });
  drawLabelValue(page, "Portfolio", clean(data.portfolioName), 32, 374, regular, bold);
  drawLabelValue(page, "Portfolio ID", clean(data.portfolioId), 245, 374, regular, bold);
  drawLabelValue(page, "Previous principal", money(data.previousPrincipal), 32, 330, regular, bold);
  drawLabelValue(page, "New total principal", money(data.newTotalPrincipal), 245, 330, regular, bold);

  page.drawText("PARTNER INFORMATION", { x: 32, y: 276, size: 9, font: bold, color: PURPLE });
  page.drawLine({ start: { x: 32, y: 268 }, end: { x: 428, y: 268 }, thickness: 1, color: BORDER });
  drawLabelValue(page, "Partner", clean(data.partnerName), 32, 248, regular, bold);
  drawLabelValue(page, "Partner ID", clean(data.partnerId), 245, 248, regular, bold);
  drawLabelValue(page, "Portfolios topped up", String(data.portfoliosToppedUpCount || 1), 32, 204, regular, bold);
  drawLabelValue(page, "Reviewed by", clean(data.reviewedBy, "System"), 245, 204, regular, bold);

  page.drawRectangle({ x: 32, y: 104, width: 396, height: 60, color: SOFT_PURPLE });
  page.drawText("AUDIT TIMESTAMPS", { x: 48, y: 145, size: 8, font: bold, color: PURPLE });
  page.drawText(`Effective: ${clean(data.effectiveAt)}`, { x: 48, y: 128, size: 8, font: regular, color: INK });
  page.drawText(`Created: ${clean(data.createdAt)}`, { x: 48, y: 115, size: 8, font: regular, color: INK });

  page.drawLine({ start: { x: 32, y: 76 }, end: { x: 428, y: 76 }, thickness: 1, color: BORDER });
  page.drawText("Returns accrue per the Master Partnership Agreement.", { x: 32, y: 57, size: 8, font: regular, color: MUTED });
  page.drawText("Welile Technologies Limited · partnership@welile.com", { x: 32, y: 42, size: 8, font: bold, color: INK });

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
