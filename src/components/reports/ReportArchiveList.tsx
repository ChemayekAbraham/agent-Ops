import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { format, parseISO } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { downloadArchivedReportPdf } from '@/lib/archivedReportPdf';

type ArchiveRow = {
  id: string;
  source: string | null;
  source_label: string | null;
  granularity: string | null;
  period_start: string | null;
  period_end: string | null;
  title: string | null;
  summary: string | null;
  submitted_by_name: string | null;
  submitted_at: string;
};

const KAMPALA = 'Africa/Kampala';

function kampalaDayKey(iso: string): string {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: KAMPALA }).format(new Date(iso));
}

function fmtMoney(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return formatUGX(n);
}

function fmtPct(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n.toFixed(1)}%`;
}

const GRANULARITIES: { label: string; value: string | null }[] = [
  { label: 'All', value: null },
  { label: 'Daily', value: 'day' },
  { label: 'Weekly', value: 'week' },
  { label: 'Monthly', value: 'month' },
];

function FigureLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-dashed py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums font-mono">{value}</span>
    </div>
  );
}

function ReportDetailDialog({
  row,
  open,
  onOpenChange,
}: {
  row: ArchiveRow | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['report-archive-detail', row?.id],
    enabled: open && !!row?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('report_archive')
        .select('id, payload')
        .eq('id', row!.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const payload = (data?.payload ?? null) as Record<string, unknown> | null;
  const zoneA = (payload?.zone_a ?? null) as Record<string, unknown> | null;
  const narrative = typeof payload?.narrative === 'string' ? (payload.narrative as string) : '';
  const actions = Array.isArray(payload?.actions) ? (payload!.actions as Record<string, unknown>[]) : [];
  const carried = Array.isArray(payload?.carried_close_outs)
    ? (payload!.carried_close_outs as Record<string, unknown>[])
    : [];

  const hasKnownShape = !!zoneA || !!narrative || actions.length > 0 || carried.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-center text-base">{row?.title ?? 'Archived report'}</DialogTitle>
        </DialogHeader>

        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            disabled={isLoading || !payload || !row}
            onClick={() => {
              if (row && payload) void downloadArchivedReportPdf(row, payload);
            }}
          >
            Download PDF
          </Button>
        </div>

        {row && (
          <p className="text-center text-[11px] text-muted-foreground">
            {row.source_label ?? row.source ?? '—'} · {row.period_start ?? '—'} to {row.period_end ?? '—'} ·
            {' '}submitted by {row.submitted_by_name ?? 'Unknown'} on{' '}
            {format(parseISO(row.submitted_at), 'dd MMM yyyy HH:mm')}
          </p>
        )}

        <hr className="my-3" />

        {isLoading && <p className="text-xs text-muted-foreground">Loading report…</p>}
        {error && <p className="text-xs text-destructive">{(error as Error).message}</p>}

        {!isLoading && !error && (
          <div className="space-y-6">
            {zoneA && (
              <section>
                <div className="rounded-md border p-3">
                  <FigureLine label="Collected" value={fmtMoney(zoneA.collected_ugx)} />
                  <FigureLine label="Scheduled due" value={fmtMoney(zoneA.scheduled_due_ugx)} />
                  <FigureLine label="Collection rate" value={fmtPct(zoneA.collection_rate_pct)} />
                  <FigureLine label="Threshold" value={fmtPct(zoneA.threshold_pct)} />
                  <FigureLine label="Arrears brought forward" value={fmtMoney(zoneA.arrears_target_ugx)} />
                  <FigureLine label="Arrears outstanding" value={fmtMoney(zoneA.arrears_outstanding_ugx)} />
                </div>
              </section>
            )}

            {narrative.trim().length > 0 && (
              <section>
                <h3 className="mb-1 text-sm font-semibold">Why these numbers</h3>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">{narrative}</p>
              </section>
            )}

            {actions.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Actions</h3>
                <ul className="space-y-2">
                  {actions.map((a, i) => (
                    <li key={i} className="rounded-md border p-2">
                      <p className="text-sm">{String(a.item_text ?? '—')}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {String(a.owner_label ?? 'Unassigned')}
                        {a.due_date ? ` · due ${String(a.due_date)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {carried.length > 0 && (
              <section>
                <h3 className="mb-2 text-sm font-semibold">Carried actions</h3>
                <ul className="space-y-2">
                  {carried.map((c, i) => (
                    <li key={i} className="rounded-md border p-2">
                      <p className="text-sm">{String(c.item_text ?? '—')}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {String(c.outcome ?? '—')}
                        {c.outcome_note ? ` · ${String(c.outcome_note)}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {!hasKnownShape && payload && (
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-[11px] leading-relaxed">
                {JSON.stringify(payload, null, 2)}
              </pre>
            )}

            {!payload && !isLoading && (
              <p className="text-xs text-muted-foreground">This report has no stored content.</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ReportArchiveList({ source }: { source?: string } = {}) {
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [granularityFilter, setGranularityFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<ArchiveRow | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['report-archive', source ?? null],
    staleTime: 60_000,
    queryFn: async () => {
      let query = supabase
        .from('report_archive')
        .select(
          'id, source, source_label, granularity, period_start, period_end, title, summary, submitted_by_name, submitted_at'
        );
      if (source) query = query.eq('source', source);
      const { data, error } = await query
        .order('submitted_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (data ?? []) as ArchiveRow[];
    },
  });

  const rows = useMemo(() => data ?? [], [data]);

  const sourceLabels = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      if (r.source_label) set.add(r.source_label);
    });
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (sourceFilter && r.source_label !== sourceFilter) return false;
      if (granularityFilter && r.granularity !== granularityFilter) return false;
      if (q) {
        const hay = `${r.title ?? ''} ${r.source_label ?? ''} ${r.submitted_by_name ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, sourceFilter, granularityFilter, search]);

  const groups = useMemo(() => {
    const map = new Map<string, ArchiveRow[]>();
    filtered.forEach((r) => {
      const key = kampalaDayKey(r.submitted_at);
      const list = map.get(key) ?? [];
      list.push(r);
      map.set(key, list);
    });
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [filtered]);

  const summaryLine = useMemo(() => {
    if (rows.length === 0) return '';
    const days = new Set(rows.map((r) => kampalaDayKey(r.submitted_at))).size;
    const newest = format(parseISO(rows[0].submitted_at), 'dd MMM yyyy');
    return `${rows.length} reports archived · ${days} days covered · newest ${newest}`;
  }, [rows]);

  if (isLoading) {
    return <p className="text-xs text-muted-foreground">Loading archived reports…</p>;
  }

  if (error) {
    return <p className="text-xs text-destructive">{(error as Error).message}</p>;
  }

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No reports have been archived yet. Submitted reports will appear here.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted-foreground">{summaryLine}</p>

      <Card>
        <CardContent className="space-y-3 p-3">
          {!source && (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                className="h-8 text-xs"
                variant={sourceFilter === null ? 'default' : 'outline'}
                onClick={() => setSourceFilter(null)}
              >
                All
              </Button>
              {sourceLabels.map((label) => (
                <Button
                  key={label}
                  size="sm"
                  className="h-8 text-xs"
                  variant={sourceFilter === label ? 'default' : 'outline'}
                  onClick={() => setSourceFilter(label)}
                >
                  {label}
                </Button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {GRANULARITIES.map((g) => (
              <Button
                key={g.label}
                size="sm"
                className="h-8 text-xs"
                variant={granularityFilter === g.value ? 'default' : 'outline'}
                onClick={() => setGranularityFilter(g.value)}
              >
                {g.label}
              </Button>
            ))}
          </div>

          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, source or submitter"
            className="h-8 text-xs"
          />
        </CardContent>
      </Card>

      {groups.length === 0 && (
        <p className="text-xs text-muted-foreground">No reports match these filters.</p>
      )}

      <div className="space-y-6">
        {groups.map(([day, dayRows]) => (
          <section key={day} className="space-y-2">
            <div className="sticky top-0 z-10 flex items-center justify-between rounded-md bg-background/95 py-1 backdrop-blur">
              <h3 className="text-sm font-semibold">
                {format(parseISO(`${day}T00:00:00`), 'EEEE, dd MMMM yyyy')}
              </h3>
              <span className="text-[11px] text-muted-foreground">{dayRows.length} reports</span>
            </div>

            <div className="space-y-2">
              {dayRows.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelected(r)}
                  className="flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{r.title ?? 'Untitled report'}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {r.source_label ?? r.source ?? '—'} · {r.granularity ?? '—'} ·{' '}
                      {r.period_start ?? '—'} to {r.period_end ?? '—'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Badge variant="outline" className="text-[10px]">
                      {r.granularity ?? '—'}
                    </Badge>
                    <div className="text-right">
                      <p className="text-[11px]">{r.submitted_by_name ?? 'Unknown'}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {format(parseISO(r.submitted_at), 'HH:mm')}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>

      <ReportDetailDialog
        row={selected}
        open={!!selected}
        onOpenChange={(v) => {
          if (!v) setSelected(null);
        }}
      />
    </div>
  );
}

export default ReportArchiveList;
