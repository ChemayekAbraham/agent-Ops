import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface TenantRentRow {
  tenant_name: string;
  tenant_phone?: string;
  first_start_date?: string;
  rent_plans?: number;
  rent_given: number;
  amount_paid: number;
  paid_direct?: number;
  paid_via_agent?: number;
  outstanding: number;
  agent_name?: string;
}

export function generateTenantOpsReportPdf(
  tenants: TenantRentRow[],
  range?: { from?: Date | null; to?: Date | null },
): Blob {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();   // 210
  const pageHeight = doc.internal.pageSize.getHeight(); // 297
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  let y = 16;

  const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;
  const num = (n: number) => Math.round(n).toLocaleString();
  const fmtDate = (d: string | Date) => {
    try { return format(new Date(d), 'dd MMM yyyy'); } catch { return '—'; }
  };

  // ===== Header =====
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
  doc.text('Tenant Payments Report', margin, y);

  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(110, 110, 120);
  doc.text(
    'Tenants who paid in this period — with their agent (if any) and current outstanding balance.',
    margin,
    y,
  );

  // Period line
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
  // Divider
  doc.setDrawColor(225, 227, 232);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  // ===== KPI Cards =====
  const totalTenants = tenants.length;
  const totalPaid = tenants.reduce((s, t) => s + (t.amount_paid || 0), 0);
  const totalOutstanding = tenants.reduce((s, t) => s + (t.outstanding || 0), 0);
  const totalPayments = tenants.reduce((s, t) => s + (t.rent_plans || 0), 0);
  const totalDirect = tenants.reduce((s, t) => s + (t.paid_direct || 0), 0);
  const totalViaAgent = tenants.reduce((s, t) => s + (t.paid_via_agent || 0), 0);

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
    // Card background
    doc.setFillColor(248, 249, 252);
    doc.setDrawColor(225, 227, 232);
    doc.setLineWidth(0.2);
    (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');

    // Icon circle
    const ix = x + 4.5;
    const iy = y + cardH / 2;
    doc.setFillColor(...icon.fill);
    doc.circle(ix, iy, 3.2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(255, 255, 255);
    doc.text(icon.glyph, ix, iy + 1.1, { align: 'center' });

    // Label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 122, 135);
    doc.text(label, x + 9.5, y + 6);

    // Value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...valueColor);
    doc.text(value, x + 9.5, y + 13);
  };

  drawCard(margin,                           'TENANTS WHO PAID',    num(totalTenants),     { fill: [37, 99, 235],  glyph: 'P' }, [15, 23, 42]);
  drawCard(margin + (cardW + cardGap),       'DIRECT PAYMENTS',     ugx(totalDirect),      { fill: [124, 58, 237], glyph: 'D' }, [124, 58, 237]);
  drawCard(margin + (cardW + cardGap) * 2,   'AGENT-COLLECTED',     ugx(totalViaAgent),    { fill: [22, 163, 74],  glyph: 'A' }, [22, 163, 74]);
  drawCard(margin + (cardW + cardGap) * 3,   'OUTSTANDING (LIFETIME)', ugx(totalOutstanding), { fill: [220, 38, 38], glyph: '!' }, [220, 38, 38]);

  y += cardH + 7;

  // ===== Table =====
  // # | Tenant (name + phone) | Channel | Agent | Paid | Outstanding
  // Tenant column widened (now holds two lines), agent column shrunk and
  // moved AFTER channel — tenant remains the focus, agent is supporting info.
  const wIdx = 8;
  const wTenant = 56;
  const wChannel = 20;
  const wAgent = 32;
  const wPaid = 34;
  const wOut = contentWidth - wIdx - wTenant - wChannel - wAgent - wPaid;
  let cx = margin;
  const cols = [
    { label: '#',                    x: cx,                w: wIdx,     align: 'left'  as const },
    { label: 'Tenant Name',          x: (cx += wIdx, cx),  w: wTenant,  align: 'left'  as const },
    { label: 'Channel',              x: (cx += wTenant, cx), w: wChannel, align: 'left' as const },
    { label: 'Agent',                x: (cx += wChannel, cx), w: wAgent, align: 'left' as const },
    { label: 'Paid in Period (UGX)', x: (cx += wAgent, cx), w: wPaid, align: 'right' as const },
    { label: 'Outstanding (UGX)',    x: (cx += wPaid, cx),  w: wOut,    align: 'right' as const },
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

  // Slightly taller row to fit tenant name + phone subline.
  const rowH = 9.5;
  const bottomLimit = pageHeight - 22;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);

  tenants.forEach((t, i) => {
    if (y + rowH > bottomLimit) {
      doc.addPage();
      y = 16;
      drawTableHeader();
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
    }

    // Zebra
    if (i % 2 === 1) {
      doc.setFillColor(248, 249, 252);
      doc.rect(margin, y, contentWidth, rowH, 'F');
    }

    // Bottom border
    doc.setDrawColor(232, 234, 240);
    doc.setLineWidth(0.15);
    doc.line(margin, y + rowH, margin + contentWidth, y + rowH);

    // Two-line tenant cell: name on top, phone underneath.
    const nameBaseline = y + 4.2;
    const subBaseline = y + 7.6;
    const baseline = y + rowH - 3.2;

    // # 
    doc.setTextColor(80, 85, 100);
    doc.text(`${i + 1}`, cols[0].x + 2, nameBaseline);

    // Tenant name + phone subline
    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text((t.tenant_name || '—').slice(0, 36), cols[1].x + 2, nameBaseline);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(135, 138, 150);
    doc.text((t.tenant_phone || '—').slice(0, 24), cols[1].x + 2, subBaseline);
    doc.setFontSize(9);

    // Channel
    const direct = t.paid_direct || 0;
    const viaAgent = t.paid_via_agent || 0;
    const channel = direct > 0 && viaAgent > 0 ? 'Mixed' : viaAgent > 0 ? 'Agent' : 'Direct';
    if (channel === 'Direct') doc.setTextColor(124, 58, 237);
    else if (channel === 'Agent') doc.setTextColor(22, 163, 74);
    else doc.setTextColor(80, 85, 100);
    doc.text(channel, cols[2].x + 2, baseline);

    // Agent (de-emphasized)
    doc.setTextColor(110, 115, 130);
    doc.text((t.agent_name || '—').slice(0, 18), cols[3].x + 2, baseline);

    // Paid
    doc.setTextColor(15, 23, 42);
    doc.text(num(t.amount_paid || 0), cols[4].x + cols[4].w - 2, baseline, { align: 'right' });

    // Outstanding (red if positive, green if zero/negative)
    if ((t.outstanding || 0) > 0) {
      doc.setTextColor(220, 38, 38);
    } else {
      doc.setTextColor(22, 163, 74);
    }
    doc.text(num(t.outstanding || 0), cols[5].x + cols[5].w - 2, baseline, { align: 'right' });

    y += rowH;
  });

  // Totals row
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
  doc.text(num(totalOutstanding), cols[5].x + cols[5].w - 2, y + rowH - 1.6, { align: 'right' });
  y += rowH + 5;

  // Footer note
  if (y + 8 > bottomLimit) { doc.addPage(); y = 16; }
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(8);
  doc.setTextColor(120, 122, 135);
  doc.text(
    'One row per tenant. "Paid in Period" = ledger payments in the date range. "Outstanding" = lifetime rent obligation minus all repayments. "Agent" shows the field agent who collected or onboarded the tenant.',
    margin,
    y,
    { maxWidth: contentWidth },
  );

  // Page number footer
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
