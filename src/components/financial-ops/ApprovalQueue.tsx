import { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';
import { differenceInHours } from 'date-fns';
import { Search, CheckCircle2, XCircle, Clock, Banknote, Wallet, Loader2, ArrowUpDown, Copy, Check, Snowflake, Unlock } from 'lucide-react';
import { toast } from 'sonner';
import { extractFromErrorObject, extractEdgeFunctionError } from '@/lib/extractEdgeFunctionError';
import { RequestDetailSheet } from './RequestDetailSheet';

type QueueType = 'wallet_withdrawals' | 'wallet_ops';

// Liquidity-control categories for the Cash Out queue. Lets an operator
// freeze e.g. "the rest of this week's Landlord Payouts" while still paying
// out a chosen few — independent of the requester's account-level fraud
// freeze. Derived from the requester's enabled role; `landlord_payout_id`
// overrides role since that column is a definitive link to a landlord payout
// event regardless of who technically holds the withdrawing wallet.
const WITHDRAWAL_CATEGORY_LABELS: Record<string, string> = {
  landlord: 'Landlord Payouts',
  agent: 'Agent Payouts',
  supporter: 'Supporter Payouts',
  tenant: 'Tenant Payouts',
  staff: 'Staff & Other',
};

function categorizeWithdrawal(row: { landlord_payout_id?: string | null }, role: string | undefined): string {
  if (row.landlord_payout_id) return 'landlord';
  if (role === 'landlord' || role === 'landlord_ops') return 'landlord';
  if (role === 'agent' || role === 'senior_agent' || role === 'sub_agent' || role === 'agent_ops') return 'agent';
  if (role === 'supporter') return 'supporter';
  if (role === 'tenant' || role === 'tenant_ops') return 'tenant';
  return 'staff';
}

interface QueueItem {
  id: string;
  type: QueueType;
  userId: string | null;
  userName: string;
  userPhone: string;
  amount: number;
  description: string;
  category: string;
  createdAt: string;
  ageHours: number;
  urgency: 'green' | 'amber' | 'red';
  rawData: any;
  // Paired-leg metadata (for double-entry events like portfolio top-ups).
  // When present, this item represents the BUSINESS EVENT and groupedIds
  // contains BOTH ledger leg IDs (cash_in + cash_out) that must be
  // approved/rejected together.
  groupedIds?: string[];
  pairedLegs?: { id: string; direction: string; rawData: any }[];
  payoutDetails?: {
    method: string;
    provider?: string;
    number?: string;
    name?: string;
    bankName?: string;
    bankAccountNumber?: string;
    bankAccountName?: string;
    agentLocation?: string;
    status?: string;
    payoutCode?: string;
  };
}

export function ApprovalQueue() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeQueue, setActiveQueue] = useState<QueueType>('wallet_withdrawals');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'approve' | 'reject' | 'freeze' | 'unfreeze' | null>(null);
  const [reason, setReason] = useState('');
  const [processing, setProcessing] = useState(false);
  const [inspectItem, setInspectItem] = useState<QueueItem | null>(null);
  const [payoutProof, setPayoutProof] = useState('');
  const [sortNewest, setSortNewest] = useState(false);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);

  // Wallet withdrawal requests (from withdrawal_requests table)
  const { data: walletWithdrawals = [], isLoading: loadingWalletWithdrawals } = useQuery({
    queryKey: ['approval-queue-wallet-withdrawals'],
    queryFn: async () => {
      const { data } = await supabase
        .from('withdrawal_requests')
        .select('*')
        .in('status', ['pending', 'requested'])
        .order('created_at', { ascending: true })
        .limit(200);
      if (!data?.length) return [];

      const userIds = [...new Set(data.map(d => d.user_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', userIds);
      const pm = new Map(profiles?.map(p => [p.id, p]) || []);

      const { data: roles } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .in('user_id', userIds)
        .eq('enabled', true);
      const roleByUser = new Map<string, string>();
      for (const r of roles || []) {
        if (!roleByUser.has(r.user_id)) roleByUser.set(r.user_id, r.role as string);
      }

      // Enrich cash withdrawals with their WPO pickup code. The code lives
      // in `payout_codes` (issued at submission). `withdrawal_requests.payout_code`
      // is only stamped later by legacy code paths, so we cannot rely on it.
      const cashIds = data.filter(d => (d.payout_method || '') === 'cash').map(d => d.id);
      const codeByWithdrawal = new Map<string, string>();
      if (cashIds.length) {
        const { data: codes } = await supabase
          .from('payout_codes')
          .select('withdrawal_request_id, code, status, created_at')
          .in('withdrawal_request_id', cashIds)
          .order('created_at', { ascending: false });
        for (const c of codes || []) {
          if (!codeByWithdrawal.has(c.withdrawal_request_id)) {
            codeByWithdrawal.set(c.withdrawal_request_id, c.code);
          }
        }
      }

      return data.map(w => {
        const profile = pm.get(w.user_id);
        const ageH = differenceInHours(new Date(), new Date(w.created_at));
        const method = w.payout_method || 'mobile_money';
        const payoutLabel = method === 'bank_transfer'
          ? `🏦 Bank: ${w.bank_name || '—'} · ${w.bank_account_number || '—'}`
          : method === 'cash'
          ? `💵 Cash at: ${w.agent_location || 'Agent'}`
          : `📱 ${w.mobile_money_provider || 'MoMo'}: ${w.mobile_money_number || '—'}`;

        return {
          id: w.id,
          type: 'wallet_withdrawals' as QueueType,
          userId: w.user_id,
          userName: profile?.full_name || 'Unknown',
          userPhone: profile?.phone || '',
          amount: w.amount,
          description: payoutLabel,
          category: categorizeWithdrawal(w, roleByUser.get(w.user_id)),
          createdAt: w.created_at,
          ageHours: ageH,
          urgency: ageH < 1 ? 'green' as const : ageH < 4 ? 'amber' as const : 'red' as const,
          rawData: w,
          payoutDetails: {
            method,
            provider: w.mobile_money_provider || undefined,
            number: w.mobile_money_number || undefined,
            name: w.mobile_money_name || undefined,
            bankName: w.bank_name || undefined,
            bankAccountNumber: w.bank_account_number || undefined,
            bankAccountName: w.bank_account_name || undefined,
            agentLocation: w.agent_location || undefined,
            status: w.status,
            payoutCode:
              (w as any).payout_code ||
              codeByWithdrawal.get(w.id) ||
              undefined,
          },
        };
      });
    },
    staleTime: 15000,
  });

  const { data: walletOps = [], isLoading: loadingWalletOps } = useQuery({
    queryKey: ['approval-queue-wallet-ops'],
    queryFn: async () => {
      const { data } = await supabase
        .from('pending_wallet_operations')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(200);
      if (!data?.length) return [];

      const userIds = [...new Set(data.filter(d => d.user_id).map(d => d.user_id!))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', userIds.length ? userIds : ['__none__']);
      const pm = new Map(profiles?.map(p => [p.id, p]) || []);

      // ── Collapse paired double-entry legs into a single business event ──
      // For events like portfolio top-ups, the system writes two rows
      // (cash_in + cash_out) sharing the same source_id, amount, created_at.
      // We group them so the operator approves/rejects ONE event atomically,
      // never half-approving the ledger (which would break SUM(cash_in)==SUM(cash_out)).
      const pairKey = (r: any) => `${r.source_id || 'no-src'}|${r.amount}|${r.created_at}|${r.user_id || 'no-user'}`;
      const groups = new Map<string, typeof data>();
      for (const row of data) {
        const k = pairKey(row);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(row);
      }

      const items: QueueItem[] = [];
      for (const groupRows of groups.values()) {
        // Prefer cash_in row as the "primary" face of the event
        const primary = groupRows.find(r => r.direction === 'cash_in') || groupRows[0];
        const profile = primary.user_id ? pm.get(primary.user_id) : null;
        const ageH = differenceInHours(new Date(), new Date(primary.created_at));
        const isPair = groupRows.length > 1;

        items.push({
          id: primary.id,
          type: 'wallet_ops' as QueueType,
          userId: primary.user_id,
          userName: profile?.full_name || 'Pending Activation',
          userPhone: profile?.phone || '',
          amount: primary.amount,
          description: primary.description || primary.category,
          category: primary.category,
          createdAt: primary.created_at,
          ageHours: ageH,
          urgency: ageH < 1 ? 'green' as const : ageH < 4 ? 'amber' as const : 'red' as const,
          rawData: primary,
          groupedIds: isPair ? groupRows.map(r => r.id) : undefined,
          pairedLegs: isPair
            ? groupRows.map(r => ({ id: r.id, direction: r.direction, rawData: r }))
            : undefined,
        });
      }
      // Stable: oldest first (matches table order)
      items.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      return items;
    },
    staleTime: 15000,
  });

  const queues: Record<QueueType, QueueItem[]> = { wallet_withdrawals: walletWithdrawals, wallet_ops: walletOps };
  const isLoading = activeQueue === 'wallet_withdrawals' ? loadingWalletWithdrawals : loadingWalletOps;

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of walletWithdrawals) {
      counts.set(i.category, (counts.get(i.category) || 0) + 1);
    }
    return counts;
  }, [walletWithdrawals]);

  const items = useMemo(() => {
    let list = queues[activeQueue];
    if (activeQueue === 'wallet_withdrawals' && categoryFilter !== 'all') {
      list = list.filter(i => i.category === categoryFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(i =>
        i.userName.toLowerCase().includes(q) ||
        i.userPhone.includes(q) ||
        i.description.toLowerCase().includes(q) ||
        i.id.startsWith(q)
      );
    }
    if (sortNewest) {
      list = [...list].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    return list;
  }, [activeQueue, categoryFilter, search, sortNewest, walletWithdrawals, walletOps]);

  // Group cash withdrawals by pickup code for visual clustering
  const groupedByCode = useMemo(() => {
    const groups = new Map<string, QueueItem[]>();
    const nonGrouped: QueueItem[] = [];
    for (const item of items) {
      const code = item.payoutDetails?.payoutCode;
      if (item.payoutDetails?.method === 'cash' && code) {
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code)!.push(item);
      } else {
        nonGrouped.push(item);
      }
    }
    return { groups, nonGrouped };
  }, [items]);

  const handleCopyCode = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);
      toast.success(`Copied ${code}`);
      setTimeout(() => setCopiedCode((prev) => (prev === code ? null : prev)), 2000);
    } catch {
      toast.error('Failed to copy code');
    }
  };

  const renderItemCard = (item: QueueItem) => {
    const Icon = queueIcon[item.type];
    const isCashOut = item.type === 'wallet_withdrawals';
    const isCashMissingCode = isCashOut && item.payoutDetails?.method === 'cash' && !item.payoutDetails?.payoutCode;
    const isSelectedMissingCode = selected.has(item.id) && isCashMissingCode;
    const isFrozen = isCashOut && !!item.rawData?.frozen;
    const ageMinutes = Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 60000);
    const ageLabel = ageMinutes < 60 ? `${ageMinutes}m` : ageMinutes < 1440 ? `${Math.floor(ageMinutes / 60)}h` : `${Math.floor(ageMinutes / 1440)}d`;

    return (
      <div
        key={item.id}
        className={`rounded-xl border-2 overflow-hidden transition-colors ${
          isSelectedMissingCode
            ? 'border-destructive/70 bg-gradient-to-r from-destructive/10 to-card shadow-sm shadow-destructive/10'
            : isCashOut
            ? 'border-orange-500/40 bg-gradient-to-r from-orange-500/5 to-card'
            : `border-l-4 ${urgencyBg[item.urgency]} border-t border-r border-b border-border/60 bg-card`
        }`}
      >
        <div className={`px-3 py-1.5 flex items-center justify-between ${
          isCashOut ? 'bg-orange-500/10' : 'bg-muted/30'
        }`} onClick={() => setInspectItem(item)}>
          <div className="flex items-center gap-2">
            <Checkbox
              checked={selected.has(item.id)}
              onCheckedChange={() => toggleSelect(item.id)}
              onClick={(e) => e.stopPropagation()}
              className="shrink-0"
            />
            <div className={`p-1 rounded-lg ${isCashOut ? 'bg-orange-500/20' : 'bg-muted'}`}>
              <Icon className={`h-3.5 w-3.5 ${isCashOut ? 'text-orange-600' : 'text-amber-600'}`} />
            </div>
            <span className={`text-[10px] font-bold uppercase tracking-wider ${
              isCashOut ? 'text-orange-600' : 'text-muted-foreground'
            }`}>
              {isCashOut ? 'Cash Out' : 'Wallet Op'}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {isFrozen && (
              <Badge variant="outline" className="text-[9px] h-5 px-1.5 gap-1 border-sky-500/40 bg-sky-500/10 text-sky-700">
                <Snowflake className="h-2.5 w-2.5" /> Frozen
              </Badge>
            )}
            {item.pairedLegs && item.pairedLegs.length > 1 && (
              <Badge variant="outline" className="text-[9px] h-5 px-1.5 gap-1 border-primary/40 bg-primary/5 text-primary">
                ⛓ {item.pairedLegs.length} linked legs
              </Badge>
            )}
            <Badge variant={item.urgency === 'red' ? 'destructive' : item.urgency === 'amber' ? 'secondary' : 'outline'} className="text-[9px] h-5 px-1.5">
              {ageLabel} ago
            </Badge>
          </div>
        </div>

        <div className="p-3 space-y-2" onClick={() => setInspectItem(item)}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold truncate">{item.userName}</p>
              <p className="text-[11px] text-muted-foreground truncate">{getItemDisplayLabel(item)}</p>
              {item.userPhone && (
                <p className="text-[10px] text-muted-foreground/70">{item.userPhone}</p>
              )}
            </div>
            <div className={`text-right shrink-0 px-3 py-2 rounded-xl ${
              isCashOut ? 'bg-orange-500/10' : 'bg-muted/50'
            }`}>
              <p className={`text-lg font-black tabular-nums ${
                isCashOut ? 'text-orange-600' : 'text-foreground'
              }`}>
                {formatUGX(item.amount)}
              </p>
            </div>
          </div>

          {isFrozen && (
            <div className="p-2.5 rounded-xl bg-sky-500/5 border border-sky-500/20 space-y-0.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-sky-700 flex items-center gap-1">
                <Snowflake className="h-3 w-3" /> On hold — Financial Ops
              </p>
              {item.rawData?.frozen_reason && (
                <p className="text-[11px] text-muted-foreground">{item.rawData.frozen_reason}</p>
              )}
            </div>
          )}

          {item.pairedLegs && item.pairedLegs.length > 1 && (
            <div className="p-2.5 rounded-xl bg-primary/5 border border-primary/20 space-y-1.5">
              <p className="text-[10px] font-bold uppercase tracking-wider text-primary">
                Double-entry event · approved as one unit
              </p>
              {item.pairedLegs.map((leg) => (
                <div key={leg.id} className="flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5">
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${leg.direction === 'cash_in' ? 'bg-emerald-500' : 'bg-orange-500'}`} />
                    <span className="font-semibold uppercase tracking-wider text-muted-foreground">
                      {leg.direction === 'cash_in' ? 'Credit (deposit)' : 'Debit (withdrawal)'}
                    </span>
                  </span>
                  <span className="font-mono text-muted-foreground/70">#{leg.id.slice(0, 8)}</span>
                </div>
              ))}
            </div>
          )}

          {item.payoutDetails && isCashOut && (
            <div className="p-2.5 rounded-xl bg-orange-500/5 border border-orange-500/20 space-y-1">
              {item.payoutDetails.method === 'mobile_money' && (
                <>
                  <p className="text-xs font-semibold">📱 {item.payoutDetails.provider || 'MoMo'}: <span className="font-mono">{item.payoutDetails.number}</span></p>
                  {item.payoutDetails.name && <p className="text-[11px] text-muted-foreground">Name: {item.payoutDetails.name}</p>}
                </>
              )}
              {item.payoutDetails.method === 'bank_transfer' && (
                <>
                  <p className="text-xs font-semibold">🏦 {item.payoutDetails.bankName}</p>
                  <p className="text-[11px] font-mono">Acc: {item.payoutDetails.bankAccountNumber}</p>
                  {item.payoutDetails.bankAccountName && <p className="text-[11px] text-muted-foreground">Name: {item.payoutDetails.bankAccountName}</p>}
                </>
              )}
              {item.payoutDetails.method === 'cash' && (
                <>
                  <p className="text-xs font-semibold">💵 Cash at: {item.payoutDetails.agentLocation || 'Agent'}</p>
                  {item.payoutDetails.payoutCode && (
                    <p className="text-[11px] font-mono font-bold text-amber-700">
                      Pickup code: {item.payoutDetails.payoutCode}
                    </p>
                  )}
                </>
              )}
              <Badge variant="outline" className="h-5 px-1.5 text-[9px]">
                {item.payoutDetails.status?.replace(/_/g, ' ')}
              </Badge>
            </div>
          )}

          {item.payoutDetails?.status && !isCashOut && (
            <Badge variant="outline" className="h-5 px-1.5 text-[9px]">
              {item.payoutDetails.status.replace(/_/g, ' ')}
            </Badge>
          )}
        </div>

        <div className="grid grid-cols-2 gap-0 border-t border-border/40">
          {isFrozen ? (
            <Button
              variant="ghost"
              className="h-12 rounded-none text-sm font-bold gap-1.5 text-sky-700 hover:bg-sky-500/10"
              onClick={(e) => { e.stopPropagation(); setSelected(new Set([item.id])); setBulkAction('unfreeze'); }}
              disabled={processing}
            >
              <Unlock className="h-4 w-4" />
              Unfreeze
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="h-12 rounded-none text-sm font-bold gap-1.5 text-primary hover:bg-primary/10"
              onClick={(e) => { e.stopPropagation(); setSelected(new Set([item.id])); setBulkAction('approve'); }}
              disabled={processing}
            >
              <CheckCircle2 className="h-4 w-4" />
              Approve
            </Button>
          )}
          <Button
            variant="ghost"
            className="h-12 rounded-none text-sm font-bold gap-1.5 text-destructive hover:bg-destructive/10 border-l border-border/40"
            onClick={(e) => { e.stopPropagation(); setSelected(new Set([item.id])); setBulkAction('reject'); }}
            disabled={processing}
          >
            <XCircle className="h-4 w-4" />
            Reject
          </Button>
        </div>
      </div>
    );
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map(i => i.id)));
    }
  };

  const getProofLabel = () => {
    if (activeQueue !== 'wallet_withdrawals' || selected.size !== 1) return null;
    const item = items.find(i => selected.has(i.id));
    if (!item?.payoutDetails) return null;
    const m = item.payoutDetails.method;
    if (m === 'bank_transfer') return { label: 'Bank Reference', placeholder: 'Enter bank transfer reference number…', type: 'bank_reference' };
    if (m === 'cash') return { label: 'Payment Voucher #', placeholder: 'Enter payment voucher number…', type: 'payment_voucher' };
    return { label: 'Transaction ID (TID)', placeholder: 'Enter MoMo transaction ID…', type: 'momo_tid' };
  };

  const proofConfig = getProofLabel();
  const walletWithdrawalApproveBlocked = activeQueue === 'wallet_withdrawals' && bulkAction === 'approve' && !payoutProof.trim();

  // Cash payouts are gated by a one-time WPO-XXXXX pickup code (issued at
  // submission, stored in `payout_codes`). Block approval entirely when any
  // selected cash withdrawal has no code on file — the backend would reject it
  // with CASH_CODE_REQUIRED anyway, so we fail fast in the UI.
  const selectedCashMissingCode =
    activeQueue === 'wallet_withdrawals' && bulkAction === 'approve'
      ? items.filter(i => selected.has(i.id) && i.payoutDetails?.method === 'cash' && !i.payoutDetails?.payoutCode)
      : [];
  const cashCodeMissingBlocked = selectedCashMissingCode.length > 0;
  const approveBlocked = walletWithdrawalApproveBlocked || cashCodeMissingBlocked;

  const handleBulkAction = useCallback(async () => {
    if (!bulkAction || selected.size === 0 || !user) return;
    if (bulkAction === 'reject' && reason.length < 10) {
      toast.error('Rejection reason must be at least 10 characters');
      return;
    }

    if (activeQueue === 'wallet_withdrawals' && bulkAction === 'approve' && !payoutProof.trim()) {
      toast.error('Proof of payout is required to approve a cash-out');
      return;
    }

    const missingCashCode = items.some(
      i => selected.has(i.id) && i.payoutDetails?.method === 'cash' && !i.payoutDetails?.payoutCode,
    );
    if (activeQueue === 'wallet_withdrawals' && bulkAction === 'approve' && missingCashCode) {
      toast.error('Cash payout is missing its WPO pickup code — cannot approve until the user resubmits.');
      return;
    }

    setProcessing(true);
    try {
      // Expand any grouped (paired-leg) items into their underlying ledger leg IDs.
      // This guarantees BOTH halves of a double-entry event are approved/rejected
      // together — never half-approved (which would break the ledger).
      const expandIds = (selectedIds: string[]) => {
        const expanded = new Set<string>();
        for (const sid of selectedIds) {
          const item = items.find(i => i.id === sid);
          if (item?.groupedIds && item.groupedIds.length > 0) {
            item.groupedIds.forEach(g => expanded.add(g));
          } else {
            expanded.add(sid);
          }
        }
        return Array.from(expanded);
      };

      const ids = activeQueue === 'wallet_ops'
        ? expandIds(Array.from(selected))
        : Array.from(selected);
      if (activeQueue === 'wallet_ops') {
        const response = await supabase.functions.invoke('approve-wallet-operation', {
          body: { bulk_ids: ids, action: bulkAction, rejection_reason: bulkAction === 'reject' ? reason : undefined },
        });
        if (response.error) {
          const msg = await extractFromErrorObject(response.error, 'Wallet operation failed');
          throw new Error(msg);
        }
        // Only keep IDs that were actually processed
        const successIds = [...(response.data?.approved_ids || []), ...(response.data?.rejected_ids || [])];
        const failedCount = ids.length - successIds.length;
        if (failedCount > 0) {
          toast.warning(`${failedCount} item(s) could not be processed`);
        }
        ids.length = 0;
        ids.push(...successIds);
      } else if (activeQueue === 'wallet_withdrawals') {
        if (bulkAction === 'reject') {
          const { data: rejectData, error: rejectErr } = await supabase.functions.invoke('reject-withdrawal', {
            body: { withdrawal_ids: ids, reason, withdrawal_type: 'wallet' },
          });
          if (rejectErr) throw rejectErr;

          const rejectedIds = (rejectData?.results || [])
            .filter((r: any) => r.status === 'rejected')
            .map((r: any) => r.id);
          const failedCount = ids.length - rejectedIds.length;
          if (failedCount > 0) {
            toast.warning(`${failedCount} item(s) could not be rejected`);
          }
          ids.length = 0;
          ids.push(...rejectedIds);
        } else if (bulkAction === 'freeze') {
          const { error: freezeErr } = await supabase
            .from('withdrawal_requests')
            .update({
              frozen: true,
              frozen_at: new Date().toISOString(),
              frozen_by: user.id,
              frozen_reason: reason.trim() || null,
              frozen_category: categoryFilter !== 'all' ? categoryFilter : null,
            } as any)
            .in('id', ids);
          if (freezeErr) throw freezeErr;
        } else if (bulkAction === 'unfreeze') {
          const { error: unfreezeErr } = await supabase
            .from('withdrawal_requests')
            .update({
              frozen: false,
              frozen_at: null,
              frozen_by: null,
              frozen_reason: null,
              frozen_category: null,
            } as any)
            .in('id', ids);
          if (unfreezeErr) throw unfreezeErr;
        } else {
          // Ledger-first: approve each withdrawal via the edge function
          const selectedItem = items.find(i => selected.has(i.id));
          const method = selectedItem?.payoutDetails?.method || 'mobile_money';
          const paymentMethodLabel = method === 'bank_transfer' ? 'bank_transfer' : method === 'cash' ? 'cash' : (selectedItem?.payoutDetails?.provider || 'mobile_money');

          const approvalResults: string[] = [];
          const failedApprovals: string[] = [];
          for (const id of ids) {
            const itemForId = items.find((i) => i.id === id);
            const isCashItem = itemForId?.payoutDetails?.method === 'cash';
            // Cash payouts: prefer the WPO code already attached to the
            // request (issued at submission time). Fall back to the
            // payoutProof field so an operator can manually type the code
            // the user presented. Always normalise to upper-case so the
            // server-side equality check is unambiguous.
            const cashCode = isCashItem
              ? (itemForId?.payoutDetails?.payoutCode || payoutProof.trim())
                  .toUpperCase()
              : undefined;
            const { data: approveData, error: approveErr } = await supabase.functions.invoke('approve-withdrawal', {
              body: {
                withdrawal_id: id,
                reference: payoutProof.trim().toUpperCase(),
                payment_method: paymentMethodLabel,
                ...(isCashItem ? { payout_code: cashCode } : {}),
              },
            });
            if (approveErr || approveData?.error) {
              // Server returns a friendly `message` alongside `error` for
              // WPO mismatches/expirations — surface it verbatim instead
              // of the opaque error code.
              const friendly = approveData?.message as string | undefined;
              const realMsg = friendly
                || await extractFromErrorObject(approveErr || new Error(approveData?.error || 'unknown'), approveData?.error || 'unknown error');
              console.error(`[ApprovalQueue] approve-withdrawal failed for ${id}:`, realMsg);
              failedApprovals.push(id);
              toast.warning(`Failed to approve ${id.slice(0, 8)}: ${realMsg}`);
            } else {
              approvalResults.push(id);
            }
          }

          if (failedApprovals.length > 0 && approvalResults.length === 0) {
            throw new Error(`Approval blocked for ${failedApprovals.length} item(s). Check the warning above for the exact ledger/funds reason.`);
          }

          // Handle cash payout codes for cash withdrawals
          // Skip any that already have a code (now generated at REQUEST time
          // by submit_withdrawal_request). Only legacy rows without a code
          // need a fresh one at approval time.
          const cashItems = items.filter(
            i => approvalResults.includes(i.id)
              && i.payoutDetails?.method === 'cash'
              && !i.payoutDetails?.payoutCode,
          );
          if (cashItems.length > 0) {
            for (const ci of cashItems) {
              const code = 'WPO-' + Math.random().toString(36).substring(2, 7).toUpperCase();
              const qrData = JSON.stringify({ code, amount: ci.amount, userId: ci.userId, withdrawalId: ci.id });
              await supabase.from('payout_codes').insert({
                withdrawal_request_id: ci.id,
                user_id: ci.userId!,
                code,
                qr_data: qrData,
                amount: ci.amount,
              });
              await supabase.from('withdrawal_requests')
                .update({ payout_code: code })
                .eq('id', ci.id);
            }
          }

          // Override ids with only successful approvals
          ids.length = 0;
          ids.push(...approvalResults);
        }
      }

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: `bulk_${bulkAction}_${activeQueue}`,
        metadata: { ids, reason: reason || undefined, payout_proof: payoutProof || undefined, count: ids.length },
      });

      const actionLabel = bulkAction === 'approve' ? 'Approved'
        : bulkAction === 'reject' ? 'Rejected'
        : bulkAction === 'freeze' ? 'Froze'
        : 'Unfroze';
      if (ids.length > 0) {
        toast.success(`${actionLabel} ${ids.length} item(s)`);
      }

      const cacheKey = `approval-queue-${activeQueue}`;
      if (bulkAction === 'freeze' || bulkAction === 'unfreeze') {
        // Frozen/unfrozen items keep their status — they stay in the queue,
        // just re-flagged, unlike approve/reject which remove them.
        const nowFrozen = bulkAction === 'freeze';
        queryClient.setQueryData<QueueItem[]>([cacheKey], (old) =>
          (old || []).map(item => ids.includes(item.id)
            ? { ...item, rawData: { ...item.rawData, frozen: nowFrozen, frozen_reason: nowFrozen ? (reason.trim() || null) : null } }
            : item)
        );
      } else {
        queryClient.setQueryData<QueueItem[]>([cacheKey], (old) =>
          (old || []).filter(item => !ids.includes(item.id))
        );
      }

      setSelected(new Set());
      setBulkAction(null);
      setReason('');
      setPayoutProof('');
      queryClient.invalidateQueries({ queryKey: [cacheKey] });
      queryClient.invalidateQueries({ queryKey: ['financial-ops-pulse'] });
    } catch (err: any) {
      toast.error(err.message || 'Action failed');
      // Invalidate on error to refresh stale items
      const cacheKey = `approval-queue-${activeQueue}`;
      queryClient.invalidateQueries({ queryKey: [cacheKey] });
    } finally {
      setProcessing(false);
    }
  }, [bulkAction, selected, activeQueue, user, reason, payoutProof, categoryFilter, queryClient, items]);

  const urgencyBg = { green: 'border-l-emerald-500', amber: 'border-l-amber-500', red: 'border-l-destructive' };
  const queueIcon: Record<QueueType, typeof Banknote> = { wallet_withdrawals: Banknote, wallet_ops: Wallet };

  const getItemDisplayLabel = (item: QueueItem) => {
    if (item.rawData?.operation_type === 'portfolio_topup') return '💰 Portfolio Deposit';
    // Show portfolio reference for ROI payout items
    if (item.type === 'wallet_ops' && item.rawData?.category === 'roi_payout') {
      const sourceId = item.rawData?.source_id;
      const meta = (item.rawData?.metadata || {}) as Record<string, any>;
      const portfolioRef = meta.portfolio_code || (sourceId ? sourceId.slice(0, 8) : null);
      if (portfolioRef) {
        return `ROI Payout · Portfolio: ${portfolioRef}`;
      }
      return 'ROI Payout';
    }
    return item.description;
  };

  const selectedItems = items.filter(i => selected.has(i.id));
  const anySelectedFrozen = activeQueue === 'wallet_withdrawals' && selectedItems.some(i => i.rawData?.frozen);
  const anySelectedUnfrozen = activeQueue === 'wallet_withdrawals' && selectedItems.some(i => !i.rawData?.frozen);

  return (
    <>
      <Card>
        <CardHeader className="pb-2 px-3 sm:px-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 justify-between">
            <CardTitle className="text-sm sm:text-base flex items-center gap-2">
              <Clock className="h-4 w-4 text-primary" /> Approval Queue
            </CardTitle>
            <div className="flex items-center gap-2">
              {selected.size > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" variant="default" className="h-7 text-[11px] sm:text-xs px-2 sm:px-3" onClick={() => setBulkAction('approve')}>
                    <CheckCircle2 className="h-3 w-3 mr-0.5" /> Approve ({selected.size})
                  </Button>
                  <Button size="sm" variant="destructive" className="h-7 text-[11px] sm:text-xs px-2 sm:px-3" onClick={() => setBulkAction('reject')}>
                    <XCircle className="h-3 w-3 mr-0.5" /> Reject ({selected.size})
                  </Button>
                  {activeQueue === 'wallet_withdrawals' && anySelectedUnfrozen && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px] sm:text-xs px-2 sm:px-3 border-sky-500/40 text-sky-700 hover:bg-sky-500/10" onClick={() => setBulkAction('freeze')}>
                      <Snowflake className="h-3 w-3 mr-0.5" /> Freeze ({selected.size})
                    </Button>
                  )}
                  {activeQueue === 'wallet_withdrawals' && anySelectedFrozen && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px] sm:text-xs px-2 sm:px-3 border-emerald-500/40 text-emerald-700 hover:bg-emerald-500/10" onClick={() => setBulkAction('unfreeze')}>
                      <Unlock className="h-3 w-3 mr-0.5" /> Unfreeze ({selectedItems.filter(i => i.rawData?.frozen).length})
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 sm:space-y-3 px-3 sm:px-6">
          <div className="overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 scrollbar-none">
            <Tabs value={activeQueue} onValueChange={(v) => { setActiveQueue(v as QueueType); setSelected(new Set()); setCategoryFilter('all'); }}>
              <TabsList className="h-8 w-max sm:w-auto">
                <TabsTrigger value="wallet_withdrawals" className="text-[10px] sm:text-xs gap-1 h-7 px-2 sm:px-3">
                  <Banknote className="h-3 w-3" /> Cash Out
                  {walletWithdrawals.length > 0 && <Badge variant="destructive" className="h-4 px-1 text-[10px]">{walletWithdrawals.length}</Badge>}
                </TabsTrigger>
                <TabsTrigger value="wallet_ops" className="text-[10px] sm:text-xs gap-1 h-7 px-2 sm:px-3">
                  <Wallet className="h-3 w-3" /> Wallet Ops
                  {walletOps.length > 0 && <Badge variant="outline" className="h-4 px-1 text-[10px]">{walletOps.length}</Badge>}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          {activeQueue === 'wallet_withdrawals' && categoryCounts.size > 0 && (
            <div className="overflow-x-auto -mx-3 px-3 sm:mx-0 sm:px-0 scrollbar-none">
              <div className="flex items-center gap-1.5 w-max sm:w-auto">
                <Button
                  size="sm"
                  variant={categoryFilter === 'all' ? 'default' : 'outline'}
                  className="h-7 text-[10px] sm:text-xs px-2 sm:px-3 shrink-0"
                  onClick={() => setCategoryFilter('all')}
                >
                  All ({walletWithdrawals.length})
                </Button>
                {Array.from(categoryCounts.entries()).map(([cat, count]) => (
                  <Button
                    key={cat}
                    size="sm"
                    variant={categoryFilter === cat ? 'default' : 'outline'}
                    className="h-7 text-[10px] sm:text-xs px-2 sm:px-3 shrink-0"
                    onClick={() => setCategoryFilter(cat)}
                  >
                    {WITHDRAWAL_CATEGORY_LABELS[cat] || cat} ({count})
                  </Button>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search name, phone…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="pl-9 h-8 text-xs"
              />
            </div>
            <Button
              variant={sortNewest ? 'default' : 'outline'}
              size="sm"
              className="h-8 text-[10px] sm:text-xs gap-1 px-2 sm:px-3 shrink-0"
              onClick={() => setSortNewest(!sortNewest)}
            >
              <ArrowUpDown className="h-3 w-3" />
              {sortNewest ? 'Newest' : 'Oldest'}
            </Button>
          </div>

          <ScrollArea className="max-h-[70vh] sm:max-h-[600px]">
            {isLoading ? (
              <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
            ) : items.length === 0 ? (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {search ? 'No matching items' : 'Queue is clear 🎉'}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center gap-2 px-2 pb-1">
                  <Checkbox checked={selected.size === items.length && items.length > 0} onCheckedChange={toggleAll} />
                  <span className="text-[11px] text-muted-foreground">
                    {selected.size > 0 ? `${selected.size} selected` : `${items.length} pending`}
                  </span>
                </div>
                {/* Render cash groups with pickup codes */}
                {Array.from(groupedByCode.groups.entries()).map(([code, groupItems]) => {
                  const groupTotal = groupItems.reduce((s, i) => s + i.amount, 0);
                  const groupSelectedCount = groupItems.filter(i => selected.has(i.id)).length;
                  const allSelected = groupItems.length > 0 && groupItems.every(i => selected.has(i.id));
                  return (
                    <div key={code} className="rounded-xl border-2 border-amber-500/50 overflow-hidden bg-gradient-to-b from-amber-500/[0.07] to-card">
                      {/* Group header: pickup code banner */}
                      <div className="px-3 py-2 bg-amber-500/15 border-b border-amber-500/30 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="p-1 rounded-md bg-amber-500/25">
                            <Banknote className="h-3.5 w-3.5 text-amber-700" />
                          </div>
                          <div className="flex flex-col min-w-0">
                            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-800">Cash Pickup Group</span>
                            <span className="text-xs font-mono font-black text-amber-900 tracking-widest truncate">{code}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Badge variant="secondary" className="h-5 px-1.5 text-[10px] bg-amber-500/20 text-amber-900 border-amber-500/30">
                            {groupItems.length} req · {formatUGX(groupTotal)}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            className={`h-7 text-[10px] px-2 gap-1 border-amber-500/40 ${copiedCode === code ? 'bg-emerald-500/15 text-emerald-700 border-emerald-500/40' : 'text-amber-800 hover:bg-amber-500/20'}`}
                            onClick={() => handleCopyCode(code)}
                          >
                            {copiedCode === code ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                            {copiedCode === code ? 'Copied' : 'Copy'}
                          </Button>
                          <Checkbox
                            checked={allSelected}
                            onCheckedChange={() => {
                              if (allSelected) {
                                groupItems.forEach(i => { if (selected.has(i.id)) toggleSelect(i.id); });
                              } else {
                                groupItems.forEach(i => { if (!selected.has(i.id)) toggleSelect(i.id); });
                              }
                            }}
                            className="shrink-0"
                          />
                        </div>
                      </div>
                      {/* Items in this group */}
                      <div className="p-2 space-y-2">
                        {groupItems.map(item => renderItemCard(item))}
                      </div>
                    </div>
                  );
                })}

                {/* Render non-grouped items flat */}
                {groupedByCode.nonGrouped.map(item => renderItemCard(item))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>

      {/* Bulk Action Dialog */}
      <Dialog open={!!bulkAction} onOpenChange={() => { setBulkAction(null); setReason(''); }}>
        <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm sm:text-base">
              {bulkAction === 'approve' ? '✅ Approve'
                : bulkAction === 'reject' ? '❌ Reject'
                : bulkAction === 'freeze' ? '❄️ Freeze'
                : '🔓 Unfreeze'} {selected.size} item(s)
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-xs sm:text-sm text-muted-foreground">
              Total: <strong>{formatUGX(items.filter(i => selected.has(i.id)).reduce((s, i) => s + i.amount, 0))}</strong>
            </p>
            {bulkAction === 'reject' && (
              <Textarea
                placeholder="Reason for rejection (min 10 characters)…"
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="text-sm min-h-[80px]"
              />
            )}
            {bulkAction === 'freeze' && (
              <div className="space-y-2">
                <div className="p-2.5 rounded-lg bg-sky-500/10 border border-sky-500/30 text-xs text-sky-800">
                  These withdrawals stay in the queue but are blocked from approval — by the operator and by any cashout agent who has already claimed a payout — until unfrozen.
                </div>
                <Textarea
                  placeholder="Reason for freezing (optional, visible to other operators)…"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  className="text-sm min-h-[60px]"
                />
              </div>
            )}
            {bulkAction === 'unfreeze' && (
              <p className="text-xs sm:text-sm text-muted-foreground">
                These withdrawals become approvable again, including by any cashout agent who already claimed the payout.
              </p>
            )}
            {bulkAction === 'approve' && activeQueue === 'wallet_withdrawals' && (
              <div className="space-y-3">
                {items.filter(i => selected.has(i.id)).map(item => (
                  <div key={item.id} className="p-3 rounded-lg border-2 border-primary/20 bg-primary/5 space-y-1">
                    <p className="text-sm font-bold">{item.userName} — {formatUGX(item.amount)}</p>
                    {item.payoutDetails?.method === 'mobile_money' && (
                      <div className="text-xs space-y-0.5">
                        <p className="font-medium">📱 {item.payoutDetails.provider}: {item.payoutDetails.number}</p>
                        {item.payoutDetails.name && <p className="text-muted-foreground">Registered name: {item.payoutDetails.name}</p>}
                      </div>
                    )}
                    {item.payoutDetails?.method === 'bank_transfer' && (
                      <div className="text-xs space-y-0.5">
                        <p className="font-medium">🏦 {item.payoutDetails.bankName}</p>
                        <p>Account: <span className="font-mono font-bold">{item.payoutDetails.bankAccountNumber}</span></p>
                        {item.payoutDetails.bankAccountName && <p>Name: {item.payoutDetails.bankAccountName}</p>}
                      </div>
                    )}
                    {item.payoutDetails?.method === 'cash' && (
                      <p className="text-xs font-medium">
                        💵 Cash payout — pickup code:{' '}
                        <span className="font-mono font-bold text-amber-700">
                          {item.payoutDetails.payoutCode || '— (will be generated)'}
                        </span>
                      </p>
                    )}
                  </div>
                ))}

                <div className="p-3 rounded-lg bg-amber-500/10 border-2 border-amber-500/40">
                  <div className="flex items-center gap-2 mb-2">
                    <Banknote className="h-5 w-5 text-amber-600 shrink-0" />
                    <p className="text-sm text-amber-700 font-bold">
                      ⚠️ Enter Proof of Payout
                    </p>
                  </div>
                  <label className="text-sm font-bold text-foreground block mb-1">
                    {proofConfig?.label || 'Payout Reference'}
                  </label>
                  <Input
                    placeholder={proofConfig?.placeholder || 'Enter payout reference…'}
                    value={payoutProof}
                    onChange={e => setPayoutProof(e.target.value)}
                    className="text-base h-12 font-mono tracking-wider border-2 border-amber-500/30 bg-background"
                    autoFocus
                  />
                  {proofConfig?.type === 'momo_tid' && (
                    <p className="text-xs text-muted-foreground mt-1">Enter the MTN/Airtel Transaction ID from the confirmation SMS</p>
                  )}
                  {proofConfig?.type === 'bank_reference' && (
                    <p className="text-xs text-muted-foreground mt-1">Enter the bank transfer reference number</p>
                  )}
                  {proofConfig?.type === 'payment_voucher' && (
                    <p className="text-xs text-muted-foreground mt-1">Enter the physical payment voucher # — a Payout Code (QR) will be generated for the user</p>
                  )}
                </div>
              </div>
            )}
            {cashCodeMissingBlocked && (
              <div className="p-3 rounded-lg bg-destructive/10 border-2 border-destructive/40 space-y-1">
                <p className="text-sm font-bold text-destructive">⛔ Missing WPO pickup code</p>
                <p className="text-xs text-muted-foreground">
                  {selectedCashMissingCode.length} selected cash payout{selectedCashMissingCode.length !== 1 ? 's have' : ' has'} no WPO-XXXXX pickup code on file and cannot be approved. Reject and ask the user to resubmit so a fresh code is issued.
                </p>
              </div>
            )}
            {bulkAction === 'approve' && activeQueue !== 'wallet_withdrawals' && (
              <Textarea
                placeholder="Optional note…"
                value={reason}
                onChange={e => setReason(e.target.value)}
                className="text-sm min-h-[60px]"
              />
            )}
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button variant="outline" size="sm" onClick={() => { setBulkAction(null); setPayoutProof(''); }} className="w-full sm:w-auto">Cancel</Button>
            <Button
              size="sm"
              variant={bulkAction === 'approve' ? 'default' : bulkAction === 'reject' ? 'destructive' : 'outline'}
              onClick={handleBulkAction}
              disabled={processing || (bulkAction === 'reject' && reason.length < 10) || approveBlocked}
              className="w-full sm:w-auto"
            >
              {processing && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Confirm {bulkAction === 'approve' ? 'Approval'
                : bulkAction === 'reject' ? 'Rejection'
                : bulkAction === 'freeze' ? 'Freeze'
                : 'Unfreeze'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Detail Drill-Down Sheet */}
      <RequestDetailSheet
        open={!!inspectItem}
        onOpenChange={(open) => !open && setInspectItem(null)}
        userId={inspectItem?.userId || null}
        requestType={inspectItem?.type || 'wallet_withdrawals'}
        requestData={inspectItem?.rawData}
      />
    </>
  );
}
