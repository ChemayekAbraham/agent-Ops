import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { BarChart3 } from 'lucide-react';

interface ListingData {
  id: string;
  title: string;
  house_category: string;
  region: string;
  status: string;
  tenant_id: string | null;
  agent_name?: string;
  created_at: string;
}

interface VacancyAnalyticsProps {
  listings: ListingData[];
}

const COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--destructive))',
  'hsl(142, 76%, 36%)',
  'hsl(48, 96%, 53%)',
  'hsl(262, 83%, 58%)',
  'hsl(199, 89%, 48%)',
];

export function VacancyAnalytics({ listings }: VacancyAnalyticsProps) {
  const analytics = useMemo(() => {
    const empty = listings.filter(l => l.status === 'available' && !l.tenant_id);
    const occupied = listings.filter(l => l.tenant_id || l.status === 'occupied');

    // Vacancy by region
    const regionMap = new Map<string, { total: number; empty: number }>();
    listings.forEach(l => {
      const r = l.region || 'Unknown';
      const current = regionMap.get(r) || { total: 0, empty: 0 };
      current.total++;
      if (l.status === 'available' && !l.tenant_id) current.empty++;
      regionMap.set(r, current);
    });
    const byRegion = Array.from(regionMap.entries())
      .map(([region, data]) => ({
        region: region.length > 12 ? region.slice(0, 12) + '…' : region,
        total: data.total,
        empty: data.empty,
        rate: data.total > 0 ? Math.round((data.empty / data.total) * 100) : 0,
      }))
      .sort((a, b) => b.empty - a.empty)
      .slice(0, 8);

    // Vacancy by category
    const categoryMap = new Map<string, { total: number; empty: number }>();
    listings.forEach(l => {
      const c = l.house_category || 'Other';
      const current = categoryMap.get(c) || { total: 0, empty: 0 };
      current.total++;
      if (l.status === 'available' && !l.tenant_id) current.empty++;
      categoryMap.set(c, current);
    });
    const byCategory = Array.from(categoryMap.entries()).map(([name, data]) => ({
      name,
      value: data.empty,
      total: data.total,
    }));

    // Agent fill rate (top agents by listings)
    const agentMap = new Map<string, { total: number; filled: number }>();
    listings.forEach(l => {
      const agent = l.agent_name || 'Unknown';
      const current = agentMap.get(agent) || { total: 0, filled: 0 };
      current.total++;
      if (l.tenant_id || l.status === 'occupied') current.filled++;
      agentMap.set(agent, current);
    });
    const agentFillRate = Array.from(agentMap.entries())
      .filter(([_, d]) => d.total >= 2)
      .map(([agent, data]) => ({
        agent: agent.length > 15 ? agent.slice(0, 15) + '…' : agent,
        fillRate: data.total > 0 ? Math.round((data.filled / data.total) * 100) : 0,
        total: data.total,
        filled: data.filled,
      }))
      .sort((a, b) => b.fillRate - a.fillRate)
      .slice(0, 8);

    // Average days empty
    const avgDaysEmpty = empty.length > 0
      ? Math.round(empty.reduce((sum, l) => sum + Math.floor((Date.now() - new Date(l.created_at).getTime()) / 86400000), 0) / empty.length)
      : 0;

    return {
      totalEmpty: empty.length,
      totalOccupied: occupied.length,
      vacancyRate: listings.length > 0 ? Math.round((empty.length / listings.length) * 100) : 0,
      avgDaysEmpty,
      byRegion,
      byCategory,
      agentFillRate,
    };
  }, [listings]);

  if (listings.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <BarChart3 className="h-5 w-5 text-primary" />
          Occupancy Analytics
        </CardTitle>
        <div className="grid grid-cols-3 gap-2 mt-2">
          <div className="p-2 rounded-lg bg-destructive/10 text-center">
            <p className="text-lg font-bold text-destructive">{analytics.vacancyRate}%</p>
            <p className="text-[10px] text-muted-foreground">Vacancy Rate</p>
          </div>
          <div className="p-2 rounded-lg bg-primary/10 text-center">
            <p className="text-lg font-bold text-primary">{analytics.avgDaysEmpty}d</p>
            <p className="text-[10px] text-muted-foreground">Avg Days Empty</p>
          </div>
          <div className="p-2 rounded-lg bg-success/10 text-center">
            <p className="text-lg font-bold text-success">{analytics.totalOccupied}</p>
            <p className="text-[10px] text-muted-foreground">Occupied</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Vacancy by Region */}
        {analytics.byRegion.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Vacancy by Region</h4>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={analytics.byRegion} layout="vertical" margin={{ left: 0, right: 10 }}>
                <XAxis type="number" tick={{ fontSize: 10 }} />
                <YAxis dataKey="region" type="category" width={90} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number, name: string) => [v, name === 'empty' ? 'Empty' : 'Total']} />
                <Bar dataKey="total" fill="hsl(var(--muted-foreground) / 0.2)" radius={[0, 4, 4, 0]} />
                <Bar dataKey="empty" fill="hsl(var(--destructive))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Vacancy by Category */}
        {analytics.byCategory.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Empty by Category</h4>
            <div className="flex items-center gap-4">
              <ResponsiveContainer width={140} height={140}>
                <PieChart>
                  <Pie data={analytics.byCategory} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={60} innerRadius={30}>
                    {analytics.byCategory.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number, name: string) => [`${v} empty`, name]} />
                </PieChart>
              </ResponsiveContainer>
              <div className="flex-1 space-y-1">
                {analytics.byCategory.map((cat, i) => (
                  <div key={cat.name} className="flex items-center gap-2 text-xs">
                    <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                    <span className="flex-1 truncate">{cat.name}</span>
                    <span className="font-medium">{cat.value}/{cat.total}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Agent Fill Rate */}
        {analytics.agentFillRate.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Agent Fill Rate</h4>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={analytics.agentFillRate} layout="vertical" margin={{ left: 0, right: 10 }}>
                <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10 }} unit="%" />
                <YAxis dataKey="agent" type="category" width={100} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v: number) => [`${v}%`, 'Fill Rate']} />
                <Bar dataKey="fillRate" fill="hsl(var(--primary))" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
