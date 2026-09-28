/** Presentation only — every figure comes from tops_collection_scoreboard / tops_overnight_changes / tops_blocked_items / tops_work_items. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, Landmark, UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { KPICard } from '@/components/executive/KPICard';
import { formatUGX } from '@/lib/rentCalculations';
import { useCollectionScoreboard } from '@/hooks/tenantOpsWorkspace/useCollectionScoreboard';
import { useOvernightChanges, type OvernightChangeItem } from '@/hooks/tenantOpsWorkspace/useOvernightChanges';
import { useBlockedItems } from '@/hooks/tenantOpsWorkspace/useBlockedItems';
import { useMyWorkItems, type MyWorkItem } from '@/hooks/tenantOpsWorkspace/useMyWorkItems';
import { useOpsTeamMembers } from '@/hooks/tenantOpsWorkspace/useOpsTeamMembers';
import { useCloseWorkItem, useEscalateWorkItem } from '@/hooks/tenantOpsWorkspace/useWorkItemMutations';
import { useNeverBilledSummary } from '@/hooks/tenantOpsWorkspace/useNeverBilledSummary';
import { TenantDrawer } from '../tenant/TenantDrawer';

const BUCKET_BADGE_CLASS: Record<MyWorkItem['bucket'], string> = {
  critical: 'bg-destructive/10 text-destructive',
  at_risk: 'bg-warning/10 text-warning',
  watch: 'bg-muted text-foreground',
  new: 'bg-primary/10 text-primary',
};

function slaLabel(item: MyWorkItem): string {
  if (!item.slaDueAt) return 'No SLA';
  const due = new Date(item.slaDueAt);
  const label = due.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return item.isOverdue ? `Overdue since ${label}` : `Due ${label}`;
}

function MyWorkItemRow({ item, onOpenTenant }: { item: MyWorkItem; onOpenTenant: (rentRequestId: string) => void }) {
  const [mode, setMode] = useState<'none' | 'close' | 'escalate'>('none');
  const [outcome, setOutcome] = useState('');
  const [escalateTo, setEscalateTo] = useState('');
  const [escalateNote, setEscalateNote] = useState('');
  const { data: team } = useOpsTeamMembers();
  const closeItem = useCloseWorkItem();
  const escalateItem = useEscalateWorkItem();

  const reset = () => {
    setMode('none');
    setOutcome('');
    setEscalateTo('');
    setEscalateNote('');
  };

  return (
    <li className="rounded-lg border p-2">
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onOpenTenant(item.rentRequestId)}>
          <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
            {item.tenantName ?? 'Unnamed'}
            <Badge variant="outline" className={`text-[10px] capitalize ${BUCKET_BADGE_CLASS[item.bucket]}`}>
              {item.bucket.replace('_', ' ')}
            </Badge>
          </p>
          <p className="text-xs text-muted-foreground">{item.reason}</p>
          <p className="text-xs font-medium">{formatUGX(item.valueAtRiskUgx)}</p>
          <p className={`text-[11px] ${item.isOverdue ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}>
            {slaLabel(item)}
          </p>
          {item.escalatedTo && <p className="text-[11px] text-muted-foreground">Escalated{item.escalationNote ? `: ${item.escalationNote}` : ''}</p>}
        </button>
        <div className="flex shrink-0 gap-1">
          <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => setMode(mode === 'escalate' ? 'none' : 'escalate')}>
            Escalate
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 text-[10px]" onClick={() => setMode(mode === 'close' ? 'none' : 'close')}>
            Close
          </Button>
        </div>
      </div>

      {mode === 'close' && (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2">
          <Textarea
            placeholder="Outcome (required)"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            className="text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-[10px]"
              disabled={!outcome.trim() || closeItem.isPending}
              onClick={() => closeItem.mutate({ workItemId: item.id, outcome: outcome.trim() }, { onSuccess: reset })}
            >
              {closeItem.isPending ? 'Saving…' : 'Confirm close'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {mode === 'escalate' && (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/30 p-2">
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
          <Textarea
            placeholder="Note (optional)"
            value={escalateNote}
            onChange={(e) => setEscalateNote(e.target.value)}
            className="text-xs"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-[10px]"
              disabled={!escalateTo || escalateItem.isPending}
              onClick={() =>
                escalateItem.mutate(
                  { workItemId: item.id, escalatedTo: escalateTo, note: escalateNote.trim() || undefined },
                  { onSuccess: reset },
                )
              }
            >
              {escalateItem.isPending ? 'Saving…' : 'Confirm escalate'}
            </Button>
            <Button variant="ghost" size="sm" className="h-7 text-[10px]" onClick={reset}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

const todayIso = () => new Date().toISOString().slice(0, 10);

function ItemList({
  items,
  render,
  onSelect,
  emptyLabel,
}: {
  items: { rent_request_id?: string }[];
  render: (item: any) => string;
  onSelect: (rentRequestId: string) => void;
  emptyLabel: string;
}) {
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }
  return (
    <ul className="space-y-1">
      {items.map((item, i) => (
        <li key={item.rent_request_id ?? i}>
          <button
            type="button"
            className="min-h-8 w-full rounded px-1 py-1 text-left text-xs text-foreground hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
            disabled={!item.rent_request_id}
            onClick={() => item.rent_request_id && onSelect(item.rent_request_id)}
          >
            {render(item)}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default function TodaySection() {
  const navigate = useNavigate();
  const asAt = todayIso();
  const { data: scoreboard, isLoading: scoreboardLoading } = useCollectionScoreboard(asAt, asAt);
  const { data: overnight, isLoading: overnightLoading } = useOvernightChanges(asAt);
  const { data: blocked, isLoading: blockedLoading } = useBlockedItems();
  const { data: neverBilledSummary, isLoading: neverBilledLoading } = useNeverBilledSummary();
  const { data: myWork, isLoading: myWorkLoading } = useMyWorkItems();
  const [openTenant, setOpenTenant] = useState<string | null>(null);

  const goToCollections = (tab: string, extra?: Record<string, string>) => {
    const params = new URLSearchParams({ section: 'collections', tab, ...extra });
    navigate(`/tenant-ops/workspace?${params.toString()}`);
  };

  return (
    <div className="space-y-4">
      {/* The four figures — never a lone ratio, never clamped */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <button type="button" onClick={() => goToCollections('due-today')} className="text-left">
          <KPICard
            title="Expected"
            value={scoreboardLoading ? '…' : formatUGX(scoreboard?.expected_ugx ?? 0)}
            icon={Banknote}
            color="bg-primary/10 text-primary"
          />
        </button>
        <button type="button" onClick={() => goToCollections('due-today')} className="text-left">
          <KPICard
            title="Collected on schedule"
            value={scoreboardLoading ? '…' : formatUGX(scoreboard?.collected_on_schedule_ugx ?? 0)}
            icon={Banknote}
            color="bg-success/10 text-success"
          />
        </button>
        <button type="button" onClick={() => goToCollections('arrears')} className="text-left">
          <KPICard
            title="Arrears collected"
            value={scoreboardLoading ? '…' : formatUGX(scoreboard?.collected_arrears_ugx ?? 0)}
            icon={Banknote}
            color="bg-warning/10 text-warning"
          />
        </button>
        <button type="button" onClick={() => goToCollections('due-today')} className="text-left">
          <KPICard
            title="Total cash in"
            value={scoreboardLoading ? '…' : formatUGX(scoreboard?.total_cash_in_ugx ?? 0)}
            icon={Banknote}
            color="bg-muted text-foreground"
          />
        </button>
      </div>
      {scoreboard && (
        <p className="text-xs text-muted-foreground">
          Coverage (capped): {scoreboard.coverage_pct ?? '—'}% — {scoreboard.basis}
        </p>
      )}

      {/* What changed overnight */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">What changed overnight</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div>
            <button
              type="button"
              onClick={() => goToCollections('arrears')}
              className="flex items-center gap-2 text-left text-xs font-semibold text-destructive hover:underline"
            >
              <AlertTriangle className="h-3.5 w-3.5" />
              Rolled into arrears ({overnightLoading ? '…' : overnight?.rolled_into_arrears.count ?? 0})
            </button>
            {overnight && (
              <ItemList
                items={overnight.rolled_into_arrears.items}
                onSelect={setOpenTenant}
                emptyLabel="None overnight."
                render={(i: OvernightChangeItem) => `${i.tenant_name ?? 'Unnamed'} · ${formatUGX(i.arrears_ugx ?? 0)}`}
              />
            )}
          </div>
          <div>
            <p className="text-xs font-semibold text-muted-foreground">
              Promises broken ({overnight?.promises_broken.count ?? 0})
            </p>
            <p className="text-xs text-muted-foreground">{overnight?.promises_broken.note}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-success">
              Plans completed ({overnightLoading ? '…' : overnight?.plans_completed.count ?? 0})
            </p>
            {overnight && (
              <ItemList
                items={overnight.plans_completed.items}
                onSelect={setOpenTenant}
                emptyLabel="None overnight."
                render={(i: OvernightChangeItem) => `${i.tenant_name ?? 'Unnamed'} · ${formatUGX(i.total_repayment_ugx ?? 0)}`}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* What is blocked */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">What is blocked</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-4">
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold">
              <Landmark className="h-3.5 w-3.5" />
              Funded, landlord unpaid
              <Badge variant="outline" className="text-[10px]">{blockedLoading ? '…' : blocked?.funded_landlord_unpaid.count ?? 0}</Badge>
            </p>
            {blocked && (
              <ItemList
                items={blocked.funded_landlord_unpaid.items}
                onSelect={setOpenTenant}
                emptyLabel="None."
                render={(i) => i.tenant_name ?? 'Unnamed'}
              />
            )}
          </div>
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold">
              Approved, unfunded
              <Badge variant="outline" className="text-[10px]">{blockedLoading ? '…' : blocked?.approved_unfunded.count ?? 0}</Badge>
            </p>
            {blocked && (
              <ItemList
                items={blocked.approved_unfunded.items}
                onSelect={setOpenTenant}
                emptyLabel="None."
                render={(i) => i.tenant_name ?? 'Unnamed'}
              />
            )}
          </div>
          <div>
            <p className="flex items-center gap-2 text-xs font-semibold">
              <UserX className="h-3.5 w-3.5" />
              Agents below adequacy
              <Badge variant="outline" className="text-[10px]">{blockedLoading ? '…' : blocked?.agents_below_adequacy.count ?? 0}</Badge>
            </p>
            {blocked && (
              <ul className="space-y-1">
                {blocked.agents_below_adequacy.items.map((a) => (
                  <li key={a.agent_id} className="text-xs text-muted-foreground">
                    {a.agent_name ?? 'Unnamed'} — {a.best_pct}%
                  </li>
                ))}
                {blocked.agents_below_adequacy.items.length === 0 && (
                  <p className="text-xs text-muted-foreground">None.</p>
                )}
              </ul>
            )}
          </div>
          <div>
            <button
              type="button"
              onClick={() => goToCollections('never-billed')}
              className="flex items-center gap-2 text-left text-xs font-semibold hover:underline"
            >
              Never billed (quarantined)
              <Badge variant="outline" className="text-[10px]">{neverBilledLoading ? '…' : neverBilledSummary?.count ?? 0}</Badge>
            </button>
            <p className="text-xs text-muted-foreground">
              {neverBilledLoading ? '…' : formatUGX(neverBilledSummary?.arrears_ugx ?? 0)} excluded from every arrears total on this tab — a due date that never appeared in the pinned bill, never corrected here.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* My work — items assigned to me, ranked by SLA due time */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">
            My work
            <Badge variant="outline" className="ml-2 text-[10px]">{myWorkLoading ? '…' : myWork?.length ?? 0}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {myWorkLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
          {!myWorkLoading && (myWork ?? []).length === 0 && (
            <p className="text-xs text-muted-foreground">Nothing assigned to you right now.</p>
          )}
          {!myWorkLoading && (myWork ?? []).length > 0 && (
            <ul className="space-y-2">
              {(myWork ?? []).map((item) => (
                <MyWorkItemRow key={item.id} item={item} onOpenTenant={setOpenTenant} />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <TenantDrawer rentRequestId={openTenant} onOpenChange={(open) => !open && setOpenTenant(null)} />
    </div>
  );
}
