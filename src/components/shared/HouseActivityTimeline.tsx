import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, UserPlus, UserX, UserCog, History } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';

interface TimelineRow {
  id: string;
  action_type: string;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  actor_id: string | null;
  actor_name: string | null;
  created_at: string;
}

const META: Record<string, { label: string; icon: React.ElementType; tone: string }> = {
  tenant_bound_to_house: { label: 'Tenant bound', icon: UserPlus, tone: 'text-success' },
  tenant_removed_from_house: { label: 'Tenant removed', icon: UserX, tone: 'text-destructive' },
  house_agent_reassigned: { label: 'Agent reassigned', icon: UserCog, tone: 'text-primary' },
};

export function HouseActivityTimeline({ houseId }: { houseId: string }) {
  const q = useQuery({
    queryKey: ['house-activity-timeline', houseId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_house_activity_timeline', { p_house_id: houseId });
      if (error) throw error;
      return (data ?? []) as TimelineRow[];
    },
    staleTime: 30_000,
  });

  if (q.isLoading) {
    return <div className="flex items-center gap-2 text-[11px] text-muted-foreground py-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading timeline…</div>;
  }
  if (q.error) {
    return <p className="text-[11px] text-destructive py-2">Couldn't load timeline.</p>;
  }
  const rows = q.data ?? [];
  if (rows.length === 0) {
    return <p className="text-[11px] text-muted-foreground py-2 italic">No activity yet.</p>;
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground flex items-center gap-1">
        <History className="h-3 w-3" /> Activity timeline
      </p>
      <ol className="relative border-l border-border ml-1 pl-3 space-y-2">
        {rows.map((r) => {
          const m = META[r.action_type] ?? { label: r.action_type, icon: History, tone: 'text-muted-foreground' };
          const Icon = m.icon;
          const ts = new Date(r.created_at);
          return (
            <li key={r.id} className="relative">
              <span className={`absolute -left-[17px] top-0.5 h-3 w-3 rounded-full bg-background border-2 ${m.tone.replace('text-', 'border-')}`} />
              <div className="flex items-start gap-1.5">
                <Icon className={`h-3 w-3 mt-0.5 shrink-0 ${m.tone}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium">{m.label}</p>
                  {r.reason && <p className="text-[11px] text-muted-foreground italic">"{r.reason}"</p>}
                  <p className="text-[10px] text-muted-foreground">
                    {r.actor_name ?? 'System'} · {format(ts, 'MMM d, yyyy HH:mm')} · {formatDistanceToNow(ts, { addSuffix: true })}
                  </p>
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
