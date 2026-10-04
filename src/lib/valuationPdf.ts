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

export interface ValuationComparisonPdfInput {
  scenarios: { label: string; inputs: ScenarioInputs; result: ScenarioResult }[];
  monthlyRevenue: number;
  ugxPerUsd: number;
  rateNote: string;
}

const ugx = (v: number) => `UGX ${Math.round(v).toLocaleString('en-US')}`;
const usd = (v: number, r: number) => `US$${Math.round(v / r).toLocaleString('en-US')}`;
const nowKampala = () => new Date().toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' });
const lastAutoTable = (doc: jsPDF) =>
  (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable;

// Letterhead: logo on the left, contact details top-right.
function drawLetterhead(doc: jsPDF) {
  doc.addImage(WELILE_LOGO, 'PNG', 40, 36, 110, 39.8);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110);
  doc.text('+256 200 909 000', 555, 42, { align: 'right' });
  doc.text('www.welile.com', 555, 55, { align: 'right' });
  doc.text('Kabale Entebbe Rd', 555, 68, { align: 'right' });
  doc.setDrawColor(200); doc.setLineWidth(0.7);
  doc.line(40, 88, 555, 88);
  doc.setTextColor(0);
}

// Continuation pages get the letterhead too; tables keep clear of it.
const pageHook = (doc: jsPDF) => () => {
  if (doc.getNumberOfPages() > 1) drawLetterhead(doc);
};

function yearRows(r: ScenarioResult, rate: number) {
  return r.rows.map((y) => [
    String(y.year), ugx(y.revenue),
    `${ugx(y.valuation)}\n${usd(y.valuation, rate)}`,
    `${y.founderStakePct.toFixed(1)}%`,
    `${ugx(y.stakeValue)}\n${usd(y.stakeValue, rate)}`,
  ]);
}

const DISCLAIMER =
  'One round a year: the first today, the next in years 1 and 2. Existing holders start at 92% (8% is the Angel Pool). ' +
  'These figures are estimates from adjustable assumptions, not a forecast, offer or financial advice.';

export function buildValuationPdf(d: ValuationPdfInput): { blob: Blob; fileName: string } {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const now = nowKampala();
  drawLetterhead(doc);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text('Company Valuation', 40, 112);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  doc.text(`Scenario: ${d.scenarioLabel}`, 40, 130);
  doc.setFontSize(9); doc.setTextColor(110);
  doc.text(`Prepared ${now} (Kampala). ${d.rateNote}`, 40, 146, { maxWidth: 515 });
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 164,
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
    margin: { top: 100 },
    didDrawPage: pageHook(doc),
  });

  autoTable(doc, {
    startY: lastAutoTable(doc).finalY + 20,
    head: [['Year', 'Yearly revenue', 'Company value', 'Existing holders stake', 'Stake value']],
    body: yearRows(d.result, d.ugxPerUsd),
    styles: { fontSize: 9 },
    margin: { top: 100 },
    didDrawPage: pageHook(doc),
  });

  const y = lastAutoTable(doc).finalY + 24;
  doc.setFontSize(8); doc.setTextColor(110);
  doc.text(DISCLAIMER, 40, y, { maxWidth: 515 });
  const fileName = `welile-valuation-${d.scenarioLabel.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`;
  return { blob: doc.output('blob'), fileName };
}

export function buildValuationComparisonPdf(d: ValuationComparisonPdfInput): { blob: Blob; fileName: string } {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const now = nowKampala();
  drawLetterhead(doc);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
  doc.text('Company Valuation — Scenario Comparison', 40, 112);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
  doc.text('Conservative, Base and High growth side by side', 40, 130);
  doc.setFontSize(9); doc.setTextColor(110);
  doc.text(`Prepared ${now} (Kampala). ${d.rateNote}`, 40, 146, { maxWidth: 515 });
  doc.setTextColor(0);

  autoTable(doc, {
    startY: 164,
    head: [['Assumption', ...d.scenarios.map((s) => s.label)]],
    body: [
      ['Starting monthly revenue', ...d.scenarios.map(() => `${ugx(d.monthlyRevenue)} (${usd(d.monthlyRevenue, d.ugxPerUsd)})`)],
      ['Monthly revenue growth', ...d.scenarios.map((s) => `${s.inputs.monthlyGrowthPct}%`)],
      ['Revenue multiple', ...d.scenarios.map((s) => `${s.inputs.multiple}×`)],
      ['Equity sold per round', ...d.scenarios.map((s) => `${s.inputs.dilutionPct}%`)],
      ['Value today (before new money)', ...d.scenarios.map((s) => `${ugx(s.result.todayPreMoney)} (${usd(s.result.todayPreMoney, d.ugxPerUsd)})`)],
      ['Raise today', ...d.scenarios.map((s) => `${ugx(s.result.todayRaise)} (${usd(s.result.todayRaise, d.ugxPerUsd)})`)],
    ],
    styles: { fontSize: 9 },
    margin: { top: 100 },
    didDrawPage: pageHook(doc),
  });

  for (const s of d.scenarios) {
    let headingY = lastAutoTable(doc).finalY + 28;
    if (headingY > 660) {
      doc.addPage();
      drawLetterhead(doc);
      headingY = 120;
    }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text(`${s.label} — 3-year outlook`, 40, headingY);
    autoTable(doc, {
      startY: headingY + 8,
      head: [['Year', 'Yearly revenue', 'Company value', 'Existing holders stake', 'Stake value']],
      body: yearRows(s.result, d.ugxPerUsd),
      styles: { fontSize: 9 },
      margin: { top: 100 },
      didDrawPage: pageHook(doc),
    });
  }

  const dy = lastAutoTable(doc).finalY + 24;
  if (dy > 780) {
    doc.addPage();
    drawLetterhead(doc);
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(DISCLAIMER, 40, 120, { maxWidth: 515 });
  } else {
    doc.setFontSize(8); doc.setTextColor(110);
    doc.text(DISCLAIMER, 40, dy, { maxWidth: 515 });
  }
  const fileName = `welile-valuation-comparison-${new Date().toISOString().slice(0, 10)}.pdf`;
  return { blob: doc.output('blob'), fileName };
}

async function sharePdf(blob: Blob, fileName: string, title: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], fileName, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (x: { files: File[] }) => boolean };
  if (nav.share && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file], title });
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

export async function shareValuationPdf(d: ValuationPdfInput): Promise<'shared' | 'downloaded'> {
  const { blob, fileName } = buildValuationPdf(d);
  return sharePdf(blob, fileName, `Welile valuation — ${d.scenarioLabel}`);
}

export async function shareValuationComparisonPdf(d: ValuationComparisonPdfInput): Promise<'shared' | 'downloaded'> {
  const { blob, fileName } = buildValuationComparisonPdf(d);
  return sharePdf(blob, fileName, 'Welile valuation — scenario comparison');
}
