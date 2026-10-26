import { useState, useEffect } from 'react';
import {
  ArrowRight, Banknote, CalendarDays, Clock3, Gift, Layers, Minus,
  Repeat2, TrendingUp, UserRound, AlertCircle, CheckCircle2, ChevronRight,
  Filter, Calendar, X, AlertTriangle, type LucideIcon
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import {
  usePartnerPaidOutstanding, usePartnerPaidOutstandingItems,
  type PartnerItemsComponent, type PartnerPaidOutstanding,
} from '@/hooks/usePartnerPaidOutstanding';

/**
 * Partner Products and Services — Paid & Outstanding.
 * Clean, executive CFO presentation; existing report sources and drill-downs stay unchanged.
 * All figures come from get_partner_paid_outstanding / get_partner_paid_outstanding_items;
 * nothing is computed client-side except adding server's own paid totals for the summary line.
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
    <section aria-label="Paid and outstanding" className="space-y-6 min-w-0">
      {/* Filter and Period Selection Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card p-4 shadow-sm">
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-foreground">Partner Products and Services</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Authoritative settlement audit and outstanding obligations schedule</p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground flex items-center gap-1">
              <span>From</span>
              <Input
                type="date"
                aria-label="From date"
                value={from}
                disabled={allTime}
                onChange={(e) => { setFrom(e.target.value); setDrill(null); }}
                className="h-8 w-36 rounded-md bg-muted/40 border-border/70 text-xs"
              />
            </label>
          </div>

          <div className="flex items-center gap-1.5">
            <label className="text-xs text-muted-foreground flex items-center gap-1">
              <span>To</span>
              <Input
                type="date"
                aria-label="To date"
                value={to}
                disabled={allTime}
                onChange={(e) => { setTo(e.target.value); setDrill(null); }}
                className="h-8 w-36 rounded-md bg-muted/40 border-border/70 text-xs"
              />
            </label>
          </div>

          <Button
            variant={allTime ? 'default' : 'outline'}
            size="sm"
            className="h-8 text-xs font-medium"
            onClick={() => { setAllTime((v) => !v); setDrill(null); }}
          >
            All time
          </Button>
        </div>
      </div>

      {rangeInvalid && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive flex items-center gap-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>The From date is after the To date.</span>
        </div>
      )}

      {q.isLoading && (
        <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
          Loading paid and outstanding amounts…
        </div>
      )}

      {q.isError && (
        <div role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-xs text-destructive text-center">
          Could not load paid and outstanding amounts. Please refresh.
        </div>
      )}

      {d && <Summary d={d} onDrill={setDrill} />}

      {drill && (
        <Records
          key={`${drill.component}|${drill.status}|${pFrom}|${pTo}`}
          drill={drill}
          from={pFrom}
          to={pTo}
          onClose={() => setDrill(null)}
        />
      )}
    </section>
  );
}

function MetricTile({
  label,
  value,
  note,
  extra,
  tag,
  tone = 'primary',
}: {
  label: string;
  value: string;
  note?: string;
  extra?: string;
  tag: string;
  tone?: 'primary' | 'success' | 'destructive' | 'warning' | 'info' | 'muted';
}) {
  const tagTones = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    destructive: 'bg-destructive/10 text-destructive',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-primary/10 text-primary',
    muted: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm hover:border-border/80 transition-colors">
      <div className="flex items-center justify-between gap-1.5">
        <span className="text-xs font-medium text-muted-foreground truncate">{label}</span>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${tagTones[tone]}`}>
          {tag}
        </span>
      </div>

      <div className="mt-2.5">
        <div className="text-xl font-bold tracking-tight text-foreground tabular-nums truncate" title={value}>
          {value}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 pt-2 border-t border-border/50 text-xs">
        <span className="text-[11px] text-muted-foreground truncate">{note || 'Recorded in journal'}</span>
        {extra && (
          <span className="text-[11px] font-semibold text-foreground tabular-nums whitespace-nowrap">
            {extra}
          </span>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  count,
  amount,
  note,
  onView,
  strong,
  icon: Icon = Banknote,
  tone = 'muted',
}: {
  label: string;
  count?: number;
  amount: number;
  note?: string;
  onView?: () => void;
  strong?: boolean;
  icon?: LucideIcon;
  tone?: 'primary' | 'success' | 'destructive' | 'warning' | 'info' | 'muted';
}) {
  const iconTones = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-success/10 text-success',
    destructive: 'bg-destructive/10 text-destructive',
    warning: 'bg-warning/10 text-warning',
    info: 'bg-primary/10 text-primary',
    muted: 'bg-muted text-muted-foreground',
  };

  if (strong) {
    return (
      <tr className="border-t-2 border-border font-bold bg-muted/20 text-foreground">
        <td className="py-3 px-3">
          <span className="font-semibold">{label}</span>
        </td>
        <td className="py-3 px-3 text-right tabular-nums text-muted-foreground">
          {count === undefined ? '' : count.toLocaleString()}
        </td>
        <td className="py-3 px-3 text-right tabular-nums whitespace-nowrap font-bold">
          {formatUGX(amount)}
        </td>
        <td className="py-3 px-3 text-right" />
      </tr>
    );
  }

  return (
    <tr className="hover:bg-muted/30 transition-colors group">
      <td className="py-2.5 px-3">
        <div className={`flex ${note ? 'items-start' : 'items-center'} gap-2.5`}>
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${iconTones[tone]} ${note ? 'mt-0.5' : ''}`}>
            <Icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <span className="font-medium text-foreground">{label}</span>
            {note && (
              <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                {note}
              </span>
            )}
          </div>
        </div>
      </td>
      <td className={`py-2.5 px-3 text-right tabular-nums text-muted-foreground ${note ? 'align-top pt-3' : 'align-middle'}`}>
        {count === undefined ? '—' : count.toLocaleString()}
      </td>
      <td className={`py-2.5 px-3 text-right tabular-nums whitespace-nowrap font-semibold text-foreground ${note ? 'align-top pt-3' : 'align-middle'}`}>
        {formatUGX(amount)}
      </td>
      <td className={`py-2.5 px-3 text-right ${note ? 'align-top pt-2' : 'align-middle'}`}>
        {onView && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs text-primary hover:text-primary hover:bg-primary/10 font-medium"
            onClick={onView}
          >
            View records
          </Button>
        )}
      </td>
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

  const head = (
    <thead className="bg-muted/40 text-muted-foreground font-medium text-[11px]">
      <tr>
        <th className="py-2.5 px-3 text-left font-medium">Component</th>
        <th className="py-2.5 px-3 text-right font-medium">Records</th>
        <th className="py-2.5 px-3 text-right font-medium">Amount (UGX)</th>
        <th className="py-2.5 px-3 text-right font-medium w-28">Action</th>
      </tr>
    </thead>
  );

  return (
    <div className="space-y-6">
      {/* 4 Clean Executive Metric Tiles */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        <MetricTile
          label="Total Paid"
          note="Cash returns + commissions"
          value={formatUGX(cashPaidTotal)}
          tag="Disbursed"
          tone="primary"
        />
        <MetricTile
          label="Total Outstanding Obligations"
          note="Active partner liabilities"
          value={formatUGX(outstandingTotal)}
          tag="Outstanding"
          tone="success"
        />
        <MetricTile
          label="Partner Returns Due Now"
          value={`${o.returns.by_status.overdue.count.toLocaleString()} accounts`}
          extra={formatUGX(o.returns.by_status.overdue.amount)}
          note="Past due date"
          tag="Immediate"
          tone={o.returns.by_status.overdue.amount > 0 ? "destructive" : "muted"}
        />
        <MetricTile
          label={`Returns Due by ${d.period.outstanding_due_to}`}
          value={`${o.returns.by_status.due_in_period.count.toLocaleString()} records`}
          extra={formatUGX(o.returns.by_status.due_in_period.amount)}
          note="Current period schedule"
          tag="Period window"
          tone="warning"
        />
      </div>

      {/* Main 2-Column Ledger Section */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 items-start [&>*]:min-w-0">
        {/* Left Column: Paid Disbursals */}
        <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
          <div className="mb-3.5 flex items-center justify-between border-b border-border/60 pb-2.5">
            <div>
              <h3 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                <Banknote className="h-4 w-4 text-primary" />
                <span>Paid Disbursals</span>
              </h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Paid {d.period.from ? `${d.period.from} to ${d.period.to}` : '(all time)'}
              </p>
            </div>
            <Badge variant="outline" className="text-xs font-normal">
              Cash &amp; Commissions
            </Badge>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              {head}
              <tbody className="divide-y divide-border/50">
                <Row
                  icon={Repeat2}
                  tone="success"
                  label="Partner Returns paid in cash"
                  count={p.returns_cash.count}
                  amount={p.returns_cash.amount}
                  onView={() => onDrill({ component: 'returns_cash', status: 'all', title: 'Partner Returns paid in cash' })}
                />
                {mainComm.map((c) => (
                  <Row
                    key={c.key}
                    icon={c.key === 'registration_bonus' ? Gift : c.key === 'topup_commission' ? Banknote : UserRound}
                    tone={c.key === 'registration_bonus' ? 'info' : c.key === 'topup_commission' ? 'warning' : 'primary'}
                    label={c.label}
                    count={c.paid.count}
                    amount={c.paid.amount}
                    onView={() => onDrill({ component: COMMISSION_COMPONENT[c.key], status: 'all', title: c.label })}
                  />
                ))}
                <Row strong label="Total Paid" amount={cashPaidTotal} />
                <Row
                  icon={Layers}
                  tone="info"
                  label="Partner Returns reinvested (compounding, not cash)"
                  count={p.returns_reinvested.count}
                  amount={p.returns_reinvested.amount}
                  onView={() => onDrill({ component: 'returns_reinvested', status: 'all', title: 'Partner Returns reinvested' })}
                />
                {lead && (
                  <Row
                    label={`${lead.label}`}
                    count={lead.paid.count}
                    amount={lead.paid.amount}
                    onView={() => onDrill({ component: 'lead_override', status: 'all', title: lead.label })}
                  />
                )}
                {histComm.map((c) => (
                  <Row
                    key={c.key}
                    icon={c.key === 'registration_bonus' ? Gift : c.key === 'topup_commission' ? Banknote : UserRound}
                    tone={c.key === 'registration_bonus' ? 'info' : c.key === 'topup_commission' ? 'warning' : 'primary'}
                    label={c.label}
                    count={c.paid.count}
                    amount={c.paid.amount}
                    onView={() => onDrill({ component: COMMISSION_COMPONENT[c.key], status: 'all', title: c.label })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right Column: Outstanding Obligations */}
        <div className="space-y-6">
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
            <div className="mb-3.5 flex items-center justify-between border-b border-border/60 pb-2.5">
              <div>
                <h3 className="text-sm font-semibold tracking-tight text-foreground flex items-center gap-2">
                  <Clock3 className="h-4 w-4 text-warning" />
                  <span>Outstanding (as at now)</span>
                </h3>
              </div>
              <Badge variant="outline" className="text-xs font-normal">
                Liabilities
              </Badge>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                {head}
                <tbody className="divide-y divide-border/50">
                  <Row
                    icon={AlertCircle}
                    tone="destructive"
                    label="Partner Returns — overdue"
                    count={o.returns.by_status.overdue.count}
                    amount={o.returns.by_status.overdue.amount}
                    onView={() => onDrill({ component: 'returns_outstanding', status: 'overdue', title: 'Partner Returns overdue' })}
                  />
                  <Row
                    icon={CalendarDays}
                    tone="warning"
                    label={`Partner Returns — due by ${d.period.outstanding_due_to}`}
                    count={o.returns.by_status.due_in_period.count}
                    amount={o.returns.by_status.due_in_period.amount}
                    onView={() => onDrill({ component: 'returns_outstanding', status: 'due_in_period', title: 'Partner Returns due in period' })}
                  />
                  <Row
                    icon={CalendarDays}
                    tone="info"
                    label="Partner Returns — due later"
                    count={o.returns.by_status.later.count}
                    amount={o.returns.by_status.later.amount}
                    onView={() => onDrill({ component: 'returns_outstanding', status: 'later', title: 'Partner Returns due later' })}
                  />
                  <Row
                    icon={Minus}
                    tone="muted"
                    label="Commissions confirmed unpaid"
                    count={o.commissions_unpaid.count}
                    amount={o.commissions_unpaid.amount}
                    onView={() => onDrill({ component: 'commissions_unpaid', status: 'all', title: 'Commissions confirmed unpaid' })}
                  />
                  <Row strong label="Total outstanding" amount={outstandingTotal} />
                </tbody>
              </table>
            </div>
          </div>

          {/* Breakdown by Type & Pending Verification */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-4">
            <h3 className="text-xs font-semibold tracking-tight text-foreground uppercase tracking-wider text-muted-foreground">
              Settlement Mode Breakdown
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-lg border border-border/70 bg-muted/20 p-3 flex flex-col justify-between">
                <div>
                  <span className="text-[11px] text-muted-foreground font-medium">Returns paid as cash</span>
                  <div className="mt-1 text-sm font-bold tabular-nums text-foreground">
                    {formatUGX(o.returns.by_mode.cash_payout.amount)}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {o.returns.by_mode.cash_payout.count.toLocaleString()} records
                  </div>
                </div>
                <div className="mt-3 pt-2 border-t border-border/50">
                  <Button
                    variant="link"
                    className="h-auto min-h-0 p-0 text-xs text-primary"
                    onClick={() => onDrill({ component: 'returns_outstanding', status: 'cash_payout', title: 'Outstanding Returns paid as cash' })}
                  >
                    View records →
                  </Button>
                </div>
              </div>

              <div className="rounded-lg border border-border/70 bg-muted/20 p-3 flex flex-col justify-between">
                <div>
                  <span className="text-[11px] text-muted-foreground font-medium">Returns reinvested (compounding)</span>
                  <div className="mt-1 text-sm font-bold tabular-nums text-foreground">
                    {formatUGX(o.returns.by_mode.compounding.amount)}
                  </div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">
                    {o.returns.by_mode.compounding.count.toLocaleString()} records
                  </div>
                </div>
                <div className="mt-3 pt-2 border-t border-border/50">
                  <Button
                    variant="link"
                    className="h-auto min-h-0 p-0 text-xs text-primary"
                    onClick={() => onDrill({ component: 'returns_outstanding', status: 'compounding', title: 'Outstanding compounding Returns' })}
                  >
                    View records →
                  </Button>
                </div>
              </div>
            </div>

            {/* Pending Deposits */}
            {o.pending_not_owed.length > 0 && (
              <div className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-warning">
                <div className="flex items-center gap-1.5 text-xs font-semibold mb-1">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span>Pending — not owed until confirmed (in no total)</span>
                </div>
                <ul className="text-xs space-y-1 pl-5 list-disc text-foreground">
                  {o.pending_not_owed.map((i) => (
                    <li key={i.key}>
                      <span className="font-medium">{i.label}</span>
                      {i.status && <span className="text-muted-foreground"> — {i.status}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Reconciliation status */}
            <div
              className={`rounded-lg p-3 text-xs flex items-start gap-2 border ${
                r.ties_out && r.commission_unpaid_matches_report
                  ? 'border-success/30 bg-success/5 text-success'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              }`}
              role="status"
            >
              {r.ties_out && r.commission_unpaid_matches_report ? (
                <CheckCircle2 className="h-4 w-4 shrink-0 text-success mt-0.5" />
              ) : (
                <AlertTriangle className="h-4 w-4 shrink-0 text-destructive mt-0.5" />
              )}
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {r.ties_out && r.commission_unpaid_matches_report
                    ? `Reconciled: outstanding Returns + unpaid commissions = Partner payables total ${formatUGX(r.partner_payables_total)}.`
                    : `Does not reconcile: Partner payables total ${formatUGX(r.partner_payables_total)} vs components ${formatUGX(r.returns_plus_unpaid_commissions)}. No figure has been adjusted.`}
                </p>
                {r.possible_double_return_credits.pairs > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Flag: {r.possible_double_return_credits.pairs} possible double Return credit(s) in the period (second credits {formatUGX(r.possible_double_return_credits.second_credit_amount)}) — for review, included as recorded.
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={drill.title}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4 sm:p-6 animate-in fade-in-0 duration-200"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-4xl max-h-[85vh] rounded-2xl border border-border bg-card shadow-2xl overflow-hidden flex flex-col animate-in zoom-in-95 duration-150">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 p-4 sm:px-6 sm:py-3.5 bg-muted/20">
          <div>
            <h3 className="text-sm font-semibold tracking-tight text-foreground">
              {drill.title} — {total.toLocaleString()} record(s)
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">Authoritative journal records drilldown</p>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs font-medium"
              disabled={offset === 0 || q.isFetching}
              onClick={() => setOffset(Math.max(0, offset - limit))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-8 text-xs font-medium"
              disabled={offset + limit >= total || q.isFetching}
              onClick={() => setOffset(offset + limit)}
            >
              Next
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              <X className="h-3.5 w-3.5 mr-1" />
              Close
            </Button>
          </div>
        </div>

        <div className="overflow-auto flex-1 min-h-0 p-4 sm:p-6">
          {q.isLoading && (
            <div className="py-16 text-center text-xs text-muted-foreground">
              Loading records…
            </div>
          )}

          {q.isError && (
            <div role="alert" className="py-8 text-center text-xs text-destructive">
              Could not load the records.
            </div>
          )}

          {q.data && (q.data.items.length === 0 ? (
            <p className="py-16 text-center text-xs text-muted-foreground">No records found for this component.</p>
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/50 text-muted-foreground sticky top-0 z-10 font-medium text-[11px] border-b border-border">
                  <tr>
                    {cols.map((c) => (
                      <th key={c} className="py-2.5 px-3 text-left font-medium">
                        {HEADINGS[c]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/50">
                  {q.data.items.map((it, i) => (
                    <tr key={String(it.ledger_id ?? it.event_id ?? it.item_id ?? i)} className="hover:bg-muted/30 transition-colors">
                      {cols.map((c) => (
                        <td key={c} className="py-2 px-3 tabular-nums text-foreground">
                          {cell(c, it[c] ?? (c === 'date' ? it.due_date : undefined))}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>

        {q.data && q.data.items.length > 0 && (
          <div className="border-t border-border/60 bg-muted/20 px-4 py-2.5 sm:px-6 flex items-center justify-between text-xs text-muted-foreground">
            <span>Showing {offset + 1}–{offset + q.data.items.length} of {total.toLocaleString()}.</span>
            <span>Page {Math.floor(offset / limit) + 1} of {Math.ceil(total / limit) || 1}</span>
          </div>
        )}
      </div>
    </div>
  );
}
