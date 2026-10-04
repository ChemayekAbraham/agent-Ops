import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { History, User, Loader2 } from 'lucide-react';
import { missionDashboardLabel, monthLabel } from '@/lib/dashboardMissions';

interface AuditRow {
  id: string;
  dashboard_role: string;
  period_month: string;
  mission: string | null;
  goals_count: number;
  posted_by_name: string | null;
  published_at: string;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

/** Audit log showing when each mission was published and the "Posted by" name used. */
export function MissionPublishAuditLog() {
  const { data, isLoading } = useQuery({
    queryKey: ['mission-publish-audit'],
    staleTime: 60000,
    queryFn: async (): Promise<AuditRow[]> => {
      const { data, error } = await supabase
        .from('mission_publish_audit')
        .select('id, dashboard_role, period_month, mission, goals_count, posted_by_name, published_at')
        .order('published_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data || []) as AuditRow[];
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          Mission publish log
        </CardTitle>
        <CardDescription>
          Every time a mission was published or updated — when it happened and the “Posted by” name used.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading log…
          </div>
        ) : !data || data.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">No missions have been published yet.</p>
        ) : (
          <ul className="divide-y">
            {data.map((row) => (
              <li key={row.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
                    {missionDashboardLabel(row.dashboard_role)}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                      {monthLabel(row.period_month)}
                    </span>
                    <span className="text-[11px] font-medium text-muted-foreground">
                      {row.goals_count} goal{row.goals_count === 1 ? '' : 's'}
                    </span>
                  </p>
                  {row.mission && (
                    <p className="mt-1 line-clamp-2 max-w-xl text-xs text-muted-foreground">{row.mission}</p>
                  )}
                  <p className="mt-1 flex items-center gap-1.5 text-xs font-medium text-foreground/80">
                    <User className="h-3.5 w-3.5 text-primary" />
                    Posted by: {row.posted_by_name || '—'}
                  </p>
                </div>
                <span className="shrink-0 text-xs font-medium text-muted-foreground">{formatWhen(row.published_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}