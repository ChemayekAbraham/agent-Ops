/** Presentation only — every row comes from tops_pipeline_queue(). Stalled items are the point: default sort is age descending. */
import { useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/hooks/useAuth';
import { usePipelineQueue, type PipelineQueueRow } from '@/hooks/tenantOpsWorkspace/usePipelineQueue';
import { TenantDrawer } from '../tenant/TenantDrawer';

const GAP_TABS = [
  { key: 'all', label: 'All stalled' },
  { key: 'Approved but unfunded', label: 'Approved but unfunded' },
  { key: 'Funded but landlord unpaid', label: 'Funded but landlord unpaid' },
  { key: 'Landlord paid but clock not started', label: 'Landlord paid but clock not started' },
] as const;

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

export default function PipelineSection() {
  const { user } = useAuth();
  const [tab, setTab] = useState<(typeof GAP_TABS)[number]['key']>('all');
  const [myDeskOnly, setMyDeskOnly] = useState(false);
  const [openTenant, setOpenTenant] = useState<string | null>(null);
  const { data, isLoading } = usePipelineQueue();

  const rows = useMemo(() => {
    let list = data ?? [];
    if (tab !== 'all') list = list.filter((r) => r.gap_label === tab);
    if (myDeskOnly && user?.id) list = list.filter((r) => r.owner_id === user.id);
    return list;
  }, [data, tab, myDeskOnly, user?.id]);

  const countsByGap = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const r of data ?? []) counts[r.gap_label] = (counts[r.gap_label] ?? 0) + 1;
    return counts;
  }, [data]);

  return (
    <div className="space-y-4">
      <Card className="border shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch checked={myDeskOnly} onCheckedChange={setMyDeskOnly} />
            Waiting on my desk
          </label>
          <p className="text-[11px] text-muted-foreground">
            Every row is a plan approved but whose repayment clock has not started — sorted oldest-stalled first.
          </p>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
        <TabsList className="flex-wrap">
          {GAP_TABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key} className="gap-1.5">
              {t.label}
              {t.key !== 'all' && <Badge variant="secondary" className="tabular-nums">{countsByGap[t.key] ?? 0}</Badge>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">
            Stalled plans <Badge variant="outline" className="ml-2 text-[10px]">{rows.length}</Badge>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Tenant</TableHead>
                  <TableHead className="text-xs">Agent</TableHead>
                  <TableHead className="text-xs">Stage</TableHead>
                  <TableHead className="text-xs">Owner</TableHead>
                  <TableHead className="text-xs">Since</TableHead>
                  <TableHead className="text-xs">Age</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row: PipelineQueueRow) => (
                  <TableRow key={row.rent_request_id} className="cursor-pointer" onClick={() => setOpenTenant(row.rent_request_id)}>
                    <TableCell className="text-xs">{row.tenant_name ?? 'Unnamed'}</TableCell>
                    <TableCell className="text-xs">{row.agent_name ?? '—'}</TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="text-[10px]">{row.current_stage_label}</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{row.owner_name ?? '—'}</TableCell>
                    <TableCell className="text-xs">{dayLabel(row.stage_entered_at)}</TableCell>
                    <TableCell className="text-xs font-medium">{row.age_days}d</TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-xs text-muted-foreground">
                      {isLoading ? 'Loading…' : 'Nothing stalled here.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <TenantDrawer rentRequestId={openTenant} onOpenChange={(open) => !open && setOpenTenant(null)} />
    </div>
  );
}
