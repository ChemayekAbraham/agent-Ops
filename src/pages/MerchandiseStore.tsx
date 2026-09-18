import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { fetchWalletBalance } from '@/hooks/wallet/useWalletBalance';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SkeletonProductCard } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import {
  ArrowLeft, ShoppingBag, Package, Wallet, CheckCircle2, Repeat, Info, Smartphone, Bike, AlertCircle, Share2,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { merchandiseInstallmentSchedule } from '@/lib/merchandiseInstallments';
import { format } from 'date-fns';
import SmartphoneOrderStatus from '@/components/merchandise/SmartphoneOrderStatus';
import MerchandiseRepaymentPortfolio from '@/components/merchandise/MerchandiseRepaymentPortfolio';
import { useMerchandiseOrderLock } from '@/hooks/useMerchandiseOrderLock';
import SpiroBikeOrderDialog from '@/components/merchandise/SpiroBikeOrderDialog';
import BikeLeaseStatus from '@/components/merchandise/BikeLeaseStatus';
import SmartphoneOrderDialog from '@/components/merchandise/SmartphoneOrderDialog';

import { StorageImage } from '@/components/ui/StorageImage';
import { shortMerchandiseUrl, longMerchandiseUrl } from '@/lib/merchandiseShareLink';
import { useRestoreBodyPointerEvents } from '@/hooks/useRestoreBodyPointerEvents';
import shoppingBagIllustration from '@/assets/Shopping_bag-amico.svg.asset.json';
import spiroBikeAsset from '@/assets/spiro-bike.jpg.asset.json';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';

// Merchandise tables aren't in generated types yet.
const db = supabase as any;

interface CatalogItem {
  id: string;
  item_name: string;
  description: string | null;
  unit_price: number;
  image_url: string | null;
  image_urls: string[] | null;
  is_active: boolean;
  sizes: string[] | null;
}

interface RecoveryPlan {
  id: string;
  item_name: string;
  original_amount: number;
  outstanding_balance: number;
  amount_recovered: number;
  status: 'active' | 'completed' | 'cancelled';
  last_recovery_at: string | null;
  created_at: string;
}

interface Deduction {
  id: string;
  item_name: string | null;
  amount: number;
  outstanding_after: number;
  created_at: string;
}

const PAGE_SIZE = 8;

export default function MerchandiseStore() {
  const navigate = useNavigate();
  // Clears the Radix stacked-modal body pointer-events lock that can make the
  // dialog's footer buttons (e.g. "Review order") silently unresponsive.
  useRestoreBodyPointerEvents();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [quantity, setQuantity] = useState('1');
  const [payMode, setPayMode] = useState<'full' | 'installment'>('full');
  const [termMonths, setTermMonths] = useState<number>(3);
  const [selectedSize, setSelectedSize] = useState<string | null>(null);
  const [confirmStep, setConfirmStep] = useState(false);
  const [ordering, setOrdering] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const { repaying: smartphoneRepaying } = useMerchandiseOrderLock(user?.id);


  const [bikeOpen, setBikeOpen] = useState(false);
  const [catalogPage, setCatalogPage] = useState(1);
  const [shareItem, setShareItem] = useState<CatalogItem | null>(null);
  // Post-purchase receipt shown to the buyer as explicit confirmation.
  const [success, setSuccess] = useState<{
    itemName: string;
    quantity: number;
    mode: 'full' | 'installment';
    paidNow: number;
    remaining: number;
    total: number;
  } | null>(null);
  const [shareCodes, setShareCodes] = useState<Record<string, string>>({});
  const {
    withdrawableBalance,
    isLoading: walletLoading,
    error: walletError,
    refetch: refetchWallet,
  } = useAgentBalances(user?.id);
  const availableWallet = Math.max(0, withdrawableBalance);
  // The pay button must never be judged against a balance that hasn't loaded —
  // a still-loading (0) wallet used to silently disable "Review order"/"Yes,
  // pay" for every item priced above 0.
  const walletBlocked = walletLoading || !!walletError;


  const {
    data: catalog = [],
    isLoading: loadingCatalog,
    error: catalogError,
    refetch: refetchCatalog,
  } = useQuery<CatalogItem[]>({
    queryKey: ['merchandise-catalog'],
    enabled: !!user?.id,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_catalog')
        .select('*')
        .eq('is_active', true)
        .order('item_name');
      if (error) throw error;
      return data || [];
    },
  });

  const { data: plans = [] } = useQuery<RecoveryPlan[]>({
    queryKey: ['my-merchandise-plans', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_recovery_plans')
        .select('*')
        .eq('customer_id', user!.id)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: deductions = [] } = useQuery<Deduction[]>({
    queryKey: ['my-merchandise-deductions', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_recovery_deductions')
        .select('id, item_name, amount, outstanding_after, created_at')
        .eq('customer_id', user!.id)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return data || [];
    },
  });

  const totalOwing = plans
    .filter((p) => p.status === 'active')
    .reduce((s, p) => s + Number(p.outstanding_balance), 0);
  const totalRecovered = plans.reduce((s, p) => s + Number(p.amount_recovered), 0);

  const qty = Math.max(1, parseInt(quantity || '1', 10) || 1);
  // Sizes on the catalog row are exactly what the company has in stock for the
  // item. Empty list = one-size item, no choice needed.
  const availableSizes: string[] = Array.isArray(selected?.sizes)
    ? (selected!.sizes as string[]).map((s) => String(s).trim()).filter(Boolean)
    : [];
  const needsSize = availableSizes.length > 0;
  const sizeMissing = needsSize && !selectedSize;
  const orderTotal = selected ? Number(selected.unit_price) * qty : 0;
  // Chosen repayment period for the instalment plan (1–12 months). The schedule
  // is reducing balance: 28% monthly charge on the opening principal, so both the
  // monthly amount and the daily wallet deduction fall month after month.
  const termSchedule = orderTotal > 0 ? merchandiseInstallmentSchedule(orderTotal, termMonths) : null;
  const termTotalRepayable = termSchedule?.totalRepayable ?? 0;
  const termFirstDaily = termSchedule?.firstDaily ?? 0;
  const termLastDaily = termSchedule?.lastDaily ?? 0;
  // Pay in full needs the whole price today. Installments are 25% of the item
  // price each — paid now and at every recovery run until the selling price is
  // cleared (4 installments, no extra charge on top of the price).
  // Instalment plans take nothing at checkout: the whole price is financed over
  // the chosen period and collected daily from the wallet.
  const dueNow = payMode === 'full' ? orderTotal : 0;
  const insufficient = selected && !walletBlocked
    ? (payMode === 'full' ? orderTotal > availableWallet : false)
    : false;
  const zeroDown = payMode === 'installment';

  const pickImage = (item: CatalogItem | null): string | null => {
    if (!item) return null;
    if (item.image_urls && item.image_urls.length > 0) return item.image_urls[0];
    return item.image_url || null;
  };

  // Short branded share links: a code is allocated once per item per sharer and
  // reused, so the pasted link reads welileapp-short instead of a function URL.
  // If the code cannot be allocated we fall back to the long function URL, which
  // still previews correctly.
  const ensureShareCode = async (item: CatalogItem): Promise<string | null> => {
    if (shareCodes[item.id]) return shareCodes[item.id];
    const { data, error } = await db.rpc('get_merchandise_share_code', {
      p_catalog_id: item.id,
    });
    if (error || !data) return null;
    const code = String(data);
    setShareCodes((prev) => ({ ...prev, [item.id]: code }));
    return code;
  };

  const buildShare = (item: CatalogItem, src = 'app', code?: string | null) => {
    const short = shortMerchandiseUrl(code ?? shareCodes[item.id] ?? '', src);
    const url = short ?? longMerchandiseUrl(item.id, item.item_name, src);
    const text = `Check out ${item.item_name} — ${formatUGX(Number(item.unit_price))} on Welile Merchandise.`;
    return { url, text, full: `${text} ${url}` };
  };

  const handleShare = async (item: CatalogItem) => {
    const code = await ensureShareCode(item);
    const { url, text } = buildShare(item, 'native', code);
    if (typeof navigator !== 'undefined' && (navigator as any).share) {
      try {
        await (navigator as any).share({ title: item.item_name, text, url });
        return;
      } catch (e: any) {
        if (e?.name === 'AbortError') return;
      }
    }
    setShareItem(item);
  };

  const copyShareLink = async (item: CatalogItem) => {
    const code = await ensureShareCode(item);
    const { full } = buildShare(item, 'copy', code);
    try {
      await navigator.clipboard.writeText(full);
      toast.success('Link copied');
    } catch {
      toast.error('Could not copy');
    }
  };

  const totalPages = Math.max(1, Math.ceil(catalog.length / PAGE_SIZE));

  // Allocate the short code as soon as the share sheet opens so every channel
  // button carries the branded link.
  useEffect(() => {
    if (shareItem) void ensureShareCode(shareItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareItem]);
  const safePage = Math.min(catalogPage, totalPages);
  const catalogSlice = catalog.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Deep-link: /merchandise?item=<id> auto-opens the checkout for that product.
  useEffect(() => {
    const itemId = searchParams.get('item');
    if (!itemId || catalog.length === 0 || selected) return;
    const match = catalog.find((c) => c.id === itemId);
    if (match) {
      setSelected(match);
      setQuantity('1');
      setPayMode('full');
      setSelectedSize(null);
      setConfirmStep(false);
    }
    // Clear the param so refreshes/back-navigation don't reopen unexpectedly.
    const next = new URLSearchParams(searchParams);
    next.delete('item');
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, searchParams]);

  const placeOrder = async () => {
    if (!selected) return;
    if (sizeMissing) {
      toast.error('Choose a size', { description: 'Pick one of the sizes currently in stock.' });
      return;
    }
    if (walletError) {
      toast.error('Wallet balance unavailable', { description: 'We could not read your wallet. Retry the wallet check and try again.' });
      return;
    }
    if (walletLoading) {
      toast.error('Still checking your wallet', { description: 'Give it a moment — your balance is loading.' });
      return;
    }
    setOrdering(true);
    // High-stakes debit: re-read the authoritative wallet view instead of
    // trusting the cached balance, so the button never promises a payment the
    // server will refuse.
    let freshWallet = availableWallet;
    if (user?.id) {
      try {
        const view = await fetchWalletBalance(user.id);
        freshWallet = Math.max(0, view.withdrawable);
      } catch {
        setOrdering(false);
        toast.error('Wallet balance unavailable', { description: 'We could not confirm your balance. Please try again.' });
        return;
      }
    }
    if (payMode === 'full' && orderTotal > freshWallet) {
      setOrdering(false);
      refetchWallet();
      toast.error('Insufficient balance', {
        description: `Your wallet has ${formatUGX(freshWallet)} but this order needs ${formatUGX(orderTotal)}. Choose installments instead.`,
      });
      return;
    }
    const { error } = payMode === 'installment'
      ? await db.rpc('agent_purchase_merchandise_plan', {
          p_catalog_id: selected.id,
          p_quantity: qty,
          p_size: selectedSize,
          p_term_months: termMonths,
        })
      : await db.rpc('agent_purchase_merchandise', {
          p_catalog_id: selected.id,
          p_quantity: qty,
          p_payment_mode: payMode,
          p_size: selectedSize,
        });
    setOrdering(false);

    if (error) {
      const msg = error.message || 'Could not place order';
      if (msg.includes('INSUFFICIENT_BALANCE')) {
        toast.error('Insufficient balance', {
          description: `Your wallet has ${formatUGX(availableWallet)} but this order needs ${formatUGX(orderTotal)}.`,
        });
      } else {
        toast.error(msg);
      }
      return;
    }
    toast.success(
      payMode === 'full'
        ? `${selected.item_name} ordered. ${formatUGX(orderTotal)} debited from your wallet.`
        : `${selected.item_name} ordered over ${termMonths} month${termMonths === 1 ? '' : 's'}. Nothing taken now — about ${formatUGX(termFirstDaily)} a day from your wallet, reducing each month.`,
    );
    setSuccess({
      itemName: selected.item_name,
      quantity: qty,
      mode: payMode,
      paidNow: payMode === 'full' ? orderTotal : 0,
      remaining: payMode === 'full' ? 0 : termTotalRepayable,
      total: orderTotal,
    });
    setSelected(null);
    setQuantity('1');
    setPayMode('full');
    setTermMonths(3);
    setSelectedSize(null);
    setConfirmStep(false);
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-plans', user?.id] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-deductions', user?.id] });
    queryClient.invalidateQueries({ queryKey: ['wallet-view', user?.id] });
  };



  return (
    <div className="min-h-[100dvh] bg-background pb-24">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border">
        <div className="max-w-lg mx-auto flex items-center gap-3 px-4 py-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(-1)}
            aria-label="Back"
            className="shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-base font-bold flex items-center gap-2">
              <ShoppingBag className="h-4 w-4 text-primary" /> What do you want to buy?
            </h1>
            <p className="text-[11px] text-muted-foreground">Buy branded gear — paid off from your wallet</p>
          </div>
        </div>
      </div>
      <div className="max-w-lg mx-auto px-4 pt-4">
        <img
          src={shoppingBagIllustration.url}
          alt="Welile merchandise shopping bag"
          className="w-full max-h-40 object-contain"
          loading="eager"
        />
      </div>

      <div className="max-w-lg mx-auto px-4 pt-4 space-y-5">
        {/* My payments summary */}
        {plans.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <Card>
              <CardContent className="p-3">
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Wallet className="h-3 w-3" /> Still to repay
                </p>
                <p className="text-lg font-bold text-amber-600">{formatUGX(totalOwing)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3" /> Repaid so far
                </p>
                <p className="text-lg font-bold text-emerald-600">{formatUGX(totalRecovered)}</p>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="rounded-xl bg-primary/5 border border-primary/15 px-3 py-2 flex gap-2 text-[11px] text-muted-foreground">
          <Info className="h-3.5 w-3.5 text-primary shrink-0 mt-0.5" />
          <p>Anything you order is repaid automatically — 15% of your withdrawable wallet is deducted up to 4 times a day until it's cleared. You'll get a notification each time.</p>
        </div>

        {/* Order a Welile Smartphone */}
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-4 flex items-center gap-3">
            <img
              src={smartphonePromoAsset.url}
              alt="Welile Smartphone"
              loading="lazy"
              className="h-11 w-11 rounded-xl object-cover shrink-0 border border-primary/20"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold leading-tight">Order a Welile Smartphone</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Get a company smartphone on credit. Choose how much can be deducted from your wallet — final price is set by marketing.
              </p>
            </div>
            <Button
              size="sm"
              className="h-8 text-xs gap-1 shrink-0"
              disabled={smartphoneRepaying}
              title={smartphoneRepaying ? 'You have a smartphone still being repaid' : undefined}
              onClick={() => setPhoneOpen(true)}
            >
              {smartphoneRepaying ? 'In repayment' : 'Order'}
            </Button>

          </CardContent>
        </Card>

        {/* Products being repaid — plan + pay button per product */}
        <MerchandiseRepaymentPortfolio userId={user?.id} />

        {/* Smartphone order status */}
        <SmartphoneOrderStatus userId={user?.id} onRequestNewOrder={() => setPhoneOpen(true)} />

        {/* Order a Welile Spiro Bike */}
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-4 flex items-center gap-3">
            <img
              src={spiroBikeAsset.url}
              alt="Welile Spiro electric bike"
              loading="lazy"
              className="h-11 w-11 rounded-xl object-cover shrink-0 border border-primary/20"
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold leading-tight">Apply for a Spiro electric bike</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Pick a model and lease term. Marketing confirms the price, then the bike is released and your lease is activated.
              </p>
            </div>
            <Button size="sm" className="h-8 text-xs gap-1 shrink-0" onClick={() => setBikeOpen(true)}>
              Apply
            </Button>
          </CardContent>
        </Card>

        {/* Spiro bike lease status */}
        <BikeLeaseStatus userId={user?.id} onRequestNewOrder={() => setBikeOpen(true)} />

        {/* Catalog */}
        <div>
          <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
            <Package className="h-4 w-4 text-primary" /> Available items
          </h2>
          {catalogError ? (
            <div className="rounded-xl border border-border bg-card p-6 text-center space-y-3">
              <p className="text-sm text-muted-foreground">
                We couldn't load the catalog. Please check your connection and try again.
              </p>
              <Button size="sm" variant="outline" onClick={() => refetchCatalog()}>
                Retry
              </Button>
            </div>
          ) : loadingCatalog ? (
            <div className="grid grid-cols-2 gap-3">
              {[...Array(4)].map((_, i) => (
                <SkeletonProductCard key={i} />
              ))}
            </div>
          ) : catalog.length === 0 ? (
            <p className="text-xs text-muted-foreground py-6 text-center">No merchandise available right now.</p>
          ) : (
            <>
            <div className="grid grid-cols-2 gap-3">
              {catalogSlice.map((item) => {
                const img = pickImage(item);
                return (
                <Card
                  key={item.id}
                  className="overflow-hidden cursor-pointer transition hover:shadow-md hover:border-primary/40 focus-within:ring-2 focus-within:ring-primary/40"
                  role="button"
                  tabIndex={0}
                  onClick={() => { setSelected(item); setQuantity('1'); setSelectedSize(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelected(item);
                      setQuantity('1');
                      setSelectedSize(null);
                    }
                  }}
                  aria-label={`Buy ${item.item_name}`}
                >
                  {img ? (
                    <StorageImage src={img} alt={item.item_name} className="w-full h-28 object-cover" loading="lazy" />
                  ) : (
                    <div className="w-full h-28 bg-muted flex items-center justify-center">
                      <Package className="h-8 w-8 text-muted-foreground/40" />
                    </div>
                  )}
                  <CardContent className="p-3 space-y-1.5">
                    <p className="text-sm font-semibold leading-tight line-clamp-1">{item.item_name}</p>
                    {item.description && (
                      <p className="text-[11px] text-muted-foreground line-clamp-2">{item.description}</p>
                    )}
                    <div>
                      <p className="text-sm font-bold text-emerald-600">
                        From {formatUGX(merchandiseInstallmentSchedule(Number(item.unit_price) || 0, 12).firstDaily)}/day
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        over up to 12 months · {formatUGX(Number(item.unit_price))} full price
                      </p>
                    </div>
                    {Array.isArray(item.sizes) && item.sizes.length > 0 && (
                      <p className="text-[10px] text-muted-foreground">
                        Sizes in stock: {item.sizes.join(', ')}
                      </p>
                    )}
                    <div className="flex gap-1.5">
                      <Button
                        size="sm"
                        className="flex-1 h-8 text-xs gap-1"
                        onClick={(e) => { e.stopPropagation(); setSelected(item); setQuantity('1'); setSelectedSize(null); }}
                      >
                        <ShoppingBag className="h-3.5 w-3.5" /> Buy
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-8 w-8 p-0 shrink-0"
                        aria-label={`Share ${item.item_name}`}
                        onClick={(e) => { e.stopPropagation(); handleShare(item); }}
                      >
                        <Share2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
                );
              })}
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between mt-3 text-xs">
                <Button variant="outline" size="sm" className="h-7" disabled={safePage <= 1} onClick={() => setCatalogPage(safePage - 1)}>Previous</Button>
                <span className="text-muted-foreground">Page {safePage} of {totalPages}</span>
                <Button variant="outline" size="sm" className="h-7" disabled={safePage >= totalPages} onClick={() => setCatalogPage(safePage + 1)}>Next</Button>
              </div>
            )}
            </>
          )}
        </div>

        {/* Recent deductions */}
        {deductions.length > 0 && (
          <div>
            <h2 className="text-sm font-bold mb-2 flex items-center gap-2">
              <Repeat className="h-4 w-4 text-primary" /> Wallet deductions for merchandise
            </h2>
            <Card>
              <CardContent className="p-0 divide-y divide-border/60">
                {deductions.map((d) => (
                  <div key={d.id} className="flex items-center justify-between px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-medium line-clamp-1">{d.item_name || 'Merchandise'}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {d.created_at ? format(new Date(d.created_at), 'dd MMM yyyy, HH:mm') : ''}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-xs font-semibold text-destructive">- {formatUGX(Number(d.amount))}</p>
                      <p className="text-[10px] text-muted-foreground">Left: {formatUGX(Number(d.outstanding_after))}</p>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}

        {/* My orders (plans) */}
        {plans.length > 0 && (
          <div>
            <h2 className="text-sm font-bold mb-2">My merchandise orders</h2>
            <Card>
              <CardContent className="p-0 divide-y divide-border/60">
                {plans.map((p) => (
                  <div key={p.id} className="px-3 py-2.5">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium">{p.item_name}</p>
                      <Badge variant={p.status === 'completed' ? 'default' : 'secondary'} className="text-[10px]">
                        {p.status === 'completed' ? 'Paid off' : 'Repaying'}
                      </Badge>
                    </div>
                    <div className="flex items-center justify-between mt-1 text-[11px] text-muted-foreground">
                      <span>Cost {formatUGX(Number(p.original_amount))}</span>
                      <span className="text-emerald-600">Repaid {formatUGX(Number(p.amount_recovered))}</span>
                      <span className="text-amber-600">Left {formatUGX(Number(p.outstanding_balance))}</span>
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* Order confirm dialog */}
      <Dialog open={!!selected} onOpenChange={(o) => { if (!o) { setSelected(null); setConfirmStep(false); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{confirmStep ? 'Confirm your purchase' : 'How would you like to pay?'}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                {pickImage(selected) ? (
                  <StorageImage src={pickImage(selected)} alt={selected.item_name} className="w-14 h-14 rounded-lg object-cover" />
                ) : (
                  <div className="w-14 h-14 rounded-lg bg-muted flex items-center justify-center">
                    <Package className="h-6 w-6 text-muted-foreground/40" />
                  </div>
                )}
                <div>
                  <p className="font-semibold text-sm">{selected.item_name}</p>
                  <p className="text-xs text-muted-foreground">{formatUGX(Number(selected.unit_price))} each</p>
                  {needsSize && selectedSize && (
                    <p className="text-xs font-medium text-primary">Size {selectedSize}</p>
                  )}
                </div>
              </div>
              {!confirmStep && (
              <>
              {needsSize && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Choose your size</Label>
                    <span className="text-[10px] text-muted-foreground">In stock now</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {availableSizes.map((s) => (
                      <button
                        key={s}
                        type="button"
                        onClick={() => setSelectedSize(s)}
                        aria-pressed={selectedSize === s}
                        className={`min-w-[44px] rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${
                          selectedSize === s
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border hover:border-primary/50'
                        }`}
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                  {sizeMissing && (
                    <p className="text-[11px] text-muted-foreground">
                      Pick a size to continue — only the sizes shown are available in stock.
                    </p>
                  )}
                </div>
              )}
              <div className="space-y-1">
                <Label className="text-xs">Quantity</Label>
                <Input
                  type="number"
                  min={1}
                  step={1}
                  pattern="[0-9]*"
                  inputMode="numeric"
                  value={quantity}
                  onChange={(e) => {
                    const raw = e.target.value;
                    const digits = raw.replace(/[^0-9]/g, '');
                    setQuantity(digits === '' ? '' : String(parseInt(digits, 10)));
                  }}
                />
              </div>
              <div className="grid gap-2">
                <button
                  type="button"
                  onClick={() => setPayMode('full')}
                  className={`text-left rounded-xl border px-3 py-2.5 transition ${payMode === 'full' ? 'border-primary bg-primary/5' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Buy now (pay in full)</span>
                    {payMode === 'full' && <CheckCircle2 className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {formatUGX(orderTotal)} is debited from your wallet immediately. Nothing to owe.
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => setPayMode('installment')}
                  className={`text-left rounded-xl border px-3 py-2.5 transition ${payMode === 'installment' ? 'border-primary bg-primary/5' : 'border-border'}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-semibold">Pay in installments</span>
                    {payMode === 'installment' && <CheckCircle2 className="h-4 w-4 text-primary" />}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Spread the {formatUGX(orderTotal)} over 1 to 12 months. Nothing is taken now — a small
                    amount is collected from your wallet each day, and it gets smaller every month.
                  </p>
                </button>
              </div>

              {payMode === 'installment' && (
                <div className="space-y-2 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2.5">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Repayment period</Label>
                    <span className="text-[10px] text-muted-foreground">Up to 12 months</span>
                  </div>
                  <Input
                    type="number"
                    min={1}
                    max={12}
                    step={1}
                    inputMode="numeric"
                    value={termMonths}
                    onChange={(e) => {
                      const raw = e.target.value.replace(/[^0-9]/g, '');
                      if (raw === '') return;
                      const n = Math.max(1, Math.min(12, parseInt(raw, 10)));
                      setTermMonths(n);
                    }}
                  />
                  {termSchedule && (
                    <div className="text-center space-y-0.5 pt-1">
                      <p className="text-[11px] text-muted-foreground">Daily from your wallet — first month</p>
                      <p className="text-2xl font-bold tabular-nums text-primary">
                        {formatUGX(termFirstDaily)}<span className="text-sm font-medium">/day</span>
                      </p>
                      <p className="text-[11px] text-muted-foreground">
                        Falls to {formatUGX(termLastDaily)}/day in your last month · {termMonths} month
                        {termMonths === 1 ? '' : 's'} · {formatUGX(termTotalRepayable)} in total
                      </p>
                    </div>
                  )}
                </div>
              )}
              </>
              )}
              <div className="rounded-lg bg-muted/50 px-3 py-2 flex justify-between text-sm">
                <span className="text-muted-foreground">Wallet balance</span>
                <span className="font-semibold">
                  {walletLoading ? 'Checking…' : walletError ? 'Unavailable' : formatUGX(availableWallet)}
                </span>
              </div>

              <div className={`rounded-lg px-3 py-2 flex justify-between text-sm ${insufficient ? 'bg-destructive/10 text-destructive' : 'bg-primary/5 text-foreground'}`}>
                <span className="text-muted-foreground">{payMode === 'full' ? 'Total to debit now' : 'Due now'}</span>
                <span className="font-bold">{formatUGX(payMode === 'full' ? orderTotal : 0)}</span>
              </div>
              {payMode === 'installment' && (
                <>
                  <div className="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 flex gap-2 text-[11px] text-muted-foreground">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                    <p>
                      <span className="font-semibold text-foreground">Nothing is taken now.</span> Collection starts
                      from your wallet daily, and the daily amount drops each month as you pay the item down. You can
                      clear it early at any time.
                    </p>
                  </div>
                </>
              )}
              {walletError ? (
                <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 flex gap-2 text-[11px] text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <p>
                    <span className="font-semibold">We couldn't read your wallet balance.</span> Tap “Retry wallet check” — payment stays disabled until your real balance loads.
                  </p>
                </div>
              ) : walletLoading ? (
                <div className="rounded-lg bg-muted px-3 py-2 flex gap-2 text-[11px] text-muted-foreground">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <p>Checking your wallet balance…</p>
                </div>
              ) : insufficient ? (
                <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 flex gap-2 text-[11px] text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <p>
                    <span className="font-semibold">Amount exceeds your available wallet balance of {formatUGX(availableWallet)}.</span> Reduce the quantity or choose installments.
                  </p>
                </div>

              ) : confirmStep ? (
                <div className="rounded-lg bg-primary/5 border border-primary/20 px-3 py-2 text-[11px] text-muted-foreground">
                  {payMode === 'full' ? (
                    <>You are about to pay <span className="font-semibold text-foreground">{formatUGX(orderTotal)}</span> in
                    full for <span className="font-semibold text-foreground">{qty} × {selected.item_name}</span>. This is
                    debited from your withdrawable wallet immediately and cannot be undone here.</>
                  ) : (
                    <>You are starting a {termMonths}-month plan for <span className="font-semibold text-foreground">{qty} × {selected.item_name}</span> at
                    {' '}<span className="font-semibold text-foreground">{formatUGX(orderTotal)}</span>.
                    {' '}<span className="font-semibold text-foreground">Nothing is taken now</span>; about
                    {' '}<span className="font-semibold text-foreground">{formatUGX(termFirstDaily)}</span> a day comes
                    from your wallet in the first month and reduces after that, {formatUGX(termTotalRepayable)} in total.</>
                  )}
                  {' '}Marketing (CMO) sees this order and your payment plan.
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">
                  {payMode === 'full'
                    ? 'The full amount is debited from your withdrawable wallet right away.'
                    : 'Payments are collected from your withdrawable wallet daily over the period you choose.'}
                </p>
              )}
            </div>
          )}
          <DialogFooter>
            {confirmStep ? (
              <>
                <Button variant="outline" onClick={() => setConfirmStep(false)} disabled={ordering}>Back</Button>
                <Button onClick={placeOrder} disabled={ordering || walletBlocked || insufficient || sizeMissing}>
                  {ordering
                    ? 'Placing order…'
                    : walletLoading
                      ? 'Checking wallet…'
                      : walletError
                        ? 'Retry wallet check'
                        : zeroDown ? 'Yes, place order' : `Yes, pay ${formatUGX(dueNow)}`}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" onClick={() => setSelected(null)} disabled={ordering}>Cancel</Button>
                {walletError ? (
                  <Button variant="outline" onClick={() => refetchWallet()}>Retry wallet check</Button>
                ) : (
                  <Button onClick={() => setConfirmStep(true)} disabled={walletLoading || insufficient || sizeMissing}>
                    {walletLoading
                      ? 'Checking wallet…'
                      : insufficient ? 'Not enough balance' : sizeMissing ? 'Choose a size' : 'Review order'}
                  </Button>
                )}
              </>
            )}
          </DialogFooter>

        </DialogContent>
      </Dialog>

      {/* Smartphone order dialog */}
      {/* Purchase success receipt */}
      <Dialog open={!!success} onOpenChange={(o) => { if (!o) setSuccess(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" /> Order placed
            </DialogTitle>
          </DialogHeader>
          {success && (
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">
                Your order for <span className="font-semibold text-foreground">{success.itemName}</span>
                {success.quantity > 1 && <> × {success.quantity}</>} was successful.
              </p>
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Order total</span>
                  <span className="font-semibold">{formatUGX(success.total)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Paid now from wallet</span>
                  <span className="font-semibold">{formatUGX(success.paidNow)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Balance to recover</span>
                  <span className="font-semibold">{formatUGX(success.remaining)}</span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                {success.mode === 'full'
                  ? 'Paid in full — nothing more will be deducted for this item.'
                  : 'Future earnings will be used to clear the balance until it reaches zero. Track it under your recovery plans below.'}
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSuccess(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SmartphoneOrderDialog open={phoneOpen} onOpenChange={setPhoneOpen} userId={user?.id} />


      <SpiroBikeOrderDialog open={bikeOpen} onOpenChange={setBikeOpen} userId={user?.id} />

      {/* Share fallback dialog */}
      <Dialog open={!!shareItem} onOpenChange={(o) => { if (!o) setShareItem(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4 text-primary" /> Share {shareItem?.item_name}
            </DialogTitle>
          </DialogHeader>
          {shareItem && (() => {
            const { url } = buildShare(shareItem, 'link');
            const enc = encodeURIComponent;
            // Each channel carries its own src tag so analytics can attribute opens.
            const per = (src: string) => buildShare(shareItem, src);
            const wa = per('whatsapp');
            const fb = per('facebook');
            const tw = per('twitter');
            const tg = per('telegram');
            const li = per('linkedin');
            const em = per('email');
            const targets: { label: string; href: string; className: string }[] = [
              { label: 'WhatsApp', href: `https://wa.me/?text=${enc(wa.full)}`, className: 'bg-emerald-500 hover:bg-emerald-600 text-white' },
              { label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${enc(fb.url)}&quote=${enc(fb.text)}`, className: 'bg-blue-600 hover:bg-blue-700 text-white' },
              { label: 'X (Twitter)', href: `https://twitter.com/intent/tweet?text=${enc(tw.text)}&url=${enc(tw.url)}`, className: 'bg-black hover:bg-neutral-800 text-white' },
              { label: 'Telegram', href: `https://t.me/share/url?url=${enc(tg.url)}&text=${enc(tg.text)}`, className: 'bg-sky-500 hover:bg-sky-600 text-white' },
              { label: 'LinkedIn', href: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(li.url)}`, className: 'bg-[#0A66C2] hover:bg-[#004182] text-white' },
              { label: 'Email', href: `mailto:?subject=${enc(shareItem.item_name)}&body=${enc(em.full)}`, className: 'bg-muted hover:bg-muted/80 text-foreground' },
            ];
            return (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  {targets.map((t) => (
                    <a
                      key={t.label}
                      href={t.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`h-9 rounded-md text-xs font-semibold inline-flex items-center justify-center ${t.className}`}
                    >
                      {t.label}
                    </a>
                  ))}
                </div>
                <div className="rounded-md border bg-muted/40 px-2.5 py-2 text-[11px] break-all">
                  {url}
                </div>
                <Button size="sm" variant="outline" className="w-full h-8 text-xs" onClick={() => copyShareLink(shareItem)}>
                  Copy link
                </Button>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
