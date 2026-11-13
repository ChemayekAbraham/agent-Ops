import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ArrowDownToLine, AlertCircle, Smartphone, Landmark, Banknote, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { fetchAgentPayoutRoutes } from '@/lib/agentPartnerPortfolios';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { humanizeWithdrawalError } from '@/lib/withdrawalErrorText';

type PayoutMode = 'mobile_money' | 'bank_transfer' | 'cash';

/** Show the destination phone / account number in full for confirmation. */
function maskDestination(text: string): string {
  return text || '—';
}

/**
 * Deterministic, name-based UUID (v5-style) derived from the CONTENT of the
 * request, bucketed to a 10-minute window. A retry of the same submission
 * (reload, reopened dialog, flaky network) reproduces the same key and
 * collides with itself; a genuinely new request later still gets through.
 */
async function computeProxyWithdrawalKey(input: {
  agentId: string;
  funderId: string;
  amount: number;
  routeKey: string;
  reason: string;
}): Promise<string> {
  const bucket = Math.floor(Date.now() / (10 * 60 * 1000));
  const canonical = [
    input.agentId, input.funderId, input.amount,
    input.routeKey, input.reason.trim(), bucket,
  ].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

interface PayoutRoute {
  key: string;
  source: 'saved' | 'portfolio';
  label: string;
  sublabel: string;
  is_default: boolean;
  payout_mode: PayoutMode;
  momo_provider: 'MTN' | 'Airtel' | null;
  momo_number: string | null;
  momo_name: string | null;
  bank_name: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  portfolio_id?: string;
  portfolio_code?: string | null;
}

interface ExtraDest {
  id: string;
  portfolio_id: string;
  payout_method: 'mobile_money' | 'bank_transfer';
  mobile_network: string | null;
  mobile_money_number: string | null;
  recipient_name: string;
  bank_name: string | null;
  account_number: string | null;
}

interface AgentProxyWithdrawalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  funderId: string;
  funderName: string;
  funderPhone: string;
  walletBalance: number;
  onSuccess?: () => void;
  /** Preselect this portfolio's payout route (shows its split numbers). */
  initialPortfolioId?: string;
}

export function AgentProxyWithdrawalDialog({
  open, onOpenChange, funderId, funderName, funderPhone, walletBalance, onSuccess, initialPortfolioId,
}: AgentProxyWithdrawalDialogProps) {
  const { user } = useAuth();
  const [amount, setAmount] = useState<number>(0);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [routes, setRoutes] = useState<PayoutRoute[]>([]);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
  const [extras, setExtras] = useState<Record<string, ExtraDest[]>>({});
  const [splits, setSplits] = useState<Record<string, number>>({});
  useEffect(() => { setSplits({}); }, [selectedRouteKey]);
  const [confirming, setConfirming] = useState(false);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setAmount(0);
    setReason('');
    setRoutes([]);
    setSelectedRouteKey(null);
    setConfirming(false);
    if (!funderId) return;

    let cancelled = false;
    (async () => {
      setLoadingRoutes(true);
      try {
        const routeRows = await fetchAgentPayoutRoutes(funderId);
        if (cancelled) return;

        const list: PayoutRoute[] = [];
        const extraMap: Record<string, ExtraDest[]> = {};
        for (const row of routeRows) {
          if (row.route_key.startsWith('extra:') && row.portfolio_id) {
            (extraMap[row.portfolio_id] ||= []).push({
              id: row.route_key.slice('extra:'.length),
              portfolio_id: row.portfolio_id,
              payout_method: row.payout_mode === 'bank_transfer' ? 'bank_transfer' : 'mobile_money',
              mobile_network: null,
              mobile_money_number: null,
              recipient_name: row.label,
              bank_name: null,
              account_number: null,
            });
            continue;
          }
          const payoutMode: PayoutMode = row.payout_mode === 'bank_transfer' ? 'bank_transfer' : row.payout_mode === 'cash' ? 'cash' : 'mobile_money';
          list.push({
            key: row.route_key,
            source: row.route_key.startsWith('saved:') ? 'saved' : 'portfolio',
            label: row.label,
            sublabel: 'Payout details on file',
            is_default: false,
            payout_mode: payoutMode,
            momo_provider: null,
            momo_number: null,
            momo_name: null,
            bank_name: null,
            bank_account_name: null,
            bank_account_number: null,
            portfolio_id: row.portfolio_id || undefined,
            portfolio_code: undefined,
          });
        }
        if (cancelled) return;
        setExtras(extraMap);

        setRoutes(list);
        // A portfolio with extra payout numbers must be split, so prefer it
        // over a saved default method (which hides the split boxes).
        const preferred =
          (initialPortfolioId ? list.find(r => r.portfolio_id === initialPortfolioId) : undefined)
          ?? list.find(r => r.source === 'portfolio' && r.portfolio_id && (extraMap[r.portfolio_id]?.length ?? 0) > 0)
          ?? list.find(r => r.is_default) ?? list[0] ?? null;
        setSelectedRouteKey(preferred?.key ?? null);
      } catch (e: any) {
        toast.error('Failed to load saved payment options', { description: e.message });
      } finally {
        if (!cancelled) setLoadingRoutes(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, funderId, initialPortfolioId]);

  const selectedRoute = routes.find(r => r.key === selectedRouteKey) ?? null;
  const routeExtras = selectedRoute?.source === 'portfolio' && selectedRoute.portfolio_id
    ? (extras[selectedRoute.portfolio_id] ?? []) : [];
  const splitMode = routeExtras.length > 0;
  const splitLines = splitMode && selectedRoute ? [
    { key: 'primary', label: selectedRoute.sublabel },
    ...routeExtras.map(e => ({
      key: e.id,
      label: e.recipient_name || 'Extra payout on file',
    })),
  ] : [];
  const usedSplits = splitLines.filter(l => (splits[l.key] || 0) > 0);
  const effectiveAmount = splitMode ? usedSplits.reduce((s, l) => s + (splits[l.key] || 0), 0) : amount;

  const isValid =
    effectiveAmount >= 500 &&
    effectiveAmount <= walletBalance &&
    reason.trim().length >= 10 &&
    !!selectedRoute &&
    (!splitMode || (usedSplits.length > 0 && usedSplits.every(l => splits[l.key] >= 500)));

  const handleSplitSubmit = async () => {
    const { data, error } = await supabase.rpc('submit_proxy_split_withdrawal' as never, {
      p_portfolio_id: selectedRoute!.portfolio_id,
      p_allocations: usedSplits.map(l => ({ destination: l.key, amount: Math.round(splits[l.key]) })),
      p_reason: reason.trim(),
    } as never);
    if (error) throw error;
    const n = ((data as any)?.request_ids ?? []).length;
    toast.success('Withdrawal requests submitted', {
      description: `${formatUGX(effectiveAmount)} for ${funderName} split into ${n} request${n === 1 ? '' : 's'}, pending Financial Ops approval`,
    });
    onOpenChange(false);
    onSuccess?.();
  };

  const handleSubmit = async () => {
    if (!user || !isValid) return;
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setLoading(true);
    try {
      if (splitMode) { await handleSplitSubmit(); return; }
      const route = selectedRoute!;
      const clientRequestId = await computeProxyWithdrawalKey({
        agentId: user.id,
        funderId,
        amount,
        routeKey: route.key,
        reason,
      });
      const routeMeta = route.source === 'portfolio'
        ? ` | Route: portfolio ${route.portfolio_code ?? route.portfolio_id}`
        : ` | Route: saved method "${route.label}"`;
      // CUSTODY-V2: partner is the legal owner of the funds.
      // user_id  = partner (so v_user_wallet_strict auto-deducts partner.withdrawable
      //            and existing approve-withdrawal flow debits the partner's wallet).
      // initiated_by / agent_id = agent (audit trail; trg_force_proxy_finops_visibility
      //            forces auto_dispatched=false so FinOps always sees the row).
      // beneficiary_id = partner (legal owner, matches user_id).
      // No `linked_party` is set — that field is reserved for legacy custody rows
      // and is now blocked at the ledger level by trg_block_proxy_custody_writes.
      const { error } = await supabase.from('withdrawal_requests').insert({
        user_id: funderId,
        agent_id: user.id,
        initiated_by: user.id,
        beneficiary_id: funderId,
        amount,
        status: 'pending' as const,
        reason: `[Proxy initiated by agent ${user.id}] ${reason.trim()}${routeMeta}`,
        proxy_partner_id: funderId,
        client_request_id: clientRequestId,
        auto_dispatched: false,
        // Route reference for the server-side deterministic intent key
        // (trg_set_withdrawal_intent_key). A portfolio route pins the key to that
        // portfolio's current payout cycle, so a re-tap of the SAME cycle is
        // refused forever while next cycle's genuine payout passes through.
        payout_route_ref: route.key,
        payout_method: route.payout_mode || 'mobile_money',
        mobile_money_provider: null,
        mobile_money_number: null,
        mobile_money_name: null,
        bank_name: null,
        bank_account_name: null,
        bank_account_number: null,
      } as any);
      if (error) {
        // 23505 = unique_violation. Either the idempotency key collided
        // (genuine network retry — treat as success) or the dedupe
        // trigger fired because an identical proxy withdrawal is already
        // waiting. Surface a friendly message in the latter case so the
        // agent doesn't keep tapping.
        if ((error as any).code === '23505') {
          const msg = String((error as any).message || '');
          // Same content, same 10-minute window: this is a retry of an
          // already-submitted request. The row IS the claim — nothing
          // financial has happened yet — so treat it as success. Pressing
          // send twice must be harmless, not merely a nicer error.
          const { data: existingSameId } = await supabase.rpc('agent_proxy_withdrawal_id_for_client_request' as never, { p_client_request_id: clientRequestId } as never);
          if (existingSameId) {
            toast.success('Withdrawal request submitted', {
              description: `${formatUGX(amount)} withdrawal for ${funderName} is pending Financial Ops approval`,
            });
            onOpenChange(false);
            onSuccess?.();
            isSubmittingRef.current = false;
            setLoading(false);
            return;
          }
          if (msg.includes('DUPLICATE_WITHDRAWAL_INTENT')) {
            toast.error(
              `This exact payout for ${funderName} (${formatUGX(amount)}) has already been requested for this cycle. ${msg.split('DUPLICATE_WITHDRAWAL_INTENT:')[1]?.trim() ?? ''}`,
              { duration: 12000 },
            );
            isSubmittingRef.current = false;
            setLoading(false);
            return;
          }
          if (msg.includes('withdrawal_requests_intent_key_uq')) {
            toast.error(
              `This exact payout for ${funderName} (${formatUGX(amount)}) is already in the system for this cycle. Open the partner's payout history before trying again.`,
              { duration: 12000 },
            );
            isSubmittingRef.current = false;
            setLoading(false);
            return;
          }
          if (msg.includes('DUPLICATE_PENDING_WITHDRAWAL')) {
            toast.error(
              `A withdrawal of ${formatUGX(amount)} for ${funderName} was already submitted recently. Wait about an hour, or check whether it's already pending, before submitting the same amount again.`,
              { duration: 8000 },
            );
            isSubmittingRef.current = false;
            setLoading(false);
            return;
          }
          // Idempotency-key collision: original insert succeeded.
        } else {
          throw error;
        }
      }

      // Get the newly created withdrawal request ID for audit
      const { data: newRowId } = await supabase.rpc('agent_proxy_withdrawal_id_for_client_request' as never, { p_client_request_id: clientRequestId } as never);

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'proxy_withdrawal_request',
        table_name: 'withdrawal_requests',
        record_id: (newRowId as string | null) || funderId,
        metadata: {
          funder_id: funderId,
          funder_name: funderName,
          amount,
          reason: reason.trim(),
          payout_route_source: route.source,
          payout_route_key: route.key,
          portfolio_id: route.portfolio_id ?? null,
          payout_method: route.payout_mode,
        },
      } as any);

      toast.success('Withdrawal request submitted', {
        description: `${formatUGX(amount)} withdrawal for ${funderName} is pending Financial Ops approval`,
      });
      onOpenChange(false);
      onSuccess?.();
    } catch (err: any) {
      toast.error('Failed to submit', {
        description: humanizeWithdrawalError(err?.message, funderName),
        duration: 8000,
      });
    } finally {
      setLoading(false);
      isSubmittingRef.current = false;
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ArrowDownToLine className="h-5 w-5 text-primary" />
            Withdraw for {funderName}
          </DialogTitle>
        </DialogHeader>

        {confirming && selectedRoute && (
          <div className="space-y-4 py-2 animate-scale-in">
            <div className="text-center space-y-1">
              <h3 className="text-base font-bold">Confirm this withdrawal</h3>
              <p className="text-xs text-muted-foreground">Check the amount and the recipient before sending.</p>
            </div>

            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-4 space-y-2 text-center">
              <p className="text-2xl font-black text-primary tracking-tight">{formatUGX(effectiveAmount)}</p>
              <p className="text-sm font-semibold">to {funderName}</p>
              {splitMode ? (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  {usedSplits.map(l => (
                    <p key={l.key}>{formatUGX(splits[l.key])} → {maskDestination(l.label)}</p>
                  ))}
                </div>
              ) : (
              <p className="text-xs text-muted-foreground">
                via {selectedRoute.label} · {maskDestination(selectedRoute.sublabel)}
              </p>
              )}
            </div>

            <div className="rounded-lg bg-warning/10 p-2.5 text-[10px] text-warning">
              ⚠️ This moves <strong>{funderName}</strong>'s money. Once sent it goes to Financial Ops for approval.
            </div>

            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setConfirming(false)} disabled={loading}>
                Go back
              </Button>
              <Button className="flex-1" onClick={handleSubmit} disabled={loading}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Confirm &amp; Send
              </Button>
            </div>
          </div>
        )}

        <div className={cn('space-y-3', confirming && 'hidden')}>
          {/* Balance */}
          <div className="rounded-lg bg-muted/50 p-3 text-center">
            <p className="text-xs text-muted-foreground">Available Balance</p>
            <p className="text-lg font-bold">{formatUGX(walletBalance)}</p>
          </div>

          {walletBalance < 500 && (
            <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Insufficient balance for withdrawal
            </div>
          )}

          {/* Saved payout routes */}
          <div>
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">
              Payout Destination
            </Label>
            {loadingRoutes ? (
              <div className="py-4 flex justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>
            ) : routes.length === 0 ? (
              <div className="flex items-start gap-2 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>
                  No payment details on file for {funderName}. Ask Partner Ops to save MoMo or bank details
                  before requesting a withdrawal.
                </span>
              </div>
            ) : (
              <div className="space-y-1.5 mt-1">
                {routes.map(r => {
                  const active = r.key === selectedRouteKey;
                  const Icon = r.payout_mode === 'mobile_money' ? Smartphone : r.payout_mode === 'bank_transfer' ? Landmark : Banknote;
                  return (
                    <button
                      type="button"
                      key={r.key}
                      onClick={() => setSelectedRouteKey(r.key)}
                      className={cn(
                        'w-full flex items-start gap-2 p-2.5 rounded-md border text-left transition-colors',
                        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50',
                      )}
                    >
                      <Icon className="h-4 w-4 mt-0.5 text-primary shrink-0" />
                      <div className="flex-1 min-w-0 text-xs">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-semibold truncate">{r.label}</span>
                          {r.source === 'portfolio' ? (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary flex items-center gap-1">
                              <Wallet className="h-2.5 w-2.5" /> Per-portfolio
                            </span>
                          ) : r.is_default ? (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-success/10 text-success">Default</span>
                          ) : (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">Saved</span>
                          )}
                        </div>
                        <p className="text-muted-foreground truncate">{r.sublabel}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Amount */}
          {splitMode ? (
            <div className="space-y-2">
              <Label className="text-xs">How much goes to each number (UGX) *</Label>
              {splitLines.map(l => (
                <div key={l.key} className="rounded-md border border-border p-2 space-y-1">
                  <p className="text-[11px] text-muted-foreground truncate">{l.label}</p>
                  <Input
                    type="number"
                    placeholder="0"
                    value={splits[l.key] || ''}
                    onChange={e => {
                      const raw = Math.max(0, Number(e.target.value) || 0);
                      setSplits(s => {
                        const others = Object.entries(s)
                          .filter(([k]) => k !== l.key)
                          .reduce((sum, [, v]) => sum + (v || 0), 0);
                        const cap = Math.max(0, walletBalance - others);
                        if (raw > cap) toast.warning(`Only ${formatUGX(cap)} of the Rent profit share is left for this number`);
                        return { ...s, [l.key]: Math.min(raw, cap) };
                      });
                    }}
                    min={0}
                  />
                </div>
              ))}
              <p className="text-[11px] text-muted-foreground">
                Total {formatUGX(effectiveAmount)} of {formatUGX(walletBalance)} Rent profit share · {formatUGX(Math.max(0, walletBalance - effectiveAmount))} left · each number used must get at least UGX 500. One withdraw request is made per number.
              </p>
              {effectiveAmount > walletBalance && (
                <p className="text-[10px] text-destructive">Total exceeds the Rent profit share available</p>
              )}
            </div>
          ) : (
          <div>
            <Label className="text-xs">Amount (UGX) *</Label>
            <Input
              type="number"
              placeholder="e.g. 50000"
              value={amount || ''}
              onChange={e => setAmount(Number(e.target.value))}
              min={500}
              max={walletBalance}
            />
            {amount > walletBalance && (
              <p className="text-[10px] text-destructive mt-1">Exceeds available balance</p>
            )}
          </div>
          )}

          {/* Reason */}
          <div>
            <Label className="text-xs">Reason (min 10 chars) *</Label>
            <Textarea
              placeholder="e.g. Funder requested cash withdrawal for personal needs"
              value={reason}
              onChange={e => setReason(e.target.value)}
              maxLength={500}
              rows={2}
            />
            <p className="text-[10px] text-muted-foreground mt-0.5">{reason.length}/500</p>
          </div>

          <div className="rounded-lg bg-warning/10 p-2.5 text-[10px] text-warning">
            ⚠️ Submitted on behalf of <strong>{funderName}</strong> and fully audited.
            {selectedRoute
              ? <> Financial Ops will pay out to the selected destination above.</>
              : <> Select a payout destination first.</>}
          </div>

          <Button
            className="w-full"
            onClick={() => setConfirming(true)}
            disabled={!isValid || loading || walletBalance < 500}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Request Withdrawal – {formatUGX(effectiveAmount || 0)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
