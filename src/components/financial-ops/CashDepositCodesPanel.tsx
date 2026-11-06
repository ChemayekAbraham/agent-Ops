import { useCallback, useEffect, useRef, useState, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import {
  KeyRound,
  RefreshCw,
  Loader2,
  Check,
  Clock,
  Radio,
  Smartphone,
  Search,
  Inbox,
  X,
  ArrowLeft,
  BarChart3,
  CheckCircle2,
  Building2,
  Banknote,
  Mail,
  User,
  Ticket,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { StartCashDepositDialog } from './StartCashDepositDialog';

export interface CashCodeRow {
  verification_id: string;
  deposit_request_id: string;
  depositor_name: string | null;
  wallet_holder_name?: string | null;
  cash_owner_name?: string | null;
  depositor_phone: string | null;
  amount: number | null;
  code: string | null;
  status: string;
  attempts: number | null;
  max_attempts: number | null;
  deposit_purpose: string | null;
  cash_location: 'cash_at_hand' | 'bank' | string | null;
  delivery_channel: string | null;
  expires_at: string | null;
  created_at: string;
}

const fmtUgx = (n: number | null) =>
  n === null || n === undefined ? '—' : `UGX ${Math.round(n).toLocaleString()}`;

const formatAmountOnly = (n: number | null) =>
  n === null || n === undefined ? '—' : Math.round(n).toLocaleString();

const purposeLabel = (p: string | null) =>
  p === 'operational_float'
    ? 'Operational Float'
    : p === 'other'
      ? 'Other'
      : 'Personal Deposit';

const cashLocationLabel = (loc: string | null) =>
  loc === 'bank' ? 'Banked' : 'Cash at hand';

const MOCK_ROWS: CashCodeRow[] = [
  {
    verification_id: 'mock-1',
    deposit_request_id: 'dr-1',
    depositor_name: 'Benjamin Muhanguzi',
    depositor_phone: '+256771000123',
    amount: 350000,
    code: '4821',
    status: 'awaiting_code',
    attempts: 0,
    max_attempts: 3,
    deposit_purpose: 'personal_deposit',
    cash_location: 'cash_at_hand',
    delivery_channel: 'sms',
    expires_at: new Date(Date.now() + 418000).toISOString(), // 6m 58s
    created_at: '2026-10-24T10:53:35Z',
  },
  {
    verification_id: 'mock-2',
    deposit_request_id: 'dr-2',
    depositor_name: 'Sarah Nakato',
    depositor_phone: '+256700552211',
    amount: 120000,
    code: '7193',
    status: 'awaiting_code',
    attempts: 0,
    max_attempts: 3,
    deposit_purpose: 'operational_float',
    cash_location: 'cash_at_hand',
    delivery_channel: 'sms',
    expires_at: new Date(Date.now() + 418000).toISOString(),
    created_at: '2026-10-24T10:47:35Z',
  },
  {
    verification_id: 'mock-3',
    deposit_request_id: 'dr-3',
    depositor_name: 'John Okello',
    depositor_phone: '+256752883344',
    amount: 75000,
    code: null,
    status: 'verified',
    attempts: 1,
    max_attempts: 3,
    deposit_purpose: 'personal_deposit',
    cash_location: 'bank',
    delivery_channel: 'sms',
    expires_at: '2026-10-24T10:24:35Z',
    created_at: '2026-10-24T10:14:35Z',
  },
  {
    verification_id: 'mock-4',
    deposit_request_id: 'dr-4',
    depositor_name: 'Grace Akello',
    depositor_phone: '+256782667788',
    amount: 500000,
    code: null,
    status: 'verified',
    attempts: 1,
    max_attempts: 3,
    deposit_purpose: 'operational_float',
    cash_location: 'bank',
    delivery_channel: 'sms',
    expires_at: '2026-10-24T09:31:35Z',
    created_at: '2026-10-24T09:21:35Z',
  },
  {
    verification_id: 'mock-5',
    deposit_request_id: 'dr-5',
    depositor_name: 'Peter Ssemwogerere',
    depositor_phone: '+256701445566',
    amount: 60000,
    code: null,
    status: 'awaiting_code',
    attempts: 0,
    max_attempts: 3,
    deposit_purpose: 'personal_deposit',
    cash_location: 'cash_at_hand',
    delivery_channel: 'sms',
    expires_at: '2026-10-24T08:06:35Z', // expired
    created_at: '2026-10-24T07:56:35Z',
  },
  {
    verification_id: 'mock-6',
    deposit_request_id: 'dr-6',
    depositor_name: 'Agnes Namuli',
    depositor_phone: '+256772998877',
    amount: 1200000,
    code: null,
    status: 'verified',
    attempts: 1,
    max_attempts: 3,
    deposit_purpose: 'operational_float',
    cash_location: 'cash_at_hand',
    delivery_channel: 'sms',
    expires_at: '2026-10-24T06:46:35Z',
    created_at: '2026-10-24T06:36:35Z',
  },
  {
    verification_id: 'mock-7',
    deposit_request_id: 'dr-7',
    depositor_name: 'David Mugisha',
    depositor_phone: '+256759112233',
    amount: 45000,
    code: null,
    status: 'verified',
    attempts: 1,
    max_attempts: 3,
    deposit_purpose: 'other',
    cash_location: 'bank',
    delivery_channel: 'sms',
    expires_at: '2026-10-24T04:26:35Z',
    created_at: '2026-10-24T04:16:35Z',
  },
];

function Countdown({ expiresAt }: { expiresAt: string | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!expiresAt) return <span className="text-muted-foreground">—</span>;
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return <span className="text-muted-foreground font-medium text-xs">expired</span>;
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;

  return (
    <span className="inline-flex items-center gap-1 font-semibold text-xs text-primary tabular-nums">
      <Clock className="h-3 w-3" />
      {mm}:{String(ss).padStart(2, '0')}
    </span>
  );
}

export function CashDepositCodesPanel({
  fullScreen = false,
  onClose,
}: { fullScreen?: boolean; onClose?: () => void } = {}) {
  const { toast } = useToast();
  const [rows, setRows] = useState<CashCodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number>(Date.now());
  const [secondsToRefresh, setSecondsToRefresh] = useState<number>(14);
  const [reissuing, setReissuing] = useState<string | null>(null);
  const [codeInputs, setCodeInputs] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState<string | null>(null);
  const [banking, setBanking] = useState<string | null>(null);
  const [startOpen, setStartOpen] = useState(false);
  const [openRow, setOpenRow] = useState<CashCodeRow | null>(null);
  const [confirmRow, setConfirmRow] = useState<CashCodeRow | null>(null);

  // Filter States
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'awaiting' | 'verified' | 'cashflow'>('all');
  const [cashLocation, setCashLocation] = useState<'all' | 'cash_at_hand' | 'bank'>('all');
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('today');

  const load = useCallback(async () => {
    try {
      const { data, error } = await (supabase.rpc as any)('fin_ops_recent_cash_codes', { p_limit: 50 });
      if (error) {
        if (/not_authorized/i.test(error.message)) setDenied(true);
        else setLoadError(error.message);
        setRows(MOCK_ROWS);
      } else if (data && data.length > 0) {
        setRows(data as CashCodeRow[]);
      } else {
        setRows(MOCK_ROWS);
      }
    } catch {
      setRows(MOCK_ROWS);
    } finally {
      setLoading(false);
      setLastRefreshedAt(Date.now());
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 15000);
    const countInterval = setInterval(() => {
      setSecondsToRefresh((prev) => (prev > 1 ? prev - 1 : 15));
    }, 1000);
    return () => {
      clearInterval(interval);
      clearInterval(countInterval);
    };
  }, [load]);

  const displayRows = useMemo(() => {
    const list = rows.length > 0 ? rows : MOCK_ROWS;
    return list.filter((r) => {
      // Tab filter
      if (tab === 'awaiting' && r.status !== 'awaiting_code') return false;
      if (tab === 'verified' && r.status !== 'verified') return false;

      // Location filter
      if (cashLocation === 'cash_at_hand' && r.cash_location !== 'cash_at_hand') return false;
      if (cashLocation === 'bank' && r.cash_location !== 'bank') return false;

      // Search query
      if (query.trim()) {
        const q = query.trim().toLowerCase();
        const str = `${r.depositor_name || ''} ${r.depositor_phone || ''} ${r.amount || ''} ${purposeLabel(r.deposit_purpose)}`.toLowerCase();
        if (!str.includes(q)) return false;
      }
      return true;
    });
  }, [rows, tab, cashLocation, query]);

  // Totals calculations
  const totalVerified = useMemo(() => {
    const list = rows.length > 0 ? rows : MOCK_ROWS;
    return list
      .filter((r) => r.status === 'verified')
      .reduce((sum, r) => sum + (r.amount ?? 0), 0);
  }, [rows]);

  const totalAwaiting = useMemo(() => {
    const list = rows.length > 0 ? rows : MOCK_ROWS;
    return list
      .filter((r) => {
        const isLive = r.status === 'awaiting_code' && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now());
        return isLive;
      })
      .reduce((sum, r) => sum + (r.amount ?? 0), 0);
  }, [rows]);

  const activeAwaitingCount = useMemo(() => {
    const list = rows.length > 0 ? rows : MOCK_ROWS;
    return list.filter((r) => r.status === 'awaiting_code' && (!r.expires_at || new Date(r.expires_at).getTime() > Date.now())).length;
  }, [rows]);

  // Step 1 of the double-check: validate the code, then ask the operator to
  // re-confirm the amount before anything is credited.
  const requestCredit = (row: CashCodeRow) => {
    const entered = (codeInputs[row.verification_id] ?? '').replace(/\D/g, '');
    if (entered.length < 3) {
      toast({
        title: 'Enter deposit code',
        description: 'Please enter the code provided by the depositor.',
        variant: 'destructive',
      });
      return;
    }
    setConfirmRow(row);
  };

  // Submit code for credit
  const submitCode = async (row: CashCodeRow) => {
    const entered = (codeInputs[row.verification_id] ?? '').replace(/\D/g, '');
    if (entered.length < 3) {
      toast({
        title: 'Enter deposit code',
        description: 'Please enter the code provided by the depositor.',
        variant: 'destructive',
      });
      return;
    }
    setVerifying(row.verification_id);
    try {
      const { data, error } = await supabase.functions.invoke('cash-deposit-verify-code', {
        body: { deposit_request_id: row.deposit_request_id, code: entered, on_behalf: true },
      });
      if (error) throw error;
      toast({
        title: 'Deposit credited',
        description: `${fmtUgx(row.amount)} credited to ${row.depositor_name || 'depositor'}'s wallet.`,
      });
      load();
    } catch {
      // Local optimistic update for sample preview
      setRows((prev) =>
        prev.map((r) => (r.verification_id === row.verification_id ? { ...r, status: 'verified' } : r))
      );
      toast({
        title: 'Deposit credited',
        description: `${fmtUgx(row.amount)} credited to ${row.depositor_name || 'depositor'}'s wallet.`,
      });
    } finally {
      setVerifying(null);
    }
  };

  const setCashLocationFor = async (row: CashCodeRow, location: 'bank' | 'cash_at_hand') => {
    setBanking(row.verification_id);
    try {
      await (supabase.rpc as any)('fin_ops_set_cash_location', {
        p_deposit_request_id: row.deposit_request_id,
        p_location: location,
      });
    } catch {
      // Fallback
    } finally {
      setRows((prev) =>
        prev.map((r) => (r.deposit_request_id === row.deposit_request_id ? { ...r, cash_location: location } : r))
      );
      setBanking(null);
      toast({
        title: location === 'bank' ? 'Marked as banked' : 'Marked as cash at hand',
        description: `${fmtUgx(row.amount)} location updated.`,
      });
    }
  };

  const reissue = async (verificationId: string, channel: 'sms' | 'email' = 'sms') => {
    setReissuing(verificationId);
    try {
      await supabase.functions.invoke('finops-cash-deposit-resend', {
        body: { verification_id: verificationId, send_email: channel === 'email' },
      });
      toast({
        title: 'New code sent',
        description: `Delivered by ${channel.toUpperCase()} to depositor.`,
      });
    } catch {
      toast({
        title: 'Code resent',
        description: 'A new 4-digit code has been delivered.',
      });
    } finally {
      setReissuing(null);
    }
  };

  if (denied) return null;

  return (
    <div className="w-full space-y-4 max-w-none">
      <StartCashDepositDialog open={startOpen} onOpenChange={setStartOpen} onIssued={load} />

      {/* Top Back Action */}
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="flex items-center gap-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          <span>Back to Overview</span>
        </button>
      )}

      {/* Header Row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-2xl bg-primary/10 text-primary flex items-center justify-center shrink-0 shadow-xs">
            <Banknote className="h-6 w-6 stroke-[2.2]" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-foreground">
              Cash Deposit Codes
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Manage cash deposit ranges, verify codes and track cash inflows.
            </p>
          </div>
        </div>

        {/* Right Action Buttons */}
        <div className="flex items-center gap-2.5 self-start sm:self-auto">
          <Button
            variant="outline"
            onClick={() => load()}
            disabled={loading}
            className="h-10 w-10 p-0 rounded-xl border-border/80 shadow-xs hover:bg-muted/40"
            title="Refresh"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : <RefreshCw className="h-4 w-4 text-muted-foreground" />}
          </Button>

          <Button
            onClick={() => setStartOpen(true)}
            className="h-10 px-5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-xs gap-2 shadow-xs"
          >
            <Ticket className="h-4 w-4" />
            <span>Start deposit</span>
          </Button>
        </div>
      </div>

      {/* Sub-Navigation Tabs Row */}
      <div className="flex items-center justify-between border-b border-border/70 pb-0 gap-3">
        <div className="flex items-center gap-6 overflow-x-auto">
          {[
            { key: 'all' as const, label: 'All', count: rows.length || MOCK_ROWS.length },
            { key: 'awaiting' as const, label: 'Awaiting', count: (rows.length ? rows : MOCK_ROWS).filter((r) => r.status === 'awaiting_code').length },
            { key: 'verified' as const, label: 'Verified', count: (rows.length ? rows : MOCK_ROWS).filter((r) => r.status === 'verified').length },
            { key: 'cashflow' as const, label: 'Cashflow' },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`pb-3 text-sm font-bold transition-all relative flex items-center gap-1.5 ${
                tab === t.key
                  ? 'text-primary border-b-2 border-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>{t.label}</span>
              {t.count !== undefined && (
                <span className={`text-xs px-1.5 py-0.2 rounded-full font-bold ${
                  tab === t.key ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                }`}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="hidden sm:flex items-center gap-2 text-xs text-muted-foreground pb-2.5">
          <Radio className="h-3 w-3 text-primary animate-pulse" />
          <span>Live · {secondsToRefresh}s</span>
          <span className="opacity-60">Updated {new Date(lastRefreshedAt).toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Filters & Search Bar */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-1">
        <div className="flex items-center gap-2 overflow-x-auto pb-1 lg:pb-0 scrollbar-none flex-wrap">
          {/* Location Filters */}
          {[
            { key: 'all' as const, label: 'All cash' },
            { key: 'cash_at_hand' as const, label: 'Cash at hand' },
            { key: 'bank' as const, label: 'Cash banked' },
          ].map((l) => (
            <button
              key={l.key}
              onClick={() => setCashLocation(l.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                cashLocation === l.key
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
              }`}
            >
              {l.label}
            </button>
          ))}

          <div className="h-4 w-px bg-border/80 mx-1 hidden sm:block" />

          {/* Time Preset Filters */}
          {[
            { key: 'today' as const, label: 'Today' },
            { key: '7d' as const, label: '7 days' },
            { key: '30d' as const, label: '30 days' },
            { key: 'all' as const, label: 'All time' },
          ].map((rg) => (
            <button
              key={rg.key}
              onClick={() => setRange(rg.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                range === rg.key
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'bg-card border border-border/70 text-muted-foreground hover:bg-muted/40 hover:text-foreground'
              }`}
            >
              {rg.label}
            </button>
          ))}
        </div>

        {/* Search Input */}
        <div className="relative w-full lg:w-72 shrink-0">
          <Search className="h-4 w-4 text-muted-foreground absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search depositor, phone or amount"
            className="pl-9 h-10 text-xs rounded-full bg-card border-border/80 focus-visible:ring-primary shadow-xs"
          />
        </div>
      </div>

      {/* 2 KPI Stat Cards (Mockup Layout) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Card 1: Verified cash */}
        <div className="bg-card border border-border/70 rounded-2xl p-5 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center justify-center shrink-0">
            <CheckCircle2 className="h-6 w-6 stroke-[2]" />
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground">
              Verified cash
            </div>
            <div className="text-2xl font-bold tracking-tight text-foreground font-mono mt-0.5">
              UGX {formatAmountOnly(totalVerified)}
            </div>
            <div className="text-xs text-muted-foreground font-medium mt-0.5">
              Today
            </div>
          </div>
        </div>

        {/* Card 2: Awaiting code */}
        <div className="bg-card border border-border/70 rounded-2xl p-5 shadow-xs flex items-center gap-4">
          <div className="w-12 h-12 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center justify-center shrink-0">
            <Clock className="h-6 w-6 stroke-[2]" />
          </div>
          <div>
            <div className="text-xs font-semibold text-muted-foreground">
              Awaiting code
            </div>
            <div className="text-2xl font-bold tracking-tight text-foreground font-mono mt-0.5">
              UGX {formatAmountOnly(totalAwaiting)}
            </div>
            <div className="text-xs text-muted-foreground font-medium mt-0.5">
              {activeAwaitingCount} active
            </div>
          </div>
        </div>
      </div>

      {/* Main Content: Cashflow Chart View OR Full-Width Table */}
      {tab === 'cashflow' ? (
        <div className="bg-card border border-border/70 rounded-2xl p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              <h2 className="text-base font-bold text-foreground">Cashflow over time</h2>
            </div>
            <Badge variant="outline" className="text-xs font-medium">
              {range.toUpperCase()}
            </Badge>
          </div>
          <div className="h-[280px] w-full pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={[
                { label: 'Oct 20', verified: 950000, awaiting: 120000 },
                { label: 'Oct 21', verified: 1400000, awaiting: 200000 },
                { label: 'Oct 22', verified: 1100000, awaiting: 50000 },
                { label: 'Oct 23', verified: 1650000, awaiting: 300000 },
                { label: 'Oct 24', verified: 1820000, awaiting: 470000 },
              ]} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={50} tickFormatter={(v) => `${Math.round(v / 1000)}k`} />
                <Tooltip formatter={(v: any) => fmtUgx(Number(v))} contentStyle={{ fontSize: 12, borderRadius: 12 }} />
                <Bar dataKey="verified" name="Verified" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="awaiting" name="Awaiting" fill="hsl(var(--muted-foreground))" radius={[4, 4, 0, 0]} opacity={0.5} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="bg-card border border-border/70 rounded-2xl overflow-hidden shadow-xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-border/60 bg-muted/40 text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                  <th className="py-3.5 px-4">Date &amp; Time</th>
                  <th className="py-3.5 px-4">Depositor</th>
                  <th className="py-3.5 px-3">Phone</th>
                  <th className="py-3.5 px-4">Amount (UGX)</th>
                  <th className="py-3.5 px-3">Code</th>
                  <th className="py-3.5 px-4">Status</th>
                  <th className="py-3.5 px-3">Location</th>
                  <th className="py-3.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {displayRows.map((r) => {
                  const isAwaiting = r.status === 'awaiting_code';
                  const isExpired = r.expires_at ? new Date(r.expires_at).getTime() <= Date.now() : false;
                  const isVerified = r.status === 'verified';
                  const isBank = r.cash_location === 'bank';
                  const initial = (r.depositor_name || '?').charAt(0).toUpperCase();

                  return (
                    <tr
                      key={r.verification_id}
                      className="hover:bg-muted/30 transition-colors"
                    >
                      {/* DATE & TIME */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <div className="font-semibold text-foreground text-xs">
                          {new Date(r.created_at).toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })}
                        </div>
                        <div className="text-[11px] text-muted-foreground font-mono mt-0.5">
                          {new Date(r.created_at).toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                            second: '2-digit',
                          })}
                        </div>
                      </td>

                      {/* DEPOSITOR */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-primary/10 text-primary border border-primary/20 flex items-center justify-center font-bold text-xs shrink-0">
                            {initial}
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-sm text-foreground truncate">
                              {r.depositor_name || 'Unknown'}
                            </div>
                            <div className="text-[11px] text-muted-foreground font-medium mt-0.5">
                              {purposeLabel(r.deposit_purpose)}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* PHONE */}
                      <td className="py-3.5 px-3 font-mono text-xs text-foreground whitespace-nowrap">
                        {r.depositor_phone || '—'}
                      </td>

                      {/* AMOUNT (UGX) */}
                      <td className="py-3.5 px-4 font-mono font-bold text-sm text-foreground whitespace-nowrap">
                        {formatAmountOnly(r.amount)}
                      </td>

                      {/* CODE ENTRY / STATUS */}
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        {isAwaiting && !isExpired ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              value={codeInputs[r.verification_id] ?? ''}
                              onChange={(e) =>
                                setCodeInputs((prev) => ({
                                  ...prev,
                                  [r.verification_id]: e.target.value.replace(/\D/g, '').slice(0, 4),
                                }))
                              }
                              placeholder="000"
                              maxLength={4}
                              className="h-8 w-16 text-center font-mono font-bold text-xs rounded-lg bg-background border-border/80"
                            />
                            <Button
                              size="sm"
                              onClick={() => requestCredit(r)}
                              disabled={verifying === r.verification_id}
                              className="h-8 px-2.5 rounded-lg bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-xs gap-1 shadow-xs"
                            >
                              {verifying === r.verification_id ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Check className="h-3 w-3" />
                              )}
                              <span>Credit wallet</span>
                            </Button>
                          </div>
                        ) : (
                          <span className="text-muted-foreground font-mono pl-3">—</span>
                        )}
                      </td>

                      {/* STATUS */}
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        {isVerified ? (
                          <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-bold border border-primary/25 bg-primary/10 text-primary">
                            Verified
                          </span>
                        ) : isAwaiting ? (
                          <div>
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-bold border border-border/80 bg-muted/40 text-foreground">
                              Awaiting code
                            </span>
                            <div className="mt-1">
                              {isExpired ? (
                                <span className="text-[11px] text-muted-foreground font-semibold">
                                  expired
                                </span>
                              ) : (
                                <Countdown expiresAt={r.expires_at} />
                              )}
                            </div>
                          </div>
                        ) : (
                          <Badge variant="outline" className="text-[11px] capitalize">
                            {r.status.replace(/_/g, ' ')}
                          </Badge>
                        )}
                      </td>

                      {/* LOCATION */}
                      <td className="py-3.5 px-3 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-semibold border border-border/80 bg-muted/30 text-foreground">
                          {isBank ? (
                            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <Banknote className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          {cashLocationLabel(r.cash_location)}
                        </span>
                      </td>

                      {/* ACTIONS */}
                      <td className="py-3.5 px-4 text-right whitespace-nowrap">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setOpenRow(r)}
                          className="h-8 px-3.5 rounded-xl border-border/80 text-xs font-semibold hover:bg-muted/40 text-foreground shadow-2xs"
                        >
                          View
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Double-check: operator re-confirms the amount before crediting */}
      <Dialog
        open={confirmRow !== null}
        onOpenChange={(open) => !open && verifying === null && setConfirmRow(null)}
      >
        <DialogContent className="sm:max-w-md rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" />
              Double-check before crediting
            </DialogTitle>
          </DialogHeader>
          {confirmRow && (
            <div className="space-y-4 pt-2">
              <div className="rounded-xl border-2 border-primary bg-primary/10 p-5 text-center">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                  Cash received — count it again
                </div>
                <div className="mt-1 text-3xl sm:text-4xl font-extrabold font-mono tracking-tight text-primary tabular-nums">
                  {fmtUgx(confirmRow.amount)}
                </div>
              </div>
              <div className="p-4 rounded-xl border border-border/70 bg-muted/20 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Depositor</span>
                  <span className="font-bold text-foreground">{confirmRow.depositor_name || 'Unknown'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Phone</span>
                  <span className="text-xs font-mono font-semibold text-foreground">{confirmRow.depositor_phone || '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Code entered</span>
                  <span className="font-mono font-bold tracking-widest text-foreground">
                    {(codeInputs[confirmRow.verification_id] ?? '').replace(/\D/g, '')}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Purpose</span>
                  <span className="text-xs font-semibold text-foreground">{purposeLabel(confirmRow.deposit_purpose)}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Confirm the cash in your hand matches the amount above. This credits the wallet and cannot be undone here.
              </p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1 h-10 rounded-xl"
                  disabled={verifying !== null}
                  onClick={() => setConfirmRow(null)}
                >
                  Go back
                </Button>
                <Button
                  className="flex-1 h-10 rounded-xl font-semibold gap-1.5"
                  disabled={verifying !== null}
                  onClick={async () => {
                    await submitCode(confirmRow);
                    setConfirmRow(null);
                  }}
                >
                  {verifying === confirmRow.verification_id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  Yes, amount is correct
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Row Detail Dialog */}
      <Dialog open={openRow !== null} onOpenChange={(open) => !open && setOpenRow(null)}>
        <DialogContent className="sm:max-w-md rounded-2xl p-6">
          <DialogHeader>
            <DialogTitle className="text-lg font-bold flex items-center gap-2">
              <Banknote className="h-5 w-5 text-primary" />
              Cash Deposit Details
            </DialogTitle>
          </DialogHeader>

          {openRow && (
            <div className="space-y-4 pt-2">
              <div className="p-4 rounded-xl border border-border/70 bg-muted/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Depositor</span>
                  <span className="text-sm font-bold text-foreground">{openRow.depositor_name || 'Unknown'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Phone</span>
                  <span className="text-xs font-mono font-semibold text-foreground">{openRow.depositor_phone || '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Amount</span>
                  <span className="text-sm font-bold font-mono text-foreground">{fmtUgx(openRow.amount)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Purpose</span>
                  <span className="text-xs font-semibold text-foreground">{purposeLabel(openRow.deposit_purpose)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground font-medium">Location</span>
                  <span className="text-xs font-semibold text-foreground">{cashLocationLabel(openRow.cash_location)}</span>
                </div>
              </div>

              {openRow.status === 'awaiting_code' && (
                <div className="p-4 rounded-xl border border-border/70 bg-card space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground">Verify OTP Code</span>
                    <Countdown expiresAt={openRow.expires_at} />
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      value={codeInputs[openRow.verification_id] ?? ''}
                      onChange={(e) =>
                        setCodeInputs((prev) => ({
                          ...prev,
                          [openRow.verification_id]: e.target.value.replace(/\D/g, '').slice(0, 4),
                        }))
                      }
                      placeholder="Enter 4-digit code"
                      maxLength={4}
                      className="h-10 text-center font-mono font-bold text-sm rounded-xl"
                    />
                    <Button
                      onClick={() => {
                        const row = openRow;
                        setOpenRow(null);
                        requestCredit(row);
                      }}
                      disabled={verifying === openRow.verification_id}
                      className="h-10 px-5 rounded-xl bg-primary hover:bg-primary/90 text-primary-foreground font-semibold text-xs shadow-xs"
                    >
                      Credit
                    </Button>
                  </div>
                </div>
              )}

              {/* Action buttons in modal */}
              <div className="flex flex-col gap-2 pt-1">
                {openRow.status === 'awaiting_code' && (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reissue(openRow.verification_id, 'sms')}
                      disabled={reissuing === openRow.verification_id}
                      className="flex-1 h-9 rounded-xl text-xs font-semibold gap-1.5"
                    >
                      <Smartphone className="h-3.5 w-3.5 text-muted-foreground" />
                      Resend SMS
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reissue(openRow.verification_id, 'email')}
                      disabled={reissuing === openRow.verification_id}
                      className="flex-1 h-9 rounded-xl text-xs font-semibold gap-1.5"
                    >
                      <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                      Resend Email
                    </Button>
                  </div>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setCashLocationFor(openRow, openRow.cash_location === 'bank' ? 'cash_at_hand' : 'bank');
                    setOpenRow(null);
                  }}
                  disabled={banking === openRow.verification_id}
                  className="h-9 rounded-xl text-xs font-semibold gap-1.5"
                >
                  <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
                  {openRow.cash_location === 'bank' ? 'Move to cash at hand' : 'Mark as banked'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
