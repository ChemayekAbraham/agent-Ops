import { useEffect, useMemo, useState, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useAuth } from '@/hooks/useAuth';
import { getDuplicateEntries, deleteEntry, updateEntry, type FieldEntry } from '@/lib/fieldCollectStore';
import { formatUGX } from '@/lib/rentCalculations';
import { toast } from 'sonner';
import { AlertTriangle, Trash2, CheckCircle2, RefreshCcw, FileWarning } from 'lucide-react';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Reconciliation surface for field-collection entries that the server rejected
 * as duplicates of an already-uploaded receipt (idempotency-key collision with
 * mismatched values). Agent picks one of:
 *   • Keep server version  → drop the local copy
 *   • Discard local copy  → same as above (semantic only)
 *   • Keep both          → re-queue with a new client_uuid, server gets a fresh row
 */
export function FieldCollectReconciliationSheet({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const [items, setItems] = useState<FieldEntry[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    try {
      setItems(await getDuplicateEntries(user.id));
    } catch (e) {
      console.warn('FieldCollectReconciliationSheet refresh failed', e);
    }
  }, [user?.id]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const totalLocal = useMemo(() => items.reduce((s, e) => s + Number(e.amount || 0), 0), [items]);

  const handleKeepServer = async (e: FieldEntry) => {
    setBusyId(e.id);
    try {
      await deleteEntry(e.id);
      toast.success('Local copy discarded — server version kept');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to discard local copy');
    } finally { setBusyId(null); }
  };

  const handleKeepBoth = async (e: FieldEntry) => {
    setBusyId(e.id);
    try {
      // Re-queue under a brand-new idempotency key so it lands as a fresh server row.
      // The key is derived from the original (no timestamp) so that if the add
      // succeeds but the delete below fails, tapping "Keep both" again rewrites
      // the same local entry and the server dedupes on client_uuid, instead of
      // queuing a second copy of the receipt.
      const newId = `${e.id}-r`;
      await updateEntry(e.id, {
        // Mutating the primary key isn't supported via updateEntry — instead
        // re-add as a new entry and remove the old. We use a workaround by
        // writing a new entry and deleting the duplicate one.
      });
      // Workaround: import addEntry dynamically to avoid extra top-level imports.
      const store = await import('@/lib/fieldCollectStore');
      await store.addEntry({
        ...e,
        id: newId,
        syncState: 'queued',
        syncError: null,
        serverId: null,
        duplicateOfServerId: null,
        duplicateServerSnapshot: null,
      });
      await deleteEntry(e.id);
      toast.success('Re-queued as a new receipt — will sync on next attempt');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to re-queue receipt');
      await refresh();
    } finally { setBusyId(null); }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[88vh] flex flex-col p-0">
        <SheetHeader className="px-4 pt-4 pb-2 border-b">
          <SheetTitle className="flex items-center gap-2">
            <FileWarning className="h-5 w-5 text-amber-500" />
            Reconcile duplicate receipts
          </SheetTitle>
          <SheetDescription>
            These offline entries were rejected because the same receipt was already on the server with different details.
            Choose which version to keep.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {items.length} duplicate{items.length === 1 ? '' : 's'}
          </span>
          <span className="font-medium">{formatUGX(totalLocal)} disputed</span>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {items.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-emerald-500" />
                <p className="text-sm">No duplicates to reconcile</p>
              </div>
            ) : items.map((e) => {
              const snap = e.duplicateServerSnapshot;
              const amountDrift = snap ? Number(snap.amount) !== Number(e.amount) : false;
              return (
                <div key={e.id} className="border rounded-lg overflow-hidden">
                  <div className="px-3 py-2 bg-amber-50 dark:bg-amber-950/20 border-b flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                    <span className="text-xs font-medium truncate">
                      {e.tenantName || 'Walk-up'} · key {e.id.slice(0, 8)}…
                    </span>
                  </div>

                  <div className="grid grid-cols-2 divide-x text-xs">
                    {/* Local */}
                    <div className="p-3 space-y-1">
                      <Badge variant="secondary" className="text-[10px]">Local (offline)</Badge>
                      <div className="font-semibold text-base">{formatUGX(e.amount)}</div>
                      <div className="text-muted-foreground">
                        {new Date(e.capturedAt).toLocaleString()}
                      </div>
                      {e.notes && <div className="text-muted-foreground line-clamp-2">"{e.notes}"</div>}
                    </div>
                    {/* Server */}
                    <div className="p-3 space-y-1">
                      <Badge variant="outline" className="text-[10px]">On server</Badge>
                      {snap ? (
                        <>
                          <div className={`font-semibold text-base ${amountDrift ? 'text-amber-600' : ''}`}>
                            {formatUGX(snap.amount)}
                          </div>
                          <div className="text-muted-foreground">
                            {new Date(snap.capturedAt).toLocaleString()}
                          </div>
                          <div className="text-muted-foreground">
                            Status: <span className="font-medium">{snap.status}</span>
                          </div>
                        </>
                      ) : (
                        <div className="text-muted-foreground italic">Snapshot unavailable</div>
                      )}
                    </div>
                  </div>

                  {amountDrift && (
                    <div className="px-3 py-1.5 bg-amber-100 dark:bg-amber-950/30 text-[11px] text-amber-800 dark:text-amber-300">
                      ⚠ Amount differs by {formatUGX(Math.abs(Number(snap!.amount) - Number(e.amount)))}
                    </div>
                  )}

                  <Separator />
                  <div className="p-2 grid grid-cols-2 gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleKeepServer(e)}
                      disabled={busyId === e.id}
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1" />
                      Keep server
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => handleKeepBoth(e)}
                      disabled={busyId === e.id}
                    >
                      <RefreshCcw className="h-3.5 w-3.5 mr-1" />
                      Keep both
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}