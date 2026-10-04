import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PhoneOff, Phone, Wallet, RefreshCw, FileDown } from 'lucide-react';
import { format, parseISO } from 'date-fns';

/**
 * Agents with tenants due today who have stopped collecting.
 *
 * Between 48% and 76% of agents who had tenants billed collected from nobody at
 * all, every day of the week of 21-27 September. Of 518 tenants billed over
 * those seven days, 238 had ZERO visits and account for 23.6m of the 44.7m
 * shortfall. Visits track coverage almost exactly: 0 visits gives 0%, 3.9
 * visits gives 73%. A visited tenant pays.
 *
 * Nothing else on this dashboard shows it. The Command Center above answers
 * "how much came in", the partial-collections panel only sees tenants who
 * already paid something, and the collection-lapse alert only fires after five
 * idle days.
 *
 * THE TWO GROUPS NEED OPPOSITE THINGS, which is why `blocker` is the first
 * thing rendered:
 *
 *   - "Needs float" — the agent spends their OWN float to settle a tenant's
 *     day, so a balance below today's bill is a hard stop rather than
 *     reluctance. One agent had 22 tenants due and 105 shillings. Ringing them
 *     is wasted breath; funding them is not.
 *
 *   - "Has float, silent" — they have the means and the tenants and stopped
 *     anyway. That is the call list.
 *
 * Landlord float is shown because the two populations overlap almost entirely:
 * on 28 September these agents held ~11.2m of it, essentially the whole
 * idle-float backlog. One conversation clears both problems.
 */

const THRESHOLDS = [3, 7, 14] as const;

interface SilentAgent {
  agent_id: string;
  agent_name: string | null;
  phone: string | null;
  days_silent: number;
  last_collected: string | null;
  tenants_today: number;
  owed_today: number;
  tenants_behind: number;
  arrears: number;
  collection_float: number;
  withdrawable: number;
  landlord_float_held: number;
  blocker: 'no_float' | 'silent_with_float';
}

const num = (v: unknown) => Number(v ?? 0) || 0;

function toCsv(rows: SilentAgent[]) {
  const head = [
    'agent', 'phone', 'days_silent', 'last_collected', 'tenants_today', 'owed_today',
    'tenants_behind', 'arrears', 'collection_float', 'withdrawable', 'landlord_float_held', 'blocker',
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map(r => [
    r.agent_name, r.phone, r.days_silent, r.last_collected ?? 'never', r.tenants_today,
    num(r.owed_today), r.tenants_behind, num(r.arrears), num(r.collection_float),
    num(r.withdrawable), num(r.landlord_float_held), r.blocker,
  ].map(esc).join(','));
  return [head.join(','), ...body].join('\n');
}

export function SilentCollectorsPanel() {
  const [minDays, setMinDays] = useState<number>(3);
  const [only, setOnly] = useState<'all' | 'silent_with_float' | 'no_float'>('all');

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['agent-ops-silent-collectors', minDays],
    queryFn: async () => {
      const { data, error } = await (supabase as never as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
      }).rpc('agent_ops_silent_collectors', { p_min_days_silent: minDays, p_limit: 200 });
      if (error) throw error;
      return (data ?? []) as SilentAgent[];
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const all = useMemo(() => data ?? [], [data]);
  const rows = useMemo(
    () => (only === 'all' ? all : all.filter(r => r.blocker === only)),
    [all, only],
  );

  const totals = useMemo(() => {
    const withFloat = all.filter(r => r.blocker === 'silent_with_float');
    const noFloat = all.filter(r => r.blocker === 'no_float');
    return {
      owed: all.reduce((s, r) => s + num(r.owed_today), 0),
      arrears: all.reduce((s, r) => s + num(r.arrears), 0),
      landlord: all.reduce((s, r) => s + num(r.landlord_float_held), 0),
      withFloat: withFloat.length,
      noFloat: noFloat.length,
      tenants: all.reduce((s, r) => s + num(r.tenants_today), 0),
    };
  }, [all]);

  const download = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `silent-collectors-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Card className="p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-auto flex items-center gap-2">
          <PhoneOff className="h-4 w-4 text-destructive" />
          <h3 className="text-sm font-semibold">Not collecting</h3>
          {isFetching && <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        {THRESHOLDS.map(t => (
          <Button
            key={t}
            size="sm"
            variant={minDays === t ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setMinDays(t)}
          >
            {t}d+ silent
          </Button>
        ))}
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={download} disabled={!rows.length}>
          <FileDown className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => void refetch()}>
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Agents with tenants billed <strong>today</strong> who have not recorded a collection for{' '}
        {minDays}+ days. A visited tenant pays — across last week, tenants with zero visits
        contributed <strong>23.6m of the 44.7m</strong> shortfall.
      </p>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Owed today" value={formatUGX(totals.owed)} />
        <Stat label="Tenants affected" value={String(totals.tenants)} />
        <Stat label="Already behind" value={formatUGX(totals.arrears)} tone="bad" />
        <Stat label="Landlord float held" value={formatUGX(totals.landlord)} tone="warn" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant={only === 'all' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setOnly('all')}>
          All {all.length}
        </Button>
        <Button size="sm" variant={only === 'silent_with_float' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setOnly('silent_with_float')}>
          <Phone className="mr-1 h-3 w-3" /> Call these {totals.withFloat}
        </Button>
        <Button size="sm" variant={only === 'no_float' ? 'default' : 'outline'} className="h-7 text-xs" onClick={() => setOnly('no_float')}>
          <Wallet className="mr-1 h-3 w-3" /> Needs float {totals.noFloat}
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">Could not load: {(error as Error).message}</p>}
      {!error && !isLoading && rows.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          Nobody is silent at this threshold. That is a good day.
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Agent</TableHead>
                <TableHead className="text-xs">Silent</TableHead>
                <TableHead className="text-right text-xs">Tenants</TableHead>
                <TableHead className="text-right text-xs">Owed today</TableHead>
                <TableHead className="text-right text-xs">Behind</TableHead>
                <TableHead className="text-right text-xs">Float</TableHead>
                <TableHead className="text-right text-xs">Landlord float</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(r => (
                <TableRow key={r.agent_id}>
                  <TableCell>
                    <div className="font-medium">{r.agent_name || '—'}</div>
                    {r.phone && (
                      <a href={`tel:${r.phone}`} className="inline-flex items-center gap-1 text-xs text-primary underline">
                        <Phone className="h-3 w-3" />{r.phone}
                      </a>
                    )}
                    <div className="mt-0.5">
                      {r.blocker === 'no_float' ? (
                        <Badge variant="outline" className="px-1 py-0 text-[9px]">
                          <Wallet className="mr-0.5 h-2.5 w-2.5" /> needs float
                        </Badge>
                      ) : (
                        <Badge variant="destructive" className="px-1 py-0 text-[9px]">has float — call</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">
                    {r.last_collected ? (
                      <>
                        <span className="font-semibold">{r.days_silent}d</span>
                        <div className="text-muted-foreground">
                          since {format(parseISO(r.last_collected), 'dd MMM')}
                        </div>
                      </>
                    ) : (
                      <span className="font-semibold text-destructive">never</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.tenants_today)}</TableCell>
                  <TableCell className="text-right tabular-nums font-semibold">{formatUGX(num(r.owed_today))}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {num(r.tenants_behind) > 0 ? (
                      <>
                        <div className="text-destructive">{formatUGX(num(r.arrears))}</div>
                        <div className="text-muted-foreground">{num(r.tenants_behind)} tenants</div>
                      </>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {formatUGX(num(r.collection_float))}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-xs">
                    {num(r.landlord_float_held) > 0
                      ? <span className="text-amber-600 dark:text-amber-400">{formatUGX(num(r.landlord_float_held))}</span>
                      : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' | 'warn' }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={`mt-0.5 text-sm font-bold tabular-nums ${
          tone === 'bad' ? 'text-destructive' : tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''
        }`}
      >
        {value}
      </div>
    </div>
  );
}

export default SilentCollectorsPanel;
