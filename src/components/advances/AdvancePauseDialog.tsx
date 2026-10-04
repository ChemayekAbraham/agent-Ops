import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Loader2, PauseCircle, PlayCircle, ShieldAlert } from 'lucide-react';

export interface AdvancePauseDialogProps {
  advanceId: string | null;
  agentName?: string | null;
  /** Current pause state of the advance, so the dialog knows which action to offer. */
  isPaused: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Query keys to invalidate after a successful pause/resume. */
  invalidateKeys?: string[];
}

const MIN_REASON = 10;

export default function AdvancePauseDialog({
  advanceId, agentName, isPaused, open, onOpenChange, invalidateKeys = [],
}: AdvancePauseDialogProps) {
  const [reason, setReason] = useState('');
  const queryClient = useQueryClient();

  const { data: events } = useQuery({
    queryKey: ['advance-pause-events', advanceId],
    enabled: open && !!advanceId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_advance_pause_events')
        .select('id, action, reason, created_at, acted_by')
        .eq('advance_id', advanceId as string)
        .order('created_at', { ascending: false })
        .limit(10);
      if (error) throw error;
      return data || [];
    },
    staleTime: 0,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const fn = isPaused ? 'resume_agent_advance' : 'pause_agent_advance';
      const { data, error } = await supabase.rpc(fn, {
        p_advance_id: advanceId as string,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success(isPaused ? 'Deductions resumed' : 'Deductions paused');
      invalidateKeys.forEach((k) => queryClient.invalidateQueries({ queryKey: [k] }));
      queryClient.invalidateQueries({ queryKey: ['advance-pause-events', advanceId] });
      setReason('');
      onOpenChange(false);
    },
    onError: (e: any) => {
      toast.error(e?.message || 'Action failed');
    },
  });

  const tooShort = reason.trim().length < MIN_REASON;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) setReason(''); onOpenChange(o); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isPaused
              ? <><PlayCircle className="h-4 w-4 text-emerald-600" /> Resume advance deductions</>
              : <><PauseCircle className="h-4 w-4 text-amber-600" /> Pause advance deductions</>}
          </DialogTitle>
          <DialogDescription>
            {agentName ? <span className="font-medium text-foreground">{agentName}</span> : 'This advance'}
            {isPaused
              ? ' — deductions are currently on hold. Resuming restarts the daily schedule from today; nothing is back-charged for the paused days.'
              : ' — while paused, no automatic deduction runs: not the daily wallet sweep, not Returns-based recovery, and not the missed-repayment clawback from new earnings.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs flex gap-2">
            <ShieldAlert className="h-4 w-4 shrink-0 text-amber-600" />
            <span>
              Interest and the outstanding balance are untouched by a pause — only collection stops.
              Every pause and resume is logged with your name and this reason.
            </span>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium">
              Reason {isPaused ? 'for resuming' : 'for the pause (dispute, unclear claim, investigation)'}
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={isPaused
                ? 'e.g. Claim reviewed with the agent, balance confirmed correct — collections restart'
                : 'e.g. Agent disputes two deductions on 5 and 6 Aug — under review by Agent Ops'}
            />
            <p className={`text-[11px] ${tooShort ? 'text-destructive' : 'text-muted-foreground'}`}>
              {reason.trim().length}/{MIN_REASON} characters minimum
            </p>
          </div>

          {(events?.length ?? 0) > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium">Pause history</p>
              <div className="max-h-32 overflow-y-auto space-y-1.5">
                {events!.map((ev: any) => (
                  <div key={ev.id} className="rounded-md border border-border p-2 text-[11px]">
                    <div className="flex items-center justify-between gap-2">
                      <Badge variant={ev.action === 'paused' ? 'secondary' : 'outline'} className="text-[9px] capitalize">
                        {ev.action}
                      </Badge>
                      <span className="text-muted-foreground">
                        {format(new Date(ev.created_at), 'dd MMM yyyy HH:mm')}
                      </span>
                    </div>
                    <p className="mt-1 text-muted-foreground break-words">{ev.reason}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            variant={isPaused ? 'default' : 'destructive'}
            disabled={tooShort || mutation.isPending || !advanceId}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-1" />}
            {isPaused ? 'Resume deductions' : 'Pause deductions'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
