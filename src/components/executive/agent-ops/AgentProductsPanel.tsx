import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { UserAvatar } from '@/components/UserAvatar';
import { AgentProductDetailDialog } from './AgentProductDetailDialog';
import { formatUGX } from '@/lib/rentCalculations';
import { generateAgentProductsInFieldPdf, type AgentProductKpis, type AgentProductRow } from '@/lib/agentProductsInFieldPdf';
import { archivePdfBlob } from '@/lib/pdfVault';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Package, Users, Warehouse, Download, Plus, RefreshCw, Search, Wallet, TrendingUp, Trash2, Clock, Layers, Activity, Check, X, Loader2, Phone, Mail, MapPin, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';

interface CatalogItem { id: string; item_name: string; unit_price: number; unit_cost: number }
interface CentreItem { id: string; location_name: string | null; agent_id: string | null; agent_name: string | null; status: string }
export interface PendingApp {
  sale_id: string;
  agent_id: string | null;
  full_name: string | null;
  avatar_url: string | null;
  phone: string | null;
  item_name: string | null;
  brand: string | null;
  model_type: string | null;
  quantity: number;
  requested_amount: number;
  order_status: string;
  created_at: string;
}
interface BreakdownRow {
  label: string;
  models: number;
  reference_price: number;
  issued_qty: number;
  issued_value: number;
  outstanding: number;
}
interface ActivityRow {
  sale_id: string;
  agent_id: string | null;
  full_name: string | null;
  avatar_url: string | null;
  item_name: string | null;
  brand: string | null;
  model_type: string | null;
  amount: number;
  outstanding: number;
  order_status: string;
  happened_at: string;
}
interface Overview {
  kpis: AgentProductKpis;
  rows: AgentProductRow[];
  catalog: CatalogItem[];
  centres: CentreItem[];
  pending: PendingApp[];
  breakdown: BreakdownRow[];
  activity: ActivityRow[];
}


const PRODUCT_SUGGESTIONS = [
  'Welile Jumper', 'Welile Jacket', 'Welile Polo', 'Welile T-Shirt', 'Welile Cap',
  'Company ID', 'Signage (Shop Board)', 'Banner / Poster', 'Umbrella', 'Branded Bag',
];

/** Company-owned bike attached to an agent for operations — never sold, no wallet recovery. */
const FLEET_BIKE_OPTION = 'Company Fleet Bike (Assigned / Operational)';


export type AgentProductCategory = 'motor_bike' | 'smart_phone' | 'signage' | 'boutique';

/** Which overview KPI card the drill-down sheet is showing. */
type DrillKey = 'pending' | 'fleet' | 'portfolio' | 'recovery' | 'repaid';

const DRILL_TITLES: Record<DrillKey, string> = {
  pending: 'Pending applications',
  fleet: 'Active field fleet',
  portfolio: 'Outstanding portfolio',
  recovery: 'Repayments received',
  repaid: 'Repaid & fully paid off',
};

const DRILL_DESCRIPTIONS: Record<DrillKey, string> = {
  pending: 'Orders awaiting approval.',
  fleet: 'Every agent currently holding issued items.',
  portfolio: 'Agents who still owe on issued items, largest balance first.',
  recovery: 'Agents who have paid something back, largest repayment first.',
  repaid: 'Agents who have repaid part or all of their merchandise. Fully paid orders are marked.',
};

const CATEGORY_LABELS: Record<AgentProductCategory, string> = {
  motor_bike: 'Motor bikes',
  smart_phone: 'Smart phones',
  signage: 'Signages',
  boutique: 'Boutique',
};

const CATEGORY_SUGGESTIONS: Record<AgentProductCategory, string[]> = {
  motor_bike: [FLEET_BIKE_OPTION],
  smart_phone: ['Welile Smartphone'],
  signage: ['Signage (Shop Board)', 'Banner / Poster'],
  boutique: ['Welile Jumper', 'Welile Jacket', 'Welile Polo', 'Welile T-Shirt', 'Welile Cap', 'Company ID', 'Umbrella', 'Branded Bag'],
};

function AgentInlineProfileExpansion({ agentId }: { agentId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-product-detail-inline', agentId],
    queryFn: async () => {
      const [detailRes, profileRes, proxyRes, tenantsRes] = await Promise.all([
        supabase.rpc('get_agent_product_detail' as any, {
          p_agent_id: agentId,
          p_category: null,
        }),
        supabase.from('profiles').select('national_id, is_frozen, frozen_at').eq('id', agentId).maybeSingle(),
        supabase.from('proxy_agent_identity').select('nin').eq('agent_user_id', agentId).maybeSingle(),
        supabase
          .from('rent_requests')
          .select('id', { count: 'exact', head: true })
          .eq('agent_id', agentId)
          .in('status', ['funded', 'repaying'])
          .eq('tenancy_status', 'active'),
      ]);
      if (detailRes.error) throw detailRes.error;
      const national_id =
        (profileRes.data?.national_id && profileRes.data.national_id.trim()) ||
        (proxyRes.data?.nin && proxyRes.data.nin.trim()) ||
        null;
      const isActive = profileRes.data?.is_active !== false && profileRes.data?.status !== 'suspended' && profileRes.data?.status !== 'inactive';
      return {
        ...(detailRes.data as any),
        national_id,
        is_active: isActive,
        active_tenant_count: tenantsRes.count ?? 0,
      };
    },
    staleTime: 60_000,
  });

  const agent = data?.agent;
  const totals = data?.totals;
  const items = (data?.items ?? []).filter(
    (it: any) => !['rejected', 'cancelled', 'declined'].includes((it.order_status || '').toLowerCase()),
  );
  const deductions = (data?.deductions ?? []).slice(0, 3);

  if (isLoading) {
    return (
      <div className="p-3 space-y-2 rounded-lg border bg-background/50 animate-pulse">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-3 pt-3 border-t border-border/70 text-xs animate-in fade-in-50 duration-200">
      {/* Roles & Profile info */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {data?.is_active !== undefined && (
            data.is_active ? (
              <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20 font-medium">
                Active Agent
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20 font-medium">
                Inactive
              </Badge>
            )
          )}
          {(agent?.roles ?? []).length > 0 ? (
            (agent.roles as string[]).map((r) => (
              <Badge key={r} variant="secondary" className="text-[10px] capitalize">
                {r.replace(/_/g, ' ')}
              </Badge>
            ))
          ) : (
            <Badge variant="outline" className="text-[10px]">Registered Agent</Badge>
          )}
          {data?.national_id ? (
            <Badge variant="outline" className="text-[10px] font-mono bg-background">
              NIN: {data.national_id}
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
              No NIN
            </Badge>
          )}
          <Badge variant="secondary" className="text-[10px] font-medium gap-1">
            <Users className="h-3 w-3 text-primary" />
            {data?.active_tenant_count ?? 0} active tenants
          </Badge>
          {agent?.email && (
            <span className="text-[11px] text-muted-foreground flex items-center gap-1 truncate max-w-[200px]">
              <Mail className="h-3 w-3 shrink-0" /> {agent.email}
            </span>
          )}
        </div>
        {(agent?.district || agent?.territory) && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <MapPin className="h-3 w-3" /> {[agent?.district, agent?.territory].filter(Boolean).join(' · ')}
          </span>
        )}
      </div>

      {/* Financial Standing summary */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-background p-2 border border-border/50">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Billed</p>
          <p className="text-xs font-bold tabular-nums">{formatUGX(Number(totals?.billed || 0))}</p>
          <p className="text-[10px] text-muted-foreground">{Number(totals?.items || 0)} item(s)</p>
        </div>
        <div className="rounded-lg bg-background p-2 border border-border/50">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Repaid</p>
          <p className="text-xs font-bold tabular-nums text-emerald-600">{formatUGX(Number(totals?.repaid || 0))}</p>
        </div>
        <div className="rounded-lg bg-background p-2 border border-border/50">
          <p className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold">Outstanding</p>
          <p className="text-xs font-bold tabular-nums text-rose-600">{formatUGX(Number(totals?.outstanding || 0))}</p>
        </div>
      </div>

      {/* Active Items on file */}
      {items.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-muted-foreground">Active products ({items.length})</p>
          <div className="max-h-28 overflow-y-auto space-y-1 rounded-lg border p-1.5 bg-background">
            {items.map((it: any) => (
              <div key={it.id} className="flex items-center justify-between text-[11px] px-2 py-1 bg-muted/30 rounded">
                <span className="font-medium truncate">{[it.brand, it.model_type].filter(Boolean).join(' ') || it.item_name}</span>
                <span className="font-semibold tabular-nums text-muted-foreground">{formatUGX(Number(it.amount || 0))}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Repayments */}
      {deductions.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-semibold text-muted-foreground">Recent repayments</p>
          <div className="rounded-lg border divide-y bg-background text-[11px]">
            {deductions.map((d: any) => (
              <div key={d.id} className="flex items-center justify-between px-2 py-1">
                <span className="text-muted-foreground truncate">{d.item_name || 'Product payment'}</span>
                <span className="font-semibold text-emerald-600 tabular-nums">{formatUGX(Number(d.amount || 0))}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function AgentProductsPanel({ category, mode = 'full' }: { category?: AgentProductCategory; mode?: 'overview' | 'issued' | 'applications' | 'completed' | 'full' } = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [itemFilter, setItemFilter] = useState('all');
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);
  const [expandedProfile, setExpandedProfile] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentProductRow | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [rejectTarget, setRejectTarget] = useState<PendingApp | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  /** Pending application opened in the read-out + decide modal. */
  const [appDetail, setAppDetail] = useState<PendingApp | null>(null);

  const scopeLabel = category ? CATEGORY_LABELS[category] : null;
  const showApplications = mode === 'applications';
  const showOverview = mode === 'overview' || mode === 'full';
  const showCompleted = mode === 'completed';
  const showIssued = mode === 'issued' || mode === 'full' || showCompleted;


  const deleteHolding = useMutation({
    mutationFn: async () => {
      if (!deleteTarget) throw new Error('No record selected for deletion');
      const { data, error } = await supabase.rpc('delete_agent_product_holdings' as any, {
        p_agent_id: deleteTarget.agent_id,
        p_category: category ?? null,
        p_reason: deleteReason.trim(),
        // Unlinked holdings carry no profile — match them by the recorded buyer name.
        p_client_name: deleteTarget.full_name ?? null,
      });
      if (error) throw error;
      return (data ?? {}) as { deleted_sales?: number; deleted_plans?: number; deleted_deductions?: number };
    },
    onSuccess: async (result) => {
      const sales = Number(result?.deleted_sales ?? 0);
      const plans = Number(result?.deleted_plans ?? 0);
      const deductions = Number(result?.deleted_deductions ?? 0);
      if (sales === 0 && plans === 0 && deductions === 0) {
        toast.warning('No records were deleted');
      } else {
        toast.success(`Deleted ${sales} sale(s), ${plans} plan(s), ${deductions} deduction(s)`);
      }
      const removedId = deleteTarget?.agent_id ?? null;
      setDeleteTarget(null);
      setDeleteReason('');
      if (removedId) {
        // Drop the row from the cached list right away, then refetch from the server.
        queryClient.setQueriesData<Overview>({ queryKey: ['agent-products-overview'], exact: false }, (prev) =>
          prev ? { ...prev, rows: (prev.rows ?? []).filter((r) => r.agent_id !== removedId) } : prev,
        );
        queryClient.removeQueries({ queryKey: ['agent-product-detail', removedId], exact: false });
      }
      await queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
    },
    onError: (e: any) => toast.error(e?.message || 'Failed to delete records'),
  });




  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['agent-products-overview', category ?? 'all'],
    queryFn: async (): Promise<Overview> => {
      const { data, error } = await supabase.rpc('get_agent_products_overview' as any, { p_category: category ?? null });
      if (error) throw error;
      const payload = (data ?? {}) as any;
      return {
        kpis: payload.kpis ?? {},
        rows: payload.rows ?? [],
        catalog: payload.catalog ?? [],
        centres: payload.centres ?? [],
        pending: payload.pending ?? [],
        breakdown: payload.breakdown ?? [],
        activity: payload.activity ?? [],
      };
    },
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    placeholderData: (prev) => prev,
    refetchOnWindowFocus: false,
  });

  const isBoutique = category === 'boutique';
  const isSignage = category === 'signage';
  /** Signages are ordinary merchandise sales, so they use the same review RPCs as Boutique. */
  const usesMerchandiseReview = isBoutique || isSignage;

  const approveApp = useMutation({
    mutationFn: async (row: PendingApp) => {
      if (usesMerchandiseReview) {

        const { error } = await supabase.rpc('agent_ops_approve_merchandise_order' as any, {
          p_sale_id: row.sale_id,
        });
        if (error) throw error;
        return;
      }
      const { error } = await supabase.rpc('approve_smartphone_order' as any, {
        p_sale_id: row.sale_id,
        p_total_amount: Math.round(Number(row.requested_amount || 0)),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Application approved');
      setAppDetail(null);
      queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-queue'] });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-pending-count'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not approve application'),
  });

  const rejectApp = useMutation({
    mutationFn: async ({ row, reason }: { row: PendingApp; reason: string }) => {
      const { error } = await supabase.rpc(
        (usesMerchandiseReview ? 'reject_merchandise_purchase' : 'reject_smartphone_order') as any,
        { p_sale_id: row.sale_id, p_reason: reason.trim() },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Application rejected');
      setRejectTarget(null);
      setRejectReason('');
      setAppDetail(null);
      queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-queue'] });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-pending-count'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not reject application'),
  });

  // Extra agent profile context (NIN, active status, active tenants, sale terms)
  // shown in the application details & reject dialogs without leaving the review flow.
  const activeAgentIdForModal = appDetail?.agent_id || rejectTarget?.agent_id || null;
  const activeSaleIdForModal = appDetail?.sale_id || rejectTarget?.sale_id || null;

  const { data: modalAgentContext } = useQuery({
    queryKey: ['agent-products-modal-context', activeAgentIdForModal, activeSaleIdForModal],
    enabled: !!activeAgentIdForModal || !!activeSaleIdForModal,
    queryFn: async () => {
      const [profileRes, proxyRes, tenantsRes, saleRes] = await Promise.all([
        activeAgentIdForModal
          ? supabase.from('profiles').select('national_id, full_name, phone, is_active, status, email, district, territory').eq('id', activeAgentIdForModal).maybeSingle()
          : Promise.resolve({ data: null }),
        activeAgentIdForModal
          ? supabase.from('proxy_agent_identity').select('nin').eq('agent_user_id', activeAgentIdForModal).maybeSingle()
          : Promise.resolve({ data: null }),
        activeAgentIdForModal
          ? supabase
              .from('rent_requests')
              .select('id', { count: 'exact', head: true })
              .eq('agent_id', activeAgentIdForModal)
              .in('status', ['funded', 'repaying'])
              .eq('tenancy_status', 'active')
          : Promise.resolve({ count: 0 }),
        activeSaleIdForModal
          ? supabase
              .from('merchandise_sales')
              .select('payment_plan, access_daily_amount, access_repayment_days, advance_period_months, unit_cost, unit_price, total_amount, total_revenue, repayment_starts_on')
              .eq('id', activeSaleIdForModal)
              .maybeSingle()
          : Promise.resolve({ data: null }),
      ]);

      const national_id =
        (profileRes.data?.national_id && profileRes.data.national_id.trim()) ||
        (proxyRes.data?.nin && proxyRes.data.nin.trim()) ||
        null;

      const profileStatus = profileRes.data?.status;
      const isActive = profileRes.data?.is_active !== false && profileStatus !== 'suspended' && profileStatus !== 'inactive';

      return {
        national_id,
        is_active: isActive,
        status: profileStatus || (isActive ? 'active' : 'inactive'),
        full_name: profileRes.data?.full_name ?? null,
        phone: profileRes.data?.phone ?? null,
        active_tenant_count: tenantsRes.count ?? 0,
        sale: saleRes.data ?? null,
      };
    },
    staleTime: 60_000,
  });


  const { data: bikeOrders = [], isLoading: isBikeOrdersLoading } = useQuery<any[]>({
    queryKey: ['bike-lease-queue'],
    enabled: category === 'motor_bike',
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_bike_lease_orders' as any, { p_status: null });
      if (error) throw error;
      return (data || []) as any[];
    },
    staleTime: 30_000,
  });

  const approvedBikeOrders = useMemo(() => {
    if (category !== 'motor_bike' || isBikeOrdersLoading) return [];
    return bikeOrders.filter((o) => ['approved', 'completed'].includes(o.order_status));
  }, [category, bikeOrders, isBikeOrdersLoading]);

  const approvedBikeAgentIds = useMemo(() => {
    if (category !== 'motor_bike') return null;
    if (isBikeOrdersLoading) return null;
    const ids = new Set<string>();
    const names = new Set<string>();
    approvedBikeOrders.forEach((o) => {
      if (o.customer_id) ids.add(o.customer_id);
      if (o.client_name) names.add(o.client_name.toLowerCase().trim());
    });
    return { ids, names };
  }, [category, approvedBikeOrders, isBikeOrdersLoading]);

  const rawRows = data?.rows ?? [];
  const allRows = useMemo(() => {
    if (category !== 'motor_bike' || !approvedBikeAgentIds) return rawRows;
    return rawRows
      .filter((r) => {
        const matchId = r.agent_id && approvedBikeAgentIds.ids.has(r.agent_id);
        const matchName = r.full_name && approvedBikeAgentIds.names.has(r.full_name.toLowerCase().trim());
        return Boolean(matchId || matchName);
      })
      .map((r) => {
        const matchingOrders = approvedBikeOrders.filter(
          (b) =>
            (b.customer_id && b.customer_id === r.agent_id) ||
            (b.client_name && (r.full_name || '').toLowerCase().trim() === b.client_name.toLowerCase().trim()),
        );
        if (matchingOrders.length > 0) {
          const totalVal = matchingOrders.reduce((sum, o) => sum + Number(o.valuation_amount || 0), 0);
          const totalPaid = matchingOrders.reduce((sum, o) => sum + Number(o.amount_paid || 0), 0);
          const totalOut = matchingOrders.reduce((sum, o) => sum + Number(o.amount_outstanding ?? o.valuation_amount ?? 0), 0);
          return {
            ...r,
            items_held: matchingOrders.length,
            held_amount: totalVal,
            outstanding_amount: totalOut,
            repaid_amount: totalPaid,
          };
        }
        return r;
      });
  }, [rawRows, category, approvedBikeAgentIds, approvedBikeOrders]);

  const kpis = data?.kpis as AgentProductKpis | undefined;
  const effectiveKpis = useMemo(() => {
    if (!kpis) return undefined;
    if (category !== 'motor_bike' || !approvedBikeAgentIds) return kpis;

    const inFieldAgents = allRows.length;
    const inFieldItems = allRows.reduce((sum, r) => sum + Number(r.items_held || 0), 0);
    const inFieldAmount = allRows.reduce((sum, r) => sum + Number(r.held_amount || 0), 0);
    const inFieldOutstanding = allRows.reduce((sum, r) => sum + Number(r.outstanding_amount || 0), 0);
    const inFieldRepaid = allRows.reduce((sum, r) => sum + Number(r.repaid_amount || 0), 0);

    return {
      ...kpis,
      in_field_agents: inFieldAgents,
      in_field_items: inFieldItems,
      in_field_amount: inFieldAmount,
      in_field_outstanding: inFieldOutstanding,
      in_field_repaid: inFieldRepaid,
    };
  }, [kpis, category, approvedBikeAgentIds, allRows]);

  const pendingApps = data?.pending ?? [];
  const breakdown = data?.breakdown ?? [];
  const activity = data?.activity ?? [];
  const isSmartphone = category === 'smart_phone';

  // KPI drill-down. The lists come straight from the same overview payload the
  // cards count, so a card and its sheet can never disagree.
  const [drill, setDrill] = useState<DrillKey | null>(null);
  const repaidRows = useMemo(
    () => allRows.filter((r) => Number(r.repaid_amount || 0) > 0)
      .sort((a, b) => Number(b.repaid_amount || 0) - Number(a.repaid_amount || 0)),
    [allRows],
  );
  const fullyPaidRows = useMemo(
    () => allRows.filter((r) => Number(r.held_amount || 0) > 0 && Number(r.outstanding_amount || 0) <= 0),
    [allRows],
  );
  const drillRows = useMemo(() => {
    switch (drill) {
      case 'fleet':
        return allRows.filter((r) => Number(r.items_held || 0) > 0);
      case 'portfolio':
        return allRows.filter((r) => Number(r.outstanding_amount || 0) > 0)
          .sort((a, b) => Number(b.outstanding_amount || 0) - Number(a.outstanding_amount || 0));
      case 'recovery':
      case 'repaid':
        return repaidRows;
      default:
        return [];
    }
  }, [drill, allRows, repaidRows]);



  const rows = useMemo(() => {
    const list = allRows;

    const term = search.trim().toLowerCase();
    return list.filter((r) => {
      const outstanding = Number(r.outstanding_amount || 0);
      // "Issued in field" keeps only agents still owing; fully repaid agents live in "Completed payments".
      if (showCompleted ? outstanding > 0 : mode === 'issued' && outstanding <= 0) return false;
      const names = (r.product_names || []).join(' ').toLowerCase();
      if (itemFilter !== 'all' && !names.includes(itemFilter.toLowerCase())) return false;
      if (!term) return true;
      return (
        (r.full_name || '').toLowerCase().includes(term) ||
        (r.location_name || '').toLowerCase().includes(term) ||
        ((r as any).phone || '').toLowerCase().includes(term) ||
        names.includes(term)
      );
    });
  }, [allRows, search, itemFilter, showCompleted, mode]);

  /** Service centre per agent, taken from the already-loaded issued rows — no extra round trip. */
  const centreByAgent = useMemo(() => {
    const map = new Map<string, string>();
    allRows.forEach((r) => {
      if (r.agent_id && r.location_name) map.set(r.agent_id, r.location_name);
    });
    (data?.centres ?? []).forEach((c) => {
      if (c.agent_id && c.location_name && !map.has(c.agent_id)) map.set(c.agent_id, c.location_name);
    });
    return map;
  }, [allRows, data?.centres]);

  /** Item names offered in the dropdown — drawn from what actually exists in this category. */
  const itemOptions = useMemo(() => {
    const names = new Set<string>();
    breakdown.forEach((b) => b.label && names.add(b.label));
    pendingApps.forEach((p) => p.item_name && names.add(p.item_name));
    allRows.forEach((r) => (r.product_names || []).forEach((n) => n && names.add(n)));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [breakdown, pendingApps, allRows]);

  const filteredPending = useMemo(() => {
    const term = search.trim().toLowerCase();
    return pendingApps.filter((p) => {
      const item = [p.brand, p.model_type].filter(Boolean).join(' ') || p.item_name || '';
      if (itemFilter !== 'all' && !`${item} ${p.item_name ?? ''}`.toLowerCase().includes(itemFilter.toLowerCase())) return false;
      if (!term) return true;
      return (
        (p.full_name || '').toLowerCase().includes(term) ||
        (p.phone || '').toLowerCase().includes(term) ||
        item.toLowerCase().includes(term)
      );
    });
  }, [pendingApps, search, itemFilter]);


  const exportPdf = async () => {
    if (!effectiveKpis) return;
    const { data: auth } = await supabase.auth.getUser();
    const actor = auth.user?.email || 'Agent Operations';
    const blob = generateAgentProductsInFieldPdf({ kpis: effectiveKpis, rows, actor });
    const filename = `Agent_Products_In_Field_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
    archivePdfBlob(blob, { label: 'Agent Products & Services', filename, category: 'other' }).catch(() => {});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const canDecide = isSmartphone || usesMerchandiseReview;

  const renderPendingRow = (p: PendingApp) => {
    const busy =
      (approveApp.isPending && approveApp.variables?.sale_id === p.sale_id) ||
      (rejectApp.isPending && rejectApp.variables?.row.sale_id === p.sale_id);
    return (
      <div
        key={p.sale_id}
        role="button"
        tabIndex={0}
        onClick={() => setAppDetail(p)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAppDetail(p); }
        }}
        className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 cursor-pointer hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <UserAvatar avatarUrl={p.avatar_url} fullName={p.full_name || undefined} size="sm" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold truncate text-foreground">{p.full_name || 'Unknown agent'}</p>
              <span className="sm:hidden text-[10px] text-muted-foreground shrink-0 tabular-nums">
                {p.created_at ? format(new Date(p.created_at), 'dd MMM') : ''}
              </span>
            </div>
            <p className="text-xs text-muted-foreground truncate">
              {[p.brand, p.model_type].filter(Boolean).join(' ') || p.item_name || '—'}
              {p.quantity > 1 ? ` × ${p.quantity}` : ''} · {formatUGX(Number(p.requested_amount || 0))}
              {p.phone ? ` · ${p.phone}` : ''}
            </p>
          </div>
        </div>

        <span className="hidden sm:block text-[11px] text-muted-foreground shrink-0 tabular-nums">
          {p.created_at ? format(new Date(p.created_at), 'dd MMM') : '—'}
        </span>

        {canDecide ? (
          <div
            className="flex items-center gap-1.5 justify-end sm:shrink-0 pl-11 sm:pl-0"
            onClick={(e) => e.stopPropagation()}
          >
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2.5 gap-1 text-xs text-success border-success/30 hover:bg-success/10 hover:text-success"
              disabled={busy}
              onClick={() => approveApp.mutate(p)}
            >
              {approveApp.isPending && approveApp.variables?.sale_id === p.sale_id
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Check className="h-3.5 w-3.5" />}
              Approve
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2.5 gap-1 text-xs text-destructive hover:text-destructive hover:bg-destructive/10"
              disabled={busy}
              onClick={() => { setRejectTarget(p); setRejectReason(''); }}
            >
              <X className="h-3.5 w-3.5" />
              Reject
            </Button>
          </div>
        ) : (
          <Badge variant="outline" className="text-[10px] shrink-0 self-end sm:self-auto">Awaiting review</Badge>
        )}
      </div>
    );
  };



  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between sm:justify-start gap-2">
        {scopeLabel && <Badge variant="secondary" className="text-[11px] font-medium">{scopeLabel}</Badge>}
        {(showIssued || showApplications) && (
          <>
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search agent name or phone"
                className="pl-8"
              />
            </div>
            <Select value={itemFilter} onValueChange={setItemFilter}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="All items" />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                <SelectItem value="all">All items</SelectItem>
                {itemOptions.map((name) => (
                  <SelectItem key={name} value={name}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(search.trim() || itemFilter !== 'all') && (
              <Button
                variant="ghost"
                size="sm"
                className="gap-1"
                onClick={() => { setSearch(''); setItemFilter('all'); }}
              >
                <X className="h-3.5 w-3.5" />
                Clear
              </Button>
            )}
          </>
        )}

        <div className="flex items-center gap-2 ml-auto sm:ml-0">
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-1.5 h-8 text-xs">
            <RefreshCw className={isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={exportPdf} disabled={!effectiveKpis} className="gap-1.5 h-8 text-xs">
            <Download className="h-3.5 w-3.5" />
            Export PDF
          </Button>
        </div>
        {showIssued && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                {category === 'motor_bike' ? 'Assign company bike' : 'New entry'}
              </Button>
            </DialogTrigger>
            <IssueProductDialog
              catalog={data?.catalog ?? []}
              centres={data?.centres ?? []}
              category={category}
              onDone={() => {
                setAddOpen(false);
                queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
              }}
            />
          </Dialog>
        )}
      </div>


      {showOverview && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          {isLoading || (category === 'motor_bike' && isBikeOrdersLoading) || !effectiveKpis ? (
            Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-[110px] rounded-2xl" />)
          ) : (
            <>
              <Card
                role="button"
                tabIndex={0}
                onClick={() => setDrill('pending')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill('pending'); } }}
                className="relative overflow-hidden cursor-pointer transition hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pending Applications</p>
                      {/* Count the same list the Applications tab renders, so the KPI and the tab badge can never disagree. */}
                      <p className="text-2xl font-bold tabular-nums">{pendingApps.length}</p>

                    </div>
                    <div className="rounded-lg bg-primary/10 p-2 text-primary">
                      <Package className="h-4 w-4" />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">Awaiting approval</p>
                </CardContent>
              </Card>

              <Card
                role="button"
                tabIndex={0}
                onClick={() => setDrill('fleet')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill('fleet'); } }}
                className="relative overflow-hidden cursor-pointer transition hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Active Field Fleet</p>
                      <p className="text-2xl font-bold tabular-nums">{effectiveKpis.in_field_agents ?? 0}</p>
                    </div>
                    <div className="rounded-lg bg-warning/10 p-2 text-warning">
                      <Users className="h-4 w-4" />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{effectiveKpis.in_field_items ?? 0} item(s) issued</p>
                </CardContent>
              </Card>

              <Card
                role="button"
                tabIndex={0}
                onClick={() => setDrill('portfolio')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill('portfolio'); } }}
                className="relative overflow-hidden cursor-pointer transition hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Financial Portfolio</p>
                      <p className="text-lg font-bold tabular-nums">{formatUGX(Number(effectiveKpis.in_field_outstanding || 0))}</p>
                    </div>
                    <div className="rounded-lg bg-success/10 p-2 text-success">
                      <Wallet className="h-4 w-4" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px]">
                      <span className="text-muted-foreground">Outstanding</span>
                      <span className="font-medium tabular-nums">{formatUGX(Number(effectiveKpis.in_field_amount || 0))} total</span>
                    </div>
                    <Progress
                      value={Number(effectiveKpis.in_field_amount || 0) > 0 ? Math.round(((Number(effectiveKpis.in_field_amount || 0) - Number(effectiveKpis.in_field_outstanding || 0)) / Number(effectiveKpis.in_field_amount || 0)) * 100) : 0}
                      className="h-1.5"
                    />
                  </div>
                </CardContent>
              </Card>

              <Card
                role="button"
                tabIndex={0}
                onClick={() => setDrill('recovery')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill('recovery'); } }}
                className="relative overflow-hidden cursor-pointer transition hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Repayment Recovery Rate</p>
                      <p className="text-2xl font-bold tabular-nums">
                        {Number(effectiveKpis.in_field_amount || 0) > 0 ? Math.round((Number(effectiveKpis.in_field_repaid || 0) / Number(effectiveKpis.in_field_amount || 0)) * 100) : 0}%
                      </p>
                    </div>
                    <div className="rounded-lg bg-info/10 p-2 text-info">
                      <TrendingUp className="h-4 w-4" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Progress
                      value={Number(effectiveKpis.in_field_amount || 0) > 0 ? Math.round((Number(effectiveKpis.in_field_repaid || 0) / Number(effectiveKpis.in_field_amount || 0)) * 100) : 0}
                      className="h-1.5"
                    />
                    <p className="text-[11px] text-muted-foreground">{formatUGX(Number(effectiveKpis.in_field_repaid || 0))} repaid</p>
                  </div>
                </CardContent>
              </Card>

              <Card
                role="button"
                tabIndex={0}
                onClick={() => setDrill('repaid')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDrill('repaid'); } }}
                className="relative overflow-hidden cursor-pointer transition hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Repaid</p>
                      <p className="text-lg font-bold tabular-nums">{formatUGX(Number(effectiveKpis.in_field_repaid || 0))}</p>
                    </div>
                    <div className="rounded-lg bg-success/10 p-2 text-success">
                      <Check className="h-4 w-4" />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {repaidRows.length} paying • {fullyPaidRows.length} fully paid
                  </p>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

      {/* KPI drill-down: every overview card opens the exact list behind its number. */}
      <Sheet open={drill !== null} onOpenChange={(o) => { if (!o) setDrill(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{drill ? DRILL_TITLES[drill] : ''}</SheetTitle>
            <SheetDescription>{drill ? DRILL_DESCRIPTIONS[drill] : ''}</SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-2">
            {drill === 'pending' ? (
              pendingApps.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nothing awaiting approval right now.</p>
              ) : (
                pendingApps.map((p) => (
                  <div key={p.sale_id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{p.full_name || 'Agent'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {[p.brand, p.model_type].filter(Boolean).join(' ') || p.item_name || '—'} • {p.quantity} pc(s)
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold tabular-nums">{formatUGX(Number(p.requested_amount || 0))}</p>
                      <p className="text-[11px] text-muted-foreground">{format(new Date(p.created_at), 'dd MMM yyyy')}</p>
                    </div>
                  </div>
                ))
              )
            ) : drillRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No records in this group yet.</p>
            ) : (
              drillRows.map((r) => (
                <div key={r.agent_id} className="rounded-xl border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{r.full_name || 'Agent'}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {(r.product_names || []).join(', ') || '—'}
                        {r.location_name ? ` • ${r.location_name}` : ''}
                      </p>
                    </div>
                    <Badge variant={Number(r.outstanding_amount || 0) <= 0 ? 'secondary' : 'outline'} className="shrink-0 text-[10px]">
                      {Number(r.outstanding_amount || 0) <= 0 ? 'Fully paid' : 'Repaying'}
                    </Badge>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                    <span className="text-muted-foreground">Issued<br /><b className="text-foreground tabular-nums">{formatUGX(Number(r.held_amount || 0))}</b></span>
                    <span className="text-muted-foreground">Repaid<br /><b className="text-success tabular-nums">{formatUGX(Number(r.repaid_amount || 0))}</b></span>
                    <span className="text-muted-foreground">Outstanding<br /><b className="text-foreground tabular-nums">{formatUGX(Number(r.outstanding_amount || 0))}</b></span>
                  </div>
                </div>
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>


      {showApplications && (
        <Card className="min-w-0">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-500" />
              Pending applications
              <Badge variant="secondary" className="text-[10px]">{filteredPending.length}</Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading && pendingApps.length === 0 ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            ) : filteredPending.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">
                {pendingApps.length === 0
                  ? 'Nothing awaiting approval right now.'
                  : 'No application matches your search or item filter.'}
              </p>
            ) : (
              <div className="divide-y divide-border">{filteredPending.map(renderPendingRow)}</div>
            )}

          </CardContent>
        </Card>
      )}

      {showOverview && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Pending applications quick-action queue */}
          <Card className="lg:col-span-2 min-w-0">
            <CardHeader className="pb-2 flex-row items-center justify-between space-y-0">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Clock className="h-4 w-4 text-amber-500" />
                Pending applications
                <Badge variant="secondary" className="text-[10px]">{pendingApps.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading && pendingApps.length === 0 ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : pendingApps.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground text-center">Nothing awaiting approval right now.</p>
              ) : (
                <div className="divide-y divide-border">{pendingApps.slice(0, 10).map(renderPendingRow)}</div>
              )}
            </CardContent>
          </Card>


          {/* Catalog & brand inventory breakdown */}
          <Card className="min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Layers className="h-4 w-4 text-primary" />
                {isSmartphone ? 'Brand inventory' : 'Catalog inventory'}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading && breakdown.length === 0 ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : breakdown.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground text-center">No catalog items yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {breakdown.map((b) => (
                    <div key={b.label} className="p-3 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-semibold truncate">{b.label}</p>
                        <span className="text-xs font-medium tabular-nums">{Number(b.issued_qty || 0)} issued</span>
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                        {isSmartphone && <span>{Number(b.models || 0)} model(s)</span>}
                        <span>Ref: {formatUGX(Number(b.reference_price || 0))}</span>
                        <span>Value: {formatUGX(Number(b.issued_value || 0))}</span>
                        <span className="text-destructive">Out: {formatUGX(Number(b.outstanding || 0))}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Recent field devices activity feed */}
          <Card className="lg:col-span-3 min-w-0">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Activity className="h-4 w-4 text-info" />
                Recent field activity
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading && activity.length === 0 ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
                </div>
              ) : activity.length === 0 ? (
                <p className="p-6 text-sm text-muted-foreground text-center">No activity recorded yet.</p>
              ) : (
                <div className="divide-y divide-border">
                  {activity.slice(0, 10).map((a) => (
                    <div key={a.sale_id} className="p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <UserAvatar avatarUrl={a.avatar_url} fullName={a.full_name || undefined} size="sm" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold truncate">{a.full_name || 'Unknown agent'}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {[a.brand, a.model_type].filter(Boolean).join(' ') || a.item_name || '—'}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between sm:justify-end gap-2 pl-11 sm:pl-0 sm:shrink-0">
                        <div className="sm:text-right">
                          <p className="text-sm font-semibold tabular-nums">{formatUGX(Number(a.amount || 0))}</p>
                          <p className="text-[10px] text-muted-foreground tabular-nums">
                            {a.happened_at ? format(new Date(a.happened_at), 'dd MMM yyyy HH:mm') : '—'}
                          </p>
                        </div>
                        <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                          {(a.order_status || '').replace(/_/g, ' ') || 'issued'}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---------- Pending application detail ---------- */}
      <Dialog open={!!appDetail} onOpenChange={(o) => { if (!o) { setAppDetail(null); setExpandedProfile(false); } }}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Application details</DialogTitle>
          </DialogHeader>
          {appDetail && (() => {
            const qty = Math.max(1, Number(appDetail.quantity || 1));
            const total = Number(appDetail.requested_amount || 0);
            const unit = total / qty;
            const item = [appDetail.brand, appDetail.model_type].filter(Boolean).join(' ') || appDetail.item_name || '—';
            const centre = (appDetail.agent_id && centreByAgent.get(appDetail.agent_id)) || 'No service center';
            const busy = approveApp.isPending || rejectApp.isPending;

            const catalogHit = (data?.catalog || []).find(
              (c) =>
                c.item_name?.toLowerCase() === (appDetail.item_name || '').toLowerCase() ||
                c.item_name?.toLowerCase() === ([appDetail.brand, appDetail.model_type].filter(Boolean).join(' ') || '').toLowerCase() ||
                (appDetail.item_name && c.item_name?.toLowerCase().includes(appDetail.item_name.toLowerCase()))
            );
            const unitCost = Number(modalAgentContext?.sale?.unit_cost || catalogHit?.unit_cost || 0);
            const totalCost = unitCost * qty;
            const expectedProfit = Math.max(0, total - totalCost);
            const profitMarginPct = total > 0 && totalCost > 0 ? (((total - totalCost) / total) * 100).toFixed(1) : (unitCost === 0 && total > 0 ? '100' : '0');

            const saleData = modalAgentContext?.sale;
            const paymentPeriodText = (() => {
              if (saleData?.access_daily_amount && saleData.access_daily_amount > 0) {
                return `Daily deduction · ${formatUGX(saleData.access_daily_amount)}/day (${saleData.access_repayment_days || '—'} days)`;
              }
              if (saleData?.advance_period_months) {
                return `${saleData.advance_period_months} month(s) repayment period`;
              }
              if (saleData?.payment_plan && saleData.payment_plan !== 'full_upfront') {
                return `${saleData.payment_plan.replace(/_/g, ' ')} plan`;
              }
              return 'Daily commission deduction plan';
            })();

            return (
              <div className="space-y-4">
                {/* Agent profile card - inline expansion */}
                <div className="rounded-xl border border-border bg-muted/30 p-3.5 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <UserAvatar avatarUrl={appDetail.avatar_url} fullName={appDetail.full_name || undefined} size="lg" />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold truncate text-foreground">{appDetail.full_name || 'Unknown agent'}</p>
                          {modalAgentContext?.is_active !== undefined && (
                            modalAgentContext.is_active ? (
                              <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20 font-medium py-0 h-4">
                                Active Agent
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20 font-medium py-0 h-4">
                                Inactive
                              </Badge>
                            )
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground mt-1">
                          {appDetail.phone ? (
                            <a href={`tel:${appDetail.phone}`} className="inline-flex items-center gap-1 hover:text-foreground font-medium">
                              <Phone className="h-3 w-3 text-primary" /> {appDetail.phone}
                            </a>
                          ) : (
                            <span>No phone on file</span>
                          )}
                          <span className="inline-flex items-center gap-1">
                            <MapPin className="h-3 w-3 text-muted-foreground" /> {centre}
                          </span>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
                          {modalAgentContext?.national_id ? (
                            <Badge variant="outline" className="text-[10px] font-mono bg-background text-foreground">
                              NIN: {modalAgentContext.national_id}
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-500/30">
                              No NIN
                            </Badge>
                          )}
                          <Badge variant="secondary" className="text-[10px] font-medium gap-1">
                            <Users className="h-3 w-3 text-primary" />
                            {modalAgentContext?.active_tenant_count ?? 0} active tenants
                          </Badge>
                        </div>
                      </div>
                    </div>
                    {appDetail.agent_id && (
                      <Button
                        size="sm"
                        variant={expandedProfile ? "secondary" : "outline"}
                        className="h-7 text-xs gap-1 shrink-0 hover:bg-background shadow-none"
                        onClick={() => setExpandedProfile((prev) => !prev)}
                      >
                        {expandedProfile ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        View profile
                      </Button>
                    )}
                  </div>

                  {/* Inline profile expansion (accordion) without leaving this modal */}
                  {expandedProfile && appDetail.agent_id && (
                    <AgentInlineProfileExpansion agentId={appDetail.agent_id} />
                  )}
                </div>

                {/* Order specs & Profitability metrics */}
                <div className="rounded-xl border border-border divide-y divide-border text-xs overflow-hidden">
                  <div className="flex items-center justify-between p-2.5">
                    <span className="text-muted-foreground">Requested item</span>
                    <span className="font-semibold text-foreground">{item}</span>
                  </div>
                  <div className="flex items-center justify-between p-2.5">
                    <span className="text-muted-foreground">Quantity & Unit price</span>
                    <span className="font-medium tabular-nums">{qty} × {formatUGX(unit)}</span>
                  </div>
                  <div className="flex items-center justify-between p-2.5 bg-muted/20">
                    <span className="font-medium text-foreground">Total order amount</span>
                    <span className="font-bold text-sm text-foreground tabular-nums">{formatUGX(total)}</span>
                  </div>
                  <div className="flex items-center justify-between p-2.5">
                    <span className="text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" /> Payment period
                    </span>
                    <span className="font-medium text-foreground">{paymentPeriodText}</span>
                  </div>
                  {unitCost > 0 && (
                    <div className="flex items-center justify-between p-2.5">
                      <span className="text-muted-foreground">Cost of goods (COGS)</span>
                      <span className="font-medium tabular-nums text-muted-foreground">
                        {qty} × {formatUGX(unitCost)} ({formatUGX(totalCost)})
                      </span>
                    </div>
                  )}
                  <div className="flex items-center justify-between p-2.5 bg-emerald-500/10 border-t border-emerald-500/20">
                    <div className="flex items-center gap-1.5">
                      <TrendingUp className="h-4 w-4 text-emerald-600" />
                      <span className="font-semibold text-emerald-950 dark:text-emerald-200">Expected Returns (Profit)</span>
                    </div>
                    <div className="text-right">
                      <span className="font-bold text-sm text-emerald-600 tabular-nums">+{formatUGX(expectedProfit)}</span>
                      {profitMarginPct !== '0' && (
                        <span className="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400 ml-1.5">
                          ({profitMarginPct}% margin)
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-2.5 text-muted-foreground">
                    <span>Request date</span>
                    <span className="font-medium">
                      {appDetail.created_at ? format(new Date(appDetail.created_at), 'dd MMM yyyy HH:mm') : '—'}
                    </span>
                  </div>
                </div>

                {canDecide ? (
                  <DialogFooter className="gap-2 sm:gap-2 pt-1">
                    <Button
                      variant="outline"
                      className="gap-1.5 text-destructive hover:text-destructive flex-1 sm:flex-none"
                      disabled={busy}
                      onClick={() => { setRejectTarget(appDetail); setRejectReason(""); setAppDetail(null); }}
                    >
                      <X className="h-4 w-4" /> Reject
                    </Button>
                    <Button className="gap-1.5 flex-1 sm:flex-none" disabled={busy} onClick={() => approveApp.mutate(appDetail)}>
                      {approveApp.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                      Approve
                    </Button>
                  </DialogFooter>
                ) : (
                  <p className="text-xs text-muted-foreground">This category is reviewed elsewhere.</p>
                )}
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>


      <Dialog open={!!rejectTarget} onOpenChange={(o) => { if (!o) { setRejectTarget(null); setRejectReason(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject application</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {rejectTarget && (() => {
              const qty = Math.max(1, Number(rejectTarget.quantity || 1));
              const total = Number(rejectTarget.requested_amount || 0);
              const unit = total / qty;
              const item = [rejectTarget.brand, rejectTarget.model_type].filter(Boolean).join(' ') || rejectTarget.item_name || '—';
              const centre = (rejectTarget.agent_id && centreByAgent.get(rejectTarget.agent_id)) || 'No service center';
              const ctx = modalAgentContext;
              return (
                <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-3">
                  {/* Agent profile */}
                  <div className="flex items-start gap-3">
                    <UserAvatar avatarUrl={rejectTarget.avatar_url} fullName={rejectTarget.full_name || undefined} size="md" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold truncate">{rejectTarget.full_name || 'Unknown agent'}</p>
                        {ctx?.is_active !== undefined && (
                          ctx.is_active ? (
                            <Badge variant="outline" className="text-[10px] bg-emerald-500/10 text-emerald-600 border-emerald-500/20 font-medium py-0 h-4">
                              Active Agent
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px] bg-amber-500/10 text-amber-600 border-amber-500/20 font-medium py-0 h-4">
                              Inactive
                            </Badge>
                          )
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{ctx?.phone || rejectTarget.phone || 'No phone on file'}</p>
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <Badge variant="secondary" className="text-[10px]">{centre}</Badge>
                        {ctx?.national_id ? (
                          <Badge variant="outline" className="text-[10px] font-mono">NIN: {ctx.national_id}</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-[10px]">No NIN</Badge>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">Active tenants</p>
                      <p className="text-lg font-bold tabular-nums">{ctx?.active_tenant_count ?? '—'}</p>
                    </div>
                  </div>
                  {/* Application details */}
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <div className="col-span-2">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Requested item</p>
                      <p className="font-medium truncate">{item}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Quantity</p>
                      <p className="font-medium tabular-nums">{qty}</p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Unit price</p>
                      <p className="font-medium tabular-nums">{formatUGX(unit)}</p>
                    </div>
                    <div className="col-span-2">
                      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Total amount</p>
                      <p className="font-semibold tabular-nums">{formatUGX(total)}</p>
                    </div>
                  </div>
                </div>
              );
            })()}

            <p className="text-sm text-muted-foreground">
              Rejecting {rejectTarget?.full_name || 'this agent'}'s request applies no wallet charge.
            </p>
            <div className="space-y-1.5">
              <Label>Reason (min 10 characters)</Label>
              <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Why is this rejected?" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={rejectReason.trim().length < 10 || rejectApp.isPending}
              onClick={() => rejectTarget && rejectApp.mutate({ row: rejectTarget, reason: rejectReason })}
            >
              {rejectApp.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>




      {showIssued && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">
              {showCompleted
                ? `${scopeLabel ?? 'Products'} fully repaid`
                : scopeLabel ? `${scopeLabel} in the field` : 'Products in the field'} ({rows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : rows.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">
                {showCompleted
                  ? 'No agents have fully cleared their balance yet.'
                  : category === 'motor_bike'
                  ? 'No company fleet bikes assigned yet. Use “Assign company bike” to assign one.'
                  : scopeLabel
                  ? `No ${scopeLabel.toLowerCase()} with an outstanding balance. Use “New entry” to record one.`
                  : 'No products with an outstanding balance. Use “New entry” to record one.'}
              </p>
            ) : (
              <div className="divide-y divide-border">
                {rows.map((r) => (
                  <div
                    key={r.agent_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailAgentId(r.agent_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDetailAgentId(r.agent_id); }
                    }}
                    className="p-3 flex items-start gap-3 cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <UserAvatar avatarUrl={r.avatar_url} fullName={r.full_name || undefined} size="md" />
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-semibold text-sm truncate">{r.full_name || r.agent_id.slice(0, 8)}</p>
                        <Badge variant="secondary" className="text-[10px]">{r.location_name || 'No center'}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {(r.product_names || []).join(', ') || '—'} · {r.items_held} item(s)
                      </p>
                      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                        <span>Held: <span className="font-semibold tabular-nums">{formatUGX(Number(r.held_amount || 0))}</span></span>
                        <span className="text-success">Repaid: <span className="font-semibold tabular-nums">{formatUGX(Number(r.repaid_amount || 0))}</span></span>
                        <span className="text-destructive">Outstanding: <span className="font-semibold tabular-nums">{formatUGX(Number(r.outstanding_amount || 0))}</span></span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <div className="text-[11px] text-muted-foreground">
                        {r.last_issued_on ? format(new Date(`${String(r.last_issued_on).slice(0, 10)}T00:00:00`), 'dd MMM yyyy') : '—'}
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 text-destructive hover:text-destructive"
                        onClick={() => { setDeleteTarget(r); setDeleteReason(''); }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete issued records</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              This permanently removes {scopeLabel ? scopeLabel.toLowerCase() : 'product'} records issued to{' '}
              <span className="font-semibold text-foreground">{deleteTarget?.full_name || 'this agent'}</span>, including
              their recovery plans. This cannot be undone.
            </p>
            <div className="space-y-1.5">
              <Label>Reason (min 10 characters)</Label>
              <Input
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="Why is this record being deleted?"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={deleteReason.trim().length < 10 || deleteHolding.isPending}
              onClick={() => deleteHolding.mutate()}
            >
              {deleteHolding.isPending ? 'Deleting…' : 'Delete records'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AgentProductDetailDialog
        agentId={detailAgentId}
        category={category}
        onClose={() => setDetailAgentId(null)}
      />
    </div>

  );
}

interface SmartphoneCatalogItem {
  id: string;
  brand: string;
  model_name: string;
  default_amount: number;
}

function IssueProductDialog({
  catalog, centres, onDone, category,
}: { catalog: CatalogItem[]; centres: CentreItem[]; onDone: () => void; category?: AgentProductCategory }) {
  const isSmartphone = category === 'smart_phone';
  const isMotorBike = category === 'motor_bike';
  const [agentTerm, setAgentTerm] = useState('');
  const [agent, setAgent] = useState<{ id: string; full_name: string } | null>(null);
  const [itemName, setItemName] = useState(isMotorBike ? FLEET_BIKE_OPTION : '');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [centreId, setCentreId] = useState<string>('none');
  const [plan, setPlan] = useState<'installment' | 'full'>('installment');
  const [amountPaid, setAmountPaid] = useState('0');
  const [notes, setNotes] = useState('');
  const [fleetModel, setFleetModel] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [serialNumber, setSerialNumber] = useState('');


  const { data: agents } = useQuery({
    queryKey: ['agent-products-agent-search', agentTerm],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ops_search_transfer_agents', { p_term: agentTerm, p_limit: 10 });
      if (error) throw error;
      return data ?? [];
    },
    enabled: agentTerm.trim().length >= 2,
    staleTime: 30_000,
  });

  const { data: phoneCatalog } = useQuery({
    queryKey: ['smartphone-catalog-active'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('smartphone_catalog')
        .select('id,brand,model_name,default_amount')
        .eq('is_active', true)
        .order('brand', { ascending: true })
        .order('model_name', { ascending: true });
      if (error) throw error;
      return (data ?? []) as SmartphoneCatalogItem[];
    },
    enabled: isSmartphone,
    staleTime: 60_000,
  });

  const productOptions = useMemo(() => {
    if (isMotorBike) {
      return [FLEET_BIKE_OPTION];
    }
    if (isSmartphone && phoneCatalog) {
      return phoneCatalog.map((p) => `${p.brand} ${p.model_name}`);
    }
    const names = new Set<string>(category ? CATEGORY_SUGGESTIONS[category] : PRODUCT_SUGGESTIONS);
    catalog.forEach((c) => names.add(c.item_name));
    const list = Array.from(names).sort();
    // Company-owned bikes are assigned, never sold — offered on bike/full scopes only.
    if (!category) list.push(FLEET_BIKE_OPTION);
    return list;
  }, [catalog, category, phoneCatalog, isSmartphone, isMotorBike]);

  /** Company fleet bike: assignment only, no price, no wallet recovery. */
  const isFleetBike = isMotorBike || itemName === FLEET_BIKE_OPTION;

  // Smartphones are issued at cost + 33% markup (Access Amount). Other products keep the legacy markup UI.
  const INTEREST_RATE = 0.33;
  const baseValue = (Number(quantity) || 0) * (Number(unitPrice) || 0);
  const interestAmount = isSmartphone || isFleetBike ? 0 : Math.round(baseValue * INTEREST_RATE);
  const total = isFleetBike ? 0 : isSmartphone ? baseValue : baseValue + interestAmount;
  const outstanding = isFleetBike
    ? 0
    : isSmartphone
      ? total
      : Math.max(total - (plan === 'full' ? total : Number(amountPaid) || 0), 0);

  // Smartphones and Welile Bikes recover at a fixed 33% rate from the agent wallet.
  const isFixedRecoveryProduct = useMemo(() => {
    if (isFleetBike) return false;
    if (isSmartphone) return true;
    const name = itemName.trim().toLowerCase();
    if (!name) return false;
    return name.includes('phone') || name.includes('bike');
  }, [itemName, isSmartphone, isFleetBike]);
  const recoveryRate = isFixedRecoveryProduct ? 0.33 : null;

  const mutation = useMutation({
    mutationFn: async () => {
      if (isFleetBike) {
        const { data, error } = await supabase.rpc('agent_ops_assign_company_fleet_bike' as any, {
          p_agent_id: agent!.id,
          p_item_name: fleetModel.trim() || 'Company Fleet Bike',
          p_plate_number: plateNumber.trim() || null,
          p_serial_number: serialNumber.trim() || null,
          p_service_centre_id: centreId === 'none' ? null : centreId,
          p_notes: notes || null,
        });
        if (error) throw error;
        return data;
      }
      const { data, error } = await supabase.rpc('agent_ops_issue_agent_product' as any, {
        p_agent_id: agent!.id,
        p_item_name: itemName,
        p_quantity: Number(quantity),
        p_unit_price: (Number(quantity) || 1) > 0 ? total / (Number(quantity) || 1) : 0,
        p_unit_cost: Number(unitCost) || 0,
        p_service_centre_id: isSmartphone ? null : (centreId === 'none' ? null : centreId),
        p_payment_plan: isSmartphone ? 'installment' : plan,
        p_amount_paid: isSmartphone ? 0 : (plan === 'full' ? total : Number(amountPaid) || 0),
        p_notes: notes || null,
        p_recovery_rate: recoveryRate,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success(
        isFleetBike
          ? 'Company bike assigned. It is recorded on the agent profile with no wallet recovery.'
          : 'Product entry recorded. Repayment plan created automatically.',
      );
      onDone();
    },
    onError: (e: any) => toast.error(e?.message || 'Could not record the entry'),
  });

  const valid = isFleetBike
    ? !!agent
    : agent && itemName && Number(quantity) > 0 && Number(unitPrice) > 0;


  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{isMotorBike ? 'Assign company bike to agent' : 'Issue product to agent'}</DialogTitle>
        <DialogDescription>
          {isMotorBike
            ? 'Assign an operational company-owned motorbike to an agent. Commercial bike leases are processed through Bike Lease Applications.'
            : 'Issue merchandise or products to an agent with optional repayment terms.'}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label>Agent</Label>
          {agent ? (
            <div className="flex items-center justify-between rounded-lg border border-border p-2">
              <span className="text-sm font-medium">{agent.full_name}</span>
              <Button variant="ghost" size="sm" onClick={() => setAgent(null)}>Change</Button>
            </div>
          ) : (
            <>
              <Input value={agentTerm} onChange={(e) => setAgentTerm(e.target.value)} placeholder="Search agent name or phone" />
              {(agents ?? []).length > 0 && (
                <div className="rounded-lg border border-border divide-y divide-border max-h-40 overflow-y-auto">
                  {(agents as any[]).map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setAgent({ id: a.id, full_name: a.full_name || a.phone || a.id })}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted"
                    >
                      {a.full_name || 'Unnamed'} · {a.phone || '—'}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        {isMotorBike ? (
          <div className="space-y-1.5">
            <Label>Product entry</Label>
            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
              <div className="space-y-0.5">
                <span className="font-semibold text-foreground">Company Fleet Bike</span>
                <span className="block text-xs text-muted-foreground">Operational assignment only · No wallet deductions or lease markup</span>
              </div>
              <Badge variant="secondary" className="text-[11px]">Company Asset</Badge>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <Label>Product</Label>
            <Select
              value={itemName}
              onValueChange={(v) => {
                setItemName(v);
                if (isSmartphone) {
                  const hit = phoneCatalog?.find((p) => `${p.brand} ${p.model_name}` === v);
                  if (hit) {
                    const accessAmount = Math.round(Number(hit.default_amount || 0) * 1.33);
                    setUnitCost(String(hit.default_amount ?? ''));
                    setUnitPrice(String(accessAmount));
                  }
                } else {
                  const hit = catalog.find((c) => c.item_name === v);
                  if (hit) {
                    setUnitPrice(String(hit.unit_price ?? ''));
                    setUnitCost(String(hit.unit_cost ?? ''));
                  }
                }
              }}
            >
              <SelectTrigger><SelectValue placeholder="Select product" /></SelectTrigger>
              <SelectContent>
                {productOptions.map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}

        {isFleetBike && (
          <div className="space-y-3 rounded-lg border border-border p-3 bg-muted/20">
            <div className="space-y-1.5">
              <Label>Bike model / description</Label>
              <Input
                value={fleetModel}
                onChange={(e) => setFleetModel(e.target.value)}
                placeholder="e.g. Spiro Commando, Spiro Ekoride, Mocoo"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label>Plate / registration</Label>
                <Input value={plateNumber} onChange={(e) => setPlateNumber(e.target.value)} placeholder="e.g. ULE 123X (optional)" />
              </div>
              <div className="space-y-1.5">
                <Label>Serial / chassis number</Label>
                <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="e.g. CHS-98214 (optional)" />
              </div>
            </div>
          </div>
        )}

        {!isFleetBike && (
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <Label>Quantity</Label>
              <Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Unit price</Label>
              <Input type="number" min="0" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Unit cost</Label>
              <Input type="number" min="0" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} />
            </div>
          </div>
        )}

        {!isSmartphone && (
          <div className="space-y-1.5">
            <Label>{isFleetBike ? 'Service center (optional)' : 'Service center'}</Label>
            <Select value={centreId} onValueChange={setCentreId}>
              <SelectTrigger><SelectValue placeholder="Select service center" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No center</SelectItem>
                {centres.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.location_name || 'Unnamed'} · {c.agent_name || '—'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        {!isSmartphone && !isFleetBike && (
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label>Payment</Label>
              <Select value={plan} onValueChange={(v) => setPlan(v as 'installment' | 'full')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="installment">Installments (wallet recovery)</SelectItem>
                  <SelectItem value="full">Paid in full</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Paid upfront</Label>
              <Input
                type="number"
                min="0"
                value={plan === 'full' ? String(total) : amountPaid}
                disabled={plan === 'full'}
                onChange={(e) => setAmountPaid(e.target.value)}
              />
            </div>
          </div>
        )}

        <div className="space-y-1.5">
          <Label>{isFleetBike ? 'Notes (optional)' : 'Notes'}</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={isFleetBike ? 'e.g. Operational field route assignment' : 'Optional'} />
        </div>

        {isFleetBike ? (
          <div className="rounded-lg bg-muted p-3 text-sm space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-medium">Recovery from wallet</span>
              <span className="font-bold tabular-nums text-lg">{formatUGX(0)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Company fleet bikes are assigned, not sold. No value is charged and no wallet deductions are made — the
              bike is recorded on the agent profile for operational tracking only.
            </p>
            <Badge variant="secondary" className="text-[11px]">Company asset · Assigned</Badge>
          </div>
        ) : isSmartphone ? (

          <div className="rounded-lg bg-muted p-3 text-sm space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-medium">Access Amount (UGX)</span>
              <span className="font-bold tabular-nums text-lg">{formatUGX(total)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Final amount = cost price × 1.33, recovered from the agent wallet.
            </p>
            {recoveryRate !== null && (
              <div className="flex items-center justify-between pt-1">
                <span>Recovery rule</span>
                <Badge variant="secondary" className="text-[11px]">Recovery Rate: 33%</Badge>
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-lg bg-muted p-3 text-sm space-y-1">
            <div className="flex justify-between"><span>Base price</span><span className="tabular-nums">{formatUGX(baseValue)}</span></div>
            <div className="flex items-center justify-between">
              <span>Interest (33%)</span>
              <span className="tabular-nums">{formatUGX(interestAmount)}</span>
            </div>
            <div className="flex justify-between">
              <span>Total value</span>
              <span className="font-semibold tabular-nums">{formatUGX(total)}</span>
            </div>
            <div className="flex justify-between">
              <span>To recover from wallet</span>
              <span className="font-semibold tabular-nums">{formatUGX(outstanding)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Total value = base price + 33% interest. Wallet recovery is total value less any amount paid upfront.
            </p>
            {recoveryRate !== null && (
              <div className="flex items-center justify-between pt-1">
                <span>Recovery rule</span>
                <Badge variant="secondary" className="text-[11px]">Recovery Rate: 33%</Badge>
              </div>
            )}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending} className="w-full">
          {mutation.isPending ? (isFleetBike ? 'Assigning…' : 'Recording…') : isFleetBike ? 'Assign company bike' : 'Record entry'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}