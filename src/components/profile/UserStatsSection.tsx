import { useNavigate } from 'react-router-dom';
import { UserStats } from '@/hooks/useUserStats';
import { Users, Building, UsersRound, Heart, Wallet, FileText, Banknote, Receipt, Home, MapPin, Truck, DollarSign, ScrollText, ChevronRight } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';

interface UserStatsSectionProps {
  stats: UserStats;
  loading: boolean;
}

interface StatItemProps {
  icon: React.ElementType;
  label: string;
  value: number | string;
  iconColor: string;
}

function StatItem({ icon: Icon, label, value, iconColor }: StatItemProps) {
  if (value === 0 || value === '0') return null;
  return (
    <div className="flex items-center justify-between py-1.5">
      <div className="flex items-center gap-2 text-sm">
        <Icon className={`h-4 w-4 ${iconColor}`} />
        <span className="text-muted-foreground">{label}</span>
      </div>
      <span className="text-sm font-semibold">{value}</span>
    </div>
  );
}

const fmt = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : n.toLocaleString();

export function UserStatsSection({ stats, loading }: UserStatsSectionProps) {
  const navigate = useNavigate();

  if (loading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
    );
  }

  const hasReferralStats =
    stats.tenantsRegistered > 0 || stats.landlordsRegistered > 0 ||
    stats.subAgentsRecruited > 0 || stats.supportersRegistered > 0;

  const hasAgentStats =
    stats.rentRequestsPosted > 0 || stats.totalEarnings > 0 ||
    stats.collectionsCount > 0 || stats.housesListed > 0 ||
    stats.visitsCount > 0 || stats.deliveryConfirmations > 0 ||
    stats.tenantsEarningFrom > 0 || stats.totalCommissions > 0;

  if (!hasReferralStats && !hasAgentStats) return null;

  return (
    <div className="space-y-3">
      {hasAgentStats && (
        <div>
          <p className="text-sm font-medium mb-2">Agent Performance</p>
          <div className="bg-muted/30 rounded-lg p-3 space-y-0.5">
            <StatItem icon={FileText} label="Rent Requests Posted" value={stats.rentRequestsPosted} iconColor="text-primary" />
            <StatItem icon={Home} label="Houses Listed" value={stats.housesListed} iconColor="text-amber-500" />
            <StatItem icon={Receipt} label="Collections Made" value={stats.collectionsCount} iconColor="text-emerald-500" />
            <StatItem icon={Banknote} label="Total Collected" value={fmt(stats.collectionsTotal)} iconColor="text-emerald-600" />
            <StatItem icon={MapPin} label="Tenant Visits" value={stats.visitsCount} iconColor="text-sky-500" />
            <StatItem icon={Truck} label="Delivery Confirmations" value={stats.deliveryConfirmations} iconColor="text-indigo-500" />
            <StatItem icon={Wallet} label="Tenants Earning From" value={stats.tenantsEarningFrom} iconColor="text-green-500" />
            <StatItem icon={DollarSign} label="Total Earnings" value={fmt(stats.totalEarnings)} iconColor="text-green-600" />
            <StatItem icon={Banknote} label="Commissions Paid Out" value={fmt(stats.totalCommissions)} iconColor="text-blue-500" />
          </div>
        </div>
      )}

      {hasReferralStats && (
        <div>
          <p className="text-sm font-medium mb-2">Referral Stats</p>
          <div className="bg-muted/30 rounded-lg p-3 space-y-0.5">
            <StatItem icon={Users} label="Tenants Registered" value={stats.tenantsRegistered} iconColor="text-blue-500" />
            <StatItem icon={Building} label="Landlords Registered" value={stats.landlordsRegistered} iconColor="text-purple-500" />
            <StatItem icon={UsersRound} label="Sub-Agents Recruited" value={stats.subAgentsRecruited} iconColor="text-orange-500" />
            <StatItem icon={Heart} label="Supporters Registered" value={stats.supportersRegistered} iconColor="text-pink-500" />
          </div>
        </div>
      )}
      {/* Agent Agreement Quick Access */}
      {(hasAgentStats || hasReferralStats) && (
        <div className="space-y-2">
          <button
            onClick={() => navigate('/agent-agreement')}
            className="w-full flex items-center justify-between py-3 px-4 rounded-xl border border-dashed border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <ScrollText className="h-4 w-4 text-primary" />
              </div>
              <div className="text-left">
                <p className="font-medium text-sm">Agent Terms & Conditions</p>
                <p className="text-xs text-muted-foreground">Tap to view agreement</p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
          <button
            onClick={() => navigate('/angel-pool-agreement')}
            className="w-full flex items-center justify-between py-3 px-4 rounded-xl border border-dashed border-amber-500/30 bg-amber-500/5 hover:bg-amber-500/10 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10">
                <ScrollText className="h-4 w-4 text-amber-600" />
              </div>
              <div className="text-left">
                <p className="font-medium text-sm">Angel Pool Agreement</p>
                <p className="text-xs text-muted-foreground">Tap to view & sign</p>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          </button>
        </div>
      )}
    </div>
  );
}
