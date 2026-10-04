import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface LandlordPayoutRow {
  landlord_name: string;
  landlord_phone?: string;
  properties?: number;
  tenants_paying?: number;
  amount_paid_out: number;
  outstanding_to_landlord?: number;
  last_payout_date?: string | Date | null;
}

export function generateLandlordOpsReportPdf(
  landlords: LandlordPayoutRow[],
  range?: { from?: Date | null; to?: Date | null },
): Blob {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  let y = 16;

  const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;
  const num = (n: number) => Math.round(n).toLocaleString();
  const fmtDate = (d: string | Date) => {
    try { return format(new Date(d), 'dd MMM yyyy'); } catch { return '—'; }
  };

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 40, 120);
  doc.text('WELILE', margin, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text(format(new Date(), 'dd MMM yyyy, hh:mm a'), pageWidth - margin, y, { align: 'right' });

  y += 9;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(15, 23, 42);
  doc.text('Landlord Payouts Report', margin, y);

  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(110, 110, 120);
  doc.text(
    'All landlord payouts disbursed in this period (from tenant rent collected). "Outstanding" reflects rent owed to the landlord across active rent plans.',
    margin,
    y,
  );

  if (range && (range.from || range.to)) {
    y += 4.5;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(110, 110, 120);
    doc.text(
      `Period: ${range.from ? fmtDate(range.from) : 'Start'} → ${range.to ? fmtDate(range.to) : 'Today'}`,
      margin,
      y,
    );
  }

  y += 4;
  doc.setDrawColor(225, 227, 232);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  // KPI Cards
  const totalLandlords = landlords.length;
  const totalPaid = landlords.reduce((s, l) => s + (l.amount_paid_out || 0), 0);
  const totalOutstanding = landlords.reduce((s, l) => s + (l.outstanding_to_landlord || 0), 0);
  const totalProperties = landlords.reduce((s, l) => s + (l.properties || 0), 0);

  const cardGap = 3;
  const cardW = (contentWidth - cardGap * 3) / 4;
  const cardH = 18;

  const drawCard = (
    x: number,
    label: string,
    value: string,
    icon: { fill: [number, number, number]; glyph: string },
    valueColor: [number, number, number],
  ) => {
    doc.setFillColor(248, 249, 252);
    doc.setDrawColor(225, 227, 232);
    doc.setLineWidth(0.2);
    (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');

    const ix = x + 4.5;
    const iy = y + cardH / 2;
    doc.setFillColor(...icon.fill);
    doc.circle(ix, iy, 3.2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text(icon.glyph, ix, iy + 1.1, { align: 'center' });

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 122, 135);
    doc.text(label, x + 9.5, y + 6);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...valueColor);
    doc.text(value, x + 9.5, y + 13);
  };

  drawCard(margin,                         'LANDLORDS PAID',     num(totalLandlords),    { fill: [37, 99, 235],  glyph: 'L' }, [15, 23, 42]);
  drawCard(margin + (cardW + cardGap),     'PROPERTIES',         num(totalProperties),   { fill: [124, 58, 237], glyph: 'H' }, [124, 58, 237]);
  drawCard(margin + (cardW + cardGap) * 2, 'PAID OUT (PERIOD)',  ugx(totalPaid),         { fill: [22, 163, 74],  glyph: '$' }, [22, 163, 74]);
  drawCard(margin + (cardW + cardGap) * 3, 'OUTSTANDING',        ugx(totalOutstanding),  { fill: [220, 38, 38],  glyph: '!' }, [220, 38, 38]);

  y += cardH + 7;

  // Table
  const wIdx = 8;
  const wLandlord = 46;
  const wPhone = 30;
  const wProps = 16;
  const wPaid = 36;
  const wLast = 24;
  const wOut = contentWidth - wIdx - wLandlord - wPhone - wProps - wPaid - wLast;
  let cx = margin;
  const cols = [
    { label: '#',                  x: cx,                   w: wIdx,      align: 'left'  as const },
    { label: 'Landlord',           x: (cx += wIdx, cx),     w: wLandlord, align: 'left'  as const },
    { label: 'Phone',              x: (cx += wLandlord, cx),w: wPhone,    align: 'left'  as const },
    { label: 'Props',              x: (cx += wPhone, cx),   w: wProps,    align: 'right' as const },
    { label: 'Paid in Period (UGX)', x: (cx += wProps, cx), w: wPaid,     align: 'right' as const },
    { label: 'Last Payout',        x: (cx += wPaid, cx),    w: wLast,     align: 'left'  as const },
    { label: 'Outstanding (UGX)',  x: (cx += wLast, cx),    w: wOut,      align: 'right' as const },
  ];

  const drawTableHeader = () => {
    doc.setFillColor(146, 52, 234);
    doc.rect(margin, y, contentWidth, 8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(255, 255, 255);
    cols.forEach(c => {
      const tx = c.align === 'right' ? c.x + c.w - 2 : c.x + 2;
      doc.text(c.label, tx, y + 5.3, { align: c.align });
    });
    y += 8;
  };

  drawTableHeader();

  const rowH = 6.8;
  const bottomLimit = pageHeight - 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);

  landlords.forEach((l, i) => {
    if (y + rowH > bottomLimit) {
      doc.addPage();
      y = 16;
      drawTableHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
    }

    if (i % 2 === 1) {
      doc.setFillColor(248, 249, 252);
      doc.rect(margin, y, contentWidth, rowH, 'F');
    }

    doc.setDrawColor(232, 234, 240);
    doc.setLineWidth(0.15);
    doc.line(margin, y + rowH, margin + contentWidth, y + rowH);

    const baseline = y + rowH - 2.2;

    doc.setTextColor(80, 85, 100);
    doc.text(`${i + 1}`, cols[0].x + 2, baseline);

    doc.setTextColor(15, 23, 42);
    doc.text((l.landlord_name || '—').slice(0, 30), cols[1].x + 2, baseline);

    doc.setTextColor(80, 85, 100);
    doc.text((l.landlord_phone || '—').slice(0, 18), cols[2].x + 2, baseline);

    doc.setTextColor(15, 23, 42);
    doc.text(num(l.properties || 0), cols[3].x + cols[3].w - 2, baseline, { align: 'right' });

    doc.text(num(l.amount_paid_out || 0), cols[4].x + cols[4].w - 2, baseline, { align: 'right' });

    doc.setTextColor(80, 85, 100);
    doc.text(l.last_payout_date ? fmtDate(l.last_payout_date) : '—', cols[5].x + 2, baseline);

    if ((l.outstanding_to_landlord || 0) > 0) doc.setTextColor(220, 38, 38);
    else doc.setTextColor(22, 163, 74);
    doc.text(num(l.outstanding_to_landlord || 0), cols[6].x + cols[6].w - 2, baseline, { align: 'right' });

    y += rowH;
  });

  // Totals
  if (y + rowH + 2 > bottomLimit) {
    doc.addPage();
    y = 16;
    drawTableHeader();
  }
  doc.setFillColor(243, 244, 248);
  doc.rect(margin, y, contentWidth, rowH + 1, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(15, 23, 42);
  doc.text('TOTAL', cols[3].x + cols[3].w - 2, y + rowH - 1.6, { align: 'right' });
  doc.text(num(totalPaid), cols[4].x + cols[4].w - 2, y + rowH - 1.6, { align: 'right' });
  doc.setTextColor(220, 38, 38);
  doc.text(num(totalOutstanding), cols[6].x + cols[6].w - 2, y + rowH - 1.6, { align: 'right' });
  y += rowH + 5;

  if (y + 8 > bottomLimit) { doc.addPage(); y = 16; }
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(120, 122, 135);
  doc.text('Note: "Paid in Period" = landlord disbursements recorded in the ledger within the date range. "Outstanding" is the rent currently owed to the landlord across all active rent plans.', margin, y);

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 158);
    doc.text(
      `Generated by Welile Technologies Ltd. • ${format(new Date(), 'PPpp')}`,
      margin,
      pageHeight - 8,
    );
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 8, { align: 'right' });
  }

  return doc.output('blob');
}
