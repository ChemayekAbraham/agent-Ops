import { useState, useEffect, useMemo, Suspense } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { fetchWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { lazyWithRetry } from '@/lib/lazyWithRetry';

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
  ArrowLeft, ShoppingBag, Package, Wallet, CheckCircle2, Repeat, Smartphone, Bike, AlertCircle, Share2, Trash2, Clock, XCircle, Sparkles, ArrowRight, ShieldCheck,
  Search, Plus, X, Shirt,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchMyBikeLeases, type BikeLeaseRecord } from '@/hooks/useBikeLeases';
import { formatUGX } from '@/lib/rentCalculations';
import { merchandiseInstallmentSchedule } from '@/lib/merchandiseInstallments';
import { format } from 'date-fns';
import SmartphoneOrderStatus from '@/components/merchandise/SmartphoneOrderStatus';
import MerchandiseRepaymentPortfolio from '@/components/merchandise/MerchandiseRepaymentPortfolio';
import { useMerchandiseOrderLock } from '@/hooks/useMerchandiseOrderLock';
import { useDeleteMerchandiseApplication } from '@/hooks/useMerchandiseRepaymentPortfolio';
import BikeLeaseStatus from '@/components/merchandise/BikeLeaseStatus';

const SpiroBikeOrderDialog = lazyWithRetry(() => import('@/components/merchandise/SpiroBikeOrderDialog'));
const SmartphoneOrderDialog = lazyWithRetry(() => import('@/components/merchandise/SmartphoneOrderDialog'));

import { StorageImage } from '@/components/ui/StorageImage';
import { shortMerchandiseUrl, longMerchandiseUrl } from '@/lib/merchandiseShareLink';
import { useRestoreBodyPointerEvents } from '@/hooks/useRestoreBodyPointerEvents';
import spiroBikeAsset from '@/assets/spiro-bike.jpg.asset.json';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';
import { MyCategorisedOrdersNotice } from '@/components/merchandise/MyCategorisedOrdersNotice';

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
  sale_id: string | null;
  pricing_basis?: string | null;
  item_name: string;
  original_amount: number;
  outstanding_balance: number;
  amount_recovered: number;
  status: 'active' | 'completed' | 'cancelled';
  last_recovery_at: string | null;
  created_at: string;
  order_status: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
}

interface Deduction {
  id: string;
  item_name: string | null;
  amount: number;
  outstanding_after: number;
  created_at: string;
}

const PAGE_SIZE = 8;

const BIKE_KEYWORDS = ['spiro', 'bike', 'ekoride', 'ekocycle', 'commando', 'mocoo', 'electric', 'moto', 'ebike', 'scooter', 'boda'];
function isBikeItem(item: CatalogItem): boolean {
  const name = (item.item_name || '').toLowerCase();
  const desc = (item.description || '').toLowerCase();
  return BIKE_KEYWORDS.some((kw) => name.includes(kw) || desc.includes(kw));
}

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
  const deleteApplication = useDeleteMerchandiseApplication(user?.id);

  const [activeMainTab, setActiveMainTab] = useState<'store' | 'orders'>(() => {
    return searchParams.get('tab') === 'orders' ? 'orders' : 'store';
  });
  const [orderFilter, setOrderFilter] = useState<'all' | 'pending' | 'approved' | 'rejected'>('all');

  const { data: bikeOrders = [] } = useQuery<BikeLeaseRecord[]>({
    queryKey: ['my-bike-lease-orders', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      return (await fetchMyBikeLeases(user!.id)) as BikeLeaseRecord[];
    },
  });

  const [dismissedBikeIds, setDismissedBikeIds] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem(`welile_dismissed_bike_leases_${user?.id}`);
      return stored ? new Set(JSON.parse(stored)) : new Set();
    } catch {
      return new Set();
    }
  });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`welile_dismissed_bike_leases_${user?.id}`);
      if (stored) {
        setDismissedBikeIds(new Set(JSON.parse(stored)));
      }
    } catch {}
  }, [user?.id, bikeOrders]);

  const visibleBikeOrders = useMemo(
    () => bikeOrders.filter((b) => !dismissedBikeIds.has(b.id)),
    [bikeOrders, dismissedBikeIds],
  );

  const { data: phoneOrders = [] } = useQuery<any[]>({
    queryKey: ['my-smartphone-orders', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select('id, item_name, unit_price, order_status, created_at, tracking_reference, rejection_reason, rejected_at')
        .eq('customer_id', user!.id)
        .ilike('item_name', '%smartphone%')
        .order('created_at', { ascending: false });
      if (error) return [];
      return data || [];
    },
  });

  const [bikeOpen, setBikeOpen] = useState(false);
  const [catalogPage, setCatalogPage] = useState(1);
  const [shareItem, setShareItem] = useState<CatalogItem | null>(null);
  const [search, setSearch] = useState('');
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
      const rows = (data || []) as Omit<RecoveryPlan, 'order_status' | 'rejection_reason' | 'rejected_at'>[];
      const saleIds = rows.flatMap((row) => (row.sale_id ? [row.sale_id] : []));
      if (saleIds.length === 0) {
        return rows.map((row) => ({ ...row, order_status: null, rejection_reason: null, rejected_at: null }));
      }
      const { data: sales, error: salesError } = await db
        .from('merchandise_sales')
        .select('id, order_status, rejection_reason, rejected_at')
        .in('id', saleIds);
      if (salesError) throw salesError;
      const saleById = new Map<string, { order_status: string | null; rejection_reason: string | null; rejected_at: string | null }>(
        (sales || []).map((sale: any) => [sale.id, sale]),
      );
      return rows
        .filter((row) => !row.sale_id || saleById.has(row.sale_id))
        // Rejection cancels the recovery plan, but the agent must still see the
        // rejected application (with the reviewer's reason) — only hide plans
        // cancelled for any other reason (e.g. deleted applications).
        .filter((row) => {
          if (row.status !== 'cancelled') return true;
          return saleById.get(row.sale_id!)?.order_status === 'rejected';
        })
        .map((row) => {
          const sale = row.sale_id ? saleById.get(row.sale_id) : null;
          return {
            ...row,
            order_status: sale?.order_status ?? null,
            rejection_reason: sale?.rejection_reason ?? null,
            rejected_at: sale?.rejected_at ?? null,
          };
        }) as RecoveryPlan[];
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

  // Calculate order counts per category and status
  const safeBikeOrders = visibleBikeOrders || [];
  const safePhoneOrders = phoneOrders || [];
  const safePlans = plans || [];

  // Exclude bike leases and smartphones from generic merchandise plans to avoid double-counting
  const bikeSaleIds = useMemo(() => new Set(safeBikeOrders.map((b) => b.id).filter(Boolean)), [safeBikeOrders]);
  const phoneSaleIds = useMemo(() => new Set(safePhoneOrders.map((p) => p.id).filter(Boolean)), [safePhoneOrders]);

  const generalMerchandisePlans = useMemo(() => {
    return safePlans.filter((p) => {
      if (p.sale_id && (bikeSaleIds.has(p.sale_id) || phoneSaleIds.has(p.sale_id))) return false;
      const name = (p.item_name || '').toLowerCase();
      if (name.includes('bike') || name.includes('spiro') || p.pricing_basis === 'spiro_28pct_v2') return false;
      if (name.includes('smartphone') || name.includes('phone')) return false;
      return true;
    });
  }, [safePlans, bikeSaleIds, phoneSaleIds]);

  const pendingBikeCount = safeBikeOrders.filter((b) =>
    ['submitted', 'pending_approval', 'ops_approved', 'coo_approved'].includes(b?.order_status || ''),
  ).length;
  const approvedBikeCount = safeBikeOrders.filter((b) =>
    ['approved', 'completed'].includes(b?.order_status || ''),
  ).length;
  const rejectedBikeCount = safeBikeOrders.filter((b) =>
    ['rejected', 'failed'].includes(b?.order_status || ''),
  ).length;

  const pendingPhoneCount = safePhoneOrders.filter((p) =>
    ['submitted', 'pending_approval', 'coo_approved'].includes(p?.order_status || ''),
  ).length;
  const approvedPhoneCount = safePhoneOrders.filter((p) =>
    ['approved', 'processing', 'completed'].includes(p?.order_status || ''),
  ).length;
  const rejectedPhoneCount = safePhoneOrders.filter((p) =>
    ['rejected', 'failed'].includes(p?.order_status || ''),
  ).length;

  const pendingPlanCount = generalMerchandisePlans.filter((p) => p?.status === 'active' && p?.order_status === 'pending_approval').length;
  const approvedPlanCount = generalMerchandisePlans.filter((p) => p?.status === 'active' && p?.order_status !== 'rejected').length;
  const rejectedPlanCount = generalMerchandisePlans.filter((p) => p?.order_status === 'rejected').length;

  const totalPending = pendingBikeCount + pendingPhoneCount + pendingPlanCount;
  const totalApproved = approvedBikeCount + approvedPhoneCount + approvedPlanCount;
  const totalRejected = rejectedBikeCount + rejectedPhoneCount + rejectedPlanCount;
  const totalOrdersCount = safeBikeOrders.length + safePhoneOrders.length + generalMerchandisePlans.length;
  const hasOrders = totalOrdersCount > 0;

  useEffect(() => {
    const tabParam = searchParams.get('tab');
    if (tabParam === 'orders') {
      setActiveMainTab('orders');
    } else if (tabParam === 'store') {
      setActiveMainTab('store');
    }
  }, [searchParams]);

  const currentFilterCount = useMemo(() => {
    if (orderFilter === 'pending') return totalPending;
    if (orderFilter === 'approved') return totalApproved;
    if (orderFilter === 'rejected') return totalRejected;
    return totalOrdersCount;
  }, [orderFilter, totalPending, totalApproved, totalRejected, totalOrdersCount]);

  const filteredPlans = useMemo(() => {
    if (orderFilter === 'all') return generalMerchandisePlans;
    if (orderFilter === 'pending') {
      return generalMerchandisePlans.filter((p) => p?.status === 'active' && p?.order_status === 'pending_approval');
    }
    if (orderFilter === 'approved') {
      return generalMerchandisePlans.filter((p) => p?.status === 'active' && p?.order_status !== 'rejected');
    }
    if (orderFilter === 'rejected') {
      return generalMerchandisePlans.filter((p) => p?.order_status === 'rejected');
    }
    return generalMerchandisePlans;
  }, [generalMerchandisePlans, orderFilter]);

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

  const filteredCatalog = catalog.filter((item) => !isBikeItem(item));
  const totalPages = Math.max(1, Math.ceil(filteredCatalog.length / PAGE_SIZE));

  // Allocate the short code as soon as the share sheet opens so every channel
  // button carries the branded link.
  useEffect(() => {
    if (shareItem) void ensureShareCode(shareItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareItem]);
  const safePage = Math.min(catalogPage, totalPages);
  const catalogSlice = filteredCatalog.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Deep-link: /merchandise?item=<id> auto-opens the checkout for that product.
  // Bikes and motorbikes are excluded from the general grid and can only be
  // ordered through the dedicated electric-bike section.
  useEffect(() => {
    const itemId = searchParams.get('item');
    if (!itemId || filteredCatalog.length === 0 || selected) return;
    const match = filteredCatalog.find((c) => c.id === itemId);
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
  }, [filteredCatalog, searchParams]);

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



  const openItem = (item: CatalogItem) => {
    setSelected(item);
    setQuantity('1');
    setSelectedSize(null);
  };

  const goToOrders = () => {
    setActiveMainTab('orders');
    setSearchParams({ tab: 'orders' });
  };

  const goToStore = () => {
    setActiveMainTab('store');
    setSearchParams({});
  };

  const scrollToAllItems = () => {
    document.getElementById('merch-all-items')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const searchTerm = search.trim().toLowerCase();
  const searchResults = searchTerm
    ? filteredCatalog.filter((item) =>
        `${item.item_name} ${item.description ?? ''}`.toLowerCase().includes(searchTerm),
      )
    : null;
  const popularItems = filteredCatalog.slice(0, 6);

  const categories = [
    {
      key: 'phone',
      label: 'Smartphone',
      icon: Smartphone,
      tile: 'bg-violet-500/15 text-violet-600 dark:text-violet-300',
      onClick: () => (smartphoneRepaying ? goToOrders() : setPhoneOpen(true)),
    },
    {
      key: 'bike',
      label: 'E-bike',
      icon: Bike,
      tile: 'bg-orange-500/15 text-orange-600 dark:text-orange-300',
      onClick: () => setBikeOpen(true),
    },
    {
      key: 'gear',
      label: 'Branded gear',
      icon: Shirt,
      tile: 'bg-sky-500/15 text-sky-600 dark:text-sky-300',
      onClick: scrollToAllItems,
    },
    {
      key: 'orders',
      label: 'My orders',
      icon: Package,
      tile: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300',
      onClick: goToOrders,
    },
  ];

  const renderItemCard = (item: CatalogItem, layout: 'rail' | 'grid') => {
    const img = pickImage(item);
    const fromDaily = merchandiseInstallmentSchedule(Number(item.unit_price) || 0, 12).firstDaily;
    const sizes = Array.isArray(item.sizes) ? item.sizes : [];
    return (
      <div
        key={item.id}
        role="button"
        tabIndex={0}
        onClick={() => openItem(item)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openItem(item);
          }
        }}
        aria-label={`Buy ${item.item_name}`}
        className={cn(
          'group cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
          layout === 'rail' ? 'w-44 shrink-0 snap-start' : 'w-full',
        )}
      >
        <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-muted">
          {img ? (
            <StorageImage
              src={img}
              alt={item.item_name}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="h-full w-full flex items-center justify-center">
              <Package className="h-8 w-8 text-muted-foreground/40" />
            </div>
          )}
          <button
            type="button"
            aria-label={`Share ${item.item_name}`}
            onClick={(e) => { e.stopPropagation(); handleShare(item); }}
            className="absolute top-2 right-2 h-8 w-8 rounded-full bg-background/90 backdrop-blur flex items-center justify-center shadow-sm hover:bg-background transition-colors"
          >
            <Share2 className="h-3.5 w-3.5" />
          </button>
          <span
            aria-hidden="true"
            className="absolute bottom-2 right-2 h-9 w-9 rounded-full bg-background text-foreground shadow-md flex items-center justify-center transition-transform group-hover:scale-110"
          >
            <Plus className="h-5 w-5" />
          </span>
        </div>
        <div className="pt-2 px-0.5 space-y-0.5">
          <p className="text-sm font-semibold leading-tight line-clamp-1">{item.item_name}</p>
          <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">
            From {formatUGX(fromDaily)}/day
          </p>
          <p className="text-[11px] text-muted-foreground line-clamp-1">
            {formatUGX(Number(item.unit_price))} full price · up to 12 months
          </p>
          {sizes.length > 0 && (
            <p className="text-[11px] text-muted-foreground line-clamp-1">Sizes: {sizes.join(', ')}</p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-[100dvh] bg-background pb-24">
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border/60">
        <div className="max-w-lg mx-auto px-4 pt-2.5 pb-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate(-1)}
              aria-label="Back"
              className="shrink-0 h-9 w-9 -ml-2"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground leading-none">
                {activeMainTab === 'orders' ? 'Track leases, advances & repayments' : 'Paying from your wallet'}
              </p>
              <h1 className="mt-1 text-base font-bold truncate flex items-center gap-1.5">
                {activeMainTab === 'orders' ? (
                  'My Orders & Repayments'
                ) : (
                  <>
                    <Wallet className="h-4 w-4 text-primary shrink-0" />
                    <span className="truncate">
                      {walletLoading
                        ? 'Checking balance…'
                        : walletError
                          ? 'Balance unavailable'
                          : `${formatUGX(availableWallet)} available`}
                    </span>
                  </>
                )}
              </h1>
            </div>
            <button
              type="button"
              onClick={activeMainTab === 'orders' ? goToStore : goToOrders}
              aria-label={activeMainTab === 'orders' ? 'Back to store' : 'My orders'}
              className="relative h-10 w-10 shrink-0 rounded-full bg-muted/70 hover:bg-muted flex items-center justify-center transition-colors"
            >
              {activeMainTab === 'orders' ? <ShoppingBag className="h-5 w-5" /> : <Package className="h-5 w-5" />}
              {activeMainTab === 'store' && totalOrdersCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                  {totalOrdersCount}
                </span>
              )}
            </button>
          </div>
          {activeMainTab === 'store' && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search phones, jackets, polos…"
                aria-label="Search merchandise"
                className="h-11 rounded-full border-transparent bg-muted/70 pl-10 pr-10 text-sm focus-visible:bg-background"
              />
              {search && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 rounded-full flex items-center justify-center text-muted-foreground hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 pt-3 space-y-5">
        <MyCategorisedOrdersNotice userId={user?.id} />

        <div className="flex gap-2">
          {([
            { key: 'store', label: 'Store', icon: ShoppingBag, onClick: goToStore },
            { key: 'orders', label: 'My Orders', icon: Package, onClick: goToOrders },
          ] as const).map((tab) => {
            const active = activeMainTab === tab.key;
            const TabIcon = tab.icon;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={tab.onClick}
                className={cn(
                  'inline-flex items-center gap-1.5 h-9 px-4 rounded-full border text-xs font-semibold transition-colors',
                  active
                    ? 'bg-foreground text-background border-foreground'
                    : 'bg-background text-foreground border-border hover:bg-muted',
                )}
              >
                <TabIcon className="h-4 w-4" />
                {tab.label}
                {tab.key === 'orders' && totalOrdersCount > 0 && (
                  <span
                    className={cn(
                      'px-1.5 py-0.5 text-[10px] rounded-full font-bold',
                      active ? 'bg-background/20 text-background' : 'bg-primary/15 text-primary',
                    )}
                  >
                    {totalOrdersCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {activeMainTab === 'store' ? (
          searchResults ? (
            <section className="space-y-3">
              <p className="text-sm font-semibold">
                {searchResults.length} {searchResults.length === 1 ? 'result' : 'results'} for “{search.trim()}”
              </p>
              {searchResults.length === 0 ? (
                <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-1">
                  <p className="text-sm font-medium">Nothing matches that name</p>
                  <p className="text-xs text-muted-foreground">Try another word, or browse the store.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-x-3 gap-y-5">
                  {searchResults.map((item) => renderItemCard(item, 'grid'))}
                </div>
              )}
            </section>
          ) : (
          <>
            {/* Category rail */}
            <div className="-mx-4 px-4 flex gap-3 overflow-x-auto no-scrollbar">
              {categories.map((c) => {
                const CatIcon = c.icon;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={c.onClick}
                    className="flex w-[76px] shrink-0 flex-col items-center gap-1.5 rounded-2xl py-1 outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <span className={cn('h-14 w-14 rounded-2xl flex items-center justify-center transition-transform hover:scale-105', c.tile)}>
                      <CatIcon className="h-7 w-7" />
                    </span>
                    <span className="text-[11px] font-medium leading-tight text-center">{c.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Promo banners */}
            <div className="-mx-4 px-4 flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar">
              <div
                role="button"
                tabIndex={0}
                onClick={() => { if (!smartphoneRepaying) setPhoneOpen(true); }}
                onKeyDown={(e) => {
                  if ((e.key === 'Enter' || e.key === ' ') && !smartphoneRepaying) {
                    e.preventDefault();
                    setPhoneOpen(true);
                  }
                }}
                className={cn(
                  'snap-start shrink-0 w-[88%] min-h-[148px] flex overflow-hidden rounded-2xl border outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                  smartphoneRepaying
                    ? 'border-amber-500/25 bg-amber-500/10'
                    : 'border-teal-500/20 bg-teal-500/10 dark:bg-teal-500/15 cursor-pointer',
                )}
              >
                <div className="flex-1 min-w-0 p-4 flex flex-col justify-between gap-2">
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold text-primary">Agent Equipment Advance</p>
                    <p className="text-base font-bold leading-snug">Welile Smartphone, 0% cash down</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      A company-issued phone on credit, paid with automatic wallet deductions.
                    </p>
                  </div>
                  {smartphoneRepaying ? (
                    <span className="inline-flex w-fit items-center gap-1.5 h-8 px-3 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-300 text-xs font-bold">
                      <Clock className="h-3.5 w-3.5" /> In repayment
                    </span>
                  ) : (
                    <span className="inline-flex w-fit items-center gap-1.5 h-8 px-4 rounded-full bg-primary text-primary-foreground text-xs font-bold shadow-sm">
                      Order now <ArrowRight className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
                <img
                  src={smartphonePromoAsset.url}
                  alt="Welile Smartphone"
                  loading="lazy"
                  className="w-28 sm:w-32 shrink-0 object-cover"
                />
              </div>

              <div
                role="button"
                tabIndex={0}
                onClick={() => setBikeOpen(true)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setBikeOpen(true);
                  }
                }}
                className="snap-start shrink-0 w-[88%] min-h-[148px] flex overflow-hidden rounded-2xl border border-orange-500/20 bg-orange-500/10 dark:bg-orange-500/15 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <div className="flex-1 min-w-0 p-4 flex flex-col justify-between gap-2">
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold text-orange-600 dark:text-orange-300">Electric bike lease</p>
                    <p className="text-base font-bold leading-snug">Ride a Spiro or Mocoo e-bike</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Pick a model and lease term. Marketing confirms the price, then the bike is released.
                    </p>
                  </div>
                  <span className="inline-flex w-fit items-center gap-1.5 h-8 px-4 rounded-full bg-foreground text-background text-xs font-bold shadow-sm">
                    Apply <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </div>
                <img
                  src={spiroBikeAsset.url}
                  alt="Welile electric bike"
                  loading="lazy"
                  className="w-28 sm:w-32 shrink-0 object-cover"
                />
              </div>
            </div>

            {/* Popular rail */}
            {!catalogError && !loadingCatalog && popularItems.length > 0 && (
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-lg font-bold tracking-tight">Popular with agents</h2>
                  <button
                    type="button"
                    onClick={scrollToAllItems}
                    aria-label="See all items"
                    className="h-9 w-9 rounded-full bg-muted/70 hover:bg-muted flex items-center justify-center transition-colors"
                  >
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
                <div className="-mx-4 px-4 flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar pb-1">
                  {popularItems.map((item) => renderItemCard(item, 'rail'))}
                </div>
              </section>
            )}

            {/* All items */}
            <section id="merch-all-items" className="space-y-3 scroll-mt-32">
              <h2 className="text-lg font-bold tracking-tight">All items</h2>
              {catalogError ? (
                <div className="rounded-2xl border border-border bg-card p-6 text-center space-y-3">
                  <p className="text-sm text-muted-foreground">
                    We couldn't load the catalog. Please check your connection and try again.
                  </p>
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => refetchCatalog()}>
                    Retry
                  </Button>
                </div>
              ) : loadingCatalog ? (
                <div className="grid grid-cols-2 gap-3">
                  {[...Array(4)].map((_, i) => (
                    <SkeletonProductCard key={i} />
                  ))}
                </div>
              ) : filteredCatalog.length === 0 ? (
                <p className="text-xs text-muted-foreground py-6 text-center">No merchandise available right now.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-5">
                    {catalogSlice.map((item) => renderItemCard(item, 'grid'))}
                  </div>
                  {totalPages > 1 && (
                    <div className="flex items-center justify-between pt-1 text-xs">
                      <Button variant="outline" size="sm" className="h-8 rounded-full" disabled={safePage <= 1} onClick={() => setCatalogPage(safePage - 1)}>Previous</Button>
                      <span className="text-muted-foreground">Page {safePage} of {totalPages}</span>
                      <Button variant="outline" size="sm" className="h-8 rounded-full" disabled={safePage >= totalPages} onClick={() => setCatalogPage(safePage + 1)}>Next</Button>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
          )
        ) : (
          /* ORDERS TAB */
          <div className="space-y-4">
            {/* Status Filter Buttons */}
            <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
              <button
                type="button"
                onClick={() => setOrderFilter('all')}
                className={cn(
                  'px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border',
                  orderFilter === 'all'
                    ? 'bg-foreground text-background border-foreground shadow-sm'
                    : 'bg-muted/50 text-muted-foreground border-border/60 hover:text-foreground',
                )}
              >
                <span>All</span>
                <span
                  className={cn(
                    'px-1.5 py-0.2 text-[10px] rounded-full font-semibold',
                    orderFilter === 'all' ? 'bg-background/20 text-background' : 'bg-background text-foreground',
                  )}
                >
                  {totalOrdersCount}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOrderFilter('pending')}
                className={cn(
                  'px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border',
                  orderFilter === 'pending'
                    ? 'bg-amber-500 text-white border-amber-600 shadow-sm'
                    : 'bg-muted/50 text-muted-foreground border-border/60 hover:text-foreground',
                )}
              >
                <Clock className="h-3 w-3" />
                <span>Pending</span>
                <span
                  className={cn(
                    'px-1.5 py-0.2 text-[10px] rounded-full font-semibold',
                    orderFilter === 'pending' ? 'bg-black/20 text-white' : 'bg-amber-500/15 text-amber-600',
                  )}
                >
                  {totalPending}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOrderFilter('approved')}
                className={cn(
                  'px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border',
                  orderFilter === 'approved'
                    ? 'bg-emerald-600 text-white border-emerald-700 shadow-sm'
                    : 'bg-muted/50 text-muted-foreground border-border/60 hover:text-foreground',
                )}
              >
                <CheckCircle2 className="h-3 w-3" />
                <span>Approved</span>
                <span
                  className={cn(
                    'px-1.5 py-0.2 text-[10px] rounded-full font-semibold',
                    orderFilter === 'approved' ? 'bg-black/20 text-white' : 'bg-emerald-500/15 text-emerald-600',
                  )}
                >
                  {totalApproved}
                </span>
              </button>

              <button
                type="button"
                onClick={() => setOrderFilter('rejected')}
                className={cn(
                  'px-3 py-1.5 rounded-full text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border',
                  orderFilter === 'rejected'
                    ? 'bg-destructive text-destructive-foreground border-destructive shadow-sm'
                    : 'bg-muted/50 text-muted-foreground border-border/60 hover:text-foreground',
                )}
              >
                <XCircle className="h-3 w-3" />
                <span>Rejected</span>
                <span
                  className={cn(
                    'px-1.5 py-0.2 text-[10px] rounded-full font-semibold',
                    orderFilter === 'rejected' ? 'bg-black/20 text-destructive-foreground' : 'bg-destructive/15 text-destructive',
                  )}
                >
                  {totalRejected}
                </span>
              </button>
            </div>

            {/* My payments summary when viewing all or approved — unified mobile card */}
            {(orderFilter === 'all' || orderFilter === 'approved') && plans.length > 0 && totalOwing > 0 && (
              <div className="rounded-xl border border-border/80 bg-card p-3 shadow-xs">
                <div className="grid grid-cols-2 divide-x divide-border/60">
                  <div className="pr-3 space-y-0.5">
                    <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground flex items-center gap-1">
                      <Wallet className="h-3 w-3 text-amber-500" /> Still to Repay
                    </span>
                    <p className="text-base sm:text-lg font-extrabold text-amber-600 dark:text-amber-400 tabular-nums">
                      {formatUGX(totalOwing)}
                    </p>
                  </div>
                  <div className="pl-3 space-y-0.5">
                    <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground flex items-center gap-1">
                      <CheckCircle2 className="h-3 w-3 text-emerald-500" /> Repaid So Far
                    </span>
                    <p className="text-base sm:text-lg font-extrabold text-emerald-600 dark:text-emerald-400 tabular-nums">
                      {formatUGX(totalRecovered)}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Spiro bike lease status */}
            <BikeLeaseStatus
              userId={user?.id}
              onRequestNewOrder={() => { setActiveMainTab('store'); setBikeOpen(true); }}
              filterStatus={orderFilter}
            />

            {/* Smartphone order status */}
            <SmartphoneOrderStatus
              userId={user?.id}
              onRequestNewOrder={() => { setActiveMainTab('store'); setPhoneOpen(true); }}
              filterStatus={orderFilter}
            />

            {/* Products being repaid — plan + pay button per product */}
            {(orderFilter === 'all' || orderFilter === 'approved') && (
              <MerchandiseRepaymentPortfolio userId={user?.id} />
            )}

            {/* Filtered Merchandise item orders */}
            {filteredPlans.length > 0 && (
              <div>
                <h2 className="text-sm font-bold mb-2">Merchandise item orders</h2>
                <Card>
                  <CardContent className="p-0 divide-y divide-border/60">
                    {filteredPlans.map((p) => {
                      const isRejected = p.order_status === 'rejected';
                      return (
                        <div key={p.id} className="px-3 py-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-medium">{p.item_name}</p>
                            {isRejected ? (
                              <Badge variant="destructive" className="text-[10px]">Application Rejected</Badge>
                            ) : (
                              <Badge variant={p.status === 'completed' ? 'default' : 'secondary'} className="text-[10px]">
                                {p.status === 'completed' ? 'Paid off' : 'Repaying'}
                              </Badge>
                            )}
                          </div>
                          {isRejected ? (
                            <div className="mt-1.5 space-y-1.5">
                              <p className="text-[11px] text-destructive">
                                {p.rejection_reason || 'No reason was recorded. Please contact support.'}
                              </p>
                              {p.rejected_at && (
                                <p className="text-[10px] text-muted-foreground">
                                  Rejected {format(new Date(p.rejected_at), 'dd MMM yyyy')}
                                </p>
                              )}
                              <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                className="h-7 text-[11px] text-destructive border-destructive/40 hover:bg-destructive/10"
                                disabled={deleteApplication.isPending}
                                onClick={() =>
                                  deleteApplication.mutate(p as any, {
                                    onSuccess: () => toast.success('Application removed.'),
                                    onError: (e) => toast.error(e.message || 'Could not remove the application.'),
                                  })
                                }
                              >
                                <Trash2 className="h-3 w-3 mr-1" />
                                Delete application
                              </Button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-between mt-1 text-[11px] text-muted-foreground">
                              <span>Cost {formatUGX(Number(p.original_amount))}</span>
                              <span className="text-emerald-600">Repaid {formatUGX(Number(p.amount_recovered))}</span>
                              <span className="text-amber-600">Left {formatUGX(Number(p.outstanding_balance))}</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </div>
            )}

            {/* Empty state when the selected filter has 0 items */}
            {currentFilterCount === 0 && (
              <Card className="border-dashed border-border/70 p-8 text-center bg-muted/20">
                <div className="flex flex-col items-center justify-center space-y-2">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground">
                    {orderFilter === 'pending' && <Clock className="h-5 w-5 text-amber-500" />}
                    {orderFilter === 'approved' && <CheckCircle2 className="h-5 w-5 text-emerald-500" />}
                    {orderFilter === 'rejected' && <XCircle className="h-5 w-5 text-rose-500" />}
                    {orderFilter === 'all' && <Package className="h-5 w-5 text-muted-foreground" />}
                  </div>
                  <p className="text-sm font-semibold capitalize">
                    No {orderFilter === 'all' ? '' : orderFilter} orders
                  </p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    {orderFilter === 'rejected'
                      ? 'You have no rejected merchandise or bike applications.'
                      : orderFilter === 'pending'
                      ? 'You have no orders currently pending review or approval.'
                      : orderFilter === 'approved'
                      ? 'You have no approved or active orders.'
                      : 'You have not placed any merchandise orders yet.'}
                  </p>
                  {orderFilter !== 'all' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2 text-xs h-7"
                      onClick={() => setOrderFilter('all')}
                    >
                      View all orders ({totalOrdersCount})
                    </Button>
                  )}
                </div>
              </Card>
            )}

            {/* Recent deductions for merchandise (when on all or approved) */}
            {(orderFilter === 'all' || orderFilter === 'approved') && deductions.length > 0 && (
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
                      const last = raw.slice(-1);
                      const candidate = parseInt(raw, 10) > 12 ? parseInt(last, 10) || 1 : parseInt(raw, 10);
                      const n = Math.max(1, Math.min(12, candidate));
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

      <Suspense fallback={null}>
        {phoneOpen && (
          <SmartphoneOrderDialog open={phoneOpen} onOpenChange={setPhoneOpen} userId={user?.id} />
        )}
        {bikeOpen && (
          <SpiroBikeOrderDialog open={bikeOpen} onOpenChange={setBikeOpen} userId={user?.id} />
        )}
      </Suspense>

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
