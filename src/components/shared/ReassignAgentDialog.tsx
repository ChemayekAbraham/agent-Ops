import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Loader2, UserCog, Search, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { FieldError, FormErrorBanner, reasonError, parseRpcError } from '@/components/shared/FormFeedback';

type Target =
  | { kind: 'house'; houseId: string; houseTitle: string; currentAgentId: string }
  | { kind: 'rent_request'; rentRequestId: string; tenantName: string; currentAgentId: string };

interface ReassignAgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: Target;
  onComplete?: () => void;
}

export function ReassignAgentDialog({ open, onOpenChange, target, onComplete }: ReassignAgentDialogProps) {
  const { toast } = useToast();
  const [agentId, setAgentId] = useState('');
  const [reason, setReason] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [reasonTouched, setReasonTouched] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setAgentId(''); setReason(''); setSearch(''); setConfirming(false);
      setSubmitAttempted(false); setReasonTouched(false); setFormError(null);
    }
  }, [open]);

  const agentsQuery = useQuery({
    queryKey: ['reassign-agent-pool'],
    enabled: open,
    queryFn: async () => {
      const { data: roleRows, error } = await supabase
        .from('user_roles')
        .select('user_id')
        .eq('role', 'agent')
        .limit(500);
      if (error) throw error;
      const ids = Array.from(new Set((roleRows ?? []).map(r => r.user_id)));
      if (!ids.length) return [] as Array<{ id: string; name: string; phone: string | null }>;
      const { data: profs } = await supabase
        .from('profiles')
        .select('id,full_name,phone')
        .in('id', ids);
      return ((profs ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>).map(p => ({
        id: p.id,
        name: p.full_name || 'Unnamed agent',
        phone: p.phone ?? null,
      })).sort((a, b) => a.name.localeCompare(b.name));
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = agentsQuery.data ?? [];
    if (!q) return all;
    return all.filter(a => a.name.toLowerCase().includes(q) || (a.phone ?? '').includes(q));
  }, [agentsQuery.data, search]);

  const errors = {
    agent: !agentId
      ? 'Pick a new agent.'
      : agentId === target.currentAgentId
        ? 'New agent must be different from the current agent.'
        : null,
    reason: reasonError(reason),
  };
  const reasonErrText = (reasonTouched || submitAttempted) ? errors.reason : null;
  const canSubmit = !errors.agent && !errors.reason && !busy;
  const selectedAgent = useMemo(
    () => (agentsQuery.data ?? []).find(a => a.id === agentId),
    [agentsQuery.data, agentId],
  );

  const handleSubmit = async () => {
    setSubmitAttempted(true);
    setFormError(null);
    if (!canSubmit) return;
    setBusy(true);
    try {
      const rpc = target.kind === 'house' ? 'reassign_house_agent' : 'reassign_rent_request_agent';
      const args =
        target.kind === 'house'
          ? { p_house_id: target.houseId, p_new_agent_id: agentId, p_reason: reason.trim() }
          : { p_rent_request_id: target.rentRequestId, p_new_agent_id: agentId, p_reason: reason.trim() };
      const { error } = await supabase.rpc(rpc as any, args as any);
      if (error) throw error;
      toast({ title: 'Agent reassigned' });
      onComplete?.();
      onOpenChange(false);
    } catch (e: any) {
      const msg = parseRpcError(e);
      setFormError(msg);
      toast({ title: 'Failed', description: msg, variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  };

  const subject = target.kind === 'house'
    ? <>house <span className="font-medium">{target.houseTitle}</span></>
    : <>tenant <span className="font-medium">{target.tenantName}</span></>;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog className="h-5 w-5 text-primary" />
            Reassign managing agent
          </DialogTitle>
          <DialogDescription>Pick a different agent to manage {subject}.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <FormErrorBanner message={formError} />
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search agents by name or phone"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-8"
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <Label>New agent</Label>
            <Select value={agentId} onValueChange={setAgentId} disabled={busy}>
              <SelectTrigger><SelectValue placeholder="Pick an agent" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {filtered.map(a => (
                  <SelectItem key={a.id} value={a.id} disabled={a.id === target.currentAgentId}>
                    {a.name}{a.phone ? ` · ${a.phone}` : ''}{a.id === target.currentAgentId ? ' (current)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {agentsQuery.isLoading && <p className="text-xs text-muted-foreground">Loading agents…</p>}
            {submitAttempted && <FieldError message={errors.agent} />}
          </div>

          <div className="space-y-1.5">
            <Label>Reason (min 10 characters)</Label>
            <Textarea
              value={reason}
              onChange={e => setReason(e.target.value)}
              onBlur={() => setReasonTouched(true)}
              maxLength={500}
              aria-invalid={!!reasonErrText}
              placeholder="e.g. Current agent on leave; reassigning to nearest sub-agent"
              rows={3}
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">{reason.trim().length}/10</p>
            <FieldError message={reasonErrText} />
          </div>
        </div>

        {confirming && (
          <div className="rounded-md border-2 border-amber-500/50 bg-amber-500/10 p-3 text-sm space-y-1">
            <p className="font-semibold flex items-center gap-1.5 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" /> Confirm reassignment?
            </p>
            <p className="text-xs">
              Management of {subject} will move to{' '}
              <span className="font-medium">{selectedAgent?.name ?? 'the selected agent'}</span>.
              This is logged with your reason.
            </p>
          </div>
        )}

        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>Go back</Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {busy && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                Yes, reassign
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
              <Button
                onClick={() => {
                  setSubmitAttempted(true);
                  setReasonTouched(true);
                  if (canSubmit) setConfirming(true);
                }}
                disabled={busy}
              >
                Review reassignment
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
