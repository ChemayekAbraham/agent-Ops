import { useState } from 'react';
import { motion } from 'framer-motion';
import { Users, TrendingUp, Wallet, AlertTriangle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { ManagerKPIDetailDrawer } from './ManagerKPIDetailDrawer';

type KPIType = 'users' | 'facilitated' | 'receivables' | 'actions';

interface ManagerKPIStripProps {
  totalUsers: number;
  activeUsers: number;
  newSignupsThisWeek: number;
  totalFacilitated: number;
  pendingActions: number;
  rentDueTotal: number;
  onNavigate?: (hub: string) => void;
}

export function ManagerKPIStrip({
  totalUsers,
  activeUsers,
  newSignupsThisWeek,
  totalFacilitated,
  pendingActions,
  rentDueTotal,
  onNavigate,
}: ManagerKPIStripProps) {
  const [detailType, setDetailType] = useState<KPIType | null>(null);

  const kpis: { label: string; value: string; sub: string; icon: typeof Users; color: string; hub: string; detailType: KPIType }[] = [
    {
      label: 'Users',
      value: totalUsers.toLocaleString(),
      sub: `+${newSignupsThisWeek} this week`,
      icon: Users,
      color: 'text-primary',
      hub: 'buffer',
      detailType: 'users',
    },
    {
      label: 'Facilitated',
      value: totalFacilitated >= 1_000_000 
        ? `${(totalFacilitated / 1_000_000).toFixed(1)}M` 
        : formatUGX(totalFacilitated),
      sub: 'Total deployed',
      icon: TrendingUp,
      color: 'text-emerald-600 dark:text-emerald-400',
      hub: 'rent-investments',
      detailType: 'facilitated',
    },
    {
      label: 'Receivables',
      value: rentDueTotal >= 1_000_000 
        ? `${(rentDueTotal / 1_000_000).toFixed(1)}M` 
        : formatUGX(rentDueTotal),
      sub: 'Outstanding',
      icon: Wallet,
      color: 'text-amber-600 dark:text-amber-400',
      hub: 'rent-investments',
      detailType: 'receivables',
    },
    {
      label: 'Actions',
      value: pendingActions.toString(),
      sub: 'Need attention',
      icon: AlertTriangle,
      color: pendingActions > 0 ? 'text-destructive' : 'text-muted-foreground',
      hub: 'wallets',
      detailType: 'actions',
    },
  ];

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="grid grid-cols-4 gap-1.5"
      >
        {kpis.map((kpi, i) => {
          const Icon = kpi.icon;
          return (
            <button
              key={i}
              onClick={() => setDetailType(kpi.detailType)}
              onDoubleClick={() => onNavigate?.(kpi.hub)}
              className="flex flex-col items-center text-center px-1 py-2.5 rounded-xl bg-card border border-border/40 transition-all active:scale-[0.96] hover:border-primary/30 hover:shadow-sm cursor-pointer touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <Icon className={cn("h-3.5 w-3.5 mb-1", kpi.color)} />
              <p className={cn("text-base font-bold leading-none", kpi.color)}>{kpi.value}</p>
              <p className="text-[9px] text-muted-foreground mt-1 leading-tight font-medium">{kpi.label}</p>
            </button>
          );
        })}
      </motion.div>

      <ManagerKPIDetailDrawer
        type={detailType}
        open={!!detailType}
        onOpenChange={(open) => { if (!open) setDetailType(null); }}
      />
    </>
  );
}
