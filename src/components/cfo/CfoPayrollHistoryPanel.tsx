/**
 * CFO — Payroll history and salary-advance status. Read-only.
 *
 * Data comes only from two SECURITY DEFINER functions gated to the enabled cfo role
 * (CFO and Deputy CFO) and super_admin. Special-advance rows also require
 * special_advance_cfo_ok():
 *   - cfo_payroll_history()  one row per pay run, totals from current payslips
 *   - cfo_advance_status()   one row per advance across salary advances, staff
 *                            loans and special advances, with repayment history
 * "Recovered" counts recoveries on runs that are approved, paid or locked — the
 * same rule as hr_pay_advance_recovered_totals(). No write of any kind happens here.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Download, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface RunRow {
  run_id: string;
  period_code: string;
  period_month: string;
  run_type: string;
  status: string;
  staff_count: number;
  total_gross: number;
  total_paye: number;
  total_nssf_employee: number;
  total_nssf_employer: number;
  total_lst: number;
  total_reinvest: number;
  total_advance_recovered: number;
  total_net: number;
  total_employer_cost: number;
  paid_count: number;
  paid_amount: number;
  prepared_by_name: string | null;
  prepared_at: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  paid_at: string | null;
  locked_at: string | null;
}

interface HistoryItem {
  label: string;
  amount: number;
  note: string | null;
}

interface AdvanceRow {
  source: 'salary_advance' | 'staff_loan' | 'special_advance';
  source_label: string;
  record_id: string;
  reference: string | null;
  borrower_name: string | null;
  staff_ref: string | null;
  purpose: string | null;
  principal: number;
  total_repayable: number | null;
  status: string;
  state: string;
  is_closed: boolean;
  requested_at: string | null;
  approved_at: string | null;
  disbursed_at: string | null;
  plan: string | null;
  recovered: number | null;
  balance: number | null;
  repayment_tracked: boolean;
  history: HistoryItem[] | null;
}

const ugx = (v: number | null | undefined) =>
  `UGX ${Math.round(Number(v ?? 0)).toLocaleString('en-US')}`;
const num = (v: number | null | undefined) => Math.round(Number(v ?? 0)).toLocaleString('en-US');
const day = (v: string | null) =>
  v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const monthLabel = (v: string) =>
  new Date(v).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

const RUN_STATUS_CLASS: Record<string, string> = {
  locked: 'bg-slate-700 text-slate-50',
  paid: 'bg-emerald-100 text-emerald-700',
  approved: 'bg-emerald-100 text-emerald-700',
  in_review: 'bg-amber-100 text-amber-800',
  calculated: 'bg-blue-100 text-blue-700',
  returned: 'bg-destructive/15 text-destructive',
  draft: 'bg-muted text-muted-foreground',
  cancelled: 'bg-muted text-muted-foreground line-through',
};

const STATE_CLASS: Record<string, string> = {
  Recovering: 'bg-amber-100 text-amber-800',
  Repaid: 'bg-emerald-100 text-emerald-700',
  Cancelled: 'bg-muted text-muted-foreground',
  'Awaiting approval': 'bg-blue-100 text-blue-700',
  'Approved — not yet disbursed': 'bg-blue-100 text-blue-700',
  'Disbursed — repayment not tracked': 'bg-amber-100 text-amber-800',
  Rejected: 'bg-muted text-muted-foreground',
  Reversed: 'bg-muted text-muted-foreground',
  'Written off': 'bg-destructive/15 text-destructive',
  'Returned to requester': 'bg-muted text-muted-foreground',
};

const SOURCES: { key: 'all' | AdvanceRow['source']; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'salary_advance', label: 'Salary advances' },
  { key: 'staff_loan', label: 'Staff loans' },
  { key: 'special_advance', label: 'Special advances' },
];

function Pill({ text, cls }: { text: string; cls?: string }) {
  return (
    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${cls ?? 'bg-muted text-muted-foreground'}`}>
      {text}
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[11px] uppercase text-muted-foreground">{label}</p>
      <p className={`text-base font-semibold ${tone ?? ''}`}>{value}</p>
    </div>
  );
}

function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]) {
  const esc = (v: string | number | null) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function PayrollHistory() {
  const [rows, setRows] = useState<RunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCancelled, setShowCancelled] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error: err } = await (supabase.rpc as any)('cfo_payroll_history');
      if (!alive) return;
      if (err) setError(err.message);
      else setRows((data ?? []) as RunRow[]);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const visible = useMemo(
    () => rows.filter((r) => showCancelled || r.status !== 'cancelled'),
    [rows, showCancelled],
  );
  const counted = useMemo(() => rows.filter((r) => r.status !== 'cancelled'), [rows]);
  const totals = useMemo(
    () =>
      counted.reduce(
        (a, r) => ({
          gross: a.gross + Number(r.total_gross),
          paye: a.paye + Number(r.total_paye),
          nssf: a.nssf + Number(r.total_nssf_employee) + Number(r.total_nssf_employer),
          net: a.net + Number(r.total_net),
          paid: a.paid + Number(r.paid_amount),
          reinvest: a.reinvest + Number(r.total_reinvest),
        }),
        { gross: 0, paye: 0, nssf: 0, net: 0, paid: 0, reinvest: 0 },
      ),
    [counted],
  );
  const cancelledCount = rows.length - counted.length;

  const exportCsv = () =>
    downloadCsv(
      'payroll-history.csv',
      ['Period', 'Type', 'Status', 'Staff', 'Gross', 'PAYE', 'NSSF 5%', 'NSSF 10%', 'LST', 'Reinvested',
        'Advance recovered', 'Net', 'Employer cost', 'Paid count', 'Paid amount', 'Prepared by',
        'Approved by', 'Approved', 'Paid', 'Locked'],
      visible.map((r) => [
        r.period_code, r.run_type, r.status, r.staff_count, r.total_gross, r.total_paye,
        r.total_nssf_employee, r.total_nssf_employer, r.total_lst, r.total_reinvest,
        r.total_advance_recovered, r.total_net, r.total_employer_cost, r.paid_count, r.paid_amount,
        r.prepared_by_name, r.approved_by_name, day(r.approved_at), day(r.paid_at), day(r.locked_at),
      ]),
    );

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Payroll history</CardTitle>
            <p className="text-xs text-muted-foreground">
              Every pay run, newest first. Totals exclude cancelled runs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {cancelledCount > 0 && (
              <Button size="sm" variant="outline" onClick={() => setShowCancelled((v) => !v)}>
                {showCancelled ? 'Hide' : 'Show'} cancelled ({cancelledCount})
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={!visible.length} onClick={exportCsv}>
              <Download className="mr-1 h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </div>
        {!loading && !error && counted.length > 0 && (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Gross" value={ugx(totals.gross)} />
            <Stat label="PAYE" value={ugx(totals.paye)} />
            <Stat label="NSSF (5% + 10%)" value={ugx(totals.nssf)} />
            <Stat label="Reinvested" value={ugx(totals.reinvest)} />
            <Stat label="Net" value={ugx(totals.net)} />
            <Stat
              label="Disbursed"
              value={ugx(totals.paid)}
              tone={totals.paid < totals.net ? 'text-amber-700' : 'text-emerald-700'}
            />
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading payroll history…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">{error}</p>
        )}
        {!loading && !error && visible.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No pay runs yet.</p>
        )}
        {!loading && !error && visible.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Staff</TableHead>
                  <TableHead className="text-right">Gross</TableHead>
                  <TableHead className="text-right">PAYE</TableHead>
                  <TableHead className="text-right">NSSF</TableHead>
                  <TableHead className="text-right">Reinvested</TableHead>
                  <TableHead className="text-right">Advance recovered</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Disbursed</TableHead>
                  <TableHead>Approved</TableHead>
                  <TableHead>Locked</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => {
                  const short = r.status !== 'cancelled' && Number(r.paid_amount) < Number(r.total_net);
                  return (
                    <TableRow key={r.run_id} className={r.status === 'cancelled' ? 'opacity-60' : undefined}>
                      <TableCell>
                        <p className="font-medium">{monthLabel(r.period_month)}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {r.run_type === 'regular' ? 'Monthly run' : r.run_type.replace('_', '-')} ·{' '}
                          <span className="font-mono">{r.run_id.slice(0, 8)}</span>
                        </p>
                      </TableCell>
                      <TableCell><Pill text={r.status} cls={RUN_STATUS_CLASS[r.status]} /></TableCell>
                      <TableCell className="text-right">{r.staff_count}</TableCell>
                      <TableCell className="text-right">{num(r.total_gross)}</TableCell>
                      <TableCell className="text-right">{num(r.total_paye)}</TableCell>
                      <TableCell className="text-right">
                        {num(Number(r.total_nssf_employee) + Number(r.total_nssf_employer))}
                      </TableCell>
                      <TableCell className="text-right">{num(r.total_reinvest)}</TableCell>
                      <TableCell className="text-right">{num(r.total_advance_recovered)}</TableCell>
                      <TableCell className="text-right font-semibold">{num(r.total_net)}</TableCell>
                      <TableCell className={`text-right ${short ? 'font-semibold text-amber-700' : ''}`}>
                        {num(r.paid_amount)}
                        <span className="block text-[11px] text-muted-foreground">
                          {r.paid_count} of {r.staff_count}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs">
                        {day(r.approved_at)}
                        {r.approved_by_name && (
                          <span className="block text-[11px] text-muted-foreground">{r.approved_by_name}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs">{day(r.locked_at)}</TableCell>
                      <TableCell>
                        <Button asChild size="sm" variant="outline">
                          <Link to={`/hr/pay/runs/${r.run_id}`}>Open</Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AdvanceStatus() {
  const [rows, setRows] = useState<AdvanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [source, setSource] = useState<(typeof SOURCES)[number]['key']>('all');
  const [openOnly, setOpenOnly] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const { data, error: err } = await (supabase.rpc as any)('cfo_advance_status');
      if (!alive) return;
      if (err) setError(err.message);
      else setRows((data ?? []) as AdvanceRow[]);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const visible = useMemo(
    () => rows.filter((r) => (source === 'all' || r.source === source) && (!openOnly || !r.is_closed)),
    [rows, source, openOnly],
  );
  const summary = useMemo(() => {
    const tracked = rows.filter((r) => r.repayment_tracked && !r.is_closed);
    const untracked = rows.filter((r) => !r.repayment_tracked && r.state.startsWith('Disbursed'));
    return {
      outstanding: tracked.reduce((s, r) => s + Number(r.balance ?? 0), 0),
      recovered: rows.reduce((s, r) => s + Number(r.recovered ?? 0), 0),
      open: rows.filter((r) => !r.is_closed).length,
      closed: rows.filter((r) => r.is_closed).length,
      untrackedCount: untracked.length,
      untrackedAmount: untracked.reduce((s, r) => s + Number(r.principal), 0),
    };
  }, [rows]);
  const countFor = (k: (typeof SOURCES)[number]['key']) =>
    k === 'all' ? rows.length : rows.filter((r) => r.source === k).length;

  const exportCsv = () =>
    downloadCsv(
      'advances.csv',
      ['Type', 'Reference', 'Borrower', 'Staff ref', 'Purpose', 'Principal', 'Total repayable', 'State',
        'Requested', 'Approved', 'Disbursed', 'Plan', 'Recovered', 'Balance'],
      visible.map((r) => [
        r.source_label, r.reference, r.borrower_name, r.staff_ref, r.purpose, r.principal, r.total_repayable,
        r.state, day(r.requested_at), day(r.approved_at), day(r.disbursed_at), r.plan,
        r.repayment_tracked ? r.recovered : 'not tracked', r.repayment_tracked ? r.balance : 'not tracked',
      ]),
    );

  return (
    <Card>
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">Advances</CardTitle>
            <p className="text-xs text-muted-foreground">
              Salary advances, staff loans and special advances — open and closed, newest first.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setOpenOnly((v) => !v)}>
              {openOnly ? 'Show history too' : 'Open only'}
            </Button>
            <Button size="sm" variant="outline" disabled={!visible.length} onClick={exportCsv}>
              <Download className="mr-1 h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </div>
        {!loading && !error && rows.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="Outstanding (tracked)" value={ugx(summary.outstanding)} tone={summary.outstanding > 0 ? 'text-amber-700' : 'text-emerald-700'} />
              <Stat label="Recovered so far" value={ugx(summary.recovered)} />
              <Stat label="Open" value={String(summary.open)} />
              <Stat label="Closed (history)" value={String(summary.closed)} />
            </div>
            {summary.untrackedCount > 0 && (
              <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {summary.untrackedCount} staff loan{summary.untrackedCount === 1 ? '' : 's'} ({ugx(summary.untrackedAmount)})
                {' '}disbursed with no repayment recorded in the system — not included in Outstanding.
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {SOURCES.map((s) => (
                <Button
                  key={s.key}
                  size="sm"
                  variant={source === s.key ? 'default' : 'outline'}
                  onClick={() => setSource(s.key)}
                >
                  {s.label} ({countFor(s.key)})
                </Button>
              ))}
            </div>
          </>
        )}
      </CardHeader>
      <CardContent>
        {loading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading advances…
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">{error}</p>
        )}
        {!loading && !error && visible.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No advances to show.</p>
        )}
        {!loading && !error && visible.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Borrower</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead className="text-right">Principal</TableHead>
                  <TableHead className="text-right">Recovered</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="min-w-[120px]">Progress</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Requested</TableHead>
                  <TableHead>Disbursed</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => {
                  const due = Number(r.total_repayable ?? r.principal);
                  const pct = r.repayment_tracked && due > 0
                    ? Math.min(100, Math.round((Number(r.recovered ?? 0) / due) * 100))
                    : null;
                  const items = r.history ?? [];
                  const key = `${r.source}-${r.record_id}`;
                  const isOpen = open === key;
                  return (
                    <Fragment key={key}>
                      <TableRow className={r.is_closed ? 'opacity-60' : undefined}>
                        <TableCell>
                          <p className="font-medium">{r.borrower_name ?? '—'}</p>
                          <p className="text-[11px] text-muted-foreground">
                            <span className="font-mono">{r.staff_ref ?? r.reference ?? '—'}</span>
                            {r.purpose ? ` · ${r.purpose}` : ''}
                          </p>
                        </TableCell>
                        <TableCell className="text-xs">{r.source_label}</TableCell>
                        <TableCell><Pill text={r.state} cls={STATE_CLASS[r.state]} /></TableCell>
                        <TableCell className="text-right">{num(r.principal)}</TableCell>
                        <TableCell className="text-right">{r.repayment_tracked ? num(r.recovered) : '—'}</TableCell>
                        <TableCell className="text-right font-semibold">{r.repayment_tracked ? num(r.balance) : '—'}</TableCell>
                        <TableCell>
                          {pct === null ? (
                            <span className="text-[11px] text-muted-foreground">Not tracked</span>
                          ) : (
                            <>
                              <div className="h-2 w-full rounded-full bg-muted">
                                <div className="h-2 rounded-full bg-emerald-500" style={{ width: `${pct}%` }} />
                              </div>
                              <span className="text-[11px] text-muted-foreground">{pct}%</span>
                            </>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{r.plan ?? '—'}</TableCell>
                        <TableCell className="text-xs">{day(r.requested_at)}</TableCell>
                        <TableCell className="text-xs">{day(r.disbursed_at)}</TableCell>
                        <TableCell>
                          {items.length > 0 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={isOpen ? 'Hide repayments' : 'Show repayments'}
                              onClick={() => setOpen(isOpen ? null : key)}
                            >
                              {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={11} className="bg-muted/30">
                            <p className="mb-1 text-xs font-semibold">Repayment history</p>
                            <div className="flex flex-wrap gap-2">
                              {items.map((it, i) => (
                                <span
                                  key={`${key}-${i}`}
                                  className="rounded-md border border-border bg-card px-2 py-1 text-xs"
                                >
                                  {it.label} · {num(it.amount)}
                                  {it.note && <span className="ml-1 text-muted-foreground">({it.note})</span>}
                                </span>
                              ))}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CfoPayrollHistoryPanel() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Payroll History &amp; Advances</h1>
        <p className="text-sm text-muted-foreground">
          Read-only. Every payroll run with its deductions and disbursement, and every advance —
          salary advances, staff loans and special advances — with what has been recovered and what is still owed.
        </p>
      </div>
      <PayrollHistory />
      <AdvanceStatus />
    </div>
  );
}
