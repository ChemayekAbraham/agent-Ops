import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Banknote, Loader2, Plus, Trash2, Wifi, WifiOff, CheckCircle2, AlertCircle, ChevronLeft } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { addEntry, deleteEntry, getEntries, newClientUuid, type FieldEntry } from '@/lib/fieldCollectStore';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { GlossaryTip } from '@/components/shared/GlossaryTip';

interface TenantFieldCollectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId: string;
  tenantName: string;
  tenantPhone: string | null;
}

/**
 * Per-tenant offline field collection dialog.
 * - Pre-bound to one tenant (no search needed).
 * - Records amount + notes; queues offline.
 * - Shows a SESSION running total: only entries captured since this dialog instance opened.
 * - Entries queue into the same shared offline store, so the global FAB picks them up for sync.
 */
export function TenantFieldCollectDialog({
  open, onOpenChange, tenantId, tenantName, tenantPhone,
}: TenantFieldCollectDialogProps) {
  const { user } = useAuth();
  const [online, setOnline] = useState<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true);
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [sessionStart, setSessionStart] = useState<number>(() => Date.now());
  const [entries, setEntries] = useState<FieldEntry[]>([]);

  /* Reset session each time dialog opens */
  useEffect(() => {
    if (open) {
      setSessionStart(Date.now());
      setAmount('');
      setNotes('');
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* Online/offline tracking */
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Never throws — see FieldCollectDialog.refreshEntries.
  const refresh = async () => {
    if (!user?.id) return;
    try {
      const all = await getEntries(user.id);
      setEntries(all.filter(e => e.tenantId === tenantId));
    } catch (e) {
      console.warn('refresh field entries failed', e);
    }
  };

  const sessionEntries = useMemo(
    () => entries.filter(e => e.capturedAt >= sessionStart),
    [entries, sessionStart]
  );
  const sessionTotal = useMemo(
    () => sessionEntries.reduce((s, e) => s + Number(e.amount || 0), 0),
    [sessionEntries]
  );

  const handleSave = async () => {
    if (!user?.id) return;
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Enter a valid amount');
      return;
    }
    setSaving(true);
    try {
      const entry: FieldEntry = {
        id: newClientUuid(),
        agentId: user.id,
        tenantId,
        tenantName,
        tenantPhone,
        amount: amt,
        notes: notes.trim() || null,
        capturedAt: Date.now(),
        syncState: 'queued',
      };
      await addEntry(entry);
      await refresh();
      setAmount('');
      setNotes('');
      toast.success(`Saved · ${formatUGX(amt)}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteEntry(id);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete entry');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[92vh] overflow-y-auto p-0">
        <Button
          variant="ghost"
          size="sm"
          className="absolute top-2 left-2 z-20 h-8 px-2 text-muted-foreground hover:text-foreground"
          onClick={() => onOpenChange(false)}
        >
          <ChevronLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <DialogHeader className="px-5 pt-10 pb-3 sticky top-0 bg-background z-10 border-b">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2 truncate">
                <Banknote className="h-5 w-5 text-primary shrink-0" />
                <span className="truncate">Collect from {tenantName}</span>
              </DialogTitle>
              <DialogDescription className="truncate">
                {tenantPhone || 'No phone on file'} · Works offline
              </DialogDescription>
            </div>
            <Badge
              variant={online ? 'default' : 'secondary'}
              className={cn('gap-1 shrink-0', !online && 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30')}
            >
              {online ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
              {online ? 'Online' : 'Offline'}
            </Badge>
          </div>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          <GlossaryTip
            terms={['Cash Collected', 'Float', 'Tracking ID']}
            intro="Tap any term for a plain-English reminder of what it means."
          />

          {/* Session running total */}
          <div className="rounded-2xl border bg-gradient-to-br from-primary/10 to-primary/5 p-4">
            <p className="text-xs text-muted-foreground">This session</p>
            <p className="text-3xl font-bold tracking-tight">{formatUGX(sessionTotal)}</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {sessionEntries.length} entr{sessionEntries.length === 1 ? 'y' : 'ies'} captured for this tenant
            </p>
          </div>

          {/* Inputs */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Amount (UGX)</Label>
            <Input
              value={amount}
              onChange={e => setAmount(e.target.value.replace(/[^\d]/g, ''))}
              inputMode="numeric"
              placeholder="e.g. 50000"
              className="text-lg font-semibold"
              autoFocus
            />
            <Label className="text-sm font-semibold pt-1">Notes (optional)</Label>
            <Input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. partial rent for May"
              maxLength={140}
            />
            <Button
              onClick={handleSave}
              disabled={saving || !amount}
              className="w-full gap-2"
              size="lg"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Save collection
            </Button>
          </div>

          <Separator />

          {/* Captured this session */}
          <div className="space-y-2">
            <Label className="text-sm font-semibold">Captured this session</Label>
            {sessionEntries.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                No collections yet. Add the first one above.
              </p>
            ) : (
              <ScrollArea className="max-h-56">
                <ul className="space-y-1.5 pr-2">
                  {sessionEntries.map(e => (
                    <li
                      key={e.id}
                      className="flex items-center justify-between gap-2 rounded-lg border bg-card px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <p className="text-sm font-semibold">{formatUGX(e.amount)}</p>
                          {e.syncState === 'synced' && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />}
                          {e.syncState === 'error' && <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
                          {e.syncState === 'queued' && <span className="h-1.5 w-1.5 rounded-full bg-amber-500 shrink-0" />}
                        </div>
                        <p className="text-[10px] text-muted-foreground truncate">
                          {new Date(e.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          {e.notes ? ` · ${e.notes}` : ''}
                        </p>
                      </div>
                      {e.syncState !== 'synced' && (
                        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleDelete(e.id)}>
                          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            Entries queue offline and sync from the <span className="font-semibold">Field Collect</span> button when you're back online.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default TenantFieldCollectDialog;