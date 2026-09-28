import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { formatUGX } from '@/lib/rentCalculations';
import { useAuth } from '@/hooks/useAuth';
import { useWorkItemForRentRequest } from '@/hooks/tenantOpsWorkspace/useWorkItemForRentRequest';
import { useOpsTeamMembers } from '@/hooks/tenantOpsWorkspace/useOpsTeamMembers';
import {
  useAssignWorkItem,
  useCloseWorkItem,
  useEscalateWorkItem,
  useSnoozeWorkItem,
} from '@/hooks/tenantOpsWorkspace/useWorkItemMutations';

/**
 * Every action deep-links to the existing Classic surface that already
 * performs it — no write path is reimplemented here. None of those existing
 * surfaces read a tenant/rent_request id from the URL today (confirmed by
 * direct investigation: TenantOpsDashboard.tsx keeps the selected tenant in
 * local state, not a search param), so these open the correct screen but
 * cannot pre-select this specific tenant there yet — wiring that would mean
 * editing an existing file beyond this build's two permitted lines.
 */
const ACTIONS = [
  { label: 'Record collection', href: '/executive-hub?tab=tenant-ops&mode=classic&view=collect-rent' },
  { label: 'Log call', href: '/executive-hub?tab=tenant-ops&mode=classic&view=calling-hub' },
  { label: 'Set promise', href: '/executive-hub?tab=tenant-ops&mode=classic&view=calling-hub' },
  { label: 'Pause', href: '/executive-hub?tab=tenant-ops&mode=classic&view=tenant-detail' },
  { label: 'Correct balance', href: '/executive-hub?tab=tenant-ops&mode=classic&view=tenant-detail' },
  { label: 'Reassign', href: '/executive-hub?tab=tenant-ops&mode=classic&view=link-agent' },
  { label: 'Escalate', href: '/executive-hub?tab=tenant-ops&mode=classic&view=calling-center' },
] as const;

const BUCKET_BADGE_CLASS: Record<string, string> = {
  critical: 'bg-destructive/10 text-destructive',
  at_risk: 'bg-warning/10 text-warning',
  watch: 'bg-muted text-foreground',
  new: 'bg-primary/10 text-primary',
};

/**
 * Our own work-item actions, additive alongside the Classic deep-links above.
 * Only renders anything actionable when tops_work_items has an open item for
 * this plan — tops_refresh_work_items() is the only thing that creates one,
 * so a caught-up plan legitimately has none.
 */
function WorkItemActions({ rentRequestId }: { rentRequestId: string }) {
  const { user } = useAuth();
  const { data: item, isLoading } = useWorkItemForRentRequest(rentRequestId);
  const { data: team } = useOpsTeamMembers();
  const assign = useAssignWorkItem();
  const close = useCloseWorkItem();
  const escalate = useEscalateWorkItem();
  const snooze = useSnoozeWorkItem();
  const [mode, setMode] = useState<'none' | 'close' | 'escalate'>('none');
  const [outcome, setOutcome] = useState('');
  const [escalateTo, setEscalateTo] = useState('');
  const [escalateNote, setEscalateNote] = useState('');

  const reset = () => {
    setMode('none');
    setOutcome('');
    setEscalateTo('');
    setEscalateNote('');
  };

  if (isLoading) {
    return <p className="text-[11px] text-muted-foreground">Loading work item…</p>;
  }
  if (!item) {
    return <p className="text-[11px] text-muted-foreground">No open work item for this plan.</p>;
  }

  return (
    <div className="space-y-2 rounded-lg border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={`text-[10px] capitalize ${BUCKET_BADGE_CLASS[item.bucket]}`}>
          {item.bucket.replace('_', ' ')}
        </Badge>
        <span className="text-xs font-medium">{formatUGX(item.valueAtRiskUgx)}</span>
        <span className="text-[11px] text-muted-foreground">{item.reason}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {!item.assignedTo && user?.id && (
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[10px]"
            disabled={assign.isPending}
            onClick={() => assign.mutate({ workItemId: item.id, assignedTo: user.id })}
          >
            {assign.isPending ? 'Assigning…' : 'Assign to me'}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[10px]"
          disabled={snooze.isPending}
          onClick={() => snooze.mutate({ workItemId: item.id, newSlaDueAt: new Date(Date.now() + 24 * 3600_000).toISOString() })}
        >
          {snooze.isPending ? 'Snoozing…' : 'Snooze 24h'}
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => setMode(mode === 'escalate' ? 'none' : 'escalate')}>
          Escalate
        </Button>
        <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => setMode(mode === 'close' ? 'none' : 'close')}>
          Close
        </Button>
      </div>

      {mode === 'close' && (
        <div className="space-y-2 rounded-md bg-muted/30 p-2">
          <Textarea placeholder="Outcome (required)" value={outcome} onChange={(e) => setOutcome(e.target.value)} className="text-xs" />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-[10px]"
              disabled={!outcome.trim() || close.isPending}
              onClick={() => close.mutate({ workItemId: item.id, outcome: outcome.trim() }, { onSuccess: reset })}
            >
              {close.isPending ? 'Saving…' : 'Confirm close'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === 'escalate' && (
        <div className="space-y-2 rounded-md bg-muted/30 p-2">
          <select
            value={escalateTo}
            onChange={(e) => setEscalateTo(e.target.value)}
            className="h-8 w-full rounded-md border bg-background px-2 text-xs"
          >
            <option value="">Escalate to…</option>
            {(team ?? []).map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
          <Textarea placeholder="Note (optional)" value={escalateNote} onChange={(e) => setEscalateNote(e.target.value)} className="text-xs" />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-[10px]"
              disabled={!escalateTo || escalate.isPending}
              onClick={() =>
                escalate.mutate(
                  { workItemId: item.id, escalatedTo: escalateTo, note: escalateNote.trim() || undefined },
                  { onSuccess: reset },
                )
              }
            >
              {escalate.isPending ? 'Saving…' : 'Confirm escalate'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ActionsRow({ rentRequestId }: { rentRequestId?: string }) {
  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rentRequestId && <WorkItemActions rentRequestId={rentRequestId} />}
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((action) => (
            <Button key={action.label} asChild variant="outline" size="sm">
              <a href={action.href} target="_blank" rel="noopener noreferrer">
                {action.label}
              </a>
            </Button>
          ))}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Opens the existing screen in a new tab — find or reselect this tenant there.
        </p>
      </CardContent>
    </Card>
  );
}
