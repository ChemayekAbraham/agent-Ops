import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { History, Loader2, Pencil } from 'lucide-react';
import {
  monthKey,
  monthLabel,
  missionDashboardLabel,
  missionFontStack,
  isMissionRestricted,
} from '@/lib/dashboardMissions';
import { cn } from '@/lib/utils';

interface MissionRow {
  id: string;
  dashboard_role: string;
  period_month: string;
  mission: string | null;
  goals: unknown;
  font_family: string | null;
  is_active: boolean;
  updated_at: string;
}

interface MissionsHistoryListProps {
  /** Load the selected mission into the editor. */
  onSelect: (dashboardRole: string, period: string) => void;
  /** Currently edited draft, for highlighting. */
  activeRole?: string;
  activePeriod?: string;
}

/**
 * Browsable list of all authored missions — current month first, then history —
 * so the CEO can review and reopen any past or upcoming mission.
 */
export function MissionsHistoryList({ onSelect, activeRole, activePeriod }: MissionsHistoryListProps) {
  const [showAll, setShowAll] = useState(false);
  const current = monthKey();

  const { data, isFetching } = useQuery({
    queryKey: ['missions-history'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('dashboard_missions')
        .select('id, dashboard_role, period_month, mission, goals, font_family, is_active, updated_at')
        .order('period_month', { ascending: false })
        .order('dashboard_role', { ascending: true });
      if (error) throw error;
      return (data ?? []) as MissionRow[];
    },
    staleTime: 10_000,
  });

  const grouped = useMemo(() => {
    const rows = (data ?? []).filter((r) => !isMissionRestricted(r.dashboard_role));
    const visible = showAll ? rows : rows.filter((r) => r.period_month >= current).concat(
      rows.filter((r) => r.period_month < current).slice(0, 4),
    );
    const map = new Map<string, MissionRow[]>();
    for (const r of visible) {
      const arr = map.get(r.period_month) ?? [];
      arr.push(r);
      map.set(r.period_month, arr);
    }
    return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data, showAll, current]);

  const total = (data ?? []).filter((r) => !isMissionRestricted(r.dashboard_role)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          Missions — current & history
        </CardTitle>
        <CardDescription>
          Every mission authored across dashboards. Tap one to open it in the editor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isFetching && total === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading missions…
          </div>
        ) : total === 0 ? (
          <p className="text-sm text-muted-foreground">No missions authored yet.</p>
        ) : (
          <>
            {grouped.map(([period, rows]) => (
              <div key={period} className="space-y-2">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    {monthLabel(period)}
                  </p>
                  {period === current && (
                    <Badge className="h-5 px-2 text-[10px]">Current</Badge>
                  )}
                </div>
                <ul className="space-y-2">
                  {rows.map((r) => {
                    const isActive = r.dashboard_role === activeRole && r.period_month === activePeriod;
                    const goalsCount = Array.isArray(r.goals)
                      ? (r.goals as unknown[]).filter((g) => typeof g === 'string' && g.trim()).length
                      : 0;
                    return (
                      <li
                        key={r.id}
                        className={cn(
                          'flex items-start justify-between gap-3 rounded-xl border p-3 transition-colors',
                          isActive ? 'border-primary/60 bg-primary/5' : 'hover:bg-muted/40',
                        )}
                      >
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge variant="secondary" className="h-5 px-2 text-[10px]">
                              {missionDashboardLabel(r.dashboard_role)}
                            </Badge>
                            {goalsCount > 0 && (
                              <span className="text-[11px] text-muted-foreground">
                                {goalsCount} goal{goalsCount > 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          {r.mission ? (
                            <p
                              className="line-clamp-2 text-sm font-medium text-foreground"
                              style={{ fontFamily: missionFontStack(r.font_family) }}
                            >
                              {r.mission}
                            </p>
                          ) : (
                            <p className="text-sm italic text-muted-foreground">Goals only</p>
                          )}
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          variant={isActive ? 'default' : 'outline'}
                          className="shrink-0 gap-1"
                          onClick={() => onSelect(r.dashboard_role, r.period_month)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {isActive ? 'Editing' : 'Open'}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}

            {total > grouped.reduce((n, [, rows]) => n + rows.length, 0) && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)}>
                {showAll ? 'Show less' : `Show all (${total})`}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}