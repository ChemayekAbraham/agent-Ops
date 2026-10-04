/**
 * ENGREP P11 — Zone C · EXCEPTIONS, continuously displayed.
 *
 * This zone ignores the DAILY / WEEKLY / MONTHLY toggle and always reads the current
 * open window. Panel 2 renders no engineer identifier of any kind: nobody is credited
 * for an unclaimed object.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
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
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { detectUnclaimed, listClaimedNotLive, listUnclaimedObjects } from '@/hr/engrep/api';
import type { EngrepClaimedNotLive, EngrepUnclaimedObject } from '@/hr/engrep/types';

const PANEL_1_HEADING = 'Claimed but not live';
const PANEL_2_HEADING = 'Live but unclaimed';

const PANEL_1_NOTE =
  'Migration in a commit, no catalog delta. Lovable syncs code from git but does not apply hand-written migrations. Pushing is not applying.';
const PANEL_2_NOTE = 'SQL-editor drift. Nobody is credited; raised for investigation.';

const MIN_NOTE_LENGTH = 25;

// The engrep tables are newer than the generated Supabase types.
const db = supabase as unknown as { from: (table: string) => any };

async function fetchOpenWindowId(): Promise<string | null> {
  const { data, error } = await db
    .from('engrep_windows')
    .select('id, period_start, status')
    .eq('status', 'open')
    .order('period_start', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data?.[0]?.id as string | undefined) ?? null;
}

function InvestigationDialog({
  object,
  onClose,
  onSaved,
}: {
  object: EngrepUnclaimedObject | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [note, setNote] = useState('');
  const remaining = Math.max(0, MIN_NOTE_LENGTH - note.trim().length);

  const save = useMutation({
    mutationFn: async () => {
      if (!object) return;
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db
        .from('engrep_unclaimed_objects')
        .update({
          note: note.trim(),
          investigated_at: new Date().toISOString(),
          investigated_by: auth?.user?.id ?? null,
        })
        .eq('id', object.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Finding recorded');
      setNote('');
      onSaved();
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Could not record the finding');
    },
  });

  return (
    <Dialog
      open={Boolean(object)}
      onOpenChange={(open) => {
        if (!open) {
          setNote('');
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record finding</DialogTitle>
          <DialogDescription>
            {object ? `${object.object_kind} · ${object.object_key}` : ''}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={5}
          placeholder="What was found on investigation?"
        />
        <p className="text-xs text-muted-foreground">
          {remaining > 0
            ? `${remaining} more character${remaining === 1 ? '' : 's'} required`
            : 'Ready to save'}
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            type="button"
            disabled={remaining > 0 || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save finding'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ZoneCExceptions({ canAdjudicate }: { canAdjudicate: boolean }) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<EngrepUnclaimedObject | null>(null);

  const windowQuery = useQuery({
    queryKey: ['engrep', 'open-window'],
    queryFn: fetchOpenWindowId,
  });
  const windowId = windowQuery.data ?? null;

  const claimedQuery = useQuery({
    queryKey: ['engrep', 'claimed-not-live', windowId],
    queryFn: () => listClaimedNotLive(windowId as string),
    enabled: Boolean(windowId),
  });

  const unclaimedQuery = useQuery({
    queryKey: ['engrep', 'unclaimed', windowId],
    queryFn: () => listUnclaimedObjects(windowId as string),
    enabled: Boolean(windowId),
  });

  const redetect = useMutation({
    mutationFn: () => detectUnclaimed(windowId as string),
    onSuccess: () => {
      toast.success('Drift re-detected');
      queryClient.invalidateQueries({ queryKey: ['engrep', 'unclaimed', windowId] });
    },
    onError: (error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'Re-detection failed');
    },
  });

  const claimed = (claimedQuery.data ?? []) as EngrepClaimedNotLive[];
  const unclaimed = (unclaimedQuery.data ?? []) as EngrepUnclaimedObject[];

  const byKind = useMemo(() => {
    const map = new Map<string, number>();
    for (const object of unclaimed) {
      map.set(object.object_kind, (map.get(object.object_kind) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  }, [unclaimed]);

  const loading = windowQuery.isLoading || claimedQuery.isLoading || unclaimedQuery.isLoading;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        Always shows the current open window. This zone ignores the Daily / Weekly / Monthly
        toggle entirely.
      </p>

      {!windowId && !windowQuery.isLoading && (
        <p className="text-xs text-muted-foreground">No open window at the moment.</p>
      )}

      {loading ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Panel 1 */}
          <div className="space-y-2">
            <div className="rounded-lg border">
              <div className="flex items-center justify-between border-b bg-muted/50 px-3 py-2">
                <p className="text-sm font-semibold">{PANEL_1_HEADING}</p>
                <span className="text-sm font-semibold tabular-nums">{claimed.length}</span>
              </div>
              <ul className="divide-y">
                {claimed.length === 0 && (
                  <li className="px-3 py-3 text-xs text-muted-foreground">Nothing outstanding.</li>
                )}
                {claimed.map((row) => (
                  <li key={row.row_id} className="flex flex-wrap items-baseline gap-2 px-3 py-2">
                    <span className="text-sm font-medium">
                      {row.engineer_code ?? row.author_email ?? '—'}
                    </span>
                    <span className="flex-1 text-sm text-muted-foreground">
                      {row.commit_subject ?? '—'}
                    </span>
                    <span className="text-xs font-semibold text-destructive">Scored 0</span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">{PANEL_1_NOTE}</p>
          </div>

          {/* Panel 2 — no engineer name, code, staff reference or band is rendered here. */}
          <div className="space-y-2">
            <div className="rounded-lg border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/50 px-3 py-2">
                <p className="text-sm font-semibold">{PANEL_2_HEADING}</p>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold tabular-nums">{unclaimed.length}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    type="button"
                    disabled={!canAdjudicate || !windowId || redetect.isPending}
                    title={
                      canAdjudicate
                        ? undefined
                        : 'Re-detection is restricted to the Lead Engineer.'
                    }
                    onClick={() => redetect.mutate()}
                  >
                    {redetect.isPending ? 'Detecting…' : 'Re-detect drift'}
                  </Button>
                </div>
              </div>

              {!canAdjudicate && (
                <p className="border-b px-3 py-2 text-xs text-muted-foreground">
                  Re-detect drift is disabled: restricted to the Lead Engineer.
                </p>
              )}

              {byKind.length > 0 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-3 py-2 text-xs text-muted-foreground">
                  {byKind.map(([kind, count]) => (
                    <span key={kind}>
                      {kind}: <span className="font-medium tabular-nums">{count}</span>
                    </span>
                  ))}
                  <span>
                    total: <span className="font-medium tabular-nums">{unclaimed.length}</span>
                  </span>
                </div>
              )}

              <ul className="divide-y">
                {unclaimed.length === 0 && (
                  <li className="px-3 py-3 text-xs text-muted-foreground">No drift detected.</li>
                )}
                {unclaimed.map((object) => (
                  <li key={object.id} className="space-y-1 px-3 py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{object.object_key}</p>
                        <p className="text-xs text-muted-foreground">
                          {object.object_kind}
                          {object.change ? ` · ${object.change}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        type="button"
                        onClick={() => setTarget(object)}
                      >
                        Record finding
                      </Button>
                    </div>
                    {object.note && (
                      <p className="text-xs italic text-muted-foreground">{object.note}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">{PANEL_2_NOTE}</p>
          </div>
        </div>
      )}

      <InvestigationDialog
        object={target}
        onClose={() => setTarget(null)}
        onSaved={() =>
          queryClient.invalidateQueries({ queryKey: ['engrep', 'unclaimed', windowId] })
        }
      />
    </div>
  );
}

export default ZoneCExceptions;
