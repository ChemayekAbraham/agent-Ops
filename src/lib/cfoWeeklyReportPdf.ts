import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';
import {
  type CfoWeeklyReport,
  prettyCategory,
  pctChange,
  deriveRisksAndActions,
} from '@/lib/cfoWeeklyReport';

const PRIMARY: [number, number, number] = [79, 70, 229];      // indigo-600
const PRIMARY_DARK: [number, number, number] = [55, 48, 163]; // indigo-800
const STRIPE: [number, number, number] = [239, 241, 254];

const fmtUGX = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))}`;

const fmtDay = (d: string) => (d ? format(new Date(d), 'dd MMM yyyy') : '—');
const fmtDateTime = (d: string) => (d ? format(new Date(d), 'dd MMM, HH:mm') : '—');

const delta = (cur: number, prev: number) => {
  const p = pctChange(cur, prev);
  if (p === null) return prev === 0 && cur === 0 ? 'no change' : 'new';
  return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
};

async function loadLogoBase64(): Promise<string | null> {
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

/**
 * Executive-level General Weekly CFO Report.
 * Renders only figures returned by `get_cfo_weekly_report` — nothing is estimated.
 */
export async function generateCfoWeeklyReportPdf(report: CfoWeeklyReport): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pw = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();
  const { cash, cash_flow: cf, profit_and_loss: pnl, position, receivables, payables } = report;
  const { risks, actions } = deriveRisksAndActions(report);

  // ── Header band ──
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pw, 30, 'F');
  if (logo) { try { doc.addImage(logo, 'PNG', margin, 6, 17, 17); } catch { /* ignore */ } }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('General Weekly CFO Report', logo ? margin + 21 : margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `${fmtDay(report.period.from)} – ${fmtDay(report.period.to)}  ·  Generated ${format(new Date(report.generated_at), 'dd MMM yyyy, HH:mm')}`,
    logo ? margin + 21 : margin, 20,
  );
  doc.setFontSize(8);
  doc.text(`Compared with ${fmtDay(report.previous_period.from)} – ${fmtDay(report.previous_period.to)}`, logo ? margin + 21 : margin, 25.5);

  let y = 38;
  doc.setTextColor(15, 23, 42);

  // ── Executive summary ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...PRIMARY_DARK);
  doc.text('Executive Summary', margin, y);
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.line(margin, y, pw - margin, y);
  y += 5;

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const summaryLines = doc.splitTextToSize(
    [
      `Cash opened the week at ${fmtUGX(cash.opening_cash)} and closed at ${fmtUGX(cash.closing_cash)}, a net movement of ${fmtUGX(cash.net_change)}.`,
      `The platform received ${fmtUGX(cf.inflows)} and paid out ${fmtUGX(cf.outflows)} across ${cf.legs} cash legs (previous week: ${fmtUGX(cf.inflows === 0 ? 0 : cf.prev_inflows)} in, ${fmtUGX(cf.prev_outflows)} out).`,
      `Revenue of ${fmtUGX(pnl.revenue)} against expenses of ${fmtUGX(pnl.expenses)} produced a net result of ${fmtUGX(pnl.net_result)} at a ${pnl.net_margin}% margin.`,
      `At period end the platform holds ${fmtUGX(position.money_we_have)} (treasury ${fmtUGX(position.money_in_treasury)}, bank ${fmtUGX(position.money_in_bank)}), owes ${fmtUGX(position.money_we_owe)} in wallet obligations and can use ${fmtUGX(position.money_we_can_use)}.`,
      `Receivables stand at ${fmtUGX(receivables.total)} and net working capital at ${fmtUGX(position.net_working_capital)}.`,
    ].join(' '),
    pw - margin * 2,
  );
  doc.text(summaryLines, margin, y);
  y += summaryLines.length * 4.4 + 4;

  const section = (title: string, startY: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...PRIMARY_DARK);
    doc.text(title, margin, startY);
    doc.setDrawColor(...PRIMARY);
    doc.line(margin, startY + 2, pw - margin, startY + 2);
    doc.setTextColor(15, 23, 42);
    return startY + 6;
  };

  const table = (head: string[][], body: (string | number)[][], startY: number, foot?: (string | number)[][]) => {
    autoTable(doc, {
      head, body, foot, startY,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      footStyles: { fillColor: STRIPE, textColor: 15, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
    return ((doc as any).lastAutoTable?.finalY || startY) + 8;
  };

  // ── Cash & liquidity ──
  y = section('Cash & Liquidity', y);
  y = table(
    [['Measure', 'Opening', 'Closing', 'Movement']],
    [
      ['Total cash (A1 + A5)', fmtUGX(cash.opening_cash), fmtUGX(cash.closing_cash), fmtUGX(cash.net_change)],
      ['Money in bank', fmtUGX(cash.opening_bank), fmtUGX(cash.closing_bank), fmtUGX(cash.closing_bank - cash.opening_bank)],
      ['Money in treasury / platform', fmtUGX(cash.opening_treasury), fmtUGX(cash.closing_treasury), fmtUGX(cash.closing_treasury - cash.opening_treasury)],
      ['A1 cash and bank', fmtUGX(cash.opening_a1), fmtUGX(cash.closing_a1), fmtUGX(cash.closing_a1 - cash.opening_a1)],
      ['A5 cash in transit', fmtUGX(cash.opening_a5), fmtUGX(cash.closing_a5), fmtUGX(cash.closing_a5 - cash.opening_a5)],
    ],
    y,
    [['Reconciliation: opening + net movement', fmtUGX(cash.opening_cash), fmtUGX(cash.closing_cash), fmtUGX(cash.opening_cash + cash.net_change - cash.closing_cash) + ' variance']],
  );

  // ── Cash flow ──
  y = section('Cash Flow', y);
  y = table(
    [['Cash flow', 'This week', 'Previous week', 'Change']],
    [
      ['Inflows', fmtUGX(cf.inflows), fmtUGX(cf.prev_inflows), delta(cf.inflows, cf.prev_inflows)],
      ['Outflows', fmtUGX(cf.outflows), fmtUGX(cf.prev_outflows), delta(cf.outflows, cf.prev_outflows)],
      ['Net cash movement', fmtUGX(cf.net), fmtUGX(cf.prev_net), delta(cf.net, cf.prev_net)],
      ['Cash ledger legs', String(cf.legs), String(cf.prev_legs), delta(cf.legs, cf.prev_legs)],
    ],
    y,
  );

  if (report.daily_flow.length) {
    y = section('Daily Cash Movement', y);
    y = table(
      [['Day', 'Inflow', 'Outflow', 'Net']],
      report.daily_flow.map((d) => [fmtDay(d.day), fmtUGX(d.inflow), fmtUGX(d.outflow), fmtUGX(d.net)]),
      y,
      [['Total', fmtUGX(cf.inflows), fmtUGX(cf.outflows), fmtUGX(cf.net)]],
    );
  }

  // ── Revenue performance ──
  y = section('Revenue Performance', y);
  y = table(
    [['Revenue category', 'This week', 'Previous week', 'Change']],
    report.revenue_lines.slice(0, 15).map((l) => [prettyCategory(l.category), fmtUGX(l.amount), fmtUGX(l.prev_amount), delta(l.amount, l.prev_amount)]),
    y,
    [['Total revenue', fmtUGX(pnl.revenue), fmtUGX(pnl.prev_revenue), delta(pnl.revenue, pnl.prev_revenue)]],
  );

  // ── Expense performance ──
  y = section('Expense Performance', y);
  y = table(
    [['Expense category', 'This week', 'Previous week', 'Change']],
    report.expense_lines.slice(0, 15).map((l) => [prettyCategory(l.category), fmtUGX(l.amount), fmtUGX(l.prev_amount), delta(l.amount, l.prev_amount)]),
    y,
    [['Total expenses', fmtUGX(pnl.expenses), fmtUGX(pnl.prev_expenses), delta(pnl.expenses, pnl.prev_expenses)]],
  );

  // ── Profitability ──
  y = section('Profitability', y);
  y = table(
    [['Measure', 'This week', 'Previous week', 'Change']],
    [
      ['Revenue', fmtUGX(pnl.revenue), fmtUGX(pnl.prev_revenue), delta(pnl.revenue, pnl.prev_revenue)],
      ['Expenses', fmtUGX(pnl.expenses), fmtUGX(pnl.prev_expenses), delta(pnl.expenses, pnl.prev_expenses)],
      ['Net result', fmtUGX(pnl.net_result), fmtUGX(pnl.prev_net_result), delta(pnl.net_result, pnl.prev_net_result)],
      ['Net margin', `${pnl.net_margin}%`, `${pnl.prev_net_margin}%`, `${(pnl.net_margin - pnl.prev_net_margin).toFixed(1)} pts`],
    ],
    y,
  );

  // ── Receivables & payables ──
  y = section('Receivables & Payables', y);
  y = table(
    [['Item', 'Amount', 'Detail', '']],
    [
      ['Tenant arrears outstanding', fmtUGX(receivables.tenant_outstanding), 'Active rent plans', ''],
      ['Agent advances outstanding', fmtUGX(receivables.advances_outstanding), `${receivables.advances_active_count} active advance(s)`, ''],
      ['Total receivables', fmtUGX(receivables.total), 'Tenant + advances', ''],
      ['Wallet obligations (money we owe)', fmtUGX(payables.wallet_total), `Withdrawable ${fmtUGX(payables.wallet_withdrawable)} · float ${fmtUGX(payables.wallet_float)}`, ''],
      ['Pending wallet operations', fmtUGX(payables.pending_operations_amount), `${payables.pending_operations_count} pending`, ''],
      ['Net working capital', fmtUGX(position.net_working_capital), 'Cash + receivables − obligations', ''],
    ],
    y,
  );

  // ── Significant movements ──
  if (report.movements.length) {
    y = section('Significant Financial Movements', y);
    y = table(
      [['Category', 'Net this week', 'Net previous week', 'Change']],
      report.movements.slice(0, 15).map((m) => [prettyCategory(m.category), fmtUGX(m.net), fmtUGX(m.prev_net), fmtUGX(m.delta)]),
      y,
    );
  }

  // ── Major transactions ──
  if (report.major_transactions.length) {
    y = section('Major Transactions', y);
    autoTable(doc, {
      head: [['Date', 'Category', 'Details', 'Flow', 'Amount']],
      body: report.major_transactions.map((t) => [
        fmtDateTime(t.date), prettyCategory(t.category), t.description || t.reference || '—',
        t.flow === 'inflow' ? 'In' : 'Out', fmtUGX(t.amount),
      ]),
      startY: y,
      margin: { left: margin, right: margin },
      styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 7.5, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: {
        0: { cellWidth: 24 }, 1: { cellWidth: 36 }, 2: { cellWidth: 'auto' },
        3: { cellWidth: 14, halign: 'center' }, 4: { cellWidth: 30, halign: 'right', fontStyle: 'bold' },
      },
    });
    y = ((doc as any).lastAutoTable?.finalY || y) + 8;
  }

  // ── Risks ──
  y = section('Key Financial Risks / Issues', y);
  y = table(
    [['Severity', 'Risk', 'Detail', '']],
    risks.map((r) => [r.severity.toUpperCase(), r.title, r.detail, '']),
    y,
  );

  // ── Actions ──
  y = section('CFO Actions & Recommendations', y);
  autoTable(doc, {
    head: [['#', 'Recommended action']],
    body: actions.map((a, i) => [String(i + 1), a]),
    startY: y,
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: { 0: { cellWidth: 10, halign: 'right' }, 1: { cellWidth: 'auto' } },
  });
  y = ((doc as any).lastAutoTable?.finalY || y) + 6;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(7.5);
  doc.setTextColor(110, 110, 110);
  doc.text(doc.splitTextToSize(`Basis of preparation: ${report.basis}`, pw - margin * 2), margin, y);

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — confidential weekly CFO report', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pw - margin, ph - 6, { align: 'right' });
  }

  return doc.output('blob');
}
