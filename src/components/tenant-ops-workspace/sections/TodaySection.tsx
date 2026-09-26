/** Presentation only — every figure comes from tops_collection_scoreboard / tops_overnight_changes / tops_blocked_items. */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Banknote, Landmark, UserX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { KPICard } from '@/components/executive/KPICard';
import { formatUGX } from '@/lib/rentCalculations';
import { useCollectionScoreboard } from '@/hooks/tenantOpsWorkspace/useCollectionScoreboard';
import { useOvernightChanges, type OvernightChangeItem } from '@/hooks/tenantOpsWorkspace/useOvernightChanges';
import { useBlockedItems } from '@/hooks/tenantOpsWorkspace/useBlockedItems';
import { TenantDrawer } from '../tenant/TenantDrawer';

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
        <CardContent className="grid gap-4 sm:grid-cols-3">
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
        </CardContent>
      </Card>

      {/* My work — placeholder, wired with an SLA clock in a later prompt */}
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">My work</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Items assigned to you with an SLA clock will appear here in a later prompt.
          </p>
        </CardContent>
      </Card>

      <TenantDrawer rentRequestId={openTenant} onOpenChange={(open) => !open && setOpenTenant(null)} />
    </div>
  );
}
