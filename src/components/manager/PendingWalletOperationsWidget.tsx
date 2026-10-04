import { useState, useEffect, useCallback } from 'react';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CheckCircle, XCircle, ArrowDownToLine, ArrowUpFromLine, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';

interface PendingOperation {
  id: string;
  user_id: string;
  amount: number;
  direction: string;
  category: string;
  description: string | null;
  source_table: string;
  source_id: string | null;
  created_at: string;
  status: string;
  metadata: any;
  reference_id: string | null;
  linked_party: string | null;
  user_name?: string;
  agent_name?: string;
  portfolio_owner_name?: string;
  portfolio_code?: string;
}

const PAYMENT_METHOD_OPTIONS = [
  { value: 'bank', label: 'Bank Payment', refLabel: 'Bank Reference Number', placeholder: 'e.g. REF20250408001' },
  { value: 'mtn_momo', label: 'MTN MoMo', refLabel: 'Transaction ID (TID)', placeholder: 'e.g. MP39665905645' },
  { value: 'airtel_money', label: 'Airtel Money', refLabel: 'Transaction ID (TID)', placeholder: 'e.g. TID8827364510' },
  { value: 'cash', label: 'Cash Payment', refLabel: 'Receipt Number', placeholder: 'e.g. RCT-00412' },
] as const;

type ApprovePaymentMethod = typeof PAYMENT_METHOD_OPTIONS[number]['value'] | '';

export function PendingWalletOperationsWidget({ requirePaymentRef = true }: { requirePaymentRef?: boolean } = {}) {
  const { user } = useAuth();
  const [operations, setOperations] = useState<PendingOperation[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');
  const [currencyOverrides, setCurrencyOverrides] = useState<Record<string, string>>({});

  // Approval dialog state
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [approveOpId, setApproveOpId] = useState<string | null>(null);
  const [approvePaymentMethod, setApprovePaymentMethod] = useState<ApprovePaymentMethod>('');
  const [approvePaymentRef, setApprovePaymentRef] = useState('');

  const selectedMethodMeta = PAYMENT_METHOD_OPTIONS.find(m => m.value === approvePaymentMethod);
  const canConfirmApproval = requirePaymentRef
    ? (approvePaymentMethod !== '' && approvePaymentRef.trim().length >= 4)
    : approvePaymentMethod !== '';

  const openApproveDialog = (opId: string) => {
    setApproveOpId(opId);
    setApprovePaymentMethod('');
    setApprovePaymentRef('');
    setApproveDialogOpen(true);
  };

  const confirmApproval = async () => {
    if (!approveOpId || !canConfirmApproval) return;
    setApproveDialogOpen(false);
    await handleAction(approveOpId, 'approve', {
      payment_method: approvePaymentMethod,
      payment_reference: approvePaymentRef.trim(),
    });
    setApproveOpId(null);
  };

  const SUPPORTED_CURRENCIES = ['UGX', 'USD', 'KES', 'TZS', 'RWF', 'GBP', 'EUR'];

  const fetchOperations = useCallback(async () => {
    if (!user) return;
    setLoading(true);

    try {
      const { data: result, error } = await (supabase.rpc as any)('get_pending_wallet_ops', {
        p_page: 1,
        p_page_size: 50,
      });

      if (error) {
        console.error('Error fetching pending operations:', error);
        return;
      }

      const parsed = typeof result === 'string' ? JSON.parse(result) : result;
      const ops = (parsed?.data || []) as PendingOperation[];

      if (ops.length > 0) {
        const walletDepositIds = ops.filter(d => d.source_table === 'wallet_deposits' && d.source_id).map(d => d.source_id!);

        // Extract portfolio codes from descriptions like "Portfolio top-up: <label> (WIPxxxxxx)"
        const portfolioCodes = [...new Set(
          ops
            .map(o => {
              const m = (o.description || '').match(/\(([A-Z0-9]+)\)\s*$/i);
              return m ? m[1] : null;
            })
            .filter((c): c is string => !!c)
        )];

        // Fetch portfolio → investor (owner) name map
        let portfolioOwnerMap = new Map<string, string>();
        if (portfolioCodes.length > 0) {
          const { data: portfolios } = await supabase
            .from('investor_portfolios')
            .select('portfolio_code, investor_id')
            .in('portfolio_code', portfolioCodes);
          const ownerIds = [...new Set((portfolios || []).map((p: any) => p.investor_id).filter(Boolean))];
          let ownerNameMap = new Map<string, string>();
          if (ownerIds.length > 0) {
            const { data: ownerProfiles } = await supabase.from('profiles').select('id, full_name').in('id', ownerIds);
            ownerNameMap = new Map((ownerProfiles || []).map((p: any) => [p.id, p.full_name]));
          }
          portfolioOwnerMap = new Map(
            (portfolios || [])
              .map((p: any) => [p.portfolio_code, ownerNameMap.get(p.investor_id) || ''] as [string, string])
              .filter(([, name]) => !!name)
          );
        }

        const enrichWithPortfolio = (op: PendingOperation): PendingOperation => {
          const m = (op.description || '').match(/\(([A-Z0-9]+)\)\s*$/i);
          const code = m ? m[1] : undefined;
          return {
            ...op,
            portfolio_code: code,
            portfolio_owner_name: code ? portfolioOwnerMap.get(code) : undefined,
          };
        };

        if (walletDepositIds.length > 0) {
          const { data: depositsData } = await supabase
            .from('wallet_deposits' as any)
            .select('id, agent_id')
            .in('id', walletDepositIds);

          const agentIds = [...new Set((depositsData || []).map((d: any) => d.agent_id).filter(Boolean))];
          const depositAgentMap = new Map((depositsData || []).map((d: any) => [d.id, d.agent_id]));

          let agentNameMap = new Map<string, string>();
          if (agentIds.length > 0) {
            const { data: agentProfiles } = await supabase.from('profiles').select('id, full_name').in('id', agentIds);
            agentNameMap = new Map(agentProfiles?.map(p => [p.id, p.full_name]) || []);
          }

          setOperations(ops.map(op => {
            const agentId = op.source_id ? depositAgentMap.get(op.source_id) : undefined;
            return enrichWithPortfolio({ ...op, agent_name: agentId ? agentNameMap.get(agentId) : undefined });
          }));
        } else {
          setOperations(ops.map(enrichWithPortfolio));
        }
      } else {
        setOperations([]);
      }
    } catch (e) {
      console.error('Failed to fetch operations:', e);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    fetchOperations();
  }, [fetchOperations]);

  const handleAction = async (opId: string, action: 'approve' | 'reject', paymentDetails?: { payment_method: string; payment_reference: string }) => {
    setProcessing(opId);
    try {
      const { data, error } = await supabase.functions.invoke('approve-wallet-operation', {
        body: {
          operation_id: opId,
          action,
          rejection_reason: action === 'reject' ? rejectionReason : undefined,
          display_currency: action === 'approve' ? (currencyOverrides[opId] || 'UGX') : undefined,
          payment_method: paymentDetails?.payment_method,
          payment_reference: paymentDetails?.payment_reference,
        },
      });

      if (error) {
        const msg = await extractFromErrorObject(error, `Failed to ${action} operation`);
        toast.error(msg);
        await fetchOperations();
        return;
      }

      // Check if this specific operation was actually processed
      const approvedIds: string[] = data?.approved_ids || [];
      const rejectedIds: string[] = data?.rejected_ids || [];
      const failedIds: string[] = data?.failed_ids || [];
      const successIds = [...approvedIds, ...rejectedIds];

      if (successIds.includes(opId)) {
        toast.success(`Operation ${action}d successfully`);
        setOperations(prev => prev.filter(op => op.id !== opId));
      } else if (failedIds.includes(opId)) {
        const failure = (data?.failures || []).find((f: any) => f.id === opId);
        toast.error(failure?.error || `Failed to ${action} operation — please retry`);
      } else {
        toast.error(`Operation was not processed — please retry`);
      }

      setRejectionReason('');
      // Always refetch to stay in sync with DB
      await fetchOperations();
    } catch (e: any) {
      toast.error(e.message || `Failed to ${action} operation`);
      await fetchOperations();
    } finally {
      setProcessing(null);
    }
  };

  // Bulk approve removed — individual payment references required

  const formatUGX = (amount: number) => `UGX ${amount.toLocaleString()}`;
  const formatTime = (dateStr: string) => {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-UG', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getAgeLabel = (dateStr: string) => {
    const mins = Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  };

  const pendingCount = operations.length;
  const totalPendingIn = operations.filter(o => o.direction === 'cash_in').reduce((s, o) => s + o.amount, 0);
  const totalPendingOut = operations.filter(o => o.direction === 'cash_out').reduce((s, o) => s + o.amount, 0);

  if (!loading && pendingCount === 0) {
    return (
      <Card className="border-success/30 bg-success/5">
        <CardContent className="py-6 text-center">
          <CheckCircle className="h-8 w-8 text-success mx-auto mb-2" />
          <p className="text-sm font-semibold text-success">All Caught Up</p>
          <p className="text-xs text-muted-foreground">No pending wallet operations</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Priority Banner */}
      {pendingCount > 0 && (
        <Card className="border-2 border-warning/60 bg-gradient-to-r from-warning/10 via-warning/5 to-background shadow-lg">
          <CardContent className="p-3 sm:p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="p-2.5 rounded-xl bg-warning/20 animate-pulse">
                  <AlertTriangle className="h-5 w-5 text-warning" />
                </div>
                <div>
                  <p className="text-sm font-bold">{pendingCount} Pending Approval{pendingCount > 1 ? 's' : ''}</p>
                  <p className="text-[11px] text-muted-foreground">Wallet deposits & withdrawals awaiting review</p>
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={fetchOperations} className="h-9 w-9 p-0">
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>

            {/* Summary pills */}
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div className="p-3 rounded-xl bg-success/10 border border-success/30">
                <div className="flex items-center gap-1.5 mb-1">
                  <ArrowDownToLine className="h-4 w-4 text-success" />
                  <span className="text-[11px] font-medium text-muted-foreground">Deposits In</span>
                </div>
                <p className="text-base font-black text-success">{formatUGX(totalPendingIn)}</p>
              </div>
              <div className="p-3 rounded-xl bg-destructive/10 border border-destructive/30">
                <div className="flex items-center gap-1.5 mb-1">
                  <ArrowUpFromLine className="h-4 w-4 text-destructive" />
                  <span className="text-[11px] font-medium text-muted-foreground">Withdrawals</span>
                </div>
                <p className="text-base font-black text-destructive">{formatUGX(totalPendingOut)}</p>
              </div>
            </div>

            {/* Bulk approve removed — individual payment references required */}
          </CardContent>
        </Card>
      )}

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Individual Operation Cards — Large, mobile-first */}
      {operations.map(op => {
        const isDeposit = op.direction === 'cash_in';
        const ageLabel = getAgeLabel(op.created_at);

        return (
          <Card
            key={op.id}
            className={`border-2 shadow-md overflow-hidden ${
              isDeposit
                ? 'border-success/40 bg-gradient-to-br from-success/5 to-background'
                : 'border-destructive/40 bg-gradient-to-br from-destructive/5 to-background'
            } ${op.agent_name ? 'ring-2 ring-purple-400/50' : ''}`}
          >
            <CardContent className="p-0">
              {/* Direction Header Strip */}
              <div className={`px-4 py-2 flex items-center justify-between ${
                isDeposit ? 'bg-success/15' : 'bg-destructive/15'
              }`}>
                <div className="flex items-center gap-2">
                  {isDeposit ? (
                    <ArrowDownToLine className="h-4 w-4 text-success" />
                  ) : (
                    <ArrowUpFromLine className="h-4 w-4 text-destructive" />
                  )}
                  <span className={`text-xs font-bold uppercase tracking-wider ${
                    isDeposit ? 'text-success' : 'text-destructive'
                  }`}>
                    {isDeposit ? 'Deposit' : 'Withdrawal'}
                  </span>
                </div>
                <span className="text-[10px] font-medium text-muted-foreground">{ageLabel}</span>
              </div>

              <div className="p-4 space-y-3">
                {/* Agent deposit warning */}
                {op.agent_name && (
                  <div className="p-3 rounded-xl bg-purple-500/10 border-2 border-purple-500/30">
                    <p className="text-[10px] font-bold text-purple-600 dark:text-purple-400 uppercase tracking-widest mb-1">
                      ⚠️ Agent Deposit — Verify with Agent
                    </p>
                    <p className="text-sm font-black text-purple-700 dark:text-purple-300">{op.agent_name}</p>
                  </div>
                )}

                {/* Reference / Source */}
                {!op.agent_name && (
                  <div className="p-3 rounded-xl bg-warning/10 border border-warning/30">
                    <p className="text-[9px] font-bold text-warning uppercase tracking-wider mb-1">
                      {op.reference_id ? 'Reference ID' : 'Source'}
                    </p>
                    <p className="font-mono text-lg font-black text-foreground break-all leading-tight">
                      {op.reference_id || op.source_table.replace(/_/g, ' ')}
                    </p>
                  </div>
                )}

                {/* User + Amount — large and clear */}
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold truncate">{op.user_name}</p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {(() => {
                        const desc = op.description || op.category || '';
                        const m = desc.match(/Portfolio top-up:\s*(.+?)\s*\(([^)]+)\)/i);
                        if (m) {
                          const code = m[2];
                          // Prefer the actual portfolio OWNER (not the requester)
                          const ownerName = op.portfolio_owner_name;
                          if (ownerName) {
                            return `Portfolio top-up: ${code} (${ownerName})`;
                          }
                          // Fallback: show code only (don't mislead by showing requester)
                          return `Portfolio top-up: ${code}`;
                        }
                        return desc;
                      })()}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{formatTime(op.created_at)}</p>
                  </div>
                  <div className={`text-right shrink-0 p-3 rounded-xl ${
                    isDeposit ? 'bg-success/10' : 'bg-destructive/10'
                  }`}>
                    <p className="text-[10px] font-medium text-muted-foreground mb-0.5">
                      {isDeposit ? 'Credit' : 'Debit'}
                    </p>
                    <p className={`text-lg font-black tabular-nums ${
                      isDeposit ? 'text-success' : 'text-destructive'
                    }`}>
                      {isDeposit ? '+' : '-'}{formatUGX(op.amount)}
                    </p>
                  </div>
                </div>

                {/* Currency selector for partner investments */}
                {op.category === 'supporter_facilitation_capital' && (
                  <div className="flex items-center gap-2 p-2.5 rounded-xl bg-muted/50 border border-border">
                    <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">Display currency:</span>
                    <Select
                      value={currencyOverrides[op.id] || 'UGX'}
                      onValueChange={(val) => setCurrencyOverrides(prev => ({ ...prev, [op.id]: val }))}
                    >
                      <SelectTrigger className="h-9 w-24 text-xs font-bold">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SUPPORTED_CURRENCIES.map(c => (
                          <SelectItem key={c} value={c}>{c}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {/* Action Buttons — BIG, thumb-friendly */}
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    size="lg"
                    className="h-14 text-sm font-bold gap-2 rounded-xl"
                    onClick={() => openApproveDialog(op.id)}
                    disabled={processing === op.id}
                  >
                    {processing === op.id ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      <CheckCircle className="h-5 w-5" />
                    )}
                    Approve
                  </Button>

                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        size="lg"
                        variant="destructive"
                        className="h-14 text-sm font-bold gap-2 rounded-xl"
                        disabled={processing === op.id}
                      >
                        <XCircle className="h-5 w-5" />
                        Reject
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Reject Operation?</AlertDialogTitle>
                        <AlertDialogDescription>
                          {formatUGX(op.amount)} {isDeposit ? 'deposit' : 'withdrawal'} for {op.user_name}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <Input
                        placeholder="Reason for rejection (required)…"
                        value={rejectionReason}
                        onChange={e => setRejectionReason(e.target.value)}
                        className="h-12 text-base"
                      />
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => handleAction(op.id, 'reject')}
                          disabled={!rejectionReason.trim()}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Reject
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {/* Payment Method Approval Dialog */}
      <AlertDialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <AlertDialogContent className="max-w-[calc(100vw-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Approval</AlertDialogTitle>
            <AlertDialogDescription>
              Select the payment method used and provide the reference details.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Payment Method</label>
              <Select value={approvePaymentMethod} onValueChange={(v) => setApprovePaymentMethod(v as ApprovePaymentMethod)}>
                <SelectTrigger className="h-12 text-base">
                  <SelectValue placeholder="Select payment method…" />
                </SelectTrigger>
                <SelectContent>
                  {PAYMENT_METHOD_OPTIONS.map(m => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {requirePaymentRef && approvePaymentMethod && selectedMethodMeta && (
              <div className="space-y-2">
                <label className="text-sm font-medium">{selectedMethodMeta.refLabel}</label>
                <Input
                  placeholder={selectedMethodMeta.placeholder}
                  value={approvePaymentRef}
                  onChange={e => setApprovePaymentRef(e.target.value)}
                  className="h-12 text-base font-mono"
                />
                {approvePaymentRef.length > 0 && approvePaymentRef.trim().length < 4 && (
                  <p className="text-xs text-destructive">Minimum 4 characters required</p>
                )}
              </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmApproval} disabled={!canConfirmApproval}>
              Approve
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
