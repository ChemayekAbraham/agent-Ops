import { useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { MapPin, Users, Banknote, Navigation, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useProfile } from '@/hooks/useProfile';
import { formatUGX } from '@/lib/rentCalculations';
import { Progress } from '@/components/ui/progress';

interface FloatData {
  float_limit: number;
  collected_today: number;
}

interface OpsStats {
  visitsToday: number;
  collectionsToday: number;
  collectionsTotalToday: number;
}

export function AgentDailyOpsCard() {
  const { profile } = useProfile();
  const [floatData, setFloatData] = useState<FloatData | null>(null);
  const [opsStats, setOpsStats] = useState<OpsStats>({ visitsToday: 0, collectionsToday: 0, collectionsTotalToday: 0 });

  useEffect(() => {
    if (!profile?.id) return;
    loadData();
  }, [profile?.id]);

  const loadData = async () => {
    if (!profile?.id) return;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // Reset float if stale, then fetch all data in parallel
    await supabase.rpc('reset_agent_float_if_stale', { p_agent_id: profile.id });

    const [floatRes, visitsRes, collectionsRes] = await Promise.all([
      supabase.from('agent_float_limits').select('float_limit, collected_today').eq('agent_id', profile.id).maybeSingle(),
      supabase.from('agent_visits').select('id', { count: 'exact', head: true }).eq('agent_id', profile.id).gte('checked_in_at', todayStart.toISOString()),
      supabase.from('agent_collections').select('amount').is('reversed_at', null).eq('agent_id', profile.id).gte('created_at', todayStart.toISOString()),
    ]);

    if (floatRes.data) {
      setFloatData({ float_limit: floatRes.data.float_limit, collected_today: floatRes.data.collected_today });
    }

    const totalCollected = (collectionsRes.data || []).reduce((sum: number, c: any) => sum + Number(c.amount), 0);
    setOpsStats({
      visitsToday: visitsRes.count || 0,
      collectionsToday: (collectionsRes.data || []).length,
      collectionsTotalToday: totalCollected,
    });
  };

  const remaining = floatData ? floatData.float_limit - floatData.collected_today : 0;
  const floatPercent = floatData && floatData.float_limit > 0 ? (floatData.collected_today / floatData.float_limit) * 100 : 0;
  const isFloatFull = floatData ? remaining <= 0 : false;

  return (
    <Card className="border-primary/20 bg-primary/5">
      <CardContent className="p-4 space-y-4">
        {/* Agent identity */}
        <div className="flex items-center justify-between">
          <div>
            <p className="font-bold text-base">{profile?.full_name || 'Agent'}</p>
            {profile?.territory && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <MapPin className="h-3 w-3" /> {profile.territory}
              </p>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">Daily Ops</p>
        </div>

        {/* Today's stats row */}
        <div className="grid grid-cols-3 gap-3">
          <div className="text-center p-2 rounded-xl bg-background/60">
            <Navigation className="h-4 w-4 mx-auto text-blue-500 mb-1" />
            <p className="font-bold text-lg">{opsStats.visitsToday}</p>
            <p className="text-[10px] text-muted-foreground">Visits</p>
          </div>
          <div className="text-center p-2 rounded-xl bg-background/60">
            <Banknote className="h-4 w-4 mx-auto text-success mb-1" />
            <p className="font-bold text-lg">{opsStats.collectionsToday}</p>
            <p className="text-[10px] text-muted-foreground">Collections</p>
          </div>
          <div className="text-center p-2 rounded-xl bg-background/60">
            <Users className="h-4 w-4 mx-auto text-primary mb-1" />
            <p className="font-bold text-sm leading-tight">{formatUGX(opsStats.collectionsTotalToday)}</p>
            <p className="text-[10px] text-muted-foreground">Collected</p>
          </div>
        </div>

        {/* Float gauge */}
        {floatData && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground font-medium">Float Capacity</span>
              {isFloatFull && (
                <span className="text-destructive flex items-center gap-1 font-semibold">
                  <AlertTriangle className="h-3 w-3" /> Full
                </span>
              )}
            </div>
            <Progress value={floatPercent} className="h-2.5" />
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Collected: {formatUGX(floatData.collected_today)}</span>
              <span>Limit: {formatUGX(floatData.float_limit)}</span>
            </div>
            <p className={`text-xs font-semibold ${isFloatFull ? 'text-destructive' : 'text-success'}`}>
              Remaining: {formatUGX(Math.max(0, remaining))}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
