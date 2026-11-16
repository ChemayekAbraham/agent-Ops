import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { openT4RentRequest } from '@/lib/t4RentRequest';
import { parseReadyToRenew, type ReadyToRenewRow } from '@/lib/readyToRenew';

/** E128: the agent's completed Rent Plans that can be renewed (tenant asked first). */
export function useReadyToRenew() {
  return useQuery<ReadyToRenewRow[] | null>({
    queryKey: ['ready-to-renew'],
    staleTime: 60_000,
    retry: 1,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ready_to_renew', {});
      if (error) throw error;
      return parseReadyToRenew(data);
    },
  });
}

const completedLabel = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : format(d, 'd MMM yyyy');
};

export function renewRow(row: ReadyToRenewRow): void {
  openT4RentRequest({
    mode: 'renewal',
    entry: 'ready-to-renew',
    renewal: {
      prevId: row.prevId,
      tenantId: row.tenantId,
      tenantName: row.tenantName,
      tenantPhone: row.tenantPhone,
      currentRent: row.lastRent,
      currentDays: row.lastDays,
      agentId: row.agentId,
      tenantAsked: row.tenantAsked,
    },
  });
}

/**
 * Agent home: "Ready to renew (n)". Renders nothing while loading, when the list is empty
 * or when the call fails, so it never blocks the dashboard.
 */
export function ReadyToRenewCard() {
  const { data, error } = useReadyToRenew();
  if (error) console.warn('[ReadyToRenewCard] could not load ready_to_renew', error);
  const rows = data ?? [];
  if (rows.length === 0) return null;

  return (
    <section aria-labelledby="ready-to-renew-title" className="rounded-2xl border border-primary/20 bg-primary/5 p-3">
      <h2 id="ready-to-renew-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <RefreshCw className="h-4 w-4 shrink-0 text-primary" />
        Ready to renew ({rows.length})
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">These Rent Plans are complete. Renew them for the same tenant.</p>
      <ul className="mt-2.5 flex flex-col gap-2">
        {rows.map((row) => {
          const done = completedLabel(row.completedOn);
          return (
            <li
              key={row.prevId}
              data-testid="ready-to-renew-row"
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-background p-2.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-sm font-semibold text-foreground">{row.tenantName}</span>
                  {row.tenantAsked && (
                    <Badge variant="default" className="shrink-0 text-[10px]">Tenant asked</Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {formatUGX(row.lastRent)} · {row.lastDays} days
                  {done ? ` · Completed ${done}` : ''}
                  {row.ref ? ` · ${row.ref}` : ''}
                </p>
              </div>
              <Button size="sm" className="shrink-0" onClick={() => renewRow(row)}>
                Renew
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
