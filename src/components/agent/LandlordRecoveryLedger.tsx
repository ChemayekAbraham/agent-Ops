import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { User2, Users, TrendingUp, AlertTriangle, CheckCircle2, Clock, ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { format } from 'date-fns';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LandlordRecoveryLedger({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: recoveryData = [], isLoading } = useQuery({
    queryKey: ['landlord-recovery-ledger', user?.id],
    queryFn: async () => {
      if (!user) return [];

      // Get all landlord assignments for this agent
      const { data: assignments } = await supabase
        .from('agent_landlord_assignments')
        .select('landlord_id, rent_request_id')
        .eq('agent_id', user.id)
        .eq('status', 'active');

      if (!assignments?.length) return [];

      const landlordIds = [...new Set(assignments.map(a => a.landlord_id))];

      // Get landlord details
      const { data: landlords } = await supabase
        .from('landlords')
        .select('id, name, phone')
        .in('id', landlordIds);

      // Get all rent requests for these landlords by this agent
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, landlord_id, rent_amount, amount_repaid, status, created_at')
        .in('landlord_id', landlordIds)
        .in('status', ['disbursed', 'repaying', 'fully_repaid', 'funded', 'coo_approved']);

      if (!requests?.length) return [];

      // Get tenant profiles
      const tenantIds = [...new Set(requests.map(r => r.tenant_id))];
      const { data: tenants } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', tenantIds);

      const tenantMap = new Map((tenants || []).map(t => [t.id, t]));
      const landlordMap = new Map((landlords || []).map(l => [l.id, l]));

      // Get float payouts (what was paid to landlords)
      const { data: payouts } = await supabase
        .from('agent_float_withdrawals')
        .select('id, landlord_id, amount, status, created_at')
        .eq('agent_id', user.id)
        .in('landlord_id', landlordIds);

      const payoutsByLandlord = new Map<string, any[]>();
      (payouts || []).forEach(p => {
        const list = payoutsByLandlord.get(p.landlord_id) || [];
        list.push(p);
        payoutsByLandlord.set(p.landlord_id, list);
      });

      // Group by landlord
      const grouped = landlordIds.map(lid => {
        const landlord = landlordMap.get(lid);
        const landlordRequests = (requests || []).filter(r => r.landlord_id === lid);
        const landlordPayouts = payoutsByLandlord.get(lid) || [];

        const totalFunded = landlordRequests.reduce((s, r) => s + (r.rent_amount || 0), 0);
        const totalRecovered = landlordRequests.reduce((s, r) => s + (r.amount_repaid || 0), 0);
        const totalPaidToLandlord = landlordPayouts
          .filter(p => p.status !== 'rejected')
          .reduce((s, p) => s + p.amount, 0);

        const tenantBreakdown = landlordRequests.map(r => ({
          ...r,
          tenant: tenantMap.get(r.tenant_id),
          recoveryPct: r.rent_amount > 0 ? Math.min(100, ((r.amount_repaid || 0) / r.rent_amount) * 100) : 0,
        }));

        return {
          landlord_id: lid,
          landlord,
          totalFunded,
          totalRecovered,
          totalPaidToLandlord,
          // Recovery can never exceed what was funded — amount_repaid includes
          // Welile fees on top of the rent principal, so a fully-repaid tenant
          // would otherwise drive this negative. Clamp at 0.
          outstanding: Math.max(0, totalFunded - totalRecovered),
          recoveryPct: totalFunded > 0 ? Math.min(100, (totalRecovered / totalFunded) * 100) : 0,
          tenants: tenantBreakdown,
          payouts: landlordPayouts,
        };
      }).filter(g => g.totalFunded > 0);

      return grouped.sort((a, b) => b.outstanding - a.outstanding);
    },
    enabled: !!user && open,
  });

  const totals = recoveryData.reduce(
    (acc, g) => ({
      funded: acc.funded + g.totalFunded,
      recovered: acc.recovered + g.totalRecovered,
      paid: acc.paid + g.totalPaidToLandlord,
    }),
    { funded: 0, recovered: 0, paid: 0 }
  );

  const overallPct = totals.funded > 0 ? Math.min(100, (totals.recovered / totals.funded) * 100) : 0;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] rounded-t-2xl p-0">
        <SheetHeader className="px-4 pt-4 pb-2">
          <SheetTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-chart-4" />
            Landlord Recovery Ledger
          </SheetTitle>
        </SheetHeader>

        {/* Summary Strip */}
        <div className="mx-4 mb-3 p-3 rounded-xl bg-muted/50 border space-y-2">
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[10px] text-muted-foreground uppercase">Funded</p>
              <p className="font-bold text-sm">{formatUGX(totals.funded)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase">Recovered</p>
              <p className="font-bold text-sm text-success">{formatUGX(totals.recovered)}</p>
            </div>
            <div>
              <p className="text-[10px] text-muted-foreground uppercase">Outstanding</p>
              <p className="font-bold text-sm text-destructive">{formatUGX(totals.funded - totals.recovered)}</p>
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Overall Recovery</span>
              <span>{overallPct.toFixed(0)}%</span>
            </div>
            <Progress value={overallPct} className="h-2" />
          </div>
        </div>

        <ScrollArea className="flex-1 h-[calc(90vh-180px)] px-4">
          {isLoading ? (
            <div className="flex justify-center py-12 text-muted-foreground text-sm">Loading...</div>
          ) : recoveryData.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground text-sm">
              No landlord recovery data yet.
            </div>
          ) : (
            <div className="space-y-3 pb-6">
              {recoveryData.map((group) => {
                const isOpen = expanded === group.landlord_id;
                const statusColor = group.recoveryPct >= 80 ? 'text-success' : group.recoveryPct >= 40 ? 'text-warning' : 'text-destructive';
                const StatusIcon = group.recoveryPct >= 80 ? CheckCircle2 : group.recoveryPct >= 40 ? Clock : AlertTriangle;

                return (
                  <div key={group.landlord_id} className="border rounded-xl overflow-hidden">
                    {/* Landlord Header */}
                    <button
                      onClick={() => setExpanded(isOpen ? null : group.landlord_id)}
                      className="w-full p-3 flex items-center gap-3 hover:bg-muted/30 transition-colors text-left"
                    >
                      <div className="p-2 rounded-lg bg-chart-4/10 shrink-0">
                        <User2 className="h-4 w-4 text-chart-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate">{group.landlord?.name || 'Unknown'}</p>
                        <div className="flex items-center gap-2 mt-0.5">
                          <StatusIcon className={`h-3 w-3 ${statusColor}`} />
                          <span className={`text-xs font-medium ${statusColor}`}>
                            {group.recoveryPct.toFixed(0)}% recovered
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            · {group.tenants.length} tenant{group.tenants.length !== 1 ? 's' : ''}
                          </span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-xs font-bold">{formatUGX(group.outstanding)}</p>
                        <p className="text-[10px] text-muted-foreground">outstanding</p>
                      </div>
                      {isOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                    </button>

                    {/* Expanded: Tenant Breakdown */}
                    {isOpen && (
                      <div className="border-t bg-muted/20 px-3 py-2 space-y-2">
                        {/* Landlord Summary */}
                        <div className="grid grid-cols-2 gap-2 text-xs pb-2 border-b border-border/50">
                          <div>
                            <span className="text-muted-foreground">Paid to Landlord:</span>
                            <span className="font-bold ml-1">{formatUGX(group.totalPaidToLandlord)}</span>
                          </div>
                          <div>
                            <span className="text-muted-foreground">Total Funded:</span>
                            <span className="font-bold ml-1">{formatUGX(group.totalFunded)}</span>
                          </div>
                        </div>

                        {/* Tenant Cards */}
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                          <Users className="h-3 w-3" /> Tenant Recovery Breakdown
                        </p>
                        {group.tenants.map((t: any) => (
                          <div key={t.id} className="p-2 rounded-lg bg-background border text-xs space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="font-medium">{t.tenant?.full_name || 'Unknown'}</span>
                              <Badge
                                variant={t.status === 'fully_repaid' ? 'default' : 'secondary'}
                                className="text-[9px]"
                              >
                                {t.status?.replace(/_/g, ' ')}
                              </Badge>
                            </div>
                            <div className="flex items-center justify-between text-muted-foreground">
                              <span>Rent: {formatUGX(t.rent_amount)}</span>
                              <span>Repaid: <span className="text-foreground font-medium">{formatUGX(t.amount_repaid || 0)}</span></span>
                            </div>
                            <p className="text-[10px] text-muted-foreground">
                              Since {format(new Date(t.created_at), 'dd MMM yy')}
                            </p>
                            <div className="space-y-0.5">
                              <div className="flex justify-between text-[10px]">
                                <span>{t.recoveryPct.toFixed(0)}%</span>
                                <span>{formatUGX(Math.max(0, (t.rent_amount || 0) - (t.amount_repaid || 0)))} left</span>
                              </div>
                              <Progress value={t.recoveryPct} className="h-1.5" />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
