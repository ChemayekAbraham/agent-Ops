import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import type { AgentWalletReportData, AgentLedgerEntry } from './fetchAgentWalletData';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-UG', { year: 'numeric', month: 'short', day: 'numeric' });
}

function catLabel(cat: string) {
  return cat.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export async function generateAgentWalletReportPdf(data: AgentWalletReportData): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;
  let y = 0;

  const ensureSpace = (needed: number) => {
    if (y + needed > ph - 15) {
      pdf.addPage();
      y = margin;
    }
  };

  // ── Header ──
  pdf.setFillColor(146, 52, 234);
  pdf.rect(0, 0, pw, 30, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Welile — Agent Wallet Statement', margin, 12);
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  pdf.text(`Generated: ${new Date().toLocaleDateString('en-UG', { dateStyle: 'full' })}`, margin, 19);
  pdf.text(`Agent: ${data.agentName}  |  Phone: ${data.agentPhone}`, margin, 25);
  y = 36;

  // ── Wallet Summary ──
  pdf.setTextColor(0, 0, 0);
  pdf.setFillColor(240, 253, 244);
  pdf.roundedRect(margin, y, pw - margin * 2, 28, 2, 2, 'F');
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Wallet Summary', margin + 4, y + 6);
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'normal');
  const col1 = margin + 4;
  const col2 = pw / 2 + 4;
  pdf.text(`Total Balance: ${formatUGX(data.walletBalance)}`, col1, y + 13);
  pdf.text(`Float Balance: ${formatUGX(data.floatBalance)}`, col2, y + 13);
  pdf.text(`Commission Balance: ${formatUGX(data.commissionBalance)}`, col1, y + 19);
  pdf.text(`Total Deposits: ${formatUGX(data.totalDeposits)}`, col2, y + 19);
  pdf.setFont('helvetica', 'bold');
  pdf.text(`Total Rent Paid: ${formatUGX(data.totalRentPaid)}`, col1, y + 25);
  pdf.setFont('helvetica', 'normal');
  y += 34;

  // ── Rent Payment Breakdown ──
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Rent Payment Breakdown', margin, y);
  y += 5;

  if (data.rentEntries.length === 0) {
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'italic');
    pdf.text('No rent payments recorded.', margin, y + 4);
    y += 10;
  } else {
    // Table header
    pdf.setFillColor(146, 52, 234);
    pdf.rect(margin, y, pw - margin * 2, 6, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.text('Date', margin + 2, y + 4);
    pdf.text('Tenant', margin + 28, y + 4);
    pdf.text('Amount', pw / 2, y + 4);
    pdf.text('Tenant Bal', pw / 2 + 28, y + 4);
    pdf.text('Ref', pw - margin - 10, y + 4);
    y += 7;
    pdf.setTextColor(0, 0, 0);
    pdf.setFont('helvetica', 'normal');

    for (const e of data.rentEntries) {
      ensureSpace(6);
      const rowY = y + 4;
      pdf.setFontSize(8);
      pdf.text(fmtDate(e.created_at), margin + 2, rowY);
      const tenantLabel = e.tenant_name ? `Paid for: ${e.tenant_name}` : (e.description || catLabel(e.category));
      pdf.text(tenantLabel.substring(0, 35), margin + 28, rowY);
      pdf.text(formatUGX(e.amount), pw / 2, rowY);
      pdf.text(e.tenant_balance !== undefined ? formatUGX(e.tenant_balance) : '—', pw / 2 + 28, rowY);
      pdf.text((e.transaction_group_id || '').slice(0, 8), pw - margin - 10, rowY);
      y += 5.5;
    }
    y += 4;
  }

  // ── Full Transaction History ──
  ensureSpace(20);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(0, 0, 0);
  pdf.text('Full Transaction History', margin, y);
  y += 5;

  // Table header
  pdf.setFillColor(146, 52, 234);
  pdf.rect(margin, y, pw - margin * 2, 6, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Date', margin + 2, y + 4);
  pdf.text('Category', margin + 28, y + 4);
  pdf.text('In/Out', pw - margin - 50, y + 4);
  pdf.text('Amount', pw - margin - 32, y + 4);
  pdf.text('Description', pw - margin - 10, y + 4);
  y += 7;
  pdf.setTextColor(0, 0, 0);
  pdf.setFont('helvetica', 'normal');

  for (let i = 0; i < data.allEntries.length; i++) {
    const e = data.allEntries[i];
    ensureSpace(6);
    const isPositive = e.direction === 'credit' || e.direction === 'cash_in';

    if (i % 2 === 0) {
      pdf.setFillColor(248, 248, 248);
      pdf.rect(margin, y - 0.5, pw - margin * 2, 5.5, 'F');
    }

    const rowY = y + 3.5;
    pdf.setFontSize(7.5);
    pdf.text(fmtDate(e.created_at), margin + 2, rowY);
    pdf.text(catLabel(e.category).substring(0, 22), margin + 28, rowY);
    pdf.setTextColor(isPositive ? 22 : 220, isPositive ? 163 : 38, isPositive ? 74 : 38);
    pdf.text(isPositive ? 'IN' : 'OUT', pw - margin - 50, rowY);
    pdf.text(formatUGX(e.amount), pw - margin - 32, rowY);
    pdf.setTextColor(0, 0, 0);
    const shortDesc = (e.description || '').substring(0, 12);
    pdf.text(shortDesc, pw - margin - 10, rowY);
    y += 5.5;
  }

  // Footer
  ensureSpace(12);
  y += 4;
  pdf.setFontSize(7);
  pdf.setTextColor(120, 120, 120);
  pdf.text(`Report generated by Welile Platform — ${new Date().toISOString()}`, margin, y);
  pdf.text(`Entries: ${data.allEntries.length} | Rent payments: ${data.rentEntries.length}`, margin, y + 4);

  return pdf.output('blob');
}
