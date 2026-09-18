import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_STRIPE: [number, number, number] = [243, 238, 252];
const POSITIVE: [number, number, number] = [5, 150, 105];
const NEGATIVE: [number, number, number] = [220, 38, 38];
const INK: [number, number, number] = [15, 23, 42];

export interface ForecastPdfPeriod {
  key: string;
  label: string;
  is_past: boolean;
  forecast_returns: number;
  actual_returns_paid: number;
  variance: number;
  partner_receivable: number;
  topups: number;
  promissory_receivable: number;
  compounding: number;
  net: number;
}

export interface ForecastPdfDetailRow {
  name: string;
  detail: string;
  amount: number;
  occurred_on: string;
  status: string;
}

export interface ForecastPdfDetailGroup {
  periodLabel: string;
  metricLabel: string;
  total: number;
  count: number;
  truncated: boolean;
  rows: ForecastPdfDetailRow[];
}

export interface ForecastPdfMeta {
  rangeText: string;
  bucketText: string;
  portfolioCount: number;
  committedCapital: number;
  promissoryOutstanding: number;
}

const fmtUGX = (n: number) =>
  new Intl.NumberFormat('en-UG', {
    style: 'currency',
    currency: 'UGX',
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);

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
 * Branded PDF of the Partner Ops Returns forecast: the period figures shown in
 * the chart, then the portfolio / ledger / promissory records behind them.
 */
export async function generatePartnerReturnsForecastPdf(
  periods: ForecastPdfPeriod[],
  details: ForecastPdfDetailGroup[],
  meta: ForecastPdfMeta,
  generatedAt: Date = new Date(),
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;

  const logo = await loadLogoBase64();

  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 28, 'F');
  if (logo) {
    try {
      doc.addImage(logo, 'PNG', margin, 6, 16, 16);
    } catch {
      /* ignore */
    }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Partner Ops Returns — forecast vs actually paid', logo ? margin + 20 : margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `${meta.rangeText} · ${meta.bucketText} · generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`,
    logo ? margin + 20 : margin,
    20,
  );

  const past = periods.filter((p) => p.is_past);
  const forecastPast = past.reduce((s, p) => s + Number(p.forecast_returns), 0);
  const actualPast = past.reduce((s, p) => s + Number(p.actual_returns_paid), 0);
  const forecastAhead = periods
    .filter((p) => !p.is_past)
    .reduce((s, p) => s + Number(p.forecast_returns), 0);
  const sum = (k: keyof ForecastPdfPeriod) =>
    periods.reduce((s, p) => s + Number(p[k] as number), 0);

  let y = 37;
  doc.setTextColor(...INK);
  doc.setFontSize(9);
  const summary: [string, string][] = [
    ['Forecast (past periods)', fmtUGX(forecastPast)],
    ['Actually paid (past periods)', fmtUGX(actualPast)],
    ['Difference', fmtUGX(actualPast - forecastPast)],
    ['Forecast ahead', fmtUGX(forecastAhead)],
    ['Receivable from partners', fmtUGX(sum('partner_receivable'))],
    ['Top-ups received', fmtUGX(sum('topups'))],
    ['Promissory notes receivable', fmtUGX(sum('promissory_receivable'))],
    ['Compounding (reinvested)', fmtUGX(sum('compounding'))],
    ['Net position', fmtUGX(sum('net'))],
    [
      'Live portfolios',
      `${meta.portfolioCount} · ${fmtUGX(meta.committedCapital)} committed`,
    ],
  ];
  const colWidth = (pageWidth - margin * 2) / 2;
  summary.forEach(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = margin + col * colWidth;
    const ly = y + row * 5.5;
    doc.setFont('helvetica', 'bold');
    doc.text(`${label}:`, x, ly);
    doc.setFont('helvetica', 'normal');
    doc.text(value, x + 62, ly);
  });
  y += Math.ceil(summary.length / 2) * 5.5 + 3;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Period figures', margin, y);

  autoTable(doc, {
    startY: y + 3,
    head: [
      [
        'Period',
        'Forecast',
        'Actually paid',
        'Difference',
        'Receivable',
        'Top-ups',
        'Promissory',
        'Compounding',
        'Net',
      ],
    ],
    body: periods.map((p) => [
      p.is_past ? p.label : `${p.label} (ahead)`,
      fmtUGX(p.forecast_returns),
      p.is_past ? fmtUGX(p.actual_returns_paid) : '—',
      p.is_past ? fmtUGX(p.variance) : '—',
      fmtUGX(p.partner_receivable),
      fmtUGX(p.topups),
      fmtUGX(p.promissory_receivable),
      fmtUGX(p.compounding),
      fmtUGX(p.net),
    ]),
    margin: { left: margin, right: margin },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 8, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 30 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
      8: { halign: 'right', fontStyle: 'bold' },
    },
    didParseCell: (data: any) => {
      if (data.section !== 'body') return;
      const p = periods[data.row.index];
      if (!p) return;
      if (data.column.index === 3 && p.is_past) {
        data.cell.styles.textColor = Number(p.variance) >= 0 ? POSITIVE : NEGATIVE;
      }
      if (data.column.index === 8) {
        data.cell.styles.textColor = Number(p.net) >= 0 ? POSITIVE : NEGATIVE;
      }
    },
  });

  const groups = details.filter((g) => g.rows.length > 0);
  if (groups.length > 0) {
    doc.addPage();
    doc.setTextColor(...INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.text('Supporting portfolio transactions', margin, 18);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(
      'Every record behind the figures above, grouped by period and figure, largest first.',
      margin,
      24,
    );

    let cursor = 30;
    for (const g of groups) {
      const pageHeight = doc.internal.pageSize.getHeight();
      if (cursor > pageHeight - 45) {
        doc.addPage();
        cursor = 18;
      }
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...THEME_PRIMARY);
      doc.text(`${g.periodLabel} — ${g.metricLabel}`, margin, cursor);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...INK);
      doc.text(
        `${g.count} record${g.count === 1 ? '' : 's'} · ${fmtUGX(g.total)}${
          g.truncated ? ` · showing the largest ${g.rows.length}` : ''
        }`,
        pageWidth - margin,
        cursor,
        { align: 'right' },
      );

      autoTable(doc, {
        startY: cursor + 3,
        head: [['#', 'Who', 'Record', 'Status', 'Date', 'Amount']],
        body: g.rows.map((r, i) => [
          String(i + 1),
          r.name,
          r.detail,
          r.status,
          r.occurred_on,
          fmtUGX(r.amount),
        ]),
        margin: { left: margin, right: margin },
        styles: { fontSize: 7.5, cellPadding: 1.6, overflow: 'linebreak' },
        headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 7.5, fontStyle: 'bold' },
        alternateRowStyles: { fillColor: THEME_STRIPE },
        columnStyles: {
          0: { cellWidth: 8, halign: 'right' },
          1: { cellWidth: 42 },
          2: { cellWidth: 'auto' },
          3: { cellWidth: 28 },
          4: { cellWidth: 22 },
          5: { cellWidth: 30, halign: 'right', fontStyle: 'bold' },
        },
      });
      cursor = ((doc as any).lastAutoTable?.finalY ?? cursor) + 9;
    }
  }

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — confidential treasury report', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, ph - 6, { align: 'right' });
  }

  return doc.output('blob');
}
