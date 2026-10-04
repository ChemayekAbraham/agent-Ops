import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Loader2, Search, HandCoins, Clock, CheckCircle2, User, RefreshCw, ArrowRight, Download, FileText, FileSpreadsheet, X,
} from 'lucide-react';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { getTelecomSendingCharge } from '@/lib/cashoutCharges';
import { useLatestClaimComments, type CashoutClaimComment } from '@/hooks/useCashoutClaimComments';
import { ClaimCommentTimeline } from '@/components/cfo/ClaimCommentTimeline';
import { MessageSquare } from 'lucide-react';

interface ClaimRow {
  id: string;
  amount: number;
  status: string;
  payout_method: string | null;
  customerId: string | null;
  customerName: string;
  customerPhone: string | null;
  merchantName: string;
  merchantPhone: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  state: 'in_progress' | 'completed';
}

const COMPLETED_STATUSES = ['approved', 'fin_ops_approved', 'completed'];

function StatusPill({ status, tone }: { status: string; tone?: 'muted' | 'active' }) {
  return (
    <span
      className={cn(
        'inline-block px-2 py-0.5 rounded-md text-[11px] font-medium capitalize border',
        tone === 'active'
          ? 'bg-success/15 text-success border-success/30'
          : 'bg-muted text-muted-foreground border-border',
      )}
    >
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function ClaimDetailDrawer({ claim, onClose }: { claim: ClaimRow | null; onClose: () => void }) {
  const { data: record, isLoading } = useQuery({
    queryKey: ['merchant-claim-detail', claim?.id],
    enabled: !!claim,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('id', claim!.id)
        .maybeSingle();
      if (error) throw error;
      return data as Record<string, any> | null;
    },
  });

  // Build the state-change audit trail from the record's stage timestamps + actor ids.
  const STAGES: { label: string; at: string; by?: string }[] = [
    { label: 'Requested', at: 'created_at', by: 'initiated_by' },
    { label: 'Processing started', at: 'processing_started_at', by: 'processing_started_by' },
    { label: 'Claimed / dispatched', at: 'dispatched_at', by: 'assigned_cashout_agent_id' },
    { label: 'Manager approved', at: 'manager_approved_at', by: 'manager_approved_by' },
    { label: 'COO approved', at: 'coo_approved_at', by: 'coo_approved_by' },
    { label: 'CFO approved', at: 'cfo_approved_at', by: 'cfo_approved_by' },
    { label: 'Fin Ops verified', at: 'fin_ops_verified_at', by: 'fin_ops_verified_by' },
    { label: 'Fin Ops approved', at: 'fin_ops_approved_at', by: 'fin_ops_approved_by' },
    { label: 'Paid out', at: 'processed_at', by: 'processed_by' },
  ];

  const events = record
    ? STAGES
        .filter(s => record[s.at])
        .map(s => ({ label: s.label, ts: record[s.at] as string, actorId: s.by ? (record[s.by] as string | null) : null }))
        .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
    : [];

  const actorIds = Array.from(new Set(events.map(e => e.actorId).filter(Boolean))) as string[];
  const { data: actorMap } = useQuery({
    queryKey: ['merchant-claim-actors', claim?.id, actorIds.join(',')],
    enabled: !!claim && actorIds.length > 0,
    queryFn: async () => {
      const map: Record<string, string> = {};
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', actorIds);
      data?.forEach(p => { map[p.id] = p.full_name || 'Unknown user'; });
      return map;
    },
  });

  const beforeStatus = claim?.state === 'completed' ? 'claimed' : 'pending';
  const afterStatus = claim?.status || 'pending';

  const fields = record
    ? Object.entries(record).filter(([, v]) => v !== null && v !== '' && typeof v !== 'object')
    : [];

  const trailRows = () =>
    events.map(e => ({
      step: e.label,
      timestamp: format(new Date(e.ts), 'dd MMM yyyy, HH:mm'),
      actor: e.actorId ? (actorMap?.[e.actorId] || 'Unknown user') : 'System / automated',
    }));

  const fileBase = () =>
    `claim-${(claim?.id || '').slice(0, 8)}-audit-trail`;

  const exportCsv = () => {
    if (!claim) return;
    const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    const header = ['Amount', 'Merchant agent', 'Customer', 'Withdrawal ID'];
    const meta = [formatUGX(claim.amount), claim.merchantName, claim.customerName, claim.id];
    const lines = [
      header.map(esc).join(','),
      meta.map(esc).join(','),
      '',
      ['Step', 'Timestamp', 'Actor'].map(esc).join(','),
      ...trailRows().map(r => [r.step, r.timestamp, r.actor].map(esc).join(',')),
    ];
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${fileBase()}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const exportPdf = async () => {
    if (!claim) return;
    const { default: jsPDF } = await import('jspdf');
    const autoTable = (await import('jspdf-autotable')).default;
    const doc = new jsPDF();
    doc.setFontSize(16);
    doc.text('Merchant Claim Audit Trail', 14, 18);
    doc.setFontSize(10);
    doc.text(`Amount: ${formatUGX(claim.amount)}`, 14, 28);
    doc.text(`Merchant agent: ${claim.merchantName}`, 14, 34);
    doc.text(`Customer: ${claim.customerName}`, 14, 40);
    doc.text(`Withdrawal ID: ${claim.id}`, 14, 46);
    autoTable(doc, {
      startY: 54,
      head: [['Step', 'Timestamp', 'Actor']],
      body: trailRows().map(r => [r.step, r.timestamp, r.actor]),
      styles: { fontSize: 9 },
      headStyles: { fillColor: [59, 130, 246] },
    });
    doc.save(`${fileBase()}.pdf`);
  };

  return (
    <Sheet open={!!claim} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
        {claim && (
          <>
            <SheetHeader>
              <SheetTitle>{formatUGX(claim.amount)} claim</SheetTitle>
              <SheetDescription>
                {claim.merchantName} claimed for {claim.customerName}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-5">
              {/* Before / after status */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Status transition
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusPill status={beforeStatus} tone="muted" />
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                  <StatusPill status={afterStatus} tone="active" />
                </div>
                <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                  {claim.claimedAt && (
                    <p>Claimed {format(new Date(claim.claimedAt), 'dd MMM yyyy, HH:mm')}</p>
                  )}
                  {claim.completedAt && (
                    <p className="text-success">Paid {format(new Date(claim.completedAt), 'dd MMM yyyy, HH:mm')}</p>
                  )}
                </div>
              </div>

              {/* Parties */}
              <div className="grid grid-cols-2 gap-3">
                <Card className="p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Merchant agent</p>
                  <p className="text-sm font-medium mt-0.5">{claim.merchantName}</p>
                  {claim.merchantPhone && <p className="text-xs text-muted-foreground">{claim.merchantPhone}</p>}
                </Card>
                <Card className="p-3">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Customer</p>
                  <p className="text-sm font-medium mt-0.5">{claim.customerName}</p>
                  {claim.customerPhone && <p className="text-xs text-muted-foreground">{claim.customerPhone}</p>}
                </Card>
              </div>

              {/* Withdrawal charge (company-borne, auto-computed) */}
              {(() => {
                const charge = getTelecomSendingCharge(claim.amount);
                return (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                      Withdrawal charge
                    </p>
                    <Card className="divide-y">
                      <div className="flex items-center justify-between px-3 py-2">
                        <span className="text-xs text-muted-foreground">Requested amount</span>
                        <span className="text-sm font-medium">{formatUGX(claim.amount)}</span>
                      </div>
                      <div className="flex items-center justify-between px-3 py-2">
                        <span className="text-xs text-muted-foreground">Withdrawal charge</span>
                        <span className="text-sm font-medium text-amber-600">{formatUGX(charge)}</span>
                      </div>
                      <div className="flex items-center justify-between px-3 py-2">
                        <span className="text-xs text-muted-foreground">Net paid to customer</span>
                        <span className="text-sm font-bold">{formatUGX(claim.amount)}</span>
                      </div>
                      <div className="flex items-center justify-between px-3 py-2">
                        <span className="text-xs text-muted-foreground">Charge bearer</span>
                        <Badge variant="outline" className="text-[10px]">Company</Badge>
                      </div>
                    </Card>
                  </div>
                );
              })()}

              {/* Comment timeline — permanent audit trail of officer notes */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" /> Comments
                </p>
                <ClaimCommentTimeline withdrawalId={claim.id} />
              </div>

              {/* Audit trail — every claim/payout state change */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Audit trail
                  </p>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="h-7 gap-1.5" disabled={events.length === 0}>
                        <Download className="h-3.5 w-3.5" /> Export
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={exportCsv}>
                        <FileSpreadsheet className="h-4 w-4 mr-2" /> Download CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={exportPdf}>
                        <FileText className="h-4 w-4 mr-2" /> Download PDF
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {isLoading ? (
                  <div className="flex items-center py-4 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading trail…
                  </div>
                ) : events.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No recorded state changes.</p>
                ) : (
                  <ol className="relative border-l border-border ml-1.5 space-y-4">
                    {events.map((e, i) => (
                      <li key={`${e.label}-${i}`} className="ml-4">
                        <span className="absolute -left-[5px] mt-1 h-2.5 w-2.5 rounded-full bg-primary" />
                        <p className="text-sm font-medium text-foreground">{e.label}</p>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(e.ts), 'dd MMM yyyy, HH:mm')}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {e.actorId ? `By ${actorMap?.[e.actorId] || 'Resolving…'}` : 'System / automated'}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              {/* Underlying withdrawal record */}
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  Underlying withdrawal record
                </p>
                {isLoading ? (
                  <div className="flex items-center py-6 text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading record…
                  </div>
                ) : !record ? (
                  <p className="text-sm text-muted-foreground">Record not found.</p>
                ) : (
                  <Card className="divide-y">
                    {fields.map(([k, v]) => (
                      <div key={k} className="flex items-start justify-between gap-3 px-3 py-2">
                        <span className="text-xs text-muted-foreground shrink-0">{k.replace(/_/g, ' ')}</span>
                        <span className="text-xs text-foreground text-right break-all">{String(v)}</span>
                      </div>
                    ))}
                  </Card>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function MerchantClaimsLog() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ClaimRow | null>(null);
  const [tab, setTab] = useState<'all' | 'in_progress' | 'completed'>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['merchant-claims-log'],
    queryFn: async (): Promise<ClaimRow[]> => {
      // 1. All cash-out (merchant) agents — id (cashout_agents.id) + user id.
      const { data: agents, error: agentsErr } = await supabase
        .from('cashout_agents')
        .select('id, agent_id, profiles:agent_id(id, full_name, phone)');
      if (agentsErr) throw agentsErr;

      const byCashoutId = new Map<string, { name: string; phone: string | null }>();
      const byUserId = new Map<string, { name: string; phone: string | null }>();
      const agentUserIds: string[] = [];
      (agents || []).forEach((a: any) => {
        const p = a.profiles;
        const info = { name: p?.full_name || 'Merchant agent', phone: p?.phone || null };
        byCashoutId.set(a.id, info);
        if (a.agent_id) { byUserId.set(a.agent_id, info); agentUserIds.push(a.agent_id); }
      });

      // Paginated fetch helper — PostgREST caps a single response at 1000 rows,
      // so we page through until exhausted to get GENUINE counts (no silent cap).
      const PAGE = 1000;
      const fetchAll = async (
        build: (from: number, to: number) => any,
      ): Promise<any[]> => {
        const out: any[] = [];
        for (let from = 0; ; from += PAGE) {
          const { data: page, error } = await build(from, from + PAGE - 1);
          if (error) throw error;
          const rows = page || [];
          out.push(...rows);
          if (rows.length < PAGE) break;
          // Safety valve against runaway loops.
          if (out.length >= 50_000) break;
        }
        return out;
      };

      // 2. In-progress claims — currently assigned to a merchant agent.
      // 3. Completed claims — settled by a merchant agent's own MoMo/cash.
      const [inProg, completed] = await Promise.all([
        fetchAll((from, to) =>
          supabase
            .from('withdrawal_requests')
            .select('id, user_id, amount, status, payout_method, dispatched_at, processed_at, assigned_cashout_agent_id, created_at')
            .not('assigned_cashout_agent_id', 'is', null)
            .order('dispatched_at', { ascending: false })
            .range(from, to),
        ),
        agentUserIds.length
          ? fetchAll((from, to) =>
              supabase
                .from('withdrawal_requests')
                .select('id, user_id, amount, status, payout_method, dispatched_at, processed_at, processed_by, created_at')
                .in('processed_by', agentUserIds)
                .in('status', COMPLETED_STATUSES)
                .order('processed_at', { ascending: false })
                .range(from, to),
            )
          : Promise.resolve([] as any[]),
      ]);

      // 4. Customer (beneficiary) names.
      const custIds = Array.from(new Set(
        [...inProg, ...completed].map((r: any) => r.user_id).filter(Boolean),
      ));
      const custMap = new Map<string, { name: string; phone: string | null }>();
      if (custIds.length) {
        // Chunk the id list so a large batch never overflows the URL / .in() cap.
        for (let i = 0; i < custIds.length; i += 200) {
          const chunk = custIds.slice(i, i + 200);
          const { data: profs } = await supabase
            .from('profiles')
            .select('id, full_name, phone')
            .in('id', chunk);
          profs?.forEach(p => custMap.set(p.id, { name: p.full_name || 'Customer', phone: p.phone || null }));
        }
      }

      const rows: ClaimRow[] = [];
      // Completed claims win: a settled withdrawal often still carries its
      // assigned_cashout_agent_id, so it also matches the in-progress query.
      // Track completed ids (and ids whose status is already terminal) so the
      // same transaction never renders as both "Completed" and "In progress".
      const completedIds = new Set<string>(completed.map((r: any) => r.id));

      completed.forEach((r: any) => {
        const m = byUserId.get(r.processed_by) || { name: 'Merchant agent', phone: null };
        const c = custMap.get(r.user_id) || { name: 'Customer', phone: null };
        rows.push({
          id: r.id, amount: Number(r.amount || 0), status: r.status, payout_method: r.payout_method,
          customerId: r.user_id, customerName: c.name, customerPhone: c.phone,
          merchantName: m.name, merchantPhone: m.phone,
          claimedAt: r.dispatched_at, completedAt: r.processed_at, state: 'completed',
        });
      });

      inProg.forEach((r: any) => {
        // Skip anything already captured as completed.
        if (completedIds.has(r.id)) return;
        const m = byCashoutId.get(r.assigned_cashout_agent_id) || { name: 'Merchant agent', phone: null };
        const c = custMap.get(r.user_id) || { name: 'Customer', phone: null };
        // Defensive: a terminal status that never populated processed_by still
        // belongs in the Completed bucket, not In progress.
        const isDone = COMPLETED_STATUSES.includes(r.status);
        rows.push({
          id: r.id, amount: Number(r.amount || 0), status: r.status, payout_method: r.payout_method,
          customerId: r.user_id, customerName: c.name, customerPhone: c.phone,
          merchantName: m.name, merchantPhone: m.phone,
          claimedAt: r.dispatched_at,
          completedAt: isDone ? (r.processed_at || null) : null,
          state: isDone ? 'completed' : 'in_progress',
        });
      });

      // Newest activity first.
      rows.sort((a, b) => {
        const ta = new Date(a.completedAt || a.claimedAt || 0).getTime();
        const tb = new Date(b.completedAt || b.claimedAt || 0).getTime();
        return tb - ta;
      });
      return rows;
    },
    staleTime: 30_000,
  });

  const rows = data || [];

  // Latest comment per claim — shown inline on the merchant list so Finance can
  // read status/notes without opening each claim.
  const { data: latestComments } = useLatestClaimComments(rows.map(r => r.id));

  // The activity timestamp used for the tab + date-range filters:
  // "paid" claims filter on completedAt, "claimed" on claimedAt.
  const activityTs = (r: ClaimRow) => r.completedAt || r.claimedAt;

  const statuses = useMemo(
    () => Array.from(new Set(rows.map(r => r.status))).sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const from = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : null;
    const to = toDate ? new Date(`${toDate}T23:59:59`).getTime() : null;
    return rows.filter(r => {
      if (tab !== 'all' && r.state !== tab) return false;
      if (statusFilter !== 'all' && r.status !== statusFilter) return false;
      if (from || to) {
        const ts = activityTs(r);
        const t = ts ? new Date(ts).getTime() : null;
        if (t === null) return false;
        if (from && t < from) return false;
        if (to && t > to) return false;
      }
      if (q) {
        const hit =
          r.merchantName.toLowerCase().includes(q) ||
          r.customerName.toLowerCase().includes(q) ||
          (r.customerPhone || '').toLowerCase().includes(q) ||
          (r.merchantPhone || '').toLowerCase().includes(q) ||
          String(r.amount).includes(q) ||
          r.id.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [rows, search, tab, statusFilter, fromDate, toDate]);

  const hasActiveFilters = tab !== 'all' || statusFilter !== 'all' || !!fromDate || !!toDate || !!search;
  const clearFilters = () => {
    setTab('all'); setStatusFilter('all'); setFromDate(''); setToDate(''); setSearch('');
  };

  const inProgressCount = rows.filter(r => r.state === 'in_progress').length;
  const completedCount = rows.filter(r => r.state === 'completed').length;

  // Money totals so Financial Ops can read paid / in-progress value at a glance.
  const inProgressTotal = useMemo(
    () => rows.filter(r => r.state === 'in_progress').reduce((s, r) => s + r.amount, 0),
    [rows],
  );
  const completedTotal = useMemo(
    () => rows.filter(r => r.state === 'completed').reduce((s, r) => s + r.amount, 0),
    [rows],
  );
  // Total of whatever is currently filtered/shown (respects tab, status, date, search).
  const filteredTotal = useMemo(
    () => filtered.reduce((s, r) => s + r.amount, 0),
    [filtered],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-primary/10">
            <HandCoins className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h2 className="text-xl font-bold">Merchant Claims Log</h2>
            <p className="text-sm text-muted-foreground">
              Every withdrawal claimed by a merchant (cash-out) agent — in progress and completed.
            </p>
          </div>
        </div>
        <button onClick={() => refetch()} className="p-2 rounded-lg hover:bg-muted transition-colors" title="Refresh">
          <RefreshCw className={cn('h-4 w-4 text-muted-foreground', isFetching && 'animate-spin')} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-warning">
            <Clock className="h-4 w-4" />
            <span className="text-xs font-medium text-muted-foreground">In progress</span>
          </div>
          <p className="text-2xl font-bold mt-1">{inProgressCount}</p>
          <p className="text-xs font-medium text-warning mt-0.5">{formatUGX(inProgressTotal)}</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-success">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-xs font-medium text-muted-foreground">Completed</span>
          </div>
          <p className="text-2xl font-bold mt-1">{completedCount}</p>
          <p className="text-xs font-medium text-success mt-0.5">{formatUGX(completedTotal)}</p>
        </Card>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by merchant, customer, phone, amount or ID…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-9 h-10"
        />
      </div>

      {/* Quick tabs: Claimed (in progress) vs Paid (completed) */}
      <div className="flex items-center gap-1 rounded-lg bg-muted p-1">
        {([
          { id: 'all', label: `All (${rows.length})` },
          { id: 'in_progress', label: `Claimed (${inProgressCount})` },
          { id: 'completed', label: `Paid (${completedCount})` },
        ] as const).map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'flex-1 h-8 rounded-md text-xs font-medium transition-colors',
              tab === t.id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Status + date-range filters */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-9">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {statuses.map(s => (
                <SelectItem key={s} value={s} className="capitalize">{s.replace(/_/g, ' ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">From</Label>
          <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="h-9" />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">To</Label>
          <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="h-9" />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground flex-wrap">
        <span className="flex items-center gap-1.5">
          {filtered.length} {filtered.length === 1 ? 'claim' : 'claims'} shown
          <span className="text-muted-foreground/60">·</span>
          <span className="font-semibold text-foreground">{formatUGX(filteredTotal)} total</span>
        </span>
        {hasActiveFilters && (
          <button onClick={clearFilters} className="inline-flex items-center gap-1 hover:text-foreground transition-colors">
            <X className="h-3.5 w-3.5" /> Clear filters
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading claims…
        </div>
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <HandCoins className="h-10 w-10 mx-auto mb-2 opacity-40" />
          <p className="text-sm">{hasActiveFilters ? 'No claims match your filters.' : 'No merchant claims recorded yet.'}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(r => (
            <Card
              key={`${r.state}-${r.id}`}
              className="p-3 cursor-pointer hover:bg-muted/50 transition-colors"
              onClick={() => setSelected(r)}
            >
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">{formatUGX(r.amount)}</span>
                    <Badge
                      variant="outline"
                      className={cn('text-[10px] capitalize',
                        r.state === 'completed'
                          ? 'bg-success/15 text-success border-success/30'
                          : 'bg-warning/15 text-warning border-warning/30')}
                    >
                      {r.state === 'completed' ? 'Completed' : 'In progress'}
                    </Badge>
                    {r.payout_method && (
                      <span className="text-[11px] text-muted-foreground capitalize">{r.payout_method.replace(/_/g, ' ')}</span>
                    )}
                  </div>
                  <p className="text-sm text-foreground mt-1 flex items-center gap-1.5">
                    <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="font-medium">{r.merchantName}</span>
                    <span className="text-muted-foreground">claimed for</span>
                    <span>{r.customerName}</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {r.merchantPhone ? `Merchant ${r.merchantPhone}` : ''}
                    {r.merchantPhone && r.customerPhone ? ' · ' : ''}
                    {r.customerPhone ? `Customer ${r.customerPhone}` : ''}
                  </p>
                  {(() => {
                    const c: CashoutClaimComment | undefined = latestComments?.[r.id];
                    if (!c) return null;
                    return (
                      <p className="text-xs mt-1 flex items-start gap-1.5 text-foreground/80">
                        <MessageSquare className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
                        <span className="min-w-0">
                          <span className="truncate">{c.comment}</span>
                          <span className="text-muted-foreground">
                            {' '}— {c.author_name || 'Officer'} · {format(new Date(c.created_at), 'dd MMM, HH:mm')}
                            {c.status ? ` · ${c.status}` : ''}
                          </span>
                        </span>
                      </p>
                    );
                  })()}
                </div>
                <div className="text-right text-[11px] text-muted-foreground shrink-0">
                  {r.claimedAt && <p>Claimed {format(new Date(r.claimedAt), 'dd MMM yyyy, HH:mm')}</p>}
                  {r.completedAt && <p className="text-success">Paid {format(new Date(r.completedAt), 'dd MMM yyyy, HH:mm')}</p>}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ClaimDetailDrawer claim={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
