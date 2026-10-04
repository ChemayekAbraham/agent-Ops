import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, Banknote, TrendingUp, Wallet, AlertTriangle, Clock, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { startOfDay, startOfMonth } from 'date-fns';

type HealthStatus = 'green' | 'yellow' | 'red';

function statusClasses(s: HealthStatus) {
  return {
    green: 'border-emerald-500/40 bg-emerald-500/8',
    yellow: 'border-amber-500/40 bg-amber-500/8',
    red: 'border-red-500/40 bg-red-500/8',
  }[s];
}

function iconColor(s: HealthStatus) {
  return { green: 'text-emerald-600', yellow: 'text-amber-600', red: 'text-red-600' }[s];
}

export default function FinancialMetricsCards() {
  const todayISO = startOfDay(new Date()).toISOString();
  const monthISO = startOfMonth(new Date()).toISOString();

  const { data, isLoading } = useQuery({
    queryKey: ['coo-financial-metrics'],
    queryFn: async () => {
      const [
        ledgerAll,
        ledgerToday,
        ledgerMonth,
        collectionsRes,
        walletsRes,
        pendingWithdrawals,
        failedWithdrawals,
      ] = await Promise.all([
        supabase.from('general_ledger').select('amount').eq('category', 'rent_repayment').eq('direction', 'cash_in').in('classification', ['production', 'legacy_real']).limit(500),
        supabase.from('general_ledger').select('amount, direction').gte('transaction_date', todayISO).in('classification', ['production', 'legacy_real']).limit(500),
        supabase.from('general_ledger').select('amount, direction').gte('transaction_date', monthISO).in('classification', ['production', 'legacy_real']).limit(500),
        supabase.from('agent_collections').select('amount').is('reversed_at', null).limit(500),
        supabase.from('wallets').select('balance').limit(500),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
        supabase.from('withdrawal_requests').select('id', { count: 'exact', head: true }).eq('status', 'failed'),
      ]);

      const totalRentCollected = (ledgerAll.data || []).reduce((s, r) => s + (r.amount || 0), 0);

      const todayEntries = ledgerToday.data || [];
      const totalPaymentsToday = todayEntries.reduce((s, r) => s + (r.amount || 0), 0);

      const monthEntries = ledgerMonth.data || [];
      const totalPaymentsMonth = monthEntries.reduce((s, r) => s + (r.amount || 0), 0);

      const agentCollections = (collectionsRes.data || []).reduce((s, r) => s + (r.amount || 0), 0);
      const systemWalletBalance = (walletsRes.data || []).reduce((s, r) => s + (r.balance || 0), 0);
      const pendingTx = pendingWithdrawals.count || 0;
      const failedTx = failedWithdrawals.count || 0;

      return { totalRentCollected, totalPaymentsToday, totalPaymentsMonth, agentCollections, systemWalletBalance, pendingTx, failedTx };
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  const tiles = [
    { label: 'Total Rent Collected', value: formatUGX(data?.totalRentCollected || 0), icon: Banknote, status: 'green' as HealthStatus },
    { label: 'Payments Today', value: formatUGX(data?.totalPaymentsToday || 0), icon: TrendingUp, status: 'green' as HealthStatus },
    { label: 'Payments This Month', value: formatUGX(data?.totalPaymentsMonth || 0), icon: TrendingUp, status: 'green' as HealthStatus },
    { label: 'Agent Collections', value: formatUGX(data?.agentCollections || 0), icon: Users, status: 'green' as HealthStatus },
    { label: 'System Wallet Balance', value: formatUGX(data?.systemWalletBalance || 0), icon: Wallet, status: (data?.systemWalletBalance || 0) > 0 ? 'green' : 'red' as HealthStatus },
    { label: 'Pending Approvals', value: data?.pendingTx || 0, icon: Clock, status: (data?.pendingTx || 0) > 5 ? 'yellow' : 'green' as HealthStatus },
    { label: 'Failed Transactions', value: data?.failedTx || 0, icon: AlertTriangle, status: (data?.failedTx || 0) > 0 ? 'red' : 'green' as HealthStatus },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {tiles.map((t) => (
        <div
          key={t.label}
          className={cn('p-3 rounded-xl border-2 transition-all min-w-0', statusClasses(t.status))}
        >
          <t.icon className={cn('h-4 w-4 mb-1.5 shrink-0', iconColor(t.status))} />
          <p className="text-sm sm:text-lg font-bold leading-tight truncate">{t.value}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{t.label}</p>
        </div>
      ))}
    </div>
  );
}
