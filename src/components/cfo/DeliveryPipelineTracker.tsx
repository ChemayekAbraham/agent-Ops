import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Loader2, Truck, Clock, CheckCircle2, AlertTriangle, Phone, User, RefreshCw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDistanceToNow, differenceInHours } from 'date-fns';
import { toast } from 'sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface DeliveryItem {
  id: string;
  rent_request_id: string;
  tenant_id: string;
  landlord_id: string | null;
  agent_id: string | null;
  amount: number;
  payout_method: string | null;
  transaction_reference: string | null;
  disbursed_at: string;
  notes: string | null;
  // Joined
  tenant_name: string;
  agent_name: string;
  agent_phone: string;
  landlord_name: string;
  landlord_phone: string;
  confirmed: boolean;
  confirmed_at: string | null;
  hours_elapsed: number;
}

export function DeliveryPipelineTracker() {
  const [items, setItems] = useState<DeliveryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('pending');

  const fetchDeliveries = async () => {
    setLoading(true);
    try {
      // Fetch disbursement records
      const { data: disbursements, error } = await supabase
        .from('disbursement_records')
        .select('id, rent_request_id, tenant_id, landlord_id, agent_id, amount, payout_method, transaction_reference, disbursed_at, notes')
        .order('disbursed_at', { ascending: false })
        .limit(100);

      if (error || !disbursements) {
        console.error('Failed to fetch disbursements:', error);
        setLoading(false);
        return;
      }

      // Get delivery confirmations
      const disbIds = disbursements.map(d => d.id);
      const { data: confirmations } = await supabase
        .from('agent_delivery_confirmations')
        .select('disbursement_id, confirmed_at')
        .in('disbursement_id', disbIds);

      const confMap = new Map((confirmations || []).map(c => [c.disbursement_id, c.confirmed_at]));

      // Get profile info for agents and tenants
      const userIds = [...new Set([
        ...disbursements.map(d => d.tenant_id),
        ...disbursements.map(d => d.agent_id).filter(Boolean),
      ])] as string[];

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', userIds);

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));

      // Get landlord info
      const landlordIds = [...new Set(disbursements.map(d => d.landlord_id).filter(Boolean))] as string[];
      const { data: landlords } = landlordIds.length > 0
        ? await supabase.from('landlords').select('id, name, phone').in('id', landlordIds)
        : { data: [] };

      const landlordMap = new Map((landlords || []).map(l => [l.id, l]));

      const now = new Date();
      const mapped: DeliveryItem[] = disbursements.map(d => {
        const tenant = profileMap.get(d.tenant_id);
        const agent = d.agent_id ? profileMap.get(d.agent_id) : null;
        const landlord = d.landlord_id ? landlordMap.get(d.landlord_id) : null;
        const confirmedAt = confMap.get(d.id) || null;

        return {
          id: d.id,
          rent_request_id: d.rent_request_id,
          tenant_id: d.tenant_id,
          landlord_id: d.landlord_id,
          agent_id: d.agent_id,
          amount: d.amount,
          payout_method: d.payout_method,
          transaction_reference: d.transaction_reference,
          disbursed_at: d.disbursed_at,
          notes: d.notes,
          tenant_name: tenant?.full_name || 'Unknown',
          agent_name: agent?.full_name || 'Unassigned',
          agent_phone: agent?.phone || '',
          landlord_name: landlord?.name || 'Unknown',
          landlord_phone: landlord?.phone || '',
          confirmed: !!confirmedAt,
          confirmed_at: confirmedAt,
          hours_elapsed: differenceInHours(now, new Date(d.disbursed_at)),
        };
      });

      setItems(mapped);
    } catch (err) {
      console.error('Delivery pipeline fetch error:', err);
    }
    setLoading(false);
  };

  const handleEscalate = async (item: DeliveryItem) => {
    try {
      await supabase.from('notifications').insert({
        user_id: item.agent_id || item.tenant_id,
        title: '⚠️ Delivery Overdue',
        message: `Rent delivery to ${item.landlord_name} (${formatUGX(item.amount)}) is overdue. Disbursed ${item.hours_elapsed}h ago. Please confirm delivery or report issues.`,
        type: 'escalation',
        metadata: {
          disbursement_id: item.id,
          rent_request_id: item.rent_request_id,
          hours_overdue: item.hours_elapsed,
        },
      });
      
      await supabase.from('agent_escalations').insert({
        agent_id: item.agent_id || item.tenant_id,
        tenant_id: item.tenant_id,
        title: `Overdue delivery: ${item.landlord_name}`,
        description: `Rent of ${formatUGX(item.amount)} disbursed ${item.hours_elapsed}h ago but no delivery confirmation received.`,
        escalation_type: 'delivery_overdue',
        severity: item.hours_elapsed > 72 ? 'critical' : 'high',
        metadata: { disbursement_id: item.id, rent_request_id: item.rent_request_id },
      });

      toast.success('Escalation created and agent notified');
    } catch (err) {
      toast.error('Failed to create escalation');
    }
  };

  useEffect(() => { fetchDeliveries(); }, []);

  const pending = items.filter(i => !i.confirmed);
  const confirmed = items.filter(i => i.confirmed);
  const overdue = pending.filter(i => i.hours_elapsed > 48);
  const active = pending.filter(i => i.hours_elapsed <= 48);

  const getUrgencyBadge = (hours: number) => {
    if (hours > 48) return <Badge variant="destructive" className="text-[9px]"><AlertTriangle className="h-2.5 w-2.5 mr-0.5" />Overdue</Badge>;
    if (hours > 24) return <Badge className="text-[9px] bg-amber-500/15 text-amber-600 border-amber-500/30"><Clock className="h-2.5 w-2.5 mr-0.5" />Urgent</Badge>;
    return <Badge variant="secondary" className="text-[9px]"><Clock className="h-2.5 w-2.5 mr-0.5" />Active</Badge>;
  };

  const renderItem = (item: DeliveryItem) => (
    <Card key={item.id} className="border-border/50">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <p className="font-bold text-sm">{item.landlord_name}</p>
              {getUrgencyBadge(item.hours_elapsed)}
            </div>
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <User className="h-3 w-3" />
              Tenant: {item.tenant_name}
            </p>
          </div>
          <div className="text-right shrink-0">
            <p className="font-bold text-sm">{formatUGX(item.amount)}</p>
            <Badge variant="outline" className="text-[9px]">{item.payout_method || 'cash'}</Badge>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 bg-muted/30 rounded-lg p-2 text-xs">
          <div>
            <p className="text-muted-foreground text-[10px]">Assigned Agent</p>
            <p className="font-medium">{item.agent_name}</p>
            {item.agent_phone && (
              <a href={`tel:${item.agent_phone}`} className="text-primary flex items-center gap-0.5 text-[10px]">
                <Phone className="h-2.5 w-2.5" />{item.agent_phone}
              </a>
            )}
          </div>
          <div>
            <p className="text-muted-foreground text-[10px]">Landlord Contact</p>
            <p className="font-medium">{item.landlord_name}</p>
            {item.landlord_phone && (
              <a href={`tel:${item.landlord_phone}`} className="text-primary flex items-center gap-0.5 text-[10px]">
                <Phone className="h-2.5 w-2.5" />{item.landlord_phone}
              </a>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock className="h-2.5 w-2.5" />
            Disbursed {formatDistanceToNow(new Date(item.disbursed_at), { addSuffix: true })}
          </span>
          {item.transaction_reference && (
            <span className="font-mono text-[9px]">Ref: {item.transaction_reference}</span>
          )}
        </div>

        {/* Escalation actions for overdue deliveries */}
        {!item.confirmed && item.hours_elapsed > 24 && (
          <div className="flex items-center gap-2 pt-1 border-t border-border/50">
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-[10px] flex-1 gap-1"
              onClick={() => handleEscalate(item)}
            >
              <AlertTriangle className="h-3 w-3" />
              Escalate to Manager
            </Button>
            {item.agent_phone && (
              <a
                href={`tel:${item.agent_phone}`}
                className="inline-flex items-center justify-center h-7 px-3 rounded-md border border-input bg-background text-[10px] gap-1 hover:bg-muted transition-colors"
              >
                <Phone className="h-3 w-3" />
                Call Agent
              </a>
            )}
          </div>
        )}

        {item.confirmed && item.confirmed_at && (
          <div className="flex items-center gap-1 text-emerald-600 text-[10px] bg-emerald-500/10 rounded px-2 py-1">
            <CheckCircle2 className="h-3 w-3" />
            Confirmed {formatDistanceToNow(new Date(item.confirmed_at), { addSuffix: true })}
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Truck className="h-5 w-5 text-primary" />
            Delivery Pipeline
          </h1>
          <p className="text-sm text-muted-foreground">
            Track landlord rent delivery status and agent confirmations
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchDeliveries}>
          <RefreshCw className="h-3.5 w-3.5 mr-1" />Refresh
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-amber-600">{pending.length}</p>
            <p className="text-[10px] text-muted-foreground">Pending Delivery</p>
          </CardContent>
        </Card>
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-destructive">{overdue.length}</p>
            <p className="text-[10px] text-muted-foreground">Overdue (48h+)</p>
          </CardContent>
        </Card>
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-3 text-center">
            <p className="text-2xl font-bold text-emerald-600">{confirmed.length}</p>
            <p className="text-[10px] text-muted-foreground">Confirmed</p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full">
          <TabsTrigger value="pending" className="flex-1">
            Pending ({pending.length})
          </TabsTrigger>
          <TabsTrigger value="overdue" className="flex-1">
            Overdue ({overdue.length})
          </TabsTrigger>
          <TabsTrigger value="confirmed" className="flex-1">
            Confirmed ({confirmed.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pending" className="space-y-2 mt-3">
          {active.length === 0 ? (
            <p className="text-center py-6 text-sm text-muted-foreground">No pending deliveries within 48h</p>
          ) : active.map(renderItem)}
        </TabsContent>

        <TabsContent value="overdue" className="space-y-2 mt-3">
          {overdue.length === 0 ? (
            <p className="text-center py-6 text-sm text-muted-foreground">No overdue deliveries 🎉</p>
          ) : overdue.map(renderItem)}
        </TabsContent>

        <TabsContent value="confirmed" className="space-y-2 mt-3">
          {confirmed.length === 0 ? (
            <p className="text-center py-6 text-sm text-muted-foreground">No confirmed deliveries yet</p>
          ) : confirmed.map(renderItem)}
        </TabsContent>
      </Tabs>
    </div>
  );
}
