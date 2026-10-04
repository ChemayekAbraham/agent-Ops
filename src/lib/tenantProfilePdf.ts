import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

export interface TenantProfilePdfData {
  aiId: string;
  fullName: string;
  phone: string;
  email: string;
  nationalId: string | null;
  verified: boolean;
  memberSince: string;
  monthlyRent: number | null;

  // Risk & rating
  riskLabel: string;
  completionRate: number;
  earningLabel: string;
  earningStars: number;

  // Financial summary
  totalRequests: number;
  totalRepaid: number;
  totalOwing: number;
  currentOutstanding: number;
  walletBalance: number;

  // Property
  landlordName: string | null;
  propertyAddress: string | null;
  houseType: string | null;

  // Rent plans
  rentPlans: {
    date: string;
    rentAmount: number;
    totalRepayment: number;
    amountRepaid: number;
    status: string;
  }[];

  // GPS
  latitude?: number | null;
  longitude?: number | null;
}

async function loadLogoAsBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function formatDate(d: string): string {
  return new Date(d).toLocaleDateString('en-UG', { year: 'numeric', month: 'long', day: 'numeric' });
}

export async function generateTenantProfilePdf(data: TenantProfilePdfData): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const cw = pw - margin * 2;
  let y = 14;

  // ─── BRANDED HEADER ───
  const logoBase64 = await loadLogoAsBase64();
  if (logoBase64) {
    pdf.addImage(logoBase64, 'PNG', margin, y - 4, 14, 14);
  }

  const textX = margin + 18;
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('Welile Technologies Limited', textX, y + 2);

  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text('Plot 24, Kampala Road, Kampala, Uganda', textX, y + 7);
  pdf.text('support@welile.com  |  www.welile.com', textX, y + 11);

  y += 20;

  // Accent line
  pdf.setDrawColor(59, 130, 246);
  pdf.setLineWidth(0.8);
  pdf.line(margin, y, pw - margin, y);
  y += 6;

  // Title
  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('TENANT PROFILE REPORT', margin, y);

  // Date
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text(`Generated: ${new Date().toLocaleDateString('en-UG', { year: 'numeric', month: 'long', day: 'numeric' })}`, pw - margin, y, { align: 'right' });
  y += 10;

  // Helper: section header
  const sectionHeader = (title: string) => {
    if (y > ph - 30) { pdf.addPage(); y = 16; }
    pdf.setFillColor(241, 245, 249);
    pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(51, 65, 85);
    pdf.text(title, margin + 3, y + 1);
    y += 8;
  };

  // Helper: row
  const row = (label: string, value: string, valueColor?: [number, number, number]) => {
    if (y > ph - 20) { pdf.addPage(); y = 16; }
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text(label, margin + 3, y);
    pdf.setFont('helvetica', 'bold');
    if (valueColor) pdf.setTextColor(...valueColor);
    else pdf.setTextColor(30, 41, 59);
    pdf.text(value, pw - margin - 3, y, { align: 'right' });
    y += 6;
  };

  // ─── AI ID & Risk ───
  sectionHeader('WELILE AI ID & TRUST SCORE');
  row('AI ID', data.aiId);
  row('Risk Tier', data.riskLabel);
  row('Completion Rate', `${data.completionRate}%`, data.completionRate >= 80 ? [34, 197, 94] : data.completionRate >= 50 ? [59, 130, 246] : [239, 68, 68]);
  row('Earning Rating', `${'★'.repeat(data.earningStars)}${'☆'.repeat(5 - data.earningStars)} ${data.earningLabel}`);
  y += 2;

  // ─── Personal Details ───
  sectionHeader('PERSONAL DETAILS');
  row('Full Name', data.fullName);
  row('Phone', data.phone);
  if (data.email) row('Email', data.email);
  if (data.nationalId) row('National ID', data.nationalId);
  row('Verified', data.verified ? '✓ Yes' : '✗ No', data.verified ? [34, 197, 94] : [239, 68, 68]);
  row('Member Since', formatDate(data.memberSince));
  if (data.monthlyRent && data.monthlyRent > 0) row('Monthly Rent', formatUGX(data.monthlyRent));
  y += 2;

  // ─── Property ───
  if (data.landlordName) {
    sectionHeader('CURRENT PROPERTY');
    row('Landlord', data.landlordName);
    if (data.propertyAddress) row('Address', data.propertyAddress);
    if (data.houseType) row('House Type', data.houseType);
    if (data.latitude && data.longitude) {
      row('GPS', `${data.latitude.toFixed(5)}, ${data.longitude.toFixed(5)}`);
    }
    y += 2;
  }

  // ─── Financial Summary ───
  sectionHeader('FINANCIAL SUMMARY');
  row('Total Rent Plans', String(data.totalRequests));
  row('Total Repaid', formatUGX(data.totalRepaid), [34, 197, 94]);
  row('Total Owing', data.totalOwing > 0 ? formatUGX(data.totalOwing) : 'Clear ✓', data.totalOwing > 0 ? [239, 68, 68] : [34, 197, 94]);
  if (data.currentOutstanding > 0) {
    row('Current Outstanding', formatUGX(data.currentOutstanding), [239, 68, 68]);
  }
  row('Wallet Balance', formatUGX(data.walletBalance));
  y += 2;

  // ─── Rent Plan History ───
  if (data.rentPlans.length > 0) {
    sectionHeader('RENT PLAN HISTORY');

    // Table header
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(100, 116, 139);
    const cols = [margin + 3, margin + 30, margin + 60, margin + 95, margin + 130];
    pdf.text('Date', cols[0], y);
    pdf.text('Rent', cols[1], y);
    pdf.text('Total Due', cols[2], y);
    pdf.text('Repaid', cols[3], y);
    pdf.text('Status', cols[4], y);
    y += 2;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pw - margin, y);
    y += 4;

    for (const plan of data.rentPlans.slice(0, 10)) {
      if (y > ph - 20) { pdf.addPage(); y = 16; }
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(30, 41, 59);
      pdf.text(formatDate(plan.date), cols[0], y);
      pdf.text(formatUGX(plan.rentAmount), cols[1], y);
      pdf.text(formatUGX(plan.totalRepayment), cols[2], y);
      pdf.setTextColor(34, 197, 94);
      pdf.text(formatUGX(plan.amountRepaid), cols[3], y);
      const owing = plan.totalRepayment - plan.amountRepaid;
      pdf.setTextColor(owing > 0 ? 239 : 34, owing > 0 ? 68 : 197, owing > 0 ? 68 : 94);
      pdf.text(plan.status.charAt(0).toUpperCase() + plan.status.slice(1), cols[4], y);
      y += 5;
    }
    y += 2;
  }

  // ─── Footer ───
  const footerY = ph - 12;
  pdf.setDrawColor(226, 232, 240);
  pdf.setLineWidth(0.3);
  pdf.line(margin, footerY - 4, pw - margin, footerY - 4);
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(148, 163, 184);
  pdf.text('This report is generated by Welile Technologies Limited and is intended for authorized use only.', margin, footerY);
  pdf.text('Confidential — Do not share with unauthorized parties.', pw - margin, footerY, { align: 'right' });

  return pdf.output('blob');
}

export async function shareTenantProfileWhatsApp(data: TenantProfilePdfData, recipientPhone?: string): Promise<void> {
  const blob = await generateTenantProfilePdf(data);
  const file = new File([blob], `Tenant_Profile_${data.fullName.replace(/\s+/g, '_')}.pdf`, { type: 'application/pdf' });

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      title: `Tenant Profile — ${data.fullName}`,
      text: `Welile Tenant Profile for ${data.fullName} (AI ID: ${data.aiId})`,
      files: [file],
    });
  } else {
    // Fallback: download
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
}
