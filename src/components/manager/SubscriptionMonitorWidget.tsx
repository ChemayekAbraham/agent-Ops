import { useState, useEffect } from 'react';
import { usePolling } from '@/hooks/usePolling';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, CreditCard, AlertTriangle, CheckCircle, Clock, TrendingUp, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { motion } from 'framer-motion';

interface SubscriptionCharge {
  id: string;
  tenant_id: string;
  tenant_name?: string;
  rent_request_id: string | null;
  service_type: string;
  charge_amount: number;
  frequency: string;
  next_charge_date: string;
  total_charges_due: number;
  total_charged: number;
  accumulated_debt: number;
  charges_completed: number;
  charges_remaining: number;
  status: string;
  created_at: string;
}

interface ChargeStats {
  active: number;
  completed: number;
  totalDebt: number;
  totalCharged: number;
  totalDue: number;
  dueToday: number;
}

export function SubscriptionMonitorWidget() {
  const [charges, setCharges] = useState<SubscriptionCharge[]>([]);
  const [stats, setStats] = useState<ChargeStats>({
    active: 0, completed: 0, totalDebt: 0, totalCharged: 0, totalDue: 0, dueToday: 0
  });
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);

  const formatUGX = (amount: number) =>
    `UGX ${amount.toLocaleString('en-UG', { maximumFractionDigits: 0 })}`;

  const fetchData = async () => {
    try {
      const { data, error } = await supabase
        .from('subscription_charges')
        .select('*')
        .order('next_charge_date', { ascending: true })
        .limit(100);

      if (error) throw error;

      const items = (data || []) as SubscriptionCharge[];
      
      // Resolve tenant names
      const tenantIds = [...new Set(items.map(c => c.tenant_id))];
      if (tenantIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', tenantIds);
        const profileMap = new Map((profiles || []).map(p => [p.id, p.full_name]));
        items.forEach(c => { c.tenant_name = profileMap.get(c.tenant_id) || undefined; });
      }
      
      setCharges(items);

      const today = new Date().toISOString().split('T')[0];
      setStats({
        active: items.filter(c => c.status === 'active').length,
        completed: items.filter(c => c.status === 'completed').length,
        totalDebt: items.reduce((s, c) => s + Number(c.accumulated_debt), 0),
        totalCharged: items.reduce((s, c) => s + Number(c.total_charged), 0),
        totalDue: items.reduce((s, c) => s + Number(c.total_charges_due), 0),
        dueToday: items.filter(c => c.status === 'active' && c.next_charge_date <= today).length,
      });
    } catch (err) {
      console.error('Error fetching subscription charges:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Polled every 60s (+ on focus). The old Realtime listener was on
  // subscription_charges, which is not in the publication, so it never fired
  // (doc 147).
  const { lastUpdatedAt, refresh } = usePolling(() => fetchData(), 60_000);

  const triggerAutoCharge = async () => {
    setProcessing(true);
    try {
      const { data, error } = await supabase.functions.invoke('auto-charge-wallets');
      if (error) throw error;
      toast.success(`Auto-charge processed: ${data?.results?.successful || 0} successful, ${data?.results?.insufficient || 0} insufficient funds`);
      fetchData();
    } catch (err) {
      toast.error('Failed to process auto-charges');
      console.error(err);
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <Card className="glass-card">
        <CardContent className="p-6 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const debtCharges = charges.filter(c => c.accumulated_debt > 0);

  return (
    <Card className="glass-card border-primary/20">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-bold flex items-center gap-2">
            <CreditCard className="h-5 w-5 text-primary" />
            Auto-Charge Monitor
          </CardTitle>
          <Button
            size="sm"
            variant="outline"
            onClick={triggerAutoCharge}
            disabled={processing}
            className="h-8 text-xs"
          >
            {processing ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <RefreshCw className="h-3 w-3 mr-1" />}
            Run Now
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary stats */}
        <div className="grid grid-cols-3 gap-2">
          <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Clock className="h-3.5 w-3.5 text-primary" />
              <span className="text-[10px] font-medium text-primary">Active</span>
            </div>
            <p className="text-lg font-black">{stats.active}</p>
            {stats.dueToday > 0 && (
              <p className="text-[10px] text-warning font-semibold">{stats.dueToday} due today</p>
            )}
          </div>
          <div className="rounded-xl bg-success/5 border border-success/20 p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <TrendingUp className="h-3.5 w-3.5 text-success" />
              <span className="text-[10px] font-medium text-success">Collected</span>
            </div>
            <p className="text-sm font-bold">{formatUGX(stats.totalCharged)}</p>
            <p className="text-[10px] text-muted-foreground">of {formatUGX(stats.totalDue)}</p>
          </div>
          <div className="rounded-xl bg-destructive/5 border border-destructive/20 p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
              <span className="text-[10px] font-medium text-destructive">Debt</span>
            </div>
            <p className="text-sm font-bold text-destructive">{formatUGX(stats.totalDebt)}</p>
            <p className="text-[10px] text-muted-foreground">{debtCharges.length} tenants</p>
          </div>
        </div>

        {/* Debt alerts */}
        {debtCharges.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-destructive flex items-center gap-1">
              <AlertTriangle className="h-3.5 w-3.5" />
              Tenants with Accumulated Debt
            </h4>
            {debtCharges.slice(0, 5).map((charge) => (
              <motion.div
                key={charge.id}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center justify-between rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2"
              >
              <div className="text-xs min-w-0 flex-1">
                  <p className="font-semibold truncate">{charge.tenant_name || charge.tenant_id.slice(0, 8)}</p>
                  <p className="text-muted-foreground capitalize">{charge.frequency} • {charge.charges_remaining} left</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-destructive">{formatUGX(Number(charge.accumulated_debt))}</p>
                  <Badge variant="destructive" className="text-[10px] h-4">debt</Badge>
                </div>
              </motion.div>
            ))}
            {debtCharges.length > 5 && (
              <p className="text-xs text-muted-foreground text-center">+{debtCharges.length - 5} more</p>
            )}
          </div>
        )}

        {/* Recent active */}
        {charges.filter(c => c.status === 'active').length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-muted-foreground">Active Schedules</h4>
            {charges.filter(c => c.status === 'active').slice(0, 5).map((charge) => (
              <div key={charge.id} className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
                <div className="text-xs min-w-0 flex-1">
                  <p className="font-semibold truncate">{charge.tenant_name || charge.tenant_id.slice(0, 8)}</p>
                  <p className="text-muted-foreground capitalize">
                    {charge.frequency} • Next: {new Date(charge.next_charge_date).toLocaleDateString()}
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-semibold">{formatUGX(Number(charge.charge_amount))}</p>
                  <div className="flex items-center gap-1">
                    <CheckCircle className="h-3 w-3 text-success" />
                    <span className="text-[10px] text-muted-foreground">{charge.charges_completed}/{charge.charges_completed + charge.charges_remaining}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {charges.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">
            No auto-charge subscriptions yet. They will appear when rent is funded.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
