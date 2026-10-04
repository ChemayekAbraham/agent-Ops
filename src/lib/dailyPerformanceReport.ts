import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

export interface DailyTenantRow {
  tenant_name: string;
  phone: string;
  daily_repayment: number;
  paidToday: number;
  hasPaid: boolean;
  agent_name: string;
  agent_phone: string;
  tenant_wallet: number;
}

export interface DailyPerformanceData {
  date: Date;
  totalExpected: number;
  totalCollected: number;
  collectionRate: number;
  paidCount: number;
  unpaidCount: number;
  tenants: DailyTenantRow[];
}

export async function generateDailyPerformancePdf(data: DailyPerformanceData): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;
  let y = 0;

  // ── Header ──────────────────────────────────────────────
  pdf.setFillColor(34, 197, 94);
  pdf.rect(0, 0, pw, 30, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.text('WELILE — Daily Repayment Report', pw / 2, 12, { align: 'center' });
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'normal');
  pdf.text(format(data.date, 'EEEE, MMMM d, yyyy'), pw / 2, 20, { align: 'center' });
  pdf.setFontSize(8);
  pdf.text(`Generated: ${format(new Date(), 'HH:mm')}`, pw / 2, 27, { align: 'center' });
  y = 36;

  // ── Summary KPIs ────────────────────────────────────────
  const boxW = (pw - margin * 2 - 6) / 3;

  // Box 1: Expected
  pdf.setFillColor(240, 253, 244);
  pdf.roundedRect(margin, y, boxW, 18, 2, 2, 'F');
  pdf.setTextColor(22, 163, 74);
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'normal');
  pdf.text('EXPECTED TODAY', margin + 3, y + 6);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text(formatUGX(data.totalExpected), margin + 3, y + 14);

  // Box 2: Collected
  const x2 = margin + boxW + 3;
  pdf.setFillColor(219, 234, 254);
  pdf.roundedRect(x2, y, boxW, 18, 2, 2, 'F');
  pdf.setTextColor(37, 99, 235);
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'normal');
  pdf.text('COLLECTED TODAY', x2 + 3, y + 6);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text(formatUGX(data.totalCollected), x2 + 3, y + 14);

  // Box 3: Collection Rate
  const x3 = margin + boxW * 2 + 6;
  const rateColor = data.collectionRate >= 70 ? [22, 163, 74] : data.collectionRate >= 40 ? [202, 138, 4] : [220, 38, 38];
  const rateBg = data.collectionRate >= 70 ? [240, 253, 244] : data.collectionRate >= 40 ? [255, 251, 235] : [254, 242, 242];
  pdf.setFillColor(rateBg[0], rateBg[1], rateBg[2]);
  pdf.roundedRect(x3, y, boxW, 18, 2, 2, 'F');
  pdf.setTextColor(rateColor[0], rateColor[1], rateColor[2]);
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'normal');
  pdf.text('COLLECTION RATE', x3 + 3, y + 6);
  pdf.setFontSize(14);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`${data.collectionRate}%`, x3 + 3, y + 14);

  y += 24;

  // Gap / shortfall
  const gap = data.totalExpected - data.totalCollected;
  pdf.setTextColor(100, 100, 100);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.text(`Paid: ${data.paidCount} tenants  |  Unpaid: ${data.unpaidCount} tenants  |  Gap: ${formatUGX(Math.max(0, gap))}`, margin, y);
  y += 8;

  // ── Table ───────────────────────────────────────────────
  // Column positions
  const cols = {
    name: margin,
    expected: margin + 50,
    actual: margin + 85,
    diff: margin + 115,
    status: margin + 145,
    agent: margin + 162,
  };

  // Table header
  pdf.setFillColor(34, 197, 94);
  pdf.rect(margin, y, pw - margin * 2, 7, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(7);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Tenant', cols.name + 2, y + 5);
  pdf.text('Expected', cols.expected + 2, y + 5);
  pdf.text('Actual', cols.actual + 2, y + 5);
  pdf.text('Difference', cols.diff + 2, y + 5);
  pdf.text('Status', cols.status + 2, y + 5);
  pdf.text('Agent', cols.agent + 2, y + 5);
  y += 9;

  // Sort: unpaid first, then by expected desc
  const sorted = [...data.tenants].sort((a, b) => {
    if (a.hasPaid !== b.hasPaid) return a.hasPaid ? 1 : -1;
    return b.daily_repayment - a.daily_repayment;
  });

  const rowH = 7;
  pdf.setFontSize(7);

  for (let i = 0; i < sorted.length; i++) {
    if (y + rowH > ph - 20) {
      pdf.addPage();
      y = margin;
      // Re-draw header on new page
      pdf.setFillColor(34, 197, 94);
      pdf.rect(margin, y, pw - margin * 2, 7, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(7);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Tenant', cols.name + 2, y + 5);
      pdf.text('Expected', cols.expected + 2, y + 5);
      pdf.text('Actual', cols.actual + 2, y + 5);
      pdf.text('Difference', cols.diff + 2, y + 5);
      pdf.text('Status', cols.status + 2, y + 5);
      pdf.text('Agent', cols.agent + 2, y + 5);
      y += 9;
    }

    const t = sorted[i];
    const diff = t.paidToday - t.daily_repayment;

    // Alternating row background
    if (i % 2 === 0) {
      pdf.setFillColor(249, 250, 251);
      pdf.rect(margin, y - 2, pw - margin * 2, rowH, 'F');
    }

    // Status-based row highlight
    if (!t.hasPaid) {
      pdf.setFillColor(254, 242, 242);
      pdf.rect(margin, y - 2, pw - margin * 2, rowH, 'F');
    }

    pdf.setTextColor(30, 30, 30);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7);
    pdf.text((t.tenant_name || '—').substring(0, 24), cols.name + 2, y + 3);
    pdf.text(formatUGX(t.daily_repayment), cols.expected + 2, y + 3);

    // Actual - bold
    pdf.setFont('helvetica', 'bold');
    pdf.text(formatUGX(t.paidToday), cols.actual + 2, y + 3);

    // Difference
    pdf.setFont('helvetica', 'normal');
    if (diff >= 0) {
      pdf.setTextColor(22, 163, 74);
    } else {
      pdf.setTextColor(220, 38, 38);
    }
    pdf.text(formatUGX(diff), cols.diff + 2, y + 3);

    // Status
    pdf.setTextColor(t.hasPaid ? 22 : 220, t.hasPaid ? 163 : 38, t.hasPaid ? 74 : 38);
    pdf.setFont('helvetica', 'bold');
    pdf.text(t.hasPaid ? '✓ Paid' : '✗ Unpaid', cols.status + 2, y + 3);

    // Agent
    pdf.setTextColor(100, 100, 100);
    pdf.setFont('helvetica', 'normal');
    pdf.text((t.agent_name || '—').substring(0, 14), cols.agent + 2, y + 3);

    y += rowH;
  }

  // ── Footer ──────────────────────────────────────────────
  const pageCount = (pdf.internal as any).getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    pdf.setPage(p);
    pdf.setFontSize(7);
    pdf.setTextColor(150);
    pdf.text(
      'Welile Platform — Daily Repayment Performance Report. For support: +256708257899',
      pw / 2, ph - 8, { align: 'center' }
    );
    pdf.text(`Page ${p} of ${pageCount}`, pw - margin, ph - 8, { align: 'right' });
  }

  return pdf.output('blob');
}

export function buildDailyPerformanceWhatsApp(data: DailyPerformanceData): string {
  const gap = Math.max(0, data.totalExpected - data.totalCollected);
  const dateStr = format(data.date, 'EEEE, MMM d yyyy');

  const lines = [
    `📊 *Welile Daily Repayment Report*`,
    `📅 ${dateStr}`,
    `━━━━━━━━━━━━━━━━`,
    `💰 *Expected:* ${formatUGX(data.totalExpected)}`,
    `✅ *Collected:* ${formatUGX(data.totalCollected)}`,
    `📉 *Gap:* ${formatUGX(gap)}`,
    `📈 *Rate:* ${data.collectionRate}%`,
    `━━━━━━━━━━━━━━━━`,
    `👥 Paid: ${data.paidCount} | Unpaid: ${data.unpaidCount}`,
    ``,
  ];

  // Top unpaid tenants (max 15)
  const unpaid = data.tenants.filter(t => !t.hasPaid).sort((a, b) => b.daily_repayment - a.daily_repayment);
  if (unpaid.length > 0) {
    lines.push(`⚠️ *Unpaid Tenants:*`);
    for (const t of unpaid.slice(0, 15)) {
      lines.push(`• ${t.tenant_name} — ${formatUGX(t.daily_repayment)} (Agent: ${t.agent_name})`);
    }
    if (unpaid.length > 15) {
      lines.push(`... and ${unpaid.length - 15} more`);
    }
  }

  lines.push('', `━━━━━━━━━━━━━━━━`, `Powered by Welile`);
  return lines.join('\n');
}

export async function downloadDailyPerformancePdf(data: DailyPerformanceData): Promise<void> {
  const blob = await generateDailyPerformancePdf(data);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `welile-daily-report-${format(data.date, 'yyyy-MM-dd')}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

export function shareDailyPerformanceWhatsApp(data: DailyPerformanceData, phone?: string): void {
  const msg = encodeURIComponent(buildDailyPerformanceWhatsApp(data));
  const waUrl = phone
    ? `https://wa.me/${phone.replace(/\D/g, '')}?text=${msg}`
    : `https://wa.me/?text=${msg}`;
  window.open(waUrl, '_blank');
}
