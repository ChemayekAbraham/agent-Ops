import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ArrowDownCircle, ArrowUpCircle, Wallet, Info, Calendar, X, ChevronRight, Copy, Check, TrendingUp, TrendingDown, Minus, Search, Download, FileText, Phone, MessageCircle, Users } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCurrency } from '@/hooks/useCurrency';
import { hapticTap } from '@/lib/haptics';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { TenantProfileView } from '@/components/agent/TenantProfileView';

interface FloatRow {
  entry_id: string;
  occurred_at: string;
  category: string;
  direction: string;
  amount: number;
  signed_amount: number;
  running_balance: number;
  description: string | null;
  transaction_group_id: string | null;
  linked_party: string | null;
  reference_id: string | null;
}

interface SiblingLeg {
  id: string;
  user_id: string | null;
  user_name: string | null;
  category: string;
  direction: 'cash_in' | 'cash_out';
  amount: number;
  ledger_scope: string;
  wallet_bucket: string | null;
  recipient_type: string | null;
  account: string | null;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  created_at: string;
  is_self: boolean;
}

interface EntryDetail {
  entry: {
    id: string;
    created_at: string;
    transaction_date: string;
    category: string;
    direction: 'cash_in' | 'cash_out';
    amount: number;
    description: string | null;
    reference_id: string | null;
    linked_party: string | null;
    linked_party_name: string | null;
    source_table: string | null;
    source_id: string | null;
    transaction_group_id: string | null;
    wallet_bucket: string | null;
    recipient_type: string | null;
    account: string | null;
    currency: string | null;
    idempotency_key: string | null;
  };
  siblings: SiblingLeg[];
}

interface FloatAllocation {
  use_entry_id: string;
  occurred_at: string;
  category: string;
  use_amount: number;
  allocated_amount: number;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  description: string | null;
  reference_id: string | null;
}

const CATEGORY_LABEL: Record<string, string> = {
  agent_float_deposit: 'Float Deposit',
  agent_float_used_for_rent: 'Tenant Rent Allocation',
  agent_float_settlement: 'Float Settlement',
  rent_float_funding: 'Landlord Rent Funding',
  rent_payment_for_tenant: 'Tenant Rent Allocation',
  partner_funding: 'Partner Funding',
  wallet_deduction: 'Admin Float Correction',
  system_balance_correction: 'Admin Float Correction',
};

function labelFor(cat: string): string {
  return CATEGORY_LABEL[cat] ?? cat.replace(/_/g, ' ');
}

type Preset = 'all' | '7d' | '30d' | 'month' | 'custom';

function toInputDate(d: Date): string {
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

export default function AgentFloatBreakdown() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { formatAmount } = useCurrency();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rows, setRows] = useState<FloatRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [preset, setPreset] = useState<Preset>(() => {
    const p = searchParams.get('preset');
    return (['all','7d','30d','month','custom'] as Preset[]).includes(p as Preset) ? (p as Preset) : 'all';
  });
  const [fromDate, setFromDate] = useState<string>(() => searchParams.get('from') ?? '');
  const [toDate, setToDate] = useState<string>(() => searchParams.get('to') ?? '');
  const [search, setSearch] = useState<string>(() => searchParams.get('q') ?? '');
  const [selected, setSelected] = useState<FloatRow | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [allocations, setAllocations] = useState<FloatAllocation[] | null>(null);
  const [allocLoading, setAllocLoading] = useState(false);
  const [allocErr, setAllocErr] = useState<string | null>(null);
  const [allocSearch, setAllocSearch] = useState('');
  const [allocFromDate, setAllocFromDate] = useState('');
  const [allocToDate, setAllocToDate] = useState('');
  const [viewingTenantId, setViewingTenantId] = useState<string | null>(null);

  // Sync filter state → URL (replace so back button isn't polluted)
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDel = (k: string, v: string, defaultVal = '') => {
      if (v && v !== defaultVal) next.set(k, v);
      else next.delete(k);
    };
    setOrDel('preset', preset, 'all');
    setOrDel('from', fromDate);
    setOrDel('to', toDate);
    setOrDel('q', search);
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, fromDate, toDate, search]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      const { data, error } = await supabase.rpc('get_agent_float_breakdown', {
        p_user_id: user.id,
        p_limit: 500,
      });
      if (cancelled) return;
      if (error) setErr(error.message);
      else setRows((data ?? []) as FloatRow[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Load full detail when a row is selected
  useEffect(() => {
    if (!selected || !user?.id) return;
    let cancelled = false;
    setDetailLoading(true);
    setDetailErr(null);
    setDetail(null);
    (async () => {
      const { data, error } = await supabase.rpc('get_float_entry_detail', {
        p_user_id: user.id,
        p_entry_id: selected.entry_id,
      });
      if (cancelled) return;
      if (error) setDetailErr(error.message);
      else setDetail(data as unknown as EntryDetail);
      setDetailLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selected, user?.id]);

  // For float deposits (cash_in), load the tenant rent transactions this
  // specific deposit funded via FIFO matching.
  useEffect(() => {
    if (!selected || !user?.id || selected.signed_amount <= 0) {
      setAllocations(null);
      return;
    }
    let cancelled = false;
    setAllocLoading(true);
    setAllocErr(null);
    setAllocations(null);
    (async () => {
      const { data, error } = await supabase.rpc('get_float_deposit_allocations', {
        p_user_id: user.id,
        p_entry_id: selected.entry_id,
      });
      if (cancelled) return;
      if (error) setAllocErr(error.message);
      else setAllocations((data ?? []) as FloatAllocation[]);
      setAllocLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selected, user?.id]);

  // Clear allocation filters when a different row is selected
  useEffect(() => {
    setAllocSearch('');
    setAllocFromDate('');
    setAllocToDate('');
    setViewingTenantId(null);
  }, [selected?.entry_id]);

  async function copyToClipboard(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      hapticTap();
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch { /* noop */ }
  }

  const currentFloat = rows[0]?.running_balance ?? 0;

  const filteredRows = useMemo(() => {
    const fromMs = fromDate ? new Date(fromDate + 'T00:00:00').getTime() : -Infinity;
    const toMs = toDate ? new Date(toDate + 'T23:59:59.999').getTime() : Infinity;
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      const t = new Date(r.occurred_at).getTime();
      if (t < fromMs || t > toMs) return false;
      if (!q) return true;
      return (
        (r.reference_id ?? '').toLowerCase().includes(q) ||
        (r.transaction_group_id ?? '').toLowerCase().includes(q) ||
        (r.entry_id ?? '').toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, fromDate, toDate, search]);

  const totalIn = filteredRows.filter(r => r.signed_amount > 0).reduce((s, r) => s + Number(r.signed_amount), 0);
  const totalOut = filteredRows.filter(r => r.signed_amount < 0).reduce((s, r) => s + Number(r.signed_amount), 0);

  const filteredAllocations = useMemo(() => {
    if (!allocations) return [];
    const fromMs = allocFromDate ? new Date(allocFromDate + 'T00:00:00').getTime() : -Infinity;
    const toMs = allocToDate ? new Date(allocToDate + 'T23:59:59.999').getTime() : Infinity;
    const q = allocSearch.trim().toLowerCase();
    return allocations.filter((a) => {
      const t = new Date(a.occurred_at).getTime();
      if (t < fromMs || t > toMs) return false;
      if (!q) return true;
      return (
        (a.tenant_name ?? '').toLowerCase().includes(q) ||
        (a.tenant_phone ?? '').toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q) ||
        (a.reference_id ?? '').toLowerCase().includes(q) ||
        (a.category ?? '').toLowerCase().includes(q)
      );
    });
  }, [allocations, allocFromDate, allocToDate, allocSearch]);

  function rangeSuffix(): string {
    if (fromDate && toDate) return `${fromDate}_to_${toDate}`;
    if (fromDate) return `from_${fromDate}`;
    if (toDate) return `until_${toDate}`;
    return 'all-time';
  }

  function rangeLabel(): string {
    if (fromDate && toDate) return `${fromDate} to ${toDate}`;
    if (fromDate) return `From ${fromDate}`;
    if (toDate) return `Until ${toDate}`;
    return 'All-time';
  }

  // Build per-row running totals (deposits, used, net) computed chronologically
  // (oldest → newest) within the currently filtered range, then keyed by entry_id
  // so they can be emitted in whatever display order we want.
  function buildRunningTotals(): Map<string, { runDeposits: number; runUsed: number; runNet: number }> {
    const chrono = [...filteredRows].sort(
      (a, b) => new Date(a.occurred_at).getTime() - new Date(b.occurred_at).getTime(),
    );
    const map = new Map<string, { runDeposits: number; runUsed: number; runNet: number }>();
    let runDeposits = 0;
    let runUsed = 0;
    for (const r of chrono) {
      const signed = Number(r.signed_amount);
      if (signed > 0) runDeposits += signed;
      else if (signed < 0) runUsed += Math.abs(signed);
      map.set(r.entry_id, { runDeposits, runUsed, runNet: runDeposits - runUsed });
    }
    return map;
  }

  function exportCsv() {
    hapticTap();
    const headers = [
      'Date',
      'Category',
      'Direction',
      'Amount (UGX)',
      'Signed Amount (UGX)',
      'Running Deposits (UGX)',
      'Running Used (UGX)',
      'Running Net (UGX)',
      'Reference ID',
      'Transaction Group',
      'Entry ID',
      'Description',
    ];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const totals = buildRunningTotals();
    const lines = [headers.join(',')];
    for (const r of filteredRows) {
      const t = totals.get(r.entry_id) ?? { runDeposits: 0, runUsed: 0, runNet: 0 };
      lines.push([
        new Date(r.occurred_at).toISOString(),
        labelFor(r.category),
        r.direction,
        Number(r.amount),
        Number(r.signed_amount),
        t.runDeposits,
        t.runUsed,
        t.runNet,
        r.reference_id ?? '',
        r.transaction_group_id ?? '',
        r.entry_id,
        r.description ?? '',
      ].map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `float-breakdown_${rangeSuffix()}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function exportPdf() {
    hapticTap();
    const [{ default: jsPDF }, autoTableMod] = await Promise.all([
      import('jspdf'),
      import('jspdf-autotable'),
    ]);
    const autoTable = (autoTableMod as any).default ?? (autoTableMod as any).autoTable;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageWidth = doc.internal.pageSize.getWidth();

    doc.setFontSize(14);
    doc.setFont('helvetica', 'bold');
    doc.text('Agent Float Breakdown', 40, 40);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'normal');
    doc.text(`Range: ${rangeLabel()}`, 40, 58);
    doc.text(`Generated: ${new Date().toLocaleString()}`, 40, 72);

    doc.setFontSize(10);
    doc.text(
      `Current Float: ${formatAmount(Number(currentFloat))}    Deposits In: ${formatAmount(totalIn)}    Used / Out: ${formatAmount(Math.abs(totalOut))}    Net: ${formatAmount(totalIn + totalOut)}`,
      40,
      90,
    );

    autoTable(doc, {
      startY: 105,
      head: [[
        'Date',
        'Category',
        'Dir',
        'Amount',
        'Signed',
        'Run. Deposits',
        'Run. Used',
        'Run. Net',
        'Reference ID',
        'Description',
      ]],
      body: (() => {
        const totals = buildRunningTotals();
        return filteredRows.map((r) => {
          const t = totals.get(r.entry_id) ?? { runDeposits: 0, runUsed: 0, runNet: 0 };
          return [
            new Date(r.occurred_at).toLocaleString(),
            labelFor(r.category),
            r.direction === 'cash_in' ? 'IN' : 'OUT',
            formatAmount(Number(r.amount)),
            formatAmount(Number(r.signed_amount)),
            formatAmount(t.runDeposits),
            formatAmount(t.runUsed),
            formatAmount(t.runNet),
            r.reference_id ?? '',
            r.description ?? '',
          ];
        });
      })(),
      styles: { fontSize: 8, cellPadding: 4 },
      headStyles: { fillColor: [30, 41, 59], textColor: 255 },
      margin: { left: 40, right: 40 },
      didDrawPage: () => {
        const pageNum = (doc as any).internal.getNumberOfPages();
        doc.setFontSize(8);
        doc.text(`Page ${pageNum}`, pageWidth - 60, doc.internal.pageSize.getHeight() - 20);
      },
    });

    doc.save(`float-breakdown_${rangeSuffix()}.pdf`);
  }

  function applyPreset(p: Preset) {
    setPreset(p);
    const now = new Date();
    if (p === 'all') { setFromDate(''); setToDate(''); return; }
    if (p === '7d') {
      const from = new Date(now); from.setDate(from.getDate() - 6);
      setFromDate(toInputDate(from)); setToDate(toInputDate(now)); return;
    }
    if (p === '30d') {
      const from = new Date(now); from.setDate(from.getDate() - 29);
      setFromDate(toInputDate(from)); setToDate(toInputDate(now)); return;
    }
    if (p === 'month') {
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      setFromDate(toInputDate(from)); setToDate(toInputDate(now)); return;
    }
  }

  const presets: { key: Preset; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: '7d', label: '7 days' },
    { key: '30d', label: '30 days' },
    { key: 'month', label: 'This month' },
    { key: 'custom', label: 'Custom' },
  ];

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur border-b">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <button
            onClick={() => { hapticTap(); navigate(-1); }}
            className="p-2 -ml-2 rounded-lg hover:bg-muted active:scale-95"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-base font-bold">Float Breakdown</h1>
            <p className="text-xs text-muted-foreground">Every deposit and tenant allocation</p>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 pt-4 space-y-4">
        {/* Summary card */}
        <div className="rounded-2xl border bg-card p-4">
          <div className="flex items-center gap-2 mb-3">
            <Wallet className="h-4 w-4 text-blue-500" />
            <span className="text-[11px] uppercase tracking-wider font-bold text-muted-foreground">Current Float</span>
          </div>
          <p className="text-3xl font-black tracking-tight">{formatAmount(Number(currentFloat))}</p>
          <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
            Company money you are holding right now to pay tenant rent on Welile's behalf. Not your earnings.
          </p>
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="rounded-xl bg-emerald-500/10 p-3">
              <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <ArrowDownCircle className="h-3.5 w-3.5" />
                <span className="text-[10px] uppercase font-bold tracking-wider">Deposits In</span>
              </div>
              <p className="text-lg font-bold mt-1">{formatAmount(totalIn)}</p>
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                Total float that landed in your wallet from MoMo, cash, or transfers during this period.
              </p>
            </div>
            <div className="rounded-xl bg-rose-500/10 p-3">
              <div className="flex items-center gap-1.5 text-rose-600 dark:text-rose-400">
                <ArrowUpCircle className="h-3.5 w-3.5" />
                <span className="text-[10px] uppercase font-bold tracking-wider">Used / Out</span>
              </div>
              <p className="text-lg font-bold mt-1">{formatAmount(Math.abs(totalOut))}</p>
              <p className="text-[10px] text-muted-foreground mt-1 leading-snug">
                Total float spent on tenant rent allocations or removed by admin corrections during this period.
              </p>
            </div>
          </div>

          {/* Net movement */}
          {(() => {
            const net = totalIn + totalOut; // totalOut is already negative
            const isPositive = net > 0;
            const isZero = net === 0;
            const Icon = isZero ? Minus : isPositive ? TrendingUp : TrendingDown;
            const tone = isZero
              ? 'text-muted-foreground bg-muted/40'
              : isPositive
                ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                : 'text-rose-600 dark:text-rose-400 bg-rose-500/10';
            const rangeLabel = fromDate || toDate ? 'in selected range' : 'all-time';
            return (
              <TooltipProvider delayDuration={150}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => hapticTap()}
                      className={`mt-3 w-full text-left rounded-xl p-3 ${tone} focus:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
                      aria-label={`Net float movement ${formatAmount(Math.abs(net))} ${rangeLabel}. Deposits ${formatAmount(totalIn)}, used ${formatAmount(Math.abs(totalOut))}.`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                          <Icon className="h-4 w-4 flex-shrink-0" />
                          <div className="min-w-0">
                            <p className="text-[10px] uppercase font-bold tracking-wider">Net Float Movement</p>
                            <p className="text-[10px] opacity-80 truncate">Deposits − Used, {rangeLabel}</p>
                          </div>
                        </div>
                        <p className="text-lg font-black tabular-nums whitespace-nowrap">
                          {isZero ? '' : isPositive ? '+' : '−'}
                          {formatAmount(Math.abs(net))}
                        </p>
                      </div>
                      <p className="text-[10px] mt-2 opacity-80 leading-snug">
                        {isZero
                          ? 'Your float balance did not change in this range.'
                          : isPositive
                            ? 'Your float grew — more came in than went out to tenants.'
                            : 'Your float shrank — more was spent on tenants than came in.'}
                      </p>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="max-w-[260px]">
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase font-bold tracking-wider opacity-80">
                        Net Breakdown ({rangeLabel})
                      </p>
                      <div className="flex items-center justify-between gap-4 text-xs">
                        <span className="flex items-center gap-1.5">
                          <ArrowDownCircle className="h-3 w-3 text-emerald-500" />
                          Deposits in
                        </span>
                        <span className="font-bold tabular-nums">{formatAmount(totalIn)}</span>
                      </div>
                      <div className="flex items-center justify-between gap-4 text-xs">
                        <span className="flex items-center gap-1.5">
                          <ArrowUpCircle className="h-3 w-3 text-rose-500" />
                          Used / out
                        </span>
                        <span className="font-bold tabular-nums">−{formatAmount(Math.abs(totalOut))}</span>
                      </div>
                      <div className="border-t border-border/50 pt-1.5 flex items-center justify-between gap-4 text-xs">
                        <span className="font-semibold">Net</span>
                        <span className="font-black tabular-nums">
                          {isZero ? '' : isPositive ? '+' : '−'}
                          {formatAmount(Math.abs(net))}
                        </span>
                      </div>
                    </div>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          })()}

          <div className="flex items-start gap-2 mt-3 text-[11px] text-muted-foreground">
            <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <p>
              Float is never withdrawable as cash. Allocate it to tenants — your 10% commission lands in your withdrawable wallet automatically.
              {(fromDate || toDate) && ' Totals reflect the selected date range.'}
            </p>
          </div>
        </div>

        {/* Date range filter */}
        <div className="rounded-2xl border bg-card p-3">
          <div className="flex items-center gap-2 mb-2">
            <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground">Date Range</span>
            {(fromDate || toDate) && (
              <button
                onClick={() => { hapticTap(); applyPreset('all'); }}
                className="ml-auto text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                <X className="h-3 w-3" /> Clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {presets.map((p) => (
              <button
                key={p.key}
                onClick={() => { hapticTap(); applyPreset(p.key); }}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-colors ${
                  preset === p.key
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background hover:bg-muted border-border text-muted-foreground'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="grid grid-cols-2 gap-2 mt-2">
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">From</span>
                <input
                  type="date"
                  value={fromDate}
                  max={toDate || undefined}
                  onChange={(e) => setFromDate(e.target.value)}
                  className="w-full rounded-lg border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">To</span>
                <input
                  type="date"
                  value={toDate}
                  min={fromDate || undefined}
                  onChange={(e) => setToDate(e.target.value)}
                  className="w-full rounded-lg border bg-background px-2 py-1.5 text-sm"
                />
              </label>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="rounded-2xl border bg-card p-3">
          <label className="flex items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by reference ID (e.g. TID, RCT, PC...)"
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground/70"
              aria-label="Search by reference ID"
            />
            {search && (
              <button
                onClick={() => { hapticTap(); setSearch(''); }}
                className="p-1 -m-1 rounded hover:bg-muted active:scale-95"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5 text-muted-foreground" />
              </button>
            )}
          </label>
          <p className="text-[10px] text-muted-foreground mt-1.5 leading-snug pl-6">
            Matches the reference ID, transaction group, entry ID, or description — within the selected date range.
          </p>
        </div>

        {/* Export */}
        <div className="rounded-2xl border bg-card p-3">
          <div className="flex items-center gap-2 mb-2">
            <Download className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground">Export</span>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {filteredRows.length} row{filteredRows.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={exportCsv}
              disabled={filteredRows.length === 0}
              className="flex items-center justify-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-semibold hover:bg-muted active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download className="h-4 w-4" />
              Download CSV
            </button>
            <button
              onClick={exportPdf}
              disabled={filteredRows.length === 0}
              className="flex items-center justify-center gap-2 rounded-lg border bg-background px-3 py-2 text-sm font-semibold hover:bg-muted active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <FileText className="h-4 w-4" />
              Download PDF
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground mt-2 leading-snug">
            Exports the {filteredRows.length} row{filteredRows.length === 1 ? '' : 's'} currently shown — respects your date range and search filters.
          </p>
        </div>

        {/* Timeline */}
        {loading ? (
          <div className="py-12 text-center text-sm text-muted-foreground">Loading...</div>
        ) : err ? (
          <div className="py-12 text-center text-sm text-rose-500">{err}</div>
        ) : filteredRows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {rows.length === 0
              ? 'No float activity yet.'
              : search
                ? `No activity matching "${search}" in this date range.`
                : 'No activity in this date range.'}
          </div>
        ) : (
          <div className="rounded-2xl border bg-card overflow-hidden">
            <div className="px-4 py-2.5 border-b bg-muted/30">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                  Activity ({filteredRows.length}{filteredRows.length !== rows.length ? ` of ${rows.length}` : ''})
                </span>
                <span className="text-[10px] text-muted-foreground">Tap a row for details</span>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                Each row is one float movement. <span className="text-emerald-600 dark:text-emerald-400 font-semibold">Green +</span> adds to float, <span className="text-rose-600 dark:text-rose-400 font-semibold">red −</span> takes from float.
              </p>
            </div>
            <ul className="divide-y">
              {filteredRows.map((r) => {
                const isIn = r.signed_amount > 0;
                return (
                  <li
                    key={r.entry_id}
                    onClick={() => { hapticTap(); setSelected(r); }}
                    className="px-4 py-3 flex items-start gap-3 cursor-pointer hover:bg-muted/40 active:bg-muted/60 transition-colors"
                  >
                    <div className={`mt-0.5 p-1.5 rounded-full ${isIn ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'}`}>
                      {isIn ? <ArrowDownCircle className="h-3.5 w-3.5" /> : <ArrowUpCircle className="h-3.5 w-3.5" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="text-sm font-semibold truncate">{labelFor(r.category)}</p>
                        <p className={`text-sm font-bold tabular-nums whitespace-nowrap ${isIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {isIn ? '+' : '−'}{formatAmount(Math.abs(Number(r.signed_amount)))}
                        </p>
                      </div>
                      {r.description && (
                        <p className="text-xs text-muted-foreground truncate mt-0.5">{r.description}</p>
                      )}
                      {r.reference_id && (
                        <p className="text-[10px] text-muted-foreground font-mono truncate mt-0.5">
                          Ref: {r.reference_id}
                        </p>
                      )}
                      <div className="flex items-center justify-between gap-2 mt-1">
                        <p className="text-[10px] text-muted-foreground">
                          {new Date(r.occurred_at).toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' })}
                        </p>
                        <div className="flex items-center gap-1">
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      {/* Drill-down sheet */}
      <Sheet open={!!selected} onOpenChange={(o) => { if (!o) { setSelected(null); setDetail(null); setViewingTenantId(null); } }}>
        <SheetContent side="bottom" className="h-[90vh] overflow-y-auto p-0">
          {viewingTenantId ? (
            <TenantProfileView
              tenantId={viewingTenantId}
              onBack={() => setViewingTenantId(null)}
            />
          ) : (
            <>
              <SheetHeader className="sticky top-0 z-10 bg-background border-b px-4 py-3">
                <SheetTitle className="text-base text-left">
                  {selected ? labelFor(selected.category) : 'Transaction Detail'}
                </SheetTitle>
              </SheetHeader>

              <div className="p-4 space-y-4">
            {detailLoading && (
              <div className="py-10 text-center text-sm text-muted-foreground">Loading details...</div>
            )}
            {detailErr && (
              <div className="py-10 text-center text-sm text-rose-500">{detailErr}</div>
            )}
            {detail && (
              <>
                {/* Amount headline */}
                <div className="rounded-2xl border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                        {selected && selected.signed_amount > 0 ? 'Float In' : 'Float Out'}
                      </p>
                      <p className={`text-2xl font-black tabular-nums mt-1 ${selected && selected.signed_amount > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                        {selected && selected.signed_amount > 0 ? '+' : '−'}
                        {formatAmount(Math.abs(Number(selected?.signed_amount ?? detail.entry.amount)))}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Bucket</p>
                      <p className="text-xs font-semibold mt-1 capitalize">{detail.entry.wallet_bucket ?? 'float'}</p>
                    </div>
                  </div>
                  {detail.entry.description && (
                    <p className="text-sm mt-3 leading-snug">{detail.entry.description}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-2">
                    {new Date(detail.entry.created_at).toLocaleString('en-UG', { dateStyle: 'full', timeStyle: 'short' })}
                  </p>
                </div>

                {/* Reference IDs */}
                <div className="rounded-2xl border bg-card overflow-hidden">
                  <div className="px-4 py-2.5 border-b bg-muted/30">
                    <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">References</span>
                  </div>
                  <dl className="divide-y">
                    <RefRow label="Reference ID" value={detail.entry.reference_id} copyKey="ref" copied={copied} onCopy={copyToClipboard} mono />
                    <RefRow label="Transaction Group" value={detail.entry.transaction_group_id} copyKey="grp" copied={copied} onCopy={copyToClipboard} mono />
                    <RefRow label="Entry ID" value={detail.entry.id} copyKey="eid" copied={copied} onCopy={copyToClipboard} mono />
                    <RefRow label="Source" value={detail.entry.source_table ? `${detail.entry.source_table}${detail.entry.source_id ? ' · ' + detail.entry.source_id.slice(0,8) : ''}` : null} copyKey="src" copied={copied} onCopy={detail.entry.source_id ? copyToClipboard : undefined} mono />
                    <RefRow label="Linked Party" value={detail.entry.linked_party_name ?? detail.entry.linked_party} copyKey="lp" copied={copied} onCopy={copyToClipboard} />
                    <RefRow label="Category" value={labelFor(detail.entry.category)} />
                    <RefRow label="Account" value={detail.entry.account} />
                    <RefRow label="Recipient Type" value={detail.entry.recipient_type} />
                  </dl>
                </div>

                {/* Tenant rent allocations funded by this float deposit (FIFO) */}
                {selected && selected.signed_amount > 0 && (
                  <div className="rounded-2xl border bg-card overflow-hidden">
                    <div className="px-4 py-2.5 border-b bg-muted/30 flex items-center gap-2">
                      <Users className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                        Allocated To Tenant Rent
                        {allocations && allocations.length > 0 ? ` (${filteredAllocations.length}/${allocations.length})` : ''}
                      </span>
                    </div>
                    <div className="px-4 py-2 border-b">
                      <p className="text-[11px] text-muted-foreground leading-snug">
                        The tenant rent payments this deposit funded, matched oldest-float-first (FIFO).
                      </p>
                    </div>

                    {/* Allocation search + date filters */}
                    {allocations && allocations.length > 0 && (
                      <div className="px-4 py-3 border-b space-y-3">
                        <label className="flex items-center gap-2">
                          <Search className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                          <input
                            type="text"
                            value={allocSearch}
                            onChange={(e) => setAllocSearch(e.target.value)}
                            placeholder="Search tenant name, phone, or reference…"
                            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground/70"
                            aria-label="Search allocations"
                          />
                          {allocSearch && (
                            <button
                              onClick={() => { hapticTap(); setAllocSearch(''); }}
                              className="p-1 -m-1 rounded hover:bg-muted active:scale-95"
                              aria-label="Clear allocation search"
                            >
                              <X className="h-3.5 w-3.5 text-muted-foreground" />
                            </button>
                          )}
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="space-y-1">
                            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">From</span>
                            <input
                              type="date"
                              value={allocFromDate}
                              onChange={(e) => setAllocFromDate(e.target.value)}
                              className="w-full rounded-lg border bg-background px-2 py-1.5 text-sm"
                            />
                          </label>
                          <label className="space-y-1">
                            <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">To</span>
                            <input
                              type="date"
                              value={allocToDate}
                              min={allocFromDate || undefined}
                              onChange={(e) => setAllocToDate(e.target.value)}
                              className="w-full rounded-lg border bg-background px-2 py-1.5 text-sm"
                            />
                          </label>
                        </div>
                      </div>
                    )}

                    {allocLoading ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">Tracing allocations…</div>
                    ) : allocErr ? (
                      <div className="py-8 text-center text-sm text-rose-500">{allocErr}</div>
                    ) : !allocations || allocations.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground px-4">
                        Not yet allocated — this float is still sitting in your wallet, unspent on tenant rent.
                      </div>
                    ) : filteredAllocations.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground px-4">
                        No allocations match your filters.
                      </div>
                    ) : (
                      <ul className="divide-y">
                        {filteredAllocations.map((a) => {
                          const phone = (a.tenant_phone ?? '').replace(/[^0-9+]/g, '');
                          const waPhone = phone.replace(/^0/, '256').replace(/^\+/, '');
                          return (
                            <li key={a.use_entry_id} className="px-4 py-3">
                              {/* Tenant name — large, clear, and clickable */}
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0 flex-1">
                                  <button
                                    onClick={() => { hapticTap(); if (a.tenant_id) setViewingTenantId(a.tenant_id); }}
                                    className="text-left w-full"
                                    disabled={!a.tenant_id}
                                  >
                                    <p className="text-base font-bold truncate leading-tight text-foreground hover:text-primary transition-colors">
                                      {a.tenant_name ?? 'Unknown Tenant'}
                                    </p>
                                  </button>
                                  {a.tenant_name && (
                                    <p className="text-[11px] text-muted-foreground mt-0.5">
                                      {labelFor(a.category)}
                                    </p>
                                  )}
                                </div>
                                <p className="text-sm font-bold tabular-nums whitespace-nowrap text-rose-600 dark:text-rose-400 mt-0.5">
                                  −{formatAmount(Number(a.allocated_amount))}
                                </p>
                              </div>
                              <p className="text-[11px] text-muted-foreground mt-1">
                                {Number(a.allocated_amount) < Number(a.use_amount)
                                  ? `Part of a ${formatAmount(Number(a.use_amount))} rent payment`
                                  : 'Full rent payment'}
                                {' · '}
                                {new Date(a.occurred_at).toLocaleDateString('en-UG', { dateStyle: 'medium' })}
                              </p>
                              {phone && (
                                <div className="flex items-center gap-2 mt-2">
                                  <a
                                    href={`tel:${phone}`}
                                    onClick={() => hapticTap()}
                                    className="inline-flex items-center gap-1 rounded-lg border bg-background px-2.5 py-1 text-[11px] font-semibold hover:bg-muted active:scale-95"
                                  >
                                    <Phone className="h-3 w-3" /> Call
                                  </a>
                                  <a
                                    href={`https://wa.me/${waPhone}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    onClick={() => hapticTap()}
                                    className="inline-flex items-center gap-1 rounded-lg border bg-background px-2.5 py-1 text-[11px] font-semibold hover:bg-muted active:scale-95"
                                  >
                                    <MessageCircle className="h-3 w-3" /> WhatsApp
                                  </a>
                                  <span className="text-[10px] text-muted-foreground font-mono ml-auto truncate">{phone}</span>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                )}

                {/* Double-entry legs */}
                {detail.siblings.length > 0 && (
                  <div className="rounded-2xl border bg-card overflow-hidden">
                    <div className="px-4 py-2.5 border-b bg-muted/30">
                      <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                        Double-Entry Legs ({detail.siblings.length})
                      </span>
                    </div>
                    <ul className="divide-y">
                      {detail.siblings.map((s) => {
                        const isIn = s.direction === 'cash_in';
                        return (
                          <li key={s.id} className={`px-4 py-3 ${s.is_self ? 'bg-primary/5' : ''}`}>
                            <div className="flex items-baseline justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold truncate">
                                  {labelFor(s.category)}
                                  {s.is_self && <span className="ml-2 text-[10px] text-primary font-bold">THIS LEG</span>}
                                </p>
                                <p className="text-[11px] text-muted-foreground mt-0.5">
                                  {s.user_name ?? (s.user_id ? s.user_id.slice(0,8) + '…' : 'Platform')}
                                  {' · '}
                                  <span className="capitalize">{s.ledger_scope}{s.wallet_bucket ? ' / ' + s.wallet_bucket : ''}</span>
                                </p>
                              </div>
                              <p className={`text-sm font-bold tabular-nums whitespace-nowrap ${isIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                                {isIn ? '+' : '−'}{formatAmount(Number(s.amount))}
                              </p>
                            </div>
                            {s.reference_id && (
                              <p className="text-[10px] text-muted-foreground font-mono mt-1 truncate">
                                Ref: {s.reference_id}
                              </p>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function RefRow({
  label, value, copyKey, copied, onCopy, mono,
}: {
  label: string;
  value: string | null | undefined;
  copyKey?: string;
  copied?: string | null;
  onCopy?: (v: string, k: string) => void;
  mono?: boolean;
}) {
  if (!value) return null;
  const canCopy = !!(copyKey && onCopy);
  return (
    <div className="px-4 py-2.5 flex items-center justify-between gap-3">
      <dt className="text-[11px] uppercase font-bold tracking-wider text-muted-foreground flex-shrink-0">{label}</dt>
      <dd className={`text-xs text-right truncate flex items-center gap-2 ${mono ? 'font-mono' : ''}`}>
        <span className="truncate">{value}</span>
        {canCopy && (
          <button
            onClick={() => onCopy!(value, copyKey!)}
            className="p-1 -m-1 rounded hover:bg-muted active:scale-95 flex-shrink-0"
            aria-label={`Copy ${label}`}
          >
            {copied === copyKey ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3 text-muted-foreground" />}
          </button>
        )}
      </dd>
    </div>
  );
}