import { useState, useEffect, useRef, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { MerchantPayoutDisputeAlarm } from '@/components/payouts/MerchantPayoutDisputeAlarm';
import { ProoflessPayoutBlocker } from '@/components/payouts/ProoflessPayoutBlocker';
import { getTelecomSendingCharge, getCashoutCommission } from '@/lib/cashoutCharges';
import { format, startOfMonth, subDays } from 'date-fns';
import {
  Banknote, QrCode, Search, CheckCircle2, Loader2,
  Smartphone, Wallet, Bell, TrendingUp, Clock, Hash, Phone, UserCheck, Coins,
  CalendarIcon, X, ArrowUp, ArrowDown, SlidersHorizontal, ArrowUpDown, Landmark,
  ChevronLeft, ChevronRight, ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import { WithdrawalPayoutCard } from '@/components/withdrawals/WithdrawalPayoutCard';
import { MerchantFloatAvailableCard } from '@/components/agent/MerchantFloatAvailableCard';
import { MerchantAgreementGate } from '@/components/merchant/agreement/MerchantAgreementGate';
import { MerchantOnlineToggle } from '@/components/agent/MerchantOnlineToggle';
import { MerchantDispatchHistory } from '@/components/agent/MerchantDispatchHistory';
import { MerchantPayoutsAuditDialog } from '@/components/agent/MerchantPayoutsAuditDialog';
import {
  normalizeCashoutAgentConfig,
  buildQueueCategoryOrClause,
  isWithdrawalCategoryAuthorized,
  isWithdrawalChannelAuthorized,
  buildChannelProviderOrClause,
  authorizedQueueCategoryLabels,
  getWithdrawalQueueCategory,
  type CashoutAgentConfig,
} from '@/lib/cashoutAgentConfig';
import { useWithdrawalsPaused } from '@/hooks/useWithdrawalsPaused';
import {
  PROXY_PRIORITY_BLOCK_MESSAGE, PROXY_PRIORITY_WAITING_LABEL, URGENT_PROXY_BADGE_LABEL,
  isUrgentProxyWithdrawal, sortProxyPriorityFirst, isUrgentProxyBlocking,
} from '@/lib/proxyPriorityQueue';
import { useProxyPayoutPriority } from '@/hooks/useProxyPayoutPriority';
import {
  LANDLORD_PRIORITY_BLOCK_MESSAGE, LANDLORD_PRIORITY_WAITING_LABEL, URGENT_LANDLORD_BADGE_LABEL,
  isUrgentLandlordPayout, sortLandlordPriorityFirst, isUrgentLandlordBlocking,
} from '@/lib/landlordPriorityQueue';
import { useLandlordPayoutPriority } from '@/hooks/useLandlordPayoutPriority';
import { invalidateWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { AlertTriangle } from 'lucide-react';

import {
  MERCHANT_QUEUE_STATUSES,
  isMerchantQueueActionable,
  isMerchantQueueSettled,
  applyMerchantQueueFence,
} from '@/lib/merchantPayoutQueue';

// Aligned with FinOps dashboard (FinOpsWithdrawalVerification) so pending counts
// match across dashboards. Sourced from the shared fence module, which mirrors the
// database view `public.v_merchant_payout_queue` exactly.
const CASHOUT_QUEUE_STATUSES = MERCHANT_QUEUE_STATUSES as unknown as string[];
// Statuses `claim_withdrawal_verified` treats as an open claim (queue statuses
// plus legacy 'approved'). Used only for "Claimed by you", never the shared queue.
const MY_ACTIVE_CLAIM_STATUSES = [...CASHOUT_QUEUE_STATUSES, 'approved'];

type PayoutChannel = 'momo' | 'cash' | 'bank';

const normalizePayoutMethod = (value?: string | null) =>
  String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

const getPayoutChannel = (withdrawal: any): PayoutChannel => {
  const method = normalizePayoutMethod(withdrawal?.payout_method);
  const flatMethod = method.replace(/_/g, '');

  // Bank first — keep it a distinct channel from generic cash pickups.
  if (['bank_transfer', 'banktransfer', 'bank', 'bank_account', 'bankaccount'].includes(method) || flatMethod.includes('bank')) {
    return 'bank';
  }

  if (['cash', 'cash_pickup', 'cashpickup', 'agent_cash', 'agentcash', 'payout_code', 'payoutcode'].includes(method) || ['cashpickup', 'agentcash', 'payoutcode'].includes(flatMethod)) {
    return 'cash';
  }

  if (flatMethod.includes('mobilemoney') || flatMethod.includes('momo') || flatMethod.includes('mtn') || flatMethod.includes('airtel')) {
    return 'momo';
  }

  if (withdrawal?.mobile_money_number || withdrawal?.mobile_money_provider || withdrawal?.mobile_money_name) {
    return 'momo';
  }

  return 'cash';
};

const getRecipientPhone = (withdrawal: any) => {
  const channel = getPayoutChannel(withdrawal);
  return channel === 'momo'
    ? withdrawal.mobile_money_number || withdrawal.profiles?.phone || '—'
    : withdrawal.profiles?.phone || withdrawal.mobile_money_number || '—';
};

const MERCHANT_LABELS: Record<string, string> = {
  mtn: 'MTN MoMo',
  airtel: 'Airtel Money',
  momo_other: 'Other Mobile Money',
  bank: 'Bank Transfer',
  cash: 'Cash',
};

const isLandlordFloatPayout = (withdrawal: any) =>
  typeof withdrawal?.reason === 'string' && withdrawal.reason.startsWith('Landlord float payout');

// ---- Server-side Pending Queue helpers (keeps the tab fast with many payouts) ----
const PAGE_SIZE = 20;

// Static merchant/provider options for the filter (server-side, so we don't need
// to load the whole queue just to discover which merchants are present).
const MERCHANT_OPTIONS = ['mtn', 'airtel', 'momo_other', 'bank', 'cash'];

// Strip characters that are reserved inside a PostgREST `.or()` filter string.
const sanitizeOrTerm = (t: string) => t.replace(/[(),*%]/g, ' ').trim();

interface QueueFilterOpts {
  status: 'all' | 'standard' | 'landlord';
  merchant: string;
  minAmount: number | null;
  maxAmount: number | null;
  fromIso: string | null;
  toIso: string | null;
  channel: 'all' | 'momo' | 'cash' | 'bank';
  searchUserIds: string[] | null;
  searchTerm: string;
  /**
   * PostgREST `.or()` clause restricting the queue to only the payout
   * categories this Cash-Out Agent is authorized to process. `null` = no
   * restriction (authorized for everything, or matrix not loaded yet).
   */
  categoryOrClause: string | null;
  /**
   * PostgREST `.or()` clause restricting the queue to the exact payment
   * channels AND providers/banks assigned to this Cash-Out Agent. `null` = no
   * restriction.
   */
  channelProviderOrClause?: string | null;
  /**
   * User ids whose accounts are currently frozen. Their withdrawal requests are
   * excluded from the queue entirely — a frozen account must never be payable.
   */
  frozenUserIds?: string[] | null;
}

/**
 * Applies every Pending Queue filter directly to a PostgREST query builder so
 * the database does the work and only the requested page travels over the wire.
 * Each `.or()` group is ANDed with the others by PostgREST, which is exactly
 * the semantics we want for combining independent filters.
 */
function applyQueueFilters(q: any, o: QueueFilterOpts) {
  // Hard settlement fence (shared with the DB view `v_merchant_payout_queue`):
  // queue statuses only, and a payout that carries a FinOps reference or a
  // processed timestamp has already been confirmed — such a row must NEVER be
  // returned by the merchant queue, even if its status column were somehow
  // left in a queue state by a failed follow-up write.
  q = applyMerchantQueueFence(q);
  // Available = unclaimed only. There is no time-based auto-release any more —
  // a claim stays with whoever took it until they confirm it (telecom
  // confirmation SMS can be delayed well past any fixed window) or a human
  // (FinOps/CFO) manually releases it. Excludes rows currently claimed by
  // anyone (including me — those live in "Claimed by you").
  q = q.is('assigned_cashout_agent_id', null);

  // Authorized payout categories (CFO permission matrix). Only surface rows in
  // the categories mapped to this agent.
  if (o.categoryOrClause) q = q.or(o.categoryOrClause);

  // Assigned channels + exact providers/banks. A merchant must never see (or be
  // able to claim) a payout for a bank or mobile-money network the CFO has not
  // assigned to them, even when the parent channel is enabled.
  if (o.channelProviderOrClause) q = q.or(o.channelProviderOrClause);

  // Frozen accounts must vanish from the payout queue — never payable.
  if (o.frozenUserIds && o.frozenUserIds.length) {
    const list = `(${o.frozenUserIds.join(',')})`;
    // Exclude when EITHER the requesting user OR the linked party
    // (proxy partner withdrawals) is currently frozen.
    q = q.not('user_id', 'in', list);
    q = q.or(`linked_party.is.null,linked_party.not.in.${list}`);
  }

  // Landlord float payout vs standard payout.
  if (o.status === 'landlord') {
    q = q.ilike('reason', 'Landlord float payout%');
  } else if (o.status === 'standard') {
    q = q.or('reason.is.null,reason.not.ilike.*Landlord float payout*');
  }

  // Amount range.
  if (o.minAmount != null && !Number.isNaN(o.minAmount)) q = q.gte('amount', o.minAmount);
  if (o.maxAmount != null && !Number.isNaN(o.maxAmount)) q = q.lte('amount', o.maxAmount);

  // Request date range (created_at).
  if (o.fromIso) q = q.gte('created_at', o.fromIso);
  if (o.toIso) q = q.lte('created_at', o.toIso);

  // Channel (MoMo vs Cash).
  if (o.channel === 'momo') {
    q = q.or('payout_method.ilike.*momo*,payout_method.ilike.*mobile*,payout_method.ilike.*mtn*,payout_method.ilike.*airtel*,mobile_money_number.not.is.null,mobile_money_provider.not.is.null');
  } else if (o.channel === 'bank') {
    q = q.ilike('payout_method', '%bank%');
  } else if (o.channel === 'cash') {
    q = q.or('payout_method.ilike.*cash*,payout_method.ilike.*pickup*');
  }

  // Merchant / provider.
  if (o.merchant === 'mtn') q = q.ilike('mobile_money_provider', '%mtn%');
  else if (o.merchant === 'airtel') q = q.ilike('mobile_money_provider', '%airtel%');
  else if (o.merchant === 'bank') q = q.ilike('payout_method', '%bank%');
  else if (o.merchant === 'cash') q = q.ilike('payout_method', '%cash%');
  else if (o.merchant === 'momo_other') q = q.not('mobile_money_provider', 'is', null);

  // Search by name / phone (name lives in profiles — resolved to user ids first).
  if (o.searchTerm) {
    const t = sanitizeOrTerm(o.searchTerm);
    if (t) {
      const parts: string[] = [];
      if (o.searchUserIds && o.searchUserIds.length) parts.push(`user_id.in.(${o.searchUserIds.join(',')})`);
      parts.push(`mobile_money_number.ilike.*${t}*`);
      parts.push(`mobile_money_name.ilike.*${t}*`);
      q = q.or(parts.join(','));
    }
  }
  return q;
}

function applyQueueSort(q: any, sort: string) {
  switch (sort) {
    case 'date_asc':
      return q.order('created_at', { ascending: true });
    case 'amount_desc':
      return q.order('amount', { ascending: false });
    case 'amount_asc':
      return q.order('amount', { ascending: true });
    case 'status':
      return q.order('reason', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false });
    case 'date_desc':
    default:
      return q.order('created_at', { ascending: false });
  }
}

/** Resolve profile ids whose name or phone match the search term. */
async function resolveSearchUserIds(term: string): Promise<string[]> {
  const t = sanitizeOrTerm(term);
  if (!t) return [];
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .or(`full_name.ilike.*${t}*,phone.ilike.*${t}*`)
    .limit(500);
  return (data || []).map((p: any) => p.id);
}

/** Fetch ids of all currently-frozen accounts so their payouts are hidden. */
async function resolveFrozenUserIds(): Promise<string[]> {
  const { data } = await supabase
    .from('profiles')
    .select('id')
    .eq('is_frozen', true)
    .limit(5000);
  return (data || []).map((p: any) => p.id);
}

/** Attach profile name/phone to a small page of withdrawal rows (no FK embed). */
async function attachProfiles(rows: any[]) {
  if (!rows || rows.length === 0) return rows || [];
  // Resolve BOTH the requesting user and any linked partner (proxy partner
  // withdrawals set `linked_party`), so merchant agents see the real partner
  // name instead of "Unknown".
  const ids = Array.from(
    new Set(
      rows.flatMap((r: any) => [r.user_id, r.linked_party]).filter(Boolean),
    ),
  );
  if (ids.length === 0) return rows;
  const { data: profs } = await supabase
    .from('profiles')
    .select('id, full_name, phone')
    .in('id', ids);
  const map = new Map((profs || []).map((p: any) => [p.id, p]));
  return rows.map((r: any) => ({
    ...r,
    profiles: map.get(r.user_id) || null,
    linked_party_profile: r.linked_party ? map.get(r.linked_party) || null : null,
  }));
}

export function AgentCashPayoutsTab() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { paused: withdrawalsPaused } = useWithdrawalsPaused();
  const [payoutCode, setPayoutCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifiedPayout, setVerifiedPayout] = useState<any>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

  // Date range filter for the commission breakdown. Defaults to "today" so the
  // card shows the volume processed and payout count for the current day.
  const [rangeFrom, setRangeFrom] = useState<Date | undefined>(() => new Date());
  const [rangeTo, setRangeTo] = useState<Date | undefined>(() => new Date());
  const fromKey = rangeFrom ? format(rangeFrom, 'yyyy-MM-dd') : '';
  const toKey = rangeTo ? format(rangeTo, 'yyyy-MM-dd') : '';

  // Incremental pagination for the breakdown lists so large datasets stay light.
  const TYPE_PAGE = 6;
  const DAY_PAGE = 10;
  const [typeVisible, setTypeVisible] = useState(TYPE_PAGE);
  const [dayVisible, setDayVisible] = useState(DAY_PAGE);
  // Reset visible counts whenever the date range changes.
  useEffect(() => {
    setTypeVisible(TYPE_PAGE);
    setDayVisible(DAY_PAGE);
  }, [fromKey, toKey]);

  // Sorting controls for the breakdown tables.
  const [daySort, setDaySort] = useState<{ key: 'date' | 'total'; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'desc' });
  const [typeSort, setTypeSort] = useState<{ key: 'type' | 'total'; dir: 'asc' | 'desc' }>({ key: 'total', dir: 'desc' });

  // Reset each breakdown list to the first page whenever its sort changes.
  useEffect(() => {
    setTypeVisible(TYPE_PAGE);
  }, [typeSort]);
  useEffect(() => {
    setDayVisible(DAY_PAGE);
  }, [daySort]);
  const toggleDaySort = (key: 'date' | 'total') =>
    setDaySort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));
  const toggleTypeSort = (key: 'type' | 'total') =>
    setTypeSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  // Per-request submission locks. The refs guard SYNCHRONOUSLY on tap (before any
  // re-render) so a rapid double-tap can never fire the same mutation twice; the
  // state mirrors them only to drive the disabled/loading UI.
  const claimLockRef = useRef<Set<string>>(new Set());
  // Tracks withdrawal ids we've already sent a timeout-release SMS for, so the
  // per-second ticker doesn't fire duplicate notifications before the refetch.
  const completeLockRef = useRef<Set<string>>(new Set());
  const [claimingIds, setClaimingIds] = useState<Set<string>>(new Set());
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  // Anchor for the "Claimed by you" section so we can scroll to a freshly
  // claimed cash-out as soon as the claim commits.
  const claimedSectionRef = useRef<HTMLDivElement | null>(null);
  const scrollToClaimed = useRef(false);

  // ---- Pending Queue advanced filters & sorting ----
  const [queueSearch, setQueueSearch] = useState('');
  const [queueStatus, setQueueStatus] = useState<'all' | 'standard' | 'landlord'>('all');
  const [queueMerchant, setQueueMerchant] = useState<string>('all');
  const [queueMin, setQueueMin] = useState('');
  const [queueMax, setQueueMax] = useState('');
  const [queueFrom, setQueueFrom] = useState<Date | undefined>(undefined);
  const [queueTo, setQueueTo] = useState<Date | undefined>(undefined);
  const [queueSort, setQueueSort] = useState<'date_desc' | 'date_asc' | 'amount_desc' | 'amount_asc' | 'status'>('date_desc');

  // Channel tab + server-side pagination state for the Pending Queue.
  const [channelTab, setChannelTab] = useState<'all' | 'momo' | 'cash' | 'bank'>('all');
  const [page, setPage] = useState(0);

  // Debounce the search box so we don't fire a query on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(queueSearch), 300);
    return () => clearTimeout(t);
  }, [queueSearch]);

  // Computed filter primitives shared by the page + count queries.
  const minAmount = queueMin.trim() === '' ? null : Number(queueMin);
  const maxAmount = queueMax.trim() === '' ? null : Number(queueMax);
  const fromIso = queueFrom
    ? new Date(queueFrom.getFullYear(), queueFrom.getMonth(), queueFrom.getDate()).toISOString()
    : null;
  const toIso = queueTo
    ? new Date(queueTo.getFullYear(), queueTo.getMonth(), queueTo.getDate(), 23, 59, 59, 999).toISOString()
    : null;

  // Any filter/sort/tab change returns to the first page.
  useEffect(() => {
    setPage(0);
  }, [debouncedSearch, queueStatus, queueMerchant, minAmount, maxAmount, fromIso, toIso, queueSort, channelTab]);

  const queueFiltersActive =
    queueSearch.trim() !== '' || queueStatus !== 'all' || queueMerchant !== 'all' ||
    queueMin !== '' || queueMax !== '' || !!queueFrom || !!queueTo;

  const resetQueueFilters = () => {
    setQueueSearch('');
    setQueueStatus('all');
    setQueueMerchant('all');
    setQueueMin('');
    setQueueMax('');
    setQueueFrom(undefined);
    setQueueTo(undefined);
  };

  type ClaimConfirmation = { momoNumber?: string | null; momoName?: string | null };
  const handleClaim = (id: string, confirm?: ClaimConfirmation) => {
    if (claimLockRef.current.has(id)) return; // already submitting this request
    if (withdrawalsPaused) {
      toast.error('Withdrawals are paused platform-wide. Merchant processing is temporarily disabled.');
      return;
    }
    // Category permission gate: a merchant agent may only claim payouts in the
    // categories the CFO mapped to them in the permission matrix.
    const row =
      (queuePage?.rows ?? []).find((w: any) => w.id === id) ||
      myActiveClaims.find((w: any) => w.id === id);
    if (row && !isWithdrawalCategoryAuthorized(agentConfig, row)) {
      const cat = getWithdrawalQueueCategory(row);
      toast.error(`Not authorized: you can't process "${cat.label}" payouts. Ask the CFO to enable this category.`);
      return;
    }
    // Channel + provider gate: the exact bank / mobile-money network must be
    // assigned to this merchant, not just the parent payment channel.
    if (row && !isWithdrawalChannelAuthorized(agentConfig, row)) {
      const provider = row.payout_method === 'bank_transfer' ? (row.bank_name || 'this bank') : (row.mobile_money_provider || 'this channel');
      toast.error(`Not authorized: ${provider} payouts are not assigned to you. Ask the CFO to enable it.`);
      return;
    }
    // One claim at a time: block claiming a NEW request while another is open.
    const alreadyMine = myActiveClaims.some((w: any) => w.id === id);
    if (!alreadyMine && myActiveClaims.length > 0) {
      toast.error('Finish your current claim before claiming another.');
      claimedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    // Landlord-payout priority gate: while an unclaimed landlord float payout
    // exists, only landlord payouts may be claimed.
    if (
      blockingUrgentLandlord &&
      blockingUrgentLandlord.id !== id &&
      !isUrgentLandlordPayout(row || undefined)
    ) {
      toast.error(LANDLORD_PRIORITY_BLOCK_MESSAGE);
      return;
    }
    // Proxy-agent priority gate: while an urgent proxy withdrawal is unclaimed,
    // only that payout may be claimed. The server enforces this too
    // (`proxy_priority_hold`); this is the fast, explicit client message.
    if (
      blockingUrgentProxy &&
      blockingUrgentProxy.id !== id &&
      !isUrgentProxyWithdrawal(row || undefined)
    ) {
      toast.error(PROXY_PRIORITY_BLOCK_MESSAGE);
      return;
    }
    claimLockRef.current.add(id);
    setClaimingIds(new Set(claimLockRef.current));
    toast.info('Claiming withdrawal… please wait', { id: `claim-${id}`, duration: 4000 });
    claimWithdrawal.mutate({
      id,
      momoNumber: confirm?.momoNumber ?? null,
      momoName: confirm?.momoName ?? null,
    });
  };

  const handleComplete = (data: {
    id: string; reference: string; method: string; sms?: string;
    proofUrl?: string; proofType?: string;
  }) => {
    if (completeLockRef.current.has(data.id)) return Promise.resolve(); // already submitting this request
    completeLockRef.current.add(data.id);
    setCompletingIds(new Set(completeLockRef.current));
    toast.info('Confirming payout… please wait', { id: `complete-${data.id}`, duration: 4000 });
    // Return the promise so the payout card can surface a specific, inline
    // retry prompt when server-side SMS validation rejects the paste.
    return completeWithdrawal.mutateAsync(data);
  };

  // Invalidate every Pending Queue query (page, counts, available total, my claims).
  const invalidateQueue = () => {
    qc.invalidateQueries({ queryKey: ['cashout-queue-page'] });
    qc.invalidateQueries({ queryKey: ['cashout-queue-counts'] });
    qc.invalidateQueries({ queryKey: ['cashout-queue-available-total'] });
    qc.invalidateQueries({ queryKey: ['cashout-my-active-claims'] });
    // The priority hold is released as soon as the urgent proxy payout is
    // claimed, completed, cancelled or failed.
    qc.invalidateQueries({ queryKey: ['cashout-blocking-urgent-proxy'] });
    // Same for the landlord float payout hold (server gate:
    // assert_no_urgent_landlord_priority -> 'landlord_priority_hold').
    qc.invalidateQueries({ queryKey: ['cashout-blocking-urgent-landlord'] });
  };

  // Check if this agent is a cashout agent
  const { data: isCashoutAgent, isLoading: cashoutAgentLoading } = useQuery({
    queryKey: ['is-cashout-agent', user?.id],
    queryFn: async () => {
      if (!user) return null;
      const { data } = await supabase
        .from('cashout_agents')
        .select('*')
        .eq('agent_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      return data;
    },
    enabled: !!user,
    // Permission edits by the CFO must take effect for this merchant right away.
    staleTime: 0,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  // Live enforcement: when the CFO changes this merchant's channels / categories,
  // refresh the matrix and the queue immediately.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`cashout-agent-config-${user.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'cashout_agents', filter: `agent_id=eq.${user.id}` },
        () => {
          qc.invalidateQueries({ queryKey: ['is-cashout-agent', user.id] });
          invalidateQueue();
        },
      )
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [user?.id]);

  // The CFO permission matrix for THIS agent, and the derived category filter
  // clause that limits the queue to only the payout categories mapped to them.
  const agentConfig: CashoutAgentConfig | null = useMemo(
    () => (isCashoutAgent ? normalizeCashoutAgentConfig((isCashoutAgent as any).config, isCashoutAgent as any) : null),
    [isCashoutAgent],
  );
  const categoryOrClause = useMemo(() => buildQueueCategoryOrClause(agentConfig), [agentConfig]);
  // Exact channel + provider/bank restriction from the same matrix.
  const channelProviderOrClause = useMemo(() => buildChannelProviderOrClause(agentConfig), [agentConfig]);
  const authorizedCategoryLabels = useMemo(() => authorizedQueueCategoryLabels(agentConfig), [agentConfig]);

  // Stale claims are released ONLY by the server: the `release-stale-cashout-claims`
  // pg_cron job (every 5 minutes) runs `release_stale_cashout_claims()`, which
  // refuses to release any row with settlement progress (proof / code /
  // transaction id / processing marker). The client never releases a claim —
  // a browser-side race previously stripped active claims out from under the
  // paying merchant, causing the same withdrawal to be paid twice.
  // Frozen accounts must never appear in the payout queue. Fetched once and
  // reused by the counts, page, and available-total queries so a freeze makes
  // the withdrawal disappear everywhere at once.

  const { data: frozenUserIds = [] } = useQuery({
    queryKey: ['cashout-frozen-user-ids'],
    queryFn: resolveFrozenUserIds,
    enabled: !!isCashoutAgent,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // Requests this agent has claimed and still needs to confirm. Kept as its own
  // (small) query so it is never affected by the queue's filters or pagination.
  //
  // Must match the SERVER's "you already have a payout in progress" check in
  // `claim_withdrawal_verified` exactly — it also counts legacy 'approved' rows
  // and treats an empty-string payment reference as none. With the narrower
  // queue fence here, the server could refuse a second claim over a row this
  // list never showed (merchants saw "you have another transaction" with
  // nothing in "Claimed by you").
  const { data: myActiveClaims = [] } = useQuery({
    queryKey: ['cashout-my-active-claims', isCashoutAgent?.id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .eq('assigned_cashout_agent_id', isCashoutAgent!.id)
        .in('status', MY_ACTIVE_CLAIM_STATUSES)
        .is('processed_at', null)
        .or('fin_ops_reference.is.null,fin_ops_reference.eq.')
        .order('dispatched_at', { ascending: true });
      if (error) throw error;
      return attachProfiles(data || []);
    },
    enabled: !!isCashoutAgent?.id,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  // Put one of THIS merchant's claims straight into "Claimed by you" (full row,
  // so the customer details the queue hides are shown). Used right after a
  // successful claim and when the server refuses a new claim because of an
  // existing one — the merchant must never be told "you have a payout in
  // progress" without that payout on screen. Never touches another desk's row.
  const pinMyClaim = async (withdrawalId: string) => {
    const deskId = isCashoutAgent?.id;
    if (!deskId || !withdrawalId) return;
    const { data, error } = await supabase
      .from('withdrawal_requests')
      .select('*')
      .eq('id', withdrawalId)
      .eq('assigned_cashout_agent_id', deskId)
      .maybeSingle();
    if (error || !data) return;
    const [row] = await attachProfiles([data]);
    qc.setQueryData(['cashout-my-active-claims', deskId], (old: any) => {
      const list = Array.isArray(old) ? old : [];
      return list.some((r: any) => r.id === row.id)
        ? list.map((r: any) => (r.id === row.id ? row : r))
        : [...list, row];
    });
  };

  // Unfiltered count of all available (unclaimed/expired) requests — powers the
  // "action required" badge and live banner regardless of active filters.
  // PRIORITY GATE (mirrors `assert_no_urgent_proxy_priority` in the database):
  // while ANY urgent proxy-agent withdrawal is still unclaimed, no other
  // merchant payout may be claimed. Queried unfiltered so the hold is visible
  // even when this merchant's filters or channel tab exclude the urgent row.
  // CTO Platform Control: "Show Proxy Agent withdrawals first". When OFF the
  // hold is released and normal withdrawals are claimable in the usual order.
  const { enforced: proxyPriorityEnforced } = useProxyPayoutPriority();
  // CTO Platform Control: "Show Landlord Payouts first". When OFF landlord float
  // payouts process in the usual order alongside other withdrawals.
  const { enforced: landlordPriorityEnforced } = useLandlordPayoutPriority();

  useEffect(() => {
    setPage(0);
    invalidateQueue();
  }, [proxyPriorityEnforced, landlordPriorityEnforced]);

  const { data: blockingUrgentProxyRow = null } = useQuery({
    queryKey: ['cashout-blocking-urgent-proxy'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('id, amount, created_at, priority_level, status, processed_at, fin_ops_reference, assigned_cashout_agent_id')
        .eq('priority_level', 'urgent_proxy')
        .in('status', CASHOUT_QUEUE_STATUSES)
        .is('processed_at', null)
        .is('fin_ops_reference', null)
        .is('assigned_cashout_agent_id', null)
        .order('created_at', { ascending: true })
        .limit(1);
      const row = (data || [])[0] ?? null;
      if (error) throw error;
      return row && isUrgentProxyBlocking(row) ? row : null;
    },
    enabled: !!isCashoutAgent && proxyPriorityEnforced,
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  const blockingUrgentProxy = proxyPriorityEnforced ? blockingUrgentProxyRow : null;

  // PRIORITY GATE for landlord float payouts:
  // while ANY unclaimed landlord float payout exists, no other payout may be
  // claimed. Queried unfiltered so the hold is visible even when filters hide it.
  const { data: blockingUrgentLandlordRow = null } = useQuery({
    queryKey: ['cashout-blocking-urgent-landlord'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('withdrawal_requests')
        .select('id, amount, created_at, reason, status, processed_at, fin_ops_reference, assigned_cashout_agent_id')
        .in('status', CASHOUT_QUEUE_STATUSES)
        .ilike('reason', 'Landlord float payout%')
        .is('processed_at', null)
        .is('fin_ops_reference', null)
        .is('assigned_cashout_agent_id', null)
        .order('created_at', { ascending: true })
        .limit(1);
      const row = (data || [])[0] ?? null;
      if (error) throw error;
      return row && isUrgentLandlordBlocking(row) ? row : null;
    },
    enabled: !!isCashoutAgent && landlordPriorityEnforced,
    staleTime: 10_000,
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });

  const blockingUrgentLandlord = landlordPriorityEnforced ? blockingUrgentLandlordRow : null;

  const { data: availableTotal = 0 } = useQuery({
    queryKey: ['cashout-queue-available-total', isCashoutAgent?.id, categoryOrClause, channelProviderOrClause, frozenUserIds],
    queryFn: async () => {
      let q = supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .in('status', CASHOUT_QUEUE_STATUSES)
        .is('processed_at', null)
        .is('fin_ops_reference', null)
        .is('assigned_cashout_agent_id', null);
      if (categoryOrClause) q = q.or(categoryOrClause);
      if (channelProviderOrClause) q = q.or(channelProviderOrClause);
      if (frozenUserIds.length) {
        const list = `(${frozenUserIds.join(',')})`;
        q = q.not('user_id', 'in', list);
        q = q.or(`linked_party.is.null,linked_party.not.in.${list}`);
      }
      const { count } = await q;
      return count || 0;
    },
    enabled: !!isCashoutAgent,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  // Per-channel filtered counts (All / MoMo / Cash) for the tab badges.
  const { data: queueCounts } = useQuery({
    queryKey: ['cashout-queue-counts', isCashoutAgent?.id, queueStatus, queueMerchant, minAmount, maxAmount, fromIso, toIso, debouncedSearch, categoryOrClause, channelProviderOrClause, frozenUserIds, proxyPriorityEnforced, blockingUrgentProxy?.id, landlordPriorityEnforced, blockingUrgentLandlord?.id],
    queryFn: async () => {
      const searchUserIds = debouncedSearch.trim() ? await resolveSearchUserIds(debouncedSearch) : null;
      const base = {
        status: queueStatus, merchant: queueMerchant,
        minAmount, maxAmount, fromIso, toIso, searchUserIds, searchTerm: debouncedSearch.trim(), categoryOrClause, channelProviderOrClause, frozenUserIds,
      };
      const landlordOnly = landlordPriorityEnforced && !!blockingUrgentLandlord;
      const proxyOnly = proxyPriorityEnforced && !!blockingUrgentProxy && !landlordOnly;
      const mk = (channel: 'all' | 'momo' | 'cash' | 'bank') => {
        let q = applyQueueFilters(
          supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }),
          { ...base, channel },
        );
        if (landlordOnly) q = q.ilike('reason', 'Landlord float payout%');
        else if (proxyOnly) q = q.eq('priority_level', 'urgent_proxy');
        return q.then((r: any) => r.count || 0);
      };
      const [all, momo, cash, bank] = await Promise.all([mk('all'), mk('momo'), mk('cash'), mk('bank')]);
      return { all, momo, cash, bank };
    },
    enabled: !!isCashoutAgent,
    staleTime: 15_000,
  });

  // The current, server-paginated page of the Pending Queue for the active tab.
  const { data: queuePage, isLoading: loadingAll, isFetching: fetchingQueue, isError: queueError, refetch: refetchQueue } = useQuery({
    queryKey: ['cashout-queue-page', isCashoutAgent?.id, channelTab, queueStatus, queueMerchant, minAmount, maxAmount, fromIso, toIso, debouncedSearch, queueSort, page, categoryOrClause, channelProviderOrClause, frozenUserIds, proxyPriorityEnforced, blockingUrgentProxy?.id, landlordPriorityEnforced, blockingUrgentLandlord?.id],
    queryFn: async () => {
      // There is no time-based release any more: a claim only becomes available
      // again when a human (FinOps/CFO) explicitly clears assigned_cashout_agent_id.
      const searchUserIds = debouncedSearch.trim() ? await resolveSearchUserIds(debouncedSearch) : null;
      const opts: QueueFilterOpts = {
        status: queueStatus, merchant: queueMerchant,
        minAmount, maxAmount, fromIso, toIso, channel: channelTab,
        searchUserIds, searchTerm: debouncedSearch.trim(), categoryOrClause, channelProviderOrClause, frozenUserIds,
      };
      let q = applyQueueFilters(
        supabase.from('withdrawal_requests').select('*', { count: 'exact' }),
        opts,
      );
      if (landlordPriorityEnforced && blockingUrgentLandlord) {
        q = q.ilike('reason', 'Landlord float payout%').order('created_at', { ascending: true });
      } else if (proxyPriorityEnforced && blockingUrgentProxy) {
        q = q.eq('priority_level', 'urgent_proxy').order('created_at', { ascending: true });
      } else {
        q = applyQueueSort(q, queueSort);
      }
      const { data, error, count } = await q.range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (error) throw error;
      const rows = await attachProfiles(data || []);
      return { rows, count: count || 0 };
    },
    enabled: !!isCashoutAgent,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });

  // Daily stats: ONLY count actual cash payouts handled by THIS cash-out agent today.
  // Sources counted:
  //   1. payout_codes marked 'paid' by this agent (cash pickup via WPO code)
  //   2. withdrawal_requests assigned to this cashout agent and completed today
  // We DO NOT include withdrawals where this user is merely 'processed_by' through
  // other approval flows — that would falsely inflate the cash-paid figure.
  const { data: dailyStats } = useQuery({
    queryKey: ['cashout-agent-daily-stats', user?.id, isCashoutAgent?.id],
    queryFn: async () => {
      if (!user || !isCashoutAgent?.id) return { codesCount: 0, totalAmount: 0, avgMinutes: 0 };
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const startIso = startOfDay.toISOString();

      // Single canonical source of truth: every withdrawal THIS merchant actually
      // confirmed paid today, across ALL channels — Cash, Mobile Money AND Bank.
      // `processed_by` is stamped only by approve-withdrawal on the paying merchant,
      // so each settled payout is counted exactly once. This both (a) includes
      // MoMo/Bank payouts that the old cash-only filter dropped and (b) removes the
      // double-count that came from unioning payout_codes with withdrawal_requests
      // (a cash-code payout writes to both).
      const { data: wreqs } = await supabase
        .from('withdrawal_requests')
        .select('amount, created_at, processed_at')
        // Scope strictly to cash-outs THIS merchant agent claimed & settled from
        // the queue, so the metric never counts payouts handled via other flows.
        // Belt-and-braces: match on EITHER the current claim assignment OR the
        // `processed_by` stamp. The 15-min stale-claim cron may have nulled
        // `assigned_cashout_agent_id` before the merchant pasted the TID, so
        // relying on the claim alone silently hides legitimately-settled payouts.
        .or(`assigned_cashout_agent_id.eq.${isCashoutAgent.id},processed_by.eq.${user.id}`)
        .eq('status', 'completed')
        .not('processed_at', 'is', null)
        .gte('processed_at', startIso);

      const rows = (wreqs || []).map((r: any) => ({
        amount: Number(r.amount || 0),
        created_at: r.created_at,
        finished_at: r.processed_at,
      }));

      const codesCount = rows.length;
      const totalAmount = rows.reduce((sum, r) => sum + r.amount, 0);
      const durations = rows
        .filter(r => r.created_at && r.finished_at)
        .map(r => (new Date(r.finished_at).getTime() - new Date(r.created_at).getTime()) / 60000);
      const avgMinutes = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;

      return { codesCount, totalAmount, avgMinutes };
    },
    enabled: !!user && !!isCashoutAgent?.id,
    staleTime: 20_000,
    refetchOnWindowFocus: true,
  });

  // Commission breakdown — totals by date for ALL payouts this agent has
  // processed (every confirmed payout credits a 0.5% commission into the
  // agent's withdrawable wallet via general_ledger). We read the wallet-scope
  // cash_in legs tagged as the cashout commission and group them by day.
  const { data: commissionBreakdown } = useQuery({
    queryKey: ['cashout-agent-commission-breakdown', user?.id, fromKey, toKey],
    queryFn: async () => {
      if (!user) return { rows: [] as { date: string; count: number; total: number }[], typeRows: [] as { type: string; count: number; total: number }[], grandTotal: 0, grandCount: 0 };
      let q = supabase
        .from('general_ledger')
        .select('amount, transaction_date, created_at, reference_id')
        .eq('user_id', user.id)
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_in')
        .eq('category', 'agent_commission_earned')
        .like('reference_id', '%-cashout-commission');
      // transaction_date is a timestamptz — filter on full-day ISO boundaries so
      // same-day payouts are included (a bare yyyy-MM-dd upper bound truncates to
      // midnight and would exclude everything that happened during the day).
      if (rangeFrom) {
        const fromIso = new Date(
          rangeFrom.getFullYear(), rangeFrom.getMonth(), rangeFrom.getDate(),
        ).toISOString();
        q = q.gte('transaction_date', fromIso);
      }
      if (rangeTo) {
        const toIso = new Date(
          rangeTo.getFullYear(), rangeTo.getMonth(), rangeTo.getDate(), 23, 59, 59, 999,
        ).toISOString();
        q = q.lte('transaction_date', toIso);
      }
      const { data, error } = await q.order('transaction_date', { ascending: false });
      if (error) throw error;

      // Resolve the payout method/type for each commission by stripping the
      // withdrawal id from the reference_id and batch-fetching the withdrawals.
      const withdrawalIds = Array.from(
        new Set(
          (data || [])
            .map((r: any) => String(r.reference_id || '').replace('-cashout-commission', ''))
            .filter(Boolean),
        ),
      );
      const methodById = new Map<string, string>();
      if (withdrawalIds.length > 0) {
        const { data: wrs } = await supabase
          .from('withdrawal_requests')
          .select('id, payout_method')
          .in('id', withdrawalIds);
        for (const w of (wrs || []) as any[]) {
          methodById.set(String(w.id), String(w.payout_method || ''));
        }
      }
      const prettyType = (m: string) => {
        const key = (m || '').toLowerCase();
        if (!key) return 'Other payout';
        if (key.includes('momo') || key.includes('mobile')) return 'Mobile Money';
        if (key.includes('bank')) return 'Bank Transfer';
        if (key.includes('cash')) return 'Cash Pickup';
        if (key.includes('wallet')) return 'Wallet';
        return m.charAt(0).toUpperCase() + m.slice(1);
      };

      const byDate = new Map<string, { count: number; total: number }>();
      const byType = new Map<string, { count: number; total: number }>();
      let grandTotal = 0;
      let grandCount = 0;
      for (const r of (data || []) as any[]) {
        const ts = r.transaction_date || r.created_at;
        if (!ts) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        const amt = Number(r.amount || 0);
        const prev = byDate.get(day) || { count: 0, total: 0 };
        byDate.set(day, { count: prev.count + 1, total: prev.total + amt });
        const wid = String(r.reference_id || '').replace('-cashout-commission', '');
        const type = prettyType(methodById.get(wid) || '');
        const prevT = byType.get(type) || { count: 0, total: 0 };
        byType.set(type, { count: prevT.count + 1, total: prevT.total + amt });
        grandTotal += amt;
        grandCount += 1;
      }
      const rows = Array.from(byDate.entries())
        .map(([date, v]) => ({ date, count: v.count, total: v.total }))
        .sort((a, b) => (a.date < b.date ? 1 : -1));
      const typeRows = Array.from(byType.entries())
        .map(([type, v]) => ({ type, count: v.count, total: v.total }))
        .sort((a, b) => b.total - a.total);
      return { rows, typeRows, grandTotal, grandCount };
    },
    enabled: !!user && !!isCashoutAgent?.id,
    staleTime: 20_000,
    refetchOnWindowFocus: true,
  });

  // Today's Activity strip: total money paid out today, and the 0.5% agent
  // commission slice on that same volume.
  const todayWithdrawn = dailyStats?.totalAmount ?? 0;
  const todayCommission = Math.round(todayWithdrawn * 0.005);

  // Payout activity — a per-payout transaction history for this merchant. Lists
  // every withdrawal they settled (all channels), the commission they earned on
  // each, and any principal reimbursement. Sourced from withdrawal_requests
  // (processed_by = self) joined to the merchant's own wallet ledger legs so the
  // figures reconcile 1:1 with the commission breakdown and the wallet statement.
  const HISTORY_PAGE = 8;
  const [historyVisible, setHistoryVisible] = useState(HISTORY_PAGE);
  const { data: payoutHistory } = useQuery({
    queryKey: ['cashout-agent-payout-history', user?.id, isCashoutAgent?.id, fromKey, toKey],
    queryFn: async () => {
      if (!user || !isCashoutAgent?.id) return [] as any[];
      // Boundaries from the active date preset (Today / Last 7 / etc.). When no
      // range is set we show all of this merchant's settled cash-outs.
      const histFromIso = rangeFrom
        ? new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), rangeFrom.getDate()).toISOString()
        : null;
      const histToIso = rangeTo
        ? new Date(rangeTo.getFullYear(), rangeTo.getMonth(), rangeTo.getDate(), 23, 59, 59, 999).toISOString()
        : null;
      let wq = supabase
        .from('withdrawal_requests')
        .select('id, amount, payout_method, processed_at, reason, mobile_money_number, mobile_money_provider, mobile_money_name, user_id')
        // Only payouts THIS merchant agent actually claimed & settled from the
        // queue — never payouts settled by others through different flows.
        // Match on EITHER the claim assignment OR the `processed_by` stamp so
        // rows whose 15-min claim expired before the merchant pasted the TID
        // still surface in their history.
        .or(`assigned_cashout_agent_id.eq.${isCashoutAgent.id},processed_by.eq.${user.id}`)
        .eq('status', 'completed')
        .not('processed_at', 'is', null);
      if (histFromIso) wq = wq.gte('processed_at', histFromIso);
      if (histToIso) wq = wq.lte('processed_at', histToIso);
      const { data: wrs, error } = await wq
        .order('processed_at', { ascending: false })
        .limit(60);
      if (error) throw error;
      const rows = wrs || [];
      // Pull the commission + reimbursement wallet legs for these payouts so each
      // row shows exactly what landed in the merchant's withdrawable wallet.
      const commById = new Map<string, number>();
      const reimbById = new Map<string, number>();
      const ids = rows.map((r: any) => String(r.id));
      if (ids.length > 0) {
        const { data: legs } = await supabase
          .from('general_ledger')
          .select('amount, reference_id, category')
          .eq('user_id', user.id)
          .eq('ledger_scope', 'wallet')
          .eq('direction', 'cash_in')
          .in('reference_id', [
            ...ids.map((id) => `${id}-cashout-commission`),
            ...ids.map((id) => `${id}-merchant-reimbursement`),
          ]);
        for (const l of (legs || []) as any[]) {
          const ref = String(l.reference_id || '');
          if (ref.endsWith('-cashout-commission')) {
            commById.set(ref.replace('-cashout-commission', ''), Number(l.amount || 0));
          } else if (ref.endsWith('-merchant-reimbursement')) {
            reimbById.set(ref.replace('-merchant-reimbursement', ''), Number(l.amount || 0));
          }
        }
      }
      const withProfiles = await attachProfiles(rows);
      return withProfiles.map((r: any) => ({
        ...r,
        commission: commById.get(String(r.id)) || 0,
        reimbursed: reimbById.get(String(r.id)) || 0,
      }));
    },
    enabled: !!user && !!isCashoutAgent?.id,
    staleTime: 20_000,
    refetchOnWindowFocus: true,
  });

  const sortedDayRows = useMemo(() => {
    const rows = [...(commissionBreakdown?.rows ?? [])];
    rows.sort((a, b) => {
      const cmp = daySort.key === 'date' ? (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) : a.total - b.total;
      return daySort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [commissionBreakdown?.rows, daySort]);

  const sortedTypeRows = useMemo(() => {
    const rows = [...(commissionBreakdown?.typeRows ?? [])];
    rows.sort((a, b) => {
      const cmp = typeSort.key === 'type' ? a.type.localeCompare(b.type) : a.total - b.total;
      return typeSort.dir === 'asc' ? cmp : -cmp;
    });
    return rows;
  }, [commissionBreakdown?.typeRows, typeSort]);

  // Realtime subscription
  useEffect(() => {
    if (!isCashoutAgent) return;
    const channel = supabase
      .channel('cashout-agent-withdrawals')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'withdrawal_requests' }, (payload) => {
        const newRow = payload.new as any;
        const isSettled = isMerchantQueueSettled(newRow);

        // Never keep a paid row visible while the fresh database query is in
        // flight (or if that refetch fails). The database status remains the
        // source of truth; this only evicts the now-terminal row from an older
        // React Query page snapshot as soon as its backend UPDATE arrives.
        if (isSettled && newRow?.id) {
          qc.setQueriesData({ queryKey: ['cashout-queue-page'] }, (old: any) => {
            if (!old?.rows) return old;
            const rows = old.rows.filter((row: any) => row.id !== newRow.id);
            return rows.length === old.rows.length
              ? old
              : { ...old, rows, count: Math.max(0, Number(old.count || 0) - 1) };
          });
        }
        // "Claimed by you" follows the server's claim definition, not the queue
        // fence (a legacy 'approved' claim is still open), so evict only a claim
        // that is genuinely closed.
        const claimClosed =
          !!newRow?.id &&
          (newRow.processed_at != null ||
            String(newRow.fin_ops_reference ?? '') !== '' ||
            !MY_ACTIVE_CLAIM_STATUSES.includes(String(newRow.status ?? '')));
        if (claimClosed) {
          qc.setQueriesData({ queryKey: ['cashout-my-active-claims'] }, (old: any) =>
            Array.isArray(old) ? old.filter((row: any) => row.id !== newRow.id) : old,
          );
        }
        invalidateQueue();
        // When a payout this merchant settled completes, refresh their earnings
        // views immediately so Today's Payouts, Commission and Payout Activity
        // never lag behind the actual ledger.
        if (newRow?.processed_by === user?.id && newRow?.status === 'completed') {
          qc.invalidateQueries({ queryKey: ['cashout-agent-daily-stats'] });
          qc.invalidateQueries({ queryKey: ['cashout-agent-commission-breakdown'] });
          qc.invalidateQueries({ queryKey: ['cashout-agent-lifetime-commission'] });
          qc.invalidateQueries({ queryKey: ['cashout-agent-payout-history'] });
        }
        if (payload.eventType === 'INSERT') {
          toast.info(`🔔 New withdrawal: ${formatUGX(Number(newRow.amount || 0))} via ${newRow.payout_method || 'wallet'}`, { duration: 6000 });
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [isCashoutAgent, qc, user?.id]);

  // Queue REFRESH ticker only — this interval re-fetches queue state every 30s
  // and never mutates anything. Releasing a stale claim is server-authoritative:
  // the `release-stale-cashout-claims` pg_cron job (every 5 minutes) calls
  // `release_stale_cashout_claims()`, which only returns a claim to the pool
  // after 45 minutes with ZERO settlement progress. The client must never
  // release another merchant's claim.

  useEffect(() => {
    if (!isCashoutAgent) return;
    const tick = setInterval(() => {
      invalidateQueue();
    }, 30_000);
    return () => clearInterval(tick);
  }, [isCashoutAgent, qc]);

  // When a claim succeeds and the "Claimed by you" list has refreshed to include
  // it, smoothly scroll up so the merchant immediately sees the claimed cash-out.
  useEffect(() => {
    if (scrollToClaimed.current && myActiveClaims.length > 0) {
      scrollToClaimed.current = false;
      claimedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [myActiveClaims]);

  // Claim a withdrawal request — ATOMIC: only succeeds if no one else has claimed it.
  // The `.is('assigned_cashout_agent_id', null)` guard makes the UPDATE a single-row
  // race-safe operation. If two agents click "Claim" at the same instant, only the
  // first transaction commits; the second matches 0 rows and we surface a clear error.
  const claimWithdrawal = useMutation({
    mutationFn: async (vars: { id: string; momoNumber?: string | null; momoName?: string | null }) => {
      // Server-side enforcement: the verified RPC checks that the MoMo number
      // and registered screen name being claimed exactly match the withdrawal's
      // stored payout details, then performs the race-guarded claim atomically.
      const { data, error } = await supabase.rpc('claim_withdrawal_verified', {
        p_withdrawal_id: vars.id,
        p_momo_number: vars.momoNumber ?? null,
        p_momo_name: vars.momoName ?? null,
      });
      if (error) throw error;
      const result = data as any;
      if (!result || result.error) {
        const err: any = new Error(result?.message || 'Unable to claim this withdrawal');
        err.code = result?.error ?? null;
        err.blockingWithdrawalId = result?.blocking_withdrawal_id ?? null;
        throw err;
      }
    },
    onSuccess: async (_data, vars) => {
      toast.success('✅ Withdrawal claimed — proceed with payout');
      // Scroll up to "Claimed by you" as soon as it holds the claim.
      scrollToClaimed.current = true;
      // Pin the claimed row immediately rather than waiting on a list refetch
      // that can race the queue refresh — otherwise the row vanishes from the
      // queue with nothing in its place and the other Claim buttons stay live.
      await pinMyClaim(vars.id);
      invalidateQueue();
    },
    onError: (e: any) => {
      if (e?.code === 'active_claim_exists' && e?.blockingWithdrawalId) {
        // The server knows which payout this merchant still holds — show it.
        toast.error('You already claimed a payout — it is pinned at the top. Finish it before claiming another.');
        scrollToClaimed.current = true;
        void pinMyClaim(e.blockingWithdrawalId);
      } else {
        toast.error(e.message);
      }
      // Refresh so the lost-race row disappears from this agent's view immediately.
      invalidateQueue();
    },
    onSettled: (_d, error, vars) => {
      const withdrawalId = vars?.id;
      // Send the "merchant agent X is processing your withdrawal" SMS only when
      // the claim actually committed for THIS agent. On a failed/lost-race claim
      // the withdrawal is not ours, and notifying would 409. Fire-and-forget so
      // telco hiccups never affect the UI.
      if (withdrawalId) {
        if (!error) {
          supabase.functions
            .invoke('notify-withdrawal-claimed', { body: { withdrawal_id: withdrawalId } })
            .catch((e) => console.warn('[claim] notify SMS failed', e));
        }
        claimLockRef.current.delete(withdrawalId);
        setClaimingIds(new Set(claimLockRef.current));
      }
    },

  });

  // Complete withdrawal via edge function (ledger-backed)
  const completeWithdrawal = useMutation({
    mutationFn: async ({ id, reference, method, sms, proofUrl, proofType, proofPath, proofBucket, proofUploadedBy }: {
      id: string; reference: string; method: string; sms?: string;
      proofUrl?: string; proofType?: string;
      proofPath?: string; proofBucket?: string; proofUploadedBy?: string;
    }) => {
      const { data, error } = await supabase.functions.invoke('approve-withdrawal', {
        // `acting_as_merchant` tells the server this payout is being settled by a
        // merchant agent paying with their OWN MoMo/cash — so they earn the
        // principal reimbursement + 0.5% commission + confirmation SMS. The
        // Financial Ops desk never sends this flag.
        // `paste_sms` carries the raw confirmation SMS so the server can
        // re-verify the TID + amount against the withdrawal request.
        body: {
          withdrawal_id: id,
          reference: reference.trim(),
          payment_method: method,
          acting_as_merchant: true,
          paste_sms: sms ?? null,
          payout_proof: proofUrl ?? null,
          payout_proof_type: proofType ?? null,
          // Authoritative, non-expiring storage reference for the FinOps
          // Receipt Archive. Signed URLs above stay for backward compat only.
          payout_proof_path: proofPath ?? null,
          payout_proof_bucket: proofBucket ?? (proofPath ? 'payment-proofs' : null),
          payout_proof_uploaded_by: proofUploadedBy ?? null,
        },
      });
      if (error || data?.error) {
        const msg = await extractEdgeFunctionError({ data, error }, 'Failed to process withdrawal');
        throw new Error(msg);
      }
      return data;
    },
    onSuccess: (data) => {
      const commission = Number(data?.cashout_commission || 0);
      const floatUsed = Number(data?.merchant_float_consumed ?? data?.merchant_reimbursed ?? 0);
      const baseMsg = `✅ Payout completed — ${formatUGX(data?.amount || 0)} sent`;
      const parts: string[] = [];
      if (floatUsed > 0) parts.push(`${formatUGX(floatUsed)} drawn from your float`);
      const fronted = Number(data?.merchant_own_money_fronted ?? 0);
      if (fronted > 0) parts.push(`${formatUGX(fronted)} of your own money recorded — Finance owes you this, nothing for you to do`);
      if (commission > 0) parts.push(`${formatUGX(commission)} commission added to your withdrawable`);
      toast.success(parts.length > 0 ? `${baseMsg} · ${parts.join(' · ')}` : baseMsg);
      invalidateQueue();
      qc.invalidateQueries({ queryKey: ['cashout-agent-commission-breakdown'] });
      qc.invalidateQueries({ queryKey: ['cashout-agent-daily-stats'] });
      qc.invalidateQueries({ queryKey: ['cashout-agent-lifetime-commission'] });
      qc.invalidateQueries({ queryKey: ['cashout-agent-payout-history'] });
      qc.invalidateQueries({ queryKey: ['merchant-payout-float'] });
      qc.invalidateQueries({ queryKey: ['merchant-float-positions'] });
      invalidateWalletBalance(qc, user?.id);
    },
    onError: (e: any) => {
      toast.error(e.message);
      // A failed confirmation now returns the request to the shared queue
      // (the edge function clears the assignment). Refresh so the released
      // claim leaves "Claimed by you" and the queue unlocks — the agent can
      // immediately claim another payout instead of being stuck on a pending row.
      invalidateQueue();
    },
    onSettled: (_d, _e, vars) => {
      if (vars?.id) {
        completeLockRef.current.delete(vars.id);
        setCompletingIds(new Set(completeLockRef.current));
      }
    },
  });

  // Verify the 4-digit pickup code AND enforce the chosen-merchant gate.
  const handleVerify = async () => {
    const code = payoutCode.trim().toUpperCase();
    if (!code) return;
    setVerifying(true);
    try {
      // Verify through a server-side, rate-limited RPC so the 4-digit code
      // can't be brute-forced: it locks the merchant out after too many wrong
      // codes in a short window and records every attempt server-side.
      const { data, error } = await supabase.rpc('verify_payout_code_throttled', { p_code: code });
      if (error) throw error;
      const result = data as any;
      if (!result || result.error) {
        if (result?.error === 'rate_limited') {
          toast.error(result.message || 'Too many incorrect codes. Please wait a few minutes and try again.');
        } else if (result?.error === 'expired') {
          toast.error(result.message || 'This payout code has expired');
        } else {
          toast.error(result?.message || 'Invalid or already-used payout code');
        }
        setVerifiedPayout(null);
        return;
      }
      setVerifiedPayout(result);
      toast.success(result._isPreferred ? 'Code verified — you are the chosen merchant ✅' : 'Payout code verified! ✅');
    } catch (err: any) { toast.error(err.message); }
    finally { setVerifying(false); }
  };

  // Complete the cash payout via the ledger-backed edge function. This is the
  // ONLY path that actually debits the customer's WITHDRAWABLE balance and
  // posts the wallet movement to the general ledger — making it visible on the
  // Financial Ops page. (The old path only flipped the code to 'paid' and never
  // moved any money, so balances were never reduced and nothing was recorded.)
  const completePayout = useMutation({
    mutationFn: async () => {
      const vp = verifiedPayout;
      if (!vp) throw new Error('Verify a code first.');
      const withdrawalId = vp.withdrawal_request_id;
      if (!withdrawalId) throw new Error('This code is not linked to a withdrawal request.');
      const reference = `CASH-${String(withdrawalId).slice(0, 8).toUpperCase()}-${vp.code}`;
      const { data, error } = await supabase.functions.invoke('approve-withdrawal', {
        body: {
          withdrawal_id: withdrawalId,
          reference,
          payment_method: 'cash',
          payout_code: vp.code,
          // Merchant settles this WPO pickup from COMPANY FLOAT: the principal
          // is drawn down from their float bucket and only the 0.5% commission
          // lands in their withdrawable wallet (+ SMS).
          acting_as_merchant: true,
        },
      });
      if (error || data?.error) {
        const msg = await extractEdgeFunctionError({ data, error }, 'Failed to complete cash payout');
        throw new Error(msg);
      }
      return data;
    },
    onSuccess: (data) => {
      const commission = Number(data?.cashout_commission || 0);
      const floatUsed = Number(data?.merchant_float_consumed ?? data?.merchant_reimbursed ?? 0);
      const amt = Number(data?.amount || verifiedPayout?.amount || 0);
      const base = `💰 Cash paid — ${formatUGX(amt)} debited from the customer's withdrawable balance`;
      const parts: string[] = [];
      if (floatUsed > 0) parts.push(`${formatUGX(floatUsed)} drawn from your float`);
      const fronted = Number(data?.merchant_own_money_fronted ?? 0);
      if (fronted > 0) parts.push(`${formatUGX(fronted)} of your own money recorded — Finance owes you this, nothing for you to do`);
      if (commission > 0) parts.push(`${formatUGX(commission)} commission added to your withdrawable`);
      toast.success(parts.length > 0 ? `${base} · ${parts.join(' · ')}` : base);
      setVerifiedPayout(null); setPayoutCode('');
      invalidateQueue();
      qc.invalidateQueries({ queryKey: ['cashout-agent-commission-breakdown'] });
      qc.invalidateQueries({ queryKey: ['cashout-agent-daily-stats'] });
      qc.invalidateQueries({ queryKey: ['cashout-agent-lifetime-commission'] });
      qc.invalidateQueries({ queryKey: ['cashout-agent-payout-history'] });
      invalidateWalletBalance(qc, user?.id);
    },
    onError: (e: any) => toast.error(e.message),
  });

  if (cashoutAgentLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }
  if (!isCashoutAgent) return null;

  // Server-driven queue values. The active tab's page comes from `queuePage`,
  // counts come from `queueCounts`, and the unfiltered total from `availableTotal`.
  // Landlord float payouts are Priority #1 while the CTO control
  // "Show Landlord Payouts first" is ON. Urgent proxy-agent payouts are Priority
  // #2. When both controls are OFF, the queue keeps its normal server order.
  const actionableRows: any[] = (queuePage?.rows ?? []).filter((row: any) => isMerchantQueueActionable(row));
  // While landlord priority is ON, ordinary withdrawals must NOT surface as
  // long as any landlord payout is present — merchant agents only see landlord
  // payouts. Once none remain, proxy priority (if ON) takes over; otherwise the
  // normal queue reappears.
  const landlordOnlyRows: any[] = actionableRows.filter((row: any) => isUrgentLandlordPayout(row));
  const proxyOnlyRows: any[] = actionableRows.filter((row: any) => isUrgentProxyWithdrawal(row));
  const pageRows: any[] = (landlordPriorityEnforced && landlordOnlyRows.length > 0)
    ? sortLandlordPriorityFirst(landlordOnlyRows)
    : (proxyPriorityEnforced && proxyOnlyRows.length > 0)
      ? sortProxyPriorityFirst(proxyOnlyRows)
      : actionableRows;
  const pageCount = queuePage?.count ?? 0;
  const channelCounts = queueCounts ?? { all: 0, momo: 0, cash: 0, bank: 0 };
  const totalPending = availableTotal;
  const filteredPending = channelCounts.all;

  // A merchant agent may only hold ONE claim at a time. While a claim is open the
  // whole queue is locked so they must finish it before taking another — there is
  // no time-based release (telecom confirmation delays made a fixed window
  // unreliable; a still-paying merchant's request must never be offered to a
  // second merchant). The only way out is confirming with proof, or a human
  // (FinOps/CFO) manually releasing the claim.
  const hasActiveClaim = myActiveClaims.length > 0;
  const totalPages = Math.max(1, Math.ceil(pageCount / PAGE_SIZE));
  const rangeStart = pageCount === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(pageCount, page * PAGE_SIZE + pageRows.length);

  return (
    <MerchantAgreementGate>
    <div className="space-y-5">
      {/* Hard block: proofless wallet deductions overshadow the whole page until
          the merchant attaches proof for every affected customer. */}
      <ProoflessPayoutBlocker />
      {/* Customer "money not delivered" alarms — must be the first thing a
          merchant agent sees when they open the payout dashboard. */}
      <MerchantPayoutDisputeAlarm />
      {withdrawalsPaused && (
        <div className="rounded-2xl border-2 border-amber-500/60 bg-amber-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="text-sm font-bold text-amber-800 dark:text-amber-300">
              Withdrawal processing is paused
            </p>
            <p className="text-xs text-amber-800/80 dark:text-amber-300/80">
              The CFO has temporarily paused withdrawals platform-wide. You cannot claim or process
              new payouts until this is lifted. Any request you've already claimed can still be
              completed with proof of payment.
            </p>
          </div>
        </div>
      )}
      {/* Online/Offline availability — only Online agents receive real-time
          withdrawal dispatches. */}
      <MerchantOnlineToggle />

      {/* My Active Claims — pinned to the very top so a request YOU claimed is
          always clearly separated from the rest of the queue and can't be missed. */}
      {myActiveClaims.length > 0 && (
        <Card ref={claimedSectionRef} className="border-2 border-amber-500/60 bg-amber-500/10 rounded-2xl shadow-lg ring-2 ring-amber-500/20 scroll-mt-4">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-bold uppercase tracking-wide flex flex-wrap items-center gap-x-2 gap-y-1.5 text-amber-700 dark:text-amber-400">
              <span className="inline-flex items-center gap-2">
                <UserCheck className="h-4 w-4 shrink-0" />
                Claimed by you · {myActiveClaims.length}
              </span>
              <Badge className="ml-auto h-5 px-2 gap-1 text-[11px] text-white normal-case tracking-normal whitespace-nowrap shrink-0 bg-amber-500 hover:bg-amber-500">
                <Clock className="h-3 w-3 shrink-0" />{' '}
                Awaiting your confirmation
              </Badge>
            </CardTitle>
            <p className="text-xs text-amber-700/80 dark:text-amber-400/80 mt-1">
              Finish this first — the queue stays locked until you confirm, with no time limit. Telecom
              providers can take a while to send the confirmation message — if you've already sent the
              money, wait for it and confirm with proof whenever it arrives; this claim is never taken
              from you automatically or reassigned to anyone else.
            </p>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {myActiveClaims.map((w: any) => (
              <WithdrawalPayoutCard
                key={w.id}
                withdrawal={w}
                isClaimed
                isClaimedByOther={false}
                onClaim={(confirm) => handleClaim(w.id, confirm)}
                onComplete={handleComplete}
                claimingId={claimingIds.has(w.id) ? w.id : null}
                completingId={completingIds.has(w.id) ? w.id : null}
              />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Shared payout float — no float requests any more. Claim, pay, get reimbursed. */}
      <MerchantFloatAvailableCard />

      {/* Authorized payout categories — the CFO permission matrix decides which
          categories of transactions this merchant agent may claim & process.
          Only these appear in the queue below. */}
      {authorizedCategoryLabels.length > 0 && (
        <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3.5">
          <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            <UserCheck className="h-3.5 w-3.5" /> Authorized payout categories
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {authorizedCategoryLabels.map((label) => (
              <Badge key={label} variant="secondary" className="text-[11px] font-medium">
                {label}
              </Badge>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
            You can only claim withdrawals in these categories. Others are hidden from your queue.
          </p>
        </div>
      )}

      {/* Today's payouts */}
      <section className="space-y-3">
        <h2 className="px-0.5 text-[11px] font-bold uppercase tracking-[0.15em] text-muted-foreground">Today's Activity</h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase text-emerald-700 dark:text-emerald-400"><Coins className="h-3.5 w-3.5" /> Today's Commission Earned</div>
            <p className="mt-1.5 text-lg font-bold leading-tight tabular-nums text-emerald-700 dark:text-emerald-400">{formatUGX(todayCommission ?? 0)}</p>
          </div>
          <div className="rounded-2xl border border-primary/20 bg-primary/5 p-3.5">
            <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase text-primary"><TrendingUp className="h-3.5 w-3.5" /> Today's Withdrawals</div>
            <p className="mt-1.5 text-lg font-bold leading-tight tabular-nums text-primary">{formatUGX(todayWithdrawn ?? 0)}</p>
          </div>
        </div>
      </section>

      {/* Commission history — informational only. All withdrawable commission
          lives on the Agent Wallet Card (single source of truth for cash-out). */}
      <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Coins className="h-4 w-4 text-emerald-600" />
            Commission History · 0.5% per payout
          </CardTitle>
          {/* Quick presets */}
          <div className="flex flex-wrap items-center gap-1.5 mt-3">
            <Button variant="secondary" size="sm" className="h-7 text-xs px-2.5"
              onClick={() => { const t = new Date(); setRangeFrom(t); setRangeTo(t); }}>
              Today
            </Button>
            <Button variant="secondary" size="sm" className="h-7 text-xs px-2.5"
              onClick={() => { setRangeFrom(subDays(new Date(), 6)); setRangeTo(new Date()); }}>
              Last 7 days
            </Button>
            <Button variant="secondary" size="sm" className="h-7 text-xs px-2.5"
              onClick={() => { setRangeFrom(subDays(new Date(), 29)); setRangeTo(new Date()); }}>
              Last 30 days
            </Button>
            <Button variant="secondary" size="sm" className="h-7 text-xs px-2.5"
              onClick={() => { setRangeFrom(startOfMonth(new Date())); setRangeTo(new Date()); }}>
              This month
            </Button>
            {(rangeFrom || rangeTo) && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs text-muted-foreground"
                onClick={() => { setRangeFrom(undefined); setRangeTo(undefined); }}
              >
                <X className="h-3.5 w-3.5 mr-1" /> Clear
              </Button>
            )}
          </div>
          {(rangeFrom || rangeTo) && (
            <p className="text-[11px] text-muted-foreground mt-2">
              Showing {rangeFrom ? format(rangeFrom, 'MMM d, yyyy') : 'the start'} – {rangeTo ? format(rangeTo, 'MMM d, yyyy') : 'today'}
            </p>
          )}
        </CardHeader>
        <CardContent className="pt-0 space-y-3">
          <div className="flex items-end justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <div>
              <p className="text-xs font-medium text-emerald-700">Total earned · 0.5%</p>
              <p className="mt-1 text-2xl font-bold leading-tight tabular-nums text-emerald-700">
                {formatUGX(commissionBreakdown?.grandTotal ?? 0)}
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-emerald-700">Payouts</p>
              <p className="text-lg font-bold tabular-nums text-foreground">{commissionBreakdown?.grandCount ?? 0}</p>
            </div>
          </div>

          {(commissionBreakdown?.rows?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {(rangeFrom || rangeTo)
                ? 'No commission earned in the selected period.'
                : 'No commission earned yet. Confirm a payout to start earning.'}
            </p>
          ) : (
            <>
              {/* By payout category / type */}
              {(commissionBreakdown?.typeRows?.length ?? 0) > 0 && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      By payout type
                    </p>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => toggleTypeSort('type')}
                        className={cn(
                          'flex items-center gap-0.5 text-[11px] font-semibold rounded-md px-1.5 py-0.5 transition-colors',
                          typeSort.key === 'type' ? 'bg-emerald-500/10 text-emerald-600' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        Type
                        {typeSort.key === 'type' && (typeSort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleTypeSort('total')}
                        className={cn(
                          'flex items-center gap-0.5 text-[11px] font-semibold rounded-md px-1.5 py-0.5 transition-colors',
                          typeSort.key === 'total' ? 'bg-emerald-500/10 text-emerald-600' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        Total
                        {typeSort.key === 'total' && (typeSort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    {sortedTypeRows.slice(0, typeVisible).map((t) => (
                      <div
                        key={t.type}
                        className="flex items-center justify-between gap-3 rounded-xl bg-emerald-500/5 border border-emerald-500/15 px-3 py-2.5"
                      >
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{t.type}</p>
                          <p className="text-xs text-muted-foreground">
                            {t.count} payout{t.count !== 1 ? 's' : ''}
                          </p>
                        </div>
                        <p className="font-bold text-emerald-600 tabular-nums shrink-0">{formatUGX(t.total)}</p>
                      </div>
                    ))}
                  </div>
                  {sortedTypeRows.length > TYPE_PAGE && (
                    <div className="flex items-center justify-center gap-3 pt-0.5">
                      {typeVisible < sortedTypeRows.length && (
                        <button
                          type="button"
                          onClick={() => setTypeVisible((v) => v + TYPE_PAGE)}
                          className="text-xs font-semibold text-emerald-600 hover:underline"
                        >
                          Show more ({sortedTypeRows.length - typeVisible})
                        </button>
                      )}
                      {typeVisible > TYPE_PAGE && (
                        <button
                          type="button"
                          onClick={() => setTypeVisible(TYPE_PAGE)}
                          className="text-xs font-semibold text-muted-foreground hover:underline"
                        >
                          Show less
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* By day */}
              <div className="flex items-center justify-between gap-2 pt-1">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  By day
                </p>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleDaySort('date')}
                    className={cn(
                      'flex items-center gap-0.5 text-[11px] font-semibold rounded-md px-1.5 py-0.5 transition-colors',
                      daySort.key === 'date' ? 'bg-emerald-500/10 text-emerald-600' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Date
                    {daySort.key === 'date' && (daySort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleDaySort('total')}
                    className={cn(
                      'flex items-center gap-0.5 text-[11px] font-semibold rounded-md px-1.5 py-0.5 transition-colors',
                      daySort.key === 'total' ? 'bg-emerald-500/10 text-emerald-600' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    Total
                    {daySort.key === 'total' && (daySort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
                  </button>
                </div>
              </div>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {sortedDayRows.slice(0, dayVisible).map((r) => (
                <div
                  key={r.date}
                  className="flex items-center justify-between gap-3 rounded-xl bg-muted/40 px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      {format(new Date(`${r.date}T00:00:00`), 'EEE, MMM d, yyyy')}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.count} payout{r.count !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <p className="font-bold text-emerald-600 tabular-nums shrink-0">{formatUGX(r.total)}</p>
                </div>
              ))}
            </div>
            {sortedDayRows.length > DAY_PAGE && (
              <div className="flex items-center justify-center gap-3 pt-0.5">
                {dayVisible < sortedDayRows.length && (
                  <button
                    type="button"
                    onClick={() => setDayVisible((v) => v + DAY_PAGE)}
                    className="text-xs font-semibold text-emerald-600 hover:underline"
                  >
                    Show more ({sortedDayRows.length - dayVisible})
                  </button>
                )}
                {dayVisible > DAY_PAGE && (
                  <button
                    type="button"
                    onClick={() => setDayVisible(DAY_PAGE)}
                    className="text-xs font-semibold text-muted-foreground hover:underline"
                  >
                    Show less
                  </button>
                )}
              </div>
            )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Payout activity — full transaction history of every payout this merchant
          has settled, with the commission earned and any principal reimbursed. */}
      <Card className="rounded-2xl">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
            <Wallet className="h-4 w-4 text-primary" />
            Payout Activity
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            All settled payouts and the commission you earned on each.
          </p>
        </CardHeader>
        <CardContent className="pt-0 space-y-2">
          {(payoutHistory?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No payouts settled yet. Confirm a payout to see it here.
            </p>
          ) : (
            <>
              <div className="space-y-2 max-h-[26rem] overflow-y-auto">
                {payoutHistory!.slice(0, historyVisible).map((h: any) => {
                  const channel = getPayoutChannel(h);
                  const method = normalizePayoutMethod(h.payout_method);
                  const methodLabel = channel === 'momo'
                    ? 'Mobile Money'
                    : method.includes('bank') ? 'Bank Transfer' : 'Cash';
                  const name = h.profiles?.full_name || 'Customer';
                  const phone = getRecipientPhone(h);
                  const earned = Number(h.commission || 0) + Number(h.reimbursed || 0);
                  const commission = Number(h.commission || 0) || getCashoutCommission(Number(h.amount || 0));
                  const sendCharge = getTelecomSendingCharge(Number(h.amount || 0));
                  return (
                    <div key={h.id} className="rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {methodLabel} · {phone}
                          </p>
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-sm font-bold tabular-nums text-foreground">{formatUGX(Number(h.amount || 0))}</p>
                          <p className="text-[11px] text-muted-foreground">
                            {h.processed_at ? format(new Date(h.processed_at), 'MMM d, HH:mm') : ''}
                          </p>
                        </div>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2 flex-wrap">
                        <span className="inline-flex items-center rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-semibold text-emerald-600 tabular-nums">
                          Commission earned: +{formatUGX(commission)}
                        </span>
                        <span className="inline-flex items-center rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 tabular-nums">
                          Telecom charge: {formatUGX(sendCharge)}
                        </span>
                      </div>
                      <div className="mt-1.5 flex items-center justify-between gap-2 border-t border-border/60 pt-1.5">
                        <span className="text-[11px] text-muted-foreground">
                          Added to your withdrawable wallet
                        </span>
                        <span className="text-[11px] font-semibold text-emerald-600 tabular-nums">
                          +{formatUGX(earned)}
                          {Number(h.commission || 0) > 0 && (
                            <span className="ml-1 font-normal text-muted-foreground">
                              ({formatUGX(Number(h.commission || 0))} comm.)
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
              {payoutHistory!.length > HISTORY_PAGE && (
                <div className="flex items-center justify-center gap-3 pt-0.5">
                  {historyVisible < payoutHistory!.length && (
                    <button
                      type="button"
                      onClick={() => setHistoryVisible((v) => v + HISTORY_PAGE)}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Show more ({payoutHistory!.length - historyVisible})
                    </button>
                  )}
                  {historyVisible > HISTORY_PAGE && (
                    <button
                      type="button"
                      onClick={() => setHistoryVisible(HISTORY_PAGE)}
                      className="text-xs font-semibold text-muted-foreground hover:underline"
                    >
                      Show less
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Live status banner */}
      {totalPending > 0 && (
        <div className="flex items-center justify-between gap-2.5 p-3.5 rounded-2xl bg-orange-500/10 border border-orange-500/20 text-orange-700 dark:text-orange-400">
          <div className="flex items-center gap-2.5 min-w-0">
            <Bell className="h-5 w-5 animate-pulse shrink-0" />
            <span className="text-sm font-semibold truncate">
              {totalPending} pending withdrawal{totalPending !== 1 ? 's' : ''} · live
            </span>
          </div>
          <button
            type="button"
            onClick={() => setAuditOpen(true)}
            className="shrink-0 rounded-lg border border-orange-500/30 bg-white/70 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-orange-700 hover:bg-card dark:bg-orange-500/10 dark:text-orange-300"
          >
            View audit
          </button>
        </div>
      )}

      <MerchantPayoutsAuditDialog open={auditOpen} onOpenChange={setAuditOpen} />

      {/* Withdrawal Requests by channel — UNCLAIMED only */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-foreground">Pending Queue</h2>
          {totalPending > 0 && (
            <span className="rounded-md bg-amber-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-700 dark:bg-amber-500/15 dark:text-amber-400">
              {totalPending} action required
            </span>
          )}
        </div>

        {hasActiveClaim && (
          <button
            type="button"
            onClick={() => claimedSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
            className="flex w-full items-center gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-left dark:border-amber-500/30 dark:bg-amber-500/10"
          >
            <Clock className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
                Queue locked — finish your current claim
              </p>
              <p className="text-xs text-amber-700/80 dark:text-amber-400/80">
                Complete it before claiming another — there's no time limit. Tap to jump to it.
              </p>
            </div>
          </button>
        )}

        {/* Advanced filters & sorting */}
        <div className="rounded-2xl border border-border bg-muted/30 p-3 space-y-3">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <SlidersHorizontal className="h-3.5 w-3.5" /> Filters &amp; Sort
            </span>
            {queueFiltersActive && (
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={resetQueueFilters}>
                <X className="h-3.5 w-3.5" /> Clear
              </Button>
            )}
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={queueSearch}
              onChange={(e) => setQueueSearch(e.target.value)}
              placeholder="Search by name or phone"
              className="h-10 pl-9"
            />
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {/* Status */}
            <Select value={queueStatus} onValueChange={(v) => setQueueStatus(v as typeof queueStatus)}>
              <SelectTrigger className="h-10"><SelectValue placeholder="Status" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="standard">Standard payout</SelectItem>
                <SelectItem value="landlord">Landlord payout</SelectItem>
              </SelectContent>
            </Select>

            {/* Merchant / provider */}
            <Select value={queueMerchant} onValueChange={setQueueMerchant}>
              <SelectTrigger className="h-10"><SelectValue placeholder="Merchant" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All merchants</SelectItem>
                {MERCHANT_OPTIONS.map((m) => (
                  <SelectItem key={m} value={m}>{MERCHANT_LABELS[m] || m}</SelectItem>
                ))}
              </SelectContent>
            </Select>

            {/* Sort */}
            <Select value={queueSort} onValueChange={(v) => setQueueSort(v as typeof queueSort)}>
              <SelectTrigger className="h-10">
                <ArrowUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <SelectValue placeholder="Sort" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date_desc">Newest first</SelectItem>
                <SelectItem value="date_asc">Oldest first</SelectItem>
                <SelectItem value="amount_desc">Amount: high → low</SelectItem>
                <SelectItem value="amount_asc">Amount: low → high</SelectItem>
                <SelectItem value="status">Landlord payouts first</SelectItem>
              </SelectContent>
            </Select>

            {/* Date range */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className={cn('h-10 justify-start gap-2 px-3 text-left font-normal', !queueFrom && !queueTo && 'text-muted-foreground')}>
                  <CalendarIcon className="h-4 w-4 shrink-0" />
                  <span className="truncate text-xs">
                    {queueFrom || queueTo
                      ? `${queueFrom ? format(queueFrom, 'MMM d') : '…'} – ${queueTo ? format(queueTo, 'MMM d') : '…'}`
                      : 'Date range'}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="range"
                  selected={{ from: queueFrom, to: queueTo }}
                  onSelect={(range) => { setQueueFrom(range?.from); setQueueTo(range?.to); }}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
          </div>

          {/* Amount range */}
          <div className="grid grid-cols-2 gap-2">
            <Input
              value={queueMin}
              onChange={(e) => setQueueMin(e.target.value.replace(/[^\d]/g, ''))}
              inputMode="numeric"
              placeholder="Min amount (UGX)"
              className="h-10"
            />
            <Input
              value={queueMax}
              onChange={(e) => setQueueMax(e.target.value.replace(/[^\d]/g, ''))}
              inputMode="numeric"
              placeholder="Max amount (UGX)"
              className="h-10"
            />
          </div>

          {queueFiltersActive && (
            <p className="text-xs text-muted-foreground">
              Showing <span className="font-semibold text-foreground">{filteredPending}</span> of {totalPending} pending
            </p>
          )}
        </div>

        <Tabs value={channelTab} onValueChange={(v) => setChannelTab(v as 'all' | 'momo' | 'cash' | 'bank')}>
        <TabsList className="w-full h-12 p-1">
          <TabsTrigger value="all" className="flex-1 gap-1.5 text-sm h-10">
            <Wallet className="h-4 w-4" /> All
            {channelCounts.all > 0 && <Badge variant="destructive" className="h-5 px-1.5 text-xs">{channelCounts.all}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="momo" className="flex-1 gap-1.5 text-sm h-10">
            <Smartphone className="h-4 w-4" /> MoMo
            {channelCounts.momo > 0 && <Badge variant="destructive" className="h-5 px-1.5 text-xs">{channelCounts.momo}</Badge>}
          </TabsTrigger>
          <TabsTrigger value="bank" className="flex-1 gap-1.5 text-sm h-10">
            <Landmark className="h-4 w-4" /> Bank
            {channelCounts.bank > 0 && <Badge variant="destructive" className="h-5 px-1.5 text-xs">{channelCounts.bank}</Badge>}
          </TabsTrigger>
        </TabsList>

        {(['all', 'momo', 'bank'] as const).map(tab => {
          // Only the active tab fetches; the page query is keyed by `channelTab`.
          const items = tab === channelTab ? pageRows : [];
          const emptyMsg = queueFiltersActive
            ? 'No withdrawals match these filters'
            : blockingUrgentLandlord
              ? 'Landlord payouts are Priority #1. No matching landlord payouts in this tab.'
              : blockingUrgentProxy
                ? 'Proxy withdrawals are Priority #1. No matching proxy withdrawals in this tab.'
                : tab === 'all'
                  ? 'No pending withdrawals'
                  : `No pending ${tab} payouts`;
          return (
            <TabsContent key={tab} value={tab} className="space-y-2.5 mt-4">
              {loadingAll && items.length === 0 ? (
                <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
              ) : tab === channelTab && queueError && items.length === 0 ? (
                <Card className="rounded-2xl border-destructive/30">
                  <CardContent className="py-10 text-center space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Couldn't load the pending queue. This is a connection issue, not an empty queue.
                    </p>
                    <Button variant="outline" size="sm" onClick={() => refetchQueue()}>
                      <Loader2 className="h-4 w-4 mr-2" /> Try again
                    </Button>
                  </CardContent>
                </Card>
              ) : items.length === 0 ? (
                <Card className="rounded-2xl"><CardContent className="py-12 text-center text-base text-muted-foreground">{emptyMsg}</CardContent></Card>
              ) : (
                <>
                {fetchingQueue && (
                  <div className="flex items-center justify-center gap-2 py-1 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Updating…
                  </div>
                )}
                {items.map((w: any) => {
                  const channel = getPayoutChannel(w);
                  const isMoMo = channel === 'momo';
                  const MethodIcon = channel === 'momo' ? Smartphone : channel === 'bank' ? Landmark : Banknote;
                  const methodLabel = channel === 'momo' ? 'Mobile Money' : channel === 'bank' ? 'Bank Transfer' : 'Cash';
                  const isLandlordPayout =
                    typeof w.reason === 'string' && w.reason.startsWith('Landlord float payout');
                  const isUrgentLandlord = landlordPriorityEnforced && isUrgentLandlordPayout(w);
                  const isUrgentProxy = proxyPriorityEnforced && isUrgentProxyWithdrawal(w);
                  const landlordBlocked =
                    !isUrgentLandlord && !!blockingUrgentLandlord && blockingUrgentLandlord.id !== w.id;
                  const proxyBlocked =
                    !isUrgentLandlord && !isUrgentProxy && !!blockingUrgentProxy && blockingUrgentProxy.id !== w.id;
                  const name = isLandlordPayout
                    ? (w.mobile_money_name || 'Landlord')
                    : (w.profiles?.full_name
                        || w.linked_party_profile?.full_name
                        || w.mobile_money_name
                        || w.bank_account_name
                        || 'Unknown');
                  return (
                    <Card
                      key={w.id}
                      className={cn(
                        'rounded-2xl transition-colors',
                        isUrgentLandlord
                          ? 'border-2 border-violet-500/60 bg-violet-500/5 ring-2 ring-violet-500/20'
                          : isUrgentProxy
                            ? 'border-2 border-destructive/60 bg-destructive/5 ring-2 ring-destructive/20'
                            : 'border-border hover:border-primary/30',
                      )}
                    >
                      <CardContent className="p-4 space-y-3.5">
                        {isUrgentLandlord && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center rounded-md bg-violet-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
                              {URGENT_LANDLORD_BADGE_LABEL}
                            </span>
                            <span className="text-[11px] font-semibold text-violet-600 dark:text-violet-400">Priority #1 — process this first</span>
                          </div>
                        )}
                        {isUrgentProxy && (
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="inline-flex items-center rounded-md bg-destructive px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-destructive-foreground">
                              {URGENT_PROXY_BADGE_LABEL}
                            </span>
                            <span className="text-[11px] font-semibold text-destructive">Priority #2 — process this first</span>
                          </div>
                        )}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 flex-1 items-start gap-3">
                            <div className={cn(
                              'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                              isMoMo
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-400'
                                : 'bg-primary/10 text-primary',
                            )}>
                              <MethodIcon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="text-base font-bold leading-tight break-words">{name}</p>
                              {isLandlordPayout && (
                                <span className="mt-0.5 inline-flex items-center rounded-md bg-violet-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">
                                  Landlord Payout
                                </span>
                              )}
                              <p className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                                <Phone className="h-3.5 w-3.5" />
                                <span className="font-mono italic">Hidden until claimed</span>
                              </p>
                              <p className="mt-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">{methodLabel} · pending</p>
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="whitespace-nowrap text-base sm:text-lg font-bold tabular-nums leading-tight text-foreground">{formatUGX(w.amount)}</p>
                          </div>
                        </div>
                        {landlordBlocked && (
                          <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-xs font-semibold text-violet-700 dark:text-violet-300">
                            {LANDLORD_PRIORITY_WAITING_LABEL} {LANDLORD_PRIORITY_BLOCK_MESSAGE}
                          </div>
                        )}
                        {proxyBlocked && (
                          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive">
                            {PROXY_PRIORITY_WAITING_LABEL} {PROXY_PRIORITY_BLOCK_MESSAGE}
                          </div>
                        )}
                        <Button
                          className="w-full h-12 gap-2 font-semibold text-base"
                          onClick={() => handleClaim(w.id, {
                            momoNumber: w.mobile_money_number ?? null,
                            momoName: w.mobile_money_name ?? null,
                          })}
                          disabled={claimingIds.has(w.id) || hasActiveClaim || landlordBlocked || proxyBlocked}
                          title={
                            claimingIds.has(w.id)
                              ? 'Request is being processed…'
                              : landlordBlocked
                                ? LANDLORD_PRIORITY_BLOCK_MESSAGE
                                : proxyBlocked
                                  ? PROXY_PRIORITY_BLOCK_MESSAGE
                                  : hasActiveClaim
                                    ? 'Finish your current claim before claiming another'
                                    : 'Claim this withdrawal'
                          }
                        >
                          {claimingIds.has(w.id) ? (
                            <><Loader2 className="h-5 w-5 animate-spin" /> Claiming…</>
                          ) : landlordBlocked ? (
                            <><Clock className="h-5 w-5" /> Waiting for Priority Landlord Payout</>
                          ) : proxyBlocked ? (
                            <><Clock className="h-5 w-5" /> Waiting for Priority Proxy Withdrawal</>
                          ) : hasActiveClaim ? (
                            <><Clock className="h-5 w-5" /> Finish current claim first</>
                          ) : (
                            <><UserCheck className="h-5 w-5" /> {isUrgentLandlord ? 'Claim Priority Landlord Payout' : isUrgentProxy ? 'Claim Priority Payout' : 'Claim'}</>
                          )}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
                {/* Server-side pagination controls */}
                {pageCount > PAGE_SIZE && (
                  <div className="flex items-center justify-between gap-3 pt-2">
                    <span className="text-xs text-muted-foreground">
                      {rangeStart}–{rangeEnd} of {pageCount}
                    </span>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2.5"
                        disabled={page === 0 || fetchingQueue}
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                      >
                        <ChevronLeft className="h-4 w-4" /> Prev
                      </Button>
                      <span className="text-xs font-semibold tabular-nums text-muted-foreground">
                        Page {page + 1} / {totalPages}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2.5"
                        disabled={page + 1 >= totalPages || fetchingQueue}
                        onClick={() => setPage((p) => p + 1)}
                      >
                        Next <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
                </>
              )}
            </TabsContent>
          );
        })}
        </Tabs>
      </section>

      {/* Complete audit trail of every withdrawal this agent was alerted to. */}
      <MerchantDispatchHistory />
    </div>
    </MerchantAgreementGate>
  );
}

// WithdrawalPayoutCard moved to src/components/withdrawals/WithdrawalPayoutCard.tsx
