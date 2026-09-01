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
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { UserAvatar } from '@/components/UserAvatar';
import { AgentProductDetailDialog } from './AgentProductDetailDialog';
import { formatUGX } from '@/lib/rentCalculations';
import { generateAgentProductsInFieldPdf, type AgentProductKpis, type AgentProductRow } from '@/lib/agentProductsInFieldPdf';
import { archivePdfBlob } from '@/lib/pdfVault';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Package, Users, Warehouse, Download, Plus, RefreshCw, Search, Wallet, TrendingUp, Trash2, Clock, Layers, Activity, Check, X, Loader2 } from 'lucide-react';

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

export type AgentProductCategory = 'motor_bike' | 'smart_phone' | 'signage' | 'boutique';

const CATEGORY_LABELS: Record<AgentProductCategory, string> = {
  motor_bike: 'Motor bikes',
  smart_phone: 'Smart phones',
  signage: 'Signages',
  boutique: 'Boutique',
};

const CATEGORY_SUGGESTIONS: Record<AgentProductCategory, string[]> = {
  motor_bike: ['Welile Spiro Bike'],
  smart_phone: ['Welile Smartphone'],
  signage: ['Signage (Shop Board)', 'Banner / Poster'],
  boutique: ['Welile Jumper', 'Welile Jacket', 'Welile Polo', 'Welile T-Shirt', 'Welile Cap', 'Company ID', 'Umbrella', 'Branded Bag'],
};

export function AgentProductsPanel({ category, mode = 'full' }: { category?: AgentProductCategory; mode?: 'overview' | 'issued' | 'applications' | 'completed' | 'full' } = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [itemFilter, setItemFilter] = useState('all');
  const [detailAgentId, setDetailAgentId] = useState<string | null>(null);
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
      });
      if (error) throw error;
      return (data ?? {}) as { deleted_sales?: number; deleted_plans?: number; deleted_deductions?: number };
    },
    onSuccess: (result) => {
      const sales = Number(result?.deleted_sales ?? 0);
      const plans = Number(result?.deleted_plans ?? 0);
      const deductions = Number(result?.deleted_deductions ?? 0);
      if (sales === 0 && plans === 0 && deductions === 0) {
        toast.warning('No records were deleted');
      } else {
        toast.success(`Deleted ${sales} sale(s), ${plans} plan(s), ${deductions} deduction(s)`);
      }
      setDeleteTarget(null);
      setDeleteReason('');
      queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
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

  const approveApp = useMutation({
    mutationFn: async (row: PendingApp) => {
      if (isBoutique) {
        const { error } = await supabase
          .from('merchandise_sales')
          .update({ order_status: 'processing' })
          .eq('id', row.sale_id);
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
        (isBoutique ? 'reject_merchandise_purchase' : 'reject_smartphone_order') as any,
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



  const kpis = data?.kpis as AgentProductKpis | undefined;
  const pendingApps = data?.pending ?? [];
  const breakdown = data?.breakdown ?? [];
  const activity = data?.activity ?? [];
  const isSmartphone = category === 'smart_phone';

  const rows = useMemo(() => {
    const list = data?.rows ?? [];

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
  }, [data?.rows, search, itemFilter, showCompleted, mode]);

  /** Service centre per agent, taken from the already-loaded issued rows — no extra round trip. */
  const centreByAgent = useMemo(() => {
    const map = new Map<string, string>();
    (data?.rows ?? []).forEach((r) => {
      if (r.agent_id && r.location_name) map.set(r.agent_id, r.location_name);
    });
    (data?.centres ?? []).forEach((c) => {
      if (c.agent_id && c.location_name && !map.has(c.agent_id)) map.set(c.agent_id, c.location_name);
    });
    return map;
  }, [data?.rows, data?.centres]);

  /** Item names offered in the dropdown — drawn from what actually exists in this category. */
  const itemOptions = useMemo(() => {
    const names = new Set<string>();
    breakdown.forEach((b) => b.label && names.add(b.label));
    pendingApps.forEach((p) => p.item_name && names.add(p.item_name));
    (data?.rows ?? []).forEach((r) => (r.product_names || []).forEach((n) => n && names.add(n)));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [breakdown, pendingApps, data?.rows]);

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
    if (!kpis) return;
    const { data: auth } = await supabase.auth.getUser();
    const actor = auth.user?.email || 'Agent Operations';
    const blob = generateAgentProductsInFieldPdf({ kpis, rows, actor });
    const filename = `Agent_Products_In_Field_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
    archivePdfBlob(blob, { label: 'Agent Products & Services', filename, category: 'other' }).catch(() => {});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const canDecide = isSmartphone || isBoutique;

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
        className="p-3 flex flex-wrap items-center gap-3 cursor-pointer hover:bg-muted/50 transition-colors"
      >
        <UserAvatar avatarUrl={p.avatar_url} fullName={p.full_name || undefined} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold truncate">{p.full_name || 'Unknown agent'}</p>
          <p className="text-xs text-muted-foreground truncate">
            {[p.brand, p.model_type].filter(Boolean).join(' ') || p.item_name || '—'}
            {p.quantity > 1 ? ` × ${p.quantity}` : ''} · {formatUGX(Number(p.requested_amount || 0))}
            {p.phone ? ` · ${p.phone}` : ''}
          </p>
        </div>
        <span className="hidden sm:block text-[11px] text-muted-foreground shrink-0">
          {p.created_at ? format(new Date(p.created_at), 'dd MMM') : '—'}
        </span>

        {canDecide ? (
          <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>

            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-success"
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
              className="h-7 gap-1 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => { setRejectTarget(p); setRejectReason(''); }}
            >
              <X className="h-3.5 w-3.5" />
              Reject
            </Button>
          </div>
        ) : (
          <Badge variant="outline" className="text-[10px] shrink-0">Awaiting review</Badge>
        )}
      </div>
    );
  };



  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {scopeLabel && <Badge variant="secondary" className="text-[11px]">{scopeLabel}</Badge>}
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

        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
          <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          Refresh
        </Button>
        <Button variant="outline" size="sm" onClick={exportPdf} disabled={!kpis} className="gap-1.5">
          <Download className="h-4 w-4" />
          Export PDF
        </Button>
        {showIssued && (
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5">
                <Plus className="h-4 w-4" />
                New entry
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {isLoading || !kpis ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[110px] rounded-2xl" />)
          ) : (
            <>
              <Card className="relative overflow-hidden">
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

              <Card className="relative overflow-hidden">
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Active Field Fleet</p>
                      <p className="text-2xl font-bold tabular-nums">{kpis.in_field_agents ?? 0}</p>
                    </div>
                    <div className="rounded-lg bg-warning/10 p-2 text-warning">
                      <Users className="h-4 w-4" />
                    </div>
                  </div>
                  <p className="text-[11px] text-muted-foreground">{kpis.in_field_items ?? 0} item(s) issued</p>
                </CardContent>
              </Card>

              <Card className="relative overflow-hidden">
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Financial Portfolio</p>
                      <p className="text-lg font-bold tabular-nums">{formatUGX(Number(kpis.in_field_outstanding || 0))}</p>
                    </div>
                    <div className="rounded-lg bg-success/10 p-2 text-success">
                      <Wallet className="h-4 w-4" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">Outstanding</span>
                      <span className="font-medium">{formatUGX(Number(kpis.in_field_amount || 0))} total</span>
                    </div>
                    <Progress
                      value={Number(kpis.in_field_amount || 0) > 0 ? Math.round(((Number(kpis.in_field_amount || 0) - Number(kpis.in_field_outstanding || 0)) / Number(kpis.in_field_amount || 0)) * 100) : 0}
                      className="h-1.5"
                    />
                  </div>
                </CardContent>
              </Card>

              <Card className="relative overflow-hidden">
                <CardContent className="p-3 flex flex-col justify-between h-full">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Repayment Recovery Rate</p>
                      <p className="text-2xl font-bold tabular-nums">
                        {Number(kpis.in_field_amount || 0) > 0 ? Math.round((Number(kpis.in_field_repaid || 0) / Number(kpis.in_field_amount || 0)) * 100) : 0}%
                      </p>
                    </div>
                    <div className="rounded-lg bg-info/10 p-2 text-info">
                      <TrendingUp className="h-4 w-4" />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Progress
                      value={Number(kpis.in_field_amount || 0) > 0 ? Math.round((Number(kpis.in_field_repaid || 0) / Number(kpis.in_field_amount || 0)) * 100) : 0}
                      className="h-1.5"
                    />
                    <p className="text-[11px] text-muted-foreground">{formatUGX(Number(kpis.in_field_repaid || 0))} repaid</p>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      )}

      {showApplications && (
        <Card>
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
          <Card className="lg:col-span-2">
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
          <Card>
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
          <Card className="lg:col-span-3">
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
                    <div key={a.sale_id} className="p-3 flex items-center gap-3">
                      <UserAvatar avatarUrl={a.avatar_url} fullName={a.full_name || undefined} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold truncate">{a.full_name || 'Unknown agent'}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {[a.brand, a.model_type].filter(Boolean).join(' ') || a.item_name || '—'}
                        </p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className="text-sm font-semibold tabular-nums">{formatUGX(Number(a.amount || 0))}</p>
                        <p className="text-[11px] text-muted-foreground">
                          {a.happened_at ? format(new Date(a.happened_at), 'dd MMM yyyy HH:mm') : '—'}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-[10px] capitalize shrink-0">
                        {(a.order_status || '').replace(/_/g, ' ') || 'issued'}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* ---------- Pending application detail ---------- */}
      <Dialog open={!!appDetail} onOpenChange={(o) => { if (!o) setAppDetail(null); }}>
        <DialogContent className="max-w-lg">
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
            return (
              <div className="space-y-4">
                <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-3">
                  <UserAvatar avatarUrl={appDetail.avatar_url} fullName={appDetail.full_name || undefined} size="md" />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate">{appDetail.full_name || 'Unknown agent'}</p>
                    <p className="text-xs text-muted-foreground truncate">{appDetail.phone || 'No phone on file'}</p>
                    <Badge variant="secondary" className="mt-1 text-[10px]">{centre}</Badge>
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div className="col-span-2">
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Requested item</dt>
                    <dd className="font-medium">{item}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Quantity</dt>
                    <dd className="font-medium tabular-nums">{qty}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Unit price</dt>
                    <dd className="font-medium tabular-nums">{formatUGX(unit)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Total amount</dt>
                    <dd className="font-semibold tabular-nums">{formatUGX(total)}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Request date</dt>
                    <dd className="font-medium">
                      {appDetail.created_at ? format(new Date(appDetail.created_at), 'dd MMM yyyy HH:mm') : '—'}
                    </dd>
                  </div>
                </dl>

                {appDetail.agent_id && (
                  <Button
                    variant="link"
                    className="h-auto p-0 text-xs"
                    onClick={() => { const id = appDetail.agent_id!; setAppDetail(null); setDetailAgentId(id); }}
                  >
                    Open full agent profile
                  </Button>
                )}

                {canDecide ? (
                  <DialogFooter className="gap-2 sm:gap-2">
                    <Button
                      variant="outline"
                      className="gap-1.5 text-destructive hover:text-destructive"
                      disabled={busy}
                      onClick={() => { setRejectTarget(appDetail); setRejectReason(""); setAppDetail(null); }}
                    >
                      <X className="h-4 w-4" /> Reject
                    </Button>
                    <Button className="gap-1.5" disabled={busy} onClick={() => approveApp.mutate(appDetail)}>
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
          <div className="space-y-3">
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
              {scopeLabel ? `${scopeLabel} in the field` : 'Products in the field'} ({rows.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
              </div>
            ) : rows.length === 0 ? (
              <p className="p-6 text-sm text-muted-foreground text-center">
                {scopeLabel
                  ? `No ${scopeLabel.toLowerCase()} issued to agents yet. Use “New entry” to record one.`
                  : 'No products issued to agents yet. Use “New entry” to record one.'}
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
  const [agentTerm, setAgentTerm] = useState('');
  const [agent, setAgent] = useState<{ id: string; full_name: string } | null>(null);
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [centreId, setCentreId] = useState<string>('none');
  const [plan, setPlan] = useState<'installment' | 'full'>('installment');
  const [amountPaid, setAmountPaid] = useState('0');
  const [notes, setNotes] = useState('');

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
    if (isSmartphone && phoneCatalog) {
      return phoneCatalog.map((p) => `${p.brand} ${p.model_name}`);
    }
    const names = new Set<string>(category ? CATEGORY_SUGGESTIONS[category] : PRODUCT_SUGGESTIONS);
    catalog.forEach((c) => names.add(c.item_name));
    return Array.from(names).sort();
  }, [catalog, category, phoneCatalog, isSmartphone]);

  // Smartphones are issued at cost + 33% markup (Access Amount). Other products keep the legacy markup UI.
  const INTEREST_RATE = 0.33;
  const baseValue = (Number(quantity) || 0) * (Number(unitPrice) || 0);
  const interestAmount = isSmartphone ? 0 : Math.round(baseValue * INTEREST_RATE);
  const total = isSmartphone ? baseValue : baseValue + interestAmount;
  const outstanding = isSmartphone
    ? total
    : Math.max(total - (plan === 'full' ? total : Number(amountPaid) || 0), 0);

  // Smartphones and Welile Bikes recover at a fixed 33% rate from the agent wallet.
  const isFixedRecoveryProduct = useMemo(() => {
    if (isSmartphone) return true;
    const name = itemName.trim().toLowerCase();
    if (!name) return false;
    return name.includes('phone') || name.includes('bike');
  }, [itemName, isSmartphone]);
  const recoveryRate = isFixedRecoveryProduct ? 0.33 : null;

  const mutation = useMutation({
    mutationFn: async () => {
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
      toast.success('Product entry recorded. Repayment plan created automatically.');
      onDone();
    },
    onError: (e: any) => toast.error(e?.message || 'Could not record the entry'),
  });

  const valid = agent && itemName && Number(quantity) > 0 && Number(unitPrice) > 0;

  return (
    <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>Issue product to agent</DialogTitle>
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

        {!isSmartphone && (
          <div className="space-y-1.5">
            <Label>Service center</Label>
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

        {!isSmartphone && (
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
          <Label>Notes</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>

        {isSmartphone ? (
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
          {mutation.isPending ? 'Recording…' : 'Record entry'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}