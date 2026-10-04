import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Loader2, ArrowDownToLine, AlertCircle, Smartphone, Landmark, Banknote, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
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

interface AgentProxyWithdrawalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  funderId: string;
  funderName: string;
  funderPhone: string;
  walletBalance: number;
  onSuccess?: () => void;
}

export function AgentProxyWithdrawalDialog({
  open, onOpenChange, funderId, funderName, funderPhone, walletBalance, onSuccess,
}: AgentProxyWithdrawalDialogProps) {
  const { user } = useAuth();
  const [amount, setAmount] = useState<number>(0);
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingRoutes, setLoadingRoutes] = useState(false);
  const [routes, setRoutes] = useState<PayoutRoute[]>([]);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string | null>(null);
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
        const [savedRes, portfoliosRes] = await Promise.all([
          supabase
            .from('saved_payout_methods' as never)
            .select('*')
            .eq('user_id', funderId)
            .order('is_default', { ascending: false })
            .order('created_at', { ascending: false }),
          supabase
            .from('investor_portfolios')
            .select('id, portfolio_code, account_name, status, payment_method, mobile_network, mobile_money_number, bank_name, bank_account_name, account_number')
            .eq('investor_id', funderId)
            .in('status', ['active', 'pending', 'pending_approval', 'matured'])
            .not('payment_method', 'is', null)
            .order('created_at', { ascending: false })
            .limit(50),
        ]);
        if (cancelled) return;

        const list: PayoutRoute[] = [];
        for (const s of ((savedRes.data ?? []) as any[])) {
          list.push({
            key: `saved:${s.id}`,
            source: 'saved',
            label: s.nickname || (s.payout_mode === 'mobile_money' ? `${s.momo_provider} MoMo` : s.payout_mode === 'bank_transfer' ? (s.bank_name || 'Bank') : 'Cash'),
            sublabel: s.payout_mode === 'mobile_money'
              ? `${s.momo_number ?? '—'} · ${s.momo_name ?? ''}`.trim()
              : s.payout_mode === 'bank_transfer'
                ? `${s.bank_account_number ?? '—'} · ${s.bank_account_name ?? ''}`.trim()
                : 'Cash pickup',
            is_default: !!s.is_default,
            payout_mode: s.payout_mode,
            momo_provider: s.momo_provider,
            momo_number: s.momo_number,
            momo_name: s.momo_name,
            bank_name: s.bank_name,
            bank_account_name: s.bank_account_name,
            bank_account_number: s.bank_account_number,
          });
        }
        for (const p of ((portfoliosRes.data ?? []) as any[])) {
          list.push({
            key: `portfolio:${p.id}`,
            source: 'portfolio',
            label: p.portfolio_code || p.account_name || `Portfolio ${p.id.slice(0, 6)}`,
            sublabel: p.payment_method === 'mobile_money'
              ? `${p.mobile_network ?? 'MoMo'} · ${p.mobile_money_number ?? '—'}`
              : p.payment_method === 'bank_transfer'
                ? `${p.bank_name ?? 'Bank'} · ${p.account_number ?? '—'}`
                : 'Cash pickup',
            is_default: false,
            payout_mode: p.payment_method,
            momo_provider: p.mobile_network,
            momo_number: p.mobile_money_number,
            momo_name: p.account_name,
            bank_name: p.bank_name,
            bank_account_name: p.bank_account_name,
            bank_account_number: p.account_number,
            portfolio_id: p.id,
            portfolio_code: p.portfolio_code,
          });
        }

        setRoutes(list);
        const preferred = list.find(r => r.is_default) ?? list[0] ?? null;
        setSelectedRouteKey(preferred?.key ?? null);
      } catch (e: any) {
        toast.error('Failed to load saved payment options', { description: e.message });
      } finally {
        if (!cancelled) setLoadingRoutes(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, funderId]);

  const selectedRoute = routes.find(r => r.key === selectedRouteKey) ?? null;

  const isValid =
    amount >= 500 &&
    amount <= walletBalance &&
    reason.trim().length >= 10 &&
    !!selectedRoute;

  const handleSubmit = async () => {
    if (!user || !isValid) return;
    if (isSubmittingRef.current) return;
    isSubmittingRef.current = true;
    setLoading(true);
    try {
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
        payout_route_ref: route.source === 'portfolio'
          ? `portfolio:${route.portfolio_id}`
          : `saved:${route.key.slice('saved:'.length)}`,
        // Pre-populate the payout route the partner has on file so Financial Ops
        // does not need to re-key MoMo / bank details. This pulls from the
        // selected saved method or per-portfolio route.
        payout_method: route.payout_mode,
        mobile_money_provider: route.payout_mode === 'mobile_money' ? route.momo_provider : null,
        mobile_money_number: route.payout_mode === 'mobile_money' ? route.momo_number : null,
        mobile_money_name: route.payout_mode === 'mobile_money' ? route.momo_name : null,
        bank_name: route.payout_mode === 'bank_transfer' ? route.bank_name : null,
        bank_account_name: route.payout_mode === 'bank_transfer' ? route.bank_account_name : null,
        bank_account_number: route.payout_mode === 'bank_transfer' ? route.bank_account_number : null,
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
          const { data: existingSame } = await supabase
            .from('withdrawal_requests')
            .select('id')
            .eq('user_id', funderId)
            .eq('client_request_id', clientRequestId)
            .maybeSingle();
          if (existingSame?.id) {
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
      const { data: newRow } = await supabase
        .from('withdrawal_requests')
        .select('id')
        .eq('user_id', funderId)
        .eq('initiated_by', user.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: false })
        .limit(1)
        .single();

      // Audit log
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'proxy_withdrawal_request',
        table_name: 'withdrawal_requests',
        record_id: newRow?.id || funderId,
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
              <p className="text-2xl font-black text-primary tracking-tight">{formatUGX(amount)}</p>
              <p className="text-sm font-semibold">to {funderName}</p>
              <p className="text-xs text-muted-foreground">
                via {selectedRoute.label} · {maskDestination(selectedRoute.sublabel)}
              </p>
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
            Request Withdrawal – {formatUGX(amount || 0)}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
