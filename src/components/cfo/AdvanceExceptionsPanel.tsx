import { useMemo, useState } from 'react';
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
  const rows = kind ? byKind.get(kind) ?? [] : [];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertOctagon className="h-4 w-4 text-destructive" /> Advance exceptions
            {data && <Badge variant={visible.length ? 'destructive' : 'secondary'}>{visible.length}</Badge>}
          </CardTitle>
          <Button size="sm" variant="outline" disabled={isFetching}
            onClick={() => (requested ? refetch() : setRequested(true))}>
            {isFetching ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
            {data ? 'Re-check' : 'Run check'}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Compares every advance with the ledger. Read-only: nothing is corrected automatically.
          {data && <> Checked {new Date(data.as_at).toLocaleString()}.</>}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <p className="text-xs text-destructive">Check failed: {advanceControlMessage((error as any)?.message)}</p>
        ) : !data ? (
          <p className="text-xs text-muted-foreground">{isFetching ? 'Checking all advances (can take up to a minute)...' : 'Run the check to see exceptions.'}</p>
        ) : (
          <>
            {legacyCount > 0 && (
              <div className="flex items-center gap-2">
                <Switch id="adv-ex-legacy" checked={showLegacy} onCheckedChange={setShowLegacy} />
                <Label htmlFor="adv-ex-legacy" className="text-xs">Include {legacyCount} legacy differences (advances before 29 Sep 2026)</Label>
              </div>
            )}
            {kinds.length === 0 ? (
              <p className="text-xs text-muted-foreground">No exceptions found.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {kinds.map((k) => (
                  <button key={k} type="button" onClick={() => setKind(kind === k ? null : k)}
                    className={`text-left rounded-lg border p-2.5 transition-colors ${kind === k ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'}`}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-semibold">{exceptionKindTitle(k)}</span>
                      <Badge variant="outline">{byKind.get(k)?.length ?? 0}</Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      {(EXCEPTION_KIND_LABELS as Record<string, { meaning: string }>)[k]?.meaning}
                    </p>
                  </button>
                ))}
              </div>
            )}
            {kind && rows.length > 0 && (
              <ul className="divide-y divide-border rounded-lg border border-border">
                {rows.map((e, i) => (
                  <li key={`${e.advance_id ?? e.agent_id}-${i}`} className="p-2.5 text-xs flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                    <div className="min-w-0">
                      <p className="font-medium truncate">{e.agent ?? 'Unknown agent'}
                        {e.severity === 'legacy' && <Badge variant="secondary" className="ml-2 text-[10px]">legacy</Badge>}
                      </p>
                      <p className="text-muted-foreground">{exceptionSummary(e, formatUGX)}</p>
                    </div>
                    {e.advance_id && (
                      <Button size="sm" variant="ghost" className="self-start sm:self-center" onClick={() => navigate(`/agent-advances/${e.advance_id}`)}>
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
