import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, Shield, Users, AlertTriangle, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export function AgentRiskExposureCard() {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-risk-exposure', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;

      // Active subscription charges where this agent is guarantor
      const { data: charges } = await supabase
        .from('subscription_charges')
        .select('id, charge_amount, accumulated_debt, tenant_id, status')
        .eq('agent_id', user.id)
        .eq('status', 'active');

      const activeCharges = charges || [];
      const guaranteedTenants = new Set(activeCharges.map(c => c.tenant_id)).size;
      const totalExposure = activeCharges.reduce((s, c) => s + Number(c.charge_amount || 0), 0);
      const activeDebt = activeCharges.reduce((s, c) => s + Number(c.accumulated_debt || 0), 0);

      // Count tenants with accumulated debt this month
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const tenantsWithDebt = activeCharges.filter(c => Number(c.accumulated_debt || 0) > 0).length;

      return {
        guaranteedTenants,
        totalExposure,
        activeDebt,
        defaultsThisMonth: tenantsWithDebt,
      };
    },
    enabled: !!user?.id,
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (!data || data.guaranteedTenants === 0) return null;

  // Risk level based on debt vs exposure ratio
  const riskRatio = data.totalExposure > 0 ? data.activeDebt / data.totalExposure : 0;
  const riskLevel = riskRatio > 0.3 ? 'high' : riskRatio > 0.1 ? 'medium' : 'low';
  const riskConfig = {
    low: { color: 'text-emerald-600', bg: 'bg-emerald-500/10', label: 'Low Risk' },
    medium: { color: 'text-amber-600', bg: 'bg-amber-500/10', label: 'Medium Risk' },
    high: { color: 'text-destructive', bg: 'bg-destructive/10', label: 'High Risk' },
  }[riskLevel];

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" /> Risk Exposure
          </CardTitle>
          <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full', riskConfig.bg, riskConfig.color)}>
            {riskConfig.label}
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="p-2 rounded-lg bg-muted/50">
            <div className="flex items-center gap-1 text-muted-foreground mb-1">
              <Users className="h-3 w-3" /> Guaranteed
            </div>
            <p className="font-bold text-sm">{data.guaranteedTenants} tenants</p>
          </div>
          <div className="p-2 rounded-lg bg-muted/50">
            <div className="flex items-center gap-1 text-muted-foreground mb-1">
              <Shield className="h-3 w-3" /> Exposure
            </div>
            <p className="font-bold text-sm">{formatUGX(data.totalExposure)}</p>
          </div>
          <div className={cn('p-2 rounded-lg', data.activeDebt > 0 ? 'bg-destructive/10' : 'bg-muted/50')}>
            <div className="flex items-center gap-1 text-muted-foreground mb-1">
              <AlertTriangle className="h-3 w-3" /> Active Debt
            </div>
            <p className={cn('font-bold text-sm', data.activeDebt > 0 && 'text-destructive')}>
              {formatUGX(data.activeDebt)}
            </p>
          </div>
          <div className={cn('p-2 rounded-lg', data.defaultsThisMonth > 0 ? 'bg-amber-500/10' : 'bg-muted/50')}>
            <div className="flex items-center gap-1 text-muted-foreground mb-1">
              <TrendingDown className="h-3 w-3" /> Defaults (month)
            </div>
            <p className={cn('font-bold text-sm', data.defaultsThisMonth > 0 && 'text-amber-600')}>
              {data.defaultsThisMonth}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
