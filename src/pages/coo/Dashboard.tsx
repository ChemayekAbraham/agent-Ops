import { OverdueVettingOpsCard } from '@/components/service-center/OverdueVettingOpsCard';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { COOWithdrawalApprovals } from '@/components/coo/COOWithdrawalApprovals';
import { COOPartnerWithdrawalApprovals } from '@/components/coo/COOPartnerWithdrawalApprovals';
import { COOROIApprovals } from '@/components/coo/COOROIApprovals';
import { CancelledProxyWithdrawals } from '@/components/coo/CancelledProxyWithdrawals';
import FinancialTransactionsTable from '@/components/coo/FinancialTransactionsTable';
import AgentCollectionsOverview from '@/components/coo/AgentCollectionsOverview';
import { AgentCollectionsCommandCenter } from '@/components/executive/agent-ops-v2/AgentCollectionsCommandCenter';
import FinancialReportsPanel from '@/components/coo/FinancialReportsPanel';
import COOPartnersPage from '@/components/coo/COOPartnersPage';
import { StaffPerformancePanel } from '@/components/executive/StaffPerformancePanel';
import ExecutiveBrief from '@/hr/components/ExecutiveBrief';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';

import { RentPipelineQueue } from '@/components/executive/RentPipelineQueue';
import { RejectedRequestsQueue } from '@/components/executive/RejectedRequestsQueue';
import { FinancialOpsCommandCenter } from '@/components/financial-ops/FinancialOpsCommandCenter';
import { ShareSupporterRecruit } from '@/components/shared/ShareSupporterRecruit';
import { COOAgentHub } from '@/components/coo/COOAgentHub';
import { COOPartnerBroadcast } from '@/components/coo/COOPartnerBroadcast';
import { MissedDaysTracker } from '@/components/executive/MissedDaysTracker';
import { PendingPortfolioTopUps } from '@/components/cfo/PendingPortfolioTopUps';
import { PartnerFinancialActivity } from '@/components/executive/PartnerFinancialActivity';
import DailyCollectionMonitoringDashboard from '@/components/shared/DailyCollectionMonitoringDashboard';
import { useIsMobile } from '@/hooks/use-mobile';
import { useNavigate } from 'react-router-dom';
import { COOScaleVisionView } from '@/components/coo/COOScaleVisionView';
import { WelileOperationsHub } from '@/components/executive/WelileOperationsHub';
import { GlobalVerificationHub } from '@/components/executive/GlobalVerificationHub';
import { ApprovalHistoryLog } from '@/components/executive/ApprovalHistoryLog';
import COOOverviewSnapshot from '@/components/coo/COOOverviewSnapshot';
import { ServiceCentreReceivablesPanel } from '@/components/cfo/ServiceCentreReceivablesPanel';
import COODepartmentBudgets from '@/components/coo/COODepartmentBudgets';
import { COOServiceCentreVetting } from '@/components/coo/COOServiceCentreVetting';
import { AgentNetworkBadge } from '@/components/executive/tenant-ops/AgentNetworkBadge';
import {
  Activity, ClipboardList, Users, Wallet, BarChart3,
  FileText, Banknote, Handshake, UserCheck, UserPlus,
  TrendingUp, ArrowLeft, ChevronRight, Receipt, Home, CalendarCheck, Megaphone, Globe2, Landmark, Wallet2, Building2, ShieldCheck, Bike, MonitorSmartphone, ShoppingBag
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { BikeLeaseApprovalQueue } from '@/components/executive/agent-ops/BikeLeaseApprovalQueue';
import { BoutiqueOrderApprovalQueue } from '@/components/executive/agent-ops/BoutiqueOrderApprovalQueue';
import { SmartphoneOrderApprovalQueue } from '@/components/executive/agent-ops/SmartphoneOrderApprovalQueue';

interface QuickNavItem {
  id: string;
  label: string;
  icon: typeof Activity;
  color: string;
  description: string;
  route?: string;
}

const quickNavItems: QuickNavItem[] = [
  { id: 'rent-approvals', label: 'Rent Approvals', icon: ClipboardList, color: 'bg-blue-500/10 text-blue-600 border-blue-500/20', description: 'Review & approve' },
  { id: 'tenants', label: 'Tenants', icon: Home, color: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20', description: 'Repayment tracker' },
  { id: 'wallets', label: 'Wallets & Ops', icon: Wallet, color: 'bg-primary/10 text-primary border-primary/20', description: 'Deposits & payouts' },
  { id: 'transactions', label: 'Transactions', icon: BarChart3, color: 'bg-amber-500/10 text-amber-600 border-amber-500/20', description: 'Monitor activity' },
  { id: 'collections', label: 'Collections', icon: Users, color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20', description: 'Agent reports' },
  { id: 'daily-collections', label: 'Daily Collections', icon: CalendarCheck, color: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20', description: 'Live monitoring' },
  { id: 'withdrawals', label: 'Withdrawals', icon: Banknote, color: 'bg-red-500/10 text-red-600 border-red-500/20', description: 'Approve payouts' },
  { id: 'agent-activity', label: 'Agent Activity', icon: Activity, color: 'bg-purple-500/10 text-purple-600 border-purple-500/20', description: 'Live tracking' },
  { id: 'partners', label: 'Partners', icon: Handshake, color: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/20', description: 'Manage partners' },
  { id: 'partner-broadcast', label: 'Partner Broadcast', icon: Megaphone, color: 'bg-violet-500/10 text-violet-600 border-violet-500/20', description: 'Mass email partners' },
  { id: 'partner-onboarding', label: 'Partner Onboarding', icon: UserPlus, color: 'bg-fuchsia-500/10 text-fuchsia-600 border-fuchsia-500/20', description: 'Approve / reject', route: '/partner-onboarding' },
  { id: 'reports', label: 'Financial Reports', icon: FileText, color: 'bg-sky-500/10 text-sky-600 border-sky-500/20', description: 'Financial reports' },
  { id: 'partner-topups', label: 'Partner Top-ups', icon: TrendingUp, color: 'bg-green-500/10 text-green-600 border-green-500/20', description: 'Pending top-ups' },
  { id: 'partner-finance', label: 'Partner Finance', icon: Receipt, color: 'bg-violet-500/10 text-violet-600 border-violet-500/20', description: 'All activity' },
  { id: 'staff-performance', label: 'Staff', icon: UserCheck, color: 'bg-pink-500/10 text-pink-600 border-pink-500/20', description: 'Team metrics' },
  { id: 'advance-requests', label: 'Business Advances', icon: Banknote, color: 'bg-purple-500/10 text-purple-600 border-purple-500/20', description: 'Business advances' },
  { id: 'service-centres', label: 'Service Centre Vetting', icon: Building2, color: 'bg-orange-500/10 text-orange-600 border-orange-500/20', description: 'Vet & activate' },
  { id: 'department-budgets', label: 'Department Budgets', icon: Wallet2, color: 'bg-teal-500/10 text-teal-600 border-teal-500/20', description: 'Approve to CFO' },
  { id: 'agent-products-motorbikes', label: 'Welile Motorbikes', icon: Bike, color: 'bg-lime-500/10 text-lime-600 border-lime-500/20', description: 'Approve to CFO' },
  { id: 'agent-products-smartphones', label: 'Welile Smartphones', icon: MonitorSmartphone, color: 'bg-sky-500/10 text-sky-600 border-sky-500/20', description: 'Approve to CFO' },
  { id: 'agent-products-boutique', label: 'Agent Boutique', icon: ShoppingBag, color: 'bg-rose-500/10 text-rose-600 border-rose-500/20', description: 'Approve to CFO' },
  { id: 'scale-vision', label: 'At Scale (40M+)', icon: Globe2, color: 'bg-primary/10 text-primary border-primary/20', description: 'Hyperscale vision' },
];

export default function COODashboardPage() {
  const [activeTab, setActiveTab] = usePersistedActiveTab('coo');
  const isMobile = useIsMobile();
  const navigate = useNavigate();

  const handleNavTo = (tab: string) => {
    setActiveTab(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const renderBackButton = (label: string) => (
    <button
      onClick={() => handleNavTo('overview')}
      className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors mb-3 active:scale-95"
    >
      <ArrowLeft className="h-4 w-4" />
      <span>Back to Overview</span>
    </button>
  );

  const renderSectionHeader = (title: string, icon: typeof Activity) => {
    const Icon = icon;
    return (
      <div className="flex items-center gap-2.5 mb-4">
        <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="h-4.5 w-4.5 text-primary" />
        </div>
        <h1 className="text-lg font-bold">{title}</h1>
      </div>
    );
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'requisitions':
        return <RequisitionsWorkspace />;
      case 'service-centres':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Service Centre Vetting', Building2)}
            <p className="text-sm text-muted-foreground -mt-2">Vet service centres verified by Agent Ops. Your approval marks them active.</p>
            <COOServiceCentreVetting />
          </div>
        );
      case 'bike-leases':
      case 'agent-products-motorbikes':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Welile Motorbikes', Bike)}
            <p className="text-sm text-muted-foreground -mt-2">Motorbike applications verified by Agent Ops. Your approval forwards them to the CFO for disbursement — approved files stay listed here as “COO approved — awaiting CFO” and open read-only.</p>
            <BikeLeaseApprovalQueue stage="coo" />
          </div>
        );
      case 'agent-products-smartphones':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Welile Smartphones', MonitorSmartphone)}
            <p className="text-sm text-muted-foreground -mt-2">Smartphone applications verified by Agent Ops. Your approval forwards them to the CFO — approved files stay listed here as “Awaiting CFO” and open read-only.</p>
            <SmartphoneOrderApprovalQueue stage="coo" />
          </div>
        );
      case 'agent-products-boutique':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Agent Boutique', ShoppingBag)}
            <p className="text-sm text-muted-foreground -mt-2">New boutique orders come to you first. Your approval forwards them to the CFO for final approval and issuance — approved orders stay listed here as “COO approved — awaiting CFO”.</p>
            <BoutiqueOrderApprovalQueue stage="coo" />
          </div>
        );
      case 'rent-approvals':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Rent Approvals', ClipboardList)}
            <p className="text-sm text-muted-foreground -mt-2">Review rent requests approved by Landlord Ops. Your sign-off forwards to CFO for payout.</p>
            <RentPipelineQueue stage="partner_ops_approved" />
            <RejectedRequestsQueue stageFilter="partner_ops_approved" title="Rejected at COO" />
          </div>
        );
      case 'tenants':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Tenant Repayment Tracker', Home)}
            <p className="text-sm text-muted-foreground -mt-2">Track tenant repayment progress, overdue accounts, and assigned agent contacts.</p>
            <MissedDaysTracker />
          </div>
        );
      case 'transactions':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Transactions', BarChart3)}
            <FinancialTransactionsTable />
          </div>
        );
      case 'collections':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Agent Collections', Users)}
            <AgentCollectionsCommandCenter />
            <AgentCollectionsOverview />
          </div>
        );
      case 'daily-collections':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Daily Collection Monitoring', CalendarCheck)}
            <p className="text-sm text-muted-foreground -mt-2">Read-only view of live tenant collections, agent performance, and monthly trend.</p>
            <DailyCollectionMonitoringDashboard mode="readonly" />
          </div>
        );
      case 'wallets':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            <FinancialOpsCommandCenter requirePaymentRef={false} />
          </div>
        );
      case 'agent-activity':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Agent Activity', Activity)}
            <COOAgentHub />
          </div>
        );
      case 'reports':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Financial Reports', FileText)}
            <FinancialReportsPanel />
          </div>
        );
      case 'withdrawals':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Withdrawal Approvals', Banknote)}
            <COOWithdrawalApprovals />
            <COOPartnerWithdrawalApprovals />
          </div>
        );
      case 'roi-approvals':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('ROI Return Approvals', TrendingUp)}
            <p className="text-sm text-muted-foreground -mt-2">Approve partner ROI payouts before they go to CFO for disbursement.</p>
            <COOROIApprovals />
            <CancelledProxyWithdrawals />
          </div>
        );
      case 'partners':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Partners', Handshake)}
            <COOPartnersPage />
          </div>
        );
      case 'partner-broadcast':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            <COOPartnerBroadcast />
          </div>
        );
      case 'partner-topups':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Partner Top-ups', TrendingUp)}
            <p className="text-sm text-muted-foreground -mt-2">Pending portfolio top-up requests awaiting verification.</p>
            <PendingPortfolioTopUps />
          </div>
        );
      case 'partner-finance':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Partner Financial Activity', Receipt)}
            <p className="text-sm text-muted-foreground -mt-2">All partner payouts, withdrawals, top-ups & retractions in one view.</p>
            <PartnerFinancialActivity />
          </div>
        );
      case 'staff-performance':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Staff Performance', UserCheck)}
            <ExecutiveBrief embedded />
            <StaffPerformancePanel />
          </div>
        );
      case 'advance-requests':
        return (
          <div className="space-y-6">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Business Advances', Banknote)}
            <BusinessAdvanceQueue stage="coo" />
          </div>
        );
      case 'department-budgets':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Department Budgets', Wallet2)}
            <p className="text-sm text-muted-foreground -mt-2">Review Tenant Ops, Agent Ops, Landlord Ops and Partner Ops budgets line by line. Your approval forwards them to the CFO.</p>
            <COODepartmentBudgets />
          </div>
        );
      case 'scale-vision':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            <COOScaleVisionView />
          </div>
        );
      case 'global-verification':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Global Verification Center', ShieldCheck)}
            <p className="text-sm text-muted-foreground -mt-2">Verify landlords, LC1 chairpersons and requests across the country.</p>
            <GlobalVerificationHub />
          </div>
        );
      case 'approval-history':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Approval History', FileText)}
            <p className="text-sm text-muted-foreground -mt-2">Full log of rent request approvals and rejections.</p>
            <ApprovalHistoryLog />
          </div>
        );
      case 'welile-operations':
        return (
          <div className="space-y-3">
            {isMobile && renderBackButton('Overview')}
            {renderSectionHeader('Welile Operations', Landmark)}
            <p className="text-sm text-muted-foreground -mt-2">Manage every user category — tenants, landlords, agents &amp; partners with deep profiles.</p>
            <WelileOperationsHub />
          </div>
        );
      default:
        return (
          <div className="space-y-5">
            <OverdueVettingOpsCard />
            {/* HERO: Welile Operations — manage every user category */}
            <button
              onClick={() => handleNavTo('welile-operations')}
              role="link"
              aria-label="Open Welile Operations hub"
              className="group w-full cursor-pointer rounded-xl border-2 border-[#9234EA]/50 bg-gradient-to-r from-[#9234EA]/10 via-[#9234EA]/5 to-transparent p-3.5 flex items-center gap-3 text-left min-h-[64px] touch-manipulation hover:border-[#9234EA] hover:shadow-md active:scale-[0.98] transition-all shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#9234EA]/60"
            >
              <div className="p-2 rounded-lg bg-[#9234EA]/15">
                <Landmark className="h-5 w-5 text-[#9234EA] shrink-0" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm text-foreground leading-tight">Welile Operations</p>
                <AgentNetworkBadge className="mt-1" />
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">Manage every user category — tenants, landlords, agents &amp; partners with deep profiles</p>
              </div>
              <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-[#9234EA] px-3 py-1.5 text-[11px] font-bold text-white shadow-sm group-hover:bg-[#7d27cc] transition-colors">
                Open hub
                <ChevronRight className="h-3.5 w-3.5" />
              </span>
            </button>

            {/* Operations snapshot: KPIs, trends, review queue & partner returns */}
            <COOOverviewSnapshot />

            {/* Service centre receivables: what agents owe on centre funding */}
            <ServiceCentreReceivablesPanel />

            {/* Quick Navigation Grid */}
            <div>
              <div className="flex items-center justify-between mb-3 px-0.5">
                <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
                  Quick Actions
                </p>
                <ShareSupporterRecruit />
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
                {quickNavItems.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => item.route ? navigate(item.route) : handleNavTo(item.id)}
                    className={cn(
                      'relative flex flex-col items-start gap-1.5 p-3.5 rounded-xl border transition-all text-left',
                      'hover:shadow-md active:scale-[0.97] active:shadow-none',
                      item.color
                    )}
                  >
                    <div className="flex items-center justify-between w-full">
                      <item.icon className="h-5 w-5" />
                      <ChevronRight className="h-3.5 w-3.5 opacity-40" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm leading-tight">{item.label}</p>
                      <p className="text-[10px] opacity-60 leading-tight mt-0.5">{item.description}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

          </div>
        );
    }
  };

  return (
    <ExecutiveDashboardLayout role="coo" activeTab={activeTab} onTabChange={setActiveTab}>
      {renderContent()}
    </ExecutiveDashboardLayout>
  );
}
