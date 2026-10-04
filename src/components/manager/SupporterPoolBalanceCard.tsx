import { useState, useEffect } from 'react';
import { AlertTriangle, Shield } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { HandCoins, TrendingUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Skeleton } from '@/components/ui/skeleton';

export function SupporterPoolBalanceCard() {
  const [poolBalance, setPoolBalance] = useState(0);
  const [totalDeployed, setTotalDeployed] = useState(0);
  const [monthlyObligation, setMonthlyObligation] = useState(0);
  const [deployableAmount, setDeployableAmount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchPoolBalance();
    const handler = () => fetchPoolBalance();
    window.addEventListener('pool-funded', handler);
    return () => window.removeEventListener('pool-funded', handler);
  }, []);

  const fetchPoolBalance = async () => {
    // Use server-side RPC instead of 3 separate queries fetching all rows
    const { data, error } = await supabase.rpc('get_supporter_pool_stats');

    if (!error && data) {
      const d = data as any;
      setPoolBalance(Number(d.poolBalance) || 0);
      setTotalDeployed(Number(d.totalDeployed) || 0);
      setMonthlyObligation(Number(d.monthlyObligation) || 0);
      setDeployableAmount(Number(d.deployableAmount) || 0);
    }
    setLoading(false);
  };

  if (loading) {
    return <Skeleton className="h-24 w-full rounded-2xl" />;
  }

  return (
    <div className="rounded-2xl border-2 border-primary/30 bg-gradient-to-br from-primary/5 via-card to-primary/10 p-4 space-y-3 overflow-hidden">
      <div className="flex items-center gap-2.5">
        <div className="p-2 rounded-xl bg-primary/15">
          <HandCoins className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h3 className="font-black text-foreground text-sm">Supporter Pool Funds</h3>
          <p className="text-[10px] text-muted-foreground font-medium">Available for rent deployment</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-primary/10 px-3 py-2 min-w-0 overflow-hidden">
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider">Pool Balance</p>
          <p className="text-lg sm:text-xl font-black text-primary truncate">{formatUGX(poolBalance)}</p>
        </div>
        <div className="rounded-xl bg-muted/50 px-3 py-2 min-w-0 overflow-hidden">
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider flex items-center gap-1">
            <TrendingUp className="h-3 w-3" /> Deployed
          </p>
          <p className="text-lg sm:text-xl font-black text-foreground truncate">{formatUGX(totalDeployed)}</p>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 min-w-0 overflow-hidden">
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider flex items-center gap-1">
            <Shield className="h-3 w-3 text-amber-600 shrink-0" /> 15% Reserve
          </p>
          <p className="text-base sm:text-lg font-black text-amber-600 dark:text-amber-400 truncate">{formatUGX(monthlyObligation)}</p>
          <p className="text-[9px] text-muted-foreground">Locked for supporter payouts</p>
        </div>
        <div className={`rounded-xl px-3 py-2 min-w-0 overflow-hidden ${deployableAmount > 0 ? 'border border-emerald-500/30 bg-emerald-500/10' : 'border border-destructive/30 bg-destructive/10'}`}>
          <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wider flex items-center gap-1">
            {deployableAmount <= 0 && <AlertTriangle className="h-3 w-3 text-destructive shrink-0" />}
            Deployable
          </p>
          <p className={`text-base sm:text-lg font-black truncate ${deployableAmount > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
            {formatUGX(deployableAmount)}
          </p>
          <p className="text-[9px] text-muted-foreground">Safe to fund tenants</p>
        </div>
      </div>
    </div>
  );
}
