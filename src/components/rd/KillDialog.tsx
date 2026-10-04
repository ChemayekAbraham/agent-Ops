import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { db, labelize, useRdMutation } from './useRd';

export function KillDialog({ missionId, open, onOpenChange }: { missionId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [why, setWhy] = useState('');
  const [belief, setBelief] = useState('');
  const [never, setNever] = useState('');
  useEffect(() => { if (open) { setWhy(''); setBelief(''); setNever(''); } }, [open]);
  const kill = useRdMutation(async () => db.rpc('rd_decide', {
    p_mission: missionId, p_decision: 'kill', p_why: why, p_belief: belief || null, p_never_again: never || null,
  }), 'Mission killed');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Kill mission</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Why</Label><Textarea rows={3} value={why} onChange={(e) => setWhy(e.target.value)} /></div>
          <div><Label>Belief that was wrong</Label><Textarea rows={2} value={belief} onChange={(e) => setBelief(e.target.value)} /></div>
          <div><Label>Never again</Label><Textarea rows={2} value={never} onChange={(e) => setNever(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={kill.isPending} onClick={() => kill.mutate(undefined, { onSuccess: () => onOpenChange(false) })}>Kill</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reason prompt, optionally with a stage picker (for Force stage). */
export function ReasonDialog({
  open, onOpenChange, title, confirmLabel, stages, onConfirm, pending,
}: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; confirmLabel: string;
  stages?: readonly string[]; onConfirm: (reason: string, stage?: string) => void; pending?: boolean;
}) {
  const [reason, setReason] = useState('');
  const [stage, setStage] = useState('');
  useEffect(() => { if (open) { setReason(''); setStage(''); } }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          {stages && (
            <div>
              <Label>Stage</Label>
              <Select value={stage} onValueChange={setStage}>
                <SelectTrigger><SelectValue placeholder="Choose stage" /></SelectTrigger>
                <SelectContent>{stages.map((s) => <SelectItem key={s} value={s}>{labelize(s)}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          <div><Label>Reason</Label><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={pending} onClick={() => onConfirm(reason, stages ? stage : undefined)}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
