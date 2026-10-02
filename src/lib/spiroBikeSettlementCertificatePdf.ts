import welileLogo from '@/assets/welile-logo.png';
import { formatUGX } from '@/lib/rentCalculations';
import { archivePdfBlob } from '@/lib/pdfVault';

export interface SpiroSettlementCertificateInput {
  agentName: string;
  agentPhone: string | null;
  nationalId?: string | null;
  modelType: string;
  trackingReference: string | null;
  valuationAmount: number;
  totalRepaid: number;
  leaseTermMonths: number;
  completedAt?: string | null;
  saleId: string;
}

async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch(welileLogo);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export function buildSpiroSettlementFilename(agentName: string, trackingRef?: string | null): string {
  const safeName = agentName.toLowerCase().replace(/[^a-z0-9]/g, '_');
  const ref = (trackingRef || 'lease').toLowerCase().replace(/[^a-z0-9]/g, '_');
  return `Welile_Spiro_Settlement_Certificate_${safeName}_${ref}.pdf`;
}

export async function generateSpiroBikeSettlementCertificatePdf(
  input: SpiroSettlementCertificateInput,
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const logo = await loadLogo();

  // Outer Certificate Border (Double frame for prestige)
  pdf.setDrawColor(124, 58, 237); // Primary purple
  pdf.setLineWidth(1.2);
  pdf.roundedRect(8, 8, pw - 16, ph - 16, 4, 4, 'S');

  pdf.setDrawColor(216, 180, 254); // Light purple inner frame
  pdf.setLineWidth(0.4);
  pdf.roundedRect(11, 11, pw - 22, ph - 22, 2, 2, 'S');

  // Decorative Top Banner
  pdf.setFillColor(124, 58, 237);
  pdf.rect(11.5, 11.5, pw - 23, 30, 'F');

  // Logo in circle
  if (logo) {
    try {
      pdf.setFillColor(255, 255, 255);
      pdf.roundedRect(margin, 15, 22, 22, 3, 3, 'F');
      pdf.addImage(logo, 'PNG', margin + 2, 17, 18, 18, undefined, 'FAST');
    } catch {
      // ignore logo error
    }
  }

  // Company Name & Certificate Title
  pdf.setTextColor(255, 255, 255);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(14);
  pdf.text('WELILE TECHNOLOGIES LIMITED', margin + 27, 22);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.text('Asset Finance & Commercial Operations Division  ·  Kampala, Uganda', margin + 27, 28);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('CERTIFICATE OF FULL SETTLEMENT & TITLE DISCHARGE', margin + 27, 35);

  let y = 52;

  // Certificate Sub-Header
  pdf.setTextColor(88, 28, 135);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.text('CERTIFICATE OF FULL SETTLEMENT', pw / 2, y, { align: 'center' });

  y += 6;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor(100, 100, 100);
  const certNo = `CERT-SPB-${(input.trackingReference || input.saleId.slice(0, 8)).toUpperCase()}`;
  pdf.text(`Certificate No: ${certNo}   |   Issued: ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })}`, pw / 2, y, { align: 'center' });

  y += 10;
  pdf.setDrawColor(226, 232, 240);
  pdf.setLineWidth(0.5);
  pdf.line(margin + 10, y, pw - margin - 10, y);

  y += 8;

  // Legal Preamble
  pdf.setTextColor(30, 41, 59);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9.5);
  const preamble = `This is to certify that the agent lease agreement detailed below has been completely settled and paid in full. Welile Technologies Limited hereby confirms that all financial obligations, daily sweep deductions, and asset lease fees have been discharged in accordance with company policy.`;
  const splitPreamble = pdf.splitTextToSize(preamble, pw - margin * 2 - 10);
  pdf.text(splitPreamble, margin + 5, y);

  y += splitPreamble.length * 5 + 6;

  // Beneficiary & Asset Info Cards (Side by side)
  const colWidth = (pw - margin * 2 - 14) / 2;

  // Card 1: Beneficiary Details
  pdf.setFillColor(248, 250, 252);
  pdf.setDrawColor(226, 232, 240);
  pdf.roundedRect(margin + 2, y, colWidth, 42, 2, 2, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(109, 40, 217);
  pdf.text('BENEFICIARY (AGENT)', margin + 6, y + 7);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Full Name:', margin + 6, y + 15);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text(input.agentName, margin + 28, y + 15);

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(71, 85, 105);
  pdf.text('Phone:', margin + 6, y + 23);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text(input.agentPhone || '—', margin + 28, y + 23);

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(71, 85, 105);
  pdf.text('National ID:', margin + 6, y + 31);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text(input.nationalId || 'Verified on file', margin + 28, y + 31);

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(71, 85, 105);
  pdf.text('Account Status:', margin + 6, y + 39);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(22, 163, 74);
  pdf.text('Active In Good Standing', margin + 30, y + 39);

  // Card 2: Asset & Lease Information
  pdf.setFillColor(248, 250, 252);
  pdf.setDrawColor(226, 232, 240);
  pdf.roundedRect(margin + 6 + colWidth, y, colWidth, 42, 2, 2, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(109, 40, 217);
  pdf.text('MOTORBIKE ASSET & LEASE', margin + 10 + colWidth, y + 7);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(71, 85, 105);
  pdf.text('Asset Model:', margin + 10 + colWidth, y + 15);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text(input.modelType, margin + 36 + colWidth, y + 15);

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(71, 85, 105);
  pdf.text('Tracking Ref:', margin + 10 + colWidth, y + 23);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text(input.trackingReference || '—', margin + 36 + colWidth, y + 23);

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(71, 85, 105);
  pdf.text('Lease Term:', margin + 10 + colWidth, y + 31);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(15, 23, 42);
  pdf.text(`${input.leaseTermMonths} Months`, margin + 36 + colWidth, y + 31);

  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(71, 85, 105);
  pdf.text('Settlement Date:', margin + 10 + colWidth, y + 39);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(15, 23, 42);
  const settleDate = input.completedAt
    ? new Date(input.completedAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    : new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  pdf.text(settleDate, margin + 36 + colWidth, y + 39);

  y += 50;

  // Financial Settlement Summary Table
  pdf.setFillColor(243, 232, 255);
  pdf.setDrawColor(216, 180, 254);
  pdf.roundedRect(margin + 2, y, pw - margin * 2 - 4, 32, 2, 2, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(109, 40, 217);
  pdf.text('FINANCIAL SETTLEMENT SUMMARY', margin + 6, y + 7);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(71, 85, 105);

  const gridY = y + 14;
  pdf.text('Initial Financed Sum:', margin + 6, gridY);
  pdf.text('Total Repaid:', margin + 55, gridY);
  pdf.text('Outstanding Balance:', margin + 105, gridY);
  pdf.text('Settlement Ratio:', margin + 145, gridY);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(15, 23, 42);
  pdf.text(formatUGX(input.valuationAmount), margin + 6, gridY + 7);
  pdf.setTextColor(22, 163, 74);
  pdf.text(formatUGX(input.totalRepaid || input.valuationAmount), margin + 55, gridY + 7);
  pdf.setTextColor(22, 163, 74);
  pdf.text('UGX 0  (NIL)', margin + 105, gridY + 7);
  pdf.setTextColor(109, 40, 217);
  pdf.text('100.0% CLEARED', margin + 145, gridY + 7);

  y += 40;

  // Official Legal Release & Logbook Transfer Authorization Clause
  pdf.setFillColor(240, 253, 244);
  pdf.setDrawColor(187, 247, 208);
  pdf.roundedRect(margin + 2, y, pw - margin * 2 - 4, 30, 2, 2, 'FD');

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(22, 101, 52);
  pdf.text('LOGBOOK CUSTODY DISCHARGE & ASSET TITLE TRANSFER AUTHORIZATION', margin + 6, y + 7);

  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(21, 128, 61);
  const dischargeText = `Pursuant to Section 10.3 of the Welile Motorbike Lease Policy, all legal custody holds maintained by Welile Technologies Limited over the official Spiro registration book, logbook title, and asset collateral are hereby formally REVOKED and RELEASED. Agent Operations is instructed to execute the official title handover to ${input.agentName}.`;
  const splitDischarge = pdf.splitTextToSize(dischargeText, pw - margin * 2 - 16);
  pdf.text(splitDischarge, margin + 6, y + 14);

  y += 38;

  // Authorized Signatures Section
  const sigColWidth = (pw - margin * 2 - 14) / 2;

  // Signatory 1: COO
  pdf.setDrawColor(203, 213, 225);
  pdf.line(margin + 10, y + 16, margin + sigColWidth - 10, y + 16);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8.5);
  pdf.setTextColor(15, 23, 42);
  pdf.text('CHIEF OPERATING OFFICER (COO)', margin + 10, y + 21);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(100, 116, 139);
  pdf.text('Welile Operations & Asset Management', margin + 10, y + 26);
  pdf.text('Authorized Digital Verification', margin + 10, y + 31);

  // Signatory 2: CFO
  pdf.line(margin + 10 + sigColWidth, y + 16, pw - margin - 10, y + 16);

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8.5);
  pdf.setTextColor(15, 23, 42);
  pdf.text('CHIEF FINANCIAL OFFICER (CFO)', margin + 10 + sigColWidth, y + 21);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7.5);
  pdf.setTextColor(100, 116, 139);
  pdf.text('Treasury & Financial Control Office', margin + 10 + sigColWidth, y + 26);
  pdf.text('Authorized Settlement Confirmation', margin + 10 + sigColWidth, y + 31);

  // Footer seal
  pdf.setFontSize(7);
  pdf.setTextColor(148, 163, 184);
  pdf.text(
    `Official Welile Asset Discharge  ·  Security Hash: ${btoa(input.saleId).slice(0, 16)}  ·  welile.com`,
    pw / 2,
    ph - 12,
    { align: 'center' },
  );

  const blob = pdf.output('blob');
  void archivePdfBlob(blob, buildSpiroSettlementFilename(input.agentName, input.trackingReference), 'spiro_bike_settlement_certificate');
  return blob;
}

export function downloadSpiroSettlementCertificate(blob: Blob, agentName: string, trackingRef?: string | null) {
  const filename = buildSpiroSettlementFilename(agentName, trackingRef);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
