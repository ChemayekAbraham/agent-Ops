import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ShieldCheck, MapPin, FileText, Database } from 'lucide-react';
import { cn } from '@/lib/utils';

const num = (n: number) => Number(n || 0).toLocaleString();
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);

const SINCE = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

type Row = {
  key: string;
  icon: any;
  label: string;
  hint: string;
  color: string;
  total: number;
  new30: number;
  new90: number;
  coverage: number | null;
  coverageLabel?: string;
};

/**
 * Data Completeness Scorecard
 *
 * Tracks the growth and coverage of the three proprietary datasets that turn
 * behaviour into financial value: verified identity, GPS-verified field visits,
 * and the rent-history credit dataset. Shows new records captured over the last
 * 30 and 90 days alongside overall coverage of the addressable base.
 */
export function DataCompletenessScorecard() {
  const { data, isLoading } = useQuery({
    queryKey: ['ceo-data-completeness'],
    staleTime: 600000,
    queryFn: async () => {
      const head = async (table: string, mod?: (q: any) => any) => {
        let q = supabase.from(table as any).select('*', { count: 'exact', head: true });
        if (mod) q = mod(q);
        const { count } = await q;
        return count || 0;
      };
      const [
        totalUsers,
        idTotal, idNew30, idNew90,
        visitsTotal, visits30, visits90,
        rentTotal, rent30, rent90, rentVerified,
        rentJourneys,
      ] = await Promise.all([
        head('profiles'),
        head('profiles', (q) => q.not('national_id', 'is', null).neq('national_id', '')),
        head('profiles', (q) => q.not('national_id', 'is', null).neq('national_id', '').gte('created_at', SINCE(30))),
        head('profiles', (q) => q.not('national_id', 'is', null).neq('national_id', '').gte('created_at', SINCE(90))),
        head('agent_visits'),
        head('agent_visits', (q) => q.gte('created_at', SINCE(30))),
        head('agent_visits', (q) => q.gte('created_at', SINCE(90))),
        head('rent_history_records'),
        head('rent_history_records', (q) => q.gte('created_at', SINCE(30))),
        head('rent_history_records', (q) => q.gte('created_at', SINCE(90))),
        head('rent_history_records', (q) => q.eq('status', 'verified')),
        head('rent_requests'),
      ]);

      const rows: Row[] = [
        {
          key: 'id',
          icon: ShieldCheck,
          label: 'ID Coverage',
          hint: 'Users with a verified national ID',
          color: 'bg-indigo-500/10 text-indigo-600',
          total: idTotal,
          new30: idNew30,
          new90: idNew90,
          coverage: pct(idTotal, totalUsers),
          coverageLabel: `${num(idTotal)} of ${num(totalUsers)} users`,
        },
        {
          key: 'gps',
          icon: MapPin,
          label: 'GPS-Verified Visits',
          hint: 'Field visits captured with geolocation',
          color: 'bg-cyan-500/10 text-cyan-600',
          total: visitsTotal,
          new30: visits30,
          new90: visits90,
          coverage: null,
        },
        {
          key: 'rent',
          icon: FileText,
          label: 'Rent-History Dataset',
          hint: 'Rent records powering the credit dataset',
          color: 'bg-orange-500/10 text-orange-600',
          total: rentTotal,
          new30: rent30,
          new90: rent90,
          coverage: pct(rentTotal, rentJourneys),
          coverageLabel: `${num(rentVerified)} verified · ${num(rentJourneys)} journeys`,
        },
      ];
      return rows;
    },
  });

  const rows = data || [];

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-start gap-2.5 p-3 sm:p-4 border-b border-border">
        <div className="p-2 rounded-lg bg-primary/10 text-primary shrink-0">
          <Database className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-bold leading-tight">Data Completeness Scorecard</h3>
          <p className="text-xs text-muted-foreground">
            New records captured and overall coverage across the proprietary datasets
          </p>
        </div>
      </div>

      {/* header row */}
      <div className="hidden sm:grid grid-cols-[1.6fr_repeat(4,1fr)] gap-2 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground bg-muted/30">
        <span>Dataset</span>
        <span className="text-right">New · 30d</span>
        <span className="text-right">New · 90d</span>
        <span className="text-right">Total</span>
        <span className="text-right">Coverage</span>
      </div>

      <div className="divide-y divide-border">
        {isLoading &&
          [0, 1, 2].map((i) => (
            <div key={i} className="px-4 py-3">
              <div className="h-8 w-full bg-muted animate-pulse rounded" />
            </div>
          ))}

        {!isLoading &&
          rows.map((r) => (
            <div
              key={r.key}
              className="grid grid-cols-2 sm:grid-cols-[1.6fr_repeat(4,1fr)] gap-2 px-4 py-3 items-center"
            >
              <div className="flex items-center gap-2.5 col-span-2 sm:col-span-1 min-w-0">
                <div className={cn('p-2 rounded-lg shrink-0', r.color)}>
                  <r.icon className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{r.label}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{r.hint}</p>
                </div>
              </div>

              <Metric mLabel="New · 30d" value={`+${num(r.new30)}`} />
              <Metric mLabel="New · 90d" value={`+${num(r.new90)}`} />
              <Metric mLabel="Total" value={num(r.total)} />

              <div className="text-right">
                <span className="sm:hidden text-[10px] text-muted-foreground block">Coverage</span>
                {r.coverage === null ? (
                  <span className="text-sm font-bold text-muted-foreground">—</span>
                ) : (
                  <>
                    <span
                      className={cn(
                        'text-sm font-bold',
                        r.coverage >= 60 ? 'text-emerald-600' : r.coverage >= 30 ? 'text-amber-600' : 'text-rose-600',
                      )}
                    >
                      {r.coverage}%
                    </span>
                    <div className="mt-1 h-1.5 w-full rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          r.coverage >= 60 ? 'bg-emerald-500' : r.coverage >= 30 ? 'bg-amber-500' : 'bg-rose-500',
                        )}
                        style={{ width: `${Math.min(100, r.coverage)}%` }}
                      />
                    </div>
                  </>
                )}
                {r.coverageLabel && (
                  <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{r.coverageLabel}</p>
                )}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function Metric({ mLabel, value }: { mLabel: string; value: string }) {
  return (
    <div className="text-right">
      <span className="sm:hidden text-[10px] text-muted-foreground block">{mLabel}</span>
      <span className="text-sm font-bold tabular-nums">{value}</span>
    </div>
  );
}