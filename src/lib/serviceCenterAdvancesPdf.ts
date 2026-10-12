// Branded PDF of a Service Centre's active product advances and repayment tracker.
// jsPDF is loaded on demand to keep it out of the main bundle.
import welileLogo from '@/assets/welile-logo.png';
import type { ServiceCenterAdvances } from '@/hooks/useServiceCenterAdvances';

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' }) : '-';

async function loadLogo(): Promise<string | null> {
  try {
    const blob = await (await fetch(welileLogo)).blob();
    return await new Promise<string>((res, rej) => {
      const r = new FileReader(); r.onloadend = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(blob);
    });
  } catch { return null; }
}

export async function generateServiceCenterAdvancesPdf(data: ServiceCenterAdvances): Promise<Blob> {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 40;
  const purple: [number, number, number] = [107, 33, 168];
  const logo = await loadLogo();

  doc.setFillColor(...purple).rect(0, 0, W, 84, 'F');
  let tx = M;
  if (logo) {
    doc.setFillColor(255, 255, 255).roundedRect(M, 14, 56, 56, 8, 8, 'F');
    try { doc.addImage(logo, 'PNG', M + 6, 20, 44, 44, undefined, 'FAST'); tx = M + 70; } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255).setFont('helvetica', 'bold').setFontSize(11).text('WELILE SERVICE CENTRE', tx, 30);
  doc.setFontSize(18).text('Active Advances & Repayment Tracker', tx, 52);
  doc.setFont('helvetica', 'normal').setFontSize(9).text(
    `${data.centre_name ? `${data.centre_name}  |  ` : ''}${data.manager_name ? `Manager: ${data.manager_name}  |  ` : ''}Issued ${fmtDate(new Date().toISOString())}`,
    tx, 68,
  );

  const t = data.totals;
  autoTable(doc, {
    startY: 104, theme: 'grid', styles: { fontSize: 10, cellPadding: 6 }, headStyles: { fillColor: purple },
    head: [['Summary', '']],
    body: [
      ['Active advances', String(data.plans.length)],
      ['Total value', ugx(t.original)],
      ['Total repaid', `${ugx(t.repaid)} (${t.pct}%)`],
      ['Still owed', ugx(t.outstanding)],
      ['Expected daily', ugx(t.daily)],
      ['Repaid in last 7 days', ugx(t.paid7d)],
      ['Behind schedule (due now)', ugx(t.due)],
    ],
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 200 } },
  });

  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 20, theme: 'striped',
    styles: { fontSize: 8, cellPadding: 4 }, headStyles: { fillColor: purple },
    head: [['#', 'Holder', 'Item', 'Value', 'Repaid', 'Owed', '%', 'Daily', 'Due now', 'Last paid']],
    body: data.plans.length
      ? data.plans.map((p, i) => [
          String(i + 1), `${p.holder_name || 'Unknown'}${p.is_self ? ' (you)' : ''}\n${p.holder_phone || ''}`, p.item_name,
          ugx(p.original_amount), ugx(p.repaid), ugx(p.outstanding), `${p.pct}%`, ugx(p.daily), ugx(p.due_balance), fmtDate(p.last_paid_at),
        ])
      : [['', 'No active advances', '', '', '', '', '', '', '', '']],
  });

  // Per-advance payment breakdown
  for (const p of data.plans) {
    let y = (doc as any).lastAutoTable.finalY + 18;
    if (y > H - 120) { doc.addPage(); y = 50; }
    doc.setTextColor(30, 41, 59).setFont('helvetica', 'bold').setFontSize(10)
      .text(`${p.holder_name || 'Unknown'} — ${p.item_name}`, M, y);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(100, 116, 139)
      .text(`Started ${fmtDate(p.starts_on)}  |  Ends ${fmtDate(p.term_end_on)}  |  ${p.pct}% repaid${p.on_hold ? '  |  On hold' : ''}`, M, y + 11);
    autoTable(doc, {
      startY: y + 16, theme: 'grid', styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: [148, 163, 184] },
      head: [['Date', 'Amount paid', 'Balance after']],
      body: p.recent.length
        ? p.recent.map((r) => [fmtDate(r.at), ugx(r.amount), ugx(r.outstanding_after)])
        : [['No payments yet', '', '']],
    });
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...purple).line(M, H - 36, W - M, H - 36);
    doc.setFontSize(8).setTextColor(100, 116, 139)
      .text('Welile  |  welileapp.com  |  Confidential', M, H - 22)
      .text(`Page ${i} of ${pages}`, W - M, H - 22, { align: 'right' });
  }
  return doc.output('blob');
}
