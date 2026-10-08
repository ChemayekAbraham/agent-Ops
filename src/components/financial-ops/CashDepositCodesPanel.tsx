import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { KeyRound, RefreshCw, Loader2, Check, Clock, Radio, Smartphone, Search, Inbox, X, ChevronDown, ArrowLeft, BarChart3, CheckCircle2, Menu, Building2, Banknote, Mail } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { StartCashDepositDialog } from './StartCashDepositDialog';

interface CashCodeRow {
  verification_id: string;
  deposit_request_id: string;
  depositor_name: string | null;
  wallet_holder_name?: string | null;
  cash_owner_name?: string | null;
  depositor_phone: string | null;
  amount: number | null;
  code: string | null; // only present while awaiting & not expired
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

const purposeLabel = (p: string | null) =>
  p === 'operational_float' ? 'Operational Float' : p === 'other' ? 'Other' : 'Personal Deposit';

const cashLocationLabel = (loc: string | null) =>
  loc === 'bank' ? 'Banked' : 'Cash at hand';

const cashLocationIcon = (loc: string | null) =>
  loc === 'bank' ? 'Building2' : 'Banknote';

// Muted tonal avatars, same calm palette as the Gmail-style email inbox.
const AVATAR_TONES = [
  'bg-rose-500/12 text-rose-600', 'bg-amber-500/12 text-amber-600',
  'bg-emerald-500/12 text-emerald-600', 'bg-sky-500/12 text-sky-600',
  'bg-indigo-500/12 text-indigo-600', 'bg-violet-500/12 text-violet-600',
  'bg-teal-500/12 text-teal-600', 'bg-orange-500/12 text-orange-600',
];

function toneFor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

/** Gmail-style date column: time for today, "MMM d" otherwise. */
function gmailDate(iso?: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Gmail groups its inbox under date rollups: Today, Yesterday, then dates. */
function dateGroupLabel(iso?: string | null) {
  if (!iso) return 'No date';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'No date';
  const now = new Date();
  const dayKey = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (dayKey(d) === dayKey(now)) return 'Today';
  if (dayKey(d) === dayKey(new Date(now.getTime() - 86_400_000))) return 'Yesterday';
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, sameYear
    ? { weekday: 'short', month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'awaiting_code')
    return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30">Awaiting code</Badge>;
  if (status === 'verified')
    return <Badge className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30">Verified</Badge>;
  return <Badge variant="outline" className="text-muted-foreground capitalize">{status.replace(/_/g, ' ')}</Badge>;
}

function CashLocationBadge({ location }: { location: string | null }) {
  const isBank = location === 'bank';
  return (
    <Badge variant="outline" className={`text-[10px] gap-1 ${isBank ? 'border-sky-500/30 text-sky-600 bg-sky-500/10' : 'border-emerald-500/30 text-emerald-600 bg-emerald-500/10'}`}>
      {isBank ? <Building2 className="h-3 w-3" /> : <Banknote className="h-3 w-3" />}
      {cashLocationLabel(location)}
    </Badge>
  );
}

function DeliveryBadge({ channel }: { channel: string | null }) {
  const normalized = channel?.toLowerCase() ?? '';
  const bySms = normalized.includes('sms');
  const byEmail = normalized.includes('email');

  if (bySms && byEmail) {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">
        <Smartphone className="h-3 w-3" />
        <Mail className="h-3 w-3" />
        Delivered by SMS &amp; email
      </Badge>
    );
  }
  if (byEmail) {
    return (
      <Badge variant="outline" className="gap-1 border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-600">
        <Mail className="h-3 w-3" /> Delivered by email
      </Badge>
    );
  }
  if (bySms) {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">
        <Smartphone className="h-3 w-3" /> Delivered by SMS
      </Badge>
    );
  }
  if (normalized === 'failed') {
    return <Badge variant="outline" className="border-destructive/30 bg-destructive/5 text-[10px] text-destructive">Delivery failed</Badge>;
  }
  if (normalized === 'fin_ops_panel') {
    return <Badge variant="outline" className="text-[10px] text-muted-foreground">Available in panel</Badge>;
  }
  return <Badge variant="outline" className="text-[10px] text-muted-foreground">Delivery not recorded</Badge>;
}

/** Live mm:ss countdown to expiry; color shifts from emerald → amber → rose as time runs low. */
function Countdown({ expiresAt, inline = false }: { expiresAt: string | null; inline?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);
  if (!expiresAt) return <span className="text-muted-foreground">—</span>;
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return <span className="text-rose-500 font-medium">expired</span>;
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  // Color tier: >90s emerald, 31-90s amber, ≤30s rose
  const colorClass =
    ms > 90_000
      ? 'text-emerald-600'
      : ms > 30_000
        ? 'text-amber-600'
        : 'text-rose-600 animate-pulse';
  return (
    <span className={`inline-flex items-center gap-1 font-medium tabular-nums ${colorClass} ${inline ? 'text-xs' : 'text-sm'}`}>
      <Clock className="h-3 w-3" />
      {mm}:{String(ss).padStart(2, '0')}
    </span>
  );
}

/**
 * Financial Ops view of recent CASH deposit codes. The plaintext code is sent
 * to the verifier inbox by `cash-deposit-request-code`; this panel surfaces it
 * in-app via the role-gated `fin_ops_recent_cash_codes` RPC so the operator can
 * read it back to the depositor without opening the shared mailbox. The actual
 * code is only revealed while the deposit is still awaiting the code and not
 * expired — crediting still requires the depositor to enter it.
 */
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
  const [realtimeHealthy, setRealtimeHealthy] = useState(false);
  const [secondsToRefresh, setSecondsToRefresh] = useState<number>(3);
  const [reissuing, setReissuing] = useState<string | null>(null);
  const [codeInputs, setCodeInputs] = useState<Record<string, string>>({});
  const [verifying, setVerifying] = useState<string | null>(null);
  const [banking, setBanking] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fast fallback poll while realtime is down; relaxed safety-net poll while it's healthy.
  const FAST_POLL_SECONDS = 3;
  const SAFETY_POLL_SECONDS = 15;
  const pollSeconds = realtimeHealthy ? SAFETY_POLL_SECONDS : FAST_POLL_SECONDS;

  const load = useCallback(async () => {
    const { data, error } = await (supabase.rpc as any)('fin_ops_recent_cash_codes', { p_limit: 50 });
    if (error) {
      if (/not_authorized/i.test(error.message)) setDenied(true);
      else setLoadError(error.message);
      setLoading(false);
      return;
    }
    setLoadError(null);
    setRows((data ?? []) as CashCodeRow[]);
    setLoading(false);
    setLastRefreshedAt(Date.now());
  }, []);

  // Adaptive polling fallback: keeps codes fresh even if realtime events stop
  // arriving. Cadence tightens automatically whenever realtime is unhealthy.
  useEffect(() => {
    load();
    setSecondsToRefresh(pollSeconds);
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(load, pollSeconds * 1_000);
    // Countdown ticker so the UI shows when the next safety refresh happens
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = setInterval(() => {
      setSecondsToRefresh((prev) => (prev > 1 ? prev - 1 : pollSeconds));
    }, 1_000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [load, pollSeconds]);

  // Refetch immediately when the tab regains focus/visibility — covers the case
  // where realtime dropped silently while the tab was backgrounded.
  useEffect(() => {
    const onActive = () => {
      if (document.visibilityState === 'visible') load();
    };
    window.addEventListener('focus', onActive);
    document.addEventListener('visibilitychange', onActive);
    return () => {
      window.removeEventListener('focus', onActive);
      document.removeEventListener('visibilitychange', onActive);
    };
  }, [load]);

  // Realtime subscription for instant updates when new cash deposit verifications are created
  useEffect(() => {
    const channel = supabase
      .channel('cash-deposit-codes-panel')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'cash_deposit_verifications',
        },
        () => {
          // New or updated verification — refresh immediately
          load();
        },
      )
      .subscribe((status) => {
        // Mark realtime healthy only when fully subscribed; any error/closure
        // flips us back to the fast fallback polling cadence.
        if (status === 'SUBSCRIBED') {
          setRealtimeHealthy(true);
          load();
        } else if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED'
        ) {
          setRealtimeHealthy(false);
        }
      });
    return () => {
      setRealtimeHealthy(false);
      supabase.removeChannel(channel);
    };
  }, [load]);


  const reissue = async (verificationId: string, channel: 'sms' | 'email' = 'sms') => {
    setReissuing(verificationId);
    // Must go through the edge function: it rotates the code AND actually
    // delivers the SMS. The old RPC only rotated the code in the database, so
    // the depositor never received anything.
    const { data, error } = await supabase.functions.invoke('finops-cash-deposit-resend', {
      body: { verification_id: verificationId, send_email: channel === 'email' },
    });
    setReissuing(null);
    const payload = data as {
      ok?: boolean; error?: string; message?: string;
      depositor_phone?: string; depositor_email?: string;
      sms_sent?: boolean; email_sent?: boolean;
    } | null;
    if (error || payload?.error) {
      let detail = payload?.message || payload?.error || error?.message || null;
      const ctx = (error as any)?.context;
      if (!payload?.message && ctx?.text) {
        try {
          const parsed = JSON.parse(await ctx.text());
          detail = parsed?.message || parsed?.error || detail;
        } catch {
          /* keep detail */
        }
      }
      toast({
        title: 'Code not delivered',
        description: detail || 'Could not resend the code.',
        variant: 'destructive',
      });
      load();
      return;
    }
    const channels = [
      payload?.sms_sent ? `SMS to ${payload?.depositor_phone ?? 'their phone'}` : null,
      payload?.email_sent ? `email to ${payload?.depositor_email ?? 'their inbox'}` : null,
    ].filter(Boolean) as string[];
    toast({
      title: 'New code sent',
      description: `${channels.length ? `Delivered by ${channels.join(' and ')}` : 'Delivered to the depositor'}. Valid for 10 minutes.`,
    });
    load();
  };

  // Operator entry: the depositor reads the SMS code back and Financial Ops
  // types it here. The edge function credits the DEPOSITOR's wallet.
  const submitCode = async (row: CashCodeRow) => {
    const entered = (codeInputs[row.verification_id] ?? '').replace(/\D/g, '');
    if (entered.length !== 4) {
      toast({ title: 'Enter the 4-digit code', description: 'The depositor must read back all 4 digits.', variant: 'destructive' });
      return;
    }
    setVerifying(row.verification_id);
    const { data, error } = await supabase.functions.invoke('cash-deposit-verify-code', {
      body: { deposit_request_id: row.deposit_request_id, code: entered, on_behalf: true },
    });
    setVerifying(null);
    const payloadError = (data as any)?.error ? ((data as any)?.message || (data as any)?.error) : null;
    if (error || payloadError) {
      toast({
        title: 'Code not accepted',
        description: payloadError || error?.message || 'Could not verify this code.',
        variant: 'destructive',
      });
      load();
      return;
    }
    setCodeInputs((prev) => ({ ...prev, [row.verification_id]: '' }));
    toast({
      title: 'Deposit verified',
      description: `${fmtUgx(row.amount)} credited to ${row.depositor_name || 'the depositor'}'s wallet.`,
    });
    load();
  };

  const [startOpen, setStartOpen] = useState(false);

  // Financial Ops marks where the physical cash now sits (banked vs still at hand).
  const setCashLocationFor = async (row: CashCodeRow, location: 'bank' | 'cash_at_hand') => {
    setBanking(row.verification_id);
    const { error } = await (supabase.rpc as any)('fin_ops_set_cash_location', {
      p_deposit_request_id: row.deposit_request_id,
      p_location: location,
    });
    setBanking(null);
    if (error) {
      const msg = /deposit_not_verified/i.test(error.message)
        ? 'This deposit was never credited (its first code window expired, so it was auto-rejected). Resend the code and have the depositor read it back — then you can bank it.'
        : /invalid_deposit_amount/i.test(error.message)
          ? 'This deposit has no valid amount to bank.'
          : /not_authorized/i.test(error.message)
            ? 'You do not have permission to change this.'
            : error.message;
      toast({
        title: 'Could not update',
        description: msg,
        variant: 'destructive',
      });
      return;
    }
    setRows((prev) =>
      prev.map((r) => (r.deposit_request_id === row.deposit_request_id ? { ...r, cash_location: location } : r)),
    );
    toast({
      title: location === 'bank' ? 'Marked as banked' : 'Marked as cash at hand',
      description:
        location === 'bank'
          ? `${fmtUgx(row.amount)} posted to Treasury · ${row.depositor_name || 'depositor'}`
          : `${fmtUgx(row.amount)} returned to cash in transit · ${row.depositor_name || 'depositor'}`,
    });
    load();
  };

  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'awaiting' | 'verified'>('all');
  const [cashLocation, setCashLocation] = useState<'all' | 'cash_at_hand' | 'bank'>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  const [range, setRange] = useState<'today' | '7d' | '30d' | 'all'>('today');
  const [view, setView] = useState<'inbox' | 'report'>('inbox');
  const [navOpen, setNavOpen] = useState(false);

  const rangeStart = (() => {
    const now = new Date();
    if (range === 'today') return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (range === '7d') return now.getTime() - 7 * 86400000;
    if (range === '30d') return now.getTime() - 30 * 86400000;
    return 0;
  })();

  const rangeRows = rows.filter((r) => {
    const inRange = !r.created_at ? range === 'all' : new Date(r.created_at).getTime() >= rangeStart;
    const inLocation = cashLocation === 'all' || r.cash_location === cashLocation;
    return inRange && inLocation;
  });

  const activeRows = rangeRows.filter(
    (r) => r.status === 'awaiting_code' && r.expires_at && new Date(r.expires_at).getTime() > Date.now(),
  );

  const activeCount = activeRows.length;

  const totalVerified = rangeRows
    .filter((r) => r.status === 'verified')
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);

  const totalPending = activeRows.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  const isLive = (r: CashCodeRow) =>
    r.status === 'awaiting_code' && !!r.expires_at && new Date(r.expires_at).getTime() > Date.now();

  const q = query.trim().toLowerCase();
  // Show every recent code — including expired ones — so verifiers can still
  // read a code back to a depositor after the active window has lapsed.
  const displayRows = rangeRows
    .filter((r) => (tab === 'all' ? true : tab === 'awaiting' ? r.status === 'awaiting_code' : r.status === 'verified'))
    .filter((r) =>
      !q
        ? true
        : [r.depositor_name, r.wallet_holder_name, r.depositor_phone, purposeLabel(r.deposit_purpose), cashLocationLabel(r.cash_location), String(r.amount ?? '')]
            .join(' ')
            .toLowerCase()
            .includes(q),
    );

  const openRow = openId ? displayRows.find((r) => r.verification_id === openId) ?? null : null;

  const tabs: { key: 'all' | 'awaiting' | 'verified'; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: rangeRows.length },
    { key: 'awaiting', label: 'Awaiting', count: rangeRows.filter((r) => r.status === 'awaiting_code').length },
    { key: 'verified', label: 'Verified', count: rangeRows.filter((r) => r.status === 'verified').length },
  ];

  // Per-day rollups: verified cash actually banked vs cash still awaiting a code.
  const dayKeyOf = (iso?: string | null) => (iso ? new Date(iso).toDateString() : 'unknown');
  const dayTotals = new Map<string, { verified: number; awaiting: number; count: number }>();
  for (const r of rangeRows) {
    const k = dayKeyOf(r.created_at);
    const e = dayTotals.get(k) ?? { verified: 0, awaiting: 0, count: 0 };
    if (r.status === 'verified') e.verified += r.amount ?? 0;
    else if (r.status === 'awaiting_code') e.awaiting += r.amount ?? 0;
    e.count += 1;
    dayTotals.set(k, e);
  }

  const chartData = Array.from(dayTotals.entries())
    .filter(([k]) => k !== 'unknown')
    .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
    .map(([k, v]) => ({
      label: new Date(k).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
      verified: v.verified,
      awaiting: v.awaiting,
      count: v.count,
    }));

  const navItems: { key: 'all' | 'awaiting' | 'verified' | 'report'; label: string; icon: typeof Inbox; count?: number }[] = [
    { key: 'all', label: 'All', icon: Inbox, count: rangeRows.length },
    { key: 'awaiting', label: 'Awaiting', icon: Clock, count: rangeRows.filter((r) => r.status === 'awaiting_code').length },
    { key: 'verified', label: 'Verified', icon: CheckCircle2, count: rangeRows.filter((r) => r.status === 'verified').length },
    { key: 'report', label: 'Cashflow', icon: BarChart3 },
  ];

  const selectNav = (key: 'all' | 'awaiting' | 'verified' | 'report') => {
    setOpenId(null);
    setNavOpen(false);
    if (key === 'report') { setView('report'); return; }
    setView('inbox');
    setTab(key);
  };

  const sideNav = (
    <nav className="p-2 space-y-0.5">
      {navItems.map((n) => {
        const active = n.key === 'report' ? view === 'report' : view === 'inbox' && tab === n.key;
        const Icon = n.icon;
        return (
          <button
            key={n.key}
            onClick={() => selectNav(n.key)}
            className={`w-full flex items-center gap-3 rounded-full px-3 py-2 text-sm transition-colors ${
              active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{n.label}</span>
            {typeof n.count === 'number' && (
              <span className="ml-auto text-xs tabular-nums opacity-70">{n.count}</span>
            )}
          </button>
        );
      })}
    </nav>
  );

  const ranges: { key: 'today' | '7d' | '30d' | 'all'; label: string }[] = [
    { key: 'today', label: 'Today' },
    { key: '7d', label: '7 days' },
    { key: '30d', label: '30 days' },
    { key: 'all', label: 'All time' },
  ];

  const codeEntry = (r: CashCodeRow, size: 'row' | 'pane') => (
    <div className="flex items-center gap-1.5">
      <Input
        inputMode="numeric"
        maxLength={4}
        placeholder="0000"
        aria-label="Enter the 4-digit code"
        className={`${size === 'pane' ? 'h-9 w-20' : 'h-8 w-16'} text-center font-mono tracking-widest`}
        value={codeInputs[r.verification_id] ?? ''}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) =>
          setCodeInputs((prev) => ({
            ...prev,
            [r.verification_id]: e.target.value.replace(/\D/g, '').slice(0, 4),
          }))
        }
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') void submitCode(r);
        }}
      />
      <Button
        size="sm"
        className={`${size === 'pane' ? 'h-10' : 'h-9'} gap-1.5 rounded-full text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-500/20 ring-1 ring-emerald-400/50`}
        disabled={verifying === r.verification_id || (codeInputs[r.verification_id] ?? '').length !== 4}
        onClick={(e) => { e.stopPropagation(); void submitCode(r); }}
      >
        {verifying === r.verification_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        Credit wallet
      </Button>
    </div>
  );

  const resendButton = (r: CashCodeRow) => (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1 rounded-full text-xs"
        disabled={reissuing === r.verification_id}
        onClick={(e) => { e.stopPropagation(); void reissue(r.verification_id, 'sms'); }}
      >
        {reissuing === r.verification_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
        Resend by SMS
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-8 gap-1 rounded-full text-xs"
        disabled={reissuing === r.verification_id}
        onClick={(e) => { e.stopPropagation(); void reissue(r.verification_id, 'email'); }}
      >
        {reissuing === r.verification_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Mail className="h-3 w-3" />}
        Resend by email
      </Button>
    </div>
  );

  const bankButton = (r: CashCodeRow, size: 'row' | 'pane' = 'row') => {
    const isBank = r.cash_location === 'bank';
    return (
      <Button
        variant="outline"
        size="sm"
        className={`${size === 'pane' ? 'h-10' : 'h-8'} gap-1 rounded-full text-xs ${
          isBank
            ? 'border-emerald-500/40 text-emerald-600'
            : 'border-sky-500/40 text-sky-600 hover:bg-sky-500/10'
        }`}
        disabled={banking === r.verification_id}
        onClick={(e) => {
          e.stopPropagation();
          void setCashLocationFor(r, isBank ? 'cash_at_hand' : 'bank');
        }}
      >
        {banking === r.verification_id ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : isBank ? (
          <Banknote className="h-3 w-3" />
        ) : (
          <Building2 className="h-3 w-3" />
        )}
        {isBank ? 'Move to cash at hand' : 'Mark as banked'}
      </Button>
    );
  };

  if (denied) return null;
  return (
    <>
      <StartCashDepositDialog open={startOpen} onOpenChange={setStartOpen} onIssued={load} />

      <div
        className={
          fullScreen
            ? 'fixed inset-0 z-50 flex flex-col bg-background'
            : 'rounded-xl border bg-card overflow-hidden'
        }
      >
        {/* ── Gmail-style toolbar ─────────────────────────────────────────── */}
        <div className={`flex flex-wrap items-center gap-2 px-3 py-2.5 border-b ${fullScreen ? 'shrink-0' : ''}`}>
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full md:hidden"
              aria-label="Menu"
              onClick={() => setNavOpen((v) => !v)}
            >
              <Menu className="h-5 w-5" />
            </Button>
            {fullScreen && onClose ? (
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-full -ml-1"
                aria-label="Close"
                onClick={onClose}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
            ) : null}
            <Inbox className="h-5 w-5 text-primary shrink-0" />
            <span className="font-medium text-sm sm:text-base truncate">Cash deposit codes</span>
            {activeCount > 0 && (
              <span className="text-xs font-semibold text-primary">({activeCount})</span>
            )}
          </div>

          <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1 sm:max-w-md">
            <div className="flex items-center gap-2 rounded-full bg-muted px-3 h-9 focus-within:bg-background focus-within:ring-1 focus-within:ring-border">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search depositor, phone or amount"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {query && (
                <button aria-label="Clear search" onClick={() => setQuery('')}>
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1 ml-auto">
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full"
              aria-label="Refresh"
              title="Refresh"
              onClick={() => load()}
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            </Button>
            <Button size="sm" className="h-9 gap-1.5 rounded-full" onClick={() => setStartOpen(true)}>
              <Smartphone className="h-4 w-4" />
              <span className="hidden sm:inline">Start deposit</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </div>

        {/* ── Gmail-style layout: side nav + content ──────────────────────── */}
        <div className={`flex min-h-0 ${fullScreen ? 'flex-1' : ''}`}>
          <aside className="hidden md:block w-44 shrink-0 border-r overflow-y-auto">{sideNav}</aside>
          {navOpen && (
            <aside className="md:hidden absolute z-20 mt-0 w-44 border-r bg-background shadow-lg">{sideNav}</aside>
          )}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* ── Gmail-style category tabs ───────────────────────────────────── */}
        <div className={`flex items-center gap-1 px-2 border-b overflow-x-auto ${fullScreen ? 'shrink-0' : ''}`}>
          {tabs.map((t) => (
            <button
              key={t.key}
              onClick={() => { setTab(t.key); setOpenId(null); }}
              className={`shrink-0 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === t.key
                  ? 'border-primary text-primary font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label} <span className="text-xs opacity-70">{t.count}</span>
            </button>
          ))}
          <div className="ml-auto hidden sm:flex items-center gap-1.5 pr-2 text-[11px] text-muted-foreground">
            <Radio className={`h-3 w-3 animate-pulse ${realtimeHealthy ? 'text-emerald-500' : 'text-amber-500'}`} />
            {realtimeHealthy ? `Live · ${secondsToRefresh}s` : `Fallback · ${secondsToRefresh}s`}
          </div>
        </div>

        {/* ── Totals strip ────────────────────────────────────────────────── */}
        <div className={`flex flex-wrap items-center gap-2 px-3 py-2 border-b bg-muted/30 text-xs ${fullScreen ? 'shrink-0' : ''}`}>
          <div className="flex items-center gap-1 overflow-x-auto">
            {ranges.map((rg) => (
              <button
                key={rg.key}
                onClick={() => { setRange(rg.key); setOpenId(null); }}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] border transition-colors ${
                  range === rg.key
                    ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                    : 'bg-background border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {rg.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 overflow-x-auto">
            {[
              { key: 'all' as const, label: 'All cash' },
              { key: 'cash_at_hand' as const, label: 'Cash at hand' },
              { key: 'bank' as const, label: 'Cash banked' },
            ].map((loc) => (
              <button
                key={loc.key}
                onClick={() => { setCashLocation(loc.key); setOpenId(null); }}
                className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] border transition-colors ${
                  cashLocation === loc.key
                    ? 'bg-primary/10 border-primary/30 text-primary font-medium'
                    : 'bg-background border-border text-muted-foreground hover:text-foreground'
                }`}
              >
                {loc.label}
              </button>
            ))}
          </div>
          <span className="text-muted-foreground">
            Verified cash <span className="font-semibold text-emerald-600">{fmtUgx(totalVerified)}</span>
          </span>
          <span className="text-muted-foreground">
            Awaiting <span className="font-semibold text-amber-600">{fmtUgx(totalPending)}</span>
          </span>
          <span className="ml-auto text-muted-foreground hidden sm:inline">
            Updated {new Date(lastRefreshedAt).toLocaleTimeString()}
          </span>
        </div>

        {/* ── Reading pane or inbox list ──────────────────────────────────── */}
        <div className={fullScreen ? 'flex-1 min-h-0 overflow-y-auto overscroll-contain' : ''}>
        {view === 'report' ? (
          <div className="p-3 sm:p-4 space-y-3">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-primary" />
              <h4 className="text-sm font-semibold">Cashflow over time</h4>
              <span className="ml-auto text-xs text-muted-foreground">{ranges.find((x) => x.key === range)?.label}</span>
            </div>
            <div className="h-[240px] rounded-lg border bg-card p-2">
              {chartData.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} barGap={2}>
                    <CartesianGrid strokeDasharray="3 3" opacity={0.15} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} width={44} tickFormatter={(v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`)} />
                    <Tooltip formatter={(v: number) => fmtUgx(v)} contentStyle={{ fontSize: 11 }} />
                    <Bar dataKey="verified" name="Verified" fill="hsl(var(--chart-2))" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="awaiting" name="Awaiting" fill="hsl(var(--chart-4))" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-full grid place-items-center text-xs text-muted-foreground">No cash deposits in this range</div>
              )}
            </div>
            <div className="rounded-lg border divide-y">
              {chartData.length === 0 && <div className="p-3 text-xs text-muted-foreground">Nothing to show.</div>}
              {[...chartData].reverse().map((d) => (
                <div key={d.label} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <span className="w-20 font-medium">{d.label}</span>
                  <span className="text-emerald-600 font-semibold tabular-nums">{fmtUgx(d.verified)}</span>
                  <span className="text-amber-600 tabular-nums">{fmtUgx(d.awaiting)} awaiting</span>
                  <span className="ml-auto text-muted-foreground">{d.count} codes</span>
                </div>
              ))}
            </div>
          </div>
        ) : openRow ? (
          <div className="p-4 space-y-4">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 rounded-full -ml-2"
              onClick={() => setOpenId(null)}
            >
              <ChevronDown className="h-4 w-4 rotate-90" /> Back to inbox
            </Button>

            <div>
              <h4 className="text-base font-semibold">
                Cash deposit · {fmtUgx(openRow.amount)}
              </h4>
              <div className="mt-2 flex items-start gap-3">
                <div className={`h-10 w-10 rounded-full grid place-items-center text-sm font-semibold ${toneFor(openRow.depositor_name || openRow.verification_id)}`}>
                  {(openRow.depositor_name || '?').charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{openRow.depositor_name || 'Unknown depositor'}</div>
                  {openRow.wallet_holder_name && openRow.wallet_holder_name !== openRow.depositor_name && (
                    <div className="text-xs text-muted-foreground truncate">
                      Credited to wallet of {openRow.wallet_holder_name}
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground">{openRow.depositor_phone || 'No phone on file'}</div>
                </div>
                <div className="text-xs text-muted-foreground whitespace-nowrap">{gmailDate(openRow.created_at)}</div>
              </div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-3 text-sm space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={openRow.status} />
                <DeliveryBadge channel={openRow.delivery_channel} />
                <Badge variant="outline" className="text-xs">{purposeLabel(openRow.deposit_purpose)}</Badge>
                <CashLocationBadge location={openRow.cash_location} />
                <Countdown expiresAt={openRow.expires_at} inline />
              </div>
              <p className="text-muted-foreground text-xs leading-relaxed">
                The 4-digit code is delivered using the channel shown above and is never shown here. Ask the depositor to read it back
                once you have received the matching cash, then enter it below. Codes expire in 10 minutes.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isLive(openRow) && codeEntry(openRow, 'pane')}
              {openRow.status !== 'verified' && resendButton(openRow)}
              {bankButton(openRow, 'pane')}
            </div>
          </div>
        ) : loading && displayRows.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : loadError ? (
          <div className="m-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Could not load cash deposit codes: {loadError}
          </div>
        ) : displayRows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            <Inbox className="h-8 w-8 mx-auto mb-2 opacity-40" />
            {q ? 'No codes match your search.' : 'No cash deposit codes yet.'}
          </div>
        ) : (
          <div className="divide-y">
            {displayRows.map((r, i) => {
              const group = dateGroupLabel(r.created_at);
              const showGroup = i === 0 || dateGroupLabel(displayRows[i - 1].created_at) !== group;
              const unread = r.status === 'awaiting_code';
              return (
                <div key={r.verification_id}>
                  {showGroup && (
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-muted/40 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
                      <span>{group}</span>
                      <span className="ml-auto normal-case tracking-normal">
                        <span className="text-emerald-600 font-semibold">{fmtUgx(dayTotals.get(dayKeyOf(r.created_at))?.verified ?? 0)}</span>
                        {' verified · '}
                        <span className="text-amber-600 font-semibold">{fmtUgx(dayTotals.get(dayKeyOf(r.created_at))?.awaiting ?? 0)}</span>
                        {' awaiting'}
                      </span>
                    </div>
                  )}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setOpenId(r.verification_id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(r.verification_id); }}
                    className={`group flex items-center gap-3 px-3 py-2.5 cursor-pointer transition-colors hover:bg-muted/50 ${
                      unread ? 'bg-background' : 'bg-muted/10'
                    }`}
                  >
                    <div className={`h-8 w-8 shrink-0 rounded-full grid place-items-center text-xs font-semibold ${toneFor(r.depositor_name || r.verification_id)}`}>
                      {(r.depositor_name || '?').charAt(0).toUpperCase()}
                    </div>

                    <div className={`w-28 sm:w-40 shrink-0 truncate text-sm ${unread ? 'font-semibold' : 'text-muted-foreground'}`}>
                      {r.depositor_name || 'Unknown'}
                    </div>

                    <div className="min-w-0 flex-1 flex items-baseline gap-1.5">
                      <span className={`truncate text-sm ${unread ? 'font-semibold' : ''}`}>
                        {fmtUgx(r.amount)}
                      </span>
                      <span className="hidden sm:inline text-xs text-muted-foreground truncate">
                        — {purposeLabel(r.deposit_purpose)}
                        {r.cash_location ? ` · ${cashLocationLabel(r.cash_location)}` : ''}
                        {r.depositor_phone ? ` · ${r.depositor_phone}` : ''}
                        {r.wallet_holder_name && r.wallet_holder_name !== r.depositor_name
                          ? ` · wallet: ${r.wallet_holder_name}`
                          : ''}
                      </span>
                    </div>

                    <div className="hidden md:flex items-center gap-2 shrink-0">
                      <DeliveryBadge channel={r.delivery_channel} />
                      <CashLocationBadge location={r.cash_location} />
                      <StatusBadge status={r.status} />
                      <Countdown expiresAt={r.expires_at} inline />
                    </div>

                    {/* Gmail reveals row actions on hover; here they stay reachable on touch too. */}
                    <div className="shrink-0 flex items-center gap-1.5">
                      {isLive(r) ? (
                        <div className="hidden lg:block">{codeEntry(r, 'row')}</div>
                      ) : null}
                      <div className="hidden sm:block">{bankButton(r)}</div>
                      <span className="text-[11px] text-muted-foreground w-14 text-right group-hover:opacity-0 transition-opacity">
                        {gmailDate(r.created_at)}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        </div>
          </div>
        </div>
      </div>
    </>
  );
}
