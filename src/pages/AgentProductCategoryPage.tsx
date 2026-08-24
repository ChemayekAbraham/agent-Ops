import { useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { ArrowLeft, Bike, Smartphone, ShoppingBag, Signpost, HandCoins } from 'lucide-react';

import { AgentProductsPanel, type AgentProductCategory } from '@/components/executive/agent-ops/AgentProductsPanel';
import { AgentProductsServicesExportButton } from '@/components/executive/agent-ops/AgentProductsServicesExportButton';
import { AdvanceRequestsQueue } from '@/components/ops/AdvanceRequestsQueue';
import { AdvanceRequestsReviewed } from '@/components/ops/AdvanceRequestsReviewed';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';
import { RentHistoryVerificationQueue } from '@/components/ops/RentHistoryVerificationQueue';
import { ActiveAdvancesPanel } from '@/components/ops/ActiveAdvancesPanel';
import { AdvanceRepaymentsPanel } from '@/components/ops/AdvanceRepaymentsPanel';

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

        <header className="flex flex-col sm:flex-row sm:items-start gap-4 rounded-2xl border bg-card p-5 shadow-sm">
          <div className={`inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${entry.color} text-white shadow-md`}>
            <Icon className="h-6 w-6" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">{entry.label}</h1>
            <p className="text-sm text-muted-foreground">{entry.desc}</p>
          </div>
          <AgentProductsServicesExportButton className="sm:justify-end" />
        </header>

        {isAdvances ? (
          <div className="space-y-6">
            <AdvanceRequestsQueue stage="agent_ops" />
            <AdvanceRequestsReviewed />
            <BusinessAdvanceQueue stage="agent_ops" />
            <ActiveAdvancesPanel />
            <AdvanceRepaymentsPanel />
            <RentHistoryVerificationQueue dept="agent_ops" />
          </div>
        ) : (
          <div className="space-y-6">
            {entry.slug === 'smart-phones' && <SmartphoneOrderApprovalQueue />}
            <AgentProductsPanel category={entry.category ?? undefined} />
          </div>
        )}
      </div>
    </div>
  );
}
