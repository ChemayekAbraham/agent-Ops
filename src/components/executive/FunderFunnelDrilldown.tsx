import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { Home, User } from 'lucide-react';
import { format } from 'date-fns';

export type FunderDetail = {
  userId: string;
  count: number;
  firstAt: string;
  lastAt: string;
  houseIds: string[];
};

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stepLabel: string;
  rangeLabel: string;
  details: FunderDetail[];
  /** Houses each funder selected in the range, for context on every step. */
  housesByUser: Record<string, string[]>;
}

type Profile = { id: string; full_name: string | null; phone: string | null };
type House = { id: string; title: string | null; monthly_rent: number | null; region: string | null };

const MAX_ROWS = 100;

export function FunderFunnelDrilldown({
  open,
  onOpenChange,
  stepLabel,
  rangeLabel,
  details,
  housesByUser,
}: Props) {
  const rows = details.slice(0, MAX_ROWS);
  const userIds = rows.map((r) => r.userId);
  const houseIds = Array.from(
    new Set(rows.flatMap((r) => [...r.houseIds, ...(housesByUser[r.userId] || [])])),
  );

  const { data, isLoading } = useQuery({
    queryKey: ['funder-funnel-drilldown', stepLabel, rangeLabel, userIds.join(','), houseIds.length],
    enabled: open && userIds.length > 0,
    staleTime: 300_000,
    queryFn: async () => {
      const [profRes, houseRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone').in('id', userIds),
        houseIds.length
          ? supabase.from('house_listings').select('id, title, monthly_rent, region').in('id', houseIds.slice(0, 300))
          : Promise.resolve({ data: [] as House[] }),
      ]);
      const profiles: Record<string, Profile> = {};
      ((profRes.data || []) as any[]).forEach((p) => { profiles[p.id] = p; });
      const houses: Record<string, House> = {};
      ((houseRes.data || []) as any[]).forEach((h) => { houses[h.id] = h; });
      return { profiles, houses };
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl rounded-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{stepLabel}</DialogTitle>
          <DialogDescription className="text-xs">
            {details.length.toLocaleString()} funder{details.length === 1 ? '' : 's'} reached this step · {rangeLabel}
            {details.length > MAX_ROWS ? ` · showing first ${MAX_ROWS}` : ''}
          </DialogDescription>
        </DialogHeader>

        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground py-6 text-center">
            No funders reached this step in the selected range.
          </p>
        ) : (
          <div className="space-y-2">
            {rows.map((r) => {
              const p = data?.profiles[r.userId];
              const selected = housesByUser[r.userId] || [];
              const stepHouses = r.houseIds;
              const shown = (selected.length ? selected : stepHouses).slice(0, 6);
              return (
                <div key={r.userId} className="rounded-xl border border-border p-2.5 space-y-1.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold flex items-center gap-1.5 truncate">
                        <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        {isLoading ? 'Loading…' : p?.full_name || 'Unknown funder'}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {p?.phone || '—'} · {r.count} action{r.count === 1 ? '' : 's'} · last{' '}
                        {format(new Date(r.lastAt), 'd MMM HH:mm')}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold">
                      {selected.length} house{selected.length === 1 ? '' : 's'} selected
                    </span>
                  </div>

                  {shown.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {shown.map((hid) => {
                        const h = data?.houses[hid];
                        return (
                          <span
                            key={hid}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px]"
                          >
                            <Home className="h-3 w-3 text-muted-foreground" />
                            <span className="max-w-[160px] truncate">{h?.title || 'House'}</span>
                            {h?.monthly_rent ? (
                              <span className="text-muted-foreground">{formatUGX(h.monthly_rent)}</span>
                            ) : null}
                          </span>
                        );
                      })}
                      {(selected.length || stepHouses.length) > shown.length && (
                        <span className="text-[10px] text-muted-foreground self-center">
                          +{(selected.length || stepHouses.length) - shown.length} more
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
