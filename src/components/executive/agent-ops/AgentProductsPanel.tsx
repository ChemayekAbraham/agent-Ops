import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { UserAvatar } from '@/components/UserAvatar';
import { MetricCard } from '@/components/MetricCard';
import { formatUGX } from '@/lib/rentCalculations';
import { generateAgentProductsInFieldPdf, type AgentProductKpis, type AgentProductRow } from '@/lib/agentProductsInFieldPdf';
import { archivePdfBlob } from '@/lib/pdfVault';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Package, Users, Warehouse, Download, Plus, RefreshCw, Search } from 'lucide-react';

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
  const scopeLabel = category ? CATEGORY_LABELS[category] : null;
  const showOverview = mode !== 'issued';
  const showIssued = mode !== 'overview';


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
      };
    },
    staleTime: 60_000,
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
        <div className="grid grid-cols-3 gap-3">
          {isLoading || !kpis ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[110px] rounded-2xl" />)
          ) : (
            <>
              <MetricCard label={scopeLabel ? `${scopeLabel} in catalog` : 'Total products'} value={String(kpis.total_products ?? 0)} icon={Package} variant="primary" />
              <MetricCard
                label={`In field · ${kpis.in_field_agents ?? 0} agents`}
                value={String(kpis.in_field_items ?? 0)}
                icon={Users}
                variant="warning"
              />
              <MetricCard label="Purchased (in stock)" value={String(kpis.stock_qty ?? 0)} icon={Warehouse} variant="success" />
            </>
          )}
        </div>
      )}

      {showOverview && kpis && (
        <div className="grid grid-cols-3 gap-3">
          <Card><CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Held amount</p>
            <p className="text-base font-bold tabular-nums">{formatUGX(Number(kpis.in_field_amount || 0))}</p>
          </CardContent></Card>
          <Card><CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Repaid so far</p>
            <p className="text-base font-bold tabular-nums text-success">{formatUGX(Number(kpis.in_field_repaid || 0))}</p>
          </CardContent></Card>
          <Card><CardContent className="p-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Outstanding</p>
            <p className="text-base font-bold tabular-nums text-destructive">{formatUGX(Number(kpis.in_field_outstanding || 0))}</p>
          </CardContent></Card>
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
                    <div className="text-[11px] text-muted-foreground shrink-0">
                      {r.last_issued_on ? format(new Date(`${String(r.last_issued_on).slice(0, 10)}T00:00:00`), 'dd MMM yyyy') : '—'}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

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