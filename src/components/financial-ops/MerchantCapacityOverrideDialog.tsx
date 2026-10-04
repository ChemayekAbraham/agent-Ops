import { useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { ShieldAlert, Gauge, Undo2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useMerchantCapacityOverrides,
  useSetMerchantCapacityOverride,
  useRevokeMerchantCapacityOverride,
} from '@/hooks/useMerchantCapacityOverrides';

/**
 * Temporarily adjust one merchant desk's qualified daily capacity.
 *
 * Recommendation only: this changes the figure Financial Ops plans against and
 * how an entered distribution pot is split. It moves no money, touches no
 * wallet bucket and posts no ledger entry. A reason of at least 10 characters is
 * mandatory and every set/revoke is stored in the audit trail with the actor and
 * timestamp.
 */
export function MerchantCapacityOverrideDialog({
  open,
  onOpenChange,
  agentId,
  agentName,
  earnedCapacity,
  canEdit,
  readOnlyReason,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agentId: string | null;
  agentName: string;
  earnedCapacity: number;
  canEdit: boolean;
  readOnlyReason?: string;
}) {
  const { data: overrides, isLoading } = useMerchantCapacityOverrides(200);
  const setOverride = useSetMerchantCapacityOverride();
  const revokeOverride = useRevokeMerchantCapacityOverride();

  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('1');
  const [reason, setReason] = useState('');
  const [revokeReason, setRevokeReason] = useState('');

  const history = useMemo(
    () => (overrides ?? []).filter((o) => o.agentId === agentId),
    [overrides, agentId],
  );
  const inForce = history.find((o) => o.isInForce) ?? null;

  const parsedAmount = Number((amount || '').replace(/[^\d.]/g, ''));
  const parsedDays = Number(days || '0');
  const reasonOk = reason.trim().length >= 10;
  const canSubmit =
    canEdit &&
    !!agentId &&
    Number.isFinite(parsedAmount) &&
    parsedAmount >= 0 &&
    parsedDays >= 1 &&
    parsedDays <= 90 &&
    reasonOk &&
    !setOverride.isPending;

  const reset = () => {
    setAmount('');
    setDays('1');
    setReason('');
    setRevokeReason('');
  };

  const submit = async () => {
    if (!agentId) return;
    try {
      await setOverride.mutateAsync({
        agentId,
        capacity: parsedAmount,
        days: parsedDays,
        reason: reason.trim(),
      });
      toast.success(`Capacity override set at ${formatUGX(parsedAmount)}/day for ${parsedDays} day${parsedDays === 1 ? '' : 's'}`);
      reset();
    } catch (e: any) {
      toast.error(e?.message || 'Could not set the override');
    }
  };

  const revoke = async () => {
    if (!inForce) return;
    if (revokeReason.trim().length < 10) {
      toast.error('A reason of at least 10 characters is required to remove an override');
      return;
    }
    try {
      await revokeOverride.mutateAsync({ overrideId: inForce.id, reason: revokeReason.trim() });
      toast.success('Override removed — capacity is back on the earned figure');
      setRevokeReason('');
    } catch (e: any) {
      toast.error(e?.message || 'Could not remove the override');
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-lg w-[calc(100vw-1.5rem)] sm:w-full max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Gauge className="h-4 w-4 text-primary" />
            Adjust qualified capacity
          </DialogTitle>
          <DialogDescription className="text-xs">
            {agentName} — temporary adjustment to the daily figure this desk qualifies for. This is
            a planning recommendation only: it sends no money by itself.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Earned on record
            </p>
            <p className="font-mono text-sm font-bold tabular-nums">{formatUGX(earnedCapacity)}/day</p>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Override in force
            </p>
            <p className="font-mono text-sm font-bold tabular-nums text-primary">
              {inForce ? `${formatUGX(inForce.overrideCapacity)}/day` : '—'}
            </p>
            {inForce && (
              <p className="text-[10px] text-muted-foreground">
                until {format(new Date(inForce.expiresAt), 'd MMM, HH:mm')}
              </p>
            )}
          </div>
        </div>

        {!canEdit && (
          <p className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {readOnlyReason || 'You can view overrides but not change them.'}
          </p>
        )}

        {canEdit && (
          <div className="space-y-3 rounded-xl border border-border p-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="cap-amount" className="text-[11px]">Override amount (UGX / day)</Label>
                <Input
                  id="cap-amount"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 800000"
                  className="font-mono tabular-nums"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="cap-days" className="text-[11px]">Lasts for (days, 1–90)</Label>
                <Input
                  id="cap-days"
                  inputMode="numeric"
                  value={days}
                  onChange={(e) => setDays(e.target.value.replace(/[^\d]/g, ''))}
                  className="font-mono tabular-nums"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cap-reason" className="text-[11px]">
                Reason (required, at least 10 characters)
              </Label>
              <Textarea
                id="cap-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                placeholder="Why this desk is being adjusted today"
              />
              <p className="text-[10px] text-muted-foreground">
                {reason.trim().length}/10 characters minimum. Stored against your name in the audit
                trail.
              </p>
            </div>
            <Button onClick={submit} disabled={!canSubmit} className="w-full">
              {setOverride.isPending ? 'Saving…' : inForce ? 'Replace override' : 'Set override'}
            </Button>
          </div>
        )}

        {canEdit && inForce && (
          <div className="space-y-2 rounded-xl border border-warning/40 bg-warning/5 p-3">
            <p className="text-[11px] font-semibold text-foreground">Remove the current override</p>
            <Textarea
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
              rows={2}
              placeholder="Reason for removing it (at least 10 characters)"
            />
            <Button
              variant="outline"
              onClick={revoke}
              disabled={revokeOverride.isPending || revokeReason.trim().length < 10}
              className="w-full"
            >
              <Undo2 className="mr-2 h-3.5 w-3.5" />
              {revokeOverride.isPending ? 'Removing…' : 'Remove override'}
            </Button>
          </div>
        )}

        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Audit trail for this desk
          </p>
          {isLoading && <p className="text-xs text-muted-foreground">Loading history…</p>}
          {!isLoading && history.length === 0 && (
            <p className="text-xs text-muted-foreground">No override has ever been set here.</p>
          )}
          <div className="space-y-2 max-h-56 overflow-y-auto">
            {history.map((o) => (
              <div key={o.id} className="rounded-lg border border-border bg-background px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold tabular-nums">
                    {formatUGX(o.overrideCapacity)}/day
                  </span>
                  <span
                    className={`rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
                      o.isInForce
                        ? 'border-primary/40 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground'
                    }`}
                  >
                    {o.isInForce ? 'in force' : o.status}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-foreground break-words">{o.reason}</p>
                <p className="text-[10px] text-muted-foreground">
                  set by {o.createdByName} · {format(new Date(o.createdAt), 'd MMM yyyy HH:mm')} ·
                  runs to {format(new Date(o.expiresAt), 'd MMM HH:mm')}
                </p>
                {o.revokedAt && (
                  <p className="text-[10px] text-muted-foreground">
                    removed by {o.revokedByName || 'Financial Ops'} ·{' '}
                    {format(new Date(o.revokedAt), 'd MMM yyyy HH:mm')}
                    {o.revokeReason ? ` — ${o.revokeReason}` : ''}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
