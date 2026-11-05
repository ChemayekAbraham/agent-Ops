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
import {
  AlertCircle,
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Coins,
  Download,
  FileSpreadsheet,
  FileText,
  Filter,
  HandCoins,
  History,
  Info,
  Landmark,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingUp,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Progress } from '@/components/ui/progress';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * cfo_payroll_history() and cfo_advance_status() are not in the generated
 * Supabase types yet, so the calls go through this cast rather than `any` —
 * the same shape the desk pages use. Both take no arguments.
 */
type RpcFn = (fn: string) => Promise<{ data: unknown; error: { message: string } | null }>;
const rpc = supabase.rpc.bind(supabase) as unknown as RpcFn;

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

const getInitials = (name: string | null | undefined): string => {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return name.slice(0, 2).toUpperCase();
};

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

function readableRpcError(message: string | null | undefined): string {
  if (message && /not\s+authori[sz]ed/i.test(message)) {
    return 'You need the CFO role to see payroll history.';
  }
  return 'Could not load this. Refresh the page, and tell the CFO office if it keeps failing.';
}

function RunStatusBadge({ status }: { status: string }) {
  switch (status.toLowerCase()) {
    case 'locked':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/30 bg-slate-800 px-2.5 py-0.5 text-xs font-semibold text-slate-100 shadow-sm">
          <Lock className="h-3 w-3 text-slate-300" />
          Locked
        </span>
      );
    case 'paid':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
          Paid
        </span>
      );
    case 'approved':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/20 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300">
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
          Approved
        </span>
      );
    case 'in_review':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <Clock className="h-3 w-3 text-amber-600" />
          In Review
        </span>
      );
    case 'calculated':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
          Calculated
        </span>
      );
    case 'returned':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold text-destructive">
          <AlertCircle className="h-3 w-3" />
          Returned
        </span>
      );
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-muted-foreground/20 bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground line-through">
          Cancelled
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground capitalize">
          {status.replace(/_/g, ' ')}
        </span>
      );
  }
}

function AdvanceStateBadge({ state }: { state: string }) {
  switch (state) {
    case 'Recovering':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse" />
          Recovering
        </span>
      );
    case 'Repaid':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <CheckCircle2 className="h-3 w-3 text-emerald-600" />
          Repaid
        </span>
      );
    case 'Awaiting approval':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/30 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
          <Clock className="h-3 w-3 text-blue-600" />
          Awaiting Approval
        </span>
      );
    case 'Approved — not yet disbursed':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-50 px-2.5 py-0.5 text-xs font-semibold text-sky-800 dark:bg-sky-950/40 dark:text-sky-300">
          Ready to Disburse
        </span>
      );
    case 'Disbursed — repayment not tracked':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <AlertTriangle className="h-3 w-3 text-amber-600" />
          Untracked
        </span>
      );
    case 'Written off':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/30 bg-destructive/10 px-2.5 py-0.5 text-xs font-semibold text-destructive">
          Written Off
        </span>
      );
    case 'Cancelled':
    case 'Rejected':
    case 'Reversed':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-muted-foreground/20 bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          {state}
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
          {state}
        </span>
      );
  }
}

function SourceBadge({ source, label }: { source: AdvanceRow['source']; label: string }) {
  let color = 'bg-muted text-muted-foreground border-border';
  if (source === 'salary_advance') {
    color = 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800';
  } else if (source === 'staff_loan') {
    color = 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-800';
  } else if (source === 'special_advance') {
    color = 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800';
  }
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-semibold ${color}`}>
      {label}
    </span>
  );
}

const SOURCES: { key: 'all' | AdvanceRow['source']; label: string }[] = [
  { key: 'all', label: 'All Sources' },
  { key: 'salary_advance', label: 'Salary Advances' },
  { key: 'staff_loan', label: 'Staff Loans' },
  { key: 'special_advance', label: 'Special Advances' },
];

/* -------------------------------------------------------------------------- */
/* Payroll History Sub-Panel                                                  */
/* -------------------------------------------------------------------------- */

interface PayrollHistoryProps {
  rows: RunRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function PayrollHistory({ rows, loading, error, onRefresh }: PayrollHistoryProps) {
  const [showCancelled, setShowCancelled] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const counted = useMemo(() => rows.filter((r) => r.status !== 'cancelled'), [rows]);
  const cancelledCount = rows.length - counted.length;

  const totals = useMemo(
    () =>
      counted.reduce(
        (a, r) => ({
          gross: a.gross + Number(r.total_gross),
          paye: a.paye + Number(r.total_paye),
          nssfEmployee: a.nssfEmployee + Number(r.total_nssf_employee),
          nssfEmployer: a.nssfEmployer + Number(r.total_nssf_employer),
          lst: a.lst + Number(r.total_lst),
          reinvest: a.reinvest + Number(r.total_reinvest),
          advanceRecovered: a.advanceRecovered + Number(r.total_advance_recovered),
          net: a.net + Number(r.total_net),
          paid: a.paid + Number(r.paid_amount),
          staffTotal: a.staffTotal + Number(r.staff_count),
        }),
        {
          gross: 0,
          paye: 0,
          nssfEmployee: 0,
          nssfEmployer: 0,
          lst: 0,
          reinvest: 0,
          advanceRecovered: 0,
          net: 0,
          paid: 0,
          staffTotal: 0,
        },
      ),
    [counted],
  );

  const filteredRuns = useMemo(() => {
    return rows.filter((r) => {
      if (!showCancelled && r.status === 'cancelled') return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const month = monthLabel(r.period_month).toLowerCase();
        const code = (r.period_code ?? '').toLowerCase();
        const runId = r.run_id.toLowerCase();
        const prep = (r.prepared_by_name ?? '').toLowerCase();
        const app = (r.approved_by_name ?? '').toLowerCase();
        if (
          !month.includes(q) &&
          !code.includes(q) &&
          !runId.includes(q) &&
          !prep.includes(q) &&
          !app.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [rows, showCancelled, statusFilter, searchTerm]);

  const exportCsv = () =>
    downloadCsv(
      'cfo-payroll-history.csv',
      [
        'Period',
        'Type',
        'Status',
        'Staff',
        'Gross',
        'PAYE',
        'NSSF 5%',
        'NSSF 10%',
        'LST',
        'Reinvested',
        'Advance Recovered',
        'Net',
        'Employer Cost',
        'Paid Count',
        'Paid Amount',
        'Prepared By',
        'Approved By',
        'Approved At',
        'Paid At',
        'Locked At',
      ],
      filteredRuns.map((r) => [
        r.period_code,
        r.run_type,
        r.status,
        r.staff_count,
        r.total_gross,
        r.total_paye,
        r.total_nssf_employee,
        r.total_nssf_employer,
        r.total_lst,
        r.total_reinvest,
        r.total_advance_recovered,
        r.total_net,
        r.total_employer_cost,
        r.paid_count,
        r.paid_amount,
        r.prepared_by_name,
        r.approved_by_name,
        day(r.approved_at),
        day(r.paid_at),
        day(r.locked_at),
      ]),
    );

  return (
    <div className="space-y-4">
      {/* KPI Cards Strip */}
      {!loading && !error && counted.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-semibold uppercase tracking-wider">Gross Payroll</span>
              <Coins className="h-4 w-4 text-primary" />
            </div>
            <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{ugx(totals.gross)}</p>
            <p className="text-[11px] text-muted-foreground">{counted.length} active pay runs</p>
          </div>

          <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-semibold uppercase tracking-wider">PAYE Tax</span>
              <Landmark className="h-4 w-4 text-blue-600" />
            </div>
            <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{ugx(totals.paye)}</p>
            <p className="text-[11px] text-muted-foreground">URA statutory withholding</p>
          </div>

          <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-semibold uppercase tracking-wider">NSSF (15%)</span>
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
            </div>
            <p className="mt-1 text-base font-bold text-foreground sm:text-lg">
              {ugx(totals.nssfEmployee + totals.nssfEmployer)}
            </p>
            <p className="text-[11px] text-muted-foreground">5% employee + 10% employer</p>
          </div>

          <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-semibold uppercase tracking-wider">Advance Recouped</span>
              <HandCoins className="h-4 w-4 text-amber-600" />
            </div>
            <p className="mt-1 text-base font-bold text-amber-700 dark:text-amber-400 sm:text-lg">
              {ugx(totals.advanceRecovered)}
            </p>
            <p className="text-[11px] text-muted-foreground">Recovered via payroll</p>
          </div>

          <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-semibold uppercase tracking-wider">Net Salary</span>
              <Wallet className="h-4 w-4 text-purple-600" />
            </div>
            <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{ugx(totals.net)}</p>
            <p className="text-[11px] text-muted-foreground">Total employee take-home</p>
          </div>

          <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="text-xs font-semibold uppercase tracking-wider">Disbursed</span>
              <TrendingUp className="h-4 w-4 text-emerald-600" />
            </div>
            <p
              className={`mt-1 text-base font-bold sm:text-lg ${
                totals.paid < totals.net ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
              }`}
            >
              {ugx(totals.paid)}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {totals.net > 0 ? `${Math.round((totals.paid / totals.net) * 100)}% payout complete` : '—'}
            </p>
          </div>
        </div>
      )}

      {/* Main Table Card */}
      <Card className="shadow-sm">
        <CardHeader className="p-4 sm:p-5 border-b border-border/60">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg font-bold">Payroll Runs</CardTitle>
                <Badge variant="outline" className="font-mono text-xs font-medium">
                  {filteredRuns.length} {filteredRuns.length === 1 ? 'run' : 'runs'}
                </Badge>
              </div>
              <CardDescription className="text-xs mt-0.5">
                Every pay run recorded in the system, newest first. Totals strictly exclude cancelled runs.
              </CardDescription>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {cancelledCount > 0 && (
                <Button
                  size="sm"
                  variant={showCancelled ? 'secondary' : 'outline'}
                  className="h-8 text-xs font-medium"
                  onClick={() => setShowCancelled((v) => !v)}
                >
                  {showCancelled ? 'Hide' : 'Show'} Cancelled ({cancelledCount})
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs font-medium gap-1.5"
                disabled={!filteredRuns.length}
                onClick={exportCsv}
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            </div>
          </div>

          {/* Search & Status Filter Strip */}
          <div className="mt-3 flex flex-col gap-2 pt-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search pay period, month, run ID, or approver..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0">
              <Filter className="h-3.5 w-3.5 text-muted-foreground mr-1" />
              {['all', 'locked', 'paid', 'approved', 'in_review'].map((st) => (
                <Button
                  key={st}
                  size="sm"
                  variant={statusFilter === st ? 'default' : 'ghost'}
                  className={`h-7 px-2.5 text-xs font-medium rounded-full ${
                    statusFilter === st ? 'shadow-sm' : 'text-muted-foreground'
                  }`}
                  onClick={() => setStatusFilter(st)}
                >
                  {st === 'all' ? 'All' : st.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </Button>
              ))}
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
              <p className="text-sm font-medium">Loading payroll runs from ledger…</p>
            </div>
          )}

          {error && (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Access Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          )}

          {!loading && !error && filteredRuns.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <FileSpreadsheet className="h-10 w-10 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-semibold text-foreground">No payroll runs match criteria</p>
              <p className="text-xs text-muted-foreground max-w-sm mt-0.5">
                {searchTerm || statusFilter !== 'all'
                  ? 'Try clearing the search query or status filter above.'
                  : 'No pay runs have been created yet.'}
              </p>
            </div>
          )}

          {!loading && !error && filteredRuns.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40 text-xs">
                    <TableHead className="font-semibold text-foreground">Period & Type</TableHead>
                    <TableHead className="font-semibold text-foreground">Status</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Staff</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Gross (UGX)</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">PAYE (UGX)</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">NSSF (15%)</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Recovered</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Net Payable</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Disbursed</TableHead>
                    <TableHead className="font-semibold text-foreground">Sign-off</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRuns.map((r) => {
                    const short = r.status !== 'cancelled' && Number(r.paid_amount) < Number(r.total_net);
                    const nssfTotal = Number(r.total_nssf_employee) + Number(r.total_nssf_employer);
                    return (
                      <TableRow
                        key={r.run_id}
                        className={`transition-colors hover:bg-muted/30 ${
                          r.status === 'cancelled' ? 'opacity-60 bg-muted/10' : ''
                        }`}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary font-semibold text-xs shrink-0">
                              <Calendar className="h-4 w-4" />
                            </div>
                            <div>
                              <p className="font-semibold text-sm leading-tight text-foreground">
                                {monthLabel(r.period_month)}
                              </p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                <span className="text-[11px] text-muted-foreground capitalize">
                                  {r.run_type === 'regular' ? 'Monthly Run' : r.run_type.replace('_', ' ')}
                                </span>
                                <span className="text-[10px] text-muted-foreground font-mono bg-muted px-1.5 py-0.2 rounded">
                                  {r.run_id.slice(0, 8)}
                                </span>
                              </div>
                            </div>
                          </div>
                        </TableCell>

                        <TableCell>
                          <RunStatusBadge status={r.status} />
                        </TableCell>

                        <TableCell className="text-right font-medium">
                          <span className="inline-flex items-center gap-1 text-xs text-foreground font-semibold">
                            <Users className="h-3 w-3 text-muted-foreground inline" />
                            {r.staff_count}
                          </span>
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs font-medium">
                          {num(r.total_gross)}
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {num(r.total_paye)}
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {num(nssfTotal)}
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs text-amber-700 dark:text-amber-400 font-semibold">
                          {num(r.total_advance_recovered)}
                        </TableCell>

                        <TableCell className="text-right font-mono text-xs font-bold text-foreground">
                          {num(r.total_net)}
                        </TableCell>

                        <TableCell className="text-right">
                          <p
                            className={`font-mono text-xs font-bold ${
                              short ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            {num(r.paid_amount)}
                          </p>
                          <span className="text-[10px] text-muted-foreground">
                            {r.paid_count} of {r.staff_count} staff
                          </span>
                        </TableCell>

                        <TableCell className="text-xs">
                          {r.approved_by_name ? (
                            <div>
                              <span className="font-medium text-foreground block">{r.approved_by_name}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {day(r.approved_at)}
                                {r.locked_at ? ` · Locked ${day(r.locked_at)}` : ''}
                              </span>
                            </div>
                          ) : (
                            <span className="text-muted-foreground text-xs">—</span>
                          )}
                        </TableCell>

                        <TableCell className="text-right">
                          <Button asChild size="sm" variant="outline" className="h-7 text-xs font-medium gap-1">
                            <Link to={`/hr/pay/runs/${r.run_id}`}>
                              Open <ArrowUpRight className="h-3 w-3" />
                            </Link>
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
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Advance Status Sub-Panel                                                   */
/* -------------------------------------------------------------------------- */

interface AdvanceStatusProps {
  rows: AdvanceRow[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

function AdvanceStatus({ rows, loading, error, onRefresh }: AdvanceStatusProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [source, setSource] = useState<(typeof SOURCES)[number]['key']>('all');
  const [openOnly, setOpenOnly] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const summary = useMemo(() => {
    const tracked = rows.filter((r) => r.repayment_tracked && !r.is_closed);
    const untracked = rows.filter((r) => !r.repayment_tracked && r.state.startsWith('Disbursed'));
    return {
      outstanding: tracked.reduce((s, r) => s + Number(r.balance ?? 0), 0),
      recovered: rows.reduce((s, r) => s + Number(r.recovered ?? 0), 0),
      totalPrincipal: rows.reduce((s, r) => s + Number(r.principal ?? 0), 0),
      open: rows.filter((r) => !r.is_closed).length,
      closed: rows.filter((r) => r.is_closed).length,
      untrackedCount: untracked.length,
      untrackedAmount: untracked.reduce((s, r) => s + Number(r.principal), 0),
    };
  }, [rows]);

  const countFor = (k: (typeof SOURCES)[number]['key']) =>
    k === 'all' ? rows.length : rows.filter((r) => r.source === k).length;

  const visible = useMemo(() => {
    return rows.filter((r) => {
      if (source !== 'all' && r.source !== source) return false;
      if (openOnly && r.is_closed) return false;
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const borrower = (r.borrower_name ?? '').toLowerCase();
        const ref = (r.reference ?? '').toLowerCase();
        const staffRef = (r.staff_ref ?? '').toLowerCase();
        const purpose = (r.purpose ?? '').toLowerCase();
        if (
          !borrower.includes(q) &&
          !ref.includes(q) &&
          !staffRef.includes(q) &&
          !purpose.includes(q)
        ) {
          return false;
        }
      }
      return true;
    });
  }, [rows, source, openOnly, searchTerm]);

  const exportCsv = () =>
    downloadCsv(
      'cfo-advances.csv',
      [
        'Type',
        'Reference',
        'Borrower',
        'Staff Ref',
        'Purpose',
        'Principal',
        'Total Repayable',
        'State',
        'Requested',
        'Approved',
        'Disbursed',
        'Plan',
        'Recovered',
        'Balance',
      ],
      visible.map((r) => [
        r.source_label,
        r.reference,
        r.borrower_name,
        r.staff_ref,
        r.purpose,
        r.principal,
        r.total_repayable,
        r.state,
        day(r.requested_at),
        day(r.approved_at),
        day(r.disbursed_at),
        r.plan,
        r.repayment_tracked ? r.recovered : 'not tracked',
        r.repayment_tracked ? r.balance : 'not tracked',
      ]),
    );

  return (
    <div className="space-y-4">
      {/* KPI Cards Strip */}
      {!loading && !error && rows.length > 0 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-semibold uppercase tracking-wider">Outstanding Portfolio</span>
                <Wallet className="h-4 w-4 text-amber-600" />
              </div>
              <p
                className={`mt-1 text-base font-bold sm:text-lg ${
                  summary.outstanding > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                }`}
              >
                {ugx(summary.outstanding)}
              </p>
              <p className="text-[11px] text-muted-foreground">{summary.open} active open advances</p>
            </div>

            <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-semibold uppercase tracking-wider">Recovered to Date</span>
                <TrendingUp className="h-4 w-4 text-emerald-600" />
              </div>
              <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{ugx(summary.recovered)}</p>
              <p className="text-[11px] text-muted-foreground">Collected via deductions</p>
            </div>

            <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-semibold uppercase tracking-wider">Total Principal Issued</span>
                <Coins className="h-4 w-4 text-primary" />
              </div>
              <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{ugx(summary.totalPrincipal)}</p>
              <p className="text-[11px] text-muted-foreground">{rows.length} total advances recorded</p>
            </div>

            <div className="rounded-xl border border-border/80 bg-card p-3.5 shadow-sm transition-all hover:border-border">
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="text-xs font-semibold uppercase tracking-wider">Settled & Closed</span>
                <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              </div>
              <p className="mt-1 text-base font-bold text-foreground sm:text-lg">{summary.closed}</p>
              <p className="text-[11px] text-muted-foreground">Fully recovered contracts</p>
            </div>
          </div>

          {summary.untrackedCount > 0 && (
            <Alert className="border-amber-300/80 bg-amber-50/80 dark:border-amber-900/60 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <AlertTitle className="text-xs font-bold">Untracked Staff Advances Detected</AlertTitle>
              <AlertDescription className="text-xs mt-0.5 leading-relaxed">
                {summary.untrackedCount} staff {summary.untrackedCount === 1 ? 'loan' : 'loans'} totaling{' '}
                <span className="font-semibold font-mono">{ugx(summary.untrackedAmount)}</span> were disbursed with no
                automated payroll repayment schedule recorded. These are isolated from the active Outstanding ledger
                portfolio.
              </AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {/* Main Table Card */}
      <Card className="shadow-sm">
        <CardHeader className="p-4 sm:p-5 border-b border-border/60">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <CardTitle className="text-lg font-bold">Advances Portfolio</CardTitle>
                <Badge variant="outline" className="font-mono text-xs font-medium">
                  {visible.length} {visible.length === 1 ? 'record' : 'records'}
                </Badge>
              </div>
              <CardDescription className="text-xs mt-0.5">
                Salary advances, staff loans and special advances across all employment terms.
              </CardDescription>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={openOnly ? 'secondary' : 'outline'}
                className="h-8 text-xs font-medium"
                onClick={() => setOpenOnly((v) => !v)}
              >
                {openOnly ? 'Show All History' : 'Open Only'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs font-medium gap-1.5"
                disabled={!visible.length}
                onClick={exportCsv}
              >
                <Download className="h-3.5 w-3.5" /> Export CSV
              </Button>
            </div>
          </div>

          {/* Filtering Tabs & Search */}
          <div className="mt-3 flex flex-col gap-2.5 pt-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1.5">
              {SOURCES.map((s) => (
                <Button
                  key={s.key}
                  size="sm"
                  variant={source === s.key ? 'default' : 'ghost'}
                  className={`h-7 px-3 text-xs font-medium rounded-full ${
                    source === s.key ? 'shadow-sm' : 'text-muted-foreground'
                  }`}
                  onClick={() => setSource(s.key)}
                >
                  {s.label} ({countFor(s.key)})
                </Button>
              ))}
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search staff, ref, or purpose..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-0">
          {loading && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary mb-2" />
              <p className="text-sm font-medium">Loading advances portfolio…</p>
            </div>
          )}

          {error && (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Access Error</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </div>
          )}

          {!loading && !error && visible.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <HandCoins className="h-10 w-10 text-muted-foreground/40 mb-2" />
              <p className="text-sm font-semibold text-foreground">No advances found</p>
              <p className="text-xs text-muted-foreground max-w-sm mt-0.5">
                {searchTerm || source !== 'all' || openOnly
                  ? 'No records match your selected filters. Try broadening the search criteria.'
                  : 'No salary advances or staff loans recorded yet.'}
              </p>
            </div>
          )}

          {!loading && !error && visible.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40 hover:bg-muted/40 text-xs">
                    <TableHead className="font-semibold text-foreground">Staff Member</TableHead>
                    <TableHead className="font-semibold text-foreground">Source</TableHead>
                    <TableHead className="font-semibold text-foreground">State</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Principal (UGX)</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Recovered (UGX)</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">Balance (UGX)</TableHead>
                    <TableHead className="min-w-[130px] font-semibold text-foreground">Recovery Progress</TableHead>
                    <TableHead className="font-semibold text-foreground">Repayment Plan</TableHead>
                    <TableHead className="font-semibold text-foreground">Dates</TableHead>
                    <TableHead className="text-right font-semibold text-foreground">History</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((r) => {
                    const due = Number(r.total_repayable ?? r.principal);
                    const pct =
                      r.repayment_tracked && due > 0
                        ? Math.min(100, Math.round((Number(r.recovered ?? 0) / due) * 100))
                        : null;
                    const items = r.history ?? [];
                    const key = `${r.source}-${r.record_id}`;
                    const isOpen = open === key;

                    return (
                      <Fragment key={key}>
                        <TableRow
                          className={`transition-colors hover:bg-muted/30 ${
                            r.is_closed ? 'opacity-65 bg-muted/10' : ''
                          }`}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <Avatar className="h-8 w-8 rounded-full border border-border">
                                <AvatarFallback className="bg-primary/10 text-primary font-bold text-xs">
                                  {getInitials(r.borrower_name)}
                                </AvatarFallback>
                              </Avatar>
                              <div>
                                <p className="font-semibold text-sm leading-tight text-foreground">
                                  {r.borrower_name ?? '—'}
                                </p>
                                <div className="flex items-center gap-1.5 mt-0.5">
                                  <span className="text-[10px] font-mono text-muted-foreground bg-muted px-1.5 py-0.2 rounded">
                                    {r.staff_ref ?? r.reference ?? '—'}
                                  </span>
                                  {r.purpose && (
                                    <span className="text-[11px] text-muted-foreground truncate max-w-[180px]">
                                      · {r.purpose}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>
                          </TableCell>

                          <TableCell>
                            <SourceBadge source={r.source} label={r.source_label} />
                          </TableCell>

                          <TableCell>
                            <AdvanceStateBadge state={r.state} />
                          </TableCell>

                          <TableCell className="text-right font-mono text-xs font-medium">
                            {num(r.principal)}
                          </TableCell>

                          <TableCell className="text-right font-mono text-xs text-muted-foreground">
                            {r.repayment_tracked ? num(r.recovered) : '—'}
                          </TableCell>

                          <TableCell className="text-right font-mono text-xs font-bold text-foreground">
                            {r.repayment_tracked ? (
                              <span
                                className={
                                  Number(r.balance) > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
                                }
                              >
                                {num(r.balance)}
                              </span>
                            ) : (
                              <span className="text-muted-foreground text-xs italic">Untracked</span>
                            )}
                          </TableCell>

                          <TableCell>
                            {pct === null ? (
                              <span className="text-[11px] text-muted-foreground italic">Not tracked</span>
                            ) : (
                              <div className="space-y-1">
                                <div className="flex items-center justify-between text-[11px]">
                                  <span className="font-semibold text-xs">{pct}%</span>
                                  <span className="text-[10px] text-muted-foreground">
                                    {num(r.recovered)} / {num(due)}
                                  </span>
                                </div>
                                <Progress
                                  value={pct}
                                  className="h-1.5 bg-muted"
                                />
                              </div>
                            )}
                          </TableCell>

                          <TableCell className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground">{r.plan ?? '—'}</span>
                          </TableCell>

                          <TableCell className="text-xs">
                            <div className="space-y-0.5">
                              <span className="block text-[11px] text-muted-foreground">
                                Req: {day(r.requested_at)}
                              </span>
                              {r.disbursed_at && (
                                <span className="block text-[11px] font-medium text-foreground">
                                  Disb: {day(r.disbursed_at)}
                                </span>
                              )}
                            </div>
                          </TableCell>

                          <TableCell className="text-right">
                            {items.length > 0 ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                                aria-label={isOpen ? 'Hide repayments' : 'Show repayments'}
                                onClick={() => setOpen(isOpen ? null : key)}
                              >
                                {isOpen ? (
                                  <ChevronUp className="h-4 w-4" />
                                ) : (
                                  <ChevronDown className="h-4 w-4" />
                                )}
                              </Button>
                            ) : (
                              <span className="text-[11px] text-muted-foreground mr-2">—</span>
                            )}
                          </TableCell>
                        </TableRow>

                        {/* Expandable Repayment Ledger Row */}
                        {isOpen && (
                          <TableRow className="bg-muted/20 hover:bg-muted/20">
                            <TableCell colSpan={10} className="p-3 sm:px-6">
                              <div className="rounded-lg border border-border/80 bg-background/80 p-3 shadow-inner">
                                <div className="flex items-center justify-between mb-2">
                                  <span className="text-xs font-bold text-foreground flex items-center gap-1.5">
                                    <History className="h-3.5 w-3.5 text-primary" />
                                    Repayment History & Schedule Deductions ({items.length})
                                  </span>
                                  <span className="text-[11px] text-muted-foreground font-mono">
                                    Total Recouped: {ugx(r.recovered)}
                                  </span>
                                </div>
                                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2">
                                  {items.map((it, i) => (
                                    <div
                                      key={`${key}-${i}`}
                                      className="rounded-md border border-border bg-card p-2 text-xs shadow-xs"
                                    >
                                      <div className="flex items-center justify-between font-semibold text-foreground">
                                        <span>{it.label}</span>
                                        <span className="font-mono text-emerald-700 dark:text-emerald-400">
                                          {ugx(it.amount)}
                                        </span>
                                      </div>
                                      {it.note && (
                                        <p className="text-[10px] text-muted-foreground mt-0.5 italic">{it.note}</p>
                                      )}
                                    </div>
                                  ))}
                                </div>
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
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Main Executive Container                                                   */
/* -------------------------------------------------------------------------- */

export default function CfoPayrollHistoryPanel() {
  const [payrollRows, setPayrollRows] = useState<RunRow[]>([]);
  const [payrollLoading, setPayrollLoading] = useState(true);
  const [payrollError, setPayrollError] = useState<string | null>(null);

  const [advanceRows, setAdvanceRows] = useState<AdvanceRow[]>([]);
  const [advanceLoading, setAdvanceLoading] = useState(true);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<string>('payroll');
  const [refreshing, setRefreshing] = useState(false);

  const fetchPayroll = async () => {
    setPayrollLoading(true);
    setPayrollError(null);
    const { data, error: err } = await rpc('cfo_payroll_history');
    if (err) setPayrollError(readableRpcError(err.message));
    else setPayrollRows((data ?? []) as RunRow[]);
    setPayrollLoading(false);
  };

  const fetchAdvances = async () => {
    setAdvanceLoading(true);
    setAdvanceError(null);
    const { data, error: err } = await rpc('cfo_advance_status');
    if (err) setAdvanceError(readableRpcError(err.message));
    else setAdvanceRows((data ?? []) as AdvanceRow[]);
    setAdvanceLoading(false);
  };

  const handleRefreshAll = async () => {
    setRefreshing(true);
    await Promise.all([fetchPayroll(), fetchAdvances()]);
    setRefreshing(false);
  };

  useEffect(() => {
    void fetchPayroll();
    void fetchAdvances();
  }, []);

  return (
    <div className="space-y-6">
      {/* Executive Command Header */}
      <div className="flex flex-col gap-4 rounded-xl border border-border/80 bg-card p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <History className="h-5 w-5" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">
              Payroll History &amp; Advances
            </h1>
            <Badge variant="outline" className="border-primary/30 bg-primary/5 text-primary text-xs font-semibold">
              <ShieldCheck className="h-3 w-3 mr-1 inline" /> CFO Ledger
            </Badge>
            <Badge variant="secondary" className="text-xs font-medium">
              Read-Only
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground sm:text-sm max-w-3xl">
            Authoritative ledger history of past payroll disbursements, statutory deductions (PAYE, NSSF, LST),
            and employee advance recovery tracking across salary advances, staff loans, and special advances.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center">
          <Button
            size="sm"
            variant="outline"
            className="h-9 gap-1.5 text-xs font-medium"
            disabled={refreshing || payrollLoading || advanceLoading}
            onClick={handleRefreshAll}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh Data
          </Button>
        </div>
      </div>

      {/* Segmented Sub-View Switcher */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="bg-muted/60 p-1">
          <TabsTrigger value="payroll" className="text-xs font-semibold gap-1.5">
            <FileSpreadsheet className="h-3.5 w-3.5" />
            Payroll History ({payrollRows.length})
          </TabsTrigger>
          <TabsTrigger value="advances" className="text-xs font-semibold gap-1.5">
            <HandCoins className="h-3.5 w-3.5" />
            Advances Portfolio ({advanceRows.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="payroll">
          <PayrollHistory
            rows={payrollRows}
            loading={payrollLoading}
            error={payrollError}
            onRefresh={fetchPayroll}
          />
        </TabsContent>

        <TabsContent value="advances">
          <AdvanceStatus
            rows={advanceRows}
            loading={advanceLoading}
            error={advanceError}
            onRefresh={fetchAdvances}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
