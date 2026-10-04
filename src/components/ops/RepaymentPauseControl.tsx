import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { PauseCircle, PlayCircle, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

const DURATIONS = [7, 14, 30] as const;

interface RepaymentPauseControlProps {
  rentRequestId: string;
  /** Kept for context only — pausing is gated on a remaining balance, not the registration type. */
  registrationType?: string | null;
  /** Remaining balance on the plan. Pausing is only offered when money is still owed. */
  outstandingAmount?: number;
  /** Terminal plans (cancelled/rejected/closed/defaulted) cannot be paused. */
  planStatus?: string | null;
}

export function RepaymentPauseControl({
  rentRequestId,
  outstandingAmount = 0,
  planStatus,
}: RepaymentPauseControlProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [days, setDays] = useState<number>(7);
  const [reason, setReason] = useState('');

  const TERMINAL = ['cancelled', 'rejected', 'closed', 'defaulted', 'deleted_by_agent'];
  const isOutstanding =
    outstandingAmount > 0 && !TERMINAL.includes(String(planStatus || '').toLowerCase());

  const { data: activePause, isLoading } = useQuery({
    queryKey: ['repayment-pause', rentRequestId],
    enabled: isOutstanding,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('rent_repayment_pauses')
        .select('id, pause_days, reason, resume_on, paused_at, status')
        .eq('rent_request_id', rentRequestId)
        .eq('status', 'active')
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const pause = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('pause_tenant_repayment', {
        p_rent_request_id: rentRequestId,
        p_days: days,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success(`Repayment collections paused for ${days} days`);
      setOpen(false);
      setReason('');
      queryClient.invalidateQueries({ queryKey: ['repayment-pause', rentRequestId] });
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to pause repayment'),
  });

  const resume = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('cancel_tenant_repayment_pause', {
        p_rent_request_id: rentRequestId,
        p_reason: 'Manual early resume by operations',
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Repayment collections resumed');
      queryClient.invalidateQueries({ queryKey: ['repayment-pause', rentRequestId] });
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to resume repayment'),
  });

  if (!isOutstanding) return null;

  if (activePause) {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 border-amber-200">
          Paused until {format(new Date(activePause.resume_on), 'dd MMM')}
        </Badge>
        <Button
          variant="outline"
          size="sm"
          className="h-6 px-2 text-[10px] gap-1"
          onClick={() => resume.mutate()}
          disabled={resume.isPending}
          title="Resume collections now"
        >
          {resume.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />}
          Resume
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-[10px] gap-1"
        onClick={() => setOpen(true)}
        disabled={isLoading}
        title="Pause repayment collections"
      >
        <PauseCircle className="h-3 w-3" />
        Pause
      </Button>

      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setReason(''); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <PauseCircle className="h-4 w-4 text-amber-600" /> Pause repayment collections
            </DialogTitle>
            <DialogDescription>
              Daily collections on this outstanding balance stop for the selected period and resume automatically once it ends. The plan end date shifts by the same number of days.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Pause duration</label>
              <div className="mt-1.5 grid grid-cols-3 gap-2">
                {DURATIONS.map((d) => (
                  <Button
                    key={d}
                    type="button"
                    variant={days === d ? 'default' : 'outline'}
                    size="sm"
                    className={cn('h-9')}
                    onClick={() => setDays(d)}
                  >
                    {d} days
                  </Button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs font-medium text-muted-foreground">Reason (min 10 characters, audited)</label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why are collections being paused?"
                className="mt-1.5 text-sm"
                rows={3}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={() => pause.mutate()}
              disabled={reason.trim().length < 10 || pause.isPending}
            >
              {pause.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              Pause {days} days
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default RepaymentPauseControl;
