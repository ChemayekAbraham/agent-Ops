import { useState } from 'react';
import { History, Lock, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  useFoodAuditHistory, useFoodExceptions, useResolveFoodException, useRaiseFoodException,
  useFoodOrders, FOOD_EXCEPTION_KINDS, FOOD_EXCEPTION_KIND_LABEL, FOOD_MAX_EXCEPTION_NOTE,
  type FoodException, type FoodExceptionKind,
} from '@/hooks/useFoodService';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** 'status_published' → 'status published' */
function readable(action: string): string {
  return action.replace(/_/g, ' ');
}

function kindLabel(kind: string): string {
  return FOOD_EXCEPTION_KIND_LABEL[kind as FoodExceptionKind] ?? readable(kind);
}

/**
 * Every field of the original evidence, not only `note` (FM-26e). The evidence
 * is never rewritten when an exception is resolved, so all of it is shown.
 */
function Evidence({ e, orderRef }: { e: FoodException; orderRef: (id: string) => string }) {
  const entries = Object.entries(e.detail ?? {});
  return (
    <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
      {e.order_id && <p>Order {orderRef(e.order_id)}</p>}
      {e.raised_via && (
        <p>{e.raised_via === 'employee' ? 'Reported by the employee' : 'Logged by the Food Coordinator'}</p>
      )}
      {entries.map(([k, v]) => (
        <p key={k}>
          {k === 'note' ? '' : <span className="font-medium">{readable(k)}: </span>}
          {typeof v === 'string' ? v : JSON.stringify(v)}
        </p>
      ))}
    </div>
  );
}

export default function FoodAuditPanel({ canAuthor = false }: { canAuthor?: boolean }) {
  const { data: audit, isLoading } = useFoodAuditHistory();
  const { data: exceptions } = useFoodExceptions();
  const resolve = useResolveFoodException();

  const [target, setTarget] = useState<FoodException | null>(null);
  const [reason, setReason] = useState('');

  // logging a new exception (FM-21): active coordinator only, server-enforced
  const raise = useRaiseFoodException();
  const { data: todaysOrders } = useFoodOrders(undefined, canAuthor);
  const [newKind, setNewKind] = useState<FoodExceptionKind | ''>('');
  const [newOrder, setNewOrder] = useState('');
  const [newNote, setNewNote] = useState('');
  const newNoteOk = newNote.trim().length > 0 && newNote.trim().length <= FOOD_MAX_EXCEPTION_NOTE;
  const orderRef = (id: string) =>
    (todaysOrders ?? []).find((o) => o.id === id)?.order_reference ?? id.slice(0, 8);

  const open = (exceptions ?? []).filter((e) => !e.resolved_at);
  const closed = (exceptions ?? []).filter((e) => e.resolved_at);

  // The server decides this from the session; this only avoids offering a
  // control that would be refused.
  const reasonOk = reason.trim().length > 0;

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <TriangleAlert className="h-4 w-4" aria-hidden="true" />
          Exceptions
        </h2>
        <p className="mb-3 text-xs text-muted-foreground">
          Issues raised during service that still need attention. Employees can report a
          problem with their own order; you can log any issue. Nothing here changes an
          order's payment or status.
        </p>

        {canAuthor && (
          <div className="mb-4 space-y-2 rounded-xl border border-border/70 bg-card p-3">
            <p className="text-xs font-medium">Log an exception</p>
            <div className="flex flex-wrap gap-2">
              <select
                aria-label="Exception kind"
                value={newKind}
                onChange={(ev) => setNewKind(ev.target.value as FoodExceptionKind)}
                className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">Kind…</option>
                {FOOD_EXCEPTION_KINDS.map((k) => (
                  <option key={k} value={k}>{FOOD_EXCEPTION_KIND_LABEL[k]}</option>
                ))}
              </select>
              <select
                aria-label="Related order (optional)"
                value={newOrder}
                onChange={(ev) => setNewOrder(ev.target.value)}
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm"
              >
                <option value="">No specific order</option>
                {(todaysOrders ?? []).map((o) => (
                  <option key={o.id} value={o.id}>{o.order_reference}</option>
                ))}
              </select>
            </div>
            <Textarea
              aria-label="Exception description"
              rows={2}
              maxLength={FOOD_MAX_EXCEPTION_NOTE}
              placeholder="What happened?"
              value={newNote}
              onChange={(ev) => setNewNote(ev.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!newKind || !newNoteOk || raise.isPending}
              onClick={() => newKind && raise.mutate(
                { kind: newKind, note: newNote.trim(), orderId: newOrder || null },
                { onSuccess: () => { setNewKind(''); setNewOrder(''); setNewNote(''); } },
              )}
            >
              Log exception
            </Button>
          </div>
        )}

        {open.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            Nothing outstanding.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {open.map((e) => (
              <li key={e.id} className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="outline" className="border-warning/30 bg-warning/10 text-warning-foreground dark:text-warning">
                    {kindLabel(e.kind)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{when(e.created_at)}</span>
                </div>
                <Evidence e={e} orderRef={orderRef} />
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-2"
                  disabled={!canAuthor}
                  title={canAuthor ? undefined : 'Only the active Food Coordinator can resolve an exception'}
                  onClick={() => { setTarget(e); setReason(''); }}
                >
                  Resolve
                </Button>
              </li>
            ))}
          </ul>
        )}

        {closed.length > 0 && (
          <>
            <h3 className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Resolved
            </h3>
            <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
              {closed.map((e) => (
                <li key={e.id} className="p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm">{kindLabel(e.kind)}</span>
                    <span className="text-xs text-muted-foreground">
                      {e.resolved_at ? when(e.resolved_at) : ''}
                    </span>
                  </div>
                  {/* the original evidence is kept alongside the reason */}
                  <Evidence e={e} orderRef={orderRef} />
                  {e.resolution_reason && (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">
                      Resolved: {e.resolution_reason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section>
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <History className="h-4 w-4" aria-hidden="true" />
          Audit history
        </h2>
        <p className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="h-3 w-3" aria-hidden="true" />
          Permanent record. Entries cannot be edited or removed by anyone.
        </p>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : (audit ?? []).length === 0 ? (
          <p className="rounded-xl border border-dashed border-border/70 p-6 text-center text-xs text-muted-foreground">
            Nothing recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 overflow-hidden rounded-xl border border-border/70 bg-card">
            {(audit ?? []).map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 p-3">
                <div className="min-w-0">
                  <p className="text-sm">
                    <span className="font-medium capitalize">{row.entity}</span>{' '}
                    <span className="text-muted-foreground">{readable(row.action)}</span>
                  </p>
                  {row.reason && (
                    <p className="mt-0.5 text-xs italic text-muted-foreground">{row.reason}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {when(row.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog open={!!target} onOpenChange={(o) => !o && setTarget(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve this exception</DialogTitle>
            <DialogDescription>
              The original record is kept. Your reason and your name are written to
              the permanent history and cannot be changed afterwards.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="resolution-reason">What was done?</Label>
            <Textarea
              id="resolution-reason"
              rows={3}
              value={reason}
              maxLength={300}
              placeholder="Substituted two portions and told the employees at the counter"
              onChange={(e) => setReason(e.target.value)}
            />
            {!reasonOk && (
              <p className="text-[11px] text-muted-foreground">A reason is required.</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>Cancel</Button>
            <Button
              disabled={!reasonOk || resolve.isPending}
              onClick={() => {
                if (!target) return;
                resolve.mutate(
                  { exceptionId: target.id, reason: reason.trim() },
                  { onSuccess: () => { setTarget(null); setReason(''); } },
                );
              }}
            >
              Resolve exception
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
