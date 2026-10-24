import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUGX } from '@/lib/rentCalculations';
import {
  usePartnerPaidOutstanding, usePartnerPaidOutstandingItems,
  type PartnerItemsComponent, type PartnerPaidOutstanding,
} from '@/hooks/usePartnerPaidOutstanding';

/**
 * Partner Products and Services — Paid & Outstanding.
 * Plain functional version (CFO request 2026-10-24); visual styling is left to the UI pass.
 * All figures come from get_partner_paid_outstanding / get_partner_paid_outstanding_items; nothing is computed here
 * except adding the server's own paid totals for the summary line.
 */

const kampalaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
const monthStart = (ymd: string) => `${ymd.slice(0, 8)}01`;

type Drill = { component: PartnerItemsComponent; status: string; title: string };

const COMMISSION_COMPONENT: Record<string, PartnerItemsComponent> = {
  registration_bonus: 'registration_bonus',
  fulfilment_commission: 'fulfilment_commission',
  topup_commission: 'topup_commission',
  recalculation_topup: 'recalculation_topup',
  lead_override: 'lead_override',
};

export function PartnerPaidOutstandingPanel() {
  const today = kampalaToday();
  const [from, setFrom] = useState<string>(monthStart(today));
  const [to, setTo] = useState<string>(today);
  const [allTime, setAllTime] = useState(false);
  const [drill, setDrill] = useState<Drill | null>(null);
  const pFrom = allTime ? null : from || null;
  const pTo = allTime ? null : to || null;
  const rangeInvalid = !allTime && !!from && !!to && from > to;
  const q = usePartnerPaidOutstanding(pFrom, pTo, !rangeInvalid);
  const d = q.data;

  return (
    <section aria-label="Paid and outstanding" className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className="text-sm font-semibold mr-auto">Paid &amp; Outstanding</h2>
        <label className="text-xs">From
          <Input type="date" aria-label="From date" value={from} disabled={allTime} onChange={(e) => { setFrom(e.target.value); setDrill(null); }} className="h-8 w-40" />
        </label>
        <label className="text-xs">To
          <Input type="date" aria-label="To date" value={to} disabled={allTime} onChange={(e) => { setTo(e.target.value); setDrill(null); }} className="h-8 w-40" />
        </label>
        <Button variant={allTime ? 'default' : 'outline'} size="sm" onClick={() => { setAllTime((v) => !v); setDrill(null); }}>All time</Button>
      </div>
      {rangeInvalid && <p role="alert" className="text-xs text-destructive">The From date is after the To date.</p>}
      {q.isLoading && <p className="text-xs text-muted-foreground">Loading paid and outstanding amounts…</p>}
      {q.isError && <p role="alert" className="text-xs text-destructive">Could not load paid and outstanding amounts. Please refresh.</p>}
      {d && <Summary d={d} onDrill={setDrill} />}
      {drill && <Records key={`${drill.component}|${drill.status}|${pFrom}|${pTo}`} drill={drill} from={pFrom} to={pTo} onClose={() => setDrill(null)} />}
    </section>
  );
}

function Row({ label, count, amount, note, onView, strong }: { label: string; count?: number; amount: number; note?: string; onView?: () => void; strong?: boolean }) {
  return (
    <tr className={strong ? 'font-semibold border-t border-border' : ''}>
      <td className="py-1 pr-2">{label}{note && <span className="block text-[10px] text-muted-foreground font-normal">{note}</span>}</td>
      <td className="py-1 pr-2 text-right tabular-nums">{count === undefined ? '' : count.toLocaleString()}</td>
      <td className="py-1 pr-2 text-right tabular-nums">{formatUGX(amount)}</td>
      <td className="py-1 text-right">{onView && <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onView}>View records</Button>}</td>
    </tr>
  );
}

function Summary({ d, onDrill }: { d: PartnerPaidOutstanding; onDrill: (x: Drill) => void }) {
  const p = d.paid;
  const o = d.outstanding;
  const r = d.reconciliation;
  const comm = p.commissions;
  const lead = comm.find((c) => c.key === 'lead_override');
  const mainComm = comm.filter((c) => c.key !== 'lead_override' && !c.historical_paid_only);
  const histComm = comm.filter((c) => c.historical_paid_only);
  const cashPaidTotal = p.returns_cash.amount + p.commission_totals.commissions_paid;
  const outstandingTotal = o.returns.amount + o.commissions_unpaid.amount;
  const head = <thead><tr className="text-[10px] text-muted-foreground"><th className="text-left font-normal">Component</th><th className="text-right font-normal">Records</th><th className="text-right font-normal">UGX</th><th /></tr></thead>;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div>
        <h3 className="text-xs font-semibold mb-1">Paid {d.period.from ? `${d.period.from} to ${d.period.to}` : '(all time)'}</h3>
        <table className="w-full text-xs">{head}<tbody>
          <Row label="Partner Returns paid in cash" count={p.returns_cash.count} amount={p.returns_cash.amount}
               note={`To partners' own wallets ${formatUGX(p.returns_cash.to_partner_wallet.amount)} · to managing Proxy Agent wallets ${formatUGX(p.returns_cash.to_other_wallet.amount)}${p.returns_cash.not_linked_to_portfolio.count ? ` · not linked to a portfolio ${formatUGX(p.returns_cash.not_linked_to_portfolio.amount)}` : ''}${p.returns_cash.reversed.count ? ` · reversed ${formatUGX(p.returns_cash.reversed.amount)}` : ''}`}
               onView={() => onDrill({ component: 'returns_cash', status: 'all', title: 'Partner Returns paid in cash' })} />
          {mainComm.map((c) => <Row key={c.key} label={c.label} count={c.paid.count} amount={c.paid.amount} note={c.rule}
               onView={() => onDrill({ component: COMMISSION_COMPONENT[c.key], status: 'all', title: c.label })} />)}
          <Row strong label="Total paid (cash Returns + commissions)" amount={cashPaidTotal} />
          <Row label="Partner Returns reinvested (compounding, not cash)" count={p.returns_reinvested.count} amount={p.returns_reinvested.amount}
               note={`${p.returns_reinvested.portfolios.toLocaleString()} portfolios · shown separately, never added to cash`}
               onView={() => onDrill({ component: 'returns_reinvested', status: 'all', title: 'Partner Returns reinvested' })} />
          {lead && <Row label={`${lead.label}`} count={lead.paid.count} amount={lead.paid.amount} note={lead.rule}
               onView={() => onDrill({ component: 'lead_override', status: 'all', title: lead.label })} />}
          {histComm.map((c) => <Row key={c.key} label={c.label} count={c.paid.count} amount={c.paid.amount} note={c.rule}
               onView={() => onDrill({ component: COMMISSION_COMPONENT[c.key], status: 'all', title: c.label })} />)}
        </tbody></table>
      </div>

      <div>
        <h3 className="text-xs font-semibold mb-1">Outstanding (as at now)</h3>
        <table className="w-full text-xs">{head}<tbody>
          <Row label="Partner Returns — overdue" count={o.returns.by_status.overdue.count} amount={o.returns.by_status.overdue.amount}
               onView={() => onDrill({ component: 'returns_outstanding', status: 'overdue', title: 'Partner Returns overdue' })} />
          <Row label={`Partner Returns — due by ${d.period.outstanding_due_to}`} count={o.returns.by_status.due_in_period.count} amount={o.returns.by_status.due_in_period.amount}
               onView={() => onDrill({ component: 'returns_outstanding', status: 'due_in_period', title: 'Partner Returns due in period' })} />
          <Row label="Partner Returns — due later" count={o.returns.by_status.later.count} amount={o.returns.by_status.later.amount}
               onView={() => onDrill({ component: 'returns_outstanding', status: 'later', title: 'Partner Returns due later' })} />
          <Row label="Commissions confirmed unpaid" count={o.commissions_unpaid.count} amount={o.commissions_unpaid.amount}
               note="Commissions are credited to wallets when earned; only a failed or stalled credit appears here"
               onView={() => onDrill({ component: 'commissions_unpaid', status: 'all', title: 'Commissions confirmed unpaid' })} />
          <Row strong label="Total outstanding" amount={outstandingTotal} />
          <Row label="of which Returns paid as cash" count={o.returns.by_mode.cash_payout.count} amount={o.returns.by_mode.cash_payout.amount}
               onView={() => onDrill({ component: 'returns_outstanding', status: 'cash_payout', title: 'Outstanding Returns paid as cash' })} />
          <Row label="of which Returns reinvested (compounding)" count={o.returns.by_mode.compounding.count} amount={o.returns.by_mode.compounding.amount}
               onView={() => onDrill({ component: 'returns_outstanding', status: 'compounding', title: 'Outstanding compounding Returns' })} />
        </tbody></table>

        <h3 className="text-xs font-semibold mt-3 mb-1">Pending — not owed until confirmed (in no total)</h3>
        <ul className="text-xs space-y-1">
          {o.pending_not_owed.map((i) => <li key={i.key}><span className="font-medium">{i.label}</span>{i.status && <span className="text-muted-foreground"> — {i.status}</span>}</li>)}
        </ul>

        <p className={`mt-3 text-[10px] ${r.ties_out && r.commission_unpaid_matches_report ? 'text-success' : 'text-destructive'}`} role="status">
          {r.ties_out && r.commission_unpaid_matches_report
            ? `Reconciled: outstanding Returns + unpaid commissions = Partner payables total ${formatUGX(r.partner_payables_total)}.`
            : `Does not reconcile: Partner payables total ${formatUGX(r.partner_payables_total)} vs components ${formatUGX(r.returns_plus_unpaid_commissions)}. No figure has been adjusted.`}
          {r.possible_double_return_credits.pairs > 0 && ` Flag: ${r.possible_double_return_credits.pairs} possible double Return credit(s) in the period (second credits ${formatUGX(r.possible_double_return_credits.second_credit_amount)}) — for review, included as recorded.`}
        </p>
      </div>
    </div>
  );
}

const COLUMNS: Record<string, string[]> = {
  returns_cash: ['date', 'partner', 'portfolio', 'paid_to', 'amount', 'status'],
  returns_reinvested: ['date', 'partner', 'portfolio', 'amount', 'status'],
  returns_outstanding: ['due_date', 'partner', 'portfolio', 'mode', 'amount', 'status'],
  registration_bonus: ['date', 'paid_to', 'note_partner', 'amount', 'status'],
  lead_override: ['date', 'paid_to', 'note_partner', 'amount', 'status'],
  fulfilment_commission: ['date', 'paid_to', 'partner', 'base_amount', 'rate', 'amount'],
  topup_commission: ['date', 'paid_to', 'partner', 'base_amount', 'rate', 'amount'],
  recalculation_topup: ['date', 'paid_to', 'amount'],
  commissions_unpaid: ['due_date', 'label', 'payee', 'amount', 'status'],
};
const HEADINGS: Record<string, string> = {
  date: 'Date', due_date: 'Due', partner: 'Partner', portfolio: 'Portfolio', paid_to: 'Paid to', amount: 'UGX', status: 'Status',
  mode: 'Mode', note_partner: 'Note (partner)', base_amount: 'Base UGX', rate: 'Rate', label: 'Component', payee: 'Payee',
};
function cell(key: string, v: unknown) {
  if (v === null || v === undefined || v === '') return '—';
  if (key === 'amount' || key === 'base_amount') return formatUGX(Number(v));
  if (key === 'rate') return `${(Number(v) * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
  if (key === 'date') return String(v).slice(0, 10);
  return String(v);
}

function Records({ drill, from, to, onClose }: { drill: Drill; from: string | null; to: string | null; onClose: () => void }) {
  const [offset, setOffset] = useState(0);
  const limit = 50;
  const q = usePartnerPaidOutstandingItems(drill.component, drill.status, from, to, offset, limit);
  const cols = COLUMNS[drill.component];
  const total = q.data?.total_count ?? 0;
  return (
    <div className="border-t border-border pt-3">
      <div className="flex items-center gap-2 mb-2">
        <h3 className="text-xs font-semibold mr-auto">{drill.title} — {total.toLocaleString()} record(s)</h3>
        <Button variant="outline" size="sm" disabled={offset === 0 || q.isFetching} onClick={() => setOffset(Math.max(0, offset - limit))}>Previous</Button>
        <Button variant="outline" size="sm" disabled={offset + limit >= total || q.isFetching} onClick={() => setOffset(offset + limit)}>Next</Button>
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
      {q.isLoading && <p className="text-xs text-muted-foreground">Loading records…</p>}
      {q.isError && <p role="alert" className="text-xs text-destructive">Could not load the records.</p>}
      {q.data && (q.data.items.length === 0 ? <p className="text-xs text-muted-foreground">No records.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-[10px] text-muted-foreground">{cols.map((c) => <th key={c} className="text-left font-normal pr-2">{HEADINGS[c]}</th>)}</tr></thead>
            <tbody>{q.data.items.map((it, i) => (
              <tr key={String(it.ledger_id ?? it.event_id ?? it.item_id ?? i)} className="border-t border-border/50">
                {cols.map((c) => <td key={c} className="py-1 pr-2 tabular-nums">{cell(c, it[c] ?? (c === 'date' ? it.due_date : undefined))}</td>)}
              </tr>
            ))}</tbody>
          </table>
          <p className="mt-1 text-[10px] text-muted-foreground">Showing {offset + 1}–{offset + q.data.items.length} of {total.toLocaleString()}.</p>
        </div>
      ))}
    </div>
  );
}
