// Export of the First 7 Days tab as it is on screen: the Rent Plans left after the filters, the filters themselves and when it was made
// (Kampala time). Presentation only: every figure and state is the server's (am_new_tenant_first7_v2); nothing is worked out here.
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format, parseISO } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { downloadCsvWithPreamble } from '@/lib/csvExport';
import {
  DAY_STATE_LABEL,
  STATUS_LABEL,
  addDays,
  kampalaStamp,
  type CardFilter,
  type DayState,
  type First7Params,
  type First7Row,
} from '@/lib/newTenantFirst7';

export interface First7ExportInput {
  /** the Rent Plans left after the filters, in the order shown */
  rows: First7Row[];
  /** how many Rent Plans the range has before the filters */
  totalInRange: number;
  params: First7Params;
  /** name of the agent filter, when one is set */
  agentName: string | null;
  generatedAt?: Date;
}

const long = (iso: string) => format(parseISO(iso), 'd MMM yyyy');
const short = (iso: string) => format(parseISO(iso), 'd MMM');

export const CARD_LABEL: Record<CardFilter, string> = {
  all: 'All Rent Plans',
  day1: 'Paid on day 1',
  on_track: STATUS_LABEL.on_track,
  behind: STATUS_LABEL.behind,
  not_started: STATUS_LABEL.not_started,
  too_early: STATUS_LABEL.too_early,
};

const FREQ_LABEL = { all: 'Daily and weekly', daily: 'Daily', weekly: 'Weekly' } as const;

/** The filters in words, as [label, value] pairs. */
export function first7FilterLines(i: Pick<First7ExportInput, 'params' | 'agentName'>): [string, string][] {
  const p = i.params;
  return [
    ['Landlord paid', p.from === p.to ? long(p.from) : `${long(p.from)} – ${long(p.to)}`],
    ['Payment period', FREQ_LABEL[p.freq]],
    ['Agent', p.agent ? i.agentName ?? 'Selected agent' : 'All agents'],
    ['Search', p.q.trim() ? `"${p.q.trim()}"` : 'None'],
    ['Show', CARD_LABEL[p.card]],
    ['Day', p.day === null ? 'All days' : `Paid on day ${p.day}`],
  ];
}

export function first7Filename(i: Pick<First7ExportInput, 'params'>, ext: 'csv' | 'pdf'): string {
  const { from, to } = i.params;
  return `first-7-days-${from === to ? from : `${from}_to_${to}`}.${ext}`;
}

const dueDayLabel = (r: First7Row) => (r.frequency === 'weekly' ? 'Weekly' : 'Daily');
const instalment = (r: First7Row) => (r.frequency === 'weekly' ? r.day_due.find((d) => d > 0) ?? r.daily_due * 7 : r.daily_due);

/** The day's figure for a grid or a file: the server's state, with a day that owes nothing shown as "Not due" (weekly days 2 to 7). */
export function exportDayState(r: First7Row, i: number): DayState {
  const state = r.day_state[i] ?? 'future';
  if ((r.day_paid[i] ?? 0) > 0 && (state === 'paid' || state === 'part')) return state;
  return (r.day_due[i] ?? 0) === 0 ? 'not_due' : state;
}

export function buildFirst7Csv(i: First7ExportInput): { preamble: string[][]; headers: string[]; rows: (string | number)[][] } {
  const stamp = kampalaStamp(i.generatedAt);
  const preamble: string[][] = [
    ['First 7 Days: Rent Plans'],
    ['Generated (Kampala time)', stamp],
    ...first7FilterLines(i),
    ['Rent Plans in this file', `${i.rows.length} of ${i.totalInRange}`],
    ['Amounts', 'UGX'],
  ];
  const headers = [
    'Tenant', 'Phone', 'Agent', 'Payment period', 'Instalment (UGX)', 'Total to repay (UGX)', 'Landlord paid', 'Day 1',
    ...Array.from({ length: 7 }, (_, n) => [`Day ${n + 1} paid (UGX)`, `Day ${n + 1} state`]).flat(),
    'Paid in 7 days (UGX)', 'Due so far (UGX)', 'Status',
  ];
  const rows = i.rows.map((r) => [
    r.tenant_name ?? '', r.tenant_phone ?? '', r.agent_name ?? '', dueDayLabel(r), instalment(r), r.total_repayment, r.landlord_paid_on, r.day1,
    ...Array.from({ length: 7 }, (_, n) => [r.day_paid[n] ?? 0, DAY_STATE_LABEL[exportDayState(r, n)]]).flat(),
    r.paid_7d, r.expected_to_date, STATUS_LABEL[r.row_status],
  ]);
  return { preamble, headers, rows };
}

export function downloadFirst7Csv(i: First7ExportInput) {
  const { preamble, headers, rows } = buildFirst7Csv(i);
  downloadCsvWithPreamble(first7Filename(i, 'csv'), preamble, headers, rows);
}

// ---------- PDF ----------

type RGB = [number, number, number];
const BRAND: RGB = [146, 52, 234];
const INK: RGB = [15, 23, 42];
const MUTED: RGB = [110, 112, 125];
const TINT: Record<DayState, RGB> = {
  paid: [220, 245, 233],
  part: [253, 240, 214],
  missed: [253, 224, 224],
  future: [238, 239, 243],
  not_due: [255, 255, 255],
};
const INK_STATE: Record<DayState, RGB> = {
  paid: [5, 120, 85],
  part: [180, 100, 0],
  missed: [185, 28, 28],
  future: [120, 122, 135],
  not_due: [150, 152, 160],
};
const ugx = (n: number) => Math.round(n).toLocaleString('en-US');

async function logPdfExport(filename: string, count: number) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'pdf_report_exported',
      table_name: 'export',
      record_id: null,
      metadata: { filename, report: 'agent_ops_first_7_days', row_count: count },
    });
  } catch (e) {
    console.warn('[first7Export] audit log insert failed:', e);
  }
}

export async function generateFirst7Pdf(i: First7ExportInput) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 10;
  const stamp = kampalaStamp(i.generatedAt);

  doc.setFillColor(...BRAND);
  doc.rect(0, 0, W, 22, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
  doc.text('First 7 Days: Rent Plans', M, 11);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
  doc.text('How new Rent Plans repay in the 7 days after the landlord was paid. Day 1 is the day after.', M, 17);
  doc.text(`Generated ${stamp} (Kampala time)`, W - M, 11, { align: 'right' });
  doc.text('Amounts in UGX', W - M, 17, { align: 'right' });

  let y = 28;
  doc.setFontSize(8);
  first7FilterLines(i).forEach(([k, v], n) => {
    const col = n % 3; const row = Math.floor(n / 3);
    const x = M + col * ((W - 2 * M) / 3);
    doc.setFont('helvetica', 'bold'); doc.setTextColor(...BRAND); doc.text(`${k}:`, x, y + row * 5);
    doc.setFont('helvetica', 'normal'); doc.setTextColor(...INK); doc.text(v, x + doc.getTextWidth(`${k}: `) + 1, y + row * 5);
  });
  y += 12;
  doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK); doc.setFontSize(9);
  doc.text(`${i.rows.length} of ${i.totalInRange} Rent Plans`, M, y);
  y += 3;

  autoTable(doc, {
    startY: y,
    margin: { left: M, right: M, bottom: 12 },
    styles: { fontSize: 6.8, cellPadding: 1.2, textColor: INK, lineColor: [226, 228, 236], lineWidth: 0.1, valign: 'middle' },
    headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold', halign: 'center' },
    head: [['Tenant', 'Agent', 'Plan', 'Paid out', ...Array.from({ length: 7 }, (_, n) => `Day ${n + 1}`), 'Paid in 7 days', 'Due so far', 'Status']],
    body: i.rows.map((r) => [
      `${r.tenant_name ?? '—'}\n${r.tenant_phone ?? ''}`,
      r.agent_name ?? '—',
      `${dueDayLabel(r)}\n${ugx(instalment(r))}`,
      short(r.landlord_paid_on),
      ...Array.from({ length: 7 }, (_, n) => {
        const st = exportDayState(r, n);
        if (st === 'not_due') return 'not due';
        if (st === 'future') return `${short(addDays(r.day1, n))}\n—`;
        if (st === 'missed') return 'Missed';
        return ugx(r.day_paid[n] ?? 0);
      }),
      ugx(r.paid_7d),
      ugx(r.expected_to_date),
      STATUS_LABEL[r.row_status],
    ]),
    columnStyles: {
      0: { cellWidth: 34 }, 1: { cellWidth: 26 }, 2: { cellWidth: 20 }, 3: { cellWidth: 14, halign: 'center' },
      11: { halign: 'right', cellWidth: 20 }, 12: { halign: 'right', cellWidth: 18 }, 13: { halign: 'center', cellWidth: 17 },
    },
    didParseCell: (d) => {
      if (d.section !== 'body') return;
      if (d.column.index >= 4 && d.column.index <= 10) {
        const st = exportDayState(i.rows[d.row.index], d.column.index - 4);
        d.cell.styles.fillColor = TINT[st];
        d.cell.styles.textColor = INK_STATE[st];
        d.cell.styles.halign = 'center';
      }
    },
    didDrawPage: () => {
      const n = doc.getNumberOfPages();
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(...MUTED);
      doc.text(`First 7 Days · ${stamp} (Kampala time)`, M, doc.internal.pageSize.getHeight() - 5);
      doc.text(`Page ${n}`, W - M, doc.internal.pageSize.getHeight() - 5, { align: 'right' });
    },
  });

  const filename = first7Filename(i, 'pdf');
  doc.save(filename);
  void logPdfExport(filename, i.rows.length);
}
