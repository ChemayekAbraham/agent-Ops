/**
 * Self-serve period wallet statement.
 *
 * Reads ONLY the signed-in user's own wallet ledger legs, with the same
 * user-facing filter as the wallet history, for any chosen date range.
 * Opening balance = sum of the same visible legs before the start date.
 * Read-only: never writes anything.
 */
import { supabase } from '@/integrations/supabase/client';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';
import { requisitionEntryLabel } from '@/lib/walletRequisitionLabel';
import welileLogo from '@/assets/welile-logo.png';

export interface PeriodRow {
  id: string;
  transaction_date: string;
  amount: number;
  direction: 'cash_in' | 'cash_out';
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  source_table: string | null;
  source_id: string | null;
  classification?: string | null;
}

const PAGE = 1000;

function base(userId: string, cols: string) {
  return applyCustomerWalletLedgerFilters(
    supabase.from('general_ledger').select(cols).eq('user_id', userId).in('ledger_scope', ['wallet', 'bridge']),
  );
}

async function fetchAll(userId: string, cols: string, apply: (q: any) => any): Promise<any[]> {
  const out: any[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await apply(base(userId, cols))
      .order('transaction_date', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as any[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out.filter(isCustomerWalletLedgerEntryVisible);
}

const signed = (r: { amount: number; direction: string }) =>
  (r.direction === 'cash_in' ? 1 : -1) * Number(r.amount || 0);

const LABELS: Record<string, string> = {
  deposit: 'Wallet deposit', wallet_deposit: 'Wallet deposit', withdrawal: 'Withdrawal',
  wallet_withdrawal: 'Withdrawal', wallet_transfer: 'Wallet transfer', transfer_in: 'Transfer in',
  transfer_out: 'Transfer out', agent_commission: 'Agent commission', agent_commission_earned: 'Commission earned',
  salary_payout: 'Salary', roi_wallet_credit: 'Returns', roi_payout: 'Returns', partner_funding: 'Supporter portfolio',
  rent_repayment: 'Rent repayment', referral_bonus: 'Referral bonus', share_capital: 'Angel Pool shares',
};

export function categoryLabel(category: string, description?: string | null) {
  return requisitionEntryLabel(description) || LABELS[category] ||
    category.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface PeriodStatement {
  from: string; to: string; opening: number; closing: number;
  totalIn: number; totalOut: number; rows: (PeriodRow & { balance: number })[];
}

/** from/to are YYYY-MM-DD, inclusive, interpreted in Kampala time (UTC+3). */
export async function loadPeriodStatement(userId: string, from: string, to: string): Promise<PeriodStatement> {
  const startIso = new Date(`${from}T00:00:00+03:00`).toISOString();
  const endIso = new Date(`${to}T23:59:59.999+03:00`).toISOString();
  const [rows, after, wallet] = await Promise.all([
    fetchAll(userId, 'id, transaction_date, amount, direction, category, description, reference_id, linked_party, source_table, source_id, classification',
      (q) => q.gte('transaction_date', startIso).lte('transaction_date', endIso)),
    fetchAll(userId, 'id, amount, direction, category, description, classification, source_table', (q) => q.gt('transaction_date', endIso)),
    supabase.from('wallets').select('withdrawable_balance, float_balance, balance').eq('user_id', userId).maybeSingle(),
  ]);

  // The wallet cache is the authoritative balance the user sees, and it is not a
  // plain sum of the visible legs: internal corrections, baseline anchors and
  // reseeds are deliberately hidden from customer-facing history. So anchor the
  // running balance at the CURRENT balance and walk backwards, instead of
  // summing visible legs forward from zero — otherwise a statement ending today
  // closes on a number that disagrees with the wallet card.
  const w: any = (wallet as any)?.data ?? null;
  const current = w
    ? Number(w.balance ?? 0) || Number(w.withdrawable_balance ?? 0) + Number(w.float_balance ?? 0)
    : 0;
  const netAfter = after.reduce((s, r) => s + signed(r), 0);
  const closing = current - netAfter;

  let totalIn = 0, totalOut = 0;
  const net = (rows as PeriodRow[]).reduce((s, r) => {
    const v = signed(r);
    if (v >= 0) totalIn += v; else totalOut += -v;
    return s + v;
  }, 0);
  const opening = closing - net;

  let bal = opening;
  const withBal = (rows as PeriodRow[]).map((r) => {
    bal += signed(r);
    return { ...r, amount: Number(r.amount), balance: bal };
  });
  return { from, to, opening, closing, totalIn, totalOut, rows: withBal };
}


const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

async function logoData(): Promise<string | null> {
  try {
    const b = await (await fetch(welileLogo)).blob();
    return await new Promise((res, rej) => { const r = new FileReader(); r.onloadend = () => res(r.result as string); r.onerror = rej; r.readAsDataURL(b); });
  } catch { return null; }
}

function kampala(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export async function generatePeriodStatementPdf(
  st: PeriodStatement, owner: { name: string; phone?: string | null },
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const m = 12;
  const logo = await logoData();

  if (logo) { try { pdf.addImage(logo, 'PNG', m, 8, 14, 14); } catch { /* ignore */ } }
  pdf.setFont('helvetica', 'bold'); pdf.setFontSize(15);
  pdf.text('Welile Wallet Statement', m + 18, 14);
  pdf.setFont('helvetica', 'normal'); pdf.setFontSize(9);
  pdf.text(`${owner.name}${owner.phone ? `  ·  ${owner.phone}` : ''}`, m + 18, 19.5);
  pdf.text(`Period: ${st.from} to ${st.to} (Kampala time)  ·  Generated ${kampala(new Date().toISOString())}`, m + 18, 24);

  autoTable(pdf, {
    startY: 30, theme: 'grid', styles: { fontSize: 9 }, headStyles: { fillColor: [40, 40, 40] },
    head: [['Opening balance', 'Money in', 'Money out', 'Closing balance', 'Transactions']],
    body: [[ugx(st.opening), ugx(st.totalIn), ugx(st.totalOut), ugx(st.closing), String(st.rows.length)]],
    margin: { left: m, right: m },
  });

  const group = (dir: 'cash_in' | 'cash_out') => {
    const map = new Map<string, { n: number; amt: number }>();
    st.rows.filter((r) => r.direction === dir).forEach((r) => {
      const k = categoryLabel(r.category, r.description);
      const g = map.get(k) ?? { n: 0, amt: 0 }; g.n++; g.amt += r.amount; map.set(k, g);
    });
    return [...map.entries()].sort((a, b) => b[1].amt - a[1].amt).map(([k, g]) => [k, String(g.n), ugx(g.amt)]);
  };
  const half = (pw - m * 2 - 6) / 2;
  const y0 = (pdf as any).lastAutoTable.finalY + 6;
  autoTable(pdf, { startY: y0, theme: 'striped', styles: { fontSize: 8.5 }, headStyles: { fillColor: [22, 128, 70] },
    head: [['Where money came from', 'Count', 'Amount']], body: group('cash_in').length ? group('cash_in') : [['None', '', '']],
    margin: { left: m, right: pw - m - half } });
  const yIn = (pdf as any).lastAutoTable.finalY;
  autoTable(pdf, { startY: y0, theme: 'striped', styles: { fontSize: 8.5 }, headStyles: { fillColor: [160, 40, 40] },
    head: [['Where money went', 'Count', 'Amount']], body: group('cash_out').length ? group('cash_out') : [['None', '', '']],
    margin: { left: m + half + 6, right: m } });
  const yOut = (pdf as any).lastAutoTable.finalY;

  autoTable(pdf, {
    startY: Math.max(yIn, yOut) + 8, theme: 'grid', styles: { fontSize: 7.5, cellPadding: 1.5, overflow: 'linebreak' },
    headStyles: { fillColor: [40, 40, 40] },
    head: [['Date (Kampala)', 'What happened', 'Details', 'Other party', 'Source reference', 'Money in', 'Money out', 'Balance']],
    body: st.rows.length ? st.rows.map((r) => [
      kampala(r.transaction_date), categoryLabel(r.category, r.description), r.description ?? '',
      r.linked_party ?? '',
      [r.reference_id, r.source_table && r.source_id ? `${r.source_table}:${r.source_id}` : null, `entry:${r.id}`].filter(Boolean).join('\n'),
      r.direction === 'cash_in' ? ugx(r.amount) : '', r.direction === 'cash_out' ? ugx(r.amount) : '', ugx(r.balance),
    ]) : [[{ content: 'No transactions in this period.', colSpan: 8 }]],
    columnStyles: { 0: { cellWidth: 26 }, 1: { cellWidth: 30 }, 2: { cellWidth: 62 }, 3: { cellWidth: 30 }, 4: { cellWidth: 52 },
      5: { halign: 'right', cellWidth: 22 }, 6: { halign: 'right', cellWidth: 22 }, 7: { halign: 'right', cellWidth: 25 } },
    margin: { left: m, right: m },
    didDrawPage: () => {
      pdf.setFontSize(7.5); pdf.setTextColor(120);
      pdf.text(`Page ${pdf.getNumberOfPages()}  ·  All amounts in UGX  ·  Confidential`, pw / 2, pdf.internal.pageSize.getHeight() - 5, { align: 'center' });
      pdf.setTextColor(0);
    },
  });
  return pdf.output('blob');
}

const csvCell = (v: string | number | null | undefined) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function generatePeriodStatementCsv(
  st: PeriodStatement, owner: { name: string; phone?: string | null },
): Blob {
  const lines: string[] = [
    'Welile Wallet Statement',
    `Name,${csvCell(owner.name)}`,
    `Phone,${csvCell(owner.phone ?? '')}`,
    `Period,${st.from} to ${st.to} (Kampala time)`,
    `Opening balance (UGX),${Math.round(st.opening)}`,
    `Money in (UGX),${Math.round(st.totalIn)}`,
    `Money out (UGX),${Math.round(st.totalOut)}`,
    `Closing balance (UGX),${Math.round(st.closing)}`,
    `Transactions,${st.rows.length}`,
    '',
    ['Date (Kampala)', 'What happened', 'Details', 'Other party', 'Direction', 'Money in (UGX)', 'Money out (UGX)', 'Balance (UGX)', 'Reference', 'Source table', 'Source ID', 'Entry ID'].join(','),
    ...st.rows.map((r) => [
      kampala(r.transaction_date), categoryLabel(r.category, r.description), r.description ?? '',
      r.linked_party ?? '', r.direction === 'cash_in' ? 'Money in' : 'Money out',
      r.direction === 'cash_in' ? Math.round(r.amount) : '', r.direction === 'cash_out' ? Math.round(r.amount) : '',
      Math.round(r.balance), r.reference_id ?? '', r.source_table ?? '', r.source_id ?? '', r.id,
    ].map(csvCell).join(',')),
  ];
  return new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
}
