import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import type { CcCallingHub } from '@/hooks/useCcCallingHub';

/** Visible only to operations / hr / super_admin. */
export function CycleControls({ hub }: { hub: CcCallingHub }) {
  const [population, setPopulation] = useState('');
  const [limit, setLimit] = useState('');
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandonReason, setAbandonReason] = useState('');
  if (!hub.canManageCycles) return null;


  const p = hub.progress;

  return (
    <Card className="rounded-2xl border-border/60 p-3 sm:p-4">
      <h3 className="mb-2 text-sm font-bold">Cycle controls</h3>

      <div className="grid gap-2 sm:grid-cols-[1fr_120px_auto]">
        <div className="space-y-1.5">
          <Label className="text-xs">Population</Label>
          <Select value={population} onValueChange={setPopulation}>
            <SelectTrigger><SelectValue placeholder="Choose a population" /></SelectTrigger>
            <SelectContent>
              {hub.populations.map((pop: any) => (
                <SelectItem key={pop.code} value={pop.code}>{pop.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Limit</Label>
          <Input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="all" inputMode="numeric" />
        </div>
        <div className="flex items-end">
          <Button
            className="w-full"
            disabled={!population || hub.openCycle.isPending}
            onClick={() =>
              hub.openCycle.mutate(
                { populationCode: population, limit: limit ? Number(limit) : null },
                {
                  onSuccess: () => toast.success('Cycle opened.'),
                  onError: (e) => toast.error((e as Error).message),
                },
              )
            }
          >
            Open cycle
          </Button>
        </div>
      </div>

      {hub.cycle && (
        <div className="mt-3 space-y-2 rounded-xl border border-border/60 p-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="secondary">Cycle #{hub.cycle.cycle_no}</Badge>
            <Badge variant="outline">{Number(p?.total_rows ?? 0)} rows</Badge>
            <Badge variant="outline">Coverage {p?.coverage_pct ?? 0}%</Badge>
            <Badge variant="outline">Reach {p?.reach_pct ?? 0}%</Badge>
            <Badge variant="outline">Attempt cap {hub.cycle.attempt_cap}</Badge>
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={hub.closeCycle.isPending}
            onClick={() =>
              hub.closeCycle.mutate(hub.cycle!.id, {
                onSuccess: () => toast.success('Cycle closed.'),
                onError: (e) => toast.error((e as Error).message),
              })
            }
          >
            Close cycle
          </Button>

          {hub.outstanding && hub.outstanding.length > 0 && (
            <div className="rounded-lg bg-destructive/10 p-2">
              <p className="mb-1 text-xs font-semibold text-destructive">
                Outstanding roster rows blocking closure ({hub.outstanding.length})
              </p>
              <ul className="max-h-40 space-y-0.5 overflow-auto text-[11px]">
                {hub.outstanding.map((o: any) => (
                  <li key={String(o.cycle_row_id)} className="font-mono">
                    {String(o.state)} · attempts {String(o.attempts_made)} · row {String(o.cycle_row_id).slice(0, 8)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
