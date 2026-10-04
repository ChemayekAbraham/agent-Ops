import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, XCircle, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';

interface Props {
  rentRequestId: string;
  initialStatus?: string;
}

type Phase = 'pending' | 'confirmed' | 'rejected';

function classify(status: string | null | undefined): Phase {
  if (!status) return 'pending';
  const s = status.toLowerCase();
  if (s === 'rejected' || s === 'cancelled' || s === 'declined') return 'rejected';
  if (['approved', 'funded', 'disbursed', 'completed', 'active', 'verified'].includes(s)) return 'confirmed';
  return 'pending';
}

export default function RentRequestStatusTracker({ rentRequestId, initialStatus = 'pending' }: Props) {
  const [status, setStatus] = useState<string>(initialStatus);

  useEffect(() => {
    let cancelled = false;

    // Initial fetch (in case parent only had optimistic value)
    supabase
      .from('rent_requests')
      .select('status')
      .eq('id', rentRequestId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled && data?.status) setStatus(data.status);
      });

    // Realtime subscription
    const channel = supabase
      .channel(`rent-request-${rentRequestId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rent_requests',
          filter: `id=eq.${rentRequestId}`,
        },
        (payload) => {
          const next = (payload.new as { status?: string })?.status;
          if (next) setStatus(next);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [rentRequestId]);

  const phase = classify(status);

  const steps: { key: Phase; label: string; icon: React.ReactNode }[] = [
    { key: 'pending', label: 'Pending Review', icon: <Clock className="h-4 w-4" /> },
    {
      key: phase === 'rejected' ? 'rejected' : 'confirmed',
      label: phase === 'rejected' ? 'Rejected' : 'Confirmed',
      icon: phase === 'rejected' ? <XCircle className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />,
    },
  ];

  return (
    <div className="rounded-xl border bg-card p-3 text-left">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
          Request Status
        </p>
        <span
          className={cn(
            'text-[10px] font-bold px-2 py-0.5 rounded-full border',
            phase === 'pending' && 'bg-amber-500/10 text-amber-600 border-amber-500/30',
            phase === 'confirmed' && 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
            phase === 'rejected' && 'bg-destructive/10 text-destructive border-destructive/30',
          )}
        >
          {status.toUpperCase()}
        </span>
      </div>

      <div className="flex items-center gap-2">
        {steps.map((step, i) => {
          const isCurrent = step.key === phase;
          const isDone = i === 0 && phase !== 'pending';
          const tone =
            step.key === 'rejected'
              ? 'destructive'
              : isDone || (isCurrent && phase === 'confirmed')
                ? 'success'
                : isCurrent
                  ? 'primary'
                  : 'muted';

          return (
            <div key={i} className="flex items-center gap-2 flex-1">
              <div
                className={cn(
                  'w-9 h-9 rounded-full flex items-center justify-center border-2 shrink-0',
                  tone === 'success' && 'bg-emerald-500 border-emerald-500 text-white',
                  tone === 'destructive' && 'bg-destructive border-destructive text-white',
                  tone === 'primary' && 'bg-primary/10 border-primary text-primary',
                  tone === 'muted' && 'bg-muted border-border text-muted-foreground',
                )}
              >
                {isCurrent && phase === 'pending' ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  step.icon
                )}
              </div>
              <p
                className={cn(
                  'text-xs font-medium flex-1 min-w-0 truncate',
                  tone === 'success' && 'text-emerald-600',
                  tone === 'destructive' && 'text-destructive',
                  tone === 'primary' && 'text-primary',
                  tone === 'muted' && 'text-muted-foreground',
                )}
              >
                {step.label}
              </p>
              {i < steps.length - 1 && (
                <div
                  className={cn(
                    'h-0.5 flex-1 min-w-[12px]',
                    phase === 'pending' && 'bg-border',
                    phase === 'confirmed' && 'bg-emerald-500',
                    phase === 'rejected' && 'bg-destructive',
                  )}
                />
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-muted-foreground mt-2">
        {phase === 'pending' && 'Awaiting Tenant Ops verification. You will be notified.'}
        {phase === 'confirmed' && 'Approved! Commission will be credited on each rent payment.'}
        {phase === 'rejected' && 'This request was rejected. Check your dashboard for details.'}
      </p>
    </div>
  );
}