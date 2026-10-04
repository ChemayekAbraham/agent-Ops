/**
 * ProxyAgentTargetPanel — one monthly target that applies to EVERY proxy agent.
 *
 * Partner Ops picks a month, a plain-language goal and a number. Progress is
 * read from a single aggregate RPC (never per-agent fan-out) so it stays fast
 * with 1,000,000+ proxy agents.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Target } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { formatUGX } from '@/lib/rentCalculations';
import {
  fetchProxyTargetOverview,
  setProxyTarget,
  PROXY_TARGET_METRICS,
  type ProxyTargetMetric,
} from './proxyAgentDirectory';

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export function ProxyAgentTargetPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [month, setMonth] = useState(thisMonth());
  const [metric, setMetric] = useState<ProxyTargetMetric>('partners_came_in');
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');

  const overview = useQuery({
    queryKey: ['proxy-agent-target-overview', month],
    queryFn: () => fetchProxyTargetOverview(month),
    staleTime: 60_000,
  });

  const meta = PROXY_TARGET_METRICS.find((m) => m.key === metric)!;
  const target = overview.data?.targets?.[metric]?.target_value ?? 0;
  const stats = overview.data?.metrics?.[metric];
  const agents = overview.data?.agents_total ?? 0;

  const fmt = (n: number) => (meta.money ? formatUGX(n) : n.toLocaleString());

  const expected = target * agents;
  const achieved = Number(stats?.achieved_total ?? 0);
  const pace = expected > 0 ? Math.min(100, Math.round((achieved / expected) * 100)) : 0;
  const hit = stats?.hit ?? 0;
  const started = stats?.started ?? 0;
  const behind = Math.max(0, agents - hit);

  const save = useMutation({
    mutationFn: () => setProxyTarget({ metric, month, target: Number(value), note }),
    onSuccess: () => {
      toast({ title: 'Target set for every proxy agent' });
      setOpen(false);
      setValue('');
      setNote('');
      void qc.invalidateQueries({ queryKey: ['proxy-agent-target-overview'] });
    },
    onError: (e: any) =>
      toast({ title: 'Could not save target', description: e.message, variant: 'destructive' }),
  });

  const monthLabel = useMemo(
    () =>
      new Date(`${month}-01T00:00:00`).toLocaleDateString(undefined, {
        month: 'long',
        year: 'numeric',
      }),
    [month],
  );

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-sm font-bold">
              <Target className="h-4 w-4 text-primary" />
              Target for every proxy agent
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              One goal, applied to all {agents.toLocaleString()} active proxy agents in {monthLabel}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="month"
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              className="h-8 w-[150px] text-xs"
              aria-label="Target month"
            />
            <Select value={metric} onValueChange={(v) => setMetric(v as ProxyTargetMetric)}>
              <SelectTrigger className="h-8 w-[220px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROXY_TARGET_METRICS.map((m) => (
                  <SelectItem key={m.key} value={m.key} className="text-xs">
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setValue(target ? String(target) : '');
                setNote(overview.data?.targets?.[metric]?.note ?? '');
                setOpen(true);
              }}
            >
              {target ? 'Change target' : 'Set target'}
            </Button>
          </div>
        </div>

        {overview.isLoading ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : target === 0 ? (
          <div className="rounded-xl border border-dashed p-4 text-center">
            <p className="text-xs font-semibold">No target set for {monthLabel}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{meta.helper}</p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {[
                { label: 'Target each', value: fmt(target), tone: '' },
                { label: 'Done so far', value: fmt(achieved), tone: '' },
                { label: 'Agents who hit it', value: hit.toLocaleString(), tone: 'text-emerald-600' },
                { label: 'Still behind', value: behind.toLocaleString(), tone: 'text-amber-600' },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border bg-muted/40 p-2.5">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                    {s.label}
                  </p>
                  <p className={`mt-0.5 truncate text-base font-bold tabular-nums ${s.tone}`}>{s.value}</p>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[11px]">
                <span className="font-semibold">
                  Whole team: {fmt(achieved)} of {fmt(expected)}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {pace}% of the month's goal
                </Badge>
              </div>
              <Progress value={pace} className="h-2" />
              <p className="text-[11px] text-muted-foreground">
                {started.toLocaleString()} agent(s) have started. {meta.helper}
              </p>
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={open} onOpenChange={(o) => !save.isPending && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Set the {monthLabel} target</DialogTitle>
            <DialogDescription className="text-xs">
              Every active proxy agent gets this same goal. {meta.helper}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">Goal</Label>
              <Select value={metric} onValueChange={(v) => setMetric(v as ProxyTargetMetric)}>
                <SelectTrigger className="text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROXY_TARGET_METRICS.map((m) => (
                    <SelectItem key={m.key} value={m.key} className="text-xs">
                      {m.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="pat-value" className="text-xs">
                {meta.money ? 'Amount per agent (UGX)' : 'Number per agent'}
              </Label>
              <Input
                id="pat-value"
                type="number"
                min={1}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={meta.money ? 'e.g. 2000000' : 'e.g. 3'}
                className="text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pat-note" className="text-xs">
                Note for the team (optional)
              </Label>
              <Textarea
                id="pat-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="text-xs"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-9 text-xs"
              disabled={!(Number(value) > 0) || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Save target
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default ProxyAgentTargetPanel;
