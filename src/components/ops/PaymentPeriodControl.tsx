import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Loader2, History } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';

type Period = 'daily' | 'weekly';

interface Props {
  rentRequestId: string;
  /** Frequency stored on the plan. */
  frequency: string | null;
  /** Amount due per day on the plan (weekly = x7). */
  dailyRepayment: number | null;
  canEdit: boolean;
  onSaved?: () => void;
  /** Styling for the trigger button so it can sit beside other row actions. */
  triggerClassName?: string;
  /** Shorter trigger label for tight action rows. */
  compact?: boolean;
}

interface HistoryRow {
  id: string;
  changed_at: string;
  changed_by_name: string | null;
  old_frequency: string | null;
  new_frequency: string | null;
  reason: string | null;
}

const label = (p: Period) => (p === 'weekly' ? 'Weekly' : 'Daily');

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala',
  });

export function PaymentPeriodControl({
  rentRequestId, frequency, dailyRepayment, canEdit, onSaved, triggerClassName, compact,
}: Props) {
  const qc = useQueryClient();
  const current: Period = String(frequency ?? 'daily').toLowerCase() === 'weekly' ? 'weekly' : 'daily';
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Period>(current);
  const [reason, setReason] = useState('');

  const daily = Math.max(0, Number(dailyRepayment ?? 0));
  const amountFor = (p: Period) => (p === 'weekly' ? daily * 7 : daily);

  const { data: history = [], isLoading: historyLoading } = useQuery<HistoryRow[]>({
    queryKey: ['rent-frequency-history', rentRequestId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await (supabase as any).rpc('ops_rent_frequency_history', {
        p_rent_request_id: rentRequestId,
      });
      if (error) throw error;
      return (data ?? []) as HistoryRow[];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (choice === current) throw new Error(`This tenant already pays ${label(current).toLowerCase()}`);
      if (reason.trim().length < 10) throw new Error('Please give a reason of at least 10 characters');
      const { error } = await (supabase as any).rpc('ops_set_rent_plan_frequency', {
        p_rent_request_id: rentRequestId,
        p_frequency: choice,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Payment period changed to ${label(choice).toLowerCase()}`);
      setReason('');
      setOpen(false);
      qc.invalidateQueries({ queryKey: ['rent-frequency-history', rentRequestId] });
      onSaved?.();
    },
    onError: (e: any) => toast.error(e?.message ?? 'Could not change the payment period'),
  });

  const openChange = (next: boolean) => {
    setOpen(next);
    if (next) { setChoice(current); setReason(''); }
  };

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn('w-full sm:w-auto', triggerClassName)}
          disabled={!canEdit}
          title="Change payment period (daily or weekly)"
        >
          <CalendarClock className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5 mr-1.5'} />
          {compact ? 'Payment period' : 'Change payment period'}
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Change payment period</DialogTitle>
          <DialogDescription>
            This tenant currently pays <span className="font-semibold">{label(current).toLowerCase()}</span>
            {daily > 0 ? <> — {formatUGX(amountFor(current))} every {current === 'weekly' ? 'week' : 'day'}.</> : '.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Toggle */}
          <div
            role="radiogroup"
            aria-label="Payment period"
            className="grid grid-cols-2 gap-2 rounded-xl bg-muted/60 p-1"
          >
            {(['daily', 'weekly'] as Period[]).map((p) => {
              const selected = choice === p;
              return (
                <button
                  key={p}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setChoice(p)}
                  className={cn(
                    'min-h-[64px] rounded-lg px-3 py-2 text-center transition-all',
                    selected
                      ? 'bg-background shadow-sm ring-1 ring-primary text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <div className="text-sm font-semibold">{label(p)}</div>
                  {daily > 0 && (
                    <div className="text-[11px] text-muted-foreground">
                      {formatUGX(amountFor(p))} / {p === 'weekly' ? 'week' : 'day'}
                    </div>
                  )}
                  {p === current && (
                    <div className="text-[10px] font-medium text-muted-foreground mt-0.5">Current</div>
                  )}
                </button>
              );
            })}
          </div>

          {choice !== current && (
            <p className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-[12px] leading-relaxed">
              From now on this tenant is expected to pay{' '}
              <span className="font-semibold">{formatUGX(amountFor(choice))}</span>{' '}
              every {choice === 'weekly' ? 'week' : 'day'}. All payments already received stay on the
              record and are re-counted against the new period.
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Reason for the change (at least 10 characters)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder="Why is this tenant moving to a different payment period?"
              className="text-sm"
            />
          </div>

          {/* Audit trail */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <History className="h-3.5 w-3.5" /> Change history
            </div>
            {historyLoading ? (
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            ) : history.length === 0 ? (
              <p className="text-[11px] text-muted-foreground">
                No changes recorded yet. Every change you make is saved here with your name and reason.
              </p>
            ) : (
              <ul className="space-y-2">
                {history.map((h) => (
                  <li key={h.id} className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] font-medium">
                      <span className="capitalize">{h.old_frequency ?? 'daily'}</span>
                      <span className="text-muted-foreground">→</span>
                      <span className="capitalize text-primary">{h.new_frequency ?? ''}</span>
                      <span className="text-muted-foreground font-normal">· {fmtDate(h.changed_at)}</span>
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      By {h.changed_by_name?.trim() || 'Ops officer'}
                    </div>
                    {h.reason && (
                      <div className="text-[11px] mt-0.5 break-words">“{h.reason}”</div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)} className="w-full sm:w-auto">
            Cancel
          </Button>
          <Button
            size="sm"
            className="w-full sm:w-auto"
            disabled={save.isPending || choice === current || reason.trim().length < 10}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
            Save change
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default PaymentPeriodControl;
