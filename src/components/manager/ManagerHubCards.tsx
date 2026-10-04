import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { 
  Wallet, 
  Home, 
  Shield,
  ArrowRight,
  Clock,
  CheckCircle,
  Users,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticSuccess } from '@/lib/haptics';
import { formatUGX } from '@/lib/rentCalculations';

interface ManagerHubCardsProps {
  pendingWalletOps: number;
  pendingWithdrawals: number;
  withdrawalStats: { pending: number; approved: number; rejected: number; pendingAmount: number; approvedAmount: number; rejectedAmount: number };
  pendingRequests: number;
  totalFacilitated: number;
  totalUsers: number;
  rentDueTotal: number;
  onOpenWallets: () => void;
  onOpenRentInvestments: () => void;
  onOpenBufferAccount: () => void;
}

export function ManagerHubCards({
  pendingWalletOps,
  pendingWithdrawals,
  withdrawalStats,
  pendingRequests,
  totalFacilitated,
  totalUsers,
  rentDueTotal,
  onOpenWallets,
  onOpenRentInvestments,
  onOpenBufferAccount,
}: ManagerHubCardsProps) {
  const totalPendingWallet = pendingWalletOps + pendingWithdrawals;

  const cards = [
    {
      id: 'wallets',
      icon: Wallet,
      title: 'Manage Wallets',
      subtitle: 'Deposits, withdrawals & approvals',
      accentColor: 'hsl(var(--primary))',
      borderClass: 'border-primary/20 hover:border-primary/40',
      iconBg: 'bg-primary/10',
      iconColor: 'text-primary',
      onClick: onOpenWallets,
      metrics: [
        { 
          label: 'Pending', 
          value: totalPendingWallet, 
          urgent: totalPendingWallet > 0,
          icon: totalPendingWallet > 0 ? AlertCircle : Clock,
        },
        { 
          label: 'Approved Today', 
          value: withdrawalStats.approved,
          icon: CheckCircle,
        },
      ],
      badge: totalPendingWallet > 0 ? totalPendingWallet : undefined,
    },
    {
      id: 'rent',
      icon: Home,
      title: 'Rent Management',
      subtitle: 'Requests, receivables & fund routing',
      accentColor: 'hsl(142, 71%, 45%)',
      borderClass: 'border-emerald-200/60 hover:border-emerald-400/60 dark:border-emerald-800/40 dark:hover:border-emerald-600/50',
      iconBg: 'bg-emerald-500/10',
      iconColor: 'text-emerald-600 dark:text-emerald-400',
      onClick: onOpenRentInvestments,
      metrics: [
        { 
          label: 'Pending Requests', 
          value: pendingRequests,
          urgent: pendingRequests > 0,
          icon: pendingRequests > 0 ? AlertCircle : Clock,
        },
        { 
          label: 'Rent Due', 
          value: rentDueTotal > 0 ? formatUGX(rentDueTotal) : 'UGX 0',
          icon: Home,
        },
      ],
      badge: pendingRequests > 0 ? pendingRequests : undefined,
    },
    {
      id: 'buffer',
      icon: Shield,
      title: 'Buffer Account',
      subtitle: 'Platform solvency & safety',
      accentColor: 'hsl(38, 92%, 50%)',
      borderClass: 'border-amber-200/60 hover:border-amber-400/60 dark:border-amber-800/40 dark:hover:border-amber-600/50',
      iconBg: 'bg-amber-500/10',
      iconColor: 'text-amber-600 dark:text-amber-400',
      onClick: onOpenBufferAccount,
      metrics: [
        { 
          label: 'Total Facilitated', 
          value: formatUGX(totalFacilitated),
          icon: Wallet,
        },
        { 
          label: 'Active Users', 
          value: totalUsers,
          icon: Users,
        },
      ],
    },
  ];

  return (
    <div className="space-y-2.5">
      {cards.map((card, index) => {
        const Icon = card.icon;
        return (
          <motion.div
            key={card.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.06, duration: 0.3, ease: 'easeOut' }}
          >
            <button
              className={cn(
                "w-full text-left rounded-2xl border bg-card p-4 transition-all duration-200",
                "active:scale-[0.98] touch-manipulation shadow-sm hover:shadow-md",
                card.borderClass
              )}
              onClick={() => {
                hapticSuccess();
                card.onClick();
              }}
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              {/* Header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className={cn("p-2.5 rounded-xl", card.iconBg)}>
                    <Icon className={cn("h-5 w-5", card.iconColor)} strokeWidth={2} />
                  </div>
                  <div>
                    <h3 className="text-[15px] font-semibold leading-tight tracking-tight">{card.title}</h3>
                    <p className="text-[11px] text-muted-foreground mt-0.5">{card.subtitle}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {card.badge && (
                    <span className="inline-flex items-center justify-center min-w-[22px] h-[22px] px-1.5 rounded-full bg-destructive text-destructive-foreground text-[11px] font-bold animate-pulse">
                      {card.badge}
                    </span>
                  )}
                  <ArrowRight className="h-4 w-4 text-muted-foreground/50" />
                </div>
              </div>

              {/* Metrics */}
              <div className="grid grid-cols-2 gap-2 min-w-0">
                {card.metrics.map((metric, mi) => {
                  const MetricIcon = metric.icon;
                  return (
                    <div 
                      key={mi} 
                      className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg bg-muted/50 min-w-0 overflow-hidden",
                        (metric as any).urgent && "bg-destructive/8 dark:bg-destructive/15"
                      )}
                    >
                      <MetricIcon className={cn(
                        "h-3.5 w-3.5 shrink-0",
                        (metric as any).urgent ? "text-destructive" : "text-muted-foreground"
                      )} />
                      <div className="min-w-0">
                        <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider leading-none">{metric.label}</p>
                        <p className={cn(
                          "text-sm font-bold mt-0.5 truncate",
                          (metric as any).urgent ? "text-destructive" : "text-foreground"
                        )}>
                          {typeof metric.value === 'number' ? metric.value.toLocaleString() : metric.value}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </button>
          </motion.div>
        );
      })}
    </div>
  );
}
