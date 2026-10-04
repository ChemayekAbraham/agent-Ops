import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { KPICard } from './KPICard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import {
  Package, ShoppingCart, Boxes, TrendingUp, Wallet, Coins, Users, HandCoins,
  Plus, ArrowDownCircle, ArrowUpCircle, Trash2, Warehouse, Receipt,
  Repeat, CheckCircle2, CircleDollarSign, Store, ShoppingBag, Power,
  Upload, X, ChevronLeft, ChevronRight, ImageIcon,
  Pencil, BarChart3,
} from 'lucide-react';
import { StorageImage } from '@/components/ui/StorageImage';
import { optimizeImage } from '@/lib/imageOptimizer';
import { MerchandiseLiveOrders } from './MerchandiseLiveOrders';

// The merchandise tables are new; the generated Supabase types don't include
// them yet, so we reach them through an untyped client alias.
const db = supabase as any;

interface Purchase {
  id: string;
  item_name: string;
  quantity: number;
  unit_cost: number;
  total_cost: number;
  purchase_date: string;
  supplier: string | null;
  notes: string | null;
  buyer_name: string | null;
  buyer_phone: string | null;
  created_at: string;
}

interface Sale {
  id: string;
  item_name: string;
  quantity: number;
  unit_price: number;
  unit_cost: number;
  total_revenue: number;
  client_name: string | null;
  client_phone: string | null;
  payment_status: 'paid' | 'credit' | 'partial';
  amount_paid: number;
  amount_outstanding: number;
  sale_date: string;
  notes: string | null;
  created_at: string;
  order_status?: OrderStatus;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | null;
  customer_id?: string | null;
  payment_plan?: 'full' | 'installment' | null;
}

type OrderStatus = 'submitted' | 'processing' | 'completed' | 'failed' | 'rejected';

interface RecoveryPlan {
  id: string;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  item_name: string;
  original_amount: number;
  outstanding_balance: number;
  amount_recovered: number;
  daily_rate: number;
  status: 'active' | 'completed' | 'cancelled';
  last_recovery_at: string | null;
  created_at: string;
}

interface CatalogItem {
  id: string;
  item_name: string;
  description: string | null;
  unit_price: number;
  unit_cost: number;
  image_url: string | null;
  image_urls: string[] | null;
  is_active: boolean;
  created_at: string;
}

const num = (v: string) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const PAGE_SIZE = 10;

// Sanity thresholds. Anything above these is almost certainly a mis-typed
// order rather than a real one, so it is badged in the table and kept out of
// the financial roll-ups.
const OUTLIER_QTY = 20;
const OUTLIER_VALUE = 2_000_000;

const isVoidSale = (s: { order_status?: OrderStatus }) =>
  s.order_status === 'rejected' || s.order_status === 'failed';

const isOutlierSale = (s: { quantity: number; total_revenue: number }) =>
  Number(s.quantity) > OUTLIER_QTY || Number(s.total_revenue) > OUTLIER_VALUE;

function usePagination<T>(rows: T[], pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const slice = rows.slice((safePage - 1) * pageSize, safePage * pageSize);
  return { slice, page: safePage, totalPages, setPage, total: rows.length };
}

function Pager({ page, totalPages, setPage, total }: { page: number; totalPages: number; setPage: (n: number) => void; total: number }) {
  if (total <= PAGE_SIZE) return null;
  return (
    <div className="flex items-center justify-between px-1 pt-3 text-xs text-muted-foreground">
      <span>Page {page} of {totalPages} · {total.toLocaleString()} rows</span>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="sm" className="h-7 px-2" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

export function MerchandiseManager() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  // ---- Filters ----
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [productFilter, setProductFilter] = useState('all');
  const [clientFilter, setClientFilter] = useState('all');

  const { data: purchases = [], isLoading: loadingPurchases } = useQuery<Purchase[]>({
    queryKey: ['merchandise-purchases'],
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_purchases')
        .select('*')
        .order('purchase_date', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60000,
  });

  const { data: sales = [], isLoading: loadingSales } = useQuery<Sale[]>({
    queryKey: ['merchandise-sales'],
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select('*')
        .order('sale_date', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60000,
  });

  const { data: recoveryPlans = [], isLoading: loadingRecovery } = useQuery<RecoveryPlan[]>({
    queryKey: ['merchandise-recovery-plans'],
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_recovery_plans')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
    staleTime: 60000,
  });

  const { data: catalog = [], isLoading: loadingCatalog } = useQuery<CatalogItem[]>({
    queryKey: ['merchandise-catalog-admin'],
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_catalog')
        .select('*')
        .order('item_name');
      if (error) throw error;
      return data || [];
    },
    staleTime: 60000,
  });

  // ---- Product & client option lists (for filters + autocomplete) ----
  const productNames = useMemo(() => {
    const set = new Set<string>();
    purchases.forEach((p) => set.add(p.item_name));
    sales.forEach((s) => set.add(s.item_name));
    return Array.from(set).sort();
  }, [purchases, sales]);

  const clientNames = useMemo(() => {
    const set = new Set<string>();
    sales.forEach((s) => { if (s.client_name) set.add(s.client_name); });
    return Array.from(set).sort();
  }, [sales]);

  // ---- Apply filters ----
  const inRange = (dateStr: string) => {
    if (fromDate && dateStr < fromDate) return false;
    if (toDate && dateStr > toDate) return false;
    return true;
  };

  const filteredPurchases = useMemo(
    () => purchases.filter((p) =>
      inRange(p.purchase_date) &&
      (productFilter === 'all' || p.item_name === productFilter),
    ),
    [purchases, fromDate, toDate, productFilter],
  );

  const filteredSales = useMemo(
    () => sales.filter((s) =>
      inRange(s.sale_date) &&
      (productFilter === 'all' || s.item_name === productFilter) &&
      (clientFilter === 'all' || s.client_name === clientFilter),
    ),
    [sales, fromDate, toDate, productFilter, clientFilter],
  );

  // ---- Financial roll-ups ----
  // Cancelled/rejected orders and sanity-check outliers never count towards
  // revenue, stock, COGS or receivables — they only appear in the sales table.
  const countableSales = useMemo(
    () => filteredSales.filter((s) => !isVoidSale(s) && !isOutlierSale(s)),
    [filteredSales],
  );

  const totals = useMemo(() => {
    const totalInvested = filteredPurchases.reduce((s, p) => s + Number(p.total_cost), 0);
    const totalQtyPurchased = filteredPurchases.reduce((s, p) => s + Number(p.quantity), 0);
    const totalRevenue = countableSales.reduce((s, x) => s + Number(x.total_revenue), 0);
    const totalQtySold = countableSales.reduce((s, x) => s + Number(x.quantity), 0);
    const cogs = countableSales.reduce((s, x) => s + Number(x.unit_cost) * Number(x.quantity), 0);
    const grossProfit = totalRevenue - cogs;
    const outstanding = countableSales.reduce((s, x) => s + Number(x.amount_outstanding), 0);
    const currentStock = totalQtyPurchased - totalQtySold;

    // Weighted average unit cost across all purchases (for inventory valuation).
    const allInvested = purchases.reduce((s, p) => s + Number(p.total_cost), 0);
    const allQty = purchases.reduce((s, p) => s + Number(p.quantity), 0);
    const avgUnitCost = allQty > 0 ? allInvested / allQty : 0;
    const inventoryValue = Math.max(0, currentStock) * avgUnitCost;

    return {
      totalInvested, totalQtyPurchased, totalRevenue, totalQtySold,
      cogs, grossProfit, outstanding, currentStock, inventoryValue,
    };
  }, [filteredPurchases, countableSales, purchases]);

  // ---- Per-item inventory table ----
  const inventoryByItem = useMemo(() => {
    const map = new Map<string, { purchased: number; sold: number; invested: number; revenue: number }>();
    filteredPurchases.forEach((p) => {
      const e = map.get(p.item_name) || { purchased: 0, sold: 0, invested: 0, revenue: 0 };
      e.purchased += Number(p.quantity);
      e.invested += Number(p.total_cost);
      map.set(p.item_name, e);
    });
    countableSales.forEach((s) => {
      const e = map.get(s.item_name) || { purchased: 0, sold: 0, invested: 0, revenue: 0 };
      e.sold += Number(s.quantity);
      e.revenue += Number(s.total_revenue);
      map.set(s.item_name, e);
    });
    return Array.from(map.entries())
      .map(([item_name, e]) => ({ item_name, ...e, stock: e.purchased - e.sold }))
      .sort((a, b) => a.item_name.localeCompare(b.item_name));
  }, [filteredPurchases, countableSales]);

  // ---- Accounts receivable (clients who owe) ----
  const receivables = useMemo(() => {
    const map = new Map<string, { name: string; phone: string; outstanding: number; count: number }>();
    countableSales.forEach((s) => {
      if (Number(s.amount_outstanding) <= 0) return;
      const key = (s.client_phone || s.client_name || 'Unknown').trim();
      const e = map.get(key) || {
        name: s.client_name || 'Unknown',
        phone: s.client_phone || '',
        outstanding: 0,
        count: 0,
      };
      e.outstanding += Number(s.amount_outstanding);
      e.count += 1;
      map.set(key, e);
    });
    return Array.from(map.values()).sort((a, b) => b.outstanding - a.outstanding);
  }, [countableSales]);

  const clearFilters = () => {
    setFromDate(''); setToDate(''); setProductFilter('all'); setClientFilter('all');
  };

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['merchandise-purchases'] });
    queryClient.invalidateQueries({ queryKey: ['merchandise-sales'] });
    queryClient.invalidateQueries({ queryKey: ['merchandise-recovery-plans'] });
    queryClient.invalidateQueries({ queryKey: ['merchandise-catalog-admin'] });
  };

  // ---- Wallet-recovery roll-ups ----
  const recovery = useMemo(() => {
    const active = recoveryPlans.filter((p) => p.status === 'active');
    const completed = recoveryPlans.filter((p) => p.status === 'completed');
    const recoveredToDate = recoveryPlans.reduce((s, p) => s + Number(p.amount_recovered), 0);
    const remaining = active.reduce((s, p) => s + Number(p.outstanding_balance), 0);
    return { active, completed, recoveredToDate, remaining, count: active.length };
  }, [recoveryPlans]);

  const deletePurchase = async (id: string) => {
    const { error } = await db.from('merchandise_purchases').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    toast.success('Purchase removed');
    refresh();
  };

  const deleteSale = async (id: string) => {
    const { error } = await db.from('merchandise_sales').delete().eq('id', id);
    if (error) { toast.error(error.message); return; }
    toast.success('Sale removed');
    refresh();
  };

  const updateOrderStatus = async (id: string, status: OrderStatus) => {
    const { error } = await db.from('merchandise_sales').update({ order_status: status }).eq('id', id);
    if (error) { toast.error(error.message); return; }
    toast.success('Order status updated');
    queryClient.invalidateQueries({ queryKey: ['merchandise-sales'] });
  };

  const [rejectTarget, setRejectTarget] = useState<Sale | null>(null);

  // Pagination
  const catalogPage = usePagination(catalog);
  const salesPage = usePagination(filteredSales);
  const purchasesPage = usePagination(filteredPurchases);

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header + actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2">
            <Warehouse className="h-5 w-5 text-primary" /> Merchandise Management
          </h2>
          <p className="text-xs text-muted-foreground">
            Track branded merchandise purchases, sales, inventory and receivables.
          </p>
        </div>
        <div className="flex gap-2">
          <RecordPurchaseDialog userId={user?.id} productNames={productNames} onSaved={refresh} />
          <RecordSaleDialog userId={user?.id} inventory={inventoryByItem} purchases={purchases} onSaved={refresh} />
          <AddCatalogItemDialog userId={user?.id} onSaved={refresh} />
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border border-border bg-card p-3">
        <div className="flex flex-col gap-1">
          <Label className="text-xs">From</Label>
          <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">To</Label>
          <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Product</Label>
          <Select value={productFilter} onValueChange={setProductFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All products</SelectItem>
              {productNames.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label className="text-xs">Client</Label>
          <Select value={clientFilter} onValueChange={setClientFilter}>
            <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All clients</SelectItem>
              {clientNames.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" onClick={clearFilters}>Clear</Button>
      </div>

      {/* Financial summary KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title="Total Invested" value={formatUGX(totals.totalInvested)} icon={Wallet} loading={loadingPurchases} color="bg-blue-500/10 text-blue-600" />
        <KPICard title="Total Revenue" value={formatUGX(totals.totalRevenue)} icon={Coins} loading={loadingSales} color="bg-green-500/10 text-green-600" />
        <KPICard title="Gross Profit" value={formatUGX(totals.grossProfit)} icon={TrendingUp} loading={loadingSales} color={totals.grossProfit >= 0 ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-600'} />
        <KPICard title="Outstanding Receivables" value={formatUGX(totals.outstanding)} icon={HandCoins} loading={loadingSales} color="bg-amber-500/10 text-amber-600" subtitle={`${receivables.length} client${receivables.length === 1 ? '' : 's'} owing`} />
      </div>

      {/* Inventory KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title="Quantity Purchased" value={totals.totalQtyPurchased.toLocaleString()} icon={ArrowDownCircle} color="bg-blue-500/10 text-blue-600" />
        <KPICard title="Quantity Sold" value={totals.totalQtySold.toLocaleString()} icon={ArrowUpCircle} color="bg-purple-500/10 text-purple-600" />
        <KPICard title="Current Stock" value={totals.currentStock.toLocaleString()} icon={Boxes} color="bg-indigo-500/10 text-indigo-600" />
        <KPICard title="Inventory Value" value={formatUGX(totals.inventoryValue)} icon={Package} color="bg-cyan-500/10 text-cyan-600" subtitle="Stock at avg cost" />
      </div>

      {/* Live customer orders + realtime pop-ups */}
      <MerchandiseLiveOrders />

      {/* Cost of goods sold callout */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <KPICard title="Cost of Merchandise Sold" value={formatUGX(totals.cogs)} icon={Receipt} color="bg-orange-500/10 text-orange-600" />
        <KPICard title="Total Accounts Receivable" value={formatUGX(totals.outstanding)} icon={Users} color="bg-amber-500/10 text-amber-600" />
      </div>

      {/* Wallet-recovery KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard title="Recovered to Date" value={formatUGX(recovery.recoveredToDate)} icon={CircleDollarSign} loading={loadingRecovery} color="bg-emerald-500/10 text-emerald-600" subtitle="Via daily wallet deductions" />
        <KPICard title="Customers Repaying" value={recovery.count.toLocaleString()} icon={Repeat} loading={loadingRecovery} color="bg-purple-500/10 text-purple-600" subtitle="Active recovery plans" />
        <KPICard title="Remaining to Recover" value={formatUGX(recovery.remaining)} icon={HandCoins} loading={loadingRecovery} color="bg-amber-500/10 text-amber-600" />
        <KPICard title="Fully Paid Accounts" value={recovery.completed.length.toLocaleString()} icon={CheckCircle2} loading={loadingRecovery} color="bg-green-500/10 text-green-600" />
      </div>

      {/* Merchandise wallet recovery */}
      <Section title="Merchandise Wallet Recovery (15% credit sales · 25% agent installments · up to 4×/day)" icon={Repeat}>
        {recoveryPlans.length === 0 ? (
          <EmptyRow text="No wallet-recovery plans yet. Credit sales to registered customers are recovered automatically." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3">Customer</th>
                  <th className="py-2 px-3">Item</th>
                  <th className="py-2 px-3 text-right">Rate</th>
                  <th className="py-2 px-3 text-right">Original</th>
                  <th className="py-2 px-3 text-right">Recovered</th>
                  <th className="py-2 px-3 text-right">Remaining</th>
                  <th className="py-2 px-3">Last Recovery</th>
                  <th className="py-2 pl-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {recoveryPlans.map((p) => (
                  <tr key={p.id} className="border-b border-border/40">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{p.customer_name || 'Customer'}</div>
                      <div className="text-[11px] text-muted-foreground">{p.customer_phone || '—'}</div>
                    </td>
                    <td className="py-2 px-3">{p.item_name}</td>
                    <td className="py-2 px-3 text-right">{Math.round(Number(p.daily_rate) * 100)}%</td>
                    <td className="py-2 px-3 text-right">{formatUGX(Number(p.original_amount))}</td>
                    <td className="py-2 px-3 text-right text-emerald-600">{formatUGX(Number(p.amount_recovered))}</td>
                    <td className="py-2 px-3 text-right font-semibold text-amber-600">{formatUGX(Number(p.outstanding_balance))}</td>
                    <td className="py-2 px-3 whitespace-nowrap text-muted-foreground">
                      {p.last_recovery_at ? format(new Date(p.last_recovery_at), 'dd MMM yy') : '—'}
                    </td>
                    <td className="py-2 pl-3"><RecoveryBadge status={p.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Storefront catalog (items agents can buy) */}
      <div className="flex justify-end gap-2">
        <Button asChild size="sm" variant="outline" className="gap-1.5">
          <a href="/admin/merchandise-share-preview">
            <BarChart3 className="h-4 w-4" /> Verify share preview
          </a>
        </Button>
        <Button asChild size="sm" variant="outline" className="gap-1.5">
          <a href="/admin/merchandise-share-analytics">
            <BarChart3 className="h-4 w-4" /> Share link analytics
          </a>
        </Button>
      </div>

      <Section title="Storefront Catalog (what agents can buy)" icon={Store}>
        {loadingCatalog ? (
          <EmptyRow text="Loading catalog…" />
        ) : catalog.length === 0 ? (
          <EmptyRow text="No storefront items yet. Add items so agents can order them from their dashboard." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3">Item</th>
                  <th className="py-2 px-3 text-right">Price</th>
                  <th className="py-2 px-3 text-right">Cost</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 pl-3" />
                </tr>
              </thead>
              <tbody>
                {catalogPage.slice.map((c) => {
                  const imgs = (c.image_urls && c.image_urls.length > 0)
                    ? c.image_urls
                    : c.image_url ? [c.image_url] : [];
                  return (
                  <tr key={c.id} className="border-b border-border/40">
                    <td className="py-2 pr-3">
                      <div className="flex items-center gap-2">
                        {imgs.length > 0 ? (
                          <StorageImage src={imgs[0]} alt={c.item_name} className="h-10 w-10 rounded-md object-cover border border-border" />
                        ) : (
                          <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center border border-border">
                            <ImageIcon className="h-4 w-4 text-muted-foreground/50" />
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="font-medium">{c.item_name}</div>
                          {c.description && <div className="text-[11px] text-muted-foreground line-clamp-1">{c.description}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="py-2 px-3 text-right font-semibold">{formatUGX(Number(c.unit_price))}</td>
                    <td className="py-2 px-3 text-right text-muted-foreground">{formatUGX(Number(c.unit_cost))}</td>
                    <td className="py-2 px-3">
                      <span className={c.is_active ? 'text-emerald-600 text-xs font-medium' : 'text-muted-foreground text-xs'}>
                        {c.is_active ? 'Active' : 'Hidden'}
                      </span>
                    </td>
                    <td className="py-2 pl-3">
                      <div className="flex justify-end gap-1">
                        <EditCatalogItemButton item={c} userId={user?.id} onSaved={refresh} />
                        <Button
                          variant="ghost" size="sm" className="h-7 gap-1 text-xs"
                          onClick={async () => {
                            const { error } = await db.from('merchandise_catalog').update({ is_active: !c.is_active }).eq('id', c.id);
                            if (error) { toast.error(error.message); return; }
                            toast.success(c.is_active ? 'Item hidden' : 'Item shown to agents');
                            refresh();
                          }}
                        >
                          <Power className="h-3.5 w-3.5" /> {c.is_active ? 'Hide' : 'Show'}
                        </Button>
                        <Button
                          variant="ghost" size="sm" className="h-7 w-7 p-0 text-destructive"
                          onClick={async () => {
                            const { error } = await db.from('merchandise_catalog').delete().eq('id', c.id);
                            if (error) { toast.error(error.message); return; }
                            toast.success('Item removed');
                            refresh();
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            <Pager {...catalogPage} />
          </div>
        )}
      </Section>

      {/* Inventory by item */}
      <Section title="Inventory by Item" icon={Boxes}>
        {inventoryByItem.length === 0 ? (
          <EmptyRow text="No merchandise recorded yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3">Item</th>
                  <th className="py-2 px-3 text-right">Purchased</th>
                  <th className="py-2 px-3 text-right">Sold</th>
                  <th className="py-2 px-3 text-right">In Stock</th>
                  <th className="py-2 px-3 text-right">Invested</th>
                  <th className="py-2 pl-3 text-right">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {inventoryByItem.map((r) => (
                  <tr key={r.item_name} className="border-b border-border/40">
                    <td className="py-2 pr-3 font-medium">{r.item_name}</td>
                    <td className="py-2 px-3 text-right">{r.purchased.toLocaleString()}</td>
                    <td className="py-2 px-3 text-right">{r.sold.toLocaleString()}</td>
                    <td className={`py-2 px-3 text-right font-semibold ${r.stock <= 0 ? 'text-red-500' : ''}`}>{r.stock.toLocaleString()}</td>
                    <td className="py-2 px-3 text-right">{formatUGX(r.invested)}</td>
                    <td className="py-2 pl-3 text-right">{formatUGX(r.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Accounts receivable */}
      <Section title="Clients Owing (Accounts Receivable)" icon={HandCoins}>
        {receivables.length === 0 ? (
          <EmptyRow text="No outstanding merchandise credit." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3">Client</th>
                  <th className="py-2 px-3">Phone</th>
                  <th className="py-2 px-3 text-right">Credit Sales</th>
                  <th className="py-2 pl-3 text-right">Outstanding</th>
                </tr>
              </thead>
              <tbody>
                {receivables.map((r, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 px-3 text-muted-foreground">{r.phone || '—'}</td>
                    <td className="py-2 px-3 text-right">{r.count}</td>
                    <td className="py-2 pl-3 text-right font-semibold text-amber-600">{formatUGX(r.outstanding)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* Recent sales */}
      <Section title="Sales Transactions" icon={ShoppingCart}>
        {filteredSales.length === 0 ? (
          <EmptyRow text="No sales recorded for the selected filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 px-3">Item</th>
                  <th className="py-2 px-3 text-right">Qty</th>
                  <th className="py-2 px-3 text-right">Revenue</th>
                  <th className="py-2 px-3">Client</th>
                  <th className="py-2 px-3">Plan</th>
                  <th className="py-2 px-3">Status</th>
                  <th className="py-2 px-3">Order</th>
                  <th className="py-2 px-3 text-right">Owed</th>
                  <th className="py-2 pl-3" />
                </tr>
              </thead>
              <tbody>
                {salesPage.slice.map((s) => (
                  <tr key={s.id} className={`border-b border-border/40 ${s.order_status === 'rejected' ? 'opacity-60' : ''}`}>
                    <td className="py-2 pr-3 whitespace-nowrap">{format(new Date(s.sale_date), 'dd MMM yy')}</td>
                    <td className="py-2 px-3">{s.item_name}</td>
                    <td className="py-2 px-3 text-right">
                      <span className="inline-flex items-center justify-end gap-1.5">
                        {s.quantity}
                        {isOutlierSale(s) && (
                          <span
                            className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-600"
                            title="Outside normal order size — excluded from the metrics above"
                          >
                            Outlier
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right">{formatUGX(Number(s.total_revenue))}</td>
                    <td className="py-2 px-3">{s.client_name || '—'}</td>
                    <td className="py-2 px-3">
                      {s.payment_plan === 'installment' ? (
                        <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                          Installments 25%
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          Paid in full
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3"><StatusBadge status={s.payment_status} /></td>
                    <td className="py-2 px-3">
                      {s.order_status === 'rejected' ? (
                        <span
                          className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
                          title={s.rejection_reason ? `Reason: ${s.rejection_reason}` : 'Rejected'}
                        >
                          Rejected
                        </span>
                      ) : (
                        <Select
                          value={s.order_status || 'submitted'}
                          onValueChange={(v) => updateOrderStatus(s.id, v as OrderStatus)}
                        >
                          <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="submitted">Submitted</SelectItem>
                            <SelectItem value="processing">Processing</SelectItem>
                            <SelectItem value="completed">Completed</SelectItem>
                            <SelectItem value="failed">Failed</SelectItem>
                          </SelectContent>
                        </Select>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right">{Number(s.amount_outstanding) > 0 ? formatUGX(Number(s.amount_outstanding)) : '—'}</td>
                    <td className="py-2 pl-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        {(s.order_status === 'submitted' || s.order_status === 'processing' || !s.order_status) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-destructive hover:bg-destructive/10"
                            onClick={() => setRejectTarget(s)}
                          >
                            Reject
                          </Button>
                        )}
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => deleteSale(s.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager {...salesPage} />
          </div>
        )}
      </Section>

      <RejectPurchaseDialog
        sale={rejectTarget}
        onClose={() => setRejectTarget(null)}
        onDone={() => { setRejectTarget(null); refresh(); }}
      />

      {/* Recent purchases */}
      <Section title="Purchase History" icon={Package}>
        {filteredPurchases.length === 0 ? (
          <EmptyRow text="No purchases recorded for the selected filters." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="py-2 pr-3">Date</th>
                  <th className="py-2 px-3">Item</th>
                  <th className="py-2 px-3 text-right">Qty</th>
                  <th className="py-2 px-3 text-right">Unit Cost</th>
                  <th className="py-2 px-3 text-right">Total</th>
                  <th className="py-2 px-3">Supplier</th>
                  <th className="py-2 pl-3" />
                </tr>
              </thead>
              <tbody>
                {purchasesPage.slice.map((p) => (
                  <tr key={p.id} className="border-b border-border/40">
                    <td className="py-2 pr-3 whitespace-nowrap">{format(new Date(p.purchase_date), 'dd MMM yy')}</td>
                    <td className="py-2 px-3">{p.item_name}</td>
                    <td className="py-2 px-3 text-right">{p.quantity}</td>
                    <td className="py-2 px-3 text-right">{formatUGX(Number(p.unit_cost))}</td>
                    <td className="py-2 px-3 text-right">{formatUGX(Number(p.total_cost))}</td>
                    <td className="py-2 px-3">{p.supplier || '—'}</td>
                    <td className="py-2 pl-3 text-right">
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => deletePurchase(p.id)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager {...purchasesPage} />
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof Package; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
        <Icon className="h-4 w-4 text-primary" /> {title}
      </h3>
      {children}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground py-6 text-center">{text}</p>;
}

function StatusBadge({ status }: { status: 'paid' | 'credit' | 'partial' }) {
  const map = {
    paid: 'bg-green-500/10 text-green-600',
    credit: 'bg-red-500/10 text-red-600',
    partial: 'bg-amber-500/10 text-amber-600',
  } as const;
  const label = { paid: 'Paid', credit: 'On Credit', partial: 'Partial' }[status];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${map[status]}`}>{label}</span>;
}

function RecoveryBadge({ status }: { status: 'active' | 'completed' | 'cancelled' }) {
  const map = {
    active: 'bg-purple-500/10 text-purple-600',
    completed: 'bg-green-500/10 text-green-600',
    cancelled: 'bg-muted text-muted-foreground',
  } as const;
  const label = { active: 'Recovering', completed: 'Fully Paid', cancelled: 'Cancelled' }[status];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${map[status]}`}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Edit storefront catalog item
// ---------------------------------------------------------------------------
const SIZE_PRESETS = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL'];

function SizeEditor({ sizes, onChange, input, onInputChange }: {
  sizes: string[]; onChange: (v: string[]) => void; input: string; onInputChange: (v: string) => void;
}) {
  const add = (raw: string) => {
    const parts = raw.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (parts.length === 0) return;
    const next = [...sizes];
    for (const p of parts) if (!next.includes(p)) next.push(p);
    onChange(next.slice(0, 20));
    onInputChange('');
  };
  const toggle = (s: string) => sizes.includes(s) ? onChange(sizes.filter(x => x !== s)) : add(s);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {SIZE_PRESETS.map(s => (
          <button key={s} type="button" onClick={() => toggle(s)}
            className={`h-8 min-w-9 rounded-md border px-2 text-xs font-medium transition-colors ${
              sizes.includes(s)
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground border-border hover:bg-muted'
            }`}>{s}</button>
        ))}
      </div>
      <div className="flex gap-2">
        <Input value={input} onChange={(e) => onInputChange(e.target.value)} placeholder="Custom size e.g. 42, Free size"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(input); } }} maxLength={40} />
        <Button type="button" variant="outline" onClick={() => add(input)} disabled={!input.trim()}>Add</Button>
      </div>
      {sizes.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {sizes.map(s => (
            <span key={s} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs">
              {s}
              <button type="button" onClick={() => onChange(sizes.filter(x => x !== s))} className="text-muted-foreground hover:text-destructive">
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">No sizes set — item will show as one-size.</p>
      )}
    </div>
  );
}

function EditCatalogItemButton({ item, userId, onSaved }: { item: any; userId?: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState(item.item_name ?? '');
  const [description, setDescription] = useState(item.description ?? '');
  const [price, setPrice] = useState(String(item.unit_price ?? ''));
  const [cost, setCost] = useState(String(item.unit_cost ?? ''));
  const [sizes, setSizes] = useState<string[]>(Array.isArray(item.sizes) ? item.sizes : []);
  const [sizeInput, setSizeInput] = useState('');
  const initialImages = (): string[] => {
    if (Array.isArray(item.image_urls) && item.image_urls.length > 0) return item.image_urls.slice(0, 2);
    if (item.image_url) return [item.image_url];
    return [];
  };
  const [existingUrls, setExistingUrls] = useState<string[]>(initialImages());
  const [newImages, setNewImages] = useState<{ file: File; previewUrl: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const totalImages = existingUrls.length + newImages.length;

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const remaining = 2 - totalImages;
    if (remaining <= 0) { toast.error('Maximum 2 images per item'); return; }
    setUploading(true);
    const next: { file: File; previewUrl: string }[] = [];
    for (const file of files.slice(0, remaining)) {
      if (!file.type.startsWith('image/')) { toast.error(`${file.name} is not an image`); continue; }
      if (file.size > 10 * 1024 * 1024) { toast.error(`${file.name} exceeds 10MB`); continue; }
      try {
        const optimized = await optimizeImage(file, { maxWidth: 1200, quality: 0.8 });
        next.push({ file: optimized.file, previewUrl: optimized.previewUrl });
      } catch {
        next.push({ file, previewUrl: URL.createObjectURL(file) });
      }
    }
    setNewImages(prev => [...prev, ...next]);
    setUploading(false);
  };

  const removeExisting = (idx: number) => setExistingUrls(prev => prev.filter((_, i) => i !== idx));
  const removeNew = (idx: number) => setNewImages(prev => {
    const copy = [...prev];
    const [removed] = copy.splice(idx, 1);
    if (removed) URL.revokeObjectURL(removed.previewUrl);
    return copy;
  });

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Item name is required'); return; }
    const p = Number(price);
    const c = Number(cost);
    if (!Number.isFinite(p) || p < 0) { toast.error('Price must be a non-negative number'); return; }
    if (!Number.isFinite(c) || c < 0) { toast.error('Cost must be a non-negative number'); return; }
    setSaving(true);
    try {
      const uploaded: string[] = [];
      for (const img of newImages) {
        const ext = (img.file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${userId ?? 'anon'}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('merchandise')
          .upload(path, img.file, { cacheControl: '3600', upsert: false, contentType: img.file.type });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from('merchandise').getPublicUrl(path);
        uploaded.push(pub.publicUrl);
      }
      const finalUrls = [...existingUrls, ...uploaded].slice(0, 2);
      const { error } = await db.from('merchandise_catalog').update({
        item_name: trimmed,
        description: description.trim() || null,
        unit_price: p,
        unit_cost: c,
        sizes,
        image_url: finalUrls[0] ?? null,
        image_urls: finalUrls,
      }).eq('id', item.id);
      if (error) throw error;
      toast.success('Item updated');
      newImages.forEach(i => URL.revokeObjectURL(i.previewUrl));
      setNewImages([]);
      setOpen(false);
      onSaved();
    } catch (err: any) {
      toast.error(err?.message ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => {
      setOpen(v);
      if (v) {
        setName(item.item_name ?? '');
        setDescription(item.description ?? '');
        setPrice(String(item.unit_price ?? ''));
        setCost(String(item.unit_cost ?? ''));
        setSizes(Array.isArray(item.sizes) ? item.sizes : []);
        setSizeInput('');
        setExistingUrls(initialImages());
        newImages.forEach(i => URL.revokeObjectURL(i.previewUrl));
        setNewImages([]);
      }
    }}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 gap-1 text-xs">
          <Pencil className="h-3.5 w-3.5" /> Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>Edit storefront item</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Item name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label>Price (UGX)</Label>
              <Input type="number" inputMode="numeric" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label>Cost (UGX)</Label>
              <Input type="number" inputMode="numeric" min={0} value={cost} onChange={(e) => setCost(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Available sizes</Label>
            <SizeEditor sizes={sizes} onChange={setSizes} input={sizeInput} onInputChange={setSizeInput} />
          </div>
          <div className="space-y-1">
            <Label>Images (max 2)</Label>
            <div className="flex flex-wrap gap-2">
              {existingUrls.map((url, idx) => (
                <div key={`ex-${idx}`} className="relative">
                  <StorageImage src={url} alt="" className="h-20 w-20 rounded-md object-cover border border-border" />
                  <button type="button" onClick={() => removeExisting(idx)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {newImages.map((img, idx) => (
                <div key={`new-${idx}`} className="relative">
                  <img src={img.previewUrl} alt="" className="h-20 w-20 rounded-md object-cover border border-border" />
                  <button type="button" onClick={() => removeNew(idx)}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center">
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {totalImages < 2 && (
                <label className="h-20 w-20 rounded-md border border-dashed border-border flex flex-col items-center justify-center text-xs text-muted-foreground cursor-pointer hover:bg-muted">
                  <Upload className="h-4 w-4 mb-1" />
                  {uploading ? 'Optimizing…' : 'Add'}
                  <input type="file" accept="image/*" multiple className="hidden" onChange={handleFiles} disabled={uploading} />
                </label>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">Auto-optimized to 1200px WebP. Max 10MB per file.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving || uploading}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Record Purchase dialog
// ---------------------------------------------------------------------------
function RecordPurchaseDialog({ userId, productNames, onSaved }: { userId?: string; productNames: string[]; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [purchaseDate, setPurchaseDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [supplier, setSupplier] = useState('');
  const [notes, setNotes] = useState('');
  const [buyerName, setBuyerName] = useState('');
  const [buyerPhone, setBuyerPhone] = useState('');

  const qty = num(quantity);
  const cost = num(unitCost);
  const total = qty * cost;

  const reset = () => {
    setItemName(''); setQuantity(''); setUnitCost('');
    setPurchaseDate(format(new Date(), 'yyyy-MM-dd')); setSupplier(''); setNotes('');
    setBuyerName(''); setBuyerPhone('');
  };

  const save = async () => {
    if (!itemName.trim()) { toast.error('Item name is required'); return; }
    if (qty <= 0) { toast.error('Quantity must be greater than 0'); return; }
    if (cost < 0) { toast.error('Unit cost cannot be negative'); return; }
    setSaving(true);
    const { error } = await db.from('merchandise_purchases').insert({
      item_name: itemName.trim(),
      quantity: qty,
      unit_cost: cost,
      total_cost: total,
      purchase_date: purchaseDate,
      supplier: supplier.trim() || null,
      notes: notes.trim() || null,
      buyer_name: buyerName.trim() || null,
      buyer_phone: buyerPhone.trim() || null,
      created_by: userId ?? null,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success(
      buyerPhone.trim()
        ? 'Purchase recorded. If the buyer is a registered user, their wallet will be debited daily.'
        : 'Purchase recorded',
    );
    reset();
    setOpen(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5"><Plus className="h-4 w-4" /> Record Purchase</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Record Merchandise Purchase</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Item name</Label>
            <Input list="merch-products" value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Branded T-shirt" />
            <datalist id="merch-products">{productNames.map((p) => <option key={p} value={p} />)}</datalist>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Quantity</Label>
              <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Unit cost (UGX)</Label>
              <Input type="number" min={0} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm flex justify-between">
            <span className="text-muted-foreground">Total investment</span>
            <span className="font-semibold">{formatUGX(total)}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Purchase date</Label>
              <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Supplier</Label>
              <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Buyer / Purchaser name</Label>
              <Input value={buyerName} onChange={(e) => setBuyerName(e.target.value)} placeholder="Who bought it" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Buyer phone</Label>
              <Input value={buyerPhone} onChange={(e) => setBuyerPhone(e.target.value)} placeholder="For wallet debit" />
            </div>
          </div>
          {buyerPhone.trim() && total > 0 && (
            <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
              If this phone belongs to a registered user, {formatUGX(total)} will be recovered
              automatically — 15% of their Withdrawable Wallet each day until fully paid.
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Purchase'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Record Sale dialog
// ---------------------------------------------------------------------------
function RecordSaleDialog({
  userId, inventory, purchases, onSaved,
}: {
  userId?: string;
  inventory: { item_name: string; stock: number }[];
  purchases: Purchase[];
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [itemName, setItemName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [saleDate, setSaleDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [clientName, setClientName] = useState('');
  const [clientPhone, setClientPhone] = useState('');
  const [paymentStatus, setPaymentStatus] = useState<'paid' | 'credit' | 'partial'>('paid');
  const [amountPaid, setAmountPaid] = useState('');
  const [notes, setNotes] = useState('');

  const qty = num(quantity);
  const price = num(unitPrice);
  const totalRevenue = qty * price;
  const paid = paymentStatus === 'paid' ? totalRevenue : paymentStatus === 'partial' ? num(amountPaid) : 0;
  const outstanding = Math.max(0, totalRevenue - paid);

  const stockForItem = inventory.find((i) => i.item_name === itemName)?.stock ?? null;

  // Auto-fill cost from weighted average purchase cost for the chosen item.
  const suggestCost = (name: string) => {
    const rows = purchases.filter((p) => p.item_name === name);
    const invested = rows.reduce((s, p) => s + Number(p.total_cost), 0);
    const q = rows.reduce((s, p) => s + Number(p.quantity), 0);
    return q > 0 ? String(Math.round(invested / q)) : '';
  };

  const reset = () => {
    setItemName(''); setQuantity(''); setUnitPrice(''); setUnitCost('');
    setSaleDate(format(new Date(), 'yyyy-MM-dd')); setClientName(''); setClientPhone('');
    setPaymentStatus('paid'); setAmountPaid(''); setNotes('');
  };

  const save = async () => {
    if (!itemName.trim()) { toast.error('Item name is required'); return; }
    if (qty <= 0) { toast.error('Quantity must be greater than 0'); return; }
    if (price < 0) { toast.error('Unit price cannot be negative'); return; }
    if ((paymentStatus === 'credit' || paymentStatus === 'partial') && !clientName.trim() && !clientPhone.trim()) {
      toast.error('Credit sales need a client name or phone'); return;
    }
    setSaving(true);
    const { error } = await db.from('merchandise_sales').insert({
      item_name: itemName.trim(),
      quantity: qty,
      unit_price: price,
      unit_cost: num(unitCost),
      total_revenue: totalRevenue,
      client_name: clientName.trim() || null,
      client_phone: clientPhone.trim() || null,
      payment_status: paymentStatus,
      amount_paid: paid,
      amount_outstanding: outstanding,
      sale_date: saleDate,
      notes: notes.trim() || null,
      created_by: userId ?? null,
    });
    setSaving(false);
    if (error) { toast.error(error.message); return; }
    toast.success('Sale recorded');
    reset();
    setOpen(false);
    onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" className="gap-1.5"><ShoppingCart className="h-4 w-4" /> Record Sale</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Record Merchandise Sale</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Item</Label>
            <Select value={itemName} onValueChange={(v) => { setItemName(v); if (!unitCost) setUnitCost(suggestCost(v)); }}>
              <SelectTrigger><SelectValue placeholder="Select an item" /></SelectTrigger>
              <SelectContent>
                {inventory.length === 0 && <div className="px-2 py-1.5 text-xs text-muted-foreground">Record a purchase first</div>}
                {inventory.map((i) => (
                  <SelectItem key={i.item_name} value={i.item_name}>{i.item_name} ({i.stock} in stock)</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {stockForItem !== null && qty > stockForItem && (
              <p className="text-[11px] text-amber-600">Warning: selling {qty} but only {stockForItem} in stock.</p>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Quantity</Label>
              <Input type="number" min={1} value={quantity} onChange={(e) => setQuantity(e.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Selling price / unit</Label>
              <Input type="number" min={0} value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Cost / unit (for profit)</Label>
            <Input type="number" min={0} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="Auto from purchases" />
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm flex justify-between">
            <span className="text-muted-foreground">Total revenue</span>
            <span className="font-semibold">{formatUGX(totalRevenue)}</span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Client name</Label>
              <Input value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="Optional" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Client phone</Label>
              <Input value={clientPhone} onChange={(e) => setClientPhone(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Payment</Label>
              <Select value={paymentStatus} onValueChange={(v) => setPaymentStatus(v as any)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="paid">Paid in full</SelectItem>
                  <SelectItem value="partial">Partial</SelectItem>
                  <SelectItem value="credit">On credit</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Sale date</Label>
              <Input type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} />
            </div>
          </div>
          {paymentStatus === 'partial' && (
            <div className="space-y-1">
              <Label className="text-xs">Amount paid now</Label>
              <Input type="number" min={0} value={amountPaid} onChange={(e) => setAmountPaid(e.target.value)} placeholder="0" />
            </div>
          )}
          {(paymentStatus === 'credit' || paymentStatus === 'partial') && (
            <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm flex justify-between">
              <span className="text-amber-700">Outstanding balance</span>
              <span className="font-semibold text-amber-700">{formatUGX(outstanding)}</span>
            </div>
          )}
          {(paymentStatus === 'credit' || paymentStatus === 'partial') && outstanding > 0 && clientPhone.trim() && (
            <div className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700">
              If this phone belongs to a registered customer, the outstanding balance will be
              recovered automatically — 15% of their Withdrawable Wallet each day until fully paid.
            </div>
          )}
          <div className="space-y-1">
            <Label className="text-xs">Notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save Sale'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add storefront catalog item dialog (items agents can order)
// ---------------------------------------------------------------------------
function AddCatalogItemDialog({ userId, onSaved }: { userId?: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [itemName, setItemName] = useState('');
  const [description, setDescription] = useState('');
  const [unitPrice, setUnitPrice] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [images, setImages] = useState<{ file: File; previewUrl: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [sizes, setSizes] = useState<string[]>([]);
  const [sizeInput, setSizeInput] = useState('');

  const reset = () => {
    setItemName(''); setDescription(''); setUnitPrice(''); setUnitCost('');
    setSizes([]); setSizeInput('');
    images.forEach(i => URL.revokeObjectURL(i.previewUrl));
    setImages([]);
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (files.length === 0) return;
    const remaining = 2 - images.length;
    if (remaining <= 0) { toast.error('Maximum 2 images per item'); return; }
    setUploading(true);
    const next: { file: File; previewUrl: string }[] = [];
    for (const file of files.slice(0, remaining)) {
      if (!file.type.startsWith('image/')) { toast.error(`${file.name} is not an image`); continue; }
      if (file.size > 10 * 1024 * 1024) { toast.error(`${file.name} exceeds 10MB`); continue; }
      try {
        const optimized = await optimizeImage(file, { maxWidth: 1200, quality: 0.8 });
        next.push({ file: optimized.file, previewUrl: optimized.previewUrl });
      } catch {
        next.push({ file, previewUrl: URL.createObjectURL(file) });
      }
    }
    setImages(prev => [...prev, ...next]);
    setUploading(false);
  };

  const removeImage = (idx: number) => {
    setImages(prev => {
      const copy = [...prev];
      const [removed] = copy.splice(idx, 1);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return copy;
    });
  };

  const save = async () => {
    if (!itemName.trim()) { toast.error('Item name is required'); return; }
    if (num(unitPrice) <= 0) { toast.error('Price must be greater than 0'); return; }
    setSaving(true);
    try {
      const uploaded: string[] = [];
      for (const img of images) {
        const ext = (img.file.name.split('.').pop() || 'jpg').toLowerCase();
        const path = `${userId ?? 'anon'}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('merchandise')
          .upload(path, img.file, { cacheControl: '3600', upsert: false, contentType: img.file.type });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from('merchandise').getPublicUrl(path);
        uploaded.push(pub.publicUrl);
      }
      const { error } = await db.from('merchandise_catalog').insert({
        item_name: itemName.trim(),
        description: description.trim() || null,
        unit_price: num(unitPrice),
        unit_cost: num(unitCost),
        sizes,
        image_url: uploaded[0] ?? null,
        image_urls: uploaded,
        is_active: true,
        created_by: userId ?? null,
      });
      if (error) throw error;
      toast.success('Item added to storefront');
      reset();
      setOpen(false);
      onSaved();
    } catch (e: any) {
      toast.error(e?.message || 'Failed to save item');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" className="gap-1.5"><ShoppingBag className="h-4 w-4" /> Add Store Item</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>Add Storefront Item</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">Item name</Label>
            <Input value={itemName} onChange={(e) => setItemName(e.target.value)} placeholder="e.g. Press Jacket" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Selling price (UGX)</Label>
              <Input type="number" min={0} value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} placeholder="0" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Cost / unit (for profit)</Label>
              <Input type="number" min={0} value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder="Optional" />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Available sizes</Label>
            <SizeEditor sizes={sizes} onChange={setSizes} input={sizeInput} onInputChange={setSizeInput} />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Product photos ({images.length}/2)</Label>
            {images.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {images.map((img, i) => (
                  <div key={i} className="relative aspect-square rounded-md overflow-hidden border border-border">
                    <img src={img.previewUrl} alt={`preview-${i}`} className="w-full h-full object-cover" />
                    <Button type="button" variant="destructive" size="icon"
                      className="absolute top-1 right-1 h-6 w-6" onClick={() => removeImage(i)}>
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {images.length < 2 && (
              <label className="flex items-center justify-center gap-2 h-10 rounded-md border border-dashed border-border text-xs text-muted-foreground cursor-pointer hover:bg-muted/40">
                <Upload className="h-3.5 w-3.5" />
                {uploading ? 'Optimizing…' : 'Upload photo (max 2)'}
                <input type="file" accept="image/*" multiple className="hidden" onChange={handleFiles} disabled={uploading} />
              </label>
            )}
            <p className="text-[10px] text-muted-foreground">Images are resized to 1200px WebP and stored securely.</p>
          </div>
          <div className="rounded-lg bg-primary/5 border border-primary/15 px-3 py-2 text-[11px] text-muted-foreground">
            Agents can order this from their dashboard. On purchase the item price is debited from the agent's withdrawable wallet immediately.
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving || uploading}>{saving ? 'Saving…' : 'Add Item'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
// ---------- Reject purchase request dialog ----------
function RejectPurchaseDialog({
  sale, onClose, onDone,
}: {
  sale: Sale | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const open = !!sale;
  const reasonTrim = reason.trim();
  const canSubmit = !!sale && reasonTrim.length >= 10 && !submitting;

  const handleOpenChange = (v: boolean) => {
    if (!v && !submitting) {
      setReason('');
      onClose();
    }
  };

  const submit = async () => {
    if (!sale) return;
    setSubmitting(true);
    const { data, error } = await db.rpc('reject_merchandise_purchase', {
      p_sale_id: sale.id,
      p_reason: reasonTrim,
    });
    setSubmitting(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const refunded = Number((data as any)?.refunded || 0);
    const already = (data as any)?.already_rejected;
    if (already) {
      toast.message('This order was already rejected.');
    } else if (refunded > 0) {
      toast.success(`Rejected. Refunded ${formatUGX(refunded)} to the agent's wallet.`);
    } else {
      toast.success('Order rejected. Nothing was refunded (no money had been debited).');
    }
    setReason('');
    onDone();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Reject purchase request</DialogTitle>
        </DialogHeader>
        {sale && (
          <div className="space-y-3 text-sm">
            <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2 space-y-1">
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Agent</span>
                <span className="font-medium text-right">{sale.client_name || '—'}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Item</span>
                <span className="font-medium text-right">{sale.item_name} × {sale.quantity}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">Amount to refund</span>
                <span className="font-semibold text-right">{formatUGX(Number(sale.total_revenue))}</span>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              The agent's wallet will be credited back for what they already paid
              (instant purchase) or for what has already been swept via the recovery
              plan. Any remaining recovery plan is cancelled.
            </p>
            <div>
              <Label className="text-xs">Reason (visible in the audit log)</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why are you rejecting this order? (min 10 characters)"
                className="mt-1 min-h-[90px]"
                disabled={submitting}
              />
              <p className="text-[10px] text-muted-foreground mt-1">
                {reasonTrim.length}/10 characters minimum
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={!canSubmit}
          >
            {submitting ? 'Rejecting…' : 'Reject & refund'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
