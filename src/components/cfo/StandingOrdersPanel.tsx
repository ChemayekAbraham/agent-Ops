import { useMemo, useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { AlertTriangle, Loader2, RefreshCw, ShieldAlert, ShieldQuestion, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  useStandingOrders, useSetStandingOrderEnabled,
  type StandingOrderRow, type StandingOrderHealth,
} from '@/hooks/useStandingOrders';

const HEALTH_META: Record<StandingOrderHealth, { label: string; badgeClass: string; icon: typeof AlertTriangle }> = {
  ok: { label: 'On track', badgeClass: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: CheckCircle2 },
  failing: { label: 'Failing', badgeClass: 'bg-destructive/10 text-destructive border-destructive/30', icon: AlertTriangle },
  orphaned: { label: 'Target missing', badgeClass: 'bg-destructive/10 text-destructive border-destructive/30', icon: ShieldAlert },
  stalled: { label: 'Not running', badgeClass: 'bg-amber-50 text-amber-700 border-amber-200', icon: ShieldQuestion },
};

function describeFrequency(row: StandingOrderRow): string {
  switch (row.frequency) {
    case 'daily': return 'Daily';
    case 'weekly': {
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      return `Weekly · ${days[row.day_of_week ?? 1]}`;
    }
    case 'interval': return `Every ${row.interval_days ?? 1} day(s)`;
    case 'monthly':
    default: return `Monthly · day ${row.day_of_month ?? 1}`;
  }
}

export function StandingOrdersPanel() {
  const { data: orders, isLoading, isFetching, refetch } = useStandingOrders();
  const setEnabled = useSetStandingOrderEnabled();
  const [filter, setFilter] = useState<'all' | 'attention'>('attention');

  const counts = useMemo(() => {
    const list = orders ?? [];
    return {
      total: list.length,
      attention: list.filter((o) => o.health !== 'ok').length,
      orphaned: list.filter((o) => o.health === 'orphaned').length,
      failing: list.filter((o) => o.health === 'failing').length,
      stalled: list.filter((o) => o.health === 'stalled').length,
    };
  }, [orders]);

  const visible = useMemo(() => {
    const list = orders ?? [];
    return filter === 'attention' ? list.filter((o) => o.health !== 'ok') : list;
  }, [orders, filter]);

  const handleToggle = (order: StandingOrderRow, next: boolean) => {
    setEnabled.mutate(
      { order, enabled: next },
      {
        onSuccess: () => toast.success(next ? 'Standing order resumed' : 'Standing order paused'),
        onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Failed to update standing order'),
      },
    );
  };

  return (
    <TooltipProvider>
      <Card className="rounded-2xl">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5" />
                Standing Orders
                {counts.attention > 0 && (
                  <Badge variant="destructive" className="text-[10px]">{counts.attention} need attention</Badge>
                )}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                {counts.total} automated payout{counts.total === 1 ? '' : 's'} on file
                {counts.orphaned > 0 && <> · <span className="text-destructive font-medium">{counts.orphaned} target missing</span></>}
                {counts.failing > 0 && <> · <span className="text-destructive font-medium">{counts.failing} failing</span></>}
                {counts.stalled > 0 && <> · <span className="text-amber-700 font-medium">{counts.stalled} not running</span></>}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant={filter === 'attention' ? 'default' : 'outline'}
                size="sm" className="h-7 text-xs"
                onClick={() => setFilter('attention')}
              >
                Needs attention
              </Button>
              <Button
                variant={filter === 'all' ? 'default' : 'outline'}
                size="sm" className="h-7 text-xs"
                onClick={() => setFilter('all')}
              >
                All
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => refetch()} disabled={isFetching}>
                {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />} Refresh
              </Button>
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : !visible.length ? (
            <div className="text-center py-6">
              <CheckCircle2 className="h-8 w-8 mx-auto mb-2 text-emerald-600" />
              <p className="text-sm text-muted-foreground">
                {filter === 'attention' ? 'No standing orders need attention.' : 'No standing orders on file.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Schedule</TableHead>
                    <TableHead>Next run</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Active</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((row) => {
                    const meta = HEALTH_META[row.health];
                    const Icon = meta.icon;
                    return (
                      <TableRow key={row.id} className={cn(row.health !== 'ok' && 'bg-destructive/[0.03]')}>
                        <TableCell className="min-w-[160px]">
                          <div className="font-medium">
                            {row.target_missing ? (
                              <span className="text-destructive">Unknown user</span>
                            ) : (row.target_name || row.target_phone || row.target_user_id)}
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate max-w-[220px]">{row.reason}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">UGX {Number(row.amount).toLocaleString()}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">{describeFrequency(row)}</TableCell>
                        <TableCell className="text-xs whitespace-nowrap">
                          {row.next_run_at ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span>{formatDistanceToNow(new Date(row.next_run_at), { addSuffix: true })}</span>
                              </TooltipTrigger>
                              <TooltipContent>{format(new Date(row.next_run_at), 'MMM d, yyyy HH:mm')}</TooltipContent>
                            </Tooltip>
                          ) : '—'}
                        </TableCell>
                        <TableCell>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Badge variant="outline" className={cn('text-[10px] gap-1', meta.badgeClass)}>
                                <Icon className="h-3 w-3" /> {meta.label}
                                {row.consecutive_failures > 1 && ` ×${row.consecutive_failures}`}
                              </Badge>
                            </TooltipTrigger>
                            {(row.last_run_error || row.target_missing) && (
                              <TooltipContent className="max-w-xs">
                                {row.target_missing
                                  ? `target_user_id ${row.target_user_id} has no matching profile/account`
                                  : row.last_run_error}
                              </TooltipContent>
                            )}
                          </Tooltip>
                        </TableCell>
                        <TableCell className="text-right">
                          <Switch
                            checked={row.enabled}
                            onCheckedChange={(v) => handleToggle(row, v)}
                            disabled={setEnabled.isPending}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </TooltipProvider>
  );
}
