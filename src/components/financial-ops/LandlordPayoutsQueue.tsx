import { getSessionCheckedUser } from '@/lib/authenticatedRequests';
import { withUuidIds } from '@/lib/isUuid';
import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { formatDistanceToNow, format } from 'date-fns';
import {
  Banknote,
  Copy,
  CheckCircle2,
  XCircle,
  Phone,
  User,
  Loader2,
  Clock,
  Wallet,
  Receipt,
  Search,
  Filter,
  RefreshCw,
  ExternalLink,
  ChevronDown,
  Building2,
  ArrowRight,
  ShieldCheck,
  Share2
} from 'lucide-react';
import { LandlordPayoutShareCard, type LandlordPayoutShareData } from './LandlordPayoutShareCard';
import { LandlordPaymentCompletedDialog, type LandlordPaymentCompletion } from './LandlordPaymentCompletedDialog';
import { ReceiptNumberLookupPanel } from './ReceiptNumberLookupPanel';

export type LandlordPayoutStatus = 'all' | 'pending' | 'awaiting_receipt' | 'disbursed';

export type Payout = {
  id: string;
  agent_id: string;
  tenant_id: string | null;
  rent_request_id: string | null;
  landlord_id: string;
  landlord_name: string;
  landlord_phone: string;
  mobile_money_provider: string;
  amount: number;
  status: string;
  created_at: string;
  disbursed_at?: string | null;
  finops_disbursed_at?: string | null;
  finops_momo_reference?: string | null;
  external_reference?: string | null;
  finops_notes?: string | null;
  agent_profile?: { full_name: string | null; phone: string | null } | null;
  tenant_profile?: { full_name: string | null } | null;
};

function formatUGX(n: number) {
  return `UGX ${Number(n || 0).toLocaleString()}`;
}

async function copyText(text: string, label: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
  } catch {
    toast.error('Copy failed');
  }
}

export function LandlordPayoutsQueue() {
  const qc = useQueryClient();
  const [disburse, setDisburse] = useState<Payout | null>(null);
  const [reject, setReject] = useState<Payout | null>(null);
  const [momoRef, setMomoRef] = useState('');
  const [notes, setNotes] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [shareData, setShareData] = useState<LandlordPayoutShareData | null>(null);
  const [completionState, setCompletion] = useState<LandlordPaymentCompletion | null>(null);

  // Filter and search state
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<LandlordPayoutStatus>('pending');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [showReceiptLookup, setShowReceiptLookup] = useState(false);

  // Fetch landlord payouts across all active operational stages
  const { data: allPayouts = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ['finops-landlord-payouts-queue-all'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('landlord_payouts')
        .select(`
          id, agent_id, tenant_id, rent_request_id, landlord_id, landlord_name,
          landlord_phone, mobile_money_provider, amount, status, created_at,
          disbursed_at, finops_disbursed_at, finops_momo_reference, external_reference, finops_notes
        `)
        .order('created_at', { ascending: false })
        .limit(200);

      if (error) throw error;
      const rows = (data ?? []) as Payout[];

      // Hydrate agent and tenant names
      const agentIds = Array.from(new Set(rows.map(r => r.agent_id)));
      const tenantIds = Array.from(new Set(rows.map(r => r.tenant_id).filter(Boolean) as string[]));
      const ids = Array.from(new Set([...agentIds, ...tenantIds]));

      if (ids.length) {
        const { data: profs } = await withUuidIds(ids, (validIds) => supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', validIds));

        const map = new Map((profs ?? []).map(p => [p.id, p]));
        rows.forEach(r => {
          r.agent_profile = (map.get(r.agent_id) as any) ?? null;
          if (r.tenant_id) r.tenant_profile = (map.get(r.tenant_id) as any) ?? null;
        });
      }

      return rows;
    },
    refetchInterval: 30_000,
  });

  // Calculate KPI stats
  const kpiStats = useMemo(() => {
    let pendingCount = 0;
    let pendingVolume = 0;
    let awaitingReceiptCount = 0;
    let awaitingReceiptVolume = 0;
    let disbursedCount = 0;
    let disbursedVolume = 0;

    const todayStr = new Date().toISOString().slice(0, 10);
    let disbursedTodayCount = 0;
    let disbursedTodayVolume = 0;

    for (const p of allPayouts) {
      const amt = Number(p.amount) || 0;
      if (p.status === 'pending_finops_disbursement') {
        pendingCount++;
        pendingVolume += amt;
      } else if (p.status === 'awaiting_agent_receipt') {
        awaitingReceiptCount++;
        awaitingReceiptVolume += amt;
      } else if (p.status === 'disbursed' || p.status === 'completed') {
        disbursedCount++;
        disbursedVolume += amt;
        const dAt = p.disbursed_at || p.finops_disbursed_at;
        if (dAt && dAt.slice(0, 10) === todayStr) {
          disbursedTodayCount++;
          disbursedTodayVolume += amt;
        }
      }
    }

    return {
      pendingCount,
      pendingVolume,
      awaitingReceiptCount,
      awaitingReceiptVolume,
      disbursedCount,
      disbursedVolume,
      disbursedTodayCount,
      disbursedTodayVolume,
    };
  }, [allPayouts]);

  // Filtered rows
  const filteredPayouts = useMemo(() => {
    return allPayouts.filter(p => {
      // Status filter
      if (statusFilter === 'pending' && p.status !== 'pending_finops_disbursement') {
        return false;
      }
      if (statusFilter === 'awaiting_receipt' && p.status !== 'awaiting_agent_receipt') {
        return false;
      }
      if (statusFilter === 'disbursed' && p.status !== 'disbursed' && p.status !== 'completed') {
        return false;
      }

      // Provider filter
      if (providerFilter !== 'all') {
        const prov = (p.mobile_money_provider || '').toLowerCase();
        if (providerFilter === 'mtn' && !prov.includes('mtn')) return false;
        if (providerFilter === 'airtel' && !prov.includes('airtel')) return false;
      }

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = (p.landlord_name || '').toLowerCase().includes(q);
        const matchesPhone = (p.landlord_phone || '').includes(q);
        const matchesAgent = (p.agent_profile?.full_name || '').toLowerCase().includes(q);
        const matchesTenant = (p.tenant_profile?.full_name || '').toLowerCase().includes(q);
        const matchesTid = (p.finops_momo_reference || p.external_reference || '').toLowerCase().includes(q);
        if (!matchesName && !matchesPhone && !matchesAgent && !matchesTenant && !matchesTid) {
          return false;
        }
      }

      return true;
    });
  }, [allPayouts, statusFilter, providerFilter, searchQuery]);

  const closeAll = () => {
    setDisburse(null);
    setReject(null);
    setMomoRef('');
    setNotes('');
    setReason('');
    setSubmitting(false);
  };

  const handleMarkDisbursed = async () => {
    if (!disburse) return;
    if (momoRef.trim().length < 6) {
      toast.error('MoMo TID must be at least 6 characters');
      return;
    }
    setSubmitting(true);
    try {
      const { data: u } = await getSessionCheckedUser();
      const { error } = await supabase
        .from('landlord_payouts')
        .update({
          status: 'awaiting_agent_receipt',
          finops_disbursed_by: u.user?.id ?? null,
          finops_disbursed_at: new Date().toISOString(),
          finops_momo_reference: momoRef.trim(),
          finops_notes: notes.trim() || null,
          external_reference: momoRef.trim(),
          disbursed_at: new Date().toISOString(),
        })
        .eq('id', disburse.id)
        .eq('status', 'pending_finops_disbursement');

      if (error) throw error;

      // Issue permanent rent receipt and SMS the landlord
      let completion: LandlordPaymentCompletion = {
        payoutId: disburse.id,
        amount: disburse.amount,
        landlordName: disburse.landlord_name,
        tenantName: disburse.tenant_profile?.full_name ?? null,
        landlordPhone: disburse.landlord_phone,
        receiptUrl: null,
        receiptNumber: null,
        smsSent: false,
      };

      try {
        const { data: rec, error: recErr } = await supabase.functions.invoke('landlord-rent-receipt', {
          body: { payout_id: disburse.id },
        });
        if (!recErr && rec) {
          completion = {
            ...completion,
            receiptUrl: (rec as any).receipt_url ?? null,
            receiptNumber: (rec as any).receipt_number ?? null,
            smsSent: (rec as any).sms_sent === true || !!(rec as any).sms_sent_at,
          };
        }
      } catch {
        /* non-blocking */
      }

      try {
        await supabase.from('notifications').insert({
          user_id: disburse.agent_id,
          type: 'landlord_payout_disbursed',
          title: 'Landlord paid — upload receipt',
          message: `Financial Ops sent ${formatUGX(disburse.amount)} to ${disburse.landlord_name}. Please upload the receipt now.`,
          metadata: { payout_id: disburse.id, momo_reference: momoRef.trim() },
        });
      } catch {
        /* non-blocking */
      }

      toast.success('Marked as disbursed');
      qc.invalidateQueries({ queryKey: ['finops-landlord-payouts-queue-all'] });
      setCompletion(completion);

      setShareData({
        amount: disburse.amount,
        landlord_name: disburse.landlord_name,
        landlord_phone: disburse.landlord_phone,
        mobile_money_provider: disburse.mobile_money_provider,
        tenant_name: disburse.tenant_profile?.full_name ?? null,
        agent_name: disburse.agent_profile?.full_name ?? null,
        agent_phone: disburse.agent_profile?.phone ?? null,
        momo_reference: momoRef.trim(),
        paid_at: new Date().toISOString(),
      });
      closeAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to mark disbursed');
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    if (!reject) return;
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setSubmitting(true);
    try {
      const { error: refundErr } = await supabase.rpc('refund_agent_float_for_payout', {
        p_payout_id: reject.id,
        p_reason: `FINOPS_REJECT: ${reason.trim()}`,
      });
      if (refundErr) throw refundErr;

      const { data: u } = await getSessionCheckedUser();
      await supabase
        .from('landlord_payouts')
        .update({
          status: 'failed',
          last_error: `Rejected by Financial Ops: ${reason.trim()}`,
          finops_disbursed_by: u.user?.id ?? null,
          finops_notes: reason.trim(),
        })
        .eq('id', reject.id);

      try {
        await supabase.from('notifications').insert({
          user_id: reject.agent_id,
          type: 'landlord_payout_rejected',
          title: 'Landlord payout rejected',
          message: `Financial Ops rejected your ${formatUGX(reject.amount)} payout to ${reject.landlord_name}. Float refunded. Reason: ${reason.trim()}`,
          metadata: { payout_id: reject.id },
        });
      } catch {
        /* non-blocking */
      }

      try {
        await supabase.functions.invoke('notify-landlord-payout-rejected', {
          body: { payout_id: reject.id, reason: reason.trim() },
        });
      } catch {
        /* non-blocking */
      }

      toast.success('Rejected and refunded');
      qc.invalidateQueries({ queryKey: ['finops-landlord-payouts-queue-all'] });
      closeAll();
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to reject');
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 w-full pb-8">
      {/* 4 Top KPI Summary Cards matching Brand Architecture */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 w-full">
        {/* Metric 1: Pending Disbursement */}
        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs space-y-2 hover:border-primary/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending Disbursement</span>
            <span className="h-8 w-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Clock className="h-4 w-4" />
            </span>
          </div>
          <div>
            <p className="text-2xl font-black text-foreground tracking-tight">{kpiStats.pendingCount}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Awaiting MoMo TID settlement</p>
          </div>
        </div>

        {/* Metric 2: Pending Volume */}
        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs space-y-2 hover:border-primary/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Pending Volume</span>
            <span className="h-8 w-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Wallet className="h-4 w-4" />
            </span>
          </div>
          <div>
            <p className="text-2xl font-black text-foreground tracking-tight">{formatUGX(kpiStats.pendingVolume)}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Total queued for payout</p>
          </div>
        </div>

        {/* Metric 3: Disbursed Today / Total */}
        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs space-y-2 hover:border-primary/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Disbursed Today</span>
            <span className="h-8 w-8 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <CheckCircle2 className="h-4 w-4" />
            </span>
          </div>
          <div>
            <p className="text-2xl font-black text-foreground tracking-tight">{kpiStats.disbursedTodayCount}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">{formatUGX(kpiStats.disbursedTodayVolume)} settled</p>
          </div>
        </div>

        {/* Metric 4: Awaiting Agent Receipts */}
        <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs space-y-2 hover:border-primary/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Awaiting Receipts</span>
            <span className="h-8 w-8 rounded-xl bg-muted border border-border flex items-center justify-center text-muted-foreground">
              <Receipt className="h-4 w-4" />
            </span>
          </div>
          <div>
            <p className="text-2xl font-black text-foreground tracking-tight">{kpiStats.awaitingReceiptCount}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Disbursed, proof needed</p>
          </div>
        </div>
      </div>

      {/* Modern Filter & Search Bar matching VerifyDeposits / FinOps boards */}
      <div className="rounded-2xl border border-border/80 bg-card p-4 shadow-xs space-y-3 w-full">
        <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3">
          {/* Status Tabs */}
          <div className="flex items-center bg-muted/60 p-1 rounded-xl overflow-x-auto">
            <button
              type="button"
              onClick={() => setStatusFilter('pending')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                statusFilter === 'pending'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>Pending Disbursement</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums ${
                statusFilter === 'pending' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground'
              }`}>
                {kpiStats.pendingCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('awaiting_receipt')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                statusFilter === 'awaiting_receipt'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>Awaiting Receipt</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums ${
                statusFilter === 'awaiting_receipt' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground'
              }`}>
                {kpiStats.awaitingReceiptCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('disbursed')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                statusFilter === 'disbursed'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>Disbursed History</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums ${
                statusFilter === 'disbursed' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground'
              }`}>
                {kpiStats.disbursedCount}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap flex items-center gap-1.5 ${
                statusFilter === 'all'
                  ? 'bg-primary text-primary-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <span>All Payouts</span>
              <span className={`text-[10px] px-1.5 py-0.2 rounded-full font-bold tabular-nums ${
                statusFilter === 'all' ? 'bg-white/20 text-white' : 'bg-muted text-muted-foreground'
              }`}>
                {allPayouts.length}
              </span>
            </button>
          </div>

          {/* Quick tool triggers */}
          <div className="flex items-center gap-2">
            <Button
              variant={showReceiptLookup ? 'default' : 'outline'}
              size="sm"
              className={`h-9 text-xs font-semibold gap-1.5 rounded-xl ${
                showReceiptLookup
                  ? 'bg-primary text-primary-foreground'
                  : 'border-border/80 hover:bg-muted text-foreground'
              }`}
              onClick={() => setShowReceiptLookup(!showReceiptLookup)}
            >
              <Receipt className="h-3.5 w-3.5" />
              <span>{showReceiptLookup ? 'Hide Receipt Tracker' : 'Track Receipt'}</span>
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="h-9 px-3 text-xs font-semibold border-border/80 hover:bg-muted text-foreground gap-1.5 rounded-xl"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 text-primary ${isFetching ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">Sync</span>
            </Button>
          </div>
        </div>

        {/* Search input & Provider filter */}
        <div className="flex flex-col sm:flex-row items-center gap-2.5 pt-1">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search by landlord name, phone, agent, tenant, or MoMo TID..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-10 rounded-xl bg-background border-border/80 text-xs font-medium focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 w-full"
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <select
              value={providerFilter}
              onChange={(e) => setProviderFilter(e.target.value)}
              className="h-10 px-3 rounded-xl bg-background border border-border/80 text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40 shrink-0"
              aria-label="Filter by provider"
            >
              <option value="all">All Providers</option>
              <option value="mtn">MTN MoMo</option>
              <option value="airtel">Airtel Money</option>
            </select>

            {(searchQuery || providerFilter !== 'all') && (
              <Button
                variant="ghost"
                size="sm"
                className="h-10 px-3 text-xs font-semibold text-muted-foreground hover:text-foreground shrink-0 rounded-xl"
                onClick={() => {
                  setSearchQuery('');
                  setProviderFilter('all');
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Embedded Collapsible Receipt Tracker */}
      {showReceiptLookup && (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 shadow-2xs">
          <ReceiptNumberLookupPanel />
        </div>
      )}

      {/* Loading state */}
      {isLoading ? (
        <div className="flex flex-col items-center justify-center py-16 text-muted-foreground space-y-3">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-xs font-medium">Loading landlord payouts queue…</p>
        </div>
      ) : filteredPayouts.length === 0 ? (
        /* Empty state */
        <div className="rounded-2xl border border-dashed border-border/80 bg-card p-12 text-center space-y-3">
          <div className="h-12 w-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto">
            <Building2 className="h-6 w-6" />
          </div>
          <div>
            <h3 className="text-base font-bold text-foreground">No Landlord Payouts Found</h3>
            <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
              {searchQuery || providerFilter !== 'all' || statusFilter !== 'all'
                ? 'No payout requests match your current filters. Try changing or clearing filters.'
                : 'There are currently no landlord payouts waiting for disbursement.'}
            </p>
          </div>
          {(searchQuery || providerFilter !== 'all' || statusFilter !== 'all') && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-xl text-xs font-semibold border-border/80"
              onClick={() => {
                setSearchQuery('');
                setProviderFilter('all');
                setStatusFilter('all');
              }}
            >
              Reset Filters
            </Button>
          )}
        </div>
      ) : (
        /* Payout Cards List */
        <div className="space-y-3.5 w-full">
          {filteredPayouts.map((p) => {
            const isPending = p.status === 'pending_finops_disbursement';
            const isAwaitingReceipt = p.status === 'awaiting_agent_receipt';
            const isDisbursed = p.status === 'disbursed' || p.status === 'completed';

            return (
              <Card
                key={p.id}
                className="p-4 sm:p-5 border border-border/80 bg-card hover:border-primary/40 shadow-xs transition-colors rounded-2xl w-full"
              >
                {/* Header: Landlord name, Status Badge, Amount */}
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-3.5 pb-3 border-b border-border/60">
                  <div className="min-w-0 flex items-start gap-3">
                    <div className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0 font-bold text-sm">
                      <Building2 className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-base font-bold text-foreground truncate">{p.landlord_name}</p>
                        <Badge
                          variant="outline"
                          className={`text-[10px] font-bold uppercase tracking-wider rounded-md ${
                            isPending
                              ? 'bg-primary/10 text-primary border-primary/20'
                              : isAwaitingReceipt
                              ? 'bg-muted text-foreground border-border'
                              : isDisbursed
                              ? 'bg-primary/10 text-primary border-primary/20'
                              : 'bg-muted text-muted-foreground border-border'
                          }`}
                        >
                          {isPending
                            ? 'Pending MoMo TID'
                            : isAwaitingReceipt
                            ? 'Awaiting Agent Receipt'
                            : isDisbursed
                            ? 'Disbursed'
                            : p.status}
                        </Badge>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Landlord ID: <span className="font-mono">{p.landlord_id?.slice(0, 8)}…</span> · Submitted{' '}
                        {formatDistanceToNow(new Date(p.created_at), { addSuffix: true })}
                      </p>
                    </div>
                  </div>

                  <div className="text-left sm:text-right shrink-0">
                    <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">Payable Amount</p>
                    <p className="text-xl sm:text-2xl font-black text-foreground tracking-tight">{formatUGX(p.amount)}</p>
                  </div>
                </div>

                {/* Details row: MoMo Phone, Provider, Agent, Tenant */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2.5 bg-muted/30 border border-border/60 rounded-xl p-3 mb-3.5">
                  {/* Phone */}
                  <div className="flex items-center justify-between gap-2 p-1.5 rounded-lg bg-background border border-border/50">
                    <div className="flex items-center gap-2 min-w-0">
                      <Phone className="h-3.5 w-3.5 text-primary shrink-0" />
                      <div className="min-w-0">
                        <p className="text-[9px] uppercase font-bold text-muted-foreground">
                          {p.mobile_money_provider || 'Mobile Money'}
                        </p>
                        <p className="font-mono text-xs font-bold text-foreground truncate">{p.landlord_phone}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px] font-semibold text-primary hover:bg-primary/10"
                      onClick={() => copyText(p.landlord_phone, 'Phone number')}
                    >
                      <Copy className="h-3 w-3 mr-1" /> Copy
                    </Button>
                  </div>

                  {/* Recipient match */}
                  <div className="flex items-center justify-between gap-2 p-1.5 rounded-lg bg-background border border-border/50">
                    <div className="flex items-center gap-2 min-w-0">
                      <User className="h-3.5 w-3.5 text-primary shrink-0" />
                      <div className="min-w-0">
                        <p className="text-[9px] uppercase font-bold text-muted-foreground">MoMo Name</p>
                        <p className="text-xs font-bold text-foreground truncate">{p.landlord_name}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-[11px] font-semibold text-primary hover:bg-primary/10"
                      onClick={() => copyText(p.landlord_name, 'Landlord name')}
                    >
                      <Copy className="h-3 w-3 mr-1" /> Copy
                    </Button>
                  </div>

                  {/* Agent */}
                  <div className="p-1.5 rounded-lg bg-background border border-border/50 min-w-0">
                    <p className="text-[9px] uppercase font-bold text-muted-foreground">Submitting Agent</p>
                    <p className="text-xs font-semibold text-foreground truncate">
                      {p.agent_profile?.full_name || 'Assigned Agent'}
                    </p>
                  </div>

                  {/* Tenant */}
                  <div className="p-1.5 rounded-lg bg-background border border-border/50 min-w-0">
                    <p className="text-[9px] uppercase font-bold text-muted-foreground">For Tenant Plan</p>
                    <p className="text-xs font-semibold text-foreground truncate">
                      {p.tenant_profile?.full_name || 'Rent Plan Member'}
                    </p>
                  </div>
                </div>

                {/* If Disbursed: Show reference info */}
                {(p.finops_momo_reference || p.external_reference) && (
                  <div className="flex items-center justify-between gap-2 bg-primary/5 border border-primary/20 rounded-xl px-3 py-2 mb-3.5 text-xs">
                    <div className="flex items-center gap-2 min-w-0">
                      <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
                      <span className="font-semibold text-foreground">
                        MoMo TID:{' '}
                        <span className="font-mono font-bold text-primary">
                          {p.finops_momo_reference || p.external_reference}
                        </span>
                      </span>
                      {p.finops_disbursed_at && (
                        <span className="text-[11px] text-muted-foreground hidden sm:inline">
                          · {format(new Date(p.finops_disbursed_at), 'dd MMM yyyy, HH:mm')}
                        </span>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs font-semibold text-primary hover:bg-primary/10"
                      onClick={() => copyText(p.finops_momo_reference || p.external_reference || '', 'MoMo TID')}
                    >
                      <Copy className="h-3 w-3 mr-1" /> Copy TID
                    </Button>
                  </div>
                )}

                {/* Actions Row */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <div className="text-[11px] text-muted-foreground">
                    Rent Plan Ref: <span className="font-mono font-semibold">{p.rent_request_id?.slice(0, 8) || 'Direct'}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    {isPending ? (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          className="rounded-xl text-xs font-semibold border-border/80 hover:bg-muted text-foreground"
                          onClick={() => setReject(p)}
                        >
                          <XCircle className="h-3.5 w-3.5 mr-1" /> Reject & Refund
                        </Button>
                        <Button
                          size="sm"
                          className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-xl text-xs shadow-xs"
                          onClick={() => setDisburse(p)}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Approve with MoMo TID
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        className="rounded-xl text-xs font-semibold border-border/80 hover:bg-muted text-foreground gap-1.5"
                        onClick={() => {
                          setShareData({
                            amount: p.amount,
                            landlord_name: p.landlord_name,
                            landlord_phone: p.landlord_phone,
                            mobile_money_provider: p.mobile_money_provider,
                            tenant_name: p.tenant_profile?.full_name ?? null,
                            agent_name: p.agent_profile?.full_name ?? null,
                            agent_phone: p.agent_profile?.phone ?? null,
                            momo_reference: p.finops_momo_reference || p.external_reference || 'CONFIRMED',
                            paid_at: p.disbursed_at || p.finops_disbursed_at || new Date().toISOString(),
                          });
                        }}
                      >
                        <Share2 className="h-3.5 w-3.5 text-primary" />
                        <span>Share Receipt Card</span>
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* Mark Disbursed Dialog */}
      <Dialog open={!!disburse} onOpenChange={(open) => !open && closeAll()}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Approve Landlord Payout with MoMo TID</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              The agent paid {disburse && formatUGX(disburse.amount)} to {disburse?.landlord_name} via {disburse?.mobile_money_provider}. Enter the MoMo Transaction ID (TID) from the provider confirmation to settle this payout.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3.5 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="momo-ref" className="text-xs font-bold">
                MoMo Transaction ID (TID) *
              </Label>
              <Input
                id="momo-ref"
                value={momoRef}
                onChange={(e) => setMomoRef(e.target.value)}
                placeholder="e.g. 23891048123 or CK230420.1542.A12345"
                className="h-10 rounded-xl font-mono text-xs"
                autoFocus
              />
              <p className="text-[11px] text-muted-foreground">
                Minimum 6 characters. Must match the telecom SMS confirmation.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="momo-notes" className="text-xs font-bold">
                Notes (optional)
              </Label>
              <Textarea
                id="momo-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Internal settlement remarks or agent notes"
                className="rounded-xl text-xs"
              />
            </div>
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" size="sm" onClick={closeAll} disabled={submitting} className="rounded-xl text-xs">
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleMarkDisbursed}
              disabled={submitting || momoRef.trim().length < 6}
              className="bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-xl text-xs gap-1.5"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
              <span>Approve with TID</span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={!!reject} onOpenChange={(open) => !open && closeAll()}>
        <DialogContent className="sm:max-w-md rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base font-bold">Reject and Refund Landlord Payout</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              The agent's float will be refunded via security RPC. Provide a clear reason (≥10 characters) so the agent can correct the request.
            </DialogDescription>
          </DialogHeader>

          <div className="py-2 space-y-1.5">
            <Label htmlFor="reject-reason" className="text-xs font-bold">
              Rejection Reason *
            </Label>
            <Textarea
              id="reject-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="e.g. Wrong landlord MoMo phone number; agent must re-verify recipient details."
              className="rounded-xl text-xs"
              autoFocus
            />
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" size="sm" onClick={closeAll} disabled={submitting} className="rounded-xl text-xs">
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleReject}
              disabled={submitting || reason.trim().length < 10}
              className="rounded-xl text-xs font-semibold"
            >
              {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Reject & Refund'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Internal completion screen — receipt proof, link + SMS resend */}
      <LandlordPaymentCompletedDialog completion={completionState} onClose={() => setCompletion(null)} />

      {/* WhatsApp share card — opens after a successful TID approval */}
      <LandlordPayoutShareCard
        open={!!shareData}
        onOpenChange={(o) => !o && setShareData(null)}
        data={shareData}
      />
    </div>
  );
}