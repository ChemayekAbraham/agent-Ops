import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  ServiceCenterSubAgent,
  useRequestTenantTransfer,
  useRestoreSubAgent,
  useSuspendSubAgent,
  useUnlinkSubAgent,
} from '@/hooks/useAgentServiceCenter';

const MIN_REASON = 10;

/** Server errors from PostgREST/RPC are plain objects, not Error instances.
 * Read the message off whatever shape arrives so the agent sees the real reason
 * (e.g. "Only funded or repaying rent plans can be transferred") instead of a generic failure. */
function serverMessage(e: unknown, fallback: string): string {
  const raw = e as { message?: unknown; details?: unknown; hint?: unknown } | null;
  const msg = [raw?.message, raw?.details, raw?.hint].find(
    (v) => typeof v === 'string' && v.trim().length > 0,
  ) as string | undefined;
  return msg?.trim() || fallback;
}

function reasonError(reason: string) {
  return reason.trim().length < MIN_REASON
    ? `Please give at least ${MIN_REASON} characters so this action is auditable.`
    : null;
}

/** Suspend / restore a sub-agent account for a chosen period. */
export function SuspendSubAgentDialog({
  subAgent,
  open,
  onOpenChange,
}: {
  subAgent: ServiceCenterSubAgent | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [days, setDays] = useState('7');
  const [reason, setReason] = useState('');
  const suspend = useSuspendSubAgent();
  const restore = useRestoreSubAgent();
  const suspended = !!subAgent?.suspension;
  const busy = suspend.isPending || restore.isPending;

  const submit = async () => {
    if (!subAgent) return;
    const err = reasonError(reason);
    if (err) { toast.error(err); return; }
    try {
      if (suspended) {
        await restore.mutateAsync({ subAgentId: subAgent.sub_agent_id, reason: reason.trim() });
        toast.success(`${subAgent.full_name ?? 'Sub-agent'} restored`);
      } else {
        const n = Number(days);
        if (!Number.isFinite(n) || n < 1 || n > 90) { toast.error('Choose between 1 and 90 days'); return; }
        await suspend.mutateAsync({ subAgentId: subAgent.sub_agent_id, days: n, reason: reason.trim() });
        toast.success(`${subAgent.full_name ?? 'Sub-agent'} suspended for ${n} day(s)`);
      }
      setReason('');
      onOpenChange(false);
    } catch (e) {
      toast.error(serverMessage(e, 'Action failed'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{suspended ? 'Restore account' : 'Suspend account'}</DialogTitle>
          <DialogDescription>
            {suspended
              ? `Lift the suspension on ${subAgent?.full_name ?? 'this sub-agent'} so they can work again.`
              : `${subAgent?.full_name ?? 'This sub-agent'} will not be able to use any agent feature until the period ends.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {!suspended && (
            <div className="space-y-2">
              <Label htmlFor="sc-days">Suspension period (days)</Label>
              <Input
                id="sc-days"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="7"
              />
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="sc-reason">Reason (required)</Label>
            <Textarea
              id="sc-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why for the audit trail"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            variant={suspended ? 'default' : 'destructive'}
            onClick={submit}
            disabled={busy}
          >
            {busy ? 'Saving…' : suspended ? 'Restore access' : 'Suspend account'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Move one tenant from this sub-agent to another sub-agent (agent ops must approve). */
export function TransferTenantDialog({
  subAgent,
  peers,
  open,
  onOpenChange,
  presetRentRequestId,
  pendingRentRequestIds = [],
}: {
  subAgent: ServiceCenterSubAgent | null;
  peers: ServiceCenterSubAgent[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Tenant chosen from the sub-agent's tenant list. */
  presetRentRequestId?: string | null;
  /** Rent plans already awaiting an Agent Ops decision — cannot be re-submitted. */
  pendingRentRequestIds?: string[];
}) {
  const [rentRequestId, setRentRequestId] = useState('');
  const [toId, setToId] = useState('');
  const [reason, setReason] = useState('');
  const request = useRequestTenantTransfer();

  useEffect(() => {
    if (open) setRentRequestId(presetRentRequestId ?? '');
  }, [open, presetRentRequestId]);

  // Server rules, mirrored exactly: only funded/repaying plans that this
  // sub-agent actually owns, and never one already awaiting approval.
  const pending = new Set(pendingRentRequestIds);
  const tenants = (subAgent?.tenant_list ?? []).filter(
    (t) => t.is_active && t.owned_by_subagent !== false && !pending.has(t.rent_request_id),
  );
  // A suspended sub-agent cannot receive tenants (the server refuses too).
  const options = peers.filter(
    (p) =>
      p.sub_agent_id !== subAgent?.sub_agent_id &&
      p.link_status === 'verified' &&
      !p.suspension,
  );

  const submit = async () => {
    if (!rentRequestId) { toast.error('Choose a tenant to transfer'); return; }
    if (!toId) { toast.error('Choose the receiving sub-agent'); return; }
    const err = reasonError(reason);
    if (err) { toast.error(err); return; }
    try {
      await request.mutateAsync({ rentRequestId, toSubAgentId: toId, reason: reason.trim() });
      toast.success('Transfer sent to Agent Operations for approval');
      setRentRequestId(''); setToId(''); setReason('');
      onOpenChange(false);
    } catch (e) {
      toast.error(serverMessage(e, 'Could not submit transfer'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer a tenant</DialogTitle>
          <DialogDescription>
            Agent Operations must approve. Once approved, all earnings from this tenant go to the
            receiving sub-agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Tenant (from {subAgent?.full_name ?? '—'})</Label>
            <Select value={rentRequestId} onValueChange={setRentRequestId}>
              <SelectTrigger>
                <SelectValue placeholder={tenants.length ? 'Select tenant' : 'No transferable tenants'} />
              </SelectTrigger>
              <SelectContent>
                {tenants.map((t) => (
                  <SelectItem key={t.rent_request_id} value={t.rent_request_id}>
                    {t.tenant_name ?? 'Unnamed tenant'} · {t.status}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {tenants.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Only funded or repaying rent plans owned by this sub-agent, with no transfer already
                waiting, can be moved.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>Receiving sub-agent</Label>
            <Select value={toId} onValueChange={setToId}>
              <SelectTrigger>
                <SelectValue placeholder={options.length ? 'Select sub-agent' : 'No eligible sub-agent'} />
              </SelectTrigger>
              <SelectContent>
                {options.map((p) => (
                  <SelectItem key={p.sub_agent_id} value={p.sub_agent_id}>
                    {p.full_name ?? p.phone ?? 'Unnamed'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {options.length === 0 && (
              <p className="text-xs text-muted-foreground">
                A receiving sub-agent must be verified and not suspended.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="sc-transfer-reason">Reason (required)</Label>
            <Textarea
              id="sc-transfer-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this tenant moving?"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={request.isPending}>Cancel</Button>
          <Button onClick={submit} disabled={request.isPending || tenants.length === 0 || options.length === 0}>
            {request.isPending ? 'Submitting…' : 'Submit for approval'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Break the parent ↔ sub-agent relationship entirely. */
export function UnlinkSubAgentDialog({
  subAgent,
  open,
  onOpenChange,
}: {
  subAgent: ServiceCenterSubAgent | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [reason, setReason] = useState('');
  const unlink = useUnlinkSubAgent();
  // Only rent plans owned by this sub-agent block the unlink — the server checks the same thing.
  const activeTenants = (subAgent?.tenant_list ?? [])
    .filter((t) => t.is_active && t.owned_by_subagent !== false).length;

  const submit = async () => {
    if (!subAgent) return;
    const err = reasonError(reason);
    if (err) { toast.error(err); return; }
    try {
      await unlink.mutateAsync({ subAgentId: subAgent.sub_agent_id, reason: reason.trim() });
      toast.success(`${subAgent.full_name ?? 'Sub-agent'} unlinked from your team`);
      setReason('');
      onOpenChange(false);
    } catch (e) {
      toast.error(serverMessage(e, 'Could not unlink this sub-agent'));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Unlink sub-agent</DialogTitle>
          <DialogDescription>
            This breaks the relationship between you and {subAgent?.full_name ?? 'this sub-agent'}.
            They keep their own account, but they leave your team and you stop earning overrides on
            their future work. The removal is archived for audit.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {activeTenants > 0 && (
            <p className="rounded-xl bg-destructive/10 p-3 text-xs text-destructive">
              This sub-agent still has {activeTenants} active tenant(s). Transfer them first — the
              system will refuse to unlink while active rent plans remain.
            </p>
          )}
          <div className="space-y-2">
            <Label htmlFor="sc-unlink-reason">Reason (required)</Label>
            <Textarea
              id="sc-unlink-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why are you removing this sub-agent from your team?"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={unlink.isPending}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={unlink.isPending || activeTenants > 0}>
            {unlink.isPending ? 'Unlinking…' : 'Unlink sub-agent'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}