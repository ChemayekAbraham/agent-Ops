import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

interface AgentInfo {
  id: string;
  full_name: string;
  phone?: string | null;
}

function fmtDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function safeName(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, '_').slice(0, 60);
}

async function generateAdvancePdf(
  agent: AgentInfo,
  advances: any[],
  ledgerByAdvance: Record<string, any[]>,
  topupsByAdvance: Record<string, any[]>,
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  // Header
  doc.setFillColor(146, 52, 234);
  doc.rect(0, 0, pageWidth, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('WELILE', margin, 10);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Agent Advance Statement', margin, 16);
  doc.setFontSize(8);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, 10, { align: 'right' });
  doc.text('CFO Export — Confidential', pageWidth - margin, 16, { align: 'right' });

  // Agent info
  doc.setTextColor(0, 0, 0);
  let y = 30;
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(agent.full_name || 'Unknown Agent', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  y += 5;
  doc.text(`Phone: ${agent.phone || '—'}`, margin, y);
  y += 4;
  doc.text(`Agent ID: ${agent.id}`, margin, y);
  y += 6;

  // Summary
  const totalPrincipal = advances.reduce((s, a) => s + Number(a.principal || 0), 0);
  const totalAccessFee = advances.reduce((s, a) => s + Number(a.access_fee || 0), 0);
  const totalFeeCollected = advances.reduce((s, a) => s + Number(a.access_fee_collected || 0), 0);
  const totalOutstanding = advances.reduce((s, a) => s + Number(a.outstanding_balance || 0), 0);
  const totalInterest = advances.reduce(
    (s, a) => s + Math.max(0, Number(a.outstanding_balance || 0) - Number(a.principal || 0)),
    0,
  );

  autoTable(doc, {
    startY: y,
    head: [['Metric', 'Value']],
    body: [
      ['Total Advances', String(advances.length)],
      ['Total Principal', formatUGX(totalPrincipal)],
      ['Total Access Fee', formatUGX(totalAccessFee)],
      ['Fee Collected', formatUGX(totalFeeCollected)],
      ['Fee Outstanding', formatUGX(totalAccessFee - totalFeeCollected)],
      ['Total Outstanding', formatUGX(totalOutstanding)],
      ['Accrued Interest', formatUGX(totalInterest)],
    ],
    theme: 'striped',
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
    margin: { left: margin, right: margin },
  });

  // Per-advance sections
  for (const adv of advances) {
    let curY = (doc as any).lastAutoTable.finalY + 8;
    if (curY > 250) {
      doc.addPage();
      curY = 20;
    }

    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.text(`Advance ${adv.id.slice(0, 8)} — ${String(adv.status).toUpperCase()}`, margin, curY);
    curY += 5;

    autoTable(doc, {
      startY: curY,
      head: [['Field', 'Value', 'Field', 'Value']],
      body: [
        ['Issued', fmtDate(adv.issued_at), 'Expires', fmtDate(adv.expires_at)],
        ['Cycle Days', String(adv.cycle_days || '—'), 'Monthly Rate', `${(Number(adv.monthly_rate || 0) * 100).toFixed(2)}%`],
        ['Principal', formatUGX(adv.principal), 'Access Fee', formatUGX(adv.access_fee || 0)],
        ['Fee Collected', formatUGX(adv.access_fee_collected || 0), 'Fee Status', String(adv.access_fee_status || 'unpaid')],
        ['Outstanding', formatUGX(adv.outstanding_balance), 'Total Payable', formatUGX(Number(adv.principal) + Number(adv.access_fee || 0))],
      ],
      theme: 'grid',
      styles: { fontSize: 7.5 },
      headStyles: { fillColor: [71, 85, 105], textColor: 255 },
      margin: { left: margin, right: margin },
    });

    // Payment history
    const ledger = ledgerByAdvance[adv.id] || [];
    curY = (doc as any).lastAutoTable.finalY + 4;
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text(`Payment History (${ledger.length} entries)`, margin, curY);
    curY += 2;

    if (ledger.length === 0) {
      autoTable(doc, {
        startY: curY + 2,
        body: [['No deductions recorded yet.']],
        theme: 'plain',
        styles: { fontSize: 8, textColor: [120, 120, 120], fontStyle: 'italic' },
        margin: { left: margin, right: margin },
      });
    } else {
      autoTable(doc, {
        startY: curY + 2,
        head: [['Date', 'Opening', 'Interest', 'Deducted', 'Closing', 'Status']],
        body: ledger.map((row) => [
          fmtDate(row.date),
          formatUGX(row.opening_balance),
          formatUGX(row.interest_accrued),
          formatUGX(row.amount_deducted),
          formatUGX(row.closing_balance),
          String(row.deduction_status || '—'),
        ]),
        theme: 'striped',
        styles: { fontSize: 7 },
        headStyles: { fillColor: [30, 41, 59], textColor: 255 },
        margin: { left: margin, right: margin },
      });
    }

    // Top-ups
    const topups = topupsByAdvance[adv.id] || [];
    if (topups.length > 0) {
      curY = (doc as any).lastAutoTable.finalY + 4;
      if (curY > 260) { doc.addPage(); curY = 20; }
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text(`Top-ups (${topups.length})`, margin, curY);
      autoTable(doc, {
        startY: curY + 2,
        head: [['Date', 'Amount', 'Monthly Rate']],
        body: topups.map((t) => [
          fmtDate(t.created_at),
          formatUGX(t.amount),
          `${(Number(t.monthly_rate || 0) * 100).toFixed(2)}%`,
        ]),
        theme: 'striped',
        styles: { fontSize: 7 },
        headStyles: { fillColor: [30, 41, 59], textColor: 255 },
        margin: { left: margin, right: margin },
      });
    }
  }

  // Footer with page numbers
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(120, 120, 120);
    doc.text(
      `Page ${i} of ${pageCount} • Welile Agent Advance Statement • ${agent.full_name}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 6,
      { align: 'center' },
    );
  }

  return doc.output('blob');
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportConsolidatedPayments(
  advances: any[],
  filterLabel: string = 'all',
): Promise<{ filename: string; rowCount: number }> {
  if (advances.length === 0) throw new Error('No advances to export');

  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const advanceIds = advances.map((a) => a.id);
  const agentNameById = new Map<string, string>();
  advances.forEach((a) => {
    agentNameById.set(a.id, a.profiles?.full_name || 'Unknown Agent');
  });

  // Bulk fetch ledger
  const { data: ledger = [] } = await supabase
    .from('agent_advance_ledger')
    .select('*')
    .in('advance_id', advanceIds)
    .order('date', { ascending: false });

  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;

  // Header
  doc.setFillColor(146, 52, 234);
  doc.rect(0, 0, pageWidth, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text('WELILE', margin, 10);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Consolidated Advance Payments Report', margin, 16);
  doc.setFontSize(8);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`, pageWidth - margin, 10, { align: 'right' });
  doc.text(`Filter: ${filterLabel.toUpperCase()} • CFO Export`, pageWidth - margin, 16, { align: 'right' });

  doc.setTextColor(0, 0, 0);
  let y = 30;

  // Summary
  const totalPrincipal = advances.reduce((s, a) => s + Number(a.principal || 0), 0);
  const totalOutstanding = advances.reduce((s, a) => s + Number(a.outstanding_balance || 0), 0);
  const totalInterestAdv = advances.reduce(
    (s, a) => s + Math.max(0, Number(a.outstanding_balance || 0) - Number(a.principal || 0)),
    0,
  );
  const totalDeducted = (ledger as any[]).reduce((s, r) => s + Number(r.amount_deducted || 0), 0);
  const totalInterestLedger = (ledger as any[]).reduce((s, r) => s + Number(r.interest_accrued || 0), 0);
  const uniqueAgents = new Set(advances.map((a) => a.agent_id)).size;

  autoTable(doc, {
    startY: y,
    head: [['Metric', 'Value']],
    body: [
      ['Filter Applied', filterLabel],
      ['Advances Covered', String(advances.length)],
      ['Agents Covered', String(uniqueAgents)],
      ['Payment Entries', String(ledger.length)],
      ['Total Principal Issued', formatUGX(totalPrincipal)],
      ['Total Interest Accrued (ledger)', formatUGX(totalInterestLedger)],
      ['Total Deducted (collected)', formatUGX(totalDeducted)],
      ['Total Outstanding', formatUGX(totalOutstanding)],
      ['Accrued Interest (advances)', formatUGX(totalInterestAdv)],
    ],
    theme: 'striped',
    styles: { fontSize: 8 },
    headStyles: { fillColor: [30, 41, 59], textColor: 255 },
    margin: { left: margin, right: margin },
  });

  // Unified payments table
  let curY = (doc as any).lastAutoTable.finalY + 8;
  doc.setFontSize(10);
  doc.setFont('helvetica', 'bold');
  doc.text(`All Payments (${ledger.length})`, margin, curY);

  if (ledger.length === 0) {
    autoTable(doc, {
      startY: curY + 2,
      body: [['No payments recorded across these advances yet.']],
      theme: 'plain',
      styles: { fontSize: 9, textColor: [120, 120, 120], fontStyle: 'italic' },
      margin: { left: margin, right: margin },
    });
  } else {
    autoTable(doc, {
      startY: curY + 2,
      head: [['Date', 'Agent', 'Adv ID', 'Opening', 'Interest', 'Deducted', 'Closing', 'Status']],
      body: (ledger as any[]).map((row) => [
        fmtDate(row.date),
        agentNameById.get(row.advance_id) || '—',
        String(row.advance_id).slice(0, 8),
        formatUGX(row.opening_balance),
        formatUGX(row.interest_accrued),
        formatUGX(row.amount_deducted),
        formatUGX(row.closing_balance),
        String(row.deduction_status || '—'),
      ]),
      theme: 'striped',
      styles: { fontSize: 7 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255 },
      margin: { left: margin, right: margin },
    });
  }

  // Footer
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(120, 120, 120);
    doc.text(
      `Page ${i} of ${pageCount} • Welile Consolidated Advance Payments • ${filterLabel}`,
      pageWidth / 2,
      doc.internal.pageSize.getHeight() - 6,
      { align: 'center' },
    );
  }

  const dateStr = new Date().toISOString().split('T')[0];
  const filename = `advance-payments-consolidated-${filterLabel}-${dateStr}.pdf`;
  downloadBlob(doc.output('blob'), filename);

  return { filename, rowCount: ledger.length };
}

export async function exportAdvanceStatements(
  advances: any[],
  onProgress?: (current: number, total: number) => void,
): Promise<{ filename: string; agentCount: number }> {
  if (advances.length === 0) throw new Error('No advances to export');

  // Group by agent
  const byAgent = new Map<string, { agent: AgentInfo; advances: any[] }>();
  for (const adv of advances) {
    const existing = byAgent.get(adv.agent_id);
    if (existing) {
      existing.advances.push(adv);
    } else {
      byAgent.set(adv.agent_id, {
        agent: {
          id: adv.agent_id,
          full_name: adv.profiles?.full_name || 'Unknown Agent',
          phone: adv.profiles?.phone,
        },
        advances: [adv],
      });
    }
  }

  const agentEntries = Array.from(byAgent.values());
  const advanceIds = advances.map((a) => a.id);

  // Fetch ledger + topups in bulk
  const [ledgerRes, topupRes] = await Promise.all([
    supabase
      .from('agent_advance_ledger')
      .select('*')
      .in('advance_id', advanceIds)
      .order('date', { ascending: true }),
    supabase
      .from('agent_advance_topups')
      .select('*')
      .in('advance_id', advanceIds)
      .order('created_at', { ascending: true }),
  ]);

  const ledgerByAdvance: Record<string, any[]> = {};
  (ledgerRes.data || []).forEach((row: any) => {
    (ledgerByAdvance[row.advance_id] ||= []).push(row);
  });
  const topupsByAdvance: Record<string, any[]> = {};
  (topupRes.data || []).forEach((row: any) => {
    (topupsByAdvance[row.advance_id] ||= []).push(row);
  });

  const dateStr = new Date().toISOString().split('T')[0];

  // Download one PDF per agent (sequentially, staggered so browsers don't block)
  for (let i = 0; i < agentEntries.length; i++) {
    const { agent, advances: agentAdvances } = agentEntries[i];
    onProgress?.(i, agentEntries.length);
    const blob = await generateAdvancePdf(agent, agentAdvances, ledgerByAdvance, topupsByAdvance);
    const filename = `advance-statement-${safeName(agent.full_name)}-${dateStr}.pdf`;
    downloadBlob(blob, filename);
    if (i < agentEntries.length - 1) {
      await new Promise((r) => setTimeout(r, 350));
    }
  }
  onProgress?.(agentEntries.length, agentEntries.length);

  return {
    filename: agentEntries.length === 1
      ? `advance-statement-${safeName(agentEntries[0].agent.full_name)}-${dateStr}.pdf`
      : `${agentEntries.length} PDFs`,
    agentCount: agentEntries.length,
  };
}
