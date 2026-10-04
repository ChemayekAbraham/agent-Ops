import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Users, TrendingUp, Wallet, AlertTriangle, UserCheck, UserPlus, Clock, Banknote, CheckCircle, XCircle, ArrowDownToLine, ArrowUpFromLine, Shield } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

type KPIType = 'users' | 'facilitated' | 'receivables' | 'actions' | null;

interface ManagerKPIDetailDrawerProps {
  type: KPIType;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface MetricRow {
  label: string;
  value: string | number;
  color?: string;
  icon?: React.ElementType;
  progress?: number;
}

export function ManagerKPIDetailDrawer({ type, open, onOpenChange }: ManagerKPIDetailDrawerProps) {
  const [loading, setLoading] = useState(true);
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [headerIcon, setHeaderIcon] = useState<React.ElementType>(Users);
  const [headerColor, setHeaderColor] = useState('text-primary');

  useEffect(() => {
    if (open && type) {
      setLoading(true);
      fetchDetails(type);
    }
  }, [open, type]);

  const fetchDetails = async (kpiType: KPIType) => {
    if (!kpiType) return;

    switch (kpiType) {
      case 'users':
        await fetchUserDetails();
        break;
      case 'facilitated':
        await fetchFacilitatedDetails();
        break;
      case 'receivables':
        await fetchReceivablesDetails();
        break;
      case 'actions':
        await fetchActionsDetails();
        break;
    }
    setLoading(false);
  };

  const fetchUserDetails = async () => {
    setTitle('User Breakdown');
    setSubtitle('Platform user distribution & activity');
    setHeaderIcon(Users);
    setHeaderColor('text-primary');

    const [totalRes, rolesRes, weekRes, activeRes] = await Promise.all([
      supabase.from('profiles').select('*', { count: 'exact', head: true }),
      supabase.from('user_roles').select('role'),
      supabase.from('profiles').select('*', { count: 'exact', head: true })
        .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()),
      supabase.from('profiles').select('*', { count: 'exact', head: true })
        .gte('last_active_at', new Date(Date.now() - 24 * 3600000).toISOString()),
    ]);

    const total = totalRes.count || 0;
    const weekSignups = weekRes.count || 0;
    const activeToday = activeRes.count || 0;
    const roles = rolesRes.data || [];

    const roleCounts: Record<string, number> = {};
    roles.forEach(r => {
      roleCounts[r.role] = (roleCounts[r.role] || 0) + 1;
    });

    const rows: MetricRow[] = [
      { label: 'Total Users', value: total.toLocaleString(), icon: Users, color: 'text-primary' },
      { label: 'Active Today', value: activeToday.toLocaleString(), icon: UserCheck, color: 'text-success' },
      { label: 'New This Week', value: `+${weekSignups}`, icon: UserPlus, color: 'text-emerald-600' },
      { label: 'Inactive (24h+)', value: Math.max(0, total - activeToday).toLocaleString(), icon: Clock, color: 'text-muted-foreground' },
    ];

    // Add role breakdown
    const roleLabels: Record<string, string> = {
      tenant: '🏠 Tenants',
      agent: '🤝 Agents',
      supporter: '💰 Supporters',
      manager: '🛡️ Managers',
      vendor: '🏪 Vendors',
    };

    Object.entries(roleLabels).forEach(([role, label]) => {
      if (roleCounts[role]) {
        rows.push({
          label,
          value: roleCounts[role].toLocaleString(),
          progress: total > 0 ? (roleCounts[role] / total) * 100 : 0,
        });
      }
    });

    setMetrics(rows);
  };

  const fetchFacilitatedDetails = async () => {
    setTitle('Facilitation Breakdown');
    setSubtitle('Rent deployment by status');
    setHeaderIcon(TrendingUp);
    setHeaderColor('text-emerald-600');

    // Use the RPC for summary stats
    const { data } = await supabase.rpc('get_rent_requests_summary');
    const s = (data as any) || {};

    const total = Number(s.total) || 0;
    const funded = Number(s.funded) || 0;
    const disbursed = Number(s.disbursed) || 0;
    const completed = Number(s.completed) || 0;
    const approved = Number(s.approved) || 0;
    const pending = Number(s.pending) || 0;
    const rejected = Number(s.rejected) || 0;

    // Get total amounts by status
    const { data: amountData } = await supabase
      .from('rent_requests')
      .select('status, rent_amount, funded_at')
      .in('status', ['funded', 'disbursed', 'completed', 'approved'])
      .limit(200);

    const statusAmounts: Record<string, number> = {};
    (amountData || []).forEach(r => {
      const st = r.status || 'unknown';
      statusAmounts[st] = (statusAmounts[st] || 0) + Number(r.rent_amount);
    });

    const totalDeployed = (statusAmounts['funded'] || 0) + (statusAmounts['disbursed'] || 0) + (statusAmounts['completed'] || 0);

    const rows: MetricRow[] = [
      { label: 'Total Deployed', value: formatUGX(totalDeployed), icon: Banknote, color: 'text-emerald-600' },
      { label: 'Funded (Active)', value: `${funded} requests · ${formatUGX(statusAmounts['funded'] || 0)}`, icon: CheckCircle, color: 'text-success' },
      { label: 'Disbursed', value: `${disbursed} requests · ${formatUGX(statusAmounts['disbursed'] || 0)}`, icon: TrendingUp, color: 'text-chart-5' },
      { label: 'Completed', value: `${completed} requests · ${formatUGX(statusAmounts['completed'] || 0)}`, icon: CheckCircle, color: 'text-primary' },
      { label: 'Approved (Awaiting Fund)', value: `${approved} · ${formatUGX(statusAmounts['approved'] || 0)}`, icon: Clock, color: 'text-amber-600' },
      { label: 'Pending Review', value: pending.toLocaleString(), icon: Clock, color: 'text-muted-foreground' },
      { label: 'Rejected', value: rejected.toLocaleString(), icon: XCircle, color: 'text-destructive' },
      { label: 'Total Requests', value: total.toLocaleString(), icon: Users, color: 'text-foreground', progress: total > 0 ? ((funded + disbursed + completed) / total) * 100 : 0 },
    ];

    setMetrics(rows);
  };

  const fetchReceivablesDetails = async () => {
    setTitle('Receivables Breakdown');
    setSubtitle('Outstanding rent & collection health');
    setHeaderIcon(Wallet);
    setHeaderColor('text-amber-600');

    const { data } = await supabase
      .from('rent_requests')
      .select('status, rent_amount, total_repayment, amount_repaid, funded_at')
      .in('status', ['approved', 'funded', 'disbursed'])
      .limit(200);

    const requests = data || [];
    let totalOwed = 0;
    let totalRepaid = 0;
    let overdueCount = 0;
    let currentCount = 0;
    let fullyPaidCount = 0;

    requests.forEach(r => {
      const owed = (r.total_repayment || 0) - (r.amount_repaid || 0);
      totalOwed += Math.max(0, owed);
      totalRepaid += Number(r.amount_repaid) || 0;

      if (owed <= 0) {
        fullyPaidCount++;
      } else if (Number(r.amount_repaid) === 0 && r.funded_at) {
        overdueCount++;
      } else {
        currentCount++;
      }
    });

    const collectionRate = (totalRepaid + totalOwed) > 0 ? (totalRepaid / (totalRepaid + totalOwed)) * 100 : 0;

    const rows: MetricRow[] = [
      { label: 'Total Outstanding', value: formatUGX(totalOwed), icon: Wallet, color: 'text-amber-600' },
      { label: 'Total Collected', value: formatUGX(totalRepaid), icon: CheckCircle, color: 'text-success' },
      { label: 'Collection Rate', value: `${collectionRate.toFixed(1)}%`, icon: TrendingUp, color: collectionRate >= 80 ? 'text-success' : collectionRate >= 60 ? 'text-amber-600' : 'text-destructive', progress: collectionRate },
      { label: 'Active (Paying)', value: `${currentCount} tenants`, icon: UserCheck, color: 'text-success' },
      { label: 'Zero Payment (Overdue)', value: `${overdueCount} tenants`, icon: AlertTriangle, color: 'text-destructive' },
      { label: 'Fully Repaid', value: `${fullyPaidCount} tenants`, icon: CheckCircle, color: 'text-primary' },
      { label: 'Active Facilitations', value: requests.length.toLocaleString(), icon: Users, color: 'text-foreground' },
    ];

    setMetrics(rows);
  };

  const fetchActionsDetails = async () => {
    setTitle('Pending Actions');
    setSubtitle('Items requiring manager attention');
    setHeaderIcon(AlertTriangle);
    setHeaderColor('text-destructive');

    const [pendingRent, pendingDeposits, pendingWithdrawals, pendingWalletOps] = await Promise.all([
      supabase.from('rent_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('deposit_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('investment_withdrawal_requests').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
      supabase.from('pending_wallet_operations').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    ]);

    const rentCount = pendingRent.count || 0;
    const depositCount = pendingDeposits.count || 0;
    const withdrawalCount = pendingWithdrawals.count || 0;
    const walletOpsCount = pendingWalletOps.count || 0;
    const totalActions = rentCount + depositCount + withdrawalCount + walletOpsCount;

    const rows: MetricRow[] = [
      { label: 'Total Pending Actions', value: totalActions.toLocaleString(), icon: AlertTriangle, color: totalActions > 0 ? 'text-destructive' : 'text-success' },
      { label: 'Rent Requests', value: rentCount.toLocaleString(), icon: Banknote, color: rentCount > 0 ? 'text-amber-600' : 'text-muted-foreground' },
      { label: 'Deposit Requests', value: depositCount.toLocaleString(), icon: ArrowDownToLine, color: depositCount > 0 ? 'text-primary' : 'text-muted-foreground' },
      { label: 'Withdrawal Requests', value: withdrawalCount.toLocaleString(), icon: ArrowUpFromLine, color: withdrawalCount > 0 ? 'text-destructive' : 'text-muted-foreground' },
      { label: 'Wallet Operations', value: walletOpsCount.toLocaleString(), icon: Shield, color: walletOpsCount > 0 ? 'text-amber-600' : 'text-muted-foreground' },
    ];

    setMetrics(rows);
  };

  const HeaderIcon = headerIcon;

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85vh]">
        <DrawerHeader className="pb-2">
          <div className="flex items-center gap-3">
            <div className={cn("p-2.5 rounded-xl", headerColor === 'text-primary' ? 'bg-primary/10' : headerColor === 'text-emerald-600' ? 'bg-emerald-500/10' : headerColor === 'text-amber-600' ? 'bg-amber-500/10' : 'bg-destructive/10')}>
              <HeaderIcon className={cn("h-5 w-5", headerColor)} />
            </div>
            <div>
              <DrawerTitle className="text-left">{title}</DrawerTitle>
              <p className="text-xs text-muted-foreground">{subtitle}</p>
            </div>
          </div>
        </DrawerHeader>

        <div className="px-4 pb-6 overflow-y-auto space-y-2">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
            </div>
          ) : (
            metrics.map((row, i) => {
              const Icon = row.icon;
              return (
                <div
                  key={i}
                  className="flex items-center gap-3 p-3 rounded-xl border border-border/50 bg-card"
                >
                  {Icon && <Icon className={cn("h-4 w-4 shrink-0", row.color || 'text-muted-foreground')} />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{row.label}</p>
                    {row.progress !== undefined && (
                      <Progress value={row.progress} className="h-1 mt-1" />
                    )}
                  </div>
                  <p className={cn("text-sm font-bold shrink-0", row.color || 'text-foreground')}>
                    {row.value}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
}
