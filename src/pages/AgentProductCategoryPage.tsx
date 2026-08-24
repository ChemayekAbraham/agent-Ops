import { useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { ArrowLeft, Bike, Smartphone, ShoppingBag, Signpost, HandCoins } from 'lucide-react';
import { AgentPersonalRentRequestPanel } from '@/components/executive/agent-ops/AgentPersonalRentRequestPanel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AgentProductsPanel, type AgentProductCategory } from '@/components/executive/agent-ops/AgentProductsPanel';
import { AgentProductsServicesReport } from '@/components/executive/agent-ops/AgentProductsServicesReport';
import { AdvanceAnalyticsPanel } from '@/components/executive/agent-ops-v2/AdvanceAnalyticsPanel';
import { AdvanceRequestsQueue } from '@/components/ops/AdvanceRequestsQueue';
import { AdvanceRequestsReviewed } from '@/components/ops/AdvanceRequestsReviewed';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';
import { RentHistoryVerificationQueue } from '@/components/ops/RentHistoryVerificationQueue';
import { ActiveAdvancesPanel } from '@/components/ops/ActiveAdvancesPanel';
import { AdvanceRepaymentsPanel } from '@/components/ops/AdvanceRepaymentsPanel';
import { ServiceCentreVerificationQueue } from '@/components/executive/ServiceCentreVerificationQueue';
import { SmartphoneOrderApprovalQueue } from '@/components/executive/agent-ops/SmartphoneOrderApprovalQueue';


export const AGENT_PRODUCT_PAGES = [
  { slug: 'motor-bikes', category: 'motor_bike' as AgentProductCategory, label: 'Agent Motor Bikes', desc: 'Spiro bike issuance, deliveries & receivables', icon: Bike, color: 'bg-orange-500', to: '/agent-ops/products/motor-bikes' },
  { slug: 'smart-phones', category: 'smart_phone' as AgentProductCategory, label: 'Agent Smart Phones', desc: 'Device orders, payments & outstanding balances', icon: Smartphone, color: 'bg-indigo-600', to: '/agent-ops/products/smart-phones' },
  { slug: 'boutique', category: 'boutique' as AgentProductCategory, label: 'Agent Boutique', desc: 'Branded merchandise sales & recoveries', icon: ShoppingBag, color: 'bg-rose-500', to: '/agent-ops/products/boutique' },
  { slug: 'signages', category: 'signage' as AgentProductCategory, label: 'Signages', desc: 'Shop signage production & agent contributions', icon: Signpost, color: 'bg-green-600', to: '/agent-ops/products/signages' },
  { slug: 'advances', category: null, label: 'Agent Advances', desc: 'Advance requests, limits & repayment queues', icon: HandCoins, color: 'bg-violet-600', to: '/agent-ops/products/advances' },
] as const;

export const AGENT_PRODUCTS_HUB_PATH = '/executive-hub?tab=agent-ops&section=agent-products-services';

export default function AgentProductCategoryPage() {
  const { slug } = useParams<{ slug: string }>();
  const entry = useMemo(() => AGENT_PRODUCT_PAGES.find((p) => p.slug === slug), [slug]);

  if (!entry) return <Navigate to={AGENT_PRODUCTS_HUB_PATH} replace />;

  const Icon = entry.icon;
  const isAdvances = entry.slug === 'advances';
  const isServiceCentres = entry.slug === 'service-centres';
  const isPersonalRentRequest = entry.slug === 'personal-rent-request';

  if (isServiceCentres) {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto max-w-7xl px-4 py-5 space-y-5">
          <Link
            to={AGENT_PRODUCTS_HUB_PATH}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Products &amp; Services Hub
          </Link>

          <header className="flex items-start gap-4 rounded-2xl border bg-card p-5 shadow-sm">
            <div className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${entry.color} text-white shadow-md`}>
              <Icon className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{entry.label}</h1>
              <p className="text-sm text-muted-foreground">{entry.desc}</p>
            </div>
          </header>

          <ServiceCentreVerificationQueue />
        </div>
      </div>
    );
  }

  if (isPersonalRentRequest) {
    return (
      <div className="min-h-screen bg-background">
        <div className="mx-auto max-w-7xl px-4 py-5 space-y-5">
          <Link
            to={AGENT_PRODUCTS_HUB_PATH}
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Products &amp; Services Hub
          </Link>

          <header className="flex items-start gap-4 rounded-2xl border bg-card p-5 shadow-sm">
            <div className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${entry.color} text-white shadow-md`}>
              <Icon className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{entry.label}</h1>
              <p className="text-sm text-muted-foreground">{entry.desc}</p>
            </div>
          </header>

          <AgentPersonalRentRequestPanel />
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 py-5 space-y-5">
        <Link
          to={AGENT_PRODUCTS_HUB_PATH}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:underline"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Products &amp; Services Hub
        </Link>

        <header className="flex items-start gap-4 rounded-2xl border bg-card p-5 shadow-sm">
          <div className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${entry.color} text-white shadow-md`}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{entry.label}</h1>
            <p className="text-sm text-muted-foreground">{entry.desc}</p>
          </div>
        </header>

        {isAdvances ? (
          <Tabs defaultValue="requests" className="space-y-4">
            <TabsList className="flex-wrap h-auto">
              <TabsTrigger value="requests">Requests</TabsTrigger>
              <TabsTrigger value="active">Active &amp; repayments</TabsTrigger>
              <TabsTrigger value="verification">Verification</TabsTrigger>
              <TabsTrigger value="reporting">Reporting</TabsTrigger>
            </TabsList>
            <TabsContent value="requests" className="space-y-6">
              <AdvanceRequestsQueue stage="agent_ops" />
              <AdvanceRequestsReviewed />
              <BusinessAdvanceQueue stage="agent_ops" />
            </TabsContent>
            <TabsContent value="active" className="space-y-6">
              <ActiveAdvancesPanel />
              <AdvanceRepaymentsPanel />
            </TabsContent>
            <TabsContent value="verification" className="space-y-6">
              <RentHistoryVerificationQueue dept="agent_ops" />
            </TabsContent>
            <TabsContent value="reporting" className="space-y-6">
              <AdvanceAnalyticsPanel />
            </TabsContent>
          </Tabs>
        ) : (
          <Tabs defaultValue="manage" className="space-y-4">
            <TabsList>
              <TabsTrigger value="manage">Management &amp; issuance</TabsTrigger>
              <TabsTrigger value="reporting">Reporting</TabsTrigger>
            </TabsList>
            <TabsContent value="manage" className="space-y-6">
              {entry.slug === 'smart-phones' && <SmartphoneOrderApprovalQueue />}
              <AgentProductsPanel category={entry.category ?? undefined} />
            </TabsContent>

            <TabsContent value="reporting">
              <AgentProductsServicesReport />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
