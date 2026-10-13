import { useState } from 'react';
import FoodLoadError from '@/components/food/FoodLoadError';
import { CalendarOff, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useFoodServicePeriods, useFoodClosures, useUpsertFoodServicePeriod, useSetFoodClosure,
  foodToday,
} from '@/hooks/useFoodService';

const EMPTY_PERIOD = { name: '', opensAt: '', closesAt: '', instructions: '', maxQty: '' };

export default function FoodServicePanel({ canAuthor }: { canAuthor: boolean }) {
  const periodsQ = useFoodServicePeriods(true);
  const { data: periods, isLoading } = periodsQ;
  const closuresQ = useFoodClosures();
  const { data: closures } = closuresQ;
  const upsertPeriod = useUpsertFoodServicePeriod();
  const setClosure = useSetFoodClosure();

  const [p, setP] = useState(EMPTY_PERIOD);
  const [closure, setClosureForm] = useState({ date: '', reason: '' });

  // mirrors the server: ordering must close after it opens
  const timesValid = p.opensAt !== '' && p.closesAt !== '' && p.closesAt > p.opensAt;
  const maxValid = p.maxQty === '' || Number(p.maxQty) > 0;
  const periodValid = p.name.trim().length > 0 && timesValid && maxValid;

  const closureValid = closure.date !== '' && closure.reason.trim().length > 0;

  return (
    <div className="space-y-6">
      <FoodLoadError queries={[periodsQ, closuresQ]} />
      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Clock className="h-4 w-4" aria-hidden="true" />
          Service periods
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          When ordering opens and closes, and how much one person may order. Times are
          in Kampala.
        </p>

        {isLoading ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : (periods ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            No service periods yet. Add one before publishing a menu.
          </p>
        ) : (
          <ul className="mb-3 divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {(periods ?? []).map((period) => (
              <li key={period.id} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{period.name}</p>
                      {!period.active && (
                        <Badge variant="outline" className="border-border bg-muted text-muted-foreground">
                          inactive
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {period.ordering_opens_at} – {period.ordering_closes_at}
                      {period.max_qty_per_employee !== null && (
                        <> &middot; max {period.max_qty_per_employee} per person</>
                      )}
                    </p>
                  </div>
                  <Button
                    size="sm" variant="ghost" disabled={!canAuthor}
                    onClick={() => upsertPeriod.mutate({
                      periodId: period.id,
                      name: period.name,
                      opensAt: period.ordering_opens_at,
                      closesAt: period.ordering_closes_at,
                      collectionInstructions: period.collection_instructions,
                      maxQtyPerEmployee: period.max_qty_per_employee,
                      active: !period.active,
                    })}
                  >
                    {period.active ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
                {period.collection_instructions && (
                  <p className="mt-1 text-xs italic text-muted-foreground">
                    {period.collection_instructions}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 rounded-xl border border-border/70 bg-card p-3 sm:grid-cols-5">
          <Input
            placeholder="Name" value={p.name} disabled={!canAuthor}
            onChange={(e) => setP((s) => ({ ...s, name: e.target.value }))}
          />
          <div className="space-y-1">
            <Label htmlFor="opens" className="sr-only">Opens</Label>
            <Input
              id="opens" type="time" value={p.opensAt} disabled={!canAuthor}
              onChange={(e) => setP((s) => ({ ...s, opensAt: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="closes" className="sr-only">Closes</Label>
            <Input
              id="closes" type="time" value={p.closesAt} disabled={!canAuthor}
              onChange={(e) => setP((s) => ({ ...s, closesAt: e.target.value }))}
            />
          </div>
          <Input
            type="number" min={1} placeholder="Max each" value={p.maxQty} disabled={!canAuthor}
            onChange={(e) => setP((s) => ({ ...s, maxQty: e.target.value }))}
          />
          <Button
            disabled={!canAuthor || !periodValid || upsertPeriod.isPending}
            onClick={() => upsertPeriod.mutate(
              {
                name: p.name.trim(),
                opensAt: p.opensAt,
                closesAt: p.closesAt,
                collectionInstructions: p.instructions.trim() || null,
                maxQtyPerEmployee: p.maxQty === '' ? null : Number(p.maxQty),
              },
              { onSuccess: () => setP(EMPTY_PERIOD) },
            )}
          >
            Add period
          </Button>
          <Input
            className="sm:col-span-5"
            placeholder="Collection instructions (optional)"
            value={p.instructions} disabled={!canAuthor}
            onChange={(e) => setP((s) => ({ ...s, instructions: e.target.value }))}
          />
          {p.opensAt !== '' && p.closesAt !== '' && !timesValid && (
            <p className="text-[11px] text-destructive sm:col-span-5">
              Ordering must close after it opens.
            </p>
          )}
          {!maxValid && (
            <p className="text-[11px] text-destructive sm:col-span-5">
              The per-person limit must be at least 1.
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <CalendarOff className="h-4 w-4" aria-hidden="true" />
          Closures
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Days the canteen is shut. A day cannot be closed while orders for it are
          still outstanding.
        </p>

        {(closures ?? []).length === 0 ? (
          <p className="mb-3 rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            No closures scheduled.
          </p>
        ) : (
          <ul className="mb-3 divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {(closures ?? []).map((c) => (
              <li key={c.closure_date} className="flex items-center justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {new Date(`${c.closure_date}T00:00:00`).toLocaleDateString('en-GB', {
                      weekday: 'short', day: 'numeric', month: 'short',
                    })}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{c.reason}</p>
                </div>
                <Button
                  size="sm" variant="ghost" disabled={!canAuthor}
                  onClick={() => setClosure.mutate({
                    closureDate: c.closure_date, closed: false, reason: 'Reopened',
                  })}
                >
                  Reopen
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="grid gap-2 rounded-xl border border-border/70 bg-card p-3 sm:grid-cols-4">
          <Input
            type="date" min={foodToday()} value={closure.date} disabled={!canAuthor}
            onChange={(e) => setClosureForm((s) => ({ ...s, date: e.target.value }))}
          />
          <Input
            className="sm:col-span-2"
            placeholder="Reason (required)" value={closure.reason} disabled={!canAuthor}
            onChange={(e) => setClosureForm((s) => ({ ...s, reason: e.target.value }))}
          />
          <Button
            variant="outline"
            disabled={!canAuthor || !closureValid || setClosure.isPending}
            onClick={() => setClosure.mutate(
              { closureDate: closure.date, closed: true, reason: closure.reason.trim() },
              { onSuccess: () => setClosureForm({ date: '', reason: '' }) },
            )}
          >
            Close day
          </Button>
          {closure.date !== '' && closure.reason.trim() === '' && (
            <p className="text-[11px] text-destructive sm:col-span-4">
              A reason is required to close a service day.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
