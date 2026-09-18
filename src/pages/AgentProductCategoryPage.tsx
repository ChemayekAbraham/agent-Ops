import { useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { ArrowLeft, Bike, Smartphone, ShoppingBag, Signpost, HandCoins } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';

import { supabase as db } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AgentProductsPanel, type AgentProductCategory } from '@/components/executive/agent-ops/AgentProductsPanel';
import { AgentProductsServicesExportButton } from '@/components/executive/agent-ops/AgentProductsServicesExportButton';
import { AdvanceRequestsQueue } from '@/components/ops/AdvanceRequestsQueue';
import { AdvanceRequestsReviewed } from '@/components/ops/AdvanceRequestsReviewed';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';

import { SmartphoneCatalogDialog } from '@/components/executive/agent-ops/SmartphoneCatalogDialog';
import { MotorBikeCatalogDialog } from '@/components/executive/agent-ops/MotorBikeCatalogDialog';
import { SmartphoneOrderApprovalQueue } from '@/components/executive/agent-ops/SmartphoneOrderApprovalQueue';
import { BikeLeaseApprovalQueue } from '@/components/executive/agent-ops/BikeLeaseApprovalQueue';
import { LendingAgentsPanel } from '@/components/executive/LendingAgentsPanel';


export const AGENT_PRODUCT_PAGES = [
  { slug: 'motor-bikes', category: 'motor_bike' as AgentProductCategory, label: 'Agent Motor Bikes', desc: 'Spiro bike issuance, deliveries & receivables', icon: Bike, color: 'bg-orange-500', to: '/agent-ops/products/motor-bikes' },
  { slug: 'smart-phones', category: 'smart_phone' as AgentProductCategory, label: 'Agent Smart Phones', desc: 'Device orders, payments & outstanding balances', icon: Smartphone, color: 'bg-indigo-600', to: '/agent-ops/products/smart-phones' },
  { slug: 'boutique', category: 'boutique' as AgentProductCategory, label: 'Agent Boutique', desc: 'Branded merchandise sales & recoveries', icon: ShoppingBag, color: 'bg-rose-500', to: '/agent-ops/products/boutique' },
  { slug: 'signages', category: 'signage' as AgentProductCategory, label: 'Signages', desc: 'Shop signage production & agent contributions', icon: Signpost, color: 'bg-green-600', to: '/agent-ops/products/signages' },
  { slug: 'advances', category: null, label: 'Agent Advances', desc: 'Advance requests, limits & repayment queues', icon: HandCoins, color: 'bg-violet-600', to: '/agent-ops/products/advances' },
  { slug: 'lending-agents', category: null, label: 'Welile Lending Agents', desc: 'Lending agent onboarding, offers & loan books', icon: HandCoins, color: 'bg-violet-700', to: '/agent-ops/products/lending-agents' },
] as const;

export const AGENT_PRODUCTS_HUB_PATH = '/executive-hub?tab=agent-ops&section=agent-products-services';

export default function AgentProductCategoryPage() {
  const { slug } = useParams<{ slug: string }>();
  const entry = useMemo(() => AGENT_PRODUCT_PAGES.find((p) => p.slug === slug), [slug]);

  if (!entry) return <Navigate to={AGENT_PRODUCTS_HUB_PATH} replace />;

  const Icon = entry.icon;
  const isAdvances = entry.slug === 'advances';

  return (
    <div className="min-h-screen bg-background overflow-x-hidden w-full">
      <div className="mx-auto max-w-7xl px-3 sm:px-4 py-4 sm:py-5 space-y-4 sm:space-y-5 overflow-x-hidden max-w-full">
        <Link
          to={AGENT_PRODUCTS_HUB_PATH}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Products &amp; Services Hub
        </Link>

        <header className="flex flex-col sm:flex-row sm:items-start gap-4 rounded-2xl border bg-card p-4 sm:p-5 shadow-sm max-w-full overflow-hidden">
          <div className="flex items-center gap-3 sm:contents">
            <div className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${entry.color} text-white shadow-md`}>
              <Icon className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1 sm:hidden">
              <h1 className="text-xl font-bold tracking-tight">{entry.label}</h1>
              <p className="text-sm text-muted-foreground">{entry.desc}</p>
            </div>
          </div>
          <div className="hidden sm:block min-w-0 flex-1">
            <h1 className="text-2xl font-bold tracking-tight">{entry.label}</h1>
            <p className="text-sm text-muted-foreground">{entry.desc}</p>
          </div>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:justify-end w-full sm:w-auto">
            {entry.slug === 'smart-phones' && <SmartphoneCatalogDialog />}
            {entry.slug === 'motor-bikes' && <MotorBikeCatalogDialog />}
            <AgentProductsServicesExportButton />
          </div>
        </header>

        {entry.slug === 'lending-agents' ? (
          <LendingAgentsPanel />
        ) : isAdvances ? (
          <div className="space-y-6">
            <AdvanceRequestsQueue stage="agent_ops" />
            <AdvanceRequestsReviewed />
            <BusinessAdvanceQueue stage="agent_ops" />
          </div>
        ) : entry.slug === 'smart-phones' ? (
          <SmartphoneTabs category={entry.category ?? undefined} />
        ) : entry.slug === 'motor-bikes' ? (
          <MotorBikeTabs category={entry.category ?? undefined} />
        ) : entry.slug === 'boutique' || entry.slug === 'signages' ? (
          <BoutiqueTabs category={entry.category ?? undefined} />
        ) : (
          <div className="space-y-6">
            <AgentProductsPanel category={entry.category ?? undefined} />
          </div>
        )}

      </div>
    </div>
  );
}

const PENDING_STATUSES = ['pending_approval', 'submitted'];

function SmartphoneTabs({ category }: { category?: AgentProductCategory }) {
  const { data: orderCounts = { pending: 0, inProgress: 0, rejected: 0 } } = useQuery({
    queryKey: ['smartphone-order-counts'],
    queryFn: async () => {
      const { data, error } = await db.rpc('list_smartphone_orders', { p_status: null });
      if (error) throw error;
      const rows = (data || []) as { order_status: string }[];
      return {
        pending: rows.filter((o) => PENDING_STATUSES.includes(o.order_status)).length,
        inProgress: rows.filter((o) => ['ops_approved', 'coo_approved'].includes(o.order_status)).length,
        rejected: rows.filter((o) => o.order_status === 'rejected').length,
      };
    },
  });
  const pendingCount = orderCounts.pending;

  return (
    <Tabs defaultValue="overview" className="space-y-4 max-w-full">
      <div className="w-full overflow-x-auto no-scrollbar scrollbar-none pb-1">
        <TabsList className="inline-flex w-max min-w-full sm:min-w-0 justify-start h-10 p-1 gap-1 bg-muted/60 rounded-xl">
          <TabsTrigger value="overview" className="shrink-0 text-xs sm:text-sm">Overview</TabsTrigger>
          <TabsTrigger value="pending" className="shrink-0 text-xs sm:text-sm gap-1.5">
            Pending <span className="hidden sm:inline">Applications</span>
            {pendingCount > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="in-progress" className="shrink-0 text-xs sm:text-sm gap-1.5">
            In Progress
            {orderCounts.inProgress > 0 && (
              <Badge variant="secondary" className="bg-sky-500/15 text-sky-600 border-sky-500/30 text-[10px] px-1.5 py-0 h-4">
                {orderCounts.inProgress}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="issued" className="shrink-0 text-xs sm:text-sm">
            Issued <span className="hidden sm:inline">Devices</span>
          </TabsTrigger>
          <TabsTrigger value="rejected" className="shrink-0 text-xs sm:text-sm gap-1.5">
            Rejected <span className="hidden sm:inline">Applications</span>
            {orderCounts.rejected > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                {orderCounts.rejected}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="overview" className="space-y-6 max-w-full">
        <AgentProductsPanel category={category} mode="overview" />
      </TabsContent>

      <TabsContent value="pending" className="space-y-6 max-w-full">
        <SmartphoneOrderApprovalQueue pendingOnly />
      </TabsContent>

      <TabsContent value="in-progress" className="space-y-6 max-w-full">
        <SmartphoneOrderApprovalQueue inProgressOnly />
      </TabsContent>

      <TabsContent value="issued" className="space-y-6 max-w-full">
        <AgentProductsPanel category={category} mode="issued" />
      </TabsContent>

      <TabsContent value="rejected" className="space-y-6 max-w-full">
        <SmartphoneOrderApprovalQueue rejectedOnly />
      </TabsContent>
    </Tabs>
  );

}

function MotorBikeTabs({ category }: { category?: AgentProductCategory }) {
  const { data: counts = { pendingOps: 0, awaitingExec: 0, approved: 0 } } = useQuery({
    queryKey: ['bike-lease-queue'],
    queryFn: async () => {
      const { data, error } = await db.rpc('list_bike_lease_orders', { p_status: null });
      if (error) throw error;
      const rows = (data || []) as { order_status: string }[];
      return {
        pendingOps: rows.filter((o) => PENDING_STATUSES.includes(o.order_status)).length,
        awaitingExec: rows.filter((o) => ['ops_approved', 'coo_approved'].includes(o.order_status)).length,
        approved: rows.filter((o) => ['approved', 'completed'].includes(o.order_status)).length,
      };
    },
  });

  return (
    <Tabs defaultValue="overview" className="space-y-4 max-w-full">
      <div className="w-full overflow-x-auto no-scrollbar scrollbar-none pb-1">
        <TabsList className="inline-flex w-max min-w-full sm:min-w-0 justify-start h-10 p-1 gap-1 bg-muted/60 rounded-xl">
          <TabsTrigger value="overview" className="shrink-0 text-xs sm:text-sm">Overview</TabsTrigger>
          <TabsTrigger value="applications" className="shrink-0 text-xs sm:text-sm gap-1.5">
            Applications
            {counts.pendingOps > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                {counts.pendingOps}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="awaiting-exec" className="shrink-0 text-xs sm:text-sm gap-1.5">
            Awaiting Exec
            {counts.awaitingExec > 0 && (
              <Badge variant="secondary" className="bg-sky-500/15 text-sky-600 border-sky-500/30 text-[10px] px-1.5 py-0 h-4">
                {counts.awaitingExec}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="approved" className="shrink-0 text-xs sm:text-sm gap-1.5">
            Approved
            {counts.approved > 0 && (
              <Badge variant="secondary" className="bg-emerald-500/15 text-emerald-600 border-emerald-500/30 text-[10px] px-1.5 py-0 h-4">
                {counts.approved}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="overview" className="space-y-6 max-w-full">
        <AgentProductsPanel category={category} />
      </TabsContent>

      <TabsContent value="applications" className="space-y-6 max-w-full">
        <BikeLeaseApprovalQueue stage="ops" pendingOnly />
      </TabsContent>

      <TabsContent value="awaiting-exec" className="space-y-6 max-w-full">
        <BikeLeaseApprovalQueue stage="ops" awaitingExecOnly />
      </TabsContent>

      <TabsContent value="approved" className="space-y-6 max-w-full">
        <BikeLeaseApprovalQueue stage="ops" approvedOnly />
      </TabsContent>
    </Tabs>
  );
}

function BoutiqueTabs({ category }: { category?: AgentProductCategory }) {
  const { data: pendingCount = 0 } = useQuery({
    queryKey: ['agent-products-pending-count', category],
    queryFn: async () => {
      const { data, error } = await db.rpc('get_agent_products_overview' as any, { p_category: category });
      if (error) throw error;
      return (((data as any)?.pending ?? []) as unknown[]).length;
    },
    staleTime: 60_000,
  });

  return (
    <Tabs defaultValue="overview" className="space-y-4">
      <div className="w-full overflow-x-auto no-scrollbar scrollbar-none pb-1">
        <TabsList className="inline-flex w-max min-w-full sm:min-w-0 justify-start h-10 p-1 gap-1 bg-muted/60 rounded-xl">
          <TabsTrigger value="overview" className="shrink-0 text-xs sm:text-sm">Overview</TabsTrigger>
          <TabsTrigger value="applications" className="shrink-0 text-xs sm:text-sm gap-1.5">
            Applications
            {pendingCount > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="issued" className="shrink-0 text-xs sm:text-sm">
            Issued <span className="hidden sm:inline">in Field</span>
          </TabsTrigger>
          <TabsTrigger value="completed" className="shrink-0 text-xs sm:text-sm">
            Completed <span className="hidden sm:inline">Payments</span>
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="overview" className="space-y-6">
        <AgentProductsPanel category={category} mode="overview" />
      </TabsContent>

      <TabsContent value="applications" className="space-y-6">
        <AgentProductsPanel category={category} mode="applications" />
      </TabsContent>

      <TabsContent value="issued" className="space-y-6">
        <AgentProductsPanel category={category} mode="issued" />
      </TabsContent>

      <TabsContent value="completed" className="space-y-6">
        <AgentProductsPanel category={category} mode="completed" />
      </TabsContent>
    </Tabs>
  );
}
