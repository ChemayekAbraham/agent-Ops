import { ShieldCheck, AlertCircle } from 'lucide-react';
import { useBikeAdvancePriority } from '@/hooks/useBikeAdvancePriority';
import { formatUGX } from '@/lib/rentCalculations';

export function BikeAdvanceRecoveryOrder({ agentId, enabled = true }: { agentId?: string | null; enabled?: boolean }) {
  const { data, isLoading, isError } = useBikeAdvancePriority(agentId, enabled);
  if (!enabled || !agentId) return null;
  if (isLoading || isError || !data) return <p role={isError ? 'alert' : undefined} className="text-xs text-muted-foreground">
    {isLoading ? 'Checking recovery order…' : 'Recovery order unavailable.'}
  </p>;
  const protectedRecovery = data.protected && data.advance_from_surplus;
  return (
    <div className={`rounded-lg border p-2.5 space-y-2 text-xs ${protectedRecovery ? 'border-success/30 bg-success/10' : 'border-warning/30 bg-warning/10'}`}>
      <p className={`flex items-center gap-1.5 font-semibold ${protectedRecovery ? 'text-success' : 'text-warning'}`}>
        {protectedRecovery ? <ShieldCheck className="h-4 w-4 shrink-0" /> : <AlertCircle className="h-4 w-4 shrink-0" />}
        {protectedRecovery ? 'Waterfall Recovery Protected' : 'Recovery priority is paused or not applicable'}
      </p>
      <dl className="grid gap-1.5 sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Priority 1 · Bike daily payment</dt><dd className="font-semibold">{formatUGX(Number(data.bike_daily))}</dd></div>
        <div><dt className="text-muted-foreground">Priority 2 · Running advance</dt><dd className="font-semibold">{formatUGX(Number(data.advance_outstanding))} · surplus only</dd></div>
      </dl>
      <p className="text-muted-foreground">Bike payment is collected first. Only earnings left after the daily bike payment can repay the advance. Contracts and fees stay separate.</p>
    </div>
  );
}