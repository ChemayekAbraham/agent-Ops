/**
 * Read-only PDF for Tenant Ops → Tenant Products & Services → Collections Forecast.
 * Every figure comes straight from the projection RPC payload; the only arithmetic
 * done here is totalling values the server already returned.
 */
import { formatUGX } from '@/lib/rentCalculations';
import type {
  PaymentCollectionsProjection, ProjectionGranularity,
} from '@/hooks/usePaymentCollectionsProjection';

const INK: [number, number, number] = [31, 41, 55];
const MUTED: [number, number, number] = [107, 114, 128];
const GREEN: [number, number, number] = [5, 150, 105];
const AMBER: [number, number, number] = [180, 83, 9];
const PURPLE: [number, number, number] = [124, 58, 237];

const granTitle = (g: ProjectionGranularity) =>
  g === 'day' ? 'Daily' : g === 'week' ? 'Weekly' : g === 'month' ? 'Monthly' : g === 'quarter' ? 'Quarterly' : 'Yearly';

const qualityLabel: Record<string, string> = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Low confidence',
};

export async function downloadCollectionsProjectionPdf(input: {
  projection: PaymentCollectionsProjection;
  horizonLabel: string;
}) {
  const { projection, horizonLabel } = input;
  const { jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default ?? autoTableMod;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;
  const meta = projection.meta;

  const kampalaNow = new Date().toLocaleString('en-GB', {
    timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // ---- Header ----
  doc.setFillColor(15, 23, 42);
  doc.rect(0, 0, pageW, 78, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('Welile — Payment Collections Forecast', margin, 34);
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text(
    `Tenant Products & Services · ${granTitle(projection.granularity)} view · Horizon: ${horizonLabel} · Generated ${kampalaNow} (Kampala)`,
    margin, 52,
  );
  doc.setFontSize(8);
  doc.text('Forecast — estimated from historical payment trends only. Not a guarantee of future collections.', margin, 66);

  // ---- KPI summary ----
  const totalForecast = projection.periods.reduce((s, p) => s + p.forecast_amount, 0);
  const totalLow = projection.periods.reduce((s, p) => s + p.low, 0);
  const totalHigh = projection.periods.reduce((s, p) => s + p.high, 0);
  const worstQuality = projection.periods.some((p) => p.quality === 'low')
    ? 'low' : projection.periods.some((p) => p.quality === 'medium') ? 'medium' : 'high';

  let y = 104;
  doc.setTextColor(...INK);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text('Forecast summary', margin, y);
  y += 8;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Expected collections', 'Range (low – high)', 'Daily level', 'Weekly trend', 'Confidence']],
    body: [[
      formatUGX(totalForecast),
      `${formatUGX(totalLow)} – ${formatUGX(totalHigh)}`,
      formatUGX(meta.level_daily),
      `${meta.trend_weekly >= 0 ? '+' : '−'}${formatUGX(Math.abs(meta.trend_weekly))} / week`,
      qualityLabel[worstQuality],
    ]],
    styles: { fontSize: 9, cellPadding: 6 },
    headStyles: { fillColor: INK, textColor: [255, 255, 255], fontSize: 8 },
    bodyStyles: { textColor: INK },
  });
  y = (doc as any).lastAutoTable.finalY + 18;

  // ---- Period table ----
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.text(`Forecast by ${projection.granularity}`, margin, y);
  y += 8;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Period', 'Forecast', 'Low', 'High', 'Confidence']],
    body: projection.periods.map((p) => [
      p.label,
      formatUGX(p.forecast_amount),
      formatUGX(p.low),
      formatUGX(p.high),
      qualityLabel[p.quality] ?? p.quality,
    ]),
    styles: { fontSize: 8.5, cellPadding: 5 },
    headStyles: { fillColor: INK, textColor: [255, 255, 255], fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    didParseCell: (data: any) => {
      if (data.section === 'body' && data.column.index === 4) {
        const q = projection.periods[data.row.index]?.quality;
        data.cell.styles.textColor = q === 'high' ? GREEN : q === 'medium' ? AMBER : MUTED;
      }
    },
  });
  y = (doc as any).lastAutoTable.finalY + 18;

  // ---- Method disclosure ----
  if (y > 700) { doc.addPage(); y = margin; }
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...INK);
  doc.text('How this is calculated', margin, y);
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED);
  const methodLines = doc.splitTextToSize(
    `${meta.method} History span: ${meta.history_span_days} days (${meta.observed_days} days with collections). ` +
    `As at ${meta.as_at} (East Africa Time). Projections beyond the observed history span are low confidence and must not be treated as commitments.`,
    pageW - margin * 2,
  );
  doc.text(methodLines, margin, y + 14);

  // ---- Footer with page numbers ----
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(
      `Welile · Payment Collections Forecast · Generated ${kampalaNow} (Kampala) — Page ${i} of ${pages}`,
      margin,
      doc.internal.pageSize.getHeight() - 18,
    );
  }

  doc.save(`welile-collections-forecast-${projection.granularity}-${meta.as_at}.pdf`);
}
