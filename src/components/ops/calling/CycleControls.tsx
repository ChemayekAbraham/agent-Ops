import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { ccErrorText, type CcCallingHub } from '@/hooks/useCcCallingHub';

/** Visible only to operations / hr / super_admin. */
export function CycleControls({ hub }: { hub: CcCallingHub }) {
  const [population, setPopulation] = useState('');
  const [limit, setLimit] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [abandonOpen, setAbandonOpen] = useState(false);
  const [abandonReason, setAbandonReason] = useState('');
  if (!hub.canManageCycles) return null;


  const p = hub.progress;
  const titleOk = title.trim().length >= 3;
  const cycleTitle = p?.title ? String(p.title) : '';
  const cycleDescription = p?.description ? String(p.description) : '';

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
            disabled={!population || !titleOk || hub.openCycle.isPending}
            onClick={() =>
              hub.openCycle.mutate(
                {
                  populationCode: population,
                  limit: limit ? Number(limit) : null,
                  title: title.trim(),
                  description: description.trim() || null,
                },
                {
                  onSuccess: () => {
                    toast.success('Cycle opened.');
                    setTitle('');
                    setDescription('');
                  },
                  onError: (e) => toast.error(ccErrorText(e)),
                },
              )
            }
          >
            Open cycle
          </Button>
        </div>
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label className="text-xs">Title (required)</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What is this cycle for?"
            maxLength={120}
          />
          {!titleOk && (
            <p className="text-[11px] text-muted-foreground">At least 3 characters — a cycle must say what it is for.</p>
          )}
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">Description (optional)</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Longer purpose, scope or instructions for callers"
          />
        </div>
      </div>


      {hub.cycle && (
        <div className="mt-3 space-y-2 rounded-xl border border-border/60 p-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <Badge variant="secondary">Cycle #{hub.cycle.cycle_no}</Badge>
            {cycleTitle && (
              <span className="font-semibold" title={cycleDescription ?? undefined}>
                {cycleTitle}
              </span>
            )}
            {cycleDescription && (
              <span className="w-full text-[11px] text-muted-foreground">{cycleDescription}</span>
            )}
            <Badge variant="outline">{Number(p?.total_rows ?? 0)} rows</Badge>
            <Badge variant="outline">Coverage {p?.coverage_pct ?? 0}%</Badge>
            <Badge variant="outline">Reach {p?.reach_pct ?? 0}%</Badge>
            
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={hub.closeCycle.isPending}
            onClick={() =>
              hub.closeCycle.mutate(hub.cycle!.id, {
                onSuccess: () => toast.success('Cycle closed.'),
                onError: (e) => toast.error(ccErrorText(e)),
              })
            }
          >
            Close cycle
          </Button>

          {/* Abandon is destructive and deliberately separated from Close. */}
          <div className="mt-2 space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2">
            <p className="text-[11px] font-semibold text-destructive">Danger zone</p>
            <p className="text-[11px] text-muted-foreground">
              Abandoning ends this cycle without the roster being worked. It is not the same as closing it, and it
              cannot be undone.
            </p>
            {!abandonOpen ? (
              <Button size="sm" variant="destructive" className="h-7 px-2 text-[11px]" onClick={() => setAbandonOpen(true)}>
                Abandon cycle
              </Button>
            ) : (
              <div className="space-y-2">
                <Label className="text-[11px]">Reason (required)</Label>
                <Textarea
                  value={abandonReason}
                  onChange={(e) => setAbandonReason(e.target.value)}
                  rows={2}
                  placeholder="Why is this cycle being abandoned?"
                />
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7 px-2 text-[11px]"
                    disabled={hub.abandonCycle.isPending}
                    onClick={() => {
                      if (!abandonReason.trim()) {
                        toast.error('A reason is required to abandon a cycle.');
                        return;
                      }
                      hub.abandonCycle.mutate(
                        { cycleId: hub.cycle!.id, reason: abandonReason.trim() },
                        {
                          onSuccess: () => {
                            toast.success('Cycle abandoned.');
                            setAbandonOpen(false);
                            setAbandonReason('');
                          },
                          onError: (e) => toast.error(ccErrorText(e)),
                        },
                      );
                    }}
                  >
                    Confirm abandon
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px]"
                    onClick={() => {
                      setAbandonOpen(false);
                      setAbandonReason('');
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>


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
