import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Filter,
  Layers,
  Loader2,
  TrendingUp,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import PredictiveReceivablesForecast from '@/components/cfo/PredictiveReceivablesForecast';
import { useReceivablesBreakdown, useReceivablesTotal } from '@/hooks/useReceivables';
import TenantPaymentsLocationFilters from '@/components/cfo/TenantPaymentsLocationFilters';
import { CollectionsProjectionPanel } from '@/components/executive/tenant-ops/CollectionsProjectionPanel';


const ALL_PRODUCTS = '__all__';
const ALL_CATEGORIES = '__all__';
const TENANT_CATEGORY_LABEL = 'Tenant Products & Services';
const AGENT_CATEGORY_LABEL = 'Agent Products & Services';
const LANDLORD_CATEGORY_LABEL = 'Landlord Products & Services';
const PARTNER_CATEGORY_LABEL = 'Partner Products & Services';
const TENANT_PRODUCTS = [
  { key: 'rent_plan', label: 'Rent Access Plans', projectionAvailable: true },
  { key: 'tenant_service_charge', label: 'Tenant Charges', projectionAvailable: false },
  { key: 'business_advance', label: 'Business Advances', projectionAvailable: false },
] as const;

/** Families that open the same full product drill-down sheet. */
const DRILL_CATEGORY_KEYS = new Set(['agent', 'landlord', 'partner']);
const DRILL_CATEGORY_LABELS = new Set([
  AGENT_CATEGORY_LABEL,
  LANDLORD_CATEGORY_LABEL,
  PARTNER_CATEGORY_LABEL,
]);

/** True for every non-tenant family that drills down. */
function isDrillFamily(key: string, label: string): boolean {
  return DRILL_CATEGORY_KEYS.has(key) || DRILL_CATEGORY_LABELS.has(label);
}

export function ReceivablesBreakdownForecast({ hideHeadline = false }: { hideHeadline?: boolean } = {}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>(ALL_CATEGORIES);
  const [productFilter, setProductFilter] = useState<string>(ALL_PRODUCTS);
  const [tenantModalOpen, setTenantModalOpen] = useState(false);
  /** Which non-tenant family sheet is open, by category key. */
  const [drillCategoryKey, setDrillCategoryKey] = useState<string | null>(null);
  /** The product row selected inside each family sheet. */
  const [drillProductKeys, setDrillProductKeys] = useState<Record<string, string | null>>({});
  const total = useReceivablesTotal();
  const breakdown = useReceivablesBreakdown();

  const validation = breakdown.data?.validation;

  const tenantCategory = useMemo(
    () => breakdown.data?.categories.find((cat) => cat.key === 'tenant' || cat.label === TENANT_CATEGORY_LABEL),
    [breakdown.data],
  );

  const tenantProducts = useMemo(
    () => TENANT_PRODUCTS.map((definition) => {
      const recognised = tenantCategory?.products.find((product) => product.key === definition.key);
      return {
        ...definition,
        outstanding: recognised?.outstanding ?? 0,
        item_count: recognised?.item_count ?? 0,
      };
    }),
    [tenantCategory],
  );

  /** Categories sorted with the tenant book pinned first, for the category drill-down. */
  const sortedCategories = useMemo(() => {
    const cats = breakdown.data?.categories ?? [];
    return cats.slice().sort((a, b) => {
      if (a.label === TENANT_CATEGORY_LABEL && b.label !== TENANT_CATEGORY_LABEL) return -1;
      if (b.label === TENANT_CATEGORY_LABEL && a.label !== TENANT_CATEGORY_LABEL) return 1;
      return 0;
    });
  }, [breakdown.data]);

  /** Flat list of every product/service across categories, for the filter. */
  const productOptions = useMemo(() => {
    const cats = breakdown.data?.categories ?? [];
    return cats.flatMap((cat) => {
      const products = cat.key === 'tenant' || cat.label === TENANT_CATEGORY_LABEL
        ? tenantProducts
        : cat.products;
      return products.map((prod) => ({
        value: `${cat.key}:${prod.key}`,
        label: cat.label === TENANT_CATEGORY_LABEL ? prod.label : `${prod.label} — ${cat.label}`,
        outstanding: prod.outstanding,
        catLabel: cat.label,
        projectionAvailable: 'projectionAvailable' in prod ? prod.projectionAvailable : true,
      }));
    });
  }, [breakdown.data, tenantProducts]);

  const filteredTotal = useMemo(() => {
    if (productFilter === ALL_PRODUCTS || !breakdown.data) return null;
    const [catKey, prodKey] = productFilter.split(':');
    const category = breakdown.data.categories.find((c) => c.key === catKey);
    const prod = category?.label === TENANT_CATEGORY_LABEL
      ? tenantProducts.find((p) => p.key === prodKey)
      : category?.products.find((p) => p.key === prodKey);
    return prod?.outstanding ?? 0;
  }, [productFilter, breakdown.data, tenantProducts]);

  const selectedTenantProduct = useMemo(() => {
    if (productFilter === ALL_PRODUCTS) return tenantProducts[0];
    const [catKey, productKey] = productFilter.split(':');
    if (catKey !== tenantCategory?.key) return tenantProducts[0];
    return tenantProducts.find((product) => product.key === productKey) ?? tenantProducts[0];
  }, [productFilter, tenantCategory?.key, tenantProducts]);

  const totalReceivables = total.data?.total ?? breakdown.data?.total ?? 0;
  const selectedTenantShare = totalReceivables > 0
    ? (selectedTenantProduct.outstanding / totalReceivables) * 100
    : 0;

  return (
    <div className="space-y-3 sm:space-y-4 max-w-full">
      {/* Headline */}
      {!hideHeadline && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground">
                  Total Receivables — authoritative
                </p>
                <p className="text-2xl sm:text-3xl font-bold font-mono tabular-nums break-words">
                  {total.isLoading ? '—' : formatUGX(total.data?.total ?? 0)}
                </p>
                <p className="text-[10px] sm:text-xs text-muted-foreground">
                  {total.data?.item_count ?? 0} open items · single server-side definition
                </p>
              </div>
              <TrendingUp className="h-5 w-5 sm:h-6 sm:w-6 text-primary shrink-0" />
            </div>

            {validation && (
              <div className="flex items-start gap-1.5 text-[10px] sm:text-xs">
                {validation.ties_out ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-px shrink-0" />
                    <span className="text-emerald-700">
                      Categories tie out exactly to the authoritative total
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive mt-px shrink-0" />
                    <span className="text-destructive">
                      Category sum differs by {formatUGX(validation.difference)} — do not rely on
                      this breakdown
                    </span>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Categories with drill-down */}
      <Card>
        <CardContent className="p-3 sm:p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Layers className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              Breakdown by category
            </p>
            {breakdown.data && (
              <span className="text-[10px] sm:text-xs font-mono tabular-nums text-muted-foreground">
                {formatUGX(filteredTotal ?? breakdown.data.total)}
              </span>
            )}
          </div>

          {/* Category dropdown */}
          {sortedCategories.length > 0 && (
            <div className="flex items-center gap-2">
              <Layers className="h-3 w-3 text-muted-foreground shrink-0" />
              <Select
                value={categoryFilter}
                onValueChange={(v) => {
                  setCategoryFilter(v);
                  if (v !== ALL_CATEGORIES) {
                    setOpenCategory(v);
                    const cat = sortedCategories.find((c) => c.key === v);
                    if (cat?.label === TENANT_CATEGORY_LABEL) {
                      setTenantModalOpen(true);
                    }
                    if (cat && isDrillFamily(cat.key, cat.label)) {
                      setDrillCategoryKey(cat.key);
                    }
                  }
                }}
              >
                <SelectTrigger className="h-8 flex-1 text-xs">
                  <SelectValue placeholder="All categories" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_CATEGORIES} className="text-xs">
                    All categories
                  </SelectItem>
                  {sortedCategories.map((cat) => (
                    <SelectItem key={cat.key} value={cat.key} className="text-xs">
                      {cat.label} · {formatUGX(cat.outstanding)} · {breakdown.data && breakdown.data.total > 0
                        ? `${((cat.outstanding / breakdown.data.total) * 100).toFixed(1)}%`
                        : '0.0%'} · {cat.item_count} item{cat.item_count === 1 ? '' : 's'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {categoryFilter !== ALL_CATEGORIES && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 px-2 text-[11px] shrink-0"
                  onClick={() => setCategoryFilter(ALL_CATEGORIES)}
                >
                  <X className="h-3 w-3 mr-1" />
                  Clear
                </Button>
              )}
            </div>
          )}

          {breakdown.isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          <div>
            {sortedCategories
              .filter((cat) => categoryFilter === ALL_CATEGORIES || cat.key === categoryFilter)
              .map((cat) => {
                const sourceProducts = cat.label === TENANT_CATEGORY_LABEL ? tenantProducts : cat.products;
                const products =
                  productFilter === ALL_PRODUCTS
                    ? sourceProducts
                    : sourceProducts.filter((p) => `${cat.key}:${p.key}` === productFilter);
                return { cat, products };
              })
              .filter(({ products }) => products.length > 0 || productFilter === ALL_PRODUCTS)
              .map(({ cat, products }) => {
              const catOpen = openCategory === cat.key;
              const isTenantCat = cat.label === TENANT_CATEGORY_LABEL;
              const isFamilyCat = !isTenantCat && isDrillFamily(cat.key, cat.label);
              const isDrillCat = isTenantCat || isFamilyCat;
              const familyProducts = isFamilyCat ? cat.products : [];
              const selectedFamilyProduct =
                familyProducts.find((p) => p.key === drillProductKeys[cat.key]) ?? familyProducts[0];
              const selectedFamilyShare =
                totalReceivables > 0 && selectedFamilyProduct
                  ? (selectedFamilyProduct.outstanding / totalReceivables) * 100
                  : 0;
              const shownOutstanding =
                productFilter === ALL_PRODUCTS
                  ? cat.outstanding
                  : products.reduce((s, p) => s + p.outstanding, 0);
              const share =
                breakdown.data.total > 0 ? (shownOutstanding / breakdown.data.total) * 100 : 0;
              const itemCount =
                productFilter === ALL_PRODUCTS
                  ? cat.item_count
                  : products.reduce((s, p) => s + p.item_count, 0);

              const categoryHeader = (
                <button
                  type="button"
                  onClick={isDrillCat ? undefined : () => setOpenCategory(catOpen ? null : cat.key)}
                  aria-expanded={
                    isDrillCat
                      ? isTenantCat
                        ? tenantModalOpen
                        : drillCategoryKey === cat.key
                      : catOpen
                  }
                  className="hidden"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {isDrillCat || !catOpen ? (
                      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                    )}
                    <span className="min-w-0">
                      <span className="block text-xs sm:text-sm font-medium truncate">
                        {cat.label}
                      </span>
                      <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                        {itemCount} item{itemCount === 1 ? '' : 's'} · {share.toFixed(1)}% of book
                      </span>
                    </span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block text-xs sm:text-sm font-bold font-mono tabular-nums">
                      {formatUGX(shownOutstanding)}
                    </span>
                    <Progress value={share} className="h-1 w-16 sm:w-24 mt-1" />
                  </span>
                </button>
              );

              const productList = (
                <>
                  {products.length === 0 && (
                    <p className="text-[10px] sm:text-xs text-muted-foreground py-1">
                      No open receivables in this category.
                    </p>
                  )}
                  {products.map((prod) => (
                    <div
                      key={`${cat.key}:${prod.key}`}
                      className="rounded-lg bg-muted/30 px-2.5 py-2 flex items-center justify-between gap-2 min-h-10"
                    >
                      <span className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[11px] sm:text-xs truncate">{prod.label}</span>
                        <span className="text-[9px] sm:text-[10px] text-muted-foreground shrink-0">
                          ({prod.item_count})
                        </span>
                      </span>
                      <span className="text-[11px] sm:text-xs font-mono tabular-nums font-semibold shrink-0">
                        {formatUGX(prod.outstanding)}
                      </span>
                    </div>
                  ))}
                </>
              );

              return (
                <div key={cat.key}>
                  {isTenantCat ? (
                    <Dialog open={tenantModalOpen} onOpenChange={setTenantModalOpen}>
                      <DialogTrigger asChild>{categoryHeader}</DialogTrigger>
                      <DialogContent className="max-w-6xl w-[92vw] max-h-[85vh] overflow-y-auto p-0 rounded-2xl border border-border/60 shadow-xl">
                        <DialogHeader className="px-5 pt-5 pb-2">
                          <DialogTitle className="text-base sm:text-lg">{cat.label}</DialogTitle>
                          <DialogDescription>
                            Receivable position and projection for {selectedTenantProduct.label}.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="px-5 pb-6 space-y-4">
                          <Card className="border-border/60">
                            <CardContent className="p-4">
                              <div className="flex items-start justify-between gap-4">
                                <div className="min-w-0">
                                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                    Outstanding receivable
                                  </p>
                                  <p className="mt-1 text-2xl sm:text-3xl font-bold font-mono tabular-nums">
                                    {formatUGX(selectedTenantProduct.outstanding)}
                                  </p>
                                  <p className="mt-1 text-[11px] text-muted-foreground">
                                    {selectedTenantProduct.item_count} open {selectedTenantProduct.item_count === 1 ? 'item' : 'items'} · {selectedTenantShare.toFixed(1)}% of total receivables book
                                  </p>
                                </div>
                                <div className="shrink-0 text-right">
                                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                    Share of book
                                  </p>
                                  <p className="mt-1 text-xl font-bold font-mono tabular-nums">
                                    {selectedTenantShare.toFixed(1)}%
                                  </p>
                                  <Progress value={selectedTenantShare} className="mt-2 h-1.5 w-24 sm:w-32" />
                                </div>
                              </div>
                              <Separator className="my-4" />
                              <div className="space-y-1.5">
                                <div className="rounded-lg bg-muted/30 px-2.5 py-2 flex items-center justify-between gap-2 min-h-10">
                                  <span className="text-[11px] sm:text-xs">{selectedTenantProduct.label}</span>
                                  <span className="text-[11px] sm:text-xs font-mono tabular-nums font-semibold">
                                    {formatUGX(selectedTenantProduct.outstanding)}
                                  </span>
                                </div>
                              </div>
                            </CardContent>
                          </Card>

                          {selectedTenantProduct.key === 'rent_plan' && (
                            <>
                              <TenantPaymentsLocationFilters />
                              <CollectionsProjectionPanel />
                            </>
                          )}
                          {selectedTenantProduct.key !== 'rent_plan' && (
                            <PredictiveReceivablesForecast
                              productLabel={selectedTenantProduct.label}
                              filterCategoryKey={cat.key}
                              filterProductKey={selectedTenantProduct.key}
                              actualTotal={selectedTenantProduct.outstanding}
                              actualItemCount={selectedTenantProduct.item_count}
                            />
                          )}
                        </div>
                      </DialogContent>
                    </Dialog>
                  ) : isFamilyCat ? (
                    <Dialog
                      open={drillCategoryKey === cat.key}
                      onOpenChange={(open) => setDrillCategoryKey(open ? cat.key : null)}
                    >
                      <DialogTrigger asChild>{categoryHeader}</DialogTrigger>
                      <DialogContent className="max-w-6xl w-[92vw] max-h-[85vh] overflow-y-auto p-0 rounded-2xl border border-border/60 shadow-xl">
                        <DialogHeader className="px-5 pt-5 pb-2">
                          <DialogTitle className="text-base sm:text-lg">{cat.label}</DialogTitle>
                          <DialogDescription>
                            Receivable position and projection for {selectedFamilyProduct?.label ?? 'this product'}.
                          </DialogDescription>
                        </DialogHeader>
                        <div className="px-5 pb-6 space-y-4">
                          {!selectedFamilyProduct ? (
                            <p className="text-xs text-muted-foreground">
                              No open receivables in this category.
                            </p>
                          ) : (
                            <>
                              <Card className="border-border/60">
                                <CardContent className="p-4">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="min-w-0">
                                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        Outstanding receivable
                                      </p>
                                      <p className="mt-1 text-2xl sm:text-3xl font-bold font-mono tabular-nums">
                                        {formatUGX(selectedFamilyProduct.outstanding)}
                                      </p>
                                      <p className="mt-1 text-[11px] text-muted-foreground">
                                        {selectedFamilyProduct.item_count} open {selectedFamilyProduct.item_count === 1 ? 'item' : 'items'} · {selectedFamilyShare.toFixed(1)}% of total receivables book
                                      </p>
                                    </div>
                                    <div className="shrink-0 text-right">
                                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        Share of book
                                      </p>
                                      <p className="mt-1 text-xl font-bold font-mono tabular-nums">
                                        {selectedFamilyShare.toFixed(1)}%
                                      </p>
                                      <Progress value={selectedFamilyShare} className="mt-2 h-1.5 w-24 sm:w-32" />
                                    </div>
                                  </div>
                                  <Separator className="my-4" />
                                  <div className="space-y-1.5">
                                    {familyProducts.map((prod) => {
                                      const active = prod.key === selectedFamilyProduct.key;
                                      return (
                                        <button
                                          key={prod.key}
                                          type="button"
                                          onClick={() =>
                                            setDrillProductKeys((current) => ({
                                              ...current,
                                              [cat.key]: prod.key,
                                            }))
                                          }
                                          className={`w-full rounded-lg px-2.5 py-2 flex items-center justify-between gap-2 min-h-10 text-left transition-colors ${
                                            active
                                              ? 'bg-primary/10 ring-1 ring-primary/40'
                                              : 'bg-muted/30 hover:bg-muted/50'
                                          }`}
                                        >
                                          <span className="flex items-center gap-1.5 min-w-0">
                                            <ChevronRight className={`h-3.5 w-3.5 shrink-0 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
                                            <span className="text-[11px] sm:text-xs truncate">{prod.label}</span>
                                            <span className="text-[9px] sm:text-[10px] text-muted-foreground shrink-0">
                                              ({prod.item_count})
                                            </span>
                                          </span>
                                          <span className="text-[11px] sm:text-xs font-mono tabular-nums font-semibold shrink-0">
                                            {formatUGX(prod.outstanding)}
                                          </span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </CardContent>
                              </Card>

                              <PredictiveReceivablesForecast
                                productLabel={selectedFamilyProduct.label}
                                filterCategoryKey={cat.key}
                                filterProductKey={selectedFamilyProduct.key}
                                actualTotal={selectedFamilyProduct.outstanding}
                                actualItemCount={selectedFamilyProduct.item_count}
                              />
                            </>
                          )}
                        </div>
                      </DialogContent>
                    </Dialog>
                  ) : (
                    <>
                      {categoryHeader}
                      {catOpen && (
                        <div className="px-2.5 pb-2.5 space-y-1.5">{productList}</div>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Predictive, data-driven forecast */}
      <PredictiveReceivablesForecast />
    </div>
  );
}
