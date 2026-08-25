import { Card, CardContent } from '@/components/ui/card';
import {
  ClipboardList,
  CalendarCheck,
  Users,
  Activity,
  Gauge,
  Shield,
  Download,
  Landmark,
  CalendarX2,
} from 'lucide-react';
import { HubEntryCard } from '@/components/ops/HubEntryCard';
import { useTenantOpsToolCounts } from '@/hooks/useTenantOpsToolCounts';
import { formatUGX } from '@/lib/rentCalculations';
import type { TenantOpsViewKey } from './tenantOpsNav';

/**
 * Landing page for Tenant Ops → Classic. Live counts come from the same
 * `ops_tenant_ops_tool_counts` RPC the Classic cards already use; every tile
 * simply navigates the shell to an existing Classic view.
 */
export function TenantOpsHome({ onNavigate }: { onNavigate: (view: TenantOpsViewKey) => void }) {
  const { data: counts, isLoading } = useTenantOpsToolCounts();
  const c = counts;

  const kpis: { label: string; value: string; hint?: string; tone?: string }[] = [
    { label: 'Awaiting review', value: String(c?.review_requests ?? 0), hint: `${c?.new_requests ?? 0} new`, tone: 'text-warning' },
    { label: 'Active plans', value: String(c?.active_plans ?? 0), hint: `${c?.repaying_plans ?? 0} repaying` },
    { label: 'Tenants', value: String(c?.tenant_count ?? 0), hint: `${c?.active_tenants ?? 0} active` },
    { label: 'Collected today', value: formatUGX(c?.collected_today ?? 0), hint: `of ${formatUGX(c?.expected_today ?? 0)} expected` },
    { label: 'Paid today', value: String(c?.paid_today_tenants ?? 0), hint: `${c?.unpaid_today_tenants ?? 0} unpaid` },
    { label: 'Critical tenants', value: String(c?.critical_tenants ?? 0), hint: `${c?.missed_days_tenants ?? 0} missing days`, tone: 'text-destructive' },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-bold">Tenant Operations</h2>
        <p className="text-xs text-muted-foreground">
          Live position across requests, repayments and tenants. Pick a tool on the left, or jump straight in below.
        </p>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {kpis.map((k) => (
          <Card key={k.label} className="shadow-sm">
            <CardContent className="p-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{k.label}</p>
              <p className={`mt-1 text-base font-bold leading-none ${k.tone || 'text-foreground'}`}>
                {isLoading ? '—' : k.value}
              </p>
              {k.hint && <p className="mt-1 text-[10px] text-muted-foreground">{k.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Priority shortcuts */}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Start here</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <HubEntryCard
            title="Review Requests"
            description="Vet, approve or return incoming rent requests"
            icon={ClipboardList}
            stats={[{ label: 'in review', value: c?.review_requests ?? 0 }, { label: 'new', value: c?.new_requests ?? 0 }]}
            onClick={() => onNavigate('pipeline')}
          />
          <HubEntryCard
            title="Daily Payments"
            description="Who paid today and who still owes"
            icon={CalendarCheck}
            stats={[{ label: 'paid', value: c?.paid_today_tenants ?? 0 }, { label: 'unpaid', value: c?.unpaid_today_tenants ?? 0 }]}
            onClick={() => onNavigate('daily')}
          />
          <HubEntryCard
            title="Missed Days"
            description="Tenants behind on their daily repayment"
            icon={CalendarX2}
            stats={[{ label: 'tenants', value: c?.missed_days_tenants ?? 0 }]}
            onClick={() => onNavigate('missed')}
          />
          <HubEntryCard
            title="Tenant Behavior"
            description="Risk signals, warnings and critical accounts"
            icon={Activity}
            stats={[{ label: 'critical', value: c?.behavior_critical ?? 0 }, { label: 'warning', value: c?.behavior_warning ?? 0 }]}
            onClick={() => onNavigate('behavior')}
          />
          <HubEntryCard
            title="Global Verification Center"
            description="Landlord, LC1 and house verification queues"
            icon={Shield}
            onClick={() => onNavigate('global-verification')}
          />
          <HubEntryCard
            title="Welile Operations"
            description="Every user profile across tenants, landlords and agents"
            icon={Landmark}
            onClick={() => onNavigate('welile-operations')}
          />
          <HubEntryCard
            title="All Tenants"
            description="Search, register and manage the whole tenant base"
            icon={Users}
            stats={[{ label: 'tenants', value: c?.tenant_count ?? 0 }]}
            onClick={() => onNavigate('all-tenants-hub')}
          />
          <HubEntryCard
            title="Agent Rent Capacity"
            description="Daily eligibility and collection capacity per agent"
            icon={Gauge}
            onClick={() => onNavigate('agent-capacity-hub')}
          />
          <HubEntryCard
            title="Reports & Exports"
            description="Extracts, statements and date-ranged reports"
            icon={Download}
            onClick={() => onNavigate('reports-hub')}
          />
        </div>
      </div>
    </div>
  );
}
