import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sparkles, UserPlus, AlertTriangle, CalendarClock, DollarSign, CheckCircle2 } from 'lucide-react';
import { format, subHours } from 'date-fns';

interface PartnerOpsBriefProps {
  onNavigate?: (tab: string) => void;
}

export function PartnerOpsBrief({ onNavigate }: PartnerOpsBriefProps) {
  const { data } = useQuery({
    queryKey: ['partner-ops-brief'],
    queryFn: async () => {
      const since = subHours(new Date(), 24).toISOString();

      const [
        newPortfoliosRes,
        pendingApprovalsRes,
        { data: maturingSoon },
        { data: recentROI },
        escalationsRes,
      ] = await Promise.all([
        supabase.from('investor_portfolios').select('*', { count: 'exact', head: true }).gte('created_at', since),
        supabase.from('investor_portfolios').select('*', { count: 'exact', head: true }).eq('status', 'pending_approval'),
        supabase.from('investor_portfolios').select('id').eq('status', 'active')
          .gte('next_roi_date', format(new Date(), 'yyyy-MM-dd'))
          .lte('next_roi_date', format(new Date(Date.now() + 7 * 86400000), 'yyyy-MM-dd')),
        supabase.from('supporter_roi_payments').select('roi_amount').gte('due_date', since).eq('status', 'paid'),
        supabase.from('partner_escalations').select('*', { count: 'exact', head: true }).eq('status', 'open'),
      ]);

      const roiPaid24h = (recentROI || []).reduce((s, p) => s + (p.roi_amount || 0), 0);

      return {
        newPortfolios: newPortfoliosRes.count || 0,
        pendingApprovals: pendingApprovalsRes.count || 0,
        maturingSoon: (maturingSoon || []).length,
        roiPaid24h,
        openEscalations: escalationsRes.count || 0,
      };
    },
    staleTime: 300000,
  });

  if (!data) return null;

  const items = [
    { icon: UserPlus, label: 'New Portfolios (24h)', value: data.newPortfolios, color: 'text-blue-500', tab: 'portfolios' },
    { icon: AlertTriangle, label: 'Pending Approval', value: data.pendingApprovals, color: (data.pendingApprovals as number) > 0 ? 'text-amber-500' : 'text-muted-foreground', tab: 'portfolios' },
    { icon: CalendarClock, label: 'Payouts in 7 days', value: data.maturingSoon, color: data.maturingSoon > 0 ? 'text-orange-500' : 'text-muted-foreground', tab: 'portfolios' },
    { icon: DollarSign, label: 'ROI Paid (24h)', value: data.roiPaid24h > 0 ? `${(data.roiPaid24h / 1e3).toFixed(0)}K` : '0', color: 'text-green-500', tab: 'roi' },
    { icon: CheckCircle2, label: 'Open Escalations', value: data.openEscalations, color: data.openEscalations > 0 ? 'text-red-500' : 'text-green-500', tab: 'activity' },
  ];

  return (
    <Card className="bg-gradient-to-r from-primary/5 to-transparent border-primary/20">
      <CardHeader className="pb-1">
        <CardTitle className="text-xs flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Daily Partners Brief
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-5 gap-2">
          {items.map(item => (
            <button
              key={item.label}
              onClick={() => onNavigate?.(item.tab)}
              className="text-center rounded-lg p-2 transition-colors hover:bg-accent/60 active:scale-95 cursor-pointer"
            >
              <item.icon className={`h-4 w-4 mx-auto mb-0.5 ${item.color}`} />
              <p className="text-lg font-bold">{item.value}</p>
              <p className="text-[9px] text-muted-foreground leading-tight">{item.label}</p>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
