import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MapPin, Globe, Filter } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';

/**
 * Receivables by Location — read-only. All figures come from
 * get_receivables_location_hierarchy (the same open receivable lines as the
 * page totals). Drill: Country → Region → District → Sub-county → Village.
 */

type Row = {
  country: string;
  region: string;
  district: string;
  subcounty: string;
  village: string;
  items: number;
  accounts: number;
  outstanding: number;
  overdue: number;
};

type Resp = {
  as_of: string;
  total_outstanding: number;
  total_items: number;
  rows: Row[];
};

const LEVELS = ['country', 'region', 'district', 'subcounty', 'village'] as const;
type Level = typeof LEVELS[number];
const LEVEL_LABEL: Record<Level, string> = {
  country: 'Country',
  region: 'Region',
  district: 'District',
  subcounty: 'Sub-county',
  village: 'Village',
};
const UNKNOWN = 'Unknown / Unmapped Location';

const CATEGORY_OPTIONS = [
  { key: 'all', label: 'All categories' },
  { key: 'tenant', label: 'Tenant Products & Services' },
  { key: 'agent', label: 'Agent Products & Services' },
  { key: 'landlord', label: 'Landlord Products & Services' },
  { key: 'partner', label: 'Partner Products & Services' },
  { key: 'other', label: 'Unclassified / Other' },
  { key: 'rnd', label: 'R&D' },
];

const num = (v: number) => formatUGX(v).replace(/^UGX\s*/, '');

export default function ReceivablesByLocation() {
  const [category, setCategory] = useState('all');
  const [path, setPath] = useState<string[]>([]);

  const q = useQuery({
    queryKey: ['receivables-location-hierarchy', category],
    queryFn: async (): Promise<Resp> => {
      const { data, error } = await (supabase.rpc as unknown as (n: string, a: object) => Promise<{ data: unknown; error: Error | null }>)(
        'get_receivables_location_hierarchy',
        { p_category: category === 'all' ? null : category }
      );
      if (error) throw error;
      return data as Resp;
    },
    staleTime: 60_000,
  });

  const level: Level = LEVELS[Math.min(path.length, LEVELS.length - 1)];
  const atLeaf = path.length >= LEVELS.length - 1;

  const groups = useMemo(() => {
    const rows = (q.data?.rows ?? []).filter((r) => path.every((p, i) => r[LEVELS[i]] === p));
    const map = new Map<string, { label: string; items: number; accounts: number; outstanding: number; overdue: number }>();
    for (const r of rows) {
      const k = r[level];
      const g = map.get(k) ?? { label: k, items: 0, accounts: 0, outstanding: 0, overdue: 0 };
      g.items += Number(r.items);
      g.accounts += Number(r.accounts);
      g.outstanding += Number(r.outstanding);
      g.overdue += Number(r.overdue);
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) =>
      a.label === UNKNOWN ? 1 : b.label === UNKNOWN ? -1 : b.outstanding - a.outstanding
    );
  }, [q.data, path, level]);

  const grand = Number(q.data?.total_outstanding ?? 0);
  const tot = groups.reduce(
    (s, g) => ({
      items: s.items + g.items,
      outstanding: s.outstanding + g.outstanding,
      overdue: s.overdue + g.overdue,
    }),
    { items: 0, outstanding: 0, overdue: 0 }
  );

  const pctNumber = (v: number) => (grand > 0 ? (v / grand) * 100 : 0);
  const pct = (v: number) => (grand > 0 ? `${pctNumber(v).toFixed(1)}%` : '0.0%');

  return (
    <section className="rounded-xl border border-border/80 bg-card p-4 shadow-xs">
      {/* Header & Filter Controls */}
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3 border-b border-border/40 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <MapPin className="h-4 w-4" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-foreground">
                Receivables by Location Hierarchy
              </h2>
              <Badge variant="outline" className="text-[10px] font-medium py-0 h-5 border-border/80">
                Level: {LEVEL_LABEL[level]}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Concentration of outstanding balances. Click any row to drill down into deeper administrative levels.
            </p>
          </div>
        </div>

        {/* Category Filter Selector */}
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-muted-foreground" />
          <Select
            value={category}
            onValueChange={(v) => {
              setCategory(v);
              setPath([]);
            }}
          >
            <SelectTrigger className="h-8 w-[210px] text-xs rounded-lg bg-muted/40 border-border/60">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CATEGORY_OPTIONS.map((c) => (
                <SelectItem key={c.key} value={c.key} className="text-xs">
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Drill-down Breadcrumb Navigation */}
      <nav
        className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/30 px-3 py-1.5 text-xs"
        aria-label="Location path"
      >
        <button
          type="button"
          onClick={() => setPath([])}
          className={`flex items-center gap-1 font-medium transition-colors ${
            path.length === 0 ? 'text-foreground font-semibold' : 'text-primary hover:underline'
          }`}
        >
          <Globe className="h-3.5 w-3.5" />
          <span>All Countries</span>
        </button>

        {path.map((p, i) => {
          const isCurrent = i === path.length - 1;
          return (
            <span key={i} className="flex items-center gap-1.5">
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/60" />
              <button
                type="button"
                disabled={isCurrent}
                onClick={() => setPath(path.slice(0, i + 1))}
                className={`font-medium transition-colors ${
                  isCurrent
                    ? 'text-foreground font-semibold cursor-default'
                    : 'text-primary hover:underline'
                }`}
              >
                {p}
              </button>
            </span>
          );
        })}
      </nav>

      {/* Hierarchy Table */}
      <div className="overflow-x-auto -mx-4 -mb-4 px-4 pb-4">
        <table className="w-full min-w-[640px] text-xs">
          <thead>
            <tr className="border-b border-border/60 text-[11px] text-muted-foreground">
              <th className="py-2.5 text-left font-medium">{LEVEL_LABEL[level]}</th>
              <th className="py-2.5 text-right font-medium">Accounts</th>
              <th className="py-2.5 text-right font-medium">Outstanding (UGX)</th>
              <th className="py-2.5 text-right font-medium">Overdue (UGX)</th>
              <th className="py-2.5 text-right font-medium">Performing (UGX)</th>
              <th className="py-2.5 text-right font-medium">% of Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {groups.map((g) => {
              const isUnk = g.label === UNKNOWN;
              const share = pctNumber(g.outstanding);
              return (
                <tr
                  key={g.label}
                  className={`group transition-colors ${
                    atLeaf ? '' : 'cursor-pointer hover:bg-muted/40'
                  }`}
                  onClick={atLeaf ? undefined : () => setPath([...path, g.label])}
                >
                  <td className="py-2.5 pr-2">
                    <div className="flex items-center gap-2">
                      <MapPin
                        className={`h-3.5 w-3.5 shrink-0 transition-colors ${
                          isUnk
                            ? 'text-muted-foreground/60'
                            : 'text-blue-500 group-hover:text-primary'
                        }`}
                      />
                      <span
                        className={`font-medium transition-colors ${
                          isUnk
                            ? 'text-muted-foreground italic'
                            : 'text-foreground group-hover:text-primary'
                        }`}
                      >
                        {g.label}
                      </span>
                      {!atLeaf && (
                        <ChevronRight className="h-3 w-3 text-muted-foreground/40 group-hover:text-primary group-hover:translate-x-0.5 transition-all ml-1" />
                      )}
                    </div>
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground">
                    {g.items.toLocaleString()}
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums font-semibold text-foreground whitespace-nowrap">
                    {num(g.outstanding)}
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">
                    {g.overdue > 0 ? (
                      <span className="inline-flex rounded-md bg-destructive/10 px-1.5 py-0.5 text-[11px] font-medium text-destructive">
                        {num(g.overdue)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </td>
                  <td className="py-2.5 px-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {num(g.outstanding - g.overdue)}
                  </td>
                  <td className="py-2.5 pl-2 text-right">
                    <div className="flex items-center justify-end gap-1.5">
                      <span className="tabular-nums font-medium text-muted-foreground text-[11px]">
                        {pct(g.outstanding)}
                      </span>
                      <div className="h-1.5 w-12 rounded-full bg-muted overflow-hidden">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all duration-500"
                          style={{ width: `${Math.min(100, Math.max(0, share))}%` }}
                        />
                      </div>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
          {groups.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-border/80 bg-muted/20 font-semibold text-foreground">
                <td className="py-2.5 pr-2">Total Selection</td>
                <td className="py-2.5 px-2 text-right tabular-nums">{tot.items.toLocaleString()}</td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">{num(tot.outstanding)}</td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap text-destructive">{num(tot.overdue)}</td>
                <td className="py-2.5 px-2 text-right tabular-nums whitespace-nowrap">{num(tot.outstanding - tot.overdue)}</td>
                <td className="py-2.5 pl-2 text-right tabular-nums">{pct(tot.outstanding)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      {!groups.length && (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {q.isLoading
            ? 'Loading location hierarchy…'
            : q.isError
            ? 'Location report unavailable.'
            : 'No receivables recorded for this selection.'}
        </p>
      )}
    </section>
  );
}
