characters — copy it exactly; do not wrap, shorten or regenerate it.

import { PDFDocument, StandardFonts, rgb } from "https://esm.sh/pdf-lib@1.17.1";

// The Welile wordmark from the company's headed paper (163 x 59, transparent).
const LOGO_BASE64 = "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";

const BRAND = rgb(0.282, 0.102, 0.498); // #481a7f, sampled from the logo
const INK = rgb(0.059, 0.09, 0.165);
const SUB = rgb(0.392, 0.455, 0.545);
const LINE = rgb(0.886, 0.91, 0.941);
const SOFT = rgb(0.973, 0.965, 0.988);

const PAGE_W = 595;
const PAGE_H = 842;
const M = 48;
const R = PAGE_W - M;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(String(v ?? 0).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const ugx = (v: unknown): string => `UGX ${Math.round(num(v)).toLocaleString("en-US")}`;
// Standard PDF fonts only carry Latin-1 plus a few punctuation marks; drop anything else.
const safe = (v: unknown, fallback = "—"): string => {
  const s = String(v ?? "").replace(/[^\x20-\x7E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D]/g, "").trim();
  return s || fallback;
};

function fit(text: string, font: any, size: number, maxWidth: number): string {
  let out = text;
  while (out.length > 4 && font.widthOfTextAtSize(out, size) > maxWidth) out = out.slice(0, -1);
  return out === text ? text : `${out.trimEnd()}…`;
}

export interface PayslipPdfLine { name?: string; amount?: number | string }

/** The templateData of the live 'salary-payslip' email, plus full_name and payslip_ref. */
export interface PayslipPdfData {
  first_name?: string;
  full_name?: string;
  period_label?: string;
  net_pay?: number | string;
  staff_ref?: string;
  position?: string;
  department?: string;
  paid_on?: string;
  earnings?: PayslipPdfLine[];
  gross_pay?: number | string;
  deductions?: PayslipPdfLine[];
  total_deductions?: number | string;
  employer_nssf?: number | string;
  payslip_ref?: string;
}

export async function renderPayslipPdf(d: PayslipPdfData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Payslip ${safe(d.period_label, "")} - ${safe(d.full_name || d.first_name, "")}`);
  pdf.setAuthor("Welile Technologies Ltd");
  const page = pdf.addPage([PAGE_W, PAGE_H]);
  const reg = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const t = (s: string, x: number, y: number, size: number, font: any = reg, color: any = INK) => page.drawText(s, { x, y, size, font, color });
  const tr = (s: string, xr: number, y: number, size: number, font: any = reg, color: any = INK) =>
    t(s, xr - font.widthOfTextAtSize(s, size), y, size, font, color);
  const tc = (s: string, y: number, size: number, font: any = reg, color: any = INK) =>
    t(s, (PAGE_W - font.widthOfTextAtSize(s, size)) / 2, y, size, font, color);
  const rule = (y: number, color: any = LINE, thickness = 0.8) =>
    page.drawLine({ start: { x: M, y }, end: { x: R, y }, thickness, color });

  // ---- Letterhead ----
  let logoDrawn = false;
  try {
    const png = await pdf.embedPng(LOGO_BASE64);
    const h = 38;
    page.drawImage(png, { x: M, y: 764, width: (png.width * h) / png.height, height: h });
    logoDrawn = true;
  } catch (_) {
    // Fall back to the wordmark in type rather than fail the payslip.
  }
  if (!logoDrawn) t("Welile", M, 772, 28, bold, BRAND);
  t("HOPE · FAITH · LOVE", M, 750, 7.5, bold, BRAND);

  tr("Welile Technologies Ltd", R, 794, 9, bold);
  tr("P.O. Box 167564, Kampala-Uganda", R, 781, 8);
  tr("weliletechnologies@gmail.com", R, 769, 8);
  tr("+256 744475573 / +256 764379713", R, 757, 8);
  rule(738, BRAND, 1.5);

  // ---- Title ----
  t("PAYSLIP", M, 704, 22, bold);
  tr(safe(d.period_label, ""), R, 710, 13, bold, BRAND);
  tr(`Paid on ${safe(d.paid_on)}`, R, 695, 8.5, reg, SUB);

  // ---- Employee ----
  const boxTop = 676;
  const boxH = 70;
  page.drawRectangle({ x: M, y: boxTop - boxH, width: R - M, height: boxH, color: SOFT, borderColor: LINE, borderWidth: 0.8 });
  const colL = M + 14;
  const colR = M + (R - M) / 2 + 8;
  const half = (R - M) / 2 - 24;
  const field = (label: string, value: unknown, x: number, y: number) => {
    t(label.toUpperCase(), x, y, 7, bold, SUB);
    t(fit(safe(value), bold, 10.5, half), x, y - 14, 10.5, bold);
  };
  field("Employee", d.full_name || d.first_name, colL, boxTop - 16);
  field("Staff ref", d.staff_ref, colR, boxTop - 16);
  field("Position", d.position, colL, boxTop - 44);
  field("Department", d.department, colR, boxTop - 44);

  // ---- Tables ----
  let y = boxTop - boxH - 30;
  const section = (label: string) => {
    t(label, M, y, 9, bold, BRAND);
    tr("UGX", R, y, 8, bold, SUB);
    y -= 8;
    rule(y, BRAND, 0.8);
    y -= 16;
  };
  const row = (label: unknown, value: unknown, strong = false) => {
    const font = strong ? bold : reg;
    t(fit(safe(label), font, 10, R - M - 120), M, y, 10, font);
    tr(Math.round(num(value)).toLocaleString("en-US"), R, y, 10, font);
    y -= 6;
    if (!strong) rule(y);
    y -= 14;
  };
  const totalRow = (label: string, value: unknown) => {
    y += 2;
    rule(y + 12, INK, 0.8);
    row(label, value, true);
    y -= 8;
  };

  section("EARNINGS");
  const earnings: PayslipPdfLine[] = Array.isArray(d.earnings) && d.earnings.length ? d.earnings : [{ name: "Basic salary", amount: d.gross_pay }];
  for (const e of earnings) row(e.name ?? "Earning", e.amount);
  totalRow("Gross pay", d.gross_pay);

  section("DEDUCTIONS");
  const deductions: PayslipPdfLine[] = Array.isArray(d.deductions) ? d.deductions : [];
  if (deductions.length === 0) row("No deductions this month", 0);
  for (const x of deductions) row(x.name ?? "Deduction", x.amount);
  const totalDeductions = d.total_deductions !== undefined && d.total_deductions !== null
    ? num(d.total_deductions)
    : deductions.reduce((s, x) => s + num(x.amount), 0);
  totalRow("Total deductions", totalDeductions);

  // ---- Net pay ----
  const netH = 56;
  page.drawRectangle({ x: M, y: y - netH + 14, width: R - M, height: netH, color: BRAND });
  t("NET PAY", M + 16, y - 8, 9, bold, rgb(1, 1, 1));
  t("Paid to your Welile wallet", M + 16, y - 24, 8.5, reg, rgb(0.9, 0.86, 0.96));
  tr(ugx(d.net_pay), R - 16, y - 20, 20, bold, rgb(1, 1, 1));
  y -= netH + 18;

  // ---- Employer contribution ----
  if (num(d.employer_nssf) > 0) {
    t("EMPLOYER CONTRIBUTION — NOT DEDUCTED FROM YOUR PAY", M, y, 7.5, bold, SUB);
    y -= 18;
    row("NSSF (employer 10%)", d.employer_nssf);
  }

  // ---- Footer ----
  rule(86);
  tc("This payslip is computer-generated and does not require a signature.", 70, 8, reg, SUB);
  tc("Keep it for your records. For any query about your pay, contact HR.", 58, 8, reg, SUB);
  tc(`Confidential · ${safe(d.staff_ref, "")} · Reference ${safe(d.payslip_ref, "")}`, 40, 7.5, bold, SUB);

  return pdf.save({ useObjectStreams: true });
}
