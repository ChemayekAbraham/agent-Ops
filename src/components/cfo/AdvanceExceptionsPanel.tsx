import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  EXCEPTION_KIND_LABELS, advanceControlMessage, exceptionKindTitle, exceptionSummary,
  type AdvanceException, type AdvanceExceptionReport,
} from '@/lib/advanceControls';
import { AlertOctagon, Loader2, RefreshCw } from 'lucide-react';

// get_agent_advance_exceptions is newer than the generated types.
const db = supabase as any;

/** Read-only: lists what the nightly reconciliation flags. Nothing here posts or corrects anything. */
export function AdvanceExceptionsPanel() {
  const navigate = useNavigate();
  const [requested, setRequested] = useState(false);
  const [showLegacy, setShowLegacy] = useState(false);
  const [kind, setKind] = useState<string | null>(null);

  const { data, isFetching, error, refetch } = useQuery<AdvanceExceptionReport>({
    queryKey: ['agent-advance-exceptions'],
    enabled: requested,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data: r, error: e } = await db.rpc('get_agent_advance_exceptions');
      if (e) throw e;
      return r as AdvanceExceptionReport;
    },
  });

  const visible = useMemo(
    () => (data?.exceptions ?? []).filter((e) => showLegacy || e.severity !== 'legacy'),
    [data, showLegacy],
  );
  const byKind = useMemo(() => {
    const m = new Map<string, AdvanceException[]>();
    for (const e of visible) m.set(e.kind, [...(m.get(e.kind) ?? []), e]);
    return m;
  }, [visible]);
  const legacyCount = (data?.exceptions ?? []).filter((e) => e.severity === 'legacy').length;
  const kinds = [...Object.keys(EXCEPTION_KIND_LABELS), ...[...byKind.keys()].filter((k) => !(k in EXCEPTION_KIND_LABELS))]
    .filter((k) => byKind.has(k));

  useEffect(() => {
    if (kinds.length > 0 && (!kind || !byKind.has(kind))) {
      setKind(kinds[0]);
    }
  }, [kinds, kind, byKind]);

  const rows = kind ? byKind.get(kind) ?? [] : [];

  return (
    <Card className="rounded-xl border-border/80 shadow-2xs">
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <AlertOctagon className="h-3.5 w-3.5" />
            </span>
            <span>Advance exceptions</span>
            {data && <Badge variant={visible.length ? 'destructive' : 'secondary'} className="text-xs font-semibold">{visible.length}</Badge>}
          </CardTitle>
          <Button size="sm" variant="outline" className="h-8 text-xs rounded-lg" disabled={isFetching}
            onClick={() => (requested ? refetch() : setRequested(true))}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            {data ? 'Re-check' : 'Run check'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Compares every advance with the ledger. Read-only: nothing is corrected automatically.
          {data && <> Checked {new Date(data.as_at).toLocaleString()}.</>}
        </p>
      </CardHeader>
      <CardContent className="pt-4 space-y-3">
        {error ? (
          <p className="text-xs text-destructive">Check failed: {advanceControlMessage((error as any)?.message)}</p>
        ) : !data ? (
          <div className="rounded-lg border border-dashed border-border/70 bg-muted/15 px-3 py-4 text-center">
            <p className="text-xs text-muted-foreground">
              {isFetching ? 'Checking all advances (can take up to a minute)...' : 'Run the check to see exceptions.'}
            </p>
          </div>
        ) : (
          <>
            {legacyCount > 0 && (
              <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2 border border-border/50">
                <Switch id="adv-ex-legacy" checked={showLegacy} onCheckedChange={setShowLegacy} />
                <Label htmlFor="adv-ex-legacy" className="text-xs cursor-pointer">Include {legacyCount} legacy differences (advances before 29 Sep 2026)</Label>
              </div>
            )}
            {kinds.length === 0 ? (
              <div className="rounded-lg border border-dashed border-emerald-500/30 bg-emerald-500/5 px-3 py-4 text-center">
                <p className="text-xs font-medium text-emerald-700 dark:text-emerald-400">No exceptions found.</p>
              </div>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {kinds.map((k) => (
                  <button key={k} type="button" onClick={() => setKind(kind === k ? null : k)}
                    className={`text-left rounded-xl border p-3 transition-all ${kind === k ? 'border-primary bg-primary/5 shadow-2xs' : 'border-border/80 bg-muted/10 hover:border-primary/40 hover:bg-muted/25'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold text-foreground">{exceptionKindTitle(k)}</span>
                      <Badge variant="outline" className="text-[11px] tabular-nums">{byKind.get(k)?.length ?? 0}</Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                      {(EXCEPTION_KIND_LABELS as Record<string, { meaning: string }>)[k]?.meaning}
                    </p>
                  </button>
                ))}
              </div>
            )}
            {kind && rows.length > 0 && (
              <ul className="divide-y divide-border/70 rounded-xl border border-border/80 bg-background overflow-hidden">
                {rows.map((e, i) => (
                  <li key={`${e.advance_id ?? e.agent_id}-${i}`} className="p-3 text-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 hover:bg-muted/20 transition-colors">
                    <div className="min-w-0">
                      <p className="font-semibold text-foreground truncate">{e.agent ?? 'Unknown agent'}
                        {e.severity === 'legacy' && <Badge variant="secondary" className="ml-2 text-[10px]">legacy</Badge>}
                      </p>
                      <p className="text-muted-foreground mt-0.5">{exceptionSummary(e, formatUGX)}</p>
                    </div>
                    {e.advance_id && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs self-start sm:self-center shrink-0" onClick={() => navigate(`/agent-advances/${e.advance_id}`)}>
                        Open
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
