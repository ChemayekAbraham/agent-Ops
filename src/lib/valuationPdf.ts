import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { ScenarioInputs, ScenarioResult } from '@/lib/valuationModel';
import { WELILE_LOGO } from '@/hr/pay/letterheadLogo';

export interface ValuationPdfInput {
  scenarioLabel: string;
  inputs: ScenarioInputs;
  result: ScenarioResult;
  monthlyRevenue: number;
  ugxPerUsd: number;
  rateNote: string;
}

const ugx = (v: number) => `UGX ${Math.round(v).toLocaleString('en-US')}`;
const usd = (v: number, r: number) => `US$${Math.round(v / r).toLocaleString('en-US')}`;

export function buildValuationPdf(d: ValuationPdfInput): { blob: Blob; fileName: string } {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text('Welile — Company Valuation', 40, 50);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  doc.text(`Scenario: ${d.scenarioLabel}`, 40, 72);
  doc.setFontSize(9); doc.setTextColor(110);
  doc.text(`Prepared ${now} (Kampala). ${d.rateNote}`, 40, 88, { maxWidth: 515 });
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 108,
    head: [['Assumption', 'Value']],
    body: [
      ['Starting monthly revenue', `${ugx(d.monthlyRevenue)} (${usd(d.monthlyRevenue, d.ugxPerUsd)})`],
      ['Monthly revenue growth', `${d.inputs.monthlyGrowthPct}%`],
      ['Revenue multiple', `${d.inputs.multiple}×`],
      ['Equity sold per round', `${d.inputs.dilutionPct}%`],
      ['Value today (before new money)', `${ugx(d.result.todayPreMoney)} (${usd(d.result.todayPreMoney, d.ugxPerUsd)})`],
      ['Raise today', `${ugx(d.result.todayRaise)} (${usd(d.result.todayRaise, d.ugxPerUsd)})`],
    ],
    styles: { fontSize: 9 },
  });

  autoTable(doc, {
    startY: (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20,
    head: [['Year', 'Yearly revenue', 'Company value', 'Existing holders stake', 'Stake value']],
    body: d.result.rows.map((y) => [
      String(y.year), ugx(y.revenue),
      `${ugx(y.valuation)}\n${usd(y.valuation, d.ugxPerUsd)}`,
      `${y.founderStakePct.toFixed(1)}%`,
      `${ugx(y.stakeValue)}\n${usd(y.stakeValue, d.ugxPerUsd)}`,
    ]),
    styles: { fontSize: 9 },
  });

  const y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 24;
  doc.setFontSize(8); doc.setTextColor(110);
  doc.text(
    'One round a year: the first today, the next in years 1 and 2. Existing holders start at 92% (8% is the Angel Pool). ' +
    'These figures are estimates from adjustable assumptions, not a forecast, offer or financial advice.',
    40, y, { maxWidth: 515 },
  );
  const fileName = `welile-valuation-${d.scenarioLabel.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`;
  return { blob: doc.output('blob'), fileName };
}

export async function shareValuationPdf(d: ValuationPdfInput): Promise<'shared' | 'downloaded'> {
  const { blob, fileName } = buildValuationPdf(d);
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (x: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: `Welile valuation — ${d.scenarioLabel}` });
      return 'shared';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'shared';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fileName; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return 'downloaded';
}
