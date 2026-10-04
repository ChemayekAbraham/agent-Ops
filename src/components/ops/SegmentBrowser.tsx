import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useOpsSegments, useOpsSegmentRows } from '@/hooks/useOpsSegment';
import { ChevronRight, Layers, RefreshCw } from 'lucide-react';

interface Props {
  scope?: string;
  onOpenBehavior: (tenantId: string) => void;
}

const fmtUGX = (n: number) => `UGX ${Math.round(n || 0).toLocaleString()}`;

export function SegmentBrowser({ scope = 'tenant', onOpenBehavior }: Props) {
  const { data: segments, isLoading: segLoading } = useOpsSegments(scope);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const activeId = selectedId || segments?.[0]?.id || null;
  const { data: rows, isLoading: rowsLoading, refetch, isFetching } = useOpsSegmentRows(activeId);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4">
      {/* Left rail */}
      <aside className="space-y-1 md:max-h-[70vh] md:overflow-y-auto">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pb-1">Saved segments</p>
        {segLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          (segments || []).map((s) => {
            const active = s.id === activeId;
            return (
              <button
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                className={`w-full text-left p-2.5 rounded-lg text-sm transition flex items-center gap-2 ${
                  active ? 'bg-primary/10 text-primary border border-primary/30' : 'hover:bg-muted text-foreground'
                }`}
              >
                <Layers className="h-3.5 w-3.5 shrink-0" />
                <span className="flex-1 min-w-0 truncate">{s.name}</span>
                {s.is_starter && <Badge variant="outline" className="text-[10px]">starter</Badge>}
              </button>
            );
          })
        )}
      </aside>

      {/* Main list */}
      <section className="space-y-3 min-w-0">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-base">
              {segments?.find((s) => s.id === activeId)?.name || 'Pick a segment'}
            </h3>
            <p className="text-xs text-muted-foreground">
              {rows ? `${rows.length} tenants in this page` : '—'}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
            className="gap-1.5"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        {rowsLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : !rows || rows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            No tenants match this segment right now.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((r) => (
              <li
                key={r.tenant_id}
                className="rounded-lg border border-border bg-card p-3 flex items-center gap-3 hover:bg-muted/40 transition cursor-pointer"
                onClick={() => onOpenBehavior(r.tenant_id)}
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{r.full_name || 'Unknown'}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {r.phone || '—'} · {r.city || '—'} · Trust {r.trust_score}
                  </p>
                </div>
                <div className="text-right hidden sm:block">
                  <p className="text-xs text-muted-foreground">Outstanding</p>
                  <p className="text-sm font-mono font-semibold">{fmtUGX(r.outstanding_ugx)}</p>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
