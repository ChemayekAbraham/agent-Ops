import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/useAuth';
import {
  ArrowRight, CheckCircle2, Home, Loader2,
  Users, Calendar, Send, XCircle,
} from 'lucide-react';
import { format } from 'date-fns';

const STAGES = [
  { key: 'matched', label: 'Matched', icon: Users, color: 'bg-blue-500/20 text-blue-700 border-blue-500/30' },
  { key: 'scheduled', label: 'Scheduled', icon: Calendar, color: 'bg-amber-500/20 text-amber-700 border-amber-500/30' },
  { key: 'viewed', label: 'Viewed', icon: CheckCircle2, color: 'bg-purple-500/20 text-purple-700 border-purple-500/30' },
  { key: 'approved', label: 'Approved', icon: CheckCircle2, color: 'bg-green-500/20 text-green-700 border-green-500/30' },
  { key: 'moved_in', label: 'Moved In', icon: Home, color: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/30' },
] as const;

interface Viewing {
  id: string;
  house_listing_id: string;
  tenant_id: string;
  agent_id: string;
  landlord_id: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  status: string;
  agent_confirmed: boolean;
  tenant_confirmed: boolean;
  landlord_confirmed: boolean;
  confirmation_count: number;
  pin_verified: boolean;
  proximity_verified: boolean;
  meeting_verified: boolean;
  agent_rating: number | null;
  tenant_rating: number | null;
  viewing_pin: string | null;
  notes: string | null;
  created_at: string;
  // Joined
  tenant_name?: string;
  tenant_phone?: string;
  agent_name?: string;
  agent_phone?: string;
  house_title?: string;
  house_address?: string;
}

export function DealPipeline() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [advancing, setAdvancing] = useState<string | null>(null);
  const [sendingConfirmation, setSendingConfirmation] = useState<string | null>(null);

  const { data: viewings, isLoading } = useQuery({
    queryKey: ['deal-pipeline'],
    queryFn: async () => {
      const { data } = await supabase
        .from('property_viewings')
        .select('*')
        .not('status', 'eq', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(200);

      if (!data?.length) return [];

      // Fetch related profiles and listings
      const tenantIds = [...new Set(data.map(v => v.tenant_id))];
      const agentIds = [...new Set(data.map(v => v.agent_id))];
      const houseIds = [...new Set(data.map(v => v.house_listing_id))];

      const [tenantsRes, agentsRes, housesRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone').in('id', tenantIds),
        supabase.from('profiles').select('id, full_name, phone').in('id', agentIds),
        supabase.from('house_listings').select('id, title, address').in('id', houseIds),
      ]);

      const tenantMap = new Map((tenantsRes.data || []).map(p => [p.id, p]));
      const agentMap = new Map((agentsRes.data || []).map(p => [p.id, p]));
      const houseMap = new Map((housesRes.data || []).map(h => [h.id, h]));

      return data.map(v => ({
        ...v,
        tenant_name: tenantMap.get(v.tenant_id)?.full_name || 'Unknown',
        tenant_phone: tenantMap.get(v.tenant_id)?.phone || '',
        agent_name: agentMap.get(v.agent_id)?.full_name || 'Unknown',
        agent_phone: agentMap.get(v.agent_id)?.phone || '',
        house_title: houseMap.get(v.house_listing_id)?.title || 'Unknown',
        house_address: houseMap.get(v.house_listing_id)?.address || '',
      })) as Viewing[];
    },
    staleTime: 30000,
  });

  const getNextStatus = (current: string) => {
    const order = ['matched', 'scheduled', 'viewed', 'approved', 'moved_in'];
    const idx = order.indexOf(current);
    return idx < order.length - 1 ? order[idx + 1] : null;
  };

  const advanceStage = async (viewing: Viewing) => {
    const next = getNextStatus(viewing.status);
    if (!next) return;
    setAdvancing(viewing.id);
    try {
      const updates: Record<string, any> = { status: next, updated_at: new Date().toISOString() };

      // If moving to moved_in, also link tenant to the house
      if (next === 'moved_in') {
        await supabase.from('house_listings').update({ tenant_id: viewing.tenant_id, status: 'occupied' }).eq('id', viewing.house_listing_id);
      }

      const { error } = await supabase.from('property_viewings').update(updates).eq('id', viewing.id);
      if (error) throw error;

      toast({ title: `✅ Advanced to "${next}"`, description: `${viewing.tenant_name} → ${viewing.house_title}` });
      queryClient.invalidateQueries({ queryKey: ['deal-pipeline'] });
    } catch (err: any) {
      toast({ title: 'Failed', description: err.message, variant: 'destructive' });
    } finally {
      setAdvancing(null);
    }
  };

  const sendConfirmationSms = async (viewing: Viewing) => {
    setSendingConfirmation(viewing.id);
    try {
      await supabase.functions.invoke('viewing-confirmation-sms', {
        body: {
          type: 'confirm',
          viewing_id: viewing.id,
          tenant_name: viewing.tenant_name,
          tenant_phone: viewing.tenant_phone,
          agent_name: viewing.agent_name,
          agent_phone: viewing.agent_phone,
          house_title: viewing.house_title,
          house_address: viewing.house_address,
        },
      });
      toast({ title: '📱 SMS Sent', description: 'Confirmation SMS sent to all parties.' });
    } catch {
      toast({ title: 'SMS failed', variant: 'destructive' });
    } finally {
      setSendingConfirmation(null);
    }
  };

  const cancelViewing = async (viewingId: string) => {
    const { error } = await supabase.from('property_viewings').update({ status: 'cancelled' }).eq('id', viewingId);
    if (!error) {
      toast({ title: 'Viewing cancelled' });
      queryClient.invalidateQueries({ queryKey: ['deal-pipeline'] });
    }
  };

  const grouped = STAGES.map(stage => ({
    ...stage,
    items: (viewings || []).filter(v => v.status === stage.key),
  }));

  if (isLoading) {
    return <div className="space-y-3">{[1,2,3].map(i => <Skeleton key={i} className="h-32 w-full rounded-xl" />)}</div>;
  }

  return (
    <div className="space-y-4">
      {/* Pipeline Stats */}
      <div className="flex gap-2 overflow-x-auto pb-2">
        {grouped.map(stage => (
          <div key={stage.key} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium whitespace-nowrap ${stage.color}`}>
            <stage.icon className="h-3 w-3" />
            {stage.label}: {stage.items.length}
          </div>
        ))}
      </div>

      {/* Pipeline Columns */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
        {grouped.map(stage => (
          <div key={stage.key} className="space-y-2">
            <div className={`rounded-lg px-2.5 py-1.5 text-xs font-bold flex items-center gap-1.5 ${stage.color}`}>
              <stage.icon className="h-3.5 w-3.5" />
              {stage.label}
              <Badge variant="outline" className="text-[9px] h-4 px-1 ml-auto">{stage.items.length}</Badge>
            </div>

            {stage.items.length === 0 ? (
              <p className="text-[10px] text-muted-foreground text-center py-4">Empty</p>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {stage.items.map(viewing => (
                  <Card key={viewing.id} className="border-border/60">
                    <CardContent className="p-2.5 space-y-1.5">
                      <p className="font-semibold text-[11px] leading-tight truncate">{viewing.house_title}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{viewing.house_address}</p>

                      <div className="text-[10px] space-y-0.5">
                        <p>👤 {viewing.tenant_name}</p>
                        <p>🏃 {viewing.agent_name}</p>
                      </div>

                      {viewing.scheduled_date && (
                        <p className="text-[10px] text-primary font-medium">
                          📅 {format(new Date(viewing.scheduled_date), 'MMM d')} {viewing.scheduled_time}
                        </p>
                      )}

                      {/* Uber-style verification signals */}
                      <div className="flex gap-1 flex-wrap">
                        <Badge className={`text-[8px] h-4 px-1 border-0 ${viewing.proximity_verified ? 'bg-green-500/20 text-green-700' : 'bg-muted text-muted-foreground'}`}>
                          📍 GPS {viewing.proximity_verified ? '✓' : '—'}
                        </Badge>
                        <Badge className={`text-[8px] h-4 px-1 border-0 ${viewing.pin_verified ? 'bg-green-500/20 text-green-700' : 'bg-muted text-muted-foreground'}`}>
                          🔑 PIN {viewing.pin_verified ? '✓' : '—'}
                        </Badge>
                        {viewing.agent_rating && (
                          <Badge className="text-[8px] h-4 px-1 border-0 bg-amber-500/20 text-amber-700">
                            ⭐ Agent {viewing.agent_rating}/5
                          </Badge>
                        )}
                        {viewing.tenant_rating && (
                          <Badge className="text-[8px] h-4 px-1 border-0 bg-amber-500/20 text-amber-700">
                            ⭐ Tenant {viewing.tenant_rating}/5
                          </Badge>
                        )}
                        {viewing.meeting_verified && (
                          <Badge className="text-[8px] h-4 px-1 border-0 bg-green-600/20 text-green-800 font-bold">
                            ✅ VERIFIED
                          </Badge>
                        )}
                      </div>

                      {/* PIN display for manager reference */}
                      {viewing.viewing_pin && !viewing.pin_verified && (
                        <p className="text-[9px] text-muted-foreground font-mono">PIN: {viewing.viewing_pin}</p>
                      )}

                      {/* Actions */}
                      <div className="flex gap-1 pt-1">
                        {getNextStatus(viewing.status) && (
                          <Button
                            size="sm"
                            className="h-6 text-[10px] gap-1 flex-1"
                            onClick={() => advanceStage(viewing)}
                            disabled={advancing === viewing.id}
                          >
                            {advancing === viewing.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <ArrowRight className="h-2.5 w-2.5" />}
                            {getNextStatus(viewing.status)}
                          </Button>
                        )}
                        {stage.key === 'scheduled' && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px] gap-1"
                            onClick={() => sendConfirmationSms(viewing)}
                            disabled={sendingConfirmation === viewing.id}
                          >
                            {sendingConfirmation === viewing.id ? <Loader2 className="h-2.5 w-2.5 animate-spin" /> : <Send className="h-2.5 w-2.5" />}
                            SMS
                          </Button>
                        )}
                        {stage.key !== 'moved_in' && (
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={() => cancelViewing(viewing.id)}>
                            <XCircle className="h-3 w-3 text-muted-foreground" />
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
