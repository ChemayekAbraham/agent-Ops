import { useState } from 'react';
import { Users, Home, UserCheck, Briefcase, Building2, Moon } from 'lucide-react';
import { useCFOImpactMetrics } from '@/hooks/useCFOImpactMetrics';
import { Card, CardContent } from '@/components/ui/card';
import { CFOImpactDrilldownSheet } from '@/components/cfo/CFOImpactDrilldownSheet';
import type { ImpactMetric } from '@/hooks/useCFOImpactDrilldown';

const fmtCount = (n: number) => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
};

interface ImpactTileProps {
  icon: typeof Users;
  label: string;
  value: string;
  sublabel: string;
  iconBg: string;
  iconColor: string;
  loading?: boolean;
  onClick?: () => void;
}

function ImpactTile({ icon: Icon, label, value, sublabel, iconBg, iconColor, loading, onClick }: ImpactTileProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="flex items-start gap-2.5 p-3 rounded-xl bg-card border border-border min-w-0 text-left transition-colors hover:bg-accent/40 disabled:cursor-default disabled:hover:bg-card"
    >
      <div className={`h-9 w-9 rounded-lg ${iconBg} flex items-center justify-center shrink-0`}>
        <Icon className={`h-4.5 w-4.5 ${iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground truncate">{label}</p>
        {loading ? (
          <div className="h-6 w-16 bg-muted animate-pulse rounded mt-0.5" />
        ) : (
          <p className="text-lg font-bold leading-tight truncate">{value}</p>
        )}
        <p className="text-[10px] text-muted-foreground truncate">{sublabel}</p>
      </div>
    </button>
  );
}

/**
 * CFO Impact KPI Strip — surfaces "lives touched" metrics at the top of
 * the Overview tab so leadership can answer board questions instantly.
 */
export function CFOImpactKPIStrip() {
  const { data, isLoading } = useCFOImpactMetrics();
  const [drilldown, setDrilldown] = useState<ImpactMetric | null>(null);

  return (
    <>
    <Card className="rounded-2xl">
      <CardContent className="p-3">
        <div className="flex items-center justify-between mb-2 px-1">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Platform Impact</p>
          {data?.asOf && (
            <p className="text-[10px] text-muted-foreground">
              as of {new Date(data.asOf).toLocaleDateString()}
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <ImpactTile
            icon={Users}
            label="Total Users"
            value={fmtCount(data?.totalUsers ?? 0)}
            sublabel="all registered accounts"
            iconBg="bg-blue-100 dark:bg-blue-900/30"
            iconColor="text-blue-600"
            loading={isLoading}
            onClick={() => setDrilldown('users')}
          />
          <ImpactTile
            icon={Home}
            label="Tenants Impacted"
            value={fmtCount(data?.tenantsImpacted ?? 0)}
            sublabel="rent ever disbursed"
            iconBg="bg-emerald-100 dark:bg-emerald-900/30"
            iconColor="text-emerald-600"
            loading={isLoading}
            onClick={() => setDrilldown('tenants')}
          />
          <ImpactTile
            icon={UserCheck}
            label="Agents Earning"
            value={fmtCount(data?.agentsEarning ?? 0)}
            sublabel="last 30 days"
            iconBg="bg-amber-100 dark:bg-amber-900/30"
            iconColor="text-amber-600"
            loading={isLoading}
            onClick={() => setDrilldown('agents')}
          />
          <ImpactTile
            icon={Briefcase}
            label="Active Partners"
            value={fmtCount(data?.partnersWithPortfolios ?? 0)}
            sublabel="with portfolios"
            iconBg="bg-purple-100 dark:bg-purple-900/30"
            iconColor="text-purple-600"
            loading={isLoading}
            onClick={() => setDrilldown('partners')}
          />
          <ImpactTile
            icon={Building2}
            label="Active Landlords"
            value={fmtCount(data?.landlordsActive ?? 0)}
            sublabel="paid in last 90 days"
            iconBg="bg-teal-100 dark:bg-teal-900/30"
            iconColor="text-teal-600"
            loading={isLoading}
            onClick={() => setDrilldown('landlords_active')}
          />
          <ImpactTile
            icon={Moon}
            label="Dormant Landlords"
            value={fmtCount(data?.landlordsDormant ?? 0)}
            sublabel="no rent in 90+ days"
            iconBg="bg-muted dark:bg-slate-900/30"
            iconColor="text-muted-foreground"
            loading={isLoading}
            onClick={() => setDrilldown('landlords_dormant')}
          />
        </div>
      </CardContent>
    </Card>
    <CFOImpactDrilldownSheet
      open={drilldown !== null}
      onOpenChange={(o) => !o && setDrilldown(null)}
      metric={drilldown}
    />
    </>
  );
}