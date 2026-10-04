/**
 * StaleWithdrawalHoldsPanel — CFO review queue for stale withdrawal holds.
 *
 * A withdrawal request that sits in pending/approved/processing without a
 * matching wallet debit ledger leg keeps holding the customer's balance
 * forever, hiding legitimately credited money. This panel reports every such
 * request and lets the CFO reconcile them ONE AT A TIME:
 *
 *   • Payment really happened  → post the missing wallet debit through the
 *     normal ledger engine and mark the withdrawal completed.
 *   • Payment never happened   → cancel the withdrawal, releasing the hold.
 *
 * The panel never edits a wallet balance and never performs bulk updates.
 * Every decision requires a written reason and is written to the audit trail.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

interface StaleHoldRow {
  withdrawal_id: string;
  hold_user_id: string;
  full_name: string | null;
  phone: string | null;
  amount: number;
  status: string;
  created_at: string;
  age_days: number;
  ledger_debit_exists: boolean;
  wallet_withdrawable: number;
  wallet_pending_holds: number;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  mobile_money_name: string | null;
  payment_reference: string | null;
  mobile_money_reference: string | null;
  is_pre_anchor: boolean;
  anchor_at: string | null;
  severity: string;
  recommendation: string;
}

type Action = 'settle' | 'cancel';

const SEVERITY_STYLES: Record<string, string> = {
  critical: 'bg-destructive/15 text-destructive border-destructive/30',
  high: 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30',
  medium: 'bg-muted text-muted-foreground border-border',
};

export function StaleWithdrawalHoldsPanel() {
  const qc = useQueryClient();
  const [minAge, setMinAge] = useState<string>('14');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<StaleHoldRow | null>(null);
  const [action, setAction] = useState<Action>('cancel');
  const [reason, setReason] = useState('');
  const [paymentRef, setPaymentRef] = useState('');

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['stale-withdrawal-holds', minAge],
    queryFn: async () => {
      const parsed = Number.parseInt(minAge, 10);
      const { data, error } = await supabase.rpc('get_stale_withdrawal_hold_queue', {
        p_min_age_days: Number.isFinite(parsed) ? parsed : null,
      });
      if (error) throw error;
      return (data ?? []) as StaleHoldRow[];
    },
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    const list = data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) =>
      [r.full_name, r.phone, r.mobile_money_number, r.mobile_money_reference, r.payment_reference]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [data, search]);

  const totals = useMemo(() => {
    const list = data ?? [];
    return {
      count: list.length,
      amount: list.reduce((s, r) => s + Number(r.amount || 0), 0),
      preAnchor: list.filter((r) => r.is_pre_anchor).length,
    };
  }, [data]);

  const reconcile = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error('No withdrawal selected');
      const { data, error } = await supabase.rpc('cfo_reconcile_stale_withdrawal', {
        p_withdrawal_id: target.withdrawal_id,
        p_action: action,
        p_reason: reason.trim(),
        p_payment_reference: paymentRef.trim() || null,
      });
      if (error) throw error;
      return data as Record<string, unknown>;
    },
    onSuccess: (result) => {
      const before = Number((result as { withdrawable_before?: number })?.withdrawable_before ?? 0);
      const after = Number((result as { withdrawable_after?: number })?.withdrawable_after ?? 0);
      toast.success(
        action === 'settle' ? 'Missing wallet debit posted' : 'Hold released',
        {
          description: `Available balance ${formatUGX(before)} → ${formatUGX(after)}`,
        },
      );
      setTarget(null);
      setReason('');
      setPaymentRef('');
      qc.invalidateQueries({ queryKey: ['stale-withdrawal-holds'] });
    },
    onError: (e: unknown) => {
      toast.error('Reconciliation failed', {
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    },
  });

  const openReview = (row: StaleHoldRow, preset: Action) => {
    setTarget(row);
    setAction(preset);
    setReason('');
    setPaymentRef(row.payment_reference ?? row.mobile_money_reference ?? '');
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <ShieldAlert className="h-5 w-5 text-amber-500" />
              Stale Withdrawal Holds
            </CardTitle>
            <CardDescription>
              Withdrawal requests still holding customer balance with no wallet debit in the ledger.
              Review each one individually — settle the missing debit if the payout truly happened,
              otherwise cancel it and release the hold.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            <span className="ml-2">Refresh</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Stale holds</p>
            <p className="text-xl font-bold">{totals.count}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Balance suppressed</p>
            <p className="text-xl font-bold">{formatUGX(totals.amount)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Pre fresh-start</p>
            <p className="text-xl font-bold text-destructive">{totals.preAnchor}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="w-32">
            <Label htmlFor="stale-min-age" className="text-xs">Minimum age (days)</Label>
            <Input
              id="stale-min-age"
              inputMode="numeric"
              value={minAge}
              onChange={(e) => setMinAge(e.target.value.replace(/[^0-9]/g, ''))}
            />
          </div>
          <div className="min-w-[200px] flex-1">
            <Label htmlFor="stale-search" className="text-xs">Search name, phone or reference</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                id="stale-search"
                className="pl-8"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g. 0783817429"
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load the queue'}
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading review queue…
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
            <p className="text-sm">No stale withdrawal holds at this age threshold.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map((row) => (
              <div key={row.withdrawal_id} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{row.full_name || 'Unnamed user'}</p>
                      <Badge variant="outline" className={SEVERITY_STYLES[row.severity] ?? SEVERITY_STYLES.medium}>
                        {row.severity}
                      </Badge>
                      <Badge variant="outline">{row.status}</Badge>
                      {row.is_pre_anchor && (
                        <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
                          pre fresh-start
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{row.phone || 'No phone on profile'}</p>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-1 text-xs sm:grid-cols-4">
                      <span className="text-muted-foreground">
                        Amount <span className="block font-semibold text-foreground">{formatUGX(Number(row.amount))}</span>
                      </span>
                      <span className="text-muted-foreground">
                        Requested{' '}
                        <span className="block font-semibold text-foreground">
                          {new Date(row.created_at).toLocaleDateString()} · {row.age_days}d
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Ledger debit <span className="block font-semibold text-destructive">missing</span>
                      </span>
                      <span className="text-muted-foreground">
                        Wallet available{' '}
                        <span className="block font-semibold text-foreground">
                          {formatUGX(Number(row.wallet_withdrawable || 0))}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Held on wallet{' '}
                        <span className="block font-semibold text-foreground">
                          {formatUGX(Number(row.wallet_pending_holds || 0))}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Mobile money{' '}
                        <span className="block font-semibold text-foreground">
                          {row.mobile_money_number || '—'} {row.mobile_money_provider ? `(${row.mobile_money_provider})` : ''}
                        </span>
                      </span>
                      <span className="text-muted-foreground">
                        Payment ref <span className="block font-semibold text-foreground">{row.payment_reference || '—'}</span>
                      </span>
                      <span className="text-muted-foreground">
                        MoMo ref <span className="block font-semibold text-foreground">{row.mobile_money_reference || '—'}</span>
                      </span>
                    </div>
                    <div className="mt-2 flex items-start gap-2 rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span>{row.recommendation}</span>
                    </div>
                  </div>
                  <CfoApprovalGate>
                    <div className="flex shrink-0 flex-col gap-2">
                      <Button size="sm" variant="outline" onClick={() => openReview(row, 'settle')}>
                        <CheckCircle2 className="mr-2 h-4 w-4" /> Payment happened
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => openReview(row, 'cancel')}>
                        <Ban className="mr-2 h-4 w-4" /> Never paid — release
                      </Button>
                    </div>
                  </CfoApprovalGate>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {action === 'settle' ? 'Post the missing wallet debit' : 'Cancel and release the hold'}
            </DialogTitle>
            <DialogDescription>
              {action === 'settle'
                ? 'Confirm the payout genuinely reached the customer. The missing double-entry is posted through the normal ledger engine and the withdrawal is marked completed. No wallet balance is edited directly.'
                : 'The withdrawal is cancelled and the hold released. The balance becomes visible again because the invalid hold is gone — no credit is created.'}
            </DialogDescription>
          </DialogHeader>

          {target && (
            <div className="space-y-3">
              <div className="rounded-lg border p-3 text-sm">
                <p className="font-semibold">{target.full_name || 'Unnamed user'}</p>
                <p className="text-xs text-muted-foreground">{target.phone || '—'}</p>
                <p className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {formatUGX(Number(target.amount))} · requested {new Date(target.created_at).toLocaleDateString()}
                </p>
              </div>

              {action === 'settle' && (
                <div>
                  <Label htmlFor="stale-ref">Payment reference</Label>
                  <Input
                    id="stale-ref"
                    value={paymentRef}
                    onChange={(e) => setPaymentRef(e.target.value)}
                    placeholder="Mobile money / bank reference"
                  />
                </div>
              )}

              <div>
                <Label htmlFor="stale-reason">Reason (minimum 10 characters)</Label>
                <Textarea
                  id="stale-reason"
                  rows={3}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={
                    action === 'settle'
                      ? 'Confirmed payout on MoMo statement dated …'
                      : 'FinOps confirmed no payout was ever sent for this request …'
                  }
                />
                <p className="mt-1 text-xs text-muted-foreground">{reason.trim().length}/10</p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={reconcile.isPending}>
              Cancel
            </Button>
            <Button
              variant={action === 'settle' ? 'default' : 'destructive'}
              onClick={() => reconcile.mutate()}
              disabled={reconcile.isPending || reason.trim().length < 10}
            >
              {reconcile.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {action === 'settle' ? 'Post debit & complete' : 'Cancel & release hold'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default StaleWithdrawalHoldsPanel;
