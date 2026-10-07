import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight, MapPin } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * Receivables by Location — read-only. All figures come from
 * get_receivables_location_hierarchy (the same open receivable lines as the
 * page totals). Drill: Country → Region → District → Sub-county → Village.
 */

type Row = { country: string; region: string; district: string; subcounty: string; village: string; items: number; accounts: number; outstanding: number; overdue: number };
type Resp = { as_of: string; total_outstanding: number; total_items: number; rows: Row[] };

const LEVELS = ['country', 'region', 'district', 'subcounty', 'village'] as const;
type Level = typeof LEVELS[number];
const LEVEL_LABEL: Record<Level, string> = { country: 'Country', region: 'Region', district: 'District', subcounty: 'Sub-county', village: 'Village' };
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
        'get_receivables_location_hierarchy', { p_category: category === 'all' ? null : category });
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
      g.items += Number(r.items); g.accounts += Number(r.accounts); g.outstanding += Number(r.outstanding); g.overdue += Number(r.overdue);
      map.set(k, g);
    }
    return [...map.values()].sort((a, b) => (a.label === UNKNOWN ? 1 : b.label === UNKNOWN ? -1 : b.outstanding - a.outstanding));
  }, [q.data, path, level]);

  const grand = Number(q.data?.total_outstanding ?? 0);
  const tot = groups.reduce((s, g) => ({ items: s.items + g.items, outstanding: s.outstanding + g.outstanding, overdue: s.overdue + g.overdue }), { items: 0, outstanding: 0, overdue: 0 });
  const pct = (v: number) => (grand > 0 ? `${((v / grand) * 100).toFixed(1)}%` : '0.0%');

  return (
    <section className="rounded-lg border border-border bg-card p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Receivables by Location</h3>
          <p className="text-[11px] text-muted-foreground">Where outstanding receivables are concentrated. Select a row to drill down.</p>
        </div>
        <Select value={category} onValueChange={(v) => { setCategory(v); setPath([]); }}>
          <SelectTrigger className="h-8 w-[220px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>{CATEGORY_OPTIONS.map((c) => <SelectItem key={c.key} value={c.key} className="text-xs">{c.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <nav className="mb-2 flex flex-wrap items-center gap-1 text-[11px]" aria-label="Location path">
        <Button variant="link" size="sm" className="h-auto min-h-0 p-0 text-[11px]" onClick={() => setPath([])}>All countries</Button>
        {path.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
            <Button variant="link" size="sm" className="h-auto min-h-0 p-0 text-[11px]" disabled={i === path.length - 1} onClick={() => setPath(path.slice(0, i + 1))}>{p}</Button>
          </span>
        ))}
      </nav>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-[11px]">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="p-2 text-left font-medium">{LEVEL_LABEL[level]}</th>
              <th className="p-2 text-right font-medium">Receivables</th>
              <th className="p-2 text-right font-medium">Outstanding (UGX)</th>
              <th className="p-2 text-right font-medium">Overdue (UGX)</th>
              <th className="p-2 text-right font-medium">Not yet due (UGX)</th>
              <th className="p-2 text-right font-medium">% of Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {groups.map((g) => (
              <tr key={g.label} className={atLeaf ? '' : 'cursor-pointer hover:bg-muted/40'} onClick={atLeaf ? undefined : () => setPath([...path, g.label])}>
                <td className="p-2">
                  <span className="flex items-center gap-1.5">
                    <MapPin className={`h-3 w-3 shrink-0 ${g.label === UNKNOWN ? 'text-muted-foreground' : 'text-primary'}`} />
                    <span className={g.label === UNKNOWN ? 'text-muted-foreground italic' : 'font-medium'}>{g.label}</span>
                    {!atLeaf && <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                  </span>
                </td>
                <td className="p-2 text-right tabular-nums">{g.items.toLocaleString()}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{num(g.outstanding)}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap text-destructive">{num(g.overdue)}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{num(g.outstanding - g.overdue)}</td>
                <td className="p-2 text-right tabular-nums">{pct(g.outstanding)}</td>
              </tr>
            ))}
          </tbody>
          {groups.length > 0 && (
            <tfoot className="border-t-2 border-border bg-muted/30 font-semibold">
              <tr>
                <td className="p-2">Total</td>
                <td className="p-2 text-right tabular-nums">{tot.items.toLocaleString()}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{num(tot.outstanding)}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{num(tot.overdue)}</td>
                <td className="p-2 text-right tabular-nums whitespace-nowrap">{num(tot.outstanding - tot.overdue)}</td>
                <td className="p-2 text-right tabular-nums">{pct(tot.outstanding)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {!groups.length && <p className="py-5 text-center text-xs text-muted-foreground">{q.isLoading ? 'Loading locations…' : q.isError ? 'Location report unavailable.' : 'No receivables for this selection.'}</p>}
    </section>
  );
}
