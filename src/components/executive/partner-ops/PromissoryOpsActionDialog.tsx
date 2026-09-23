import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, MessageSquare, Phone } from 'lucide-react';

/**
 * Partner Ops action dialog for one open promise.
 *
 * Every action is written through the SECURITY DEFINER RPC
 * `promissory_ops_record_action` into the append-only working log
 * `promissory_note_ops_actions`. Nothing here touches the promise itself,
 * a wallet, the ledger or any funding behaviour — it only records what
 * Partner Ops did about the promise.
 */

export type OpsAction = 'assign' | 'unassign' | 'contact' | 'snooze' | 'unsnooze' | 'resolve' | 'reopen';

export interface OpsActionTarget {
  id: string;
  partner_name: string;
  phone_number: string | null;
  whatsapp_number: string | null;
  amount: number;
  fulfilment_due_on: string | null;
  assigned_to?: string | null;
  assigned_to_name?: string | null;
  snoozed_until?: string | null;
  resolution?: string | null;
}

const ACTION_COPY: Record<OpsAction, { title: string; blurb: string; cta: string }> = {
  assign: {
    title: 'Assign this promise',
    blurb: 'Give a named Partner Ops person responsibility for converting this promise.',
    cta: 'Assign',
  },
  unassign: {
    title: 'Remove the assignment',
    blurb: 'Send this promise back to the unassigned pool.',
    cta: 'Unassign',
  },
  contact: {
    title: 'Log a contact with the partner',
    blurb: 'Record how you reached the partner and what they said.',
    cta: 'Save contact',
  },
  snooze: {
    title: 'Snooze this promise',
    blurb: 'Hide it from the working queue until a date you choose. It keeps counting as open money.',
    cta: 'Snooze',
  },
  unsnooze: {
    title: 'Bring back into the queue',
    blurb: 'End the snooze and show this promise again straight away.',
    cta: 'Unsnooze',
  },
  resolve: {
    title: 'Resolve this promise',
    blurb: 'Close it out of the working queue with an outcome. The promise record, its status and any money stay exactly as they are.',
    cta: 'Resolve',
  },
  reopen: {
    title: 'Reopen this promise',
    blurb: 'Put a resolved promise back into the working queue.',
    cta: 'Reopen',
  },
};

const CHANNELS = [
  ['call', 'Phone call'],
  ['whatsapp', 'WhatsApp'],
  ['sms', 'SMS'],
  ['email', 'Email'],
  ['in_person', 'In person'],
] as const;

const RESOLUTIONS = [
  ['fulfilled_offline', 'Money received / funded outside this promise'],
  ['cancelled_by_partner', 'Partner cancelled the promise'],
  ['duplicate', 'Duplicate of another promise'],
  ['uncollectible', 'Written off as uncollectible'],
  ['other', 'Other (explain below)'],
] as const;

interface Props {
  action: OpsAction | null;
  note: OpsActionTarget | null;
  onClose: () => void;
}

export function PromissoryOpsActionDialog({ action, note, onClose }: Props) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [assignee, setAssignee] = useState('');
  const [channel, setChannel] = useState<string>('call');
  const [outcome, setOutcome] = useState('');
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [resolution, setResolution] = useState<string>('fulfilled_offline');

  const open = !!action && !!note;

  useEffect(() => {
    if (!open) return;
    setReason('');
    setOutcome('');
    setChannel('call');
    setResolution('fulfilled_offline');
    setAssignee(note?.assigned_to || '');
    const d = new Date();
    d.setDate(d.getDate() + 3);
    setSnoozeUntil(d.toISOString().slice(0, 10));
  }, [open, note?.id, note?.assigned_to]);

  const { data: assignees = [] } = useQuery({
    queryKey: ['promissory-ops-assignees'],
    enabled: open && action === 'assign',
    staleTime: 600_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('promissory_ops_assignees');
      if (error) throw error;
      return (data || []) as { user_id: string; full_name: string; role: string }[];
    },
  });

  const { data: history = [] } = useQuery({
    queryKey: ['promissory-ops-history', note?.id],
    enabled: open && !!note?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('promissory_note_ops_actions')
        .select('id, action, channel, outcome, snooze_until, resolution, reason, created_at')
        .eq('note_id', note!.id)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data || [];
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      if (!note || !action) throw new Error('Nothing to save');
      const { data, error } = await supabase.rpc('promissory_ops_record_action', {
        p_note_id: note.id,
        p_action: action,
        p_reason: reason.trim(),
        p_assigned_to: action === 'assign' ? assignee || null : null,
        p_channel: action === 'contact' ? channel : null,
        p_outcome: action === 'contact' ? outcome.trim() || null : null,
        p_snooze_until: action === 'snooze' ? snoozeUntil : null,
        p_resolution: action === 'resolve' ? resolution : null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success(`${ACTION_COPY[action!].cta} recorded`);
      qc.invalidateQueries({ queryKey: ['promissory-ops-queue-state'] });
      qc.invalidateQueries({ queryKey: ['promissory-ops-history'] });
      onClose();
    },
    onError: (e: any) => toast.error(e?.message || 'Could not save that action'),
  });

  const blocked = useMemo(() => {
    if (reason.trim().length < 10) return 'Write at least 10 characters explaining why.';
    if (action === 'assign' && !assignee) return 'Choose who takes this promise.';
    if (action === 'snooze' && (!snoozeUntil || snoozeUntil <= new Date().toISOString().slice(0, 10)))
      return 'Pick a date in the future.';
    return null;
  }, [reason, action, assignee, snoozeUntil]);

  if (!open || !action || !note) return null;
  const copy = ACTION_COPY[action];
  const waNumber = (note.whatsapp_number || note.phone_number || '').replace(/[^\d]/g, '');

  return (
    <Dialog open={open} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{copy.title}</DialogTitle>
          <DialogDescription className="text-xs">
            {note.partner_name || 'Unnamed partner'} · {formatUGX(Number(note.amount || 0))}
            {note.fulfilment_due_on ? ` · promised ${note.fulfilment_due_on}` : ' · no promised date'}
            <br />
            {copy.blurb}
          </DialogDescription>
        </DialogHeader>

        {action === 'contact' && (
          <div className="flex flex-wrap gap-2">
            {note.phone_number && (
              <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                <a href={`tel:${note.phone_number}`}>
                  <Phone className="h-3.5 w-3.5 mr-1" /> Call {note.phone_number}
                </a>
              </Button>
            )}
            {waNumber && (
              <Button asChild size="sm" variant="outline" className="h-8 text-xs">
                <a href={`https://wa.me/${waNumber}`} target="_blank" rel="noreferrer">
                  <MessageSquare className="h-3.5 w-3.5 mr-1" /> WhatsApp
                </a>
              </Button>
            )}
          </div>
        )}

        <div className="space-y-3">
          {action === 'assign' && (
            <div className="space-y-1">
              <Label className="text-xs">Assign to</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Choose a Partner Ops person" />
                </SelectTrigger>
                <SelectContent>
                  {assignees.map(a => (
                    <SelectItem key={a.user_id} value={a.user_id} className="text-xs">
                      {a.full_name} · {a.role.replace(/_/g, ' ')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {action === 'contact' && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">How did you reach them?</Label>
                <Select value={channel} onValueChange={setChannel}>
                  <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHANNELS.map(([v, l]) => (
                      <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">What did they say? (optional)</Label>
                <Input
                  value={outcome}
                  onChange={e => setOutcome(e.target.value)}
                  placeholder="e.g. paying on Friday after school fees"
                  className="h-9 text-xs"
                />
              </div>
            </>
          )}

          {action === 'snooze' && (
            <div className="space-y-1">
              <Label className="text-xs">Show again on</Label>
              <Input
                type="date"
                value={snoozeUntil}
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                onChange={e => setSnoozeUntil(e.target.value)}
                className="h-9 text-xs"
              />
            </div>
          )}

          {action === 'resolve' && (
            <div className="space-y-1">
              <Label className="text-xs">Outcome</Label>
              <Select value={resolution} onValueChange={setResolution}>
                <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RESOLUTIONS.map(([v, l]) => (
                    <SelectItem key={v} value={v} className="text-xs">{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Why (recorded for audit, 10 characters minimum)</Label>
            <Textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              rows={3}
              placeholder="Explain the decision in your own words"
              className="text-xs"
            />
          </div>
        </div>

        {history.length > 0 && (
          <div className="rounded-lg border bg-muted/30 p-2 space-y-1 max-h-40 overflow-y-auto">
            <p className="text-[10px] font-semibold text-muted-foreground">Earlier actions on this promise</p>
            {history.map((h: any) => (
              <div key={h.id} className="text-[10px] text-muted-foreground">
                <Badge variant="outline" className="text-[9px] px-1 py-0 mr-1">{h.action}</Badge>
                {new Date(h.created_at).toLocaleString()}
                {h.channel ? ` · ${h.channel}` : ''}
                {h.resolution ? ` · ${h.resolution.replace(/_/g, ' ')}` : ''}
                {h.snooze_until ? ` · until ${h.snooze_until}` : ''}
                {h.outcome ? ` · "${h.outcome}"` : ''}
                <span className="block opacity-80">{h.reason}</span>
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            disabled={!!blocked || save.isPending}
            onClick={() => save.mutate()}
            title={blocked || undefined}
          >
            {save.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            {copy.cta}
          </Button>
        </DialogFooter>
        {blocked && <p className="text-[10px] text-muted-foreground text-right">{blocked}</p>}
      </DialogContent>
    </Dialog>
  );
}
