import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { formatUGX } from '@/lib/rentCalculations';
import { Eye, Users, Home, TrendingUp } from 'lucide-react';
import { format, subDays, startOfDay } from 'date-fns';

type TopHouse = {
  id: string;
  title: string;
  count: number;
  lastAt: string;
  monthly_rent?: number;
  daily_rate?: number;
};

type EngagementData = {
  today: number;
  last7: number;
  last30: number;
  uniqueUsers: number;
  uniqueHouses: number;
  topHouses: TopHouse[];
};

const EVENT_TYPE = 'funder_house_repayment_terms_viewed';

/**
 * Funder engagement with the hidden repayment details on house cards.
 *
 * Tracks every click of “View repayment terms” in the funder listing and
 * surfaces daily/weekly/monthly view counts plus the most inspected houses.
 */
export function FunderEngagementPanel() {
  const { data, isLoading } = useQuery<EngagementData>({
    queryKey: ['exec-funder-engagement-panel'],
    staleTime: 300_000,
    queryFn: async () => {
      const now = new Date();
      const todayStart = startOfDay(now).toISOString();
      const d7 = subDays(now, 7).toISOString();
      const d30 = subDays(now, 30).toISOString();

      const [todayRes, d7Res, d30Res, rowsRes] = await Promise.all([
        supabase
          .from('system_events')
          .select('id', { count: 'exact', head: true })
          .eq('event_type', EVENT_TYPE)
          .gte('created_at', todayStart),
        supabase
          .from('system_events')
          .select('id', { count: 'exact', head: true })
          .eq('event_type', EVENT_TYPE)
          .gte('created_at', d7),
        supabase
          .from('system_events')
          .select('id', { count: 'exact', head: true })
          .eq('event_type', EVENT_TYPE)
          .gte('created_at', d30),
        supabase
          .from('system_events')
          .select('user_id, related_entity_id, created_at, metadata')
          .eq('event_type', EVENT_TYPE)
          .gte('created_at', d30)
          .order('created_at', { ascending: false })
          .limit(5000),
      ]);

      const rows = rowsRes.data || [];
      const uniqueUsers = new Set(rows.map((r) => r.user_id).filter(Boolean)).size;
      const uniqueHouses = new Set(rows.map((r) => r.related_entity_id).filter(Boolean)).size;

      const byHouse: Record<
        string,
        { count: number; lastAt: string; monthly_rent?: number; daily_rate?: number }
      > = {};
      rows.forEach((r) => {
        const id = r.related_entity_id || 'unknown';
        const meta = (r.metadata || {}) as Record<string, unknown>;
        if (!byHouse[id]) {
          byHouse[id] = {
            count: 0,
            lastAt: r.created_at,
            monthly_rent: typeof meta.monthly_rent === 'number' ? meta.monthly_rent : undefined,
            daily_rate: typeof meta.daily_rate === 'number' ? meta.daily_rate : undefined,
          };
        }
        byHouse[id].count++;
        if (r.created_at > byHouse[id].lastAt) {
          byHouse[id].lastAt = r.created_at;
        }
      });

      const topHouseIds = Object.entries(byHouse)
        .filter(([id]) => id !== 'unknown')
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([id]) => id);

      const houseTitles: Record<string, string> = {};
      if (topHouseIds.length) {
        for (let i = 0; i < topHouseIds.length; i += 100) {
          const chunk = topHouseIds.slice(i, i + 100);
          const { data: houses } = await supabase
            .from('house_listings')
            .select('id, title')
            .in('id', chunk);
          (houses || []).forEach((h: any) => {
            houseTitles[h.id] = h.title;
          });
        }
      }

      const topHouses: TopHouse[] = Object.entries(byHouse)
        .filter(([id]) => id !== 'unknown')
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([id, info]) => ({
          id,
          title: houseTitles[id] || 'Unknown house',
          count: info.count,
          lastAt: info.lastAt,
          monthly_rent: info.monthly_rent,
          daily_rate: info.daily_rate,
        }));

      return {
        today: todayRes.count || 0,
        last7: d7Res.count || 0,
        last30: d30Res.count || 0,
        uniqueUsers,
        uniqueHouses,
        topHouses,
      };
    },
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold">Funder engagement</h3>
        <p className="text-[11px] text-muted-foreground">
          How often funders open the hidden repayment details on house cards.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard
          title="Views today"
          value={data?.today ?? 0}
          icon={Eye}
          loading={isLoading}
          color="bg-primary/10 text-primary"
          subtitle="Repayment terms opens"
        />
        <KPICard
          title="Last 7 days"
          value={data?.last7 ?? 0}
          icon={TrendingUp}
          loading={isLoading}
          color="bg-blue-500/10 text-blue-600"
          subtitle="Weekly opens"
        />
        <KPICard
          title="Last 30 days"
          value={data?.last30 ?? 0}
          icon={Eye}
          loading={isLoading}
          color="bg-emerald-500/10 text-emerald-600"
          subtitle="Monthly opens"
        />
        <KPICard
          title="Unique funders"
          value={data?.uniqueUsers ?? 0}
          icon={Users}
          loading={isLoading}
          color="bg-purple-500/10 text-purple-600"
          subtitle="Distinct users (30d)"
        />
      </div>

      {data && data.uniqueHouses > 0 && (
        <p className="text-[10px] text-muted-foreground">
          {data.uniqueHouses.toLocaleString()} different house{data.uniqueHouses === 1 ? '' : 's'} inspected in the last 30 days.
        </p>
      )}

      {data?.topHouses && data.topHouses.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs font-semibold flex items-center gap-1.5">
            <Home className="h-3.5 w-3.5" />
            Top houses by detail views (30d)
          </h4>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b border-border">
                  <th className="text-left font-medium py-1.5">House</th>
                  <th className="text-right font-medium py-1.5">Views</th>
                  <th className="text-right font-medium py-1.5 hidden sm:table-cell">Monthly rent</th>
                  <th className="text-right font-medium py-1.5 hidden sm:table-cell">Last viewed</th>
                </tr>
              </thead>
              <tbody>
                {data.topHouses.map((h) => (
                  <tr key={h.id} className="border-b border-border/60 last:border-0">
                    <td className="py-1.5 truncate max-w-[180px]">{h.title}</td>
                    <td className="py-1.5 text-right font-semibold">{h.count}</td>
                    <td className="py-1.5 text-right hidden sm:table-cell">
                      {formatUGX(h.monthly_rent ?? 0)}
                    </td>
                    <td className="py-1.5 text-right text-muted-foreground hidden sm:table-cell">
                      {h.lastAt ? format(new Date(h.lastAt), 'dd MMM') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
