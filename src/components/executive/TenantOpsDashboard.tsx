import { useState } from 'react';
import { HubEntryCard } from '@/components/ops/HubEntryCard';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';
import { RentHistoryVerificationQueue } from '@/components/ops/RentHistoryVerificationQueue';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTenantOpsToolCounts } from '@/hooks/useTenantOpsToolCounts';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { RentPipelineQueue } from './RentPipelineQueue';
import { RejectedRequestsQueue } from './RejectedRequestsQueue';
import { ApprovalHistoryLog } from './ApprovalHistoryLog';
import { TenantBehaviorDashboard } from './TenantBehaviorDashboard';
import { DailyPaymentTracker } from './DailyPaymentTracker';
import { MissedDaysTracker } from './MissedDaysTracker';
import { TenantAgentLinker } from './TenantAgentLinker';
import { TenantTransferAuditTrail } from './TenantTransferAuditTrail';
import { TenantRentCollector } from './TenantRentCollector';
import { AgentTenantSearch } from './AgentTenantSearch';
import { TenantOverviewList } from './TenantOverviewList';
import { TenantLocationsBrowser } from './tenant-ops/TenantLocationsBrowser';
import { TenantOpsPortfolioPerformance } from './tenant-ops/portfolio/TenantOpsPortfolioPerformance';
import { TenantDetailPanel } from './TenantDetailPanel';
import { TenantRegistrationReview } from './TenantRegistrationReview';
import { AgentAllocationReport } from './AgentAllocationReport';
import { TenantOpsLandlordFloatPanel } from './TenantOpsLandlordFloatPanel';
import { TenantOpsLandlordFloatTimeline } from './TenantOpsLandlordFloatTimeline';
import { LocationBrowser } from './landlord-ops/LocationBrowser';
import { TenantLocationBrowser } from './tenant-ops/TenantLocationBrowser';
import { GlobalVerificationHub } from './GlobalVerificationHub';
import { WelileOperationsHub } from './WelileOperationsHub';
import { AgentNetworkBadge } from './tenant-ops/AgentNetworkBadge';
import { PipelineStatusHub } from './tenant-ops/PipelineStatusHub';
import { TenantOpsExtractCenter, type ExtractKind, type ExtractTargetView } from './tenant-ops/TenantOpsExtractCenter';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { generateTenantOpsExtractPdf, downloadPdfBlob } from '@/lib/generateTenantOpsExtractPdf';
import DailyCollectionMonitoringDashboard from '@/components/shared/DailyCollectionMonitoringDashboard';
import { DailyRentReport } from '@/components/reports/DailyRentReport';
import { AgentRentCapacityPanel } from './AgentRentCapacityPanel';
import { TenantProductsServicesReport } from './tenant-ops/TenantProductsServicesReport';
import { TenantRepaymentReliabilityPanel } from './tenant-ops/TenantRepaymentReliabilityPanel';
import { BacklogAnalysis } from './tenant-ops/BacklogAnalysis';
import { AgentMonitoring } from './tenant-ops/AgentMonitoring';
import { TenantSelfRepaymentsPanel } from '@/components/reporting/TenantSelfRepaymentsPanel';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';

import {
  FileCheck, Clock, AlertTriangle, CheckCircle2, Banknote,
  ArrowRight, Activity, ClipboardList, CalendarCheck, CalendarX2,
  ArrowLeft, History, Table2, Link2, HandCoins, Users, Trash2, Loader2, FileSearch, Printer, Network, Shield, ShieldCheck, CalendarIcon, Download, Wallet, Landmark, MapPin, XCircle
} from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import ResidenceAddressForm from '@/components/profile/ResidenceAddressForm';
import { generateTenantOpsReportPdf } from '@/lib/generateTenantOpsReportPdf';
import TenantLocationCorrectionsHub from '@/components/tenant-ops/TenantLocationCorrectionsHub';
import { format } from 'date-fns';
import { motion, AnimatePresence } from 'framer-motion';
import { Gauge } from 'lucide-react';

type ActiveView = 'overview' | 'pipeline' | 'pipeline-hub' | 'daily' | 'missed' | 'backlog-analysis' | 'behavior' | 'history' | 'all-requests' | 'link-agent' | 'transfer-audit' | 'collect-rent' | 'agent-tenants' | 'tenant-detail' | 'registration-review' | 'advance-requests' | 'agent-allocations' | 'daily-collections' | 'agent-monitoring' | 'landlord-float' | 'landlord-float-timeline' | 'location-browser' | 'tenant-location-browser' | 'global-verification' | 'welile-operations' | 'daily-repayments-report' | 'tenant-self-repayments' | 'agent-capacity-hub' | 'all-tenants-hub' | 'reports-hub' | 'tenant-products-report' | 'reliability-hub' | 'location-corrections' | 'tenant-locations-test' | 'portfolio-performance-hub';

/** Public alias so the sidebar shell can type its nav keys against the exact
 *  same view union Classic already routes on. */
export type TenantOpsClassicView = ActiveView;

interface NavCard {
  id: ActiveView;
  label: string;
  description: string;
  icon: React.ElementType;
  color: string;
  badge?: number;
  badgeColor?: string;
}

/**
 * Classic Tenant Ops. Standalone by default (own `activeView` state, own
 * overview + "Back to Overview" row). When `view` / `onViewChange` are passed
 * the parent shell owns navigation instead, and `hideOverview` suppresses the
 * overview block plus the back row because the shell's sidebar replaces them.
 * Every working view, query, dialog and handler below is unchanged.
 */
export function TenantOpsDashboard({
  view: controlledView,
  onViewChange,
  hideOverview = false,
}: {
  view?: ActiveView;
  onViewChange?: (view: ActiveView) => void;
  hideOverview?: boolean;
} = {}) {
  const [internalView, setInternalView] = useState<ActiveView>('overview');
  const activeView = controlledView ?? internalView;
  const setActiveView = (next: ActiveView) => {
    if (controlledView === undefined) setInternalView(next);
    onViewChange?.(next);
  };

  const queryClient = useQueryClient();
  const [deleteDialog, setDeleteDialog] = useState<{ open: boolean; tenantId: string; tenantName: string }>({ open: false, tenantId: '', tenantName: '' });
  const [locationDialog, setLocationDialog] = useState<{ open: boolean; tenantId: string; tenantName: string }>({ open: false, tenantId: '', tenantName: '' });
  const [selectedTenantIds, setSelectedTenantIds] = useState<string[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedTenant, setSelectedTenant] = useState<{ id: string; name: string } | null>(null);
  /** Where the currently open tenant detail was launched from, so Back returns there. */
  const [tenantDetailOrigin, setTenantDetailOrigin] = useState<ActiveView | null>(null);
  const [overviewFilter, setOverviewFilter] = useState<string | undefined>(undefined);
  // Lifecycle group the Pipeline Status hub should open on when it is entered
  // from one of the Classic "Pipeline status" tiles.
  const [pipelineSeed, setPipelineSeed] = useState<string>('all');
  const [printingPdf, setPrintingPdf] = useState(false);
  const [reportFrom, setReportFrom] = useState<Date | undefined>(undefined);
  const [reportTo, setReportTo] = useState<Date | undefined>(undefined);
  const [extracting, setExtracting] = useState<null | 'applied' | 'approved' | 'funded' | 'collected' | 'expected'>(null);

  const handlePrintReport = async () => {
    setPrintingPdf(true);
    try {
      // Date window — payments collected in this period.
      // Normalize both ends to LOCAL midnight / end-of-day so the user
      // gets exactly the calendar days they picked (no UTC drift).
      let fromDate = reportFrom ? new Date(reportFrom) : null;
      let toDate = reportTo ? new Date(reportTo) : null;
      // Defensive swap if user inverted the range.
      if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
        const tmp = fromDate; fromDate = toDate; toDate = tmp;
        toast('Date range was reversed — swapped automatically.', { icon: '↔️' });
      }
      if (fromDate) fromDate.setHours(0, 0, 0, 0);
      if (toDate) toDate.setHours(23, 59, 59, 999);
      const fromIso = fromDate ? fromDate.toISOString() : null;
      const toIso = toDate ? toDate.toISOString() : null;

      // 1. Pull tenant payments from the ledger (source of truth for direct
      //    repayments) plus the agent-collection record (the canonical record
      //    of field collections). Agent-collection ledger legs are dropped in
      //    favour of the collection rows themselves so nothing is counted
      //    twice and every day in the range is represented.
      const ledgerLegs = await fetchAllPaged<any>(() => {
        let q = supabase
          .from('general_ledger')
          .select('user_id, amount, source_id, source_table, transaction_date, transaction_group_id')
          .or('and(category.in.(tenant_repayment,rent_repayment),direction.eq.cash_in),'
            + 'and(category.eq.tenant_repayment_collected,direction.eq.cash_out)')
          .order('transaction_date', { ascending: false });
        if (fromIso) q = q.gte('transaction_date', fromIso);
        if (toIso) q = q.lte('transaction_date', toIso);
        return q;
      });
      const fieldCollections = await fetchAllPaged<any>(() => {
        let q = supabase
          .from('agent_collections')
          .select('id, tenant_id, agent_id, amount, created_at').is('reversed_at', null)
          .order('created_at', { ascending: false });
        if (fromIso) q = q.gte('created_at', fromIso);
        if (toIso) q = q.lte('created_at', toIso);
        return q;
      });
      const payments: any[] = [
        ...ledgerLegs.filter((l: any) => l.source_table !== 'agent_collections'),
        ...fieldCollections.map((c: any) => ({
          user_id: c.tenant_id,
          amount: Number(c.amount || 0),
          source_id: c.id,
          source_table: 'agent_collections',
          transaction_date: c.created_at,
          transaction_group_id: null,
        })),
      ];

      if (payments.length === 0) {
        toast.error('No tenant payments found for the selected period');
        return;
      }


      // 1b. Resolve the TRUE tenant for each payment leg.
      //     The ledger leg's user_id often holds the AGENT (because the
      //     agent's wallet/float is the cash mover), while the actual tenant
      //     lives on the linked rent_request (source_id) or agent_collections
      //     row. We build a per-leg tenant map so the report lists the rent
      //     beneficiary, not the collector.
      const sourceIds = [...new Set(payments.map(p => p.source_id).filter(Boolean) as string[])];
      const [rrLookupRes, acLookupRes] = await Promise.all([
        sourceIds.length
          ? supabase.from('rent_requests').select('id, tenant_id').in('id', sourceIds)
          : Promise.resolve({ data: [] as any[] }),
        sourceIds.length
          ? supabase.from('agent_collections').select('id, tenant_id').in('id', sourceIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const tenantBySourceId = new Map<string, string>();
      for (const r of (rrLookupRes.data || []) as any[]) {
        if (r.tenant_id) tenantBySourceId.set(r.id, r.tenant_id);
      }
      for (const c of (acLookupRes.data || []) as any[]) {
        if (c.tenant_id && !tenantBySourceId.has(c.id)) tenantBySourceId.set(c.id, c.tenant_id);
      }


      // 2a. Resolve responsible agent via agent_collections
      //     (legacy manual-collect-rent path — kept for backward compat).
      const collectionIds = [...new Set(
        payments.filter(p => p.source_table === 'agent_collections' && p.source_id).map(p => p.source_id as string)
      )];
      const { data: collections } = collectionIds.length
        ? await supabase.from('agent_collections').select('id, agent_id, tenant_id').in('id', collectionIds)
        : { data: [] as any[] };
      const collectionMap = new Map((collections || []).map(c => [c.id, c]));

      // 2b. Resolve responsible agent via the SAME transaction_group_id
      //     (Float-Allocation path — covers virtually all production agent
     //      collections today). Each tenant_repayment is part of a 4-leg
     //      group: agent_float_used_for_rent (cash_out, user_id=AGENT) +
     //      tenant_repayment (cash_in, user_id=TENANT) + 2 commission legs.
     //      The agent identity lives on the float / commission legs, never
     //      on the tenant leg. Looking it up via source_id alone — which is
     //      what the previous version did — silently misses every Float-
     //      Allocation payment, producing AGENT-COLLECTED = 0 (FIX-46).
      const groupIds = [...new Set(
        payments.map(p => (p as any).transaction_group_id).filter(Boolean) as string[]
      )];
      const { data: groupLegs } = groupIds.length
        ? await supabase
            .from('general_ledger')
            .select('user_id, category, direction, transaction_group_id')
            .in('transaction_group_id', groupIds)
            .in('category', ['agent_float_used_for_rent', 'agent_commission_earned'])
        : { data: [] as any[] };
      const agentByGroup = new Map<string, string>();
      // Pass 1 — preferred signal: the float being drawn down.
      for (const leg of (groupLegs || []) as any[]) {
        if (leg.category === 'agent_float_used_for_rent' && leg.direction === 'cash_out' && leg.user_id) {
          agentByGroup.set(leg.transaction_group_id, leg.user_id);
        }
      }
      // Pass 2 — fallback: the agent's commission credit (when float leg
      // is absent for any reason).
      for (const leg of (groupLegs || []) as any[]) {
        if (
          leg.category === 'agent_commission_earned'
          && leg.direction === 'cash_in'
          && leg.user_id
          && !agentByGroup.has(leg.transaction_group_id)
        ) {
          agentByGroup.set(leg.transaction_group_id, leg.user_id);
        }
      }

      // 3. Tenant + agent profile lookups
      // Resolve the TRUE tenant id per payment: prefer the rent-request /
      // agent-collection beneficiary; fall back to the ledger leg user_id
      // (the legacy direct-pay case where the tenant paid from their own
      // wallet).
      const resolveTenantId = (p: any): string | null => {
        const fromSource = p.source_id ? tenantBySourceId.get(p.source_id) : undefined;
        return (fromSource || p.user_id || null) as string | null;
      };
      const tenantIds = [...new Set(payments.map(p => resolveTenantId(p)).filter(Boolean) as string[])];
      // Also fetch rent_requests (assigned agent fallback) AND profiles.referrer_id
      // (onboarding agent fallback). Outstanding now comes from the ledger so
      // it's accurate even for tenants without a rent_request row.
      const [tenantRes, rentReqRes, ledgerLifetimeRes] = await Promise.all([
        tenantIds.length
          ? supabase.from('profiles').select('id, full_name, phone, referrer_id').in('id', tenantIds)
          : Promise.resolve({ data: [] as any[] }),
        tenantIds.length
          ? supabase.from('rent_requests')
              .select('tenant_id, agent_id, total_repayment, amount_repaid, status')
              .in('tenant_id', tenantIds)
              .in('status', ['funded', 'disbursed', 'repaying', 'fully_repaid', 'defaulted'])
          : Promise.resolve({ data: [] as any[] }),
        tenantIds.length
          ? supabase.from('general_ledger')
              .select('user_id, category, direction, amount')
              .in('user_id', tenantIds)
              .in('category', ['rent_obligation', 'tenant_repayment', 'tenant_repayment_collected', 'rent_repayment'])
          : Promise.resolve({ data: [] as any[] }),
      ]);
      const tenantMap = new Map((tenantRes.data || []).map((p: any) => [p.id, p]));

      // Assigned-agent fallback per tenant (from rent_requests).
      const outstandingByTenant = new Map<string, number>();
      const assignedAgentByTenant = new Map<string, string>();
      for (const r of (rentReqRes.data || [])) {
        if (r.agent_id && !assignedAgentByTenant.has(r.tenant_id)) {
          assignedAgentByTenant.set(r.tenant_id, r.agent_id);
        }
      }

      // Lifetime outstanding straight from the ledger (source of truth).
      // outstanding = SUM(rent_obligation cash_out) − SUM(repayments cash_in).
      // Negative results clamp to 0 (overpayment / credit).
      for (const tid of tenantIds) outstandingByTenant.set(tid, 0);
      for (const r of (ledgerLifetimeRes.data || []) as any[]) {
        if (!r.user_id) continue;
        const amt = Number(r.amount || 0);
        const cur = outstandingByTenant.get(r.user_id) || 0;
        if (r.category === 'rent_obligation' && r.direction === 'cash_out') {
          outstandingByTenant.set(r.user_id, cur + amt);
        } else if (r.direction === 'cash_in') {
          outstandingByTenant.set(r.user_id, cur - amt);
        }
      }
      for (const [k, v] of outstandingByTenant) {
        if (v < 0) outstandingByTenant.set(k, 0);
      }

      // Fallback: tenants whose plans predate ledger posting have no
      // rent_obligation legs, so the ledger sum reads 0 even though the plan
      // still owes. Use the plan figures (total_repayment − amount_repaid)
      // whenever they show more outstanding than the ledger does.
      const planOutstandingByTenant = new Map<string, number>();
      for (const r of (rentReqRes.data || []) as any[]) {
        if (!r.tenant_id) continue;
        const rem = Math.max(0, Number(r.total_repayment || 0) - Number(r.amount_repaid || 0));
        planOutstandingByTenant.set(r.tenant_id, (planOutstandingByTenant.get(r.tenant_id) || 0) + rem);
      }
      for (const [tid, rem] of planOutstandingByTenant) {
        if (rem > (outstandingByTenant.get(tid) || 0)) outstandingByTenant.set(tid, rem);
      }

      // Referrer-as-agent fallback: only count referrers who actually hold the agent role.
      const referrerIds = [...new Set(
        (tenantRes.data || [])
          .map((p: any) => p.referrer_id)
          .filter((id: any) => !!id)
      )] as string[];
      const { data: agentRoleRows } = referrerIds.length
        ? await supabase.from('user_roles').select('user_id').in('user_id', referrerIds).eq('role', 'agent')
        : { data: [] as any[] };
      const agentReferrerSet = new Set((agentRoleRows || []).map((r: any) => r.user_id));
      const referrerAgentByTenant = new Map<string, string>();
      for (const p of (tenantRes.data || []) as any[]) {
        if (p.referrer_id && agentReferrerSet.has(p.referrer_id)) {
          referrerAgentByTenant.set(p.id, p.referrer_id);
        }
      }

      // Resolve agent profiles for collection-based, rent-request and referrer fallbacks
      const allAgentIds = [...new Set([
        ...((collections || []).map(c => c.agent_id).filter(Boolean) as string[]),
        ...Array.from(agentByGroup.values()),
        ...Array.from(assignedAgentByTenant.values()),
        ...Array.from(referrerAgentByTenant.values()),
      ])];
      const { data: agentProfiles } = allAgentIds.length
        ? await supabase.from('profiles').select('id, full_name').in('id', allAgentIds)
        : { data: [] as any[] };
      const agentMap = new Map((agentProfiles || []).map((p: any) => [p.id, p]));

      // 4. Aggregate one row per tenant — paid IN RANGE
      const byTenant = new Map<string, {
        tenant_name: string; tenant_phone: string;
        amount_paid: number; outstanding: number;
        paid_direct: number; paid_via_agent: number;
        agent_names: Set<string>;
        payment_count: number;
      }>();
      for (const p of payments) {
        const tenantId = resolveTenantId(p);
        if (!tenantId) continue;
        // Per-row attribution priority:
        //   (1) Float-Allocation agent — same transaction_group_id has an
        //       agent_float_used_for_rent / commission leg (the dominant
        //       agent path in production).
        //   (2) Legacy collection — source_id matches an agent_collections row.
        //   Either of (1) or (2) flips the row into "agent-collected".
        //   (3) Assigned agent on an active rent_request — display only.
        //   (4) Onboarding agent (profiles.referrer_id) — display only.
        const groupAgentId = (p as any).transaction_group_id
          ? agentByGroup.get((p as any).transaction_group_id)
          : undefined;
        const collection = p.source_id ? collectionMap.get(p.source_id) : null;
        // Agent identity for THIS payment: prefer the float-allocation
        // group, then the legacy collection's agent_id; fall back to the
        // ledger leg's user_id when it differs from the resolved tenant
        // (i.e. the leg was posted under the agent's wallet).
        const legUserAgentId = (p.user_id && p.user_id !== tenantId) ? p.user_id : null;
        const collectingAgentId = collection?.agent_id || legUserAgentId;
        const isAgentCollection = !!groupAgentId || !!collectingAgentId;
        const attributedAgentId =
          groupAgentId
          || collectingAgentId
          || assignedAgentByTenant.get(tenantId)
          || referrerAgentByTenant.get(tenantId);
        let agentName = '—';
        if (attributedAgentId) {
          const profileName = agentMap.get(attributedAgentId)?.full_name;
          if (profileName) {
            agentName = profileName;
            // Multi-role test/sandbox case: the same UUID acts as agent +
            // tenant. Still counted as agent-collected (it really was), but
            // tagged so reviewers don't think it's a bug.
            if (attributedAgentId === tenantId) agentName = `${profileName} (self)`;
          } else if (isAgentCollection) {
            agentName = 'Agent (deleted)';
          }
        }
        const amt = Number(p.amount || 0);

        let row = byTenant.get(tenantId);
        if (!row) {
          row = {
            tenant_name: tenantMap.get(tenantId)?.full_name || '—',
            tenant_phone: tenantMap.get(tenantId)?.phone || '—',
            amount_paid: 0,
            outstanding: outstandingByTenant.get(tenantId) || 0,
            paid_direct: 0,
            paid_via_agent: 0,
            agent_names: new Set<string>(),
            payment_count: 0,
          };
          byTenant.set(tenantId, row);
        }
        row.amount_paid += amt;
        if (isAgentCollection) row.paid_via_agent += amt; else row.paid_direct += amt;
        row.payment_count += 1;
        if (agentName && agentName !== '—') row.agent_names.add(agentName);
      }

      const rows = Array.from(byTenant.values())
        .map(t => ({
          tenant_name: t.tenant_name,
          tenant_phone: t.tenant_phone,
          rent_plans: t.payment_count,
          rent_given: 0,
          amount_paid: t.amount_paid,
          paid_direct: t.paid_direct,
          paid_via_agent: t.paid_via_agent,
          outstanding: t.outstanding,
          agent_name: t.agent_names.size === 0 ? 'Direct (no agent)' : Array.from(t.agent_names).join(', '),
        }))
        .sort((a, b) => b.amount_paid - a.amount_paid);

      const blob = generateTenantOpsReportPdf(rows, { from: fromDate, to: toDate });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = reportFrom || reportTo
        ? `${reportFrom ? format(reportFrom, 'yyyyMMdd') : 'start'}_${reportTo ? format(reportTo, 'yyyyMMdd') : format(new Date(), 'yyyyMMdd')}`
        : format(new Date(), 'yyyy-MM-dd');
      a.download = `Tenant_Rent_Report_${suffix}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('Report downloaded');
    } catch (err: any) {
      toast.error(err.message || 'Failed to generate report');
    } finally {
      setPrintingPdf(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Quick CSV extracts (Tenants Applied / Approved / Repayments Collected /
  // Expected). Share the same From / To pickers as Print Report. When no
  // dates are picked we default to the last 30 days for the three time-bound
  // reports; "Expected" defaults to today → +90 days so the user always sees
  // a meaningful forward-looking number on first click.
  // ---------------------------------------------------------------------------
  const resolveWindow = (defaultDays: number, forward = false) => {
    let from = reportFrom ? new Date(reportFrom) : null;
    let to = reportTo ? new Date(reportTo) : null;
    if (from && to && from.getTime() > to.getTime()) {
      const t = from; from = to; to = t;
    }
    if (!from && !to) {
      if (forward) {
        from = new Date();
        to = new Date(Date.now() + defaultDays * 86400_000);
      } else {
        to = new Date();
        from = new Date(Date.now() - defaultDays * 86400_000);
      }
    } else if (from && !to) {
      to = new Date();
    } else if (!from && to) {
      from = new Date(to.getTime() - defaultDays * 86400_000);
    }
    if (from) from.setHours(0, 0, 0, 0);
    if (to) to.setHours(23, 59, 59, 999);
    return { from: from!, to: to! };
  };

  const windowSuffix = (from: Date, to: Date) =>
    `${format(from, 'yyyyMMdd')}_${format(to, 'yyyyMMdd')}`;

  // Fetch tenant + landlord names for a list of rent_request rows in one go.
  const enrichWithProfiles = async (rows: any[]) => {
    const ids = [...new Set(rows.flatMap(r => [r.tenant_id, r.landlord_id, r.approved_by]).filter(Boolean) as string[])];
    if (!ids.length) return new Map<string, any>();
    const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
    return new Map((data || []).map((p: any) => [p.id, p]));
  };

  // Page through a query so a long date range is never silently truncated
  // by the default row cap (which used to make wide ranges look like they
  // only returned the most recent day).
  const fetchAllPaged = async <T,>(build: () => any, pageSize = 1000): Promise<T[]> => {
    const out: T[] = [];
    for (let offset = 0; offset < 100_000; offset += pageSize) {
      const { data, error } = await build().range(offset, offset + pageSize - 1);
      if (error) throw error;
      const chunk = (data || []) as T[];
      out.push(...chunk);
      if (chunk.length < pageSize) break;
    }
    return out;
  };


  const handleExtractApplied = async () => {
    setExtracting('applied');
    try {
      const { from, to } = resolveWindow(30);
      const data = await fetchAllPaged<any>(() => supabase
        .from('rent_requests')
        .select('id, tenant_id, landlord_id, rent_amount, daily_repayment, duration_days, status, created_at')
        .gte('created_at', from.toISOString())
        .lte('created_at', to.toISOString())
        .order('created_at', { ascending: false }));
      if (!data.length) { toast.error('No tenant applications in this window'); return; }

      const profiles = await enrichWithProfiles(data);
      const rows = data.map((r: any) => {
        const t = profiles.get(r.tenant_id); const l = profiles.get(r.landlord_id);
        return [
          r.id,
          t?.full_name || '—',
          t?.phone || '—',
          l?.full_name || '—',
          Number(r.rent_amount || 0),
          Number(r.daily_repayment || 0),
          r.duration_days ?? '',
          r.status || '',
          r.created_at,
        ];
      });
      const blob = generateTenantOpsExtractPdf({
        title: 'Tenants Applied',
        subtitle: 'Every rent application created in this period.',
        range: { from, to },
        kpis: [
          { label: 'Applications', value: rows.length.toLocaleString(), color: [37, 99, 235] },
          { label: 'Rent Requested', value: `UGX ${Math.round(rows.reduce((s, r: any) => s + Number(r[4] || 0), 0)).toLocaleString()}`, color: [15, 23, 42] },
        ],
        columns: [
          { label: '#',                   width: 8,  align: 'left' },
          { label: 'Tenant',              width: 40, format: 'text' },
          { label: 'Phone',               width: 24, format: 'text' },
          { label: 'Landlord',            width: 36, format: 'text' },
          { label: 'Rent (UGX)',          width: 24, format: 'ugx' },
          { label: 'Daily (UGX)',         width: 22, format: 'ugx' },
          { label: 'Days',                width: 12, format: 'number' },
          { label: 'Status',              width: 22, format: 'text' },
          { label: 'Applied',             width: 28, format: 'datetime' },
        ],
        rows: rows.map((r, i) => [i + 1, r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]),
        footerNote: 'One row per rent application created in the selected period. Status reflects current pipeline state.',
      });
      downloadPdfBlob(blob, `tenants-applied_${windowSuffix(from, to)}.pdf`);
      toast.success(`Extracted ${rows.length} applications`);
    } catch (err: any) {
      toast.error(err.message || 'Extract failed');
    } finally {
      setExtracting(null);
    }
  };

  const handleExtractApproved = async () => {
    setExtracting('approved');
    try {
      const { from, to } = resolveWindow(30);
      // `approved_at` is rarely stamped — most rows just transition status forward.
      // So we widen the net: any row whose status is past the approval gate, then
      // window by COALESCE(approved_at, created_at).
      const POST_APPROVAL_STATUSES = [
        'agent_verified',
        'tenant_ops_approved',
        'landlord_ops_approved',
        'coo_approved',
        'approved',
        'funded',
        'disbursed',
        'active',
        'repaying',
        'completed',
      ];
      const data = await fetchAllPaged<any>(() => supabase
        .from('rent_requests')
        .select('id, tenant_id, approved_by, rent_amount, total_repayment, daily_repayment, approved_at, created_at, status')
        .in('status', POST_APPROVAL_STATUSES)
        // Pull anything that *could* fall in the window using either timestamp,
        // then filter precisely in JS.
        .or(`and(approved_at.gte.${from.toISOString()},approved_at.lte.${to.toISOString()}),and(approved_at.is.null,created_at.gte.${from.toISOString()},created_at.lte.${to.toISOString()})`)
        .order('created_at', { ascending: false }));
      if (!data.length) { toast.error('No approvals in this window'); return; }

      const profiles = await enrichWithProfiles(data);
      let stamped = 0;
      let inferred = 0;
      const rows = data.map((r: any) => {
        const t = profiles.get(r.tenant_id); const a = profiles.get(r.approved_by);
        const effectiveTs = r.approved_at || r.created_at;
        const isInferred = !r.approved_at;
        if (isInferred) inferred++; else stamped++;
        return [
          r.id,
          t?.full_name || '—',
          t?.phone || '—',
          Number(r.rent_amount || 0),
          Number(r.total_repayment || 0),
          Number(r.daily_repayment || 0),
          effectiveTs,
          a?.full_name || '—',
          isInferred ? `${r.status || ''} (inferred)` : (r.status || ''),
        ];
      });
      const totalRent = rows.reduce((s, r: any) => s + Number(r[3] || 0), 0);
      const totalRepay = rows.reduce((s, r: any) => s + Number(r[4] || 0), 0);
      const blob = generateTenantOpsExtractPdf({
        title: 'Tenants Approved',
        subtitle: 'Rent applications past the approval gate in this period. Rows missing approved_at are inferred from created_at (marked).',
        range: { from, to },
        kpis: [
          { label: 'Approvals', value: rows.length.toLocaleString(), color: [22, 163, 74] },
          { label: 'Rent Approved', value: `UGX ${Math.round(totalRent).toLocaleString()}`, color: [15, 23, 42] },
          { label: 'Total Repayable', value: `UGX ${Math.round(totalRepay).toLocaleString()}`, color: [124, 58, 237] },
          { label: 'Stamped / Inferred', value: `${stamped} / ${inferred}`, color: [148, 163, 184] },
        ],
        columns: [
          { label: '#',              width: 8,  align: 'left' },
          { label: 'Tenant',         width: 40, format: 'text' },
          { label: 'Phone',          width: 24, format: 'text' },
          { label: 'Rent (UGX)',     width: 24, format: 'ugx' },
          { label: 'Total Repay',    width: 26, format: 'ugx' },
          { label: 'Daily (UGX)',    width: 22, format: 'ugx' },
          { label: 'Approved',       width: 28, format: 'datetime' },
          { label: 'Approved By',    width: 32, format: 'text' },
          { label: 'Status',         width: 22, format: 'text' },
        ],
        rows: rows.map((r, i) => [i + 1, r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]),
        totals: ['', 'TOTAL', '', totalRent, totalRepay, '', '', '', ''],
        footerNote: 'Approved = status past approval gate (agent_verified → completed). When approved_at is missing, created_at is shown and the row is marked "inferred".',
      });
      downloadPdfBlob(blob, `tenants-approved_${windowSuffix(from, to)}.pdf`);
      toast.success(`Extracted ${rows.length} approvals`);
    } catch (err: any) {
      toast.error(err.message || 'Extract failed');
    } finally {
      setExtracting(null);
    }
  };

  const handleExtractFunded = async () => {
    setExtracting('funded');
    try {
      const { from, to } = resolveWindow(30);
      // Same dual-window trick as Approved: `funded_at` is sometimes
      // unstamped on legacy rows. We widen the net to any row whose
      // status is past the funding gate, then window by the best
      // available timestamp (funded_at → approved_at → created_at).
      const POST_FUNDING_STATUSES = [
        'funded',
        'disbursed',
        'active',
        'repaying',
        'completed',
      ];
      const data = await fetchAllPaged<any>(() => supabase
        .from('rent_requests')
        .select('id, tenant_id, agent_id, approved_by, rent_amount, total_repayment, daily_repayment, amount_repaid, funded_at, approved_at, created_at, status')
        .in('status', POST_FUNDING_STATUSES)
        .or(
          `and(funded_at.gte.${from.toISOString()},funded_at.lte.${to.toISOString()}),` +
          `and(funded_at.is.null,approved_at.gte.${from.toISOString()},approved_at.lte.${to.toISOString()}),` +
          `and(funded_at.is.null,approved_at.is.null,created_at.gte.${from.toISOString()},created_at.lte.${to.toISOString()})`
        )
        .order('created_at', { ascending: false }));
      if (!data.length) { toast.error('No funded tenants in this window'); return; }

      const effTs = (r: any) => r.funded_at || r.approved_at || r.created_at;

      // Full funding history for these tenants, so we can tell a FIRST-TIME
      // funded tenant from a repeat / renewing one (and show which cycle
      // this plan is for that tenant).
      const tenantIds = [...new Set(data.map((r: any) => r.tenant_id).filter(Boolean) as string[])];
      const history = tenantIds.length
        ? await fetchAllPaged<any>(() => supabase
            .from('rent_requests')
            .select('id, tenant_id, funded_at, approved_at, created_at')
            .in('status', POST_FUNDING_STATUSES)
            .in('tenant_id', tenantIds))
        : [];
      const historyByTenant = new Map<string, any[]>();
      for (const h of history) {
        if (!h.tenant_id) continue;
        const list = historyByTenant.get(h.tenant_id) || [];
        list.push(h);
        historyByTenant.set(h.tenant_id, list);
      }
      for (const [, list] of historyByTenant) {
        list.sort((a, b) => new Date(effTs(a)).getTime() - new Date(effTs(b)).getTime());
      }
      // 1-based cycle number of a plan within its tenant's funding history.
      const cycleOf = (r: any) => {
        const list = historyByTenant.get(r.tenant_id) || [];
        const idx = list.findIndex(h => h.id === r.id);
        return idx >= 0 ? idx + 1 : 1;
      };

      const profiles = await enrichWithProfiles(
        data.flatMap((r: any) => [{ tenant_id: r.tenant_id }, { tenant_id: r.agent_id }, { tenant_id: r.approved_by }])
      );

      let stamped = 0;
      let inferred = 0;
      const build = (r: any) => {
        const t = profiles.get(r.tenant_id);
        const a = profiles.get(r.approved_by);
        const ag = profiles.get(r.agent_id);
        const isInferred = !r.funded_at;
        if (isInferred) inferred++; else stamped++;
        const cycle = cycleOf(r);
        return {
          cycle,
          isNew: cycle <= 1,
          row: [
            t?.full_name || '—',
            t?.phone || '—',
            cycle,
            Number(r.rent_amount || 0),
            Number(r.total_repayment || 0),
            Number(r.daily_repayment || 0),
            Number(r.amount_repaid || 0),
            effTs(r),
            ag?.full_name || a?.full_name || '—',
            isInferred ? `${r.status || ''} (inferred)` : (r.status || ''),
          ] as any[],
        };
      };
      const built = data.map(build);
      const newOnes = built.filter(b => b.isNew);
      const repeatOnes = built.filter(b => !b.isNew);

      const sum = (list: typeof built, idx: number) => list.reduce((s, b) => s + Number(b.row[idx] || 0), 0);
      const totalFunded = sum(built, 3);
      const totalRepay = sum(built, 4);
      const totalRepaid = sum(built, 6);
      const pct = (n: number) => built.length ? `${Math.round((n / built.length) * 100)}%` : '0%';

      const columns = [
        { label: '#',              width: 8,  align: 'left' as const },
        { label: 'Tenant',         width: 34, format: 'text' as const },
        { label: 'Phone',          width: 22, format: 'text' as const },
        { label: 'Cycle',          width: 12, format: 'number' as const },
        { label: 'Rent (UGX)',     width: 22, format: 'ugx' as const },
        { label: 'Total Repay',    width: 24, format: 'ugx' as const },
        { label: 'Daily (UGX)',    width: 20, format: 'ugx' as const },
        { label: 'Repaid (UGX)',   width: 22, format: 'ugx' as const },
        { label: 'Funded',         width: 26, format: 'datetime' as const },
        { label: 'Agent',          width: 26, format: 'text' as const },
        { label: 'Status',         width: 20, format: 'text' as const },
      ];
      const sectionOf = (list: typeof built, title: string, note: string) => ({
        title,
        note,
        columns,
        rows: list.map((b, i) => [i + 1, ...b.row]),
        totals: ['', 'TOTAL', '', '', sum(list, 3), sum(list, 4), '', sum(list, 6), '', '', ''] as any[],
      });

      const blob = generateTenantOpsExtractPdf({
        title: 'Tenants Funded',
        subtitle: 'Rent plans past the funding gate in this period, split into first-time (new) and repeat / renewing tenants.',
        range: { from, to },
        kpis: [
          { label: 'Total Funded', value: built.length.toLocaleString(), color: [22, 163, 74] },
          { label: 'New Tenants', value: `${newOnes.length} (${pct(newOnes.length)})`, color: [37, 99, 235] },
          { label: 'Repeat / Renewing', value: `${repeatOnes.length} (${pct(repeatOnes.length)})`, color: [124, 58, 237] },
          { label: 'Rent Funded', value: `UGX ${Math.round(totalFunded).toLocaleString()}`, color: [15, 23, 42] },
          { label: 'Total Repayable', value: `UGX ${Math.round(totalRepay).toLocaleString()}`, color: [124, 58, 237] },
          { label: 'Already Repaid', value: `UGX ${Math.round(totalRepaid).toLocaleString()}`, color: [217, 119, 6] },
          { label: 'Avg Rent Funded', value: `UGX ${built.length ? Math.round(totalFunded / built.length).toLocaleString() : 0}`, color: [15, 23, 42] },
          { label: 'Stamped / Inferred', value: `${stamped} / ${inferred}`, color: [148, 163, 184] },
        ],
        sections: [
          sectionOf(newOnes, `New tenants funded — ${newOnes.length} (${pct(newOnes.length)})`, 'First rent plan ever funded for this tenant.'),
          sectionOf(repeatOnes, `Repeat / renewing tenants funded — ${repeatOnes.length} (${pct(repeatOnes.length)})`, 'Tenant had at least one earlier funded rent plan. Cycle = which funded plan this is for them.'),
        ],
        footerNote: 'Funded = status past funding gate (funded → completed). New vs repeat is derived from the tenant\'s full funded-plan history. When funded_at is missing, the next-best timestamp is shown and the row is marked "inferred".',
      });
      downloadPdfBlob(blob, `tenants-funded_${windowSuffix(from, to)}.pdf`);
      toast.success(`Extracted ${built.length} funded plans — ${newOnes.length} new, ${repeatOnes.length} repeat`);
    } catch (err: any) {
      toast.error(err.message || 'Extract failed');
    } finally {
      setExtracting(null);
    }
  };

  const handleExtractCollected = async () => {
    setExtracting('collected');
    try {
      const { from, to } = resolveWindow(30);

      // ── Source 1: agent collections (the canonical record of every tenant
      //    payment taken in the field — covers every day in the range).
      const collections = await fetchAllPaged<any>(() => supabase
        .from('agent_collections')
        .select('id, tenant_id, agent_id, amount, payment_method, collection_channel, created_at').is('reversed_at', null)
        .gte('created_at', from.toISOString())
        .lte('created_at', to.toISOString())
        .order('created_at', { ascending: false }));

      // ── Source 2: repayments posted straight to the ledger that are NOT
      //    an agent collection (tenant paid from their own wallet, deposit
      //    sweeps, etc.). Filtering out `agent_collections`-sourced legs is
      //    what prevents double counting.
      const ledger = await fetchAllPaged<any>(() => supabase
        .from('general_ledger')
        .select('user_id, amount, source_id, source_table, transaction_date, transaction_group_id')
        .or('and(category.in.(tenant_repayment,rent_repayment),direction.eq.cash_in),'
          + 'and(category.eq.tenant_repayment_collected,direction.eq.cash_out)')
        .neq('classification', 'admin_correction')
        .gte('transaction_date', from.toISOString())
        .lte('transaction_date', to.toISOString())
        .order('transaction_date', { ascending: false }));
      const directLegs = ledger.filter((l: any) => l.source_table !== 'agent_collections');

      if (!collections.length && !directLegs.length) {
        toast.error('No repayments collected in this window');
        return;
      }

      // Resolve tenant for direct legs via their rent request when needed.
      const directSourceIds = [...new Set(directLegs.map((l: any) => l.source_id).filter(Boolean) as string[])];
      const { data: rrLookup } = directSourceIds.length
        ? await supabase.from('rent_requests').select('id, tenant_id').in('id', directSourceIds)
        : { data: [] as any[] };
      const tenantBySource = new Map<string, string>();
      for (const r of (rrLookup || []) as any[]) if (r.tenant_id) tenantBySource.set(r.id, r.tenant_id);

      type Payment = { ts: string; tenantId: string | null; agentId: string | null; amount: number; channel: string };
      const payments: Payment[] = [
        ...collections.map((c: any) => ({
          ts: c.created_at,
          tenantId: c.tenant_id || null,
          agentId: c.agent_id || null,
          amount: Number(c.amount || 0),
          channel: c.payment_method || c.collection_channel || 'agent collection',
        })),
        ...directLegs.map((l: any) => ({
          ts: l.transaction_date,
          tenantId: (l.source_id && tenantBySource.get(l.source_id)) || l.user_id || null,
          agentId: null,
          amount: Number(l.amount || 0),
          channel: l.source_table || 'direct',
        })),
      ].sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());

      const profileIds = [...new Set(payments.flatMap(p => [p.tenantId, p.agentId]).filter(Boolean) as string[])];
      const { data: profs } = profileIds.length
        ? await supabase.from('profiles').select('id, full_name, phone').in('id', profileIds)
        : { data: [] as any[] };
      const pmap = new Map((profs || []).map((p: any) => [p.id, p]));

      const total = payments.reduce((s, p) => s + p.amount, 0);
      const agentCollected = payments.filter(p => p.agentId).reduce((s, p) => s + p.amount, 0);
      const uniqueTenants = new Set(payments.map(p => p.tenantId).filter(Boolean)).size;
      const uniqueAgents = new Set(payments.map(p => p.agentId).filter(Boolean)).size;

      // Per-day breakdown so it is obvious every selected day is included.
      const byDay = new Map<string, { count: number; amount: number; tenants: Set<string> }>();
      for (const p of payments) {
        const key = format(new Date(p.ts), 'yyyy-MM-dd');
        const bucket = byDay.get(key) || { count: 0, amount: 0, tenants: new Set<string>() };
        bucket.count += 1;
        bucket.amount += p.amount;
        if (p.tenantId) bucket.tenants.add(p.tenantId);
        byDay.set(key, bucket);
      }
      const dayRows = [...byDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .map(([day, b], i) => [i + 1, day, b.count, b.tenants.size, b.amount]);
      const activeDays = dayRows.length;

      const blob = generateTenantOpsExtractPdf({
        title: 'Repayments Collected',
        subtitle: 'Every tenant repayment recorded in the selected period — agent field collections plus direct wallet repayments.',
        range: { from, to },
        kpis: [
          { label: 'Total Collected', value: `UGX ${Math.round(total).toLocaleString()}`, color: [22, 163, 74] },
          { label: 'Payments', value: payments.length.toLocaleString(), color: [15, 23, 42] },
          { label: 'Days With Collections', value: activeDays.toLocaleString(), color: [37, 99, 235] },
          { label: 'Unique Tenants', value: uniqueTenants.toLocaleString(), color: [37, 99, 235] },
          { label: 'Agents Collecting', value: uniqueAgents.toLocaleString(), color: [124, 58, 237] },
          { label: 'Collected By Agents', value: `UGX ${Math.round(agentCollected).toLocaleString()}`, color: [124, 58, 237] },
          { label: 'Daily Average', value: `UGX ${activeDays ? Math.round(total / activeDays).toLocaleString() : 0}`, color: [217, 119, 6] },
        ],
        sections: [
          {
            title: 'Daily totals across the selected period',
            note: 'One row per calendar day that had collections inside the selected date range.',
            columns: [
              { label: '#',            width: 8,  align: 'left' },
              { label: 'Day',          width: 30, format: 'date' },
              { label: 'Payments',     width: 24, format: 'number' },
              { label: 'Tenants',      width: 24, format: 'number' },
              { label: 'Collected',    width: 34, format: 'ugx' },
            ],
            rows: dayRows,
            totals: ['', 'TOTAL', payments.length, uniqueTenants, total],
          },
          {
            title: 'Individual payments',
            columns: [
              { label: '#',              width: 8,  align: 'left' },
              { label: 'Date',           width: 26, format: 'datetime' },
              { label: 'Tenant',         width: 40, format: 'text' },
              { label: 'Phone',          width: 24, format: 'text' },
              { label: 'Agent',          width: 36, format: 'text' },
              { label: 'Amount (UGX)',   width: 26, format: 'ugx' },
              { label: 'Channel',        width: 24, format: 'text' },
            ],
            rows: payments.map((p, i) => [
              i + 1,
              p.ts,
              (p.tenantId && pmap.get(p.tenantId)?.full_name) || '—',
              (p.tenantId && pmap.get(p.tenantId)?.phone) || '—',
              (p.agentId && pmap.get(p.agentId)?.full_name) || (p.agentId ? 'Agent' : 'Direct (no agent)'),
              p.amount,
              p.channel,
            ]),
            totals: ['', '', '', '', 'TOTAL', total, ''],
          },
        ],
        footerNote: 'Agent field collections come from the collections record; direct repayments come from the ledger (agent-collection legs excluded so nothing is counted twice).',
      });
      downloadPdfBlob(blob, `repayments-collected_${windowSuffix(from, to)}.pdf`);
      toast.success(`Collected: UGX ${Math.round(total).toLocaleString()} across ${payments.length} payments (${activeDays} day${activeDays === 1 ? '' : 's'})`);
    } catch (err: any) {
      toast.error(err.message || 'Extract failed');
    } finally {
      setExtracting(null);
    }
  };


  const handleExtractExpected = async () => {
    setExtracting('expected');
    try {
      const { from, to } = resolveWindow(90, true);
      // Active rent plans = funded/disbursed/repaying (not rejected/cancelled/fully_repaid/defaulted).
      const plans = await fetchAllPaged<any>(() => supabase
        .from('rent_requests')
        .select('id, tenant_id, daily_repayment, total_repayment, amount_repaid, duration_days, disbursed_at, funded_at, status, tenancy_status')
        .in('status', ['funded', 'disbursed', 'repaying'])
        .order('created_at', { ascending: false }));
      const active = (plans || []).filter((p: any) =>
        !['ended', 'terminated'].includes((p.tenancy_status || '').toLowerCase())
      );

      if (active.length === 0) { toast.error('No active rent plans'); return; }
      const profiles = await enrichWithProfiles(active);

      const winStart = from.getTime();
      const winEnd = to.getTime();
      let totalExpected = 0;
      let totalOutstanding = 0;
      const rows = active.map((r: any) => {
        const start = r.disbursed_at || r.funded_at;
        const startMs = start ? new Date(start).getTime() : winStart;
        const planEndMs = startMs + (Number(r.duration_days || 0) * 86400_000);
        const overlapStart = Math.max(startMs, winStart);
        const overlapEnd = Math.min(planEndMs, winEnd);
        const days = Math.max(0, Math.ceil((overlapEnd - overlapStart) / 86400_000));
        const daily = Number(r.daily_repayment || 0);
        const expected = days * daily;
        const outstanding = Math.max(0, Number(r.total_repayment || 0) - Number(r.amount_repaid || 0));
        totalExpected += expected;
        totalOutstanding += outstanding;
        const t = profiles.get(r.tenant_id);
        return [
          r.id,
          t?.full_name || '—',
          t?.phone || '—',
          daily,
          days,
          expected,
          Number(r.total_repayment || 0),
          Number(r.amount_repaid || 0),
          outstanding,
        ];
      });
      const blob = generateTenantOpsExtractPdf({
        title: 'Repayments Expected',
        subtitle: 'Daily-repayment × days-in-window for every active rent plan, plus lifetime outstanding.',
        range: { from, to },
        kpis: [
          { label: 'Active Plans', value: active.length.toLocaleString(), color: [37, 99, 235] },
          { label: 'Expected (window)', value: `UGX ${Math.round(totalExpected).toLocaleString()}`, color: [22, 163, 74] },
          { label: 'Outstanding (lifetime)', value: `UGX ${Math.round(totalOutstanding).toLocaleString()}`, color: [220, 38, 38] },
        ],
        columns: [
          { label: '#',              width: 8,  align: 'left' },
          { label: 'Tenant',         width: 40, format: 'text' },
          { label: 'Phone',          width: 24, format: 'text' },
          { label: 'Daily (UGX)',    width: 22, format: 'ugx' },
          { label: 'Days',           width: 14, format: 'number' },
          { label: 'Expected (UGX)', width: 28, format: 'ugx' },
          { label: 'Total Repay',    width: 26, format: 'ugx' },
          { label: 'Repaid',         width: 24, format: 'ugx' },
          { label: 'Outstanding',    width: 28, format: 'ugx' },
        ],
        rows: rows.map((r, i) => [i + 1, r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8]]),
        totals: ['', 'TOTAL', '', '', '', totalExpected, '', '', totalOutstanding],
        footerNote: 'Expected (window) = daily_repayment × days the plan overlaps the selected period. Outstanding = total_repayment − amount_repaid (lifetime).',
      });
      downloadPdfBlob(blob, `repayments-expected_${windowSuffix(from, to)}.pdf`);
      toast.success(`Expected (window): UGX ${Math.round(totalExpected).toLocaleString()} • Outstanding: UGX ${Math.round(totalOutstanding).toLocaleString()}`);
    } catch (err: any) {
      toast.error(err.message || 'Extract failed');
    } finally {
      setExtracting(null);
    }
  };

  const handleDeleteTenant = async () => {
    if (!deleteDialog.tenantId) return;
    const reason = window.prompt('Reason for archiving this tenant (min 10 characters, recorded in audit log):')?.trim() || '';
    if (reason.length < 10) { toast.error('A reason of at least 10 characters is required'); return; }
    setDeleting(true);
    try {
      const { error } = await supabase.functions.invoke('delete-user', {
        body: { user_id: deleteDialog.tenantId, preserve_history: true, reason },
      });
      if (error) throw error;
      toast.success(`Tenant "${deleteDialog.tenantName}" has been archived; payment history is preserved`);
      setDeleteDialog({ open: false, tenantId: '', tenantName: '' });
      queryClient.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
    } catch (err: any) {
      toast.error(err.message || 'Failed to delete tenant');
    } finally {
      setDeleting(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedTenantIds.length === 0) return;
    const reason = window.prompt(`Reason for archiving ${selectedTenantIds.length} tenants (min 10 characters, recorded in audit log):`)?.trim() || '';
    if (reason.length < 10) { toast.error('A reason of at least 10 characters is required'); return; }
    setBulkDeleting(true);
    let success = 0;
    let failed = 0;
    const failures: string[] = [];
    for (const id of selectedTenantIds) {
      try {
        const { error } = await supabase.functions.invoke('delete-user', { body: { user_id: id, preserve_history: true, reason } });
        if (error) throw error;
        success += 1;
      } catch (err: any) {
        failed += 1;
        failures.push(err?.message || id);
      }
    }
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
    setSelectedTenantIds([]);
    queryClient.invalidateQueries({ queryKey: ['exec-tenant-ops'] });
    if (failed === 0) {
      toast.success(`Archived ${success} tenant${success === 1 ? '' : 's'}; payment history is preserved`);
    } else {
      toast.error(`Archived ${success}, failed ${failed}. ${failures[0] || ''}`);
    }
  };

  const { data: rentRequests, isLoading } = useQuery({
    queryKey: ['exec-tenant-ops'],
    queryFn: async () => {
      // Source = rent_requests (includes outstanding_balance registrations).
      // Paginate past the 1000-row default cap so EVERY rent_request is loaded —
      // no tenant with a request (or an outstanding balance) is dropped.
      const items: any[] = [];
      let from = 0;
      const PAGE = 1000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase
          .from('rent_requests')
          .select('id, status, rent_amount, total_repayment, amount_repaid, registration_type, created_at, tenant_id, landlord_id, agent_id')
          .order('created_at', { ascending: false })
          .range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        items.push(...data);
        if (data.length < PAGE) break;
        from += PAGE;
      }

      const tenantIds = [...new Set(items.map(r => r.tenant_id).filter(Boolean))] as string[];
      const landlordIds = [...new Set(items.map(r => r.landlord_id).filter(Boolean))] as string[];
      const agentIds = [...new Set(items.map(r => r.agent_id).filter(Boolean))] as string[];

      // Hydrate names — batched in() calls so nothing is truncated.
      const fetchInBatches = async <T,>(ids: string[], fn: (batch: string[]) => PromiseLike<{ data: T[] | null }>): Promise<T[]> => {
        const out: T[] = [];
        for (let i = 0; i < ids.length; i += 500) {
          const { data } = await fn(ids.slice(i, i + 500));
          if (data) out.push(...data);
        }
        return out;
      };

      const [tenantProfiles, landlords, agents] = await Promise.all([
        fetchInBatches<any>(tenantIds, (b) => supabase.from('profiles').select('id, full_name, phone, tenant_status').in('id', b)),
        fetchInBatches<any>(landlordIds, (b) => supabase.from('landlords').select('id, name, phone').in('id', b)),
        fetchInBatches<any>(agentIds, (b) => supabase.from('profiles').select('id, full_name').in('id', b)),
      ]);

      const profileMap = new Map(tenantProfiles.map((p: any) => [p.id, p]));
      const landlordMap = new Map(landlords.map((l: any) => [l.id, l]));
      const agentMap = new Map(agents.map((a: any) => [a.id, a]));

      return items
        .map(r => ({
          ...r,
          tenant_name: profileMap.get(r.tenant_id)?.full_name || '—',
          tenant_phone: profileMap.get(r.tenant_id)?.phone || '—',
          tenant_status: profileMap.get(r.tenant_id)?.tenant_status || 'active',
          landlord_name: landlordMap.get(r.landlord_id)?.name || '—',
          landlord_phone: landlordMap.get(r.landlord_id)?.phone || '—',
          agent_name: r.agent_id ? (agentMap.get(r.agent_id)?.full_name || '—') : 'Unassigned',
        }));
    },
    staleTime: 600000,
  });

  const rows = rentRequests || [];
  const pending = rows.filter(r => r.status === 'pending').length;
  const funded = rows.filter(r => ['funded', 'disbursed'].includes(r.status)).length;
  const repaying = rows.filter(r => r.status === 'repaying').length;
  const fullyRepaid = rows.filter(r => r.status === 'fully_repaid').length;
  const defaulted = rows.filter(r => r.status === 'defaulted').length;
  const inPipeline = rows.filter(r => ['tenant_ops_approved', 'agent_verified', 'landlord_ops_approved', 'coo_approved'].includes(r.status)).length;

  const { data: toolCounts } = useTenantOpsToolCounts();
  const { data: rejectedTenantOpsCount = 0 } = useQuery({
    queryKey: ['tenant-ops-rejected-count'],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('rent_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'rejected')
        .eq('rejected_at_stage', 'agent_ops_approved');
      if (error) return 0;
      return count ?? 0;
    },
    staleTime: 30_000,
  });

  const navCards: NavCard[] = [
    {
      id: 'pipeline',
      label: 'Review Requests',
      description: 'Approve or reject pending rent requests',
      icon: ClipboardList,
      color: 'bg-amber-500/10 text-amber-600 border-amber-200',
      badge: toolCounts?.review_requests ?? 0,
      badgeColor: 'bg-amber-500 text-white',
    },
    {
      id: 'tenant-products-report',
      label: 'Products & Services Report',
      description: 'Daily tenant products, receivables & payables',
      icon: FileSearch,
      color: 'bg-purple-500/10 text-purple-600 border-purple-200',
    },
    {
      id: 'daily',
      label: 'Daily Payments',
      description: 'Who paid today & who hasn\'t',
      icon: CalendarCheck,
      color: 'bg-emerald-500/10 text-emerald-600 border-emerald-200',
      // Tenants who paid today (>= half the daily amount) — same rule as the tool.
      badge: toolCounts?.paid_today_tenants ?? 0,
      badgeColor: 'bg-emerald-500 text-white',
    },
    {
      id: 'missed',
      label: 'Missed Days',
      description: 'Tenants behind on payments',
      icon: CalendarX2,
      color: 'bg-destructive/10 text-destructive border-destructive/20',
      badge: toolCounts?.missed_days_tenants ?? defaulted,
      badgeColor: 'bg-destructive text-white',
    },
    {
      id: 'behavior',
      label: 'Tenant Behavior',
      description: 'Risk scores & payment patterns',
      icon: Activity,
      color: 'bg-purple-500/10 text-purple-600 border-purple-200',
      // Tenant Behavior tool's own risk model, not the missed-days model.
      badge: toolCounts?.behavior_critical ?? 0,
      badgeColor: 'bg-purple-500 text-white',
    },
    {
      id: 'history',
      label: 'Approval History',
      description: 'Past approvals & rejections log',
      icon: History,
      color: 'bg-blue-500/10 text-blue-600 border-blue-200',
      badge: toolCounts?.approvals_today ?? 0,
      badgeColor: 'bg-blue-500 text-white',
    },
    {
      id: 'all-requests',
      label: 'All Requests',
      description: 'Full table of every request',
      icon: Table2,
      color: 'bg-muted text-foreground border-border',
    },
    {
      id: 'link-agent',
      label: 'Link Agent',
      description: 'Assign an agent to a tenant',
      icon: Link2,
      color: 'bg-primary/10 text-primary border-primary/20',
    },
    {
      id: 'transfer-audit' as ActiveView,
      label: 'Transfer Audit',
      description: 'Geo-stamped link & transfer history',
      icon: Shield,
      color: 'bg-emerald-500/10 text-emerald-600 border-emerald-200',
      badge: toolCounts?.transfers_30d ?? 0,
      badgeColor: 'bg-emerald-500 text-white',
    },
    {
      id: 'collect-rent',
      label: 'Collect Rent',
      description: 'Charge tenant or agent wallet',
      icon: HandCoins,
      color: 'bg-orange-500/10 text-orange-600 border-orange-200',
    },
    {
      id: 'agent-tenants' as ActiveView,
      label: 'Search by Agent',
      description: 'Find tenants via their agent',
      icon: Users,
      color: 'bg-cyan-500/10 text-cyan-600 border-cyan-200',
    },
    {
      id: 'registration-review' as ActiveView,
      label: 'Review Registration',
      description: 'View & edit tenant info',
      icon: FileSearch,
      color: 'bg-teal-500/10 text-teal-600 border-teal-200',
    },
    {
      id: 'advance-requests' as ActiveView,
      label: 'Business Advances',
      description: 'Business advances & rent history',
      icon: Banknote,
      color: 'bg-purple-500/10 text-purple-600 border-purple-200',
    },
    {
      id: 'agent-allocations' as ActiveView,
      label: 'Agent Allocations',
      description: 'Holistic per-agent tenant repayment view',
      icon: Network,
      color: 'bg-indigo-500/10 text-indigo-600 border-indigo-200',
    },
    {
      id: 'landlord-float' as ActiveView,
      label: 'Agent Landlord Float',
      description: 'Per-agent landlord-payout float balances & earmarks',
      icon: Landmark,
      color: 'bg-fuchsia-500/10 text-fuchsia-600 border-fuchsia-200',
    },
    {
      id: 'landlord-float-timeline' as ActiveView,
      label: 'Float Timeline',
      description: 'Allocation history by date & reference ID',
      icon: History,
      color: 'bg-violet-500/10 text-violet-600 border-violet-200',
    },
    {
      id: 'location-browser' as ActiveView,
      label: 'Browse by Location',
      description: 'Drill country → region → district → ward → agent → landlord → properties',
      icon: MapPin,
      color: 'bg-sky-500/10 text-sky-600 border-sky-200',
    },
    {
      id: 'daily-repayments-report' as ActiveView,
      label: 'Daily Rent Repayments',
      description: 'Ledger-confirmed rent repayments by tenant for the day',
      icon: HandCoins,
      color: 'bg-emerald-500/10 text-emerald-600 border-emerald-200',
    },
  ];

  const goBack = () => {
    if (tenantDetailOrigin) {
      const origin = tenantDetailOrigin;
      setTenantDetailOrigin(null);
      setActiveView(origin);
    } else {
      setActiveView('overview');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openHub = (view: ActiveView) => {
    setTenantDetailOrigin(null);
    setActiveView(view);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** Enter the Pipeline Status hub, optionally pre-filtered to one lifecycle
   *  group (used by the Classic "Pipeline status" tiles). */
  const openPipelineHub = (statusKey: string = 'all') => {
    setPipelineSeed(statusKey);
    openHub('pipeline-hub');
  };

  // Hub entry card for the Classic sections — same interaction model as the
  // Global Verification Center / Welile Operations hero cards: icon, section
  // name, a minimal summary, and an "Open hub" pill that promotes the section
  // to its dedicated full-width working view (with "Back to Overview").
  const renderHubEntry = (opts: {
    title: string;
    view: ActiveView;
    icon: React.ElementType;
    description: string;
    stats?: { label: string; value: string | number }[];
  }) => {
    return (
      <HubEntryCard
        key={opts.view}
        title={opts.title}
        description={opts.description}
        icon={opts.icon}
        stats={opts.stats}
        onClick={() => openHub(opts.view)}
      />
    );
  };

  const columns: Column<any>[] = [
    { key: 'created_at', label: 'Date', render: (v) => v ? format(new Date(v as string), 'dd MMM yy') : '—' },
    { key: 'tenant_name', label: 'Tenant', render: (v, row: any) => (
      <span className="flex items-center gap-1.5 flex-wrap">
        <span className={row?.tenant_status === 'inactive' ? 'line-through text-muted-foreground' : ''}>
          {String(v ?? '—')}
        </span>
        {row?.tenant_status === 'inactive' && (
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-amber-100 text-amber-700 border border-amber-300">
            Not active
          </span>
        )}
        {row?.tenant_status === 'evicted' && (
          <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-destructive/10 text-destructive border border-destructive/30">
            Evicted
          </span>
        )}
      </span>
    )},
    { key: 'tenant_phone', label: 'Phone' },
    { key: 'status', label: 'Status', render: (v) => {
      const colors: Record<string, string> = {
        pending: 'bg-amber-100 text-amber-700',
        tenant_ops_approved: 'bg-blue-100 text-blue-700',
        agent_verified: 'bg-purple-100 text-purple-700',
        landlord_ops_approved: 'bg-indigo-100 text-indigo-700',
        coo_approved: 'bg-emerald-100 text-emerald-700',
        funded: 'bg-green-100 text-green-700',
        disbursed: 'bg-teal-100 text-teal-700',
        repaying: 'bg-purple-100 text-purple-700',
        fully_repaid: 'bg-emerald-100 text-emerald-700',
        defaulted: 'bg-destructive/10 text-destructive',
      };
      return <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[String(v)] || 'bg-muted'}`}>{String(v).replace(/_/g, ' ')}</span>;
    }},
    { key: 'rent_amount', label: 'Amount', render: (v, row: any) => {
      // Outstanding-balance registrations: obligation = arrears (total_repayment), not monthly rent
      const amount = row?.registration_type === 'outstanding_balance'
        ? Number(row?.total_repayment || 0)
        : Number(v || 0);
      return amount.toLocaleString();
    }},
    { key: 'amount_repaid', label: 'Remaining', render: (_v, row: any) => {
      const obligation = row?.registration_type === 'outstanding_balance'
        ? Number(row?.total_repayment || 0)
        : Number(row?.total_repayment || row?.rent_amount || 0);
      const remaining = Math.max(0, obligation - Number(row?.amount_repaid || 0));
      return remaining.toLocaleString();
    }},
    { key: 'agent_name', label: 'Current Agent', render: (v) => (
      <span className={`text-xs ${v === 'Unassigned' ? 'text-muted-foreground italic' : 'font-medium'}`}>
        {String(v ?? '—')}
      </span>
    )},
    { key: 'landlord_name', label: 'Landlord' },
    { key: 'landlord_phone', label: 'L. Phone' },
    { key: 'tenant_id', label: 'Action', render: (_v, row) => (
      <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-primary hover:bg-primary/10"
        onClick={(e) => {
          e.stopPropagation();
          setLocationDialog({ open: true, tenantId: row.tenant_id, tenantName: row.tenant_name || 'Tenant' });
        }}
      >
        <MapPin className="h-3.5 w-3.5 mr-1" />
        Location
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="h-8 px-2 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          setDeleteDialog({ open: true, tenantId: row.tenant_id, tenantName: row.tenant_name || 'Unknown' });
        }}
      >
        <Trash2 className="h-3.5 w-3.5 mr-1" />
        Delete
      </Button>
      </div>
    )},
  ];

  const renderSubView = () => {
    switch (activeView) {
      case 'pipeline':
        return (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-3">
              <div className="min-w-0">
                <p className="text-sm font-bold">Reviewing requests</p>
                <p className="text-[11px] text-muted-foreground">
                  Approvals live here. For counts, money and reports open the Pipeline Status hub.
                </p>
              </div>
              <Button size="sm" variant="outline" className="gap-1.5" onClick={() => openPipelineHub('all')}>
                <Activity className="h-3.5 w-3.5" />
                Pipeline Status hub
              </Button>
            </div>

            <Tabs defaultValue="pending" className="space-y-4">
              <div className="overflow-x-auto scrollbar-hide -mx-1 px-1">
                <TabsList variant="pills" className="w-max">
                  <TabsTrigger value="pending" variant="pills" className="gap-1.5">
                    <Clock className="h-3.5 w-3.5" />
                    <span className="text-xs">Pending Review</span>
                    {toolCounts?.review_requests != null && toolCounts.review_requests > 0 && (
                      <Badge variant="primary" size="sm" className="ml-0.5 min-w-[18px] justify-center font-bold">
                        {toolCounts.review_requests}
                      </Badge>
                    )}
                  </TabsTrigger>
                  <TabsTrigger value="rejected" variant="pills" className="gap-1.5">
                    <XCircle className="h-3.5 w-3.5 text-destructive" />
                    <span className="text-xs">Rejected</span>
                    {rejectedTenantOpsCount > 0 && (
                      <Badge variant="destructive" size="sm" className="ml-0.5 min-w-[18px] justify-center font-bold">
                        {rejectedTenantOpsCount}
                      </Badge>
                    )}
                  </TabsTrigger>
                </TabsList>
              </div>

              <TabsContent value="pending" className="space-y-4">
                <RentPipelineQueue
                  stage="agent_ops_approved"
                  additionalStatuses={['agent_verified']}
                />
              </TabsContent>
              <TabsContent value="rejected" className="space-y-4">
                <RejectedRequestsQueue stageFilter="agent_ops_approved" title="Rejected at Tenant Ops" />
              </TabsContent>
            </Tabs>
          </div>
        );
      case 'pipeline-hub':
        return (
          <PipelineStatusHub
            key={pipelineSeed}
            initialStatusKey={pipelineSeed}
            onOpenTenant={(tenantId, tenantName) => {
              setSelectedTenant({ id: tenantId, name: tenantName });
              setActiveView('tenant-detail');
            }}
          />
        );
      case 'location-corrections':
        return <TenantLocationCorrectionsHub />;
      case 'daily':
        return <DailyPaymentTracker />;
      case 'missed':
        return <MissedDaysTracker />;
      case 'backlog-analysis':
        return <BacklogAnalysis />;
      case 'behavior':
        return <TenantBehaviorDashboard />;
      case 'history':
        return <ApprovalHistoryLog />;
      case 'all-requests':
        return (
          <ExecutiveDataTable
            data={rows}
            columns={columns}
            loading={isLoading}
            title="All Requests"
            getRowId={(r: any) => String(r.tenant_id || r.id)}
            selectedIds={selectedTenantIds}
            onSelectionChange={setSelectedTenantIds}
            bulkActions={(ids) => (
              <Button
                variant="destructive"
                size="sm"
                className="h-8 gap-1.5"
                onClick={() => setBulkDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete {ids.length}
              </Button>
            )}
            filters={[{
              key: 'status',
              label: 'Status',
              options: [
                { value: 'pending', label: 'Pending' },
                { value: 'tenant_ops_approved', label: 'Tenant Ops Approved' },
                { value: 'agent_verified', label: 'Agent Verified' },
                { value: 'landlord_ops_approved', label: 'Landlord Ops Approved' },
                { value: 'coo_approved', label: 'COO Approved' },
                { value: 'funded', label: 'Funded' },
                { value: 'repaying', label: 'Repaying' },
                { value: 'fully_repaid', label: 'Fully Repaid' },
                { value: 'defaulted', label: 'Defaulted' },
              ],
            }]}
          />
        );
      case 'link-agent':
        return <TenantAgentLinker />;
      case 'transfer-audit':
        return <TenantTransferAuditTrail />;
      case 'collect-rent':
        return <TenantRentCollector />;
      case 'agent-tenants':
        return <AgentTenantSearch />;
      case 'tenant-detail':
        return selectedTenant ? (
          <TenantDetailPanel
            tenantId={selectedTenant.id}
            tenantName={selectedTenant.name}
            onBack={goBack}
            onViewRegistration={() => setActiveView('registration-review')}
          />
        ) : (
          <TenantOverviewList
            data={rows}
            loading={isLoading}
            onSelectTenant={(id, name) => {
              setSelectedTenant({ id, name });
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        );
      case 'registration-review':
        return selectedTenant ? (
          <TenantRegistrationReview
            tenantId={selectedTenant.id}
            tenantName={selectedTenant.name}
            onBack={goBack}
          />
        ) : (
          <TenantOverviewList
            data={rows}
            loading={isLoading}
            onSelectTenant={(id, name) => {
              setSelectedTenant({ id, name });
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        );
      case 'advance-requests':
        return (
          <div className="space-y-6">
            <BusinessAdvanceQueue stage="tenant_ops" />
            <RentHistoryVerificationQueue dept="tenant_ops" />
          </div>
        );
      case 'agent-allocations':
        return <AgentAllocationReport />;
      case 'landlord-float':
        return <TenantOpsLandlordFloatPanel />;
      case 'landlord-float-timeline':
        return <TenantOpsLandlordFloatTimeline />;
      case 'location-browser':
        return <LocationBrowser />;
      case 'tenant-location-browser':
        return <TenantLocationBrowser />;
      case 'welile-operations':
        return <WelileOperationsHub />;
      case 'global-verification':
        return <GlobalVerificationHub />;
      case 'daily-collections':
        return <DailyCollectionMonitoringDashboard mode="editable" title="Daily Collection Monitoring" />;
      case 'agent-monitoring':
        return <AgentMonitoring />;
      case 'daily-repayments-report':
        return <DailyRentReport mode="tenant" />;
      case 'tenant-self-repayments':
        return <TenantSelfRepaymentsPanel audience="tenant-ops" />;
      case 'agent-capacity-hub':
        return <AgentRentCapacityPanel />;
      case 'all-tenants-hub':
        return (
          <TenantOverviewList
            data={rows}
            loading={isLoading}
            initialCategory={overviewFilter}
            onSelectTenant={(id, name) => {
              setSelectedTenant({ id, name });
              setActiveView('tenant-detail');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        );
      case 'tenant-locations-test':
        return (
          <TenantLocationsBrowser
            onSelectTenant={(id, name) => {
              setSelectedTenant({ id, name });
              setTenantDetailOrigin('tenant-locations-test');
              setActiveView('tenant-detail');
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
          />
        );
      case 'portfolio-performance-hub':
        return <TenantOpsPortfolioPerformance />;
      case 'tenant-products-report':
        return <TenantProductsServicesReport />;
      case 'reliability-hub':
        return <TenantRepaymentReliabilityPanel />;
      case 'reports-hub':
        return (
          <div className="space-y-3">
            {reportsToolbar}
            <TenantOpsExtractCenter
              rangeLabel={reportRangeLabel}
              extracting={extracting}
              onExtract={runExtract}
              printing={printingPdf}
              onPrintReport={() => void handlePrintReport()}
              onOpenView={(view: ExtractTargetView) => {
                setActiveView(view as ActiveView);
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }}
            />
          </div>
        );
      default:
        return null;
    }
  };

  const sectionHubLabels: Partial<Record<ActiveView, string>> = {
    'pipeline-hub': 'Pipeline Status',
    'agent-capacity-hub': 'Agent Rent Capacity',
    'all-tenants-hub': 'All Tenants',
    'tenant-locations-test': 'Tenant Locations',
    'portfolio-performance-hub': 'Portfolio Performance',
    'daily-collections': 'Daily Collection Monitoring',
    'agent-monitoring': 'Agent Monitoring',
    'reports-hub': 'Reports & Exports',
    'reliability-hub': 'Repayment Reliability Score',
  };

  const activeLabel = navCards.find(n => n.id === activeView)?.label || sectionHubLabels[activeView] || '';

  // Primary mobile quick-actions — surfaced in a sticky pill bar at the
  // very top so the most-used flows are one tap away on a phone.
  const quickActions: { id: ActiveView; label: string; icon: React.ElementType; tone: string }[] = [
    { id: 'collect-rent', label: 'Collect', icon: HandCoins, tone: 'bg-orange-500/10 text-orange-700 border-orange-200' },
    { id: 'pipeline', label: 'Review', icon: ClipboardList, tone: 'bg-amber-500/10 text-amber-700 border-amber-200' },
    { id: 'daily', label: 'Today', icon: CalendarCheck, tone: 'bg-emerald-500/10 text-emerald-700 border-emerald-200' },
    { id: 'missed', label: 'Missed', icon: CalendarX2, tone: 'bg-destructive/10 text-destructive border-destructive/20' },
  ];

  // Reports & Exports toolbar — shared by the inline Classic section and
  // its dedicated "Open hub" full view.
  // Label + dispatcher so the centralized Extract card can reuse the very same
  // date window and extract handlers this toolbar already uses.
  const reportRangeLabel = reportFrom || reportTo
    ? `${reportFrom ? format(reportFrom, 'dd MMM yyyy') : 'any date'} — ${reportTo ? format(reportTo, 'dd MMM yyyy') : 'today'}`
    : 'no date filter — all time';

  const runExtract = (kind: ExtractKind) => {
    if (kind === 'applied') return void handleExtractApplied();
    if (kind === 'approved') return void handleExtractApproved();
    if (kind === 'funded') return void handleExtractFunded();
    if (kind === 'collected') return void handleExtractCollected();
    return void handleExtractExpected();
  };

  const reportsToolbar = (
                <div className="flex flex-wrap sm:justify-end items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={cn("gap-1.5 font-normal", !reportFrom && "text-muted-foreground")}>
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {reportFrom ? format(reportFrom, 'dd MMM yyyy') : 'From'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={reportFrom}
                      onSelect={setReportFrom}
                      initialFocus
                      className={cn("p-3 pointer-events-auto")}
                    />
                  </PopoverContent>
                </Popover>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm" className={cn("gap-1.5 font-normal", !reportTo && "text-muted-foreground")}>
                      <CalendarIcon className="h-3.5 w-3.5" />
                      {reportTo ? format(reportTo, 'dd MMM yyyy') : 'To'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={reportTo}
                      onSelect={setReportTo}
                      initialFocus
                      className={cn("p-3 pointer-events-auto")}
                    />
                  </PopoverContent>
                </Popover>
                {(reportFrom || reportTo) && (
                  <Button variant="ghost" size="sm" onClick={() => { setReportFrom(undefined); setReportTo(undefined); }}>
                    Clear
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="gap-1.5" disabled={!!extracting}>
                      {extracting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                      Extract
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64 bg-popover">
                    <DropdownMenuLabel className="text-xs">Tenants</DropdownMenuLabel>
                    <DropdownMenuItem disabled={!!extracting} onClick={handleExtractApplied}>
                      <ClipboardList className="h-4 w-4 mr-2" /> How many applied (CSV)
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!!extracting} onClick={handleExtractApproved}>
                      <CheckCircle2 className="h-4 w-4 mr-2" /> How many approved (CSV)
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!!extracting} onClick={handleExtractFunded}>
                      <Wallet className="h-4 w-4 mr-2" /> How many funded (PDF)
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel className="text-xs">Repayments</DropdownMenuLabel>
                    <DropdownMenuItem disabled={!!extracting} onClick={handleExtractCollected}>
                      <Banknote className="h-4 w-4 mr-2" /> How much collected (CSV)
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!!extracting} onClick={handleExtractExpected}>
                      <CalendarCheck className="h-4 w-4 mr-2" /> How much expected (CSV)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={handlePrintReport}
                  disabled={printingPdf}
                >
                  {printingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
                  Print Report
                </Button>
              </div>
  );

  return (
    <div className="space-y-3">
      <AnimatePresence mode="wait">
        {activeView === 'overview' ? (hideOverview ? null : (
          <motion.div
            key="overview"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="space-y-3"
          >
            {/* HERO: Global verification center — always first */}
            <button
              onClick={() => { setActiveView('global-verification'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              className="w-full rounded-xl border-2 border-primary/50 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-3.5 flex items-center gap-3 text-left min-h-[64px] touch-manipulation active:scale-[0.98] transition-transform shadow-sm"
            >
              <div className="p-2 rounded-lg bg-primary/15">
                <Shield className="h-5 w-5 text-primary shrink-0" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-bold text-sm text-foreground leading-tight">Global Verification Center</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 leading-snug">New landlords, LC1 chairpersons &amp; rent requests to verify — by country (Uganda, Kenya…)</p>
              </div>
              <ArrowRight className="h-5 w-5 text-primary shrink-0" />
            </button>

            {/* HERO: Welile Operations — manage every user category */}
            <button
              onClick={() => { setActiveView('welile-operations'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
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
                <ArrowRight className="h-3.5 w-3.5" />
              </span>
            </button>

            {/* Secondary: original landlord-float earmarks panel */}
            <button
              onClick={() => { setActiveView('landlord-float'); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              className="w-full rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/5 p-2.5 flex items-center gap-2.5 text-left min-h-[52px] touch-manipulation active:scale-[0.98] transition-transform"
            >
              <div className="p-1.5 rounded-lg bg-fuchsia-500/15">
                <Landmark className="h-4 w-4 text-fuchsia-600 shrink-0" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-[13px] text-foreground leading-tight">Landlord-payout earmarks (legacy view)</p>
                <p className="text-[10px] text-muted-foreground mt-0.5 leading-snug">Per-agent float balances &amp; earmarks</p>
              </div>
              <ArrowRight className="h-4 w-4 text-fuchsia-600 shrink-0" />
            </button>

            {/* Sticky mobile quick-actions — always reachable */}
            <div className="sticky top-[52px] z-20 -mx-2 px-2 py-1.5 bg-background/95 backdrop-blur border-b sm:hidden">
              <div className="grid grid-cols-4 gap-1.5">
                {quickActions.map((q) => {
                  const Icon = q.icon;
                  return (
                    <button
                      key={q.id}
                      onClick={() => { setActiveView(q.id); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                      className={`flex flex-col items-center justify-center gap-0.5 rounded-lg border px-1 py-1.5 ${q.tone}`}
                    >
                      <Icon className="h-4 w-4" />
                      <span className="text-[10px] font-semibold leading-none">{q.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Tenant Ops Tools — surfaced first on mobile for fast nav */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Tenant Ops Tools</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-2.5">
                {navCards.map((card) => {
                  const Icon = card.icon;
                  return (
                    <motion.button
                      key={card.id}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => {
                        setActiveView(card.id);
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                      }}
                      className="text-left w-full"
                    >
                      <Card className={`border h-full hover:shadow-md transition-shadow ${card.color.includes('amber') ? 'border-amber-200' : card.color.includes('emerald') ? 'border-emerald-200' : card.color.includes('destructive') ? 'border-destructive/20' : card.color.includes('purple') ? 'border-purple-200' : card.color.includes('blue') ? 'border-blue-200' : 'border-border'}`}>
                        <CardContent className="p-3 sm:p-3.5 space-y-1.5 sm:space-y-2">
                          <div className="flex items-start justify-between">
                            <div className={`p-1.5 sm:p-2 rounded-xl ${card.color.split(' ').slice(0, 1).join(' ')}`}>
                              <Icon className={`h-4 w-4 sm:h-5 sm:w-5 ${card.color.split(' ').slice(1, 2).join(' ')}`} />
                            </div>
                            {card.badge !== undefined && card.badge > 0 && (
                              <Badge className={`text-[10px] px-1.5 py-0 font-bold ${card.badgeColor}`}>
                                {card.badge}
                              </Badge>
                            )}
                          </div>
                          <div>
                            <p className="font-bold text-[13px] sm:text-sm text-foreground leading-tight">{card.label}</p>
                            <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5 leading-snug line-clamp-2">{card.description}</p>
                          </div>
                        </CardContent>
                      </Card>
                    </motion.button>
                  );
                })}
              </div>
            </div>

            {/* Classic workspaces — each opens its own hub view */}
            <div>
              <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-1.5">Workspaces</p>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
                {renderHubEntry({
                  title: 'Pipeline Status',
                  view: 'pipeline-hub',
                  icon: Activity,
                  description: 'Lifecycle counts, receivables, landlord payables, charts and auditable reports for any date range',
                  stats: [
                    { label: 'pending', value: pending },
                    { label: 'in pipeline', value: inPipeline },
                    { label: 'funded', value: funded },
                  ],
                })}
                {renderHubEntry({
                  title: 'Agent Rent Capacity',
                  view: 'agent-capacity-hub',
                  icon: Gauge,
                  description: 'Fleet-wide rent-request capacity, eligibility and daily ratings per agent',
                })}
                {renderHubEntry({
                  title: 'All Tenants',
                  view: 'all-tenants-hub',
                  icon: Users,
                  description: 'Full tenant register with search, filters, profiles and bulk actions',
                  stats: [
                    // Unique tenants, not rent-request rows.
                    { label: 'tenants', value: toolCounts?.tenant_count ?? new Set(rows.map(r => r.tenant_id)).size },
                    { label: 'pending', value: toolCounts?.new_requests ?? pending },
                    { label: 'repaying', value: toolCounts?.repaying_plans ?? repaying },
                  ],
                })}
                {renderHubEntry({
                  title: 'Tenant Locations',
                  view: 'tenant-locations-test',
                  icon: MapPin,
                  description: 'Read-only test page: Region → District → County → Sub-county → Parish → Village → tenants, with an Unmapped group for legacy locations',
                })}
                {renderHubEntry({
                  title: 'Daily Collection Monitoring',
                  view: 'daily-collections',
                  icon: CalendarCheck,
                  description: 'Track and edit today’s expected vs collected rent across the fleet',
                })}
                {renderHubEntry({
                  title: 'Repayment Reliability Score',
                  view: 'reliability-hub',
                  icon: ShieldCheck,
                  description: 'Risk score per tenant from rent amount, expected daily repayments, missed days and payment recency — with the collecting agent',
                })}
                {renderHubEntry({
                  title: 'Tenant Location Corrections',
                  view: 'location-corrections',
                  icon: MapPin,
                  description: 'Legacy tenants whose saved location is not yet matched to the approved location list — corrected tenants leave the list automatically',
                })}
                {renderHubEntry({
                  title: 'Reports & Exports',
                  view: 'reports-hub',
                  icon: Download,
                  description: 'Date-ranged extracts (applied, approved, funded, collected) and printed reports',
                })}
              </div>
            </div>

            {/* Pipeline status strip */}
            <div className="pt-2">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Pipeline status</p>
                <button
                  type="button"
                  onClick={() => openPipelineHub('all')}
                  className="inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline"
                >
                  Open hub
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <Card className="border bg-amber-500/5 cursor-pointer hover:shadow-md transition-shadow" onClick={() => openPipelineHub('pending')}>
                <CardContent className="p-2.5 text-center">
                  <p className="text-2xl font-extrabold text-amber-600">{pending}</p>
                  <p className="text-[10px] text-muted-foreground font-medium">Pending</p>
                </CardContent>
              </Card>
              <Card className="border bg-green-500/5 cursor-pointer hover:shadow-md transition-shadow" onClick={() => openPipelineHub('funded')}>
                <CardContent className="p-2.5 text-center">
                  <p className="text-2xl font-extrabold text-green-600">{funded}</p>
                  <p className="text-[10px] text-muted-foreground font-medium">Funded</p>
                </CardContent>
              </Card>
              <Card className="border bg-purple-500/5 cursor-pointer hover:shadow-md transition-shadow" onClick={() => openPipelineHub('repaying')}>
                <CardContent className="p-2.5 text-center">
                  <p className="text-2xl font-extrabold text-purple-600">{repaying}</p>
                  <p className="text-[10px] text-muted-foreground font-medium">Repaying</p>
                </CardContent>
              </Card>
              <Card className="border bg-destructive/5 cursor-pointer hover:shadow-md transition-shadow" onClick={() => openPipelineHub('defaulted')}>
                <CardContent className="p-2.5 text-center">
                  <p className="text-2xl font-extrabold text-destructive">{defaulted}</p>
                  <p className="text-[10px] text-muted-foreground font-medium">Defaulted</p>
                </CardContent>
              </Card>
            </div>
            </div>

          </motion.div>
        )) : (

          <motion.div
            key={activeView}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.15 }}
            className="space-y-3"
          >
            {/* Back button - skip for tenant-detail which has its own, and when
                a parent shell provides sidebar navigation instead. */}
            {!hideOverview && activeView !== 'tenant-detail' && (

              <Button
                variant="ghost"
                onClick={goBack}
                className="h-11 px-3 gap-2 text-sm font-semibold -ml-1"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to Overview
                <span className="text-muted-foreground font-normal">· {activeLabel}</span>
              </Button>
            )}

            {renderSubView()}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Tenant Confirmation Dialog */}
      <AlertDialog open={deleteDialog.open} onOpenChange={(open) => !open && setDeleteDialog({ open: false, tenantId: '', tenantName: '' })}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Tenant</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{deleteDialog.tenantName}</strong> from the active tenant list and disable access, while preserving payment history and ledger records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteTenant}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Archiving...</>
              ) : (
                <><Trash2 className="h-4 w-4 mr-2" />Archive Tenant</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Delete Confirmation */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={(open) => !open && !bulkDeleting && setBulkDeleteOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {selectedTenantIds.length} tenant{selectedTenantIds.length === 1 ? '' : 's'}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{selectedTenantIds.length}</strong> selected tenant{selectedTenantIds.length === 1 ? '' : 's'} from active tenant views and disable access, while preserving payment history and ledger records.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkDelete}
              disabled={bulkDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {bulkDeleting ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Archiving…</>
              ) : (
                <><Trash2 className="h-4 w-4 mr-2" />Archive {selectedTenantIds.length}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit Tenant Location Dialog */}
      <Dialog open={locationDialog.open} onOpenChange={(open) => !open && setLocationDialog({ open: false, tenantId: '', tenantName: '' })}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Location — {locationDialog.tenantName}</DialogTitle>
          </DialogHeader>
          {locationDialog.tenantId && (
            <ResidenceAddressForm
              userId={locationDialog.tenantId}
              actingAsAgent
              onSaved={() => setLocationDialog({ open: false, tenantId: '', tenantName: '' })}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
