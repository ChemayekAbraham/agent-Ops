import { formatUGX } from '@/lib/rentCalculations';

export interface TppoPlanDetailRow {
  rent_request_id: string;
  tenant_name: string;
  agent_name: string;
  daily_amount: number;
  scheduled_in_period: number;
  arrears: number;
  plan_total: number;
  repaid: number;
  term_start: string;
  obligation_end: string;
}

export interface TppoPlanDetailReport {
  granularity: string;
  period_start: string;
  period_end: string;
  scheduled_through: string;
  period_open: boolean;
  schedule_basis: 'pinned' | 'live';
  timezone: string;
  totals: {
    plans: number;
    scheduled_total: number;
    arrears_total: number;
    plans_in_arrears: number;
  };
  rows: TppoPlanDetailRow[];
  generated_at: string;
}

const RED: [number, number, number] = [185, 28, 28];
const MUTED: [number, number, number] = [107, 114, 128];

/** Build and download the Scheduled plan-detail PDF for the TPPO report. */
export async function downloadTppoPlanDetailPdf(report: TppoPlanDetailReport): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default ?? autoTableMod;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();

  const scheduledTotal = formatUGX(report.totals.scheduled_total);
  const scope = report.granularity === 'day' ? 'today' : 'this period';

  // 1. Title
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.text(`Scheduled ${scope} — ${scheduledTotal}`, pageWidth / 2, 40, { align: 'center' });

  // 2. Subtitle line
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED);
  let subtitle = `Agent Ops · Portfolio Performance · ${report.period_start} to ${report.period_end} (Africa/Kampala)`;
  if (report.period_open) subtitle += ` · counted through ${report.scheduled_through}, period still open`;
  doc.text(subtitle, pageWidth / 2, 58, { align: 'center' });

  // 3. Explanatory paragraph (exact wording)
  doc.setFontSize(9);
  const paragraph =
    `Every rent plan whose term start falls on or before the period end and whose obligation end falls on or after the period start. ` +
    `The instalment falling due is the daily amount, trimmed on the final day so a plan never schedules more than its plan total. ` +
    `Summing across all ${report.totals.plans} plans gives ${formatUGX(report.totals.scheduled_total)}, of which ${report.totals.plans_in_arrears} plans are also in arrears, shown in red.`;
  const lines = doc.splitTextToSize(paragraph, pageWidth - 96);
  doc.text(lines, 48, 78);
  const tableStartY = 78 + lines.length * 12 + 10;

  // 4. Table body (payload order, no re-sort)
  const body = report.rows.map((row, i) => [
    String(i + 1),
    row.tenant_name,
    row.agent_name,
    formatUGX(row.daily_amount),
    formatUGX(row.scheduled_in_period),
    row.arrears > 0 ? formatUGX(row.arrears) : '—',
    formatUGX(row.plan_total),
    formatUGX(row.repaid),
    row.term_start,
    row.obligation_end,
  ]);

  // 5. TOTAL row — figure comes from totals.scheduled_total, never from summing rows
  body.push([
    '',
    'TOTAL',
    `${report.totals.plans} plans`,
    '',
    formatUGX(report.totals.scheduled_total),
    '',
    '',
    '',
    '',
    '',
  ]);

  const totalRowIndex = body.length - 1;

  autoTable(doc, {
    startY: tableStartY,
    head: [[
      '#', 'Tenant', 'Agent', 'Daily amount', 'Scheduled', 'Arrears',
      'Plan total', 'Repaid', 'Term start', 'Obligation end',
    ]],
    body,
    showHead: 'everyPage',
    styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak' },
    headStyles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' },
    columnStyles: {
      0: { halign: 'left', cellWidth: 28 },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
    },
    didParseCell: (hookData: any) => {
      if (hookData.section !== 'body') return;
      if (hookData.row.index === totalRowIndex) {
        hookData.cell.styles.fontStyle = 'bold';
        return;
      }
      const row = report.rows[hookData.row.index];
      if (row && hookData.column.index === 5 && row.arrears > 0) {
        hookData.cell.styles.textColor = RED;
      }
    },
    didDrawPage: () => {
      const pageCount = doc.getNumberOfPages();
      const pageNumber = (doc.internal as any).getCurrentPageInfo().pageNumber;
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      doc.text(
        `Welile · Scheduled plan detail · Page ${pageNumber} of ${pageCount}`,
        pageWidth / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: 'center' },
      );
    },
  });

  doc.save(`welile-scheduled-${report.granularity}-${report.period_start}.pdf`);
}
