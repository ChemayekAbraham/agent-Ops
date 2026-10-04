import welileLogoUrl from '@/assets/welile-logo.png';

/**
 * Branded, print-quality "Commission & Telecom Report" for a single merchant
 * agent. Renders a header band, a KPI summary strip, and a detailed
 * transaction ledger with a totals footer row.
 */

type RGB = [number, number, number];

const BRAND: RGB = [105, 0, 204];        // Welile primary (271 100% 40%)
const BRAND_DARK: RGB = [66, 0, 128];    // deeper violet
const INK: RGB = [30, 27, 46];           // near-black text
const MUTED: RGB = [120, 116, 132];      // muted label text
const STRIPE: RGB = [244, 240, 252];     // light violet row stripe
const BORDER: RGB = [226, 222, 236];

const EMERALD: RGB = [16, 150, 100];
const BLUE: RGB = [37, 99, 235];
const TEAL: RGB = [13, 148, 136];
const AMBER: RGB = [202, 138, 4];
const RED: RGB = [201, 42, 42];
const SLATE: RGB = [100, 116, 139];

const fmtUGX = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0))}`;

/** Blend a colour toward white by `amt` (0..1) — used for soft card fills. */
const tint = (c: RGB, amt: number): RGB =>
  [Math.round(c[0] + (255 - c[0]) * amt), Math.round(c[1] + (255 - c[1]) * amt), Math.round(c[2] + (255 - c[2]) * amt)];

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export interface CommissionTelecomRow {
  dateTime: string;
  recipient: string;
  phone: string;
  method: string;
  amount: number;
  /** null => commission was not credited for this payout */
  commission: number | null;
  telecom: number;
  status: string;
  reference: string;
}

export interface CommissionTelecomReportInput {
  agentName: string;
  agentPhone: string;
  scopeLabel: string;
  generatedAt?: Date;
  rows: CommissionTelecomRow[];
  summary: {
    payouts: number;
    volumeTotal: number;
    commissionCredited: number;
    commissionExpected: number;
    missingCount: number;
    gap: number;
    telecomTotal: number;
  };
}

export async function generateCommissionTelecomReportPdf(
  input: CommissionTelecomReportInput,
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const generatedAt = input.generatedAt ?? new Date();

  const logo = await loadLogoBase64();

  // ── Header band ──
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageWidth, 26, 'F');
  doc.setFillColor(...BRAND_DARK);
  doc.rect(0, 26, pageWidth, 1.5, 'F'); // accent underline

  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 5.5, 15, 15); } catch { /* ignore */ }
  }
  const titleX = logo ? margin + 19 : margin;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Commission & Telecom Report', titleX, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(235, 225, 250);
  doc.text(
    `${input.agentName || 'Unknown'}  ·  ${input.agentPhone || '—'}`,
    titleX, 18.5,
  );

  // right-aligned scope + generated
  doc.setFontSize(8.5);
  doc.setTextColor(255, 255, 255);
  doc.text(input.scopeLabel, pageWidth - margin, 11, { align: 'right' });
  doc.setTextColor(225, 210, 248);
  doc.text(
    `Generated ${generatedAt.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    pageWidth - margin, 17, { align: 'right' },
  );

  // ── KPI summary strip ──
  const s = input.summary;
  const cards: { label: string; value: string; sub?: string; accent: RGB }[] = [
    { label: 'Payouts', value: String(s.payouts), accent: BRAND },
    { label: 'Volume total', value: fmtUGX(s.volumeTotal), accent: BLUE },
    { label: 'Commission credited', value: fmtUGX(s.commissionCredited), accent: EMERALD },
    { label: 'Commission expected', value: fmtUGX(s.commissionExpected), sub: '0.5% of volume', accent: TEAL },
    {
      label: 'Unpaid / gap',
      value: fmtUGX(s.gap),
      sub: `${s.missingCount} payout${s.missingCount === 1 ? '' : 's'}`,
      accent: s.gap > 0 ? RED : SLATE,
    },
    { label: 'Telecom charges', value: fmtUGX(s.telecomTotal), accent: AMBER },
  ];

  const cardY = 33;
  const cardH = 22;
  const gap = 4;
  const cardW = (pageWidth - margin * 2 - gap * (cards.length - 1)) / cards.length;

  cards.forEach((c, i) => {
    const x = margin + i * (cardW + gap);
    // card body
    doc.setFillColor(...tint(c.accent, 0.93));
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.roundedRect(x, cardY, cardW, cardH, 2, 2, 'FD');
    // accent bar
    doc.setFillColor(...c.accent);
    doc.roundedRect(x, cardY, cardW, 2.4, 2, 2, 'F');
    doc.rect(x, cardY + 1.4, cardW, 1, 'F');
    // label
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(...MUTED);
    doc.text(c.label.toUpperCase(), x + 3.5, cardY + 8);
    // value
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(c.value.length > 12 ? 10.5 : 12.5);
    doc.setTextColor(...c.accent);
    doc.text(c.value, x + 3.5, cardY + 15);
    // sub
    if (c.sub) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(...MUTED);
      doc.text(c.sub, x + 3.5, cardY + 19.5);
    }
  });

  // ── Section title ──
  const tableTop = cardY + cardH + 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_DARK);
  doc.text('Transaction Ledger', margin, tableTop);
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(0.4);
  doc.line(margin, tableTop + 1.8, pageWidth - margin, tableTop + 1.8);

  // ── Transactions table ──
  autoTable(doc, {
    startY: tableTop + 4,
    head: [['Date / Time', 'Recipient', 'Phone', 'Method', 'Amount', 'Commission', 'Telecom', 'Status', 'Reference']],
    body: input.rows.map((r) => [
      r.dateTime,
      r.recipient,
      r.phone || '—',
      r.method,
      fmtUGX(r.amount),
      r.commission === null ? 'not credited' : fmtUGX(r.commission),
      fmtUGX(r.telecom),
      r.status,
      r.reference || '—',
    ]),
    foot: [[
      'Totals', '', '', '',
      fmtUGX(s.volumeTotal),
      fmtUGX(s.commissionCredited),
      fmtUGX(s.telecomTotal),
      `${s.payouts} txn`, '',
    ]],
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 7.6, cellPadding: 2, overflow: 'linebreak', valign: 'middle', textColor: INK, lineColor: BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: BRAND, textColor: 255, fontSize: 7.6, fontStyle: 'bold', halign: 'left' },
    footStyles: { fillColor: tint(BRAND, 0.85), textColor: BRAND_DARK, fontStyle: 'bold', fontSize: 7.8 },
    alternateRowStyles: { fillColor: STRIPE },
    columnStyles: {
      0: { cellWidth: 26 },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 24 },
      3: { cellWidth: 24 },
      4: { cellWidth: 26, halign: 'right', fontStyle: 'bold' },
      5: { cellWidth: 25, halign: 'right' },
      6: { cellWidth: 22, halign: 'right' },
      7: { cellWidth: 20, halign: 'center' },
      8: { cellWidth: 30, fontSize: 6.8, textColor: MUTED },
    },
    didParseCell: (data: any) => {
      // colour the status pill
      if (data.section === 'body' && data.column.index === 7) {
        const v = String(data.cell.raw || '').toLowerCase();
        if (v.includes('complet') || v.includes('success') || v.includes('paid')) {
          data.cell.styles.textColor = EMERALD;
          data.cell.styles.fontStyle = 'bold';
        } else if (v.includes('fail') || v.includes('reject')) {
          data.cell.styles.textColor = RED;
          data.cell.styles.fontStyle = 'bold';
        } else {
          data.cell.styles.textColor = AMBER;
          data.cell.styles.fontStyle = 'bold';
        }
      }
      // dim "not credited" commission
      if (data.section === 'body' && data.column.index === 5) {
        if (String(data.cell.raw || '').toLowerCase().includes('not credited')) {
          data.cell.styles.textColor = RED;
          data.cell.styles.fontStyle = 'italic';
        }
      }
    },
  });

  // ── Footer on every page ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.line(margin, pageHeight - 9, pageWidth - margin, pageHeight - 9);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text('Powered by Welile — confidential merchant commission report', margin, pageHeight - 5);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, pageHeight - 5, { align: 'right' });
  }

  return doc.output('blob');
}
