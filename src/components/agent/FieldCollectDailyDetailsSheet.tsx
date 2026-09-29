import { useEffect, useMemo, useState, useCallback } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/hooks/useAuth';
import { getEntries, type FieldEntry } from '@/lib/fieldCollectStore';
import { formatUGX } from '@/lib/rentCalculations';
import { CheckCircle2, Clock, AlertCircle, FileWarning, Users, CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type Filter = 'all' | 'synced' | 'pending';

/**
 * Read-only drill-down: today's field-collection entries grouped by tenant,
 * with a synced/pending tab filter. Reads from IndexedDB so it works offline.
 */
export function FieldCollectDailyDetailsSheet({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const [entries, setEntries] = useState<FieldEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    try {
      setEntries(await getEntries(user.id));
    } catch (e) {
      console.warn('FieldCollectDailyDetailsSheet refresh failed', e);
    }
  }, [user?.id]);

  useEffect(() => { if (open) refresh(); }, [open, refresh]);

  const today = useMemo(() => {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return entries.filter(e => e.capturedAt >= start.getTime());
  }, [entries]);

  const filtered = useMemo(() => {
    if (filter === 'synced') return today.filter(e => e.syncState === 'synced');
    if (filter === 'pending') return today.filter(e => e.syncState !== 'synced');
    return today;
  }, [today, filter]);

  const counts = useMemo(() => ({
    all: today.length,
    synced: today.filter(e => e.syncState === 'synced').length,
    pending: today.filter(e => e.syncState !== 'synced').length,
  }), [today]);

  // Group filtered entries by tenant key (tenantId, or name+phone for walk-ups)
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; phone: string | null; tenantId: string | null; items: FieldEntry[]; total: number }>();
    for (const e of filtered) {
      const key = e.tenantId || `walkup:${e.tenantName.toLowerCase()}|${e.tenantPhone || ''}`;
      const g = map.get(key) || { name: e.tenantName, phone: e.tenantPhone, tenantId: e.tenantId, items: [], total: 0 };
      g.items.push(e);
      g.total += Number(e.amount || 0);
      map.set(key, g);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [filtered]);

  const grandTotal = useMemo(() => filtered.reduce((s, e) => s + Number(e.amount || 0), 0), [filtered]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
        <SheetHeader className="px-4 pt-4 pb-2 border-b">
          <SheetTitle className="flex items-center gap-2">
            <CalendarDays className="h-5 w-5 text-primary" />
            Today's collections
          </SheetTitle>
          <SheetDescription>
            Grouped by tenant. Switch tabs to filter by sync status.
          </SheetDescription>
        </SheetHeader>

        <div className="px-4 py-3 border-b bg-muted/40">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-muted-foreground">
              {filtered.length} entr{filtered.length === 1 ? 'y' : 'ies'} · {groups.length} tenant{groups.length === 1 ? '' : 's'}
            </span>
            <span className="text-base font-bold">{formatUGX(grandTotal)}</span>
          </div>
          <Tabs value={filter} onValueChange={v => setFilter(v as Filter)}>
            <TabsList className="grid grid-cols-3 w-full h-8">
              <TabsTrigger value="all" className="text-xs">All ({counts.all})</TabsTrigger>
              <TabsTrigger value="synced" className="text-xs">Synced ({counts.synced})</TabsTrigger>
              <TabsTrigger value="pending" className="text-xs">Pending ({counts.pending})</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {groups.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <Users className="h-10 w-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No entries match this filter</p>
              </div>
            ) : groups.map((g, idx) => (
              <div key={idx} className="border rounded-lg overflow-hidden">
                <div className="px-3 py-2 bg-muted/30 border-b flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate flex items-center gap-1.5">
                      {!g.tenantId && <Badge variant="outline" className="text-[9px] px-1 py-0">Walk-up</Badge>}
                      {g.name}
                    </p>
                    {g.phone && <p className="text-[11px] text-muted-foreground truncate">{g.phone}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold">{formatUGX(g.total)}</p>
                    <p className="text-[10px] text-muted-foreground">{g.items.length} entr{g.items.length === 1 ? 'y' : 'ies'}</p>
                  </div>
                </div>
                <ul className="divide-y">
                  {g.items
                    .slice()
                    .sort((a, b) => b.capturedAt - a.capturedAt)
                    .map(e => (
                      <li key={e.id} className="px-3 py-2 flex items-center justify-between gap-2 text-xs">
                        <div className="flex items-center gap-2 min-w-0">
                          <StatusIcon state={e.syncState} />
                          <div className="min-w-0">
                            <p className="font-medium truncate">{formatUGX(e.amount)}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {new Date(e.capturedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              {e.notes ? ` · ${e.notes}` : ''}
                            </p>
                          </div>
                        </div>
                        <StatusLabel state={e.syncState} />
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function StatusIcon({ state }: { state: FieldEntry['syncState'] }) {
  if (state === 'synced') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />;
  if (state === 'error') return <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  if (state === 'duplicate') return <FileWarning className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
  return <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
}

function StatusLabel({ state }: { state: FieldEntry['syncState'] }) {
  const map: Record<FieldEntry['syncState'], { text: string; cls: string }> = {
    synced:    { text: 'Synced',    cls: 'text-emerald-600 dark:text-emerald-400' },
    queued:    { text: 'Pending',   cls: 'text-amber-600 dark:text-amber-400' },
    error:     { text: 'Failed',    cls: 'text-red-600 dark:text-red-400' },
    duplicate: { text: 'Duplicate', cls: 'text-amber-600 dark:text-amber-400' },
  };
  const { text, cls } = map[state];
  return <span className={cn('text-[10px] font-medium shrink-0', cls)}>{text}</span>;
}