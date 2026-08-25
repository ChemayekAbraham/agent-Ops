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
import { formatUGX } from '@/lib/rentCalculations';
import { generateAgentProductsInFieldPdf, type AgentProductKpis, type AgentProductRow } from '@/lib/agentProductsInFieldPdf';
import { archivePdfBlob } from '@/lib/pdfVault';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Package, Users, Warehouse, Download, Plus, RefreshCw, Search, Wallet, TrendingUp, Trash2 } from 'lucide-react';

interface CatalogItem { id: string; item_name: string; unit_price: number; unit_cost: number }
interface CentreItem { id: string; location_name: string | null; agent_id: string | null; agent_name: string | null; status: string }
interface Overview { kpis: AgentProductKpis; rows: AgentProductRow[]; catalog: CatalogItem[]; centres: CentreItem[] }

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

export function AgentProductsPanel({ category, mode = 'full' }: { category?: AgentProductCategory; mode?: 'overview' | 'issued' | 'full' } = {}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<AgentProductRow | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const scopeLabel = category ? CATEGORY_LABELS[category] : null;
  const showOverview = mode !== 'issued';
  const showIssued = mode !== 'overview';

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

  const approveApp = useMutation({
    mutationFn: async (row: PendingApp) => {
      const { error } = await supabase.rpc('approve_smartphone_order' as any, {
        p_sale_id: row.sale_id,
        p_total_amount: Math.round(Number(row.requested_amount || 0)),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Application approved');
      queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-queue'] });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-pending-count'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not approve application'),
  });

  const rejectApp = useMutation({
    mutationFn: async ({ row, reason }: { row: PendingApp; reason: string }) => {
      const { error } = await supabase.rpc('reject_smartphone_order' as any, {
        p_sale_id: row.sale_id,
        p_reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Application rejected');
      setRejectTarget(null);
      setRejectReason('');
      queryClient.invalidateQueries({ queryKey: ['agent-products-overview'], exact: false });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-queue'] });
      queryClient.invalidateQueries({ queryKey: ['smartphone-order-pending-count'] });
    },
    onError: (e: any) => toast.error(e?.message || 'Could not reject application'),
  });


  const kpis = data?.kpis as AgentProductKpis | undefined;
  const rows = useMemo(() => {
    const list = data?.rows ?? [];
    const term = search.trim().toLowerCase();
    if (!term) return list;
    return list.filter((r) =>
      (r.full_name || '').toLowerCase().includes(term) ||
      (r.location_name || '').toLowerCase().includes(term) ||
      (r.product_names || []).join(' ').toLowerCase().includes(term)
    );
  }, [data?.rows, search]);

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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {scopeLabel && <Badge variant="secondary" className="text-[11px]">{scopeLabel}</Badge>}
        {showIssued && (
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={scopeLabel ? `Search agent, location or ${scopeLabel.toLowerCase()}` : 'Search agent, location or product'}
              className="pl-8"
            />
          </div>
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
                      <p className="text-2xl font-bold tabular-nums">{kpis.pending_applications ?? 0}</p>
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
                  <div key={r.agent_id} className="p-3 flex items-start gap-3">
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
                    <div className="flex flex-col items-end gap-1 shrink-0">
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



    </div>
  );
}

function IssueProductDialog({
  catalog, centres, onDone, category,
}: { catalog: CatalogItem[]; centres: CentreItem[]; onDone: () => void; category?: AgentProductCategory }) {
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

  const productOptions = useMemo(() => {
    const names = new Set<string>(category ? CATEGORY_SUGGESTIONS[category] : PRODUCT_SUGGESTIONS);
    catalog.forEach((c) => names.add(c.item_name));
    return Array.from(names).sort();
  }, [catalog, category]);

  // Every issued product carries a 33% interest markup on the base price.
  const INTEREST_RATE = 0.33;
  const baseValue = (Number(quantity) || 0) * (Number(unitPrice) || 0);
  const interestAmount = Math.round(baseValue * INTEREST_RATE);
  const total = baseValue + interestAmount;
  const outstanding = Math.max(total - (plan === 'full' ? total : Number(amountPaid) || 0), 0);

  // Smartphones and Welile Bikes recover at a fixed 33% rate from the agent wallet.
  const isFixedRecoveryProduct = useMemo(() => {
    const name = itemName.trim().toLowerCase();
    if (!name) return false;
    return name.includes('phone') || name.includes('bike');
  }, [itemName]);
  const recoveryRate = isFixedRecoveryProduct ? 0.33 : null;



  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('agent_ops_issue_agent_product' as any, {
        p_agent_id: agent!.id,
        p_item_name: itemName,
        p_quantity: Number(quantity),
        p_unit_price: (Number(quantity) || 1) > 0 ? total / (Number(quantity) || 1) : 0,
        p_unit_cost: Number(unitCost) || 0,
        p_service_centre_id: centreId === 'none' ? null : centreId,
        p_payment_plan: plan,
        p_amount_paid: plan === 'full' ? total : Number(amountPaid) || 0,
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
              const hit = catalog.find((c) => c.item_name === v);
              if (hit) {
                setUnitPrice(String(hit.unit_price ?? ''));
                setUnitCost(String(hit.unit_cost ?? ''));
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

        <div className="space-y-1.5">
          <Label>Notes</Label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" />
        </div>

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


      </div>
      <DialogFooter>
        <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending} className="w-full">
          {mutation.isPending ? 'Recording…' : 'Record entry'}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}