import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  ArrowDownToLine, CheckCircle, XCircle, Loader2, RefreshCw,
  Smartphone, Clock, Hand, Wallet, Briefcase, AlertTriangle, EyeOff, Eye, Unlock,
} from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { UserAvatar } from '@/components/UserAvatar';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import { extractToPhones, normalizeUgPhone } from '@/components/financial-ops/emailExtraction';
import { UserDrilldownDrawer } from '@/components/ops/UserDrilldownDrawer';
import { ReceiptCodeEntry } from '@/components/financial-ops/ReceiptCodeEntry';

interface WithdrawalRequest {
  id: string;
  user_id: string;
  amount: number;
  status: string;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  mobile_money_name: string | null;
  payout_method: string | null;
  bank_name: string | null;
  bank_account_number: string | null;
  bank_account_name: string | null;
  agent_location: string | null;
  reason: string | null;
  created_at: string;
  fin_ops_reference: string | null;
  hidden_from_merchant_queue?: boolean | null;
  assigned_cashout_agent_id: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  agent_id?: string | null;
  initiated_by?: string | null;
  proxy_partner_id?: string | null;
  linked_party?: string | null;
  cashout_agent?: { full_name: string | null; phone: string | null } | null;
  user?: { full_name: string; phone: string; avatar_url: string | null };
  proxy_agent?: { id: string; full_name: string | null; phone: string | null; avatar_url: string | null } | null;
}

import { formatDynamic } from '@/lib/currencyFormat';
const formatCurrency = formatDynamic;

type ActiveTab = 'pending' | 'rejected';

export function FinOpsWithdrawalVerification() {
  const { user } = useAuth();
  const [pendingRequests, setPendingRequests] = useState<WithdrawalRequest[]>([]);
  const [rejectedRequests, setRejectedRequests] = useState<WithdrawalRequest[]>([]);
  const [profileUser, setProfileUser] = useState<{ id: string; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  
  const [selected, setSelected] = useState<WithdrawalRequest | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [reference, setReference] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<string>('');

  // Suggested TIDs / references pulled from recent outgoing emails matching
  // this withdrawal (same recipient phone + amount, last 7 days). Lets the
  // operator one-tap-fill the reference instead of hunting through Gmail.
  type TidSuggestion = {
    tid: string;
    amount: number;
    date: string;
    channel: string | null;
    counterparty: string | null;
    used: boolean;
  };
  const [suggestedTids, setSuggestedTids] = useState<TidSuggestion[]>([]);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  
  const [activeTab, setActiveTab] = useState<ActiveTab>('pending');
  const [releasingClaim, setReleasingClaim] = useState<string | null>(null);

  // Release a merchant agent's claim on a withdrawal so it returns to the open queue.
  const handleReleaseClaim = async (req: WithdrawalRequest) => {
    setReleasingClaim(req.id);
    try {
      const { error } = await supabase
        .from('withdrawal_requests')
        .update({
          assigned_cashout_agent_id: null,
          claimed_by: null,
          claimed_at: null,
          dispatched_at: null,
        } as any)
        .eq('id', req.id);
      if (error) throw error;

      // Audit the release for traceability.
      try {
        await supabase.from('audit_logs').insert({
          user_id: user!.id,
          action_type: 'finops_claim_released',
          table_name: 'withdrawal_requests',
          record_id: req.id,
          metadata: {
            amount: Number(req.amount || 0),
            released_agent_name: req.cashout_agent?.full_name || null,
            released_agent_id: req.assigned_cashout_agent_id,
            released_at: new Date().toISOString(),
          },
        });
      } catch (auditErr) {
        console.warn('[finops-release-claim] audit log failed', auditErr);
      }

      toast.success('Claim released — withdrawal returned to open queue');
      fetchRequests();
    } catch (e: any) {
      console.error('[finops-release-claim]', e);
      toast.error(e.message || 'Failed to release claim');
    } finally {
      setReleasingClaim(null);
    }
  };

  // Landlord float payouts are funded from the agent's dedicated landlord
  // float (deducted at disburse time) — NOT their personal/withdrawable wallet.
  const isLandlordFloatReason = (reason?: string | null): boolean =>
    typeof reason === 'string' && reason.startsWith('Landlord float payout');

  // Map a withdrawal's payout_method + provider → the dialog's payment-method
  // dropdown value. Used to pre-select the method when an operator opens the
  // Approve dialog.
  const inferPaymentMethod = (req: WithdrawalRequest): string => {
    const m = (req.payout_method || 'mobile_money').toLowerCase();
    if (m === 'bank_transfer' || m === 'bank') return 'bank_transfer';
    if (m === 'cash') return 'cash';
    const prov = (req.mobile_money_provider || '').toLowerCase();
    if (prov.includes('airtel')) return 'airtel_money';
    return 'mtn_momo';
  };

  // Live wallet balances for the requester of each withdrawal.
  // Keyed by user_id → { withdrawable (personal), float (operational) }.
  const [walletBalances, setWalletBalances] = useState<
    Record<string, { withdrawable: number; float: number; pendingHolds: number; loading?: boolean }>
  >({});

  const fetchWalletBalances = useCallback(async (userIds: string[]) => {
    const uniq = Array.from(new Set(userIds.filter(Boolean)));
    if (uniq.length === 0) return;
    const results = await Promise.all(
      uniq.map(async (uid) => {
        const { data } = await supabase.rpc('get_user_wallet_view', { p_user_id: uid });
        const r = (data ?? {}) as Record<string, unknown>;
        return [uid, {
          withdrawable: Number((r.withdrawable as number | string | undefined) ?? 0),
          float: Number((r.float_balance as number | string | undefined) ?? 0),
          pendingHolds: Number((r.pending_holds as number | string | undefined) ?? 0),
        }] as const;
      })
    );
    setWalletBalances((prev) => {
      const next = { ...prev };
      for (const [uid, bal] of results) next[uid] = bal;
      return next;
    });
  }, []);

  // Landlord float payouts are funded from the agent's dedicated landlord
  // float (`agent_landlord_float`), NOT their personal/withdrawable wallet.
  // The float is deducted at disburse time and `approve-withdrawal` skips the
  // wallet debit, so the personal-wallet impact strip is misleading for these
  // rows. Track the landlord float balance keyed by agent user_id instead.
  const [landlordFloatBalances, setLandlordFloatBalances] = useState<Record<string, number>>({});

  const fetchLandlordFloatBalances = useCallback(async (agentIds: string[]) => {
    const uniq = Array.from(new Set(agentIds.filter(Boolean)));
    if (uniq.length === 0) return;
    const { data } = await supabase
      .from('agent_landlord_float')
      .select('agent_id, balance')
      .in('agent_id', uniq);
    setLandlordFloatBalances((prev) => {
      const next = { ...prev };
      for (const row of (data ?? []) as Array<{ agent_id: string; balance: number | string }>) {
        next[row.agent_id] = Number(row.balance ?? 0);
      }
      return next;
    });
  }, []);

  // Force re-render every 60s so the age chip stays fresh.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const fetchProfiles = async (data: any[]) => {
    if (!data.length) return [];
    const proxyIdFor = (r: any): string | null => {
      const aid = r.agent_id || r.initiated_by;
      if (aid && aid !== r.user_id) return aid;
      return null;
    };
    const userIds = [...new Set([
      ...data.map(r => r.user_id),
      ...data.map(r => r.claimed_by).filter(Boolean),
      ...data.map(r => r.assigned_cashout_agent_id).filter(Boolean),
      ...data.map(proxyIdFor).filter(Boolean),
    ])];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, full_name, phone, avatar_url')
      .in('id', userIds);
    const profileMap = new Map(profiles?.map(p => [p.id, p]) || []);
    return data.map(r => {
      const proxyId = proxyIdFor(r);
      const proxyProfile = proxyId ? profileMap.get(proxyId) : null;
      // Resolve the claiming agent: prefer claimed_by, fall back to assigned_cashout_agent_id
      const claimantProfile = (r.claimed_by && profileMap.get(r.claimed_by))
        || (r.assigned_cashout_agent_id && profileMap.get(r.assigned_cashout_agent_id))
        || null;
      return {
        ...r,
        user: profileMap.get(r.user_id) || { full_name: 'Unknown', phone: '', avatar_url: null },
        cashout_agent: claimantProfile,
        proxy_agent: proxyProfile
          ? { id: proxyId, full_name: proxyProfile.full_name, phone: proxyProfile.phone, avatar_url: proxyProfile.avatar_url }
          : null,
      };
    });
  };

  const fetchRequests = useCallback(async () => {
    try {
      // Fetch pending
      const { data: pendingData, error: pendingErr } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .in('status', ['pending', 'requested', 'manager_approved', 'cfo_approved', 'fin_ops_approved'])
        .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(100);

      if (pendingErr) throw pendingErr;

      // Fetch rejected (last 90 days)
      const { data: rejectedData, error: rejectedErr } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('status', 'rejected')
        .gte('created_at', new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString())
        .order('created_at', { ascending: false })
        .limit(100);

      if (rejectedErr) throw rejectedErr;

      const [pendingWithProfiles, rejectedWithProfiles] = await Promise.all([
        fetchProfiles(pendingData || []),
        fetchProfiles(rejectedData || []),
      ]);

      setPendingRequests(pendingWithProfiles);
      setRejectedRequests(rejectedWithProfiles);
      void fetchWalletBalances([
        ...pendingWithProfiles.map((r: any) => r.user_id),
        ...pendingWithProfiles.map((r: any) => r.proxy_agent?.id).filter(Boolean),
        ...rejectedWithProfiles.map((r: any) => r.user_id),
        ...rejectedWithProfiles.map((r: any) => r.proxy_agent?.id).filter(Boolean),
      ]);
      void fetchLandlordFloatBalances([
        ...pendingWithProfiles.filter((r: any) => isLandlordFloatReason(r.reason)).map((r: any) => r.user_id),
        ...rejectedWithProfiles.filter((r: any) => isLandlordFloatReason(r.reason)).map((r: any) => r.user_id),
      ]);
    } catch (e) {
      console.error('FinOps withdrawal fetch error:', e);
      toast.error('Failed to load withdrawal requests');
    } finally {
      setLoading(false);
    }
  }, [fetchWalletBalances, fetchLandlordFloatBalances]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  // When the Approve dialog opens for a withdrawal, (1) pre-fill the payment
  // method from the request and (2) fetch matching outgoing email TIDs so
  // the operator can one-tap the reference instead of typing it.
  useEffect(() => {
    if (!approveOpen || !selected) {
      setSuggestedTids([]);
      return;
    }
    setPaymentMethod((prev) => prev || inferPaymentMethod(selected));

    let cancelled = false;
    (async () => {
      setLoadingSuggestions(true);
      try {
        const amt = Number(selected.amount || 0);
        if (!amt) {
          if (!cancelled) setSuggestedTids([]);
          return;
        }
        const phone = normalizeUgPhone(selected.mobile_money_number || '');
        const method = (selected.payout_method || 'mobile_money').toLowerCase();
        const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('gmail_transactions')
          .select('id,amount,transaction_id,internal_date,channel,counterparty,subject,snippet,from_email,from_name,direction')
          .eq('direction', 'out')
          .not('transaction_id', 'is', null)
          .gte('amount', amt - 100)
          .lte('amount', amt + 100)
          .gte('internal_date', since)
          .order('internal_date', { ascending: false })
          .limit(50);
        if (error) throw error;
        const rows = (data ?? []).filter((r: any) => {
          // For mobile-money withdrawals we additionally require the
          // recipient phone to appear after "to" in the email body — this
          // is what discriminates the right TID from other same-amount
          // payouts on the same day.
          if (method === 'mobile_money' && phone) {
            return extractToPhones(r).includes(phone);
          }
          return true;
        });
        const tids = Array.from(
          new Set(rows.map((r: any) => String(r.transaction_id).trim().toUpperCase())),
        );
        const usedSet = new Set<string>();
        if (tids.length) {
          const { data: used } = await supabase
            .from('withdrawal_requests')
            .select('fin_ops_reference,status')
            .in('fin_ops_reference', tids);
          (used ?? []).forEach((u: any) => {
            if (!u.fin_ops_reference) return;
            if (['rejected', 'cancelled', 'failed', 'expired'].includes(String(u.status))) return;
            usedSet.add(String(u.fin_ops_reference).trim().toUpperCase());
          });
        }
        const seen = new Set<string>();
        const list: TidSuggestion[] = [];
        for (const r of rows as any[]) {
          const t = String(r.transaction_id).trim().toUpperCase();
          if (seen.has(t)) continue;
          seen.add(t);
          list.push({
            tid: t,
            amount: Number(r.amount) || 0,
            date: r.internal_date,
            channel: r.channel ?? null,
            counterparty: r.counterparty ?? null,
            used: usedSet.has(t),
          });
          if (list.length >= 6) break;
        }
        if (!cancelled) setSuggestedTids(list);
      } catch (e) {
        console.error('TID suggestion fetch failed:', e);
        if (!cancelled) setSuggestedTids([]);
      } finally {
        if (!cancelled) setLoadingSuggestions(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approveOpen, selected?.id]);

  // Realtime: refetch on any insert/update to withdrawal_requests so cards
  // disappear the moment ANY operator approves/rejects them.
  const fetchRef = useRef(fetchRequests);
  fetchRef.current = fetchRequests;
  useEffect(() => {
    const channel = supabase
      .channel('finops-withdrawals-rt')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'withdrawal_requests' },
        () => fetchRef.current(),
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  /**
   * Customer mobile-money withdrawals are settled by merchant agents from their
   * own MTN/Airtel float (they claim, they pay, we refund them). Financial Ops
   * only pays merchant agents and bank/cash payouts, so mobile money is
   * monitor-only on this desk.
   */
  const isMerchantOnlyPayout = (req: WithdrawalRequest) =>
    (req.payout_method || 'mobile_money').toLowerCase() === 'mobile_money';

  // Approve with TID/Receipt/Bank Ref → approved (final) via ledger-first edge function
  const handleApprove = async () => {
    if (!user || !selected || reference.trim().length < 3 || !paymentMethod) return;
    // Financial Ops pays merchant agents and banks only — never a customer's
    // mobile money. Customer mobile-money withdrawals are claimed and paid out
    // by merchant agents from their own MTN/Airtel float. FinOps monitors them.
    if (isMerchantOnlyPayout(selected)) {
      toast.error('Mobile money payouts are handled by merchant agents. Financial Ops can only monitor these.');
      setApproveOpen(false);
      return;
    }
    // Cash payouts are gated by the one-time WPO-XXXXX pickup code and MUST be
    // approved through ReceiptCodeEntry (which sends `payout_code`). If the
    // operator switched the dropdown away from "cash", block here so we never
    // hit the backend's CASH_CODE_REQUIRED 400.
    if ((selected.payout_method || '').toLowerCase() === 'cash') {
      toast.error('This is a cash payout — enter the WPO-XXXXX pickup code below to approve.');
      setPaymentMethod('cash');
      return;
    }
    setProcessing(selected.id);
    try {
      const { data, error } = await supabase.functions.invoke('approve-withdrawal', {
        body: {
          withdrawal_id: selected.id,
          reference: reference.trim().toUpperCase(),
          payment_method: paymentMethod,
        },
      });
      if (error || data?.error) {
        const msg = await extractEdgeFunctionError({ data, error }, 'Failed to approve');
        throw new Error(msg);
      }

      toast.success('Withdrawal approved & completed!');
      setPendingRequests(prev => prev.filter(r => r.id !== selected.id));
      setRejectedRequests(prev => prev.filter(r => r.id !== selected.id));
      setApproveOpen(false);
      setSelected(null);
      setReference('');
      setPaymentMethod('');
    } catch (e: any) {
      toast.error(e.message || 'Failed to approve');
    } finally {
      setProcessing(null);
    }
  };

  const handleReject = async () => {
    if (!user || !selected || rejectionReason.trim().length < 10) return;
    setProcessing(selected.id);
    try {
      const { data, error: rejectErr } = await supabase.functions.invoke('reject-withdrawal', {
        body: { withdrawal_ids: [selected.id], reason: rejectionReason.trim(), withdrawal_type: 'wallet' },
      });
      if (rejectErr) {
        const msg = await extractEdgeFunctionError({ data, error: rejectErr }, 'Failed to reject');
        throw new Error(msg);
      }

      const result = data?.results?.find((r: any) => r.id === selected.id);
      if (result?.status !== 'rejected') {
        toast.error(`Rejection failed: ${result?.status || 'unknown error'}`);
        return;
      }

      toast.success('Withdrawal rejected');
      setPendingRequests(prev => prev.filter(r => r.id !== selected.id));
      // Add to rejected list
      const rejectedItem = { ...selected, status: 'rejected' };
      setRejectedRequests(prev => [rejectedItem, ...prev]);
      setRejectOpen(false);
      setRejectionReason('');
      setSelected(null);
    } catch (e: any) {
      toast.error(e.message || 'Failed to reject');
    } finally {
      setProcessing(null);
    }
  };


  const getPayoutLabel = (req: WithdrawalRequest) => {
    const method = req.payout_method || 'mobile_money';
    if (method === 'bank_transfer') return `🏦 ${req.bank_name || 'Bank'} · ${req.bank_account_number || '—'}`;
    if (method === 'cash') return `💵 Cash at: ${req.agent_location || 'Agent'}`;
    return null;
  };

  // ─── Duplicate-cluster detection ────────────────────────────────────
  // Groups identical pending requests (same user → same recipient → same
  // amount) so ops can reject N-1 duplicates in one click instead of
  // clicking through five identical cards. Keeps the *newest* row in
  // each cluster as the live one.
  const duplicateKeyFor = (req: WithdrawalRequest): string | null => {
    const method = req.payout_method || 'mobile_money';
    if (method === 'mobile_money' && req.mobile_money_number) {
      const phone = String(req.mobile_money_number).replace(/\D/g, '');
      return `${req.user_id}|momo|${req.mobile_money_provider || ''}|${phone}|${req.amount}`;
    }
    if (method === 'bank_transfer' && req.bank_account_number) {
      return `${req.user_id}|bank|${req.bank_name || ''}|${req.bank_account_number}|${req.amount}`;
    }
    if (method === 'cash') {
      return `${req.user_id}|cash|${req.agent_location || ''}|${req.amount}`;
    }
    return null;
  };

  const duplicateClusters = (() => {
    const clusters = new Map<string, WithdrawalRequest[]>();
    for (const req of pendingRequests) {
      const k = duplicateKeyFor(req);
      if (!k) continue;
      const list = clusters.get(k) ?? [];
      list.push(req);
      clusters.set(k, list);
    }
    const result = new Map<string, WithdrawalRequest[]>();
    clusters.forEach((rows, k) => {
      if (rows.length < 2) return;
      rows.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
      result.set(k, rows);
    });
    return result;
  })();

  const handleBulkRejectDuplicates = async (cluster: WithdrawalRequest[]) => {
    if (!user || cluster.length < 2) return;
    const [newest, ...older] = cluster;
    const ids = older.map((r) => r.id);
    const ok = window.confirm(
      `Reject ${ids.length} older duplicate${ids.length === 1 ? '' : 's'} of this request?\n\n` +
        `Newest will stay (created ${new Date(newest.created_at).toLocaleTimeString()}). ` +
        `The other ${ids.length} identical submission${ids.length === 1 ? '' : 's'} will be rejected with reason "Duplicate of newer pending request".`,
    );
    if (!ok) return;
    setProcessing(ids[0]);
    try {
      const { data, error: rejectErr } = await supabase.functions.invoke('reject-withdrawal', {
        body: {
          withdrawal_ids: ids,
          reason: 'Duplicate of newer pending request — auto-rejected by Financial Ops to keep the queue clean.',
          withdrawal_type: 'wallet',
        },
      });
      if (rejectErr) {
        const msg = await extractEdgeFunctionError({ data, error: rejectErr }, 'Bulk reject failed');
        throw new Error(msg);
      }
      const rejectedIds = new Set<string>(
        (data?.results || [])
          .filter((r: any) => r.status === 'rejected')
          .map((r: any) => r.id as string),
      );
      if (rejectedIds.size === 0) {
        toast.error('No duplicates were rejected.');
        return;
      }
      setPendingRequests((prev) => prev.filter((r) => !rejectedIds.has(r.id)));
      setRejectedRequests((prev) => [
        ...older
          .filter((r) => rejectedIds.has(r.id))
          .map((r) => ({ ...r, status: 'rejected' as const })),
        ...prev,
      ]);
      toast.success(
        `Rejected ${rejectedIds.size} duplicate${rejectedIds.size === 1 ? '' : 's'} — newest kept for review.`,
      );
    } catch (e: any) {
      toast.error(e.message || 'Failed to reject duplicates');
    } finally {
      setProcessing(null);
    }
  };

  // FinOps-only visibility toggle — suppresses a withdrawal from the
  // Merchant Agent payout queue (src/lib/merchantPayoutQueue.ts) without
  // changing its status. Does not touch settlement state.
  const handleToggleHiddenFromMerchantQueue = async (req: WithdrawalRequest) => {
    if (!user) return;
    const nextHidden = !req.hidden_from_merchant_queue;
    setProcessing(req.id);
    try {
      const { error } = await supabase
        .from('withdrawal_requests')
        .update({
          hidden_from_merchant_queue: nextHidden,
          hidden_from_merchant_queue_at: nextHidden ? new Date().toISOString() : null,
          hidden_from_merchant_queue_by: nextHidden ? user.id : null,
        } as any)
        .eq('id', req.id);
      if (error) throw error;
      setPendingRequests((prev) =>
        prev.map((r) => (r.id === req.id ? { ...r, hidden_from_merchant_queue: nextHidden } : r)),
      );
      toast.success(
        nextHidden
          ? 'Hidden from the Merchant Agent payout queue.'
          : 'Visible in the Merchant Agent payout queue again.',
      );
    } catch (e: any) {
      toast.error(e.message || 'Failed to update merchant queue visibility');
    } finally {
      setProcessing(null);
    }
  };

  const getAgeBadge = (createdAt: string) => {
    const ms = Date.now() - new Date(createdAt).getTime();
    const minutes = Math.floor(ms / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    let label: string;
    if (days >= 30) label = `${Math.floor(days / 30)}mo old`;
    else if (days >= 7) label = `${Math.floor(days / 7)}w old`;
    else if (days >= 1) label = `${days}d old`;
    else if (hours >= 1) label = `${hours}h old`;
    else label = `${Math.max(1, minutes)}m old`;

    let variant: 'destructive' | 'warning' | 'secondary' = 'secondary';
    if (hours >= 4 || days >= 1) variant = 'destructive';
    else if (hours >= 1) variant = 'warning';

    return (
      <Badge variant={variant} size="sm" className="gap-1">
        <Clock className="h-2.5 w-2.5" />
        {label}
      </Badge>
    );
  };

  // Stage badge: tells the operator EXACTLY which approval is missing on a card.
  const getStageBadge = (status: string) => {
    switch (status) {
      case 'pending':
      case 'requested':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-[10px] font-bold uppercase tracking-wider">
            Awaiting Manager
          </span>
        );
      case 'manager_approved':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-500/10 border border-blue-500/30 text-blue-700 dark:text-blue-300 text-[10px] font-bold uppercase tracking-wider">
            Manager OK → Needs FinOps TID
          </span>
        );
      case 'cfo_approved':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-purple-500/10 border border-purple-500/30 text-purple-700 dark:text-purple-300 text-[10px] font-bold uppercase tracking-wider">
            CFO OK → Needs FinOps TID
          </span>
        );
      case 'fin_ops_approved':
        return (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-[10px] font-bold uppercase tracking-wider">
            FinOps OK → Finalising
          </span>
        );
      default:
        return null;
    }
  };

  const renderPendingCard = (req: WithdrawalRequest) => {
    void req;
    return _renderPendingCard(req);
  };

  const renderBalanceStrip = (req: WithdrawalRequest) => {
    const amount = Number(req.amount || 0);
    const proxy = req.proxy_agent || null;

    // ── Landlord float payout: funded from the agent's landlord float ──────
    // The float was already deducted at disburse time and approve-withdrawal
    // skips the agent's personal wallet entirely. Show the landlord float as
    // the true funding source instead of the misleading personal-wallet impact.
    if (isLandlordFloatReason(req.reason)) {
      const floatBal = landlordFloatBalances[req.user_id];
      const known = floatBal !== undefined;
      return (
        <div className="px-2 py-1.5 rounded-lg border bg-amber-500/5 border-amber-500/30 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              Landlord float: <span className="text-foreground normal-case font-semibold">{req.user?.full_name || 'Agent'}</span>
            </p>
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 font-semibold uppercase tracking-wider">
              Company float
            </span>
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <Briefcase className="h-3 w-3 text-amber-600 shrink-0" />
            <div className="min-w-0">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">Available landlord float</p>
              <p className="text-xs font-bold text-foreground truncate">{known ? formatCurrency(floatBal) : '—'}</p>
              {known && (
                <p className="text-[9px] text-muted-foreground truncate">→ {formatCurrency(Math.max(0, floatBal - amount))} after payout</p>
              )}
            </div>
          </div>
          <p className="text-[10px] text-muted-foreground leading-snug pt-0.5 border-t border-border/40">
            Already deducted from the agent's float at request time. The agent's personal wallet is never touched for this payout.
          </p>
          {known && floatBal < amount && (
            <div className="flex items-center gap-1 text-[10px] font-semibold text-destructive">
              <AlertTriangle className="h-3 w-3" />
              <span>Landlord float short {formatCurrency(amount - floatBal)} — verify before completing.</span>
            </div>
          )}
        </div>
      );
    }

    const renderOneWallet = (
      opts: {
        ownerLabel: string;
        ownerName: string;
        userId: string;
        showImpact: boolean;
        roleTag?: string;
      },
    ) => {
      const bal = walletBalances[opts.userId];
      const personal = bal?.withdrawable ?? 0;
      const float = bal?.float ?? 0;
      const pendingHolds = bal?.pendingHolds ?? 0;
      const totalAvailable = personal + float;
      const insufficient = opts.showImpact && bal !== undefined && totalAvailable < amount;
      const afterPersonal = Math.max(0, personal - amount);
      // Show "impact" assuming personal bucket is debited first, then float.
      const personalUsed = Math.min(personal, amount);
      const floatUsed = Math.min(float, Math.max(0, amount - personal));
      const afterFloat = float - floatUsed;
      return (
        <div
          className={`px-2 py-1.5 rounded-lg border space-y-1 ${
            insufficient
              ? 'bg-destructive/10 border-destructive/40'
              : 'bg-muted/40 border-border/50'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {opts.ownerLabel}: <span className="text-foreground normal-case font-semibold">{opts.ownerName}</span>
            </p>
            {opts.roleTag && (
              <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-semibold uppercase tracking-wider">
                {opts.roleTag}
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <div className="flex items-center gap-1.5 min-w-0">
              <Wallet className="h-3 w-3 text-primary shrink-0" />
              <div className="min-w-0">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">Personal</p>
                <p className="text-xs font-bold text-foreground truncate">
                  {bal ? formatCurrency(personal) : '—'}
                </p>
                {opts.showImpact && bal && (
                  <p className="text-[9px] text-muted-foreground truncate">
                    → {formatCurrency(afterPersonal)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 min-w-0">
              <Briefcase className="h-3 w-3 text-amber-600 shrink-0" />
              <div className="min-w-0">
                <p className="text-[9px] uppercase tracking-wider text-muted-foreground leading-none">Op. Float</p>
                <p className="text-xs font-bold text-foreground truncate">
                  {bal ? formatCurrency(float) : '—'}
                </p>
                {opts.showImpact && bal && (
                  <p className="text-[9px] text-muted-foreground truncate">
                    → {formatCurrency(afterFloat)}
                  </p>
                )}
              </div>
            </div>
          </div>
          {bal && pendingHolds > 0 && (
            <div className="flex items-center justify-between gap-2 px-1 py-1 rounded bg-amber-500/10 border border-amber-500/30">
              <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider">
                <Clock className="h-3 w-3" />
                Reserved against pending requests
              </span>
              <span className="text-[11px] font-bold text-amber-700 dark:text-amber-400 tabular-nums">
                {formatCurrency(pendingHolds)}
              </span>
            </div>
          )}
          {opts.showImpact && bal && (
            <div className="flex items-center justify-between text-[10px] pt-0.5 border-t border-border/40">
              <span className="text-muted-foreground">
                Debit {formatCurrency(amount)} → {personalUsed > 0 && `${formatCurrency(personalUsed)} personal`}{personalUsed > 0 && floatUsed > 0 ? ' + ' : ''}{floatUsed > 0 && `${formatCurrency(floatUsed)} float`}
              </span>
            </div>
          )}
          {insufficient && (
            <div className="flex items-center gap-1 text-[10px] font-semibold text-destructive">
              <AlertTriangle className="h-3 w-3" />
              <span>Insufficient — short {formatCurrency(amount - totalAvailable)}. Debit will be blocked.</span>
            </div>
          )}
        </div>
      );
    };

    // Proxy withdrawal: agent (proxy) is the debit source (v2 partner
    // withdrawals still hold partner.withdrawable, but operationally the
    // proxy agent's wallet is what FinOps must watch for funding). Show
    // BOTH wallets so the operator sees the full picture and the impact.
    if (proxy) {
      return (
        <div className="space-y-1.5">
          {renderOneWallet({
            ownerLabel: 'Requested by',
            ownerName: req.user?.full_name || 'Partner',
            userId: req.user_id,
            showImpact: true,
            roleTag: 'Partner',
          })}
          {renderOneWallet({
            ownerLabel: 'Proxy agent',
            ownerName: proxy.full_name || 'Agent',
            userId: proxy.id,
            showImpact: true,
            roleTag: 'Proxy',
          })}
        </div>
      );
    }

    return renderOneWallet({
      ownerLabel: 'Wallet',
      ownerName: req.user?.full_name || 'User',
      userId: req.user_id,
      showImpact: true,
    });
  };

  const _renderPendingCard = (req: WithdrawalRequest) => {
    const bankLabel = getPayoutLabel(req);
    const ageBadge = getAgeBadge(req.created_at);
    const cluster = (() => {
      const k = duplicateKeyFor(req);
      if (!k) return null;
      return duplicateClusters.get(k) ?? null;
    })();
    const isNewestInCluster = cluster ? cluster[0].id === req.id : false;
    const olderCount = cluster ? cluster.length - 1 : 0;
    return (
      <div key={req.id} className="p-3 rounded-xl border border-amber-500/30 bg-amber-500/5 space-y-2">
        {cluster && (
          <div className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border ${
            isNewestInCluster
              ? 'bg-destructive/10 border-destructive/30'
              : 'bg-muted/40 border-border/50'
          }`}>
            <span className="text-[11px] font-semibold flex items-center gap-1.5">
              <span className={isNewestInCluster ? 'text-destructive' : 'text-muted-foreground'}>
                ⚠ {cluster.length} duplicate submissions
              </span>
              <span className="text-muted-foreground font-normal">
                · same recipient · same amount
              </span>
              {!isNewestInCluster && (
                <span className="text-[10px] text-muted-foreground italic">
                  (older copy)
                </span>
              )}
            </span>
            {isNewestInCluster && olderCount > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-[11px] px-2 text-destructive border-destructive/40"
                onClick={() => handleBulkRejectDuplicates(cluster)}
                disabled={!!processing}
              >
                Reject {olderCount} older duplicate{olderCount === 1 ? '' : 's'}
              </Button>
            )}
          </div>
        )}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserAvatar fullName={req.user?.full_name || ''} avatarUrl={req.user?.avatar_url} size="sm" />
            <button
              type="button"
              onClick={() => setProfileUser({ id: req.user_id, name: req.user?.full_name || 'User' })}
              className="text-left group"
              title="Open full profile"
            >
              <p className="text-sm font-bold underline decoration-dotted underline-offset-2 group-hover:text-primary">{req.user?.full_name}</p>
              <p className="text-xs text-muted-foreground">{req.user?.phone} · tap for full profile</p>
            </button>
          </div>
          <div className="text-right space-y-1">
            <p className="text-base font-black">{formatCurrency(req.amount)}</p>
            <div className="flex items-center justify-end gap-1 flex-wrap">
              {getStageBadge(req.status)}
            </div>
          </div>
        </div>

        {renderBalanceStrip(req)}

        {req.hidden_from_merchant_queue && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/40 text-amber-700 dark:text-amber-300">
            <EyeOff className="h-3.5 w-3.5 shrink-0" />
            <p className="text-[11px] font-bold uppercase tracking-wide">
              Hidden from Merchant Agent payout queue
            </p>
          </div>
        )}

        {req.assigned_cashout_agent_id && (
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-orange-500/10 border border-orange-500/40 text-orange-700 dark:text-orange-300">
            <Hand className="h-3.5 w-3.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-wide">
                Claimed by Merchant Agent — DO NOT double-pay
              </p>
              <p className="text-[11px] font-medium truncate opacity-90">
                {req.cashout_agent?.full_name || 'Agent'}
                {req.cashout_agent?.phone ? ` · ${req.cashout_agent.phone}` : ''}
                {req.claimed_at ? ` · claimed ${formatDistanceToNow(new Date(req.claimed_at), { addSuffix: true })}` : ''}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 h-7 text-[11px] font-bold border-orange-500/50 text-orange-700 dark:text-orange-300 hover:bg-orange-500/20"
              disabled={releasingClaim === req.id}
              onClick={(e) => { e.stopPropagation(); handleReleaseClaim(req); }}
            >
              {releasingClaim === req.id
                ? <Loader2 className="h-3 w-3 animate-spin mr-1" />
                : <Unlock className="h-3 w-3 mr-1" />}
              Release Claim
            </Button>
          </div>
        )}

        {(req.mobile_money_name || req.bank_account_name) && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-primary/5 border border-primary/10">
            <span className="text-xs font-bold text-foreground">
              Recipient: {req.mobile_money_name || req.bank_account_name}
            </span>
          </div>
        )}

        {req.mobile_money_number && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Smartphone className="h-3 w-3" />
            <span className={`uppercase font-medium ${req.mobile_money_provider === 'mtn' ? 'text-yellow-600' : 'text-red-500'}`}>
              {req.mobile_money_provider || 'MoMo'}
            </span>
            <span>•</span>
            <span>{req.mobile_money_number}</span>
            {req.mobile_money_name && <><span>•</span><span>{req.mobile_money_name}</span></>}
          </div>
        )}

        {bankLabel && <p className="text-xs text-muted-foreground">{bankLabel}</p>}

        {req.reason?.includes('[Agent proxy:') && (
          <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-primary/10 border border-primary/20 text-primary text-[10px] font-semibold uppercase tracking-wider">
            👤 Proxy Agent Request
          </div>
        )}

        {req.reason && (
          <div className="px-2 py-1.5 rounded-lg bg-muted/50 border border-border/50">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Reason</p>
            <p className="text-xs text-foreground">{req.reason}</p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <p className="text-[10px] text-muted-foreground">
              Requested {formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}
            </p>
            {ageBadge}
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              className={`h-8 text-xs ${req.hidden_from_merchant_queue ? 'text-amber-600 border-amber-500/40 bg-amber-500/10' : 'text-muted-foreground'}`}
              onClick={() => handleToggleHiddenFromMerchantQueue(req)}
              disabled={!!processing}
              title={
                req.hidden_from_merchant_queue
                  ? 'Currently hidden from the Merchant Agent payout queue — click to make it visible again'
                  : 'Hide this withdrawal from the Merchant Agent payout queue'
              }
            >
              {req.hidden_from_merchant_queue ? (
                <><EyeOff className="h-3 w-3 mr-1" />Hidden from queue</>
              ) : (
                <><Eye className="h-3 w-3 mr-1" />Hide from queue</>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs text-destructive border-destructive/30"
              onClick={() => { setSelected(req); setRejectOpen(true); }}
              disabled={!!processing}
            >
              <XCircle className="h-3 w-3 mr-1" />
              Reject
            </Button>
            {isMerchantOnlyPayout(req) ? (
              <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-muted/60 border border-border text-[11px] font-medium text-muted-foreground">
                <Hand className="h-3 w-3" />
                A merchant agent pays this
              </span>
            ) : (
              <Button
                size="sm"
                className="h-8 text-xs bg-primary hover:bg-primary/90 text-primary-foreground"
                onClick={() => { setSelected(req); setApproveOpen(true); }}
                disabled={!!processing}
              >
                <CheckCircle className="h-3 w-3 mr-1" />
                Approve & Complete
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderRejectedCard = (req: WithdrawalRequest) => {
    const bankLabel = getPayoutLabel(req);
    const ageBadge = getAgeBadge(req.created_at);
    return (
      <div key={req.id} className="p-3 rounded-xl border border-destructive/30 bg-destructive/5 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <UserAvatar fullName={req.user?.full_name || ''} avatarUrl={req.user?.avatar_url} size="sm" />
            <button
              type="button"
              onClick={() => setProfileUser({ id: req.user_id, name: req.user?.full_name || 'User' })}
              className="text-left group"
              title="Open full profile"
            >
              <p className="text-sm font-bold underline decoration-dotted underline-offset-2 group-hover:text-primary">{req.user?.full_name}</p>
              <p className="text-xs text-muted-foreground">{req.user?.phone} · tap for full profile</p>
            </button>
          </div>
          <div className="text-right">
            <p className="text-base font-black">{formatCurrency(req.amount)}</p>
            <Badge variant="destructive" size="sm">Rejected</Badge>
          </div>
        </div>

        {renderBalanceStrip(req)}

        {(req.mobile_money_name || req.bank_account_name) && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-primary/5 border border-primary/10">
            <span className="text-xs font-bold text-foreground">
              Recipient: {req.mobile_money_name || req.bank_account_name}
            </span>
          </div>
        )}

        {req.mobile_money_number && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Smartphone className="h-3 w-3" />
            <span className={`uppercase font-medium ${req.mobile_money_provider === 'mtn' ? 'text-yellow-600' : 'text-red-500'}`}>
              {req.mobile_money_provider || 'MoMo'}
            </span>
            <span>•</span>
            <span>{req.mobile_money_number}</span>
          </div>
        )}

        {bankLabel && <p className="text-xs text-muted-foreground">{bankLabel}</p>}

        {req.reason && (
          <div className="px-2 py-1.5 rounded-lg bg-destructive/10 border border-destructive/20">
            <p className="text-[10px] font-semibold text-destructive uppercase tracking-wider mb-0.5">Rejection Reason</p>
            <p className="text-xs text-foreground">{req.reason}</p>
          </div>
        )}

        {(req as any).rejection_reason && !(req.reason) && (
          <div className="px-2 py-1.5 rounded-lg bg-destructive/10 border border-destructive/20">
            <p className="text-[10px] font-semibold text-destructive uppercase tracking-wider mb-0.5">Rejection Reason</p>
            <p className="text-xs text-foreground">{(req as any).rejection_reason}</p>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <p className="text-[10px] text-muted-foreground">
              Requested {formatDistanceToNow(new Date(req.created_at), { addSuffix: true })}
            </p>
            {ageBadge}
          </div>
          <div className="flex gap-2">
            {isMerchantOnlyPayout(req) ? (
              <span className="inline-flex items-center gap-1 h-8 px-2.5 rounded-lg bg-muted/60 border border-border text-[11px] font-medium text-muted-foreground">
                <Hand className="h-3 w-3" />
                A merchant agent pays this
              </span>
            ) : (
              <Button
                size="sm"
                className="h-8 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                onClick={() => { setSelected(req); setApproveOpen(true); }}
                disabled={!!processing}
              >
                <CheckCircle className="h-3 w-3 mr-1" />
                Re-Approve & Pay
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm flex items-center gap-2">
              <ArrowDownToLine className="h-4 w-4 text-primary" />
              Withdrawal Requests
            </CardTitle>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={fetchRequests}>
              <RefreshCw className="h-4 w-4" />
            </Button>
          </div>

          {/* Tabs */}
          <div className="flex gap-1 bg-muted/50 p-1 rounded-xl mt-2">
            <button
              onClick={() => setActiveTab('pending')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                activeTab === 'pending'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Pending
              {pendingRequests.length > 0 && (
                <Badge variant="warning" size="sm" className="text-[10px] px-1.5">{pendingRequests.length}</Badge>
              )}
            </button>
            <button
              onClick={() => setActiveTab('rejected')}
              className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5 ${
                activeTab === 'rejected'
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Rejected
              {rejectedRequests.length > 0 && (
                <Badge variant="destructive" size="sm" className="text-[10px] px-1.5">{rejectedRequests.length}</Badge>
              )}
            </button>
          </div>

          <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">Your role here is to watch, not to pay.</span>{' '}
              Customer mobile money withdrawals are claimed and paid out by merchant agents from
              their own MTN/Airtel money — you only refund the merchant agent afterwards. You still
              pay bank transfers and cash pickups yourself.
            </p>
          </div>
        </CardHeader>
        <CardContent>
          {activeTab === 'pending' ? (
            pendingRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No pending wallet withdrawals
              </p>
            ) : (
              <div className="space-y-2">
                {pendingRequests.map(req => renderPendingCard(req))}
              </div>
            )
          ) : (
            rejectedRequests.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No rejected withdrawals in the last 90 days
              </p>
            ) : (
              <div className="space-y-2">
                {rejectedRequests.map(req => renderRejectedCard(req))}
              </div>
            )
          )}
        </CardContent>
      </Card>

      {/* Approve & Complete Dialog */}
      <AlertDialog open={approveOpen} onOpenChange={(open) => { setApproveOpen(open); if (!open) { setReference(''); setPaymentMethod(''); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {selected?.status === 'rejected' ? 'Re-Approve & Complete Withdrawal' : 'Approve & Complete Withdrawal'}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 pt-1">
                {selected && (
                  <>
                    {selected.status === 'rejected' && (
                      <div className="px-2.5 py-2 rounded-lg bg-warning/10 border border-warning/30">
                        <p className="text-[10px] font-semibold text-warning uppercase tracking-wider mb-0.5">⚠️ Previously Rejected</p>
                        <p className="text-xs text-foreground">This withdrawal was rejected and is being re-approved. Ensure the reason for rejection has been resolved.</p>
                      </div>
                    )}
                    <div className="space-y-1.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Name</span>
                        <span className="font-semibold text-foreground">{selected.user?.full_name}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Phone</span>
                        <span className="font-mono text-foreground">{selected.user?.phone || '—'}</span>
                      </div>
                      {selected.mobile_money_number && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">MoMo</span>
                          <span className="text-foreground">
                            <span className={`uppercase font-medium ${selected.mobile_money_provider === 'mtn' ? 'text-yellow-600' : 'text-red-500'}`}>
                              {selected.mobile_money_provider || 'MoMo'}
                            </span>
                            {' · '}{selected.mobile_money_number}
                          </span>
                        </div>
                      )}
                      {(selected.mobile_money_name || selected.bank_account_name) && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Recipient</span>
                          <span className="font-semibold text-foreground">{selected.mobile_money_name || selected.bank_account_name}</span>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Amount</span>
                        <span className="font-black text-foreground">{formatCurrency(selected.amount)}</span>
                      </div>
                    </div>
                    {selected.reason && (
                      <div className="px-2.5 py-2 rounded-lg bg-muted/50 border border-border/50">
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-0.5">Reason</p>
                        <p className="text-xs text-foreground">{selected.reason}</p>
                      </div>
                    )}
                  </>
                )}
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">Payment Method Used</p>
                  <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Select payment method" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mtn_momo">MTN Mobile Money</SelectItem>
                      <SelectItem value="airtel_money">Airtel Money</SelectItem>
                      <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                      <SelectItem value="cash">Cash</SelectItem>
                    </SelectContent>
                  </Select>
                  {!paymentMethod && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 font-medium">
                      ⚠ Pick a method to enable Approve
                    </p>
                  )}
                </div>
                {paymentMethod === 'cash' ? (
                  selected && (
                    <ReceiptCodeEntry
                      withdrawalId={selected.id}
                      amount={selected.amount}
                      recipientName={selected.user?.full_name}
                      recipientPhone={selected.user?.phone}
                      onVerified={() => {
                        toast.success('Withdrawal approved & completed!');
                        const id = selected.id;
                        setPendingRequests(prev => prev.filter(r => r.id !== id));
                        setRejectedRequests(prev => prev.filter(r => r.id !== id));
                        setApproveOpen(false);
                        setSelected(null);
                        setReference('');
                        setPaymentMethod('');
                      }}
                      onCancel={() => { setApproveOpen(false); }}
                    />
                  )
                ) : (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">
                    {paymentMethod === 'bank_transfer' ? 'Bank Reference' : 'Transaction ID (TID)'}
                  </p>
                  {(loadingSuggestions || suggestedTids.length > 0) && (
                    <div className="mb-2 p-2 rounded-lg border border-primary/20 bg-primary/5">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-primary mb-1.5">
                        {loadingSuggestions
                          ? 'Scanning recent emails…'
                          : `Matching emails (last 7d) — tap to fill`}
                      </p>
                      {loadingSuggestions ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {suggestedTids.map((s) => (
                            <button
                              key={s.tid}
                              type="button"
                              onClick={() => setReference(s.tid)}
                              className={`px-2 py-1 rounded-md border text-[11px] font-mono transition-colors ${
                                s.used
                                  ? 'border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15'
                                  : reference.trim().toUpperCase() === s.tid
                                    ? 'border-primary bg-primary text-primary-foreground'
                                    : 'border-primary/40 bg-background hover:bg-primary/10 text-foreground'
                              }`}
                              title={`${formatCurrency(s.amount)} · ${new Date(s.date).toLocaleString()}${s.counterparty ? ` · ${s.counterparty}` : ''}${s.used ? ' · already used on another withdrawal' : ''}`}
                            >
                              <span className="font-bold">{s.tid}</span>
                              <span className="ml-1 opacity-70">{formatCurrency(s.amount)}</span>
                              {s.used && <span className="ml-1 font-bold">· USED</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  <Input
                    placeholder={paymentMethod === 'cash' ? 'Enter receipt number' : paymentMethod === 'bank_transfer' ? 'Enter bank reference' : 'Enter TID to confirm payment'}
                    value={reference}
                    onChange={e => setReference(e.target.value)}
                    className="font-mono uppercase"
                  />
                  {reference.length > 0 && reference.trim().length < 3 && (
                    <p className="text-[10px] text-destructive mt-1">Must be at least 3 characters</p>
                  )}
                  {reference.trim().length === 0 && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 mt-1 font-medium">
                      ⚠ Enter the TID / receipt to enable Approve
                    </p>
                  )}
                </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {paymentMethod === 'cash' ? (
              <AlertDialogCancel>Close</AlertDialogCancel>
            ) : (
              <>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <Button
                  type="button"
                  onClick={() => void handleApprove()}
                  disabled={!!processing || reference.trim().length < 3 || !paymentMethod}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white"
                >
                  {processing ? 'Processing...' : selected?.status === 'rejected' ? 'Re-Approve & Complete' : 'Approve & Complete'}
                </Button>
              </>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Reject Dialog */}
      <AlertDialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Withdrawal?</AlertDialogTitle>
            <AlertDialogDescription>
              Rejecting <strong>{selected ? formatCurrency(selected.amount) : ''}</strong> for {selected?.user?.full_name}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            placeholder="Reason for rejection (min 10 characters)..."
            value={rejectionReason}
            onChange={e => setRejectionReason(e.target.value)}
            className="mt-2"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={handleReject}
              disabled={rejectionReason.trim().length < 10 || !!processing}
              variant="destructive"
            >
              {processing ? 'Rejecting...' : 'Reject'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Full requester profile — wallet, balances, roles, transfers */}
      <UserDrilldownDrawer
        open={!!profileUser}
        onOpenChange={(o) => { if (!o) setProfileUser(null); }}
        agentId={profileUser?.id ?? null}
        tenantId={profileUser?.id ?? null}
        defaultTab="agent"
      />

    </>
  );
}
