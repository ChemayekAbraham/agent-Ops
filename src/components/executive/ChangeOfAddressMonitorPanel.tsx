import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  ArrowRightLeft, RefreshCw, CheckCircle2, Clock, XCircle, AlertTriangle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

interface Check {
  path: string;
  ok: boolean;
  firstStatus: number | null;
  isPermanent: boolean;
  finalUrl: string | null;
  finalStatus: number | null;
  location: string | null;
  error?: string;
}
interface MonitorRow {
  old_domain: string;
  new_domain: string;
  status: string;
  redirect_healthy: boolean;
  consecutive_healthy: number;
  checks: Check[];
  last_action: string | null;
  last_action_at: string | null;
  redirect_first_seen_at: string | null;
  ready_at: string | null;
  verified_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
}

function statusMeta(status: string) {
  switch (status) {
    case 'verified':
      return { icon: CheckCircle2, variant: 'default' as const, label: 'Consolidation verified' };
    case 'ready_to_submit':
      return { icon: CheckCircle2, variant: 'default' as const, label: 'Ready — submit in Search Console' };
    case 'redirect_live':
      return { icon: Clock, variant: 'secondary' as const, label: 'Redirect live — stabilising' };
    default:
      return { icon: AlertTriangle, variant: 'outline' as const, label: 'Awaiting redirect' };
  }
}

export function ChangeOfAddressMonitorPanel() {
  const [running, setRunning] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['change-of-address-monitor'],
    queryFn: async (): Promise<MonitorRow | null> => {
      const { data, error } = await supabase
        .from('change_of_address_monitor')
        .select('*')
        .eq('old_domain', 'welilereceipts.com')
        .eq('new_domain', 'welileapp.com')
        .maybeSingle();
      if (error) throw error;
      return data as unknown as MonitorRow | null;
    },
  });

  const runCheck = async () => {
    setRunning(true);
    try {
      const { error } = await supabase.functions.invoke('change-of-address-monitor', { body: {} });
      if (error) throw error;
      await refetch();
      toast.success('Redirect check complete');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setRunning(false);
    }
  };

  const meta = data ? statusMeta(data.status) : null;
  const StatusIcon = meta?.icon ?? Clock;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
          Change of Address — welilereceipts.com → welileapp.com
        </CardTitle>
        <Button size="sm" variant="outline" onClick={runCheck} disabled={running}>
          <RefreshCw className={`h-4 w-4 ${running ? 'animate-spin' : ''}`} />
          <span className="ml-2">Run check</span>
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : !data ? (
          <p className="text-sm text-muted-foreground">
            No monitor data yet. Click “Run check” to evaluate the redirect now.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={meta!.variant} className="gap-1">
                <StatusIcon className="h-3.5 w-3.5" />
                {meta!.label}
              </Badge>
              <span className="text-xs text-muted-foreground">
                Healthy checks in a row: {data.consecutive_healthy}
              </span>
              {data.last_checked_at && (
                <span className="text-xs text-muted-foreground">
                  Last checked {formatDistanceToNow(new Date(data.last_checked_at), { addSuffix: true })}
                </span>
              )}
            </div>

            {data.status === 'ready_to_submit' && (
              <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                Redirect is live and stable. In Search Console, open the{' '}
                <strong>welilereceipts.com</strong> property → <strong>Settings → Change of Address</strong>,
                pick <strong>welileapp.com</strong> as the destination, then Validate &amp; Submit. The
                sitemap has been re-submitted automatically.
              </div>
            )}

            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Path</TableHead>
                  <TableHead>First hop</TableHead>
                  <TableHead>Final</TableHead>
                  <TableHead className="text-right">Redirect</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.checks?.map((c) => (
                  <TableRow key={c.path}>
                    <TableCell className="font-mono text-xs">{c.path}</TableCell>
                    <TableCell className="text-xs">
                      {c.firstStatus ?? '—'}{c.isPermanent ? ' (301/308)' : ''}
                    </TableCell>
                    <TableCell className="text-xs">
                      {c.finalStatus ?? '—'}
                      {c.error ? <span className="text-destructive"> · {c.error.slice(0, 40)}</span> : ''}
                    </TableCell>
                    <TableCell className="text-right">
                      {c.ok ? (
                        <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-500" />
                      ) : (
                        <XCircle className="ml-auto h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <p className="text-xs text-muted-foreground">
              Runs automatically every 3 hours. When all rows show a permanent 301 landing on
              welileapp.com, the consolidation actions are re-run and this panel turns green.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}