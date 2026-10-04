import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

export interface ScheduleDay {
  day: number;
  date: Date;
  status: 'paid' | 'missed' | 'due_today' | 'upcoming' | 'today';
  expected: number;
  paid: number;
}

export interface RepaymentPdfData {
  tenantName: string;
  phone?: string;
  propertyAddress?: string;
  landlordName?: string;
  agentName?: string;
  agentPhone?: string;
  rentAmount: number;
  totalRepayment: number;
  dailyRepayment: number;
  durationDays: number;
  status: string;
  paidAmount: number;
  schedule: ScheduleDay[];
  startDate?: string;
}

export async function generateRepaymentPdf(data: RepaymentPdfData): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  const paidDays = data.schedule.filter(d => d.status === 'paid').length;
  const missedDays = data.schedule.filter(d => d.status === 'missed').length;
  const upcomingDays = data.schedule.filter(d => d.status === 'upcoming' || d.status === 'due_today' || d.status === 'today').length;
  const progress = data.totalRepayment > 0 ? Math.min(100, (data.paidAmount / data.totalRepayment) * 100) : 0;

  // ─── Header ───────────────────────────────────────────────
  doc.setFillColor(34, 197, 94); // green
  doc.rect(0, 0, pageWidth, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('WELILE PLATFORM', pageWidth / 2, 12, { align: 'center' });
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Repayment Schedule Report', pageWidth / 2, 21, { align: 'center' });
  doc.setFontSize(8);
  doc.text(`Generated: ${format(new Date(), 'MMMM d, yyyy HH:mm')}`, pageWidth / 2, 27, { align: 'center' });

  doc.setTextColor(30, 30, 30);

  // ─── Tenant Info ──────────────────────────────────────────
  let y = 38;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Tenant Information', 14, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);

  const infoRows: [string, string][] = [
    ['Tenant Name:', data.tenantName || 'N/A'],
    ...(data.phone ? [['Phone:', data.phone] as [string, string]] : []),
    ['Property:', data.propertyAddress || 'N/A'],
    ['Landlord:', data.landlordName || 'N/A'],
    ...(data.agentName ? [['Agent:', `${data.agentName}${data.agentPhone ? ` (${data.agentPhone})` : ''}`] as [string, string]] : []),
    ...(data.startDate ? [['Start Date:', format(new Date(data.startDate), 'MMM d, yyyy')] as [string, string]] : []),
  ];

  infoRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, 14, y);
    doc.setFont('helvetica', 'normal');
    doc.text(value, 55, y);
    y += 5;
  });

  // ─── Loan Summary ─────────────────────────────────────────
  y += 3;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Loan Summary', 14, y);
  y += 6;
  doc.setFontSize(9);

  const loanRows: [string, string][] = [
    ['Rent Amount:', formatUGX(data.rentAmount)],
    ['Access Fee + Costs:', formatUGX(data.totalRepayment - data.rentAmount)],
    ['Total Repayment:', formatUGX(data.totalRepayment)],
    ['Daily Repayment:', formatUGX(data.dailyRepayment)],
    ['Duration:', `${data.durationDays} days`],
    ['Status:', (data.status || 'Pending').toUpperCase()],
  ];

  loanRows.forEach(([label, value]) => {
    doc.setFont('helvetica', 'bold');
    doc.text(label, 14, y);
    doc.setFont('helvetica', 'normal');
    doc.text(value, 70, y);
    y += 5;
  });

  // ─── Progress Bar ─────────────────────────────────────────
  y += 3;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Payment Progress', 14, y);
  y += 6;

  // Background bar
  doc.setFillColor(220, 220, 220);
  doc.roundedRect(14, y, pageWidth - 28, 6, 2, 2, 'F');
  // Progress fill
  doc.setFillColor(34, 197, 94);
  const fillWidth = Math.max(0, ((pageWidth - 28) * progress) / 100);
  if (fillWidth > 0) doc.roundedRect(14, y, fillWidth, 6, 2, 2, 'F');
  y += 9;

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(`${progress.toFixed(1)}% Complete`, 14, y);
  doc.text(`Paid: ${formatUGX(data.paidAmount)}`, 60, y);
  doc.text(`Outstanding: ${formatUGX(Math.max(0, data.totalRepayment - data.paidAmount))}`, 110, y);
  y += 5;

  doc.setFontSize(8);
  doc.setFillColor(34, 197, 94);
  doc.circle(14, y + 1, 2, 'F');
  doc.text(`${paidDays} Paid Days`, 18, y + 2);
  doc.setFillColor(239, 68, 68);
  doc.circle(55, y + 1, 2, 'F');
  doc.text(`${missedDays} Missed Days`, 59, y + 2);
  doc.setFillColor(156, 163, 175);
  doc.circle(100, y + 1, 2, 'F');
  doc.text(`${upcomingDays} Upcoming`, 104, y + 2);
  y += 10;

  // ─── Schedule Table ───────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Day-by-Day Schedule', 14, y);
  y += 4;

  // Table header
  doc.setFillColor(34, 197, 94);
  doc.rect(14, y, pageWidth - 28, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('Day', 16, y + 4.5);
  doc.text('Date', 30, y + 4.5);
  doc.text('Status', 70, y + 4.5);
  doc.text('Expected', 110, y + 4.5);
  doc.text('Paid', 150, y + 4.5);
  y += 7;

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  data.schedule.forEach((day, i) => {
    if (y > 272) {
      doc.addPage();
      y = 15;
    }

    // Row background
    if (day.status === 'paid') {
      doc.setFillColor(240, 253, 244);
    } else if (day.status === 'missed') {
      doc.setFillColor(254, 242, 242);
    } else if (day.status === 'due_today' || day.status === 'today') {
      doc.setFillColor(255, 251, 235);
    } else if (i % 2 === 0) {
      doc.setFillColor(249, 249, 249);
    } else {
      doc.setFillColor(255, 255, 255);
    }
    doc.rect(14, y - 3, pageWidth - 28, 6.5, 'F');

    const statusText = day.status === 'paid' ? '✓ Paid'
      : day.status === 'missed' ? '✗ Missed'
      : day.status === 'due_today' || day.status === 'today' ? '! Due Today'
      : 'Upcoming';

    if (day.status === 'paid') doc.setTextColor(22, 163, 74);
    else if (day.status === 'missed') doc.setTextColor(220, 38, 38);
    else if (day.status === 'due_today' || day.status === 'today') doc.setTextColor(202, 138, 4);
    else doc.setTextColor(100, 100, 100);

    doc.text(String(day.day), 16, y + 1);
    doc.setTextColor(30, 30, 30);
    doc.text(format(day.date, 'MMM d, yyyy'), 30, y + 1);
    doc.text(statusText, 70, y + 1);
    doc.text(formatUGX(day.expected), 110, y + 1);
    doc.text(day.paid > 0 ? formatUGX(day.paid) : '-', 150, y + 1);

    y += 6.5;
  });

  // ─── Footer ───────────────────────────────────────────────
  const pageCount = (doc.internal as any).getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(150);
    doc.text(
      'This is an automated report generated by Welile Platform. For queries, contact your agent.',
      pageWidth / 2,
      290,
      { align: 'center' }
    );
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - 14, 290, { align: 'right' });
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}

export function buildWhatsAppMessage(data: RepaymentPdfData): string {
  const paidDays = data.schedule.filter(d => d.status === 'paid').length;
  const missedDays = data.schedule.filter(d => d.status === 'missed').length;
  const progress = data.totalRepayment > 0
    ? Math.min(100, (data.paidAmount / data.totalRepayment) * 100).toFixed(1)
    : '0.0';

  return encodeURIComponent(
    `*Welile Repayment Schedule*\n` +
    `─────────────────────\n` +
    `*Tenant:* ${data.tenantName}\n` +
    `*Property:* ${data.propertyAddress || 'N/A'}\n` +
    `*Landlord:* ${data.landlordName || 'N/A'}\n` +
    `─────────────────────\n` +
    `*Rent:* ${formatUGX(data.rentAmount)}\n` +
    `*Total Repayment:* ${formatUGX(data.totalRepayment)}\n` +
    `*Daily Amount:* ${formatUGX(data.dailyRepayment)}\n` +
    `*Duration:* ${data.durationDays} days\n` +
    `─────────────────────\n` +
    `*Progress:* ${progress}%\n` +
    `*Paid:* ${formatUGX(data.paidAmount)}\n` +
    `*Outstanding:* ${formatUGX(Math.max(0, data.totalRepayment - data.paidAmount))}\n` +
    `*Paid Days:* ${paidDays} ✅\n` +
    `*Missed Days:* ${missedDays} ❌\n` +
    `─────────────────────\n` +
    `Generated by Welile Platform`
  );
}

export async function downloadRepaymentPdf(data: RepaymentPdfData, filename?: string): Promise<void> {
  const bytes = await generateRepaymentPdf(data);
  const blob = new Blob([bytes as unknown as ArrayBuffer], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename || `welile-repayment-${data.tenantName.replace(/\s+/g, '-')}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

export async function shareRepaymentPdfWhatsApp(data: RepaymentPdfData, phone?: string): Promise<void> {
  const msg = buildWhatsAppMessage(data);
  const waUrl = phone
    ? `https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`
    : `https://wa.me/?text=${msg}`;
  window.open(waUrl, '_blank');
}
