import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import { Checkbox } from '@/components/ui/checkbox';
import { Smartphone, AlertTriangle, Loader2, Check, Plus, Search, ArrowLeft, ShoppingCart, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { useSmartphoneCatalog, type SmartphoneOsType, type SmartphoneCatalogEntry } from '@/components/executive/agent-ops/SmartphoneCatalogDialog';
import { SMARTPHONE_PERIODS as PERIODS, smartphoneSchedule } from '@/lib/smartphoneAdvance';
import { downPaymentCopy } from '@/lib/moBanjaIphone';
import { SmartphoneProductImage } from './SmartphoneProductImage';

const db = supabase as any;

interface Eligibility {
  user_id: string;
  rank: number | null;
  collected_30d: number;

  active_tenant_count?: number;
  required_active_tenants?: number;
  has_national_id: boolean;
  has_workplace_verification: boolean;
  has_open_application: boolean;
  has_active_advance?: boolean;
  advance_outstanding?: number;
  eligible: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}

/** Longest repayment period: its first-month daily is the lowest an agent can start on. */
const LONGEST_MONTHS = PERIODS[PERIODS.length - 1].months;

/**
 * Agent Smartphone Advance application. Open to agents and sub-agents with at
 * least 3 active tenants on the Welile network. Every active catalog phone is selectable.
 * Every active, priced model is offered; Agent Ops assigns the supplier to the
 * order after submission. The applicant sees the daily
 * amount, the chosen period and the terms — never the internal programme charge.
 */
export default function SmartphoneOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const [osType, setOsType] = useState<SmartphoneOsType>('android');
  const [catalogId, setCatalogId] = useState('');
  const [months, setMonths] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<'full' | 'installments'>('installments');
  const [submitting, setSubmitting] = useState(false);
  const [docsReady, setDocsReady] = useState(false);
  const [phoneSearch, setPhoneSearch] = useState('');
  // Product page shown inside the sheet; the "cart" is the selected catalogId
  // (an application is for one phone, so the cart holds one item).
  const [detailId, setDetailId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const listScrollTop = useRef(0);
  const checkoutRef = useRef<HTMLDivElement>(null);

  const { data: eligibility, isLoading: eligLoading } = useQuery<Eligibility | null>({
    queryKey: ['smartphone-eligibility', userId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await db.rpc('get_agent_smartphone_eligibility', { p_user_id: null });
      if (error) throw error;
      return (data || null) as Eligibility | null;
    },
  });

  const { data: catalog = [], isLoading: catalogLoading } = useSmartphoneCatalog();

  const isIOSDevice = (c: SmartphoneCatalogEntry) =>
    c.os_type === 'ios' ||
    c.brand.trim().toLowerCase() === 'apple' ||
    c.brand.trim().toLowerCase().startsWith('iphone');

  const options = useMemo(
    () =>
      catalog
        .filter((c) => c.is_active && Number(c.default_amount || 0) > 0)
        .filter((c) => (osType === 'ios' ? isIOSDevice(c) : !isIOSDevice(c))),
    [catalog, osType],
  );

  // Display-only: how many models each tab holds, and the search filter over the grid.
  const osCounts = useMemo(() => {
    const offered = catalog.filter((c) => c.is_active && Number(c.default_amount || 0) > 0);
    const ios = offered.filter(isIOSDevice).length;
    return { ios, android: offered.length - ios };
  }, [catalog]);

  const searchTerm = phoneSearch.trim().toLowerCase();
  const visibleOptions = searchTerm
    ? options.filter((c) =>
        `${c.brand} ${c.model_name ?? ''} ${c.specifications ?? ''}`.toLowerCase().includes(searchTerm),
      )
    : options;

  const selected = options.find((c) => c.id === catalogId);
  const dpCopy = downPaymentCopy(selected?.brand ?? (osType === 'ios' ? 'Apple' : 'Android'), selected?.model_name);
  const price = Math.max(0, Math.round(Number(selected?.default_amount ?? 0)));
  const cashTopUp = Math.round(price / 2);
  const totalOnCollection = price + cashTopUp;

  useEffect(() => {
    setCatalogId('');
  }, [osType]);

  // Deductions begin 7 days after the phone is released, so the schedule the
  // applicant sees is anchored there too.
  const startDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }, []);

  const period = months ? PERIODS.find((p) => String(p.months) === months) : undefined;
  const schedule = period ? smartphoneSchedule(price, period.months, startDate) : null;
  const totalRepayable = schedule?.total ?? 0;
  const dailyAmount = schedule?.daily ?? 0;
  const lastDaily = schedule?.dailyLast ?? 0;
  const scheduleDays = schedule?.days ?? 0;
  const scheduleRows = schedule?.schedule.rows ?? [];

  // Applications are open to every agent — only a duplicate open application
  // or a running advance repayment stops a submission. Portfolio and document
  // checks are review inputs shown to the Agent Ops manager, never a block here.
  const hasOpenApplication = !!eligibility?.has_open_application;
  const hasActiveAdvance = !!eligibility?.has_active_advance;
  const advanceOutstanding = Math.max(0, Math.round(Number(eligibility?.advance_outstanding ?? 0)));
  const blocked = hasOpenApplication || hasActiveAdvance;
  const canSubmit =
    !blocked && !!selected && price > 0 && docsReady && (paymentMethod === 'full' || !!period);

  const reset = () => {
    setOsType('android');
    setCatalogId('');
    setMonths('');
    setPaymentMethod('installments');
    setDocsReady(false);
    setPhoneSearch('');
    setDetailId(null);
  };

  const detail = detailId ? options.find((c) => c.id === detailId) ?? null : null;

  const openDetail = (id: string) => {
    listScrollTop.current = bodyRef.current?.scrollTop ?? 0;
    setDetailId(id);
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: 0 }));
  };

  const closeDetail = () => {
    setDetailId(null);
    requestAnimationFrame(() => bodyRef.current?.scrollTo({ top: listScrollTop.current }));
  };

  const addToCart = (c: SmartphoneCatalogEntry, goToCheckout: boolean) => {
    const replacing = !!selected && selected.id !== c.id;
    setCatalogId(c.id);
    toast.success(replacing ? `Cart updated: ${phoneName(c)}` : `${phoneName(c)} added to your cart`);
    if (goToCheckout) {
      setDetailId(null);
      requestAnimationFrame(() =>
        checkoutRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      );
    }
  };

  const submit = async () => {
    if (!selected) {
      toast.error('Select a phone from the catalogue');
      return;
    }
    if (paymentMethod === 'installments' && !period) {
      toast.error('Choose a repayment period');
      return;
    }
    setSubmitting(true);
    const { error } =
      paymentMethod === 'full'
        ? await db.rpc('agent_order_smartphone_full', { p_catalog_id: selected.id })
        : await db.rpc('agent_order_smartphone', {
            p_catalog_id: selected.id,
            p_period_months: period!.months,
          });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'Could not submit your application');
      return;
    }
    toast.success('Application submitted for Agent Ops review.');
    reset();
    onOpenChange(false);
    queryClient.invalidateQueries({ queryKey: ['smartphone-eligibility', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-plans', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-deductions', userId] });
  };

  const phoneName = (c: SmartphoneCatalogEntry) => [c.brand, c.model_name].filter(Boolean).join(' ');

  const footerHint = !selected
    ? 'Pick a phone to continue'
    : paymentMethod === 'full'
      ? `${formatUGX(price)} due in full`
      : period && dailyAmount > 0
        ? `${formatUGX(dailyAmount)}/day · ${period.months} month${period.months === 1 ? '' : 's'}`
        : 'Choose a repayment period';

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (submitting) return;
        if (!o) setDetailId(null);
        onOpenChange(o);
      }}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          // On a product page, Escape goes back to the list instead of closing the sheet.
          if (detailId) {
            e.preventDefault();
            closeDetail();
          }
        }}
        className={[
          // Mobile: full-width bottom sheet with its own scroll and a sticky action bar.
          // Desktop: the standard centered card.
          'app-dialog-bottom-sheet',
          '!left-0 !right-0 !top-auto !bottom-0',
          '!translate-x-0 !translate-y-0',
          '!max-w-none !w-full',
          '!rounded-t-3xl !rounded-b-none',
          '!p-0 !gap-0',
          'h-[92dvh] !max-h-[92dvh]',
          'flex flex-col !overflow-hidden',
          'sm:!left-[50%] sm:!top-[50%] sm:!bottom-auto sm:!right-auto',
          'sm:!translate-x-[-50%] sm:!translate-y-[-50%]',
          'sm:!max-w-md sm:!w-full',
          'sm:!rounded-2xl',
          'sm:h-auto sm:!max-h-[90vh]',
        ].join(' ')}
      >
        <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
          <span className="h-1.5 w-10 rounded-full bg-muted-foreground/30" />
        </div>

        <DialogHeader className="shrink-0 px-5 pt-2 sm:pt-5 pb-3 pr-14 text-left">
          {detail ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={closeDetail}
                aria-label="Back to all phones"
                className="-ml-2 flex h-10 w-10 shrink-0 items-center justify-center rounded-full hover:bg-muted transition-colors"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <DialogTitle className="truncate text-lg font-bold tracking-tight">{phoneName(detail)}</DialogTitle>
            </div>
          ) : (
            <>
              <DialogTitle className="flex items-center gap-2 text-lg font-bold tracking-tight">
                <Smartphone className="h-5 w-5 text-primary" /> Pick your phone
              </DialogTitle>
              <p className="text-xs text-muted-foreground">
                Welile funds the down payment. You pay it back daily from your wallet.
              </p>
            </>
          )}
        </DialogHeader>

        <div ref={bodyRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 pb-5 space-y-5">
          {detail ? (
            (() => {
              const dPrice = Math.max(0, Math.round(Number(detail.default_amount || 0)));
              const dFromDaily = smartphoneSchedule(dPrice, LONGEST_MONTHS, startDate).daily;
              const dCopy = downPaymentCopy(detail.brand, detail.model_name);
              const dIos = isIOSDevice(detail);
              const specs = [detail.specifications, detail.more_specifications].filter(Boolean) as string[];
              const highlights = (detail.highlights ?? []).filter(Boolean);
              return (
                <div key={detail.id} className="space-y-5 animate-in fade-in-50 slide-in-from-right-4 duration-200">
                  <div className="relative">
                    <SmartphoneProductImage
                      imageUrl={detail.image_url}
                      brand={detail.brand}
                      model={detail.model_name}
                      ios={dIos}
                      className="aspect-square w-full rounded-3xl"
                    />
                    {detail.id === catalogId && (
                      <span className="absolute left-3 top-3 inline-flex items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-[11px] font-bold text-primary-foreground shadow-sm">
                        <Check className="h-3.5 w-3.5" /> In your cart
                      </span>
                    )}
                  </div>

                  <div className="space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      <span className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold">
                        {dIos ? 'iPhone · iOS' : 'Android'}
                      </span>
                      {specs.map((s) => (
                        <span key={s} className="rounded-full bg-muted px-2.5 py-1 text-[11px] font-semibold">
                          {s}
                        </span>
                      ))}
                    </div>
                    <h2 className="text-2xl font-bold leading-tight tracking-tight">{phoneName(detail)}</h2>
                  </div>

                  <div className="rounded-2xl border border-border bg-card p-4 space-y-1">
                    <p className="text-xs text-muted-foreground">{dCopy.amountLabelShort} Welile funds</p>
                    <p className="text-2xl font-bold tabular-nums">{formatUGX(dPrice)}</p>
                    {dFromDaily > 0 && (
                      <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                        From {formatUGX(dFromDaily)}/day over {LONGEST_MONTHS} months
                      </p>
                    )}
                    <p className="pt-1 text-[11px] text-muted-foreground">
                      Bring {formatUGX(Math.round(dPrice / 2))} in cash on collection day (half of the down payment).
                    </p>
                  </div>

                  <section className="space-y-2">
                    <h3 className="text-base font-bold">About this phone</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {detail.description ||
                        `The ${phoneName(detail)} is available through the Welile smartphone advance. Agent Ops can add a full description in the phone catalog.`}
                    </p>
                  </section>

                  {highlights.length > 0 && (
                    <section className="space-y-2">
                      <h3 className="text-base font-bold">Key features</h3>
                      <ul className="divide-y divide-border rounded-2xl border border-border bg-card">
                        {highlights.map((h) => (
                          <li key={h} className="flex items-start gap-2.5 px-3.5 py-2.5 text-sm">
                            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                            <span>{h}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  )}

                  <section className="space-y-2">
                    <h3 className="text-base font-bold">How it works</h3>
                    <ol className="space-y-2.5">
                      {[
                        'Add the phone to your cart, choose daily installments or full payment, and submit.',
                        'Agent Ops reviews your application and pays the supplier directly.',
                        'Collect the phone with your National ID, a workplace photo and your cash top-up.',
                        'Daily deductions start 7 days after the phone is released.',
                      ].map((step, i) => (
                        <li key={step} className="flex gap-3 text-sm">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                            {i + 1}
                          </span>
                          <span className="pt-0.5 text-muted-foreground">{step}</span>
                        </li>
                      ))}
                    </ol>
                  </section>

                  {selected && selected.id !== detail.id && (
                    <p className="rounded-2xl bg-amber-500/10 p-3 text-[11px] text-amber-700 dark:text-amber-300">
                      Your cart holds one phone. Adding this one replaces the {phoneName(selected)}.
                    </p>
                  )}
                </div>
              );
            })()
          ) : (
          <>
          {eligLoading ? (
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your profile…
            </p>
          ) : hasOpenApplication ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3 space-y-1">
              <p className="text-xs font-semibold flex items-center gap-1.5 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Application in progress
              </p>
              <p className="text-[11px] text-muted-foreground">
                You already have a smartphone application under review. You can apply again once it is
                decided.
              </p>
            </div>
          ) : hasActiveAdvance ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-3 space-y-1">
              <p className="text-xs font-semibold flex items-center gap-1.5 text-destructive">
                <AlertTriangle className="h-3.5 w-3.5" /> Clear your advance first
              </p>
              <p className="text-[11px] text-muted-foreground">
                You still have an advance repayment running
                {advanceOutstanding > 0 ? ` (UGX ${advanceOutstanding.toLocaleString()} outstanding)` : ''}.
                You become eligible for a smartphone once the advance is fully cleared.
              </p>
            </div>
          ) : null}

          {/* Phone type chips */}
          <div role="tablist" aria-label="Phone type" className="flex gap-2">
            {(['android', 'ios'] as const).map((os) => {
              const active = osType === os;
              return (
                <button
                  key={os}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  disabled={blocked}
                  onClick={() => setOsType(os)}
                  className={cn(
                    'flex flex-1 items-center gap-2 rounded-full border py-1.5 pl-1.5 pr-4 text-sm font-semibold transition-colors disabled:opacity-50',
                    active
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border bg-card text-foreground hover:bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                      active ? 'bg-background/15' : 'bg-muted',
                    )}
                  >
                    <Smartphone className="h-4 w-4" />
                  </span>
                  <span className="truncate">{os === 'ios' ? 'iPhone' : 'Android'}</span>
                  <span className={cn('ml-auto text-xs font-medium', active ? 'text-background/70' : 'text-muted-foreground')}>
                    {os === 'ios' ? osCounts.ios : osCounts.android}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Product grid */}
          <section className="space-y-3">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-base font-bold tracking-tight">
                {osType === 'ios' ? 'iPhones' : 'Android phones'}
              </h3>
              {!catalogLoading && options.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  {visibleOptions.length} model{visibleOptions.length === 1 ? '' : 's'}
                </span>
              )}
            </div>

            {options.length > 6 && (
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  value={phoneSearch}
                  onChange={(e) => setPhoneSearch(e.target.value)}
                  placeholder={`Search ${osType === 'ios' ? 'iPhone' : 'Android'} models`}
                  aria-label="Search phone models"
                  className="h-10 rounded-full border-transparent bg-muted/70 pl-10 text-base sm:text-sm focus-visible:bg-background"
                />
              </div>
            )}

            {catalogLoading ? (
              <div className="grid grid-cols-2 gap-3">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="space-y-2 rounded-3xl border border-border/60 p-1.5">
                    <div className="aspect-square w-full animate-pulse rounded-[20px] bg-muted" />
                    <div className="mx-1.5 h-3 w-3/4 animate-pulse rounded bg-muted" />
                    <div className="mx-1.5 mb-1.5 h-3 w-1/2 animate-pulse rounded bg-muted" />
                  </div>
                ))}
              </div>
            ) : options.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border p-6 text-center">
                <p className="text-sm font-medium">No {osType === 'ios' ? 'iPhone' : 'Android'} phones available</p>
                <p className="text-xs text-muted-foreground">Check the other phone type, or try again later.</p>
              </div>
            ) : visibleOptions.length === 0 ? (
              <p className="py-4 text-center text-xs text-muted-foreground">No models match “{phoneSearch.trim()}”.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {visibleOptions.map((c) => {
                  const isSelected = c.id === catalogId;
                  const cardPrice = Math.max(0, Math.round(Number(c.default_amount || 0)));
                  const fromDaily = smartphoneSchedule(cardPrice, LONGEST_MONTHS, startDate).daily;
                  return (
                    <div
                      key={c.id}
                      role="button"
                      tabIndex={0}
                      aria-label={`View ${phoneName(c)}`}
                      onClick={() => openDetail(c.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          openDetail(c.id);
                        }
                      }}
                      className={cn(
                        'group cursor-pointer rounded-3xl border bg-card p-1.5 text-left transition-all outline-none focus-visible:ring-2 focus-visible:ring-primary/50 active:scale-[0.98]',
                        isSelected
                          ? 'border-primary shadow-md ring-2 ring-primary/30'
                          : 'border-border/70 hover:border-primary/40 hover:shadow-sm',
                      )}
                    >
                      <div className="relative">
                        <SmartphoneProductImage
                          imageUrl={c.image_url}
                          brand={c.brand}
                          model={c.model_name}
                          ios={isIOSDevice(c)}
                          className="aspect-square w-full rounded-[20px]"
                        />
                        {isSelected && (
                          <span className="absolute left-2 top-2 rounded-full bg-primary px-2 py-0.5 text-[10px] font-bold text-primary-foreground shadow-sm">
                            In cart
                          </span>
                        )}
                        <button
                          type="button"
                          aria-label={isSelected ? `${phoneName(c)} is in your cart` : `Add ${phoneName(c)} to cart`}
                          disabled={blocked}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isSelected) openDetail(c.id);
                            else addToCart(c, false);
                          }}
                          className={cn(
                            'absolute bottom-2 right-2 flex h-9 w-9 items-center justify-center rounded-full shadow-md transition-all disabled:opacity-50',
                            isSelected
                              ? 'bg-primary text-primary-foreground scale-105'
                              : 'bg-background/95 text-foreground hover:scale-110',
                          )}
                        >
                          {isSelected ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                        </button>
                      </div>
                      <div className="space-y-0.5 px-1.5 pb-1.5 pt-2">
                        <p className="text-sm font-semibold leading-tight line-clamp-2">{phoneName(c)}</p>
                        {c.specifications && (
                          <p className="text-[11px] text-muted-foreground line-clamp-1">{c.specifications}</p>
                        )}
                        <p className="pt-1 text-sm font-bold tabular-nums">{formatUGX(cardPrice)}</p>
                        <p className="text-[11px] leading-snug text-muted-foreground line-clamp-2">
                          Offered by Welile as down payment
                        </p>
                        {fromDaily > 0 && (
                          <p className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                            From {formatUGX(fromDaily)}/day
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div ref={checkoutRef} className="scroll-mt-4" />

          {selected && price > 0 && (
            <div className="rounded-2xl border border-border bg-muted/40 p-3.5 space-y-2">
              <div className="flex items-center gap-3 pb-1">
                <SmartphoneProductImage
                  imageUrl={selected.image_url}
                  brand={selected.brand}
                  model={selected.model_name}
                  ios={isIOSDevice(selected)}
                  size="sm"
                  className="h-12 w-12 shrink-0 rounded-xl"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold truncate">{phoneName(selected)}</p>
                  {selected.specifications && (
                    <p className="text-[11px] text-muted-foreground truncate">{selected.specifications}</p>
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 text-muted-foreground">{dpCopy.amountLabelShort} Welile funds</span>
                <span className="shrink-0 font-bold tabular-nums">{formatUGX(price)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="min-w-0 text-muted-foreground">Cash you bring (50% of it)</span>
                <span className="shrink-0 font-bold tabular-nums text-primary">{formatUGX(cashTopUp)}</span>
              </div>
              <div className="flex items-center justify-between gap-3 border-t border-border pt-2 text-xs">
                <span className="min-w-0 font-semibold text-foreground">Total on collection day</span>
                <span className="shrink-0 font-bold tabular-nums">{formatUGX(totalOnCollection)}</span>
              </div>
              <p className="text-[11px] text-muted-foreground flex gap-1.5 pt-1 border-t border-border">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>
                  To qualify, come with an extra <span className="font-medium text-foreground">{formatUGX(cashTopUp)}</span> in
                  cash — half of the down payment. Welile funds the down payment and your cash top-up
                  reduces what you repay overall.
                </span>
              </p>
            </div>
          )}

          <div className="rounded-2xl border border-primary/30 bg-primary/5 p-3.5 space-y-2">
            <p className="text-xs font-semibold">
              {dpCopy.partner ? `How the ${dpCopy.partner} iPhone works` : 'How this phone works'}
            </p>
            <p className="text-[11px] text-muted-foreground">{dpCopy.amountNote}</p>
            <ul className="space-y-1 text-[11px] text-muted-foreground">
              {dpCopy.twoLegs.map((line) => (
                <li key={line} className="flex gap-1.5">
                  <span className="text-primary">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>
            {dpCopy.lockNotice && (
              <p className="text-[11px] text-muted-foreground flex gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                <span>{dpCopy.lockNotice}</span>
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label className="text-sm font-bold">Payment method</Label>
            <div role="radiogroup" aria-label="Payment method" className="flex rounded-full bg-muted/70 p-1">
              {([
                { key: 'installments', label: 'Daily installments' },
                { key: 'full', label: 'Full payment' },
              ] as const).map((m) => {
                const active = paymentMethod === m.key;
                return (
                  <button
                    key={m.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    disabled={blocked}
                    onClick={() => setPaymentMethod(m.key)}
                    className={cn(
                      'flex-1 rounded-full py-2 text-sm font-semibold transition-all disabled:opacity-50',
                      active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {m.label}
                  </button>
                );
              })}
            </div>
          </div>

          {paymentMethod === 'installments' && (
            <div className="space-y-2">
              <Label className="text-sm font-bold">Repayment period</Label>
              <div
                role="radiogroup"
                aria-label="Repayment period"
                className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 no-scrollbar"
              >
                {PERIODS.map((p) => {
                  const active = months === String(p.months);
                  return (
                    <button
                      key={p.months}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={blocked}
                      onClick={() => setMonths(String(p.months))}
                      className={cn(
                        'flex w-[68px] shrink-0 flex-col items-center rounded-2xl border py-2 transition-colors disabled:opacity-50',
                        active
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card hover:bg-muted',
                      )}
                    >
                      <span className="text-base font-bold leading-none">{p.months}</span>
                      <span className={cn('mt-1 text-[10px]', active ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                        month{p.months === 1 ? '' : 's'}
                      </span>
                      <span className={cn('text-[10px]', active ? 'text-primary-foreground/70' : 'text-muted-foreground')}>
                        {p.days} days
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {paymentMethod === 'full' && price > 0 && (
            <div className="rounded-2xl border border-border bg-muted/40 p-3.5 text-center space-y-1">
              <p className="text-xs text-muted-foreground">
                {dpCopy.amountLabel} — due in full
              </p>
              <p className="text-2xl font-bold tabular-nums">{formatUGX(price)}</p>
              <p className="text-[11px] text-muted-foreground">
                The full amount is collected from your Welile Wallet. No daily deductions.
              </p>
            </div>
          )}

          {paymentMethod === 'installments' && dailyAmount > 0 && (
            <div className="rounded-2xl border border-border bg-muted/40 p-3.5 space-y-2">
              <div className="text-center space-y-1">
                <p className="text-xs text-muted-foreground">
                  Daily repayment to Welile — first month
                </p>
                <p className="text-2xl font-bold tabular-nums text-green-600">
                  {formatUGX(dailyAmount)}
                  <span className="text-sm font-medium text-green-600">/day</span>
                </p>
                <p className="text-[11px] font-bold text-muted-foreground">
                  Reduces to {formatUGX(lastDaily)}/day in your last month · {scheduleDays} days ·{' '}
                  {formatUGX(totalRepayable)} in total. Deductions start 7 days after your phone is
                  released.
                  {` This covers the Welile down payment only — you also repay ${
                    dpCopy.partner ?? 'the supplier'
                  } on their own plan, directly to them.`}
                </p>
              </div>

              <div className="rounded-xl border border-border bg-background/60 overflow-hidden">
                <div className="grid grid-cols-3 gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <span>Month</span>
                  <span className="text-right">Amount</span>
                  <span className="text-right">Per day</span>
                </div>
                {scheduleRows.map((r) => (
                  <div
                    key={r.monthIndex}
                    className="grid grid-cols-3 gap-1 border-t border-border px-2 py-1.5 text-[11px] tabular-nums"
                  >
                    <span className="text-muted-foreground">Month {r.monthIndex}</span>
                    <span className="text-right font-medium">{formatUGX(r.totalDue)}</span>
                    <span className="text-right font-medium">{formatUGX(r.dailyDeduction)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-border bg-muted/30 p-4 space-y-3 text-sm">
            <h4 className="font-semibold">Terms &amp; Conditions</h4>
            <ol className="list-decimal pl-4 space-y-2 text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">Eligibility:</span> Open to active operational
                agents with 3+ active tenants and a National ID recorded on their Welile profile.
              </li>
              <li>
                <span className="font-medium text-foreground">Collection day:</span> you must present your
                National ID and a workplace photo. Both are captured and verified before the phone is released
                to you — no documents, no phone.
              </li>
              <li>
                <span className="font-medium text-foreground">Supplier:</span> Welile pays the registered
                supplier directly; you receive the phone, not cash.
              </li>
              <li>
                <span className="font-medium text-foreground">Cash top-up:</span> you must bring an extra
                50% of the down payment in cash on collection day. Welile funds the down payment; your cash
                top-up reduces the overall repayment burden.
              </li>
              <li>
                <span className="font-medium text-foreground">Repayment:</span> a daily amount is deducted
                from your Welile Wallet over the period you choose (1 to 12 months). The amount
                reduces every month as your balance comes down.
              </li>
              <li>
                <span className="font-medium text-foreground">Deductions start:</span> 7 days after your
                phone is released (grace period), then daily until cleared.
              </li>
              <li>
                <span className="font-medium text-foreground">Late charge:</span> once you are 30 days behind
                schedule, UGX 50,000 is added to your balance each month until you catch up.
              </li>
            </ol>
          </div>

          <div className="flex items-start gap-2 rounded-2xl border border-border bg-muted/30 p-3">
            <Checkbox
              id="docs-ready"
              checked={docsReady}
              onCheckedChange={(v) => setDocsReady(v === true)}
              disabled={blocked}
              className="mt-0.5"
            />
            <Label htmlFor="docs-ready" className="text-[11px] leading-snug text-muted-foreground font-normal cursor-pointer">
              I confirm I will present my <span className="font-medium text-primary">National ID</span> and a{' '}
              <span className="font-medium text-primary">workplace photo</span> for verification on phone
              collection day. The phone is not released without them.
            </Label>
          </div>

          <p className="text-[11px] text-muted-foreground">
            Your application is reviewed internally, then the supplier is paid directly.
            {paymentMethod === 'full'
              ? ' The full amount is collected from your Welile Wallet once your phone is released.'
              : ' Nothing is deducted from your wallet before your phone is released.'}
          </p>
          </>
          )}
        </div>

        {/* Sticky action bar */}
        {detail ? (
          <div className="shrink-0 border-t border-border bg-background/95 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] backdrop-blur">
            {detail.id === catalogId ? (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="h-12 rounded-full px-5"
                  onClick={() => {
                    setCatalogId('');
                    toast.success('Removed from your cart');
                  }}
                >
                  Remove
                </Button>
                <Button
                  className="h-12 flex-1 rounded-full font-semibold gap-2"
                  onClick={() => {
                    setDetailId(null);
                    requestAnimationFrame(() =>
                      checkoutRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                    );
                  }}
                >
                  <ShoppingCart className="h-4 w-4" /> Go to checkout
                </Button>
              </div>
            ) : (
              <Button
                className="h-12 w-full rounded-full font-semibold gap-2"
                disabled={blocked}
                onClick={() => addToCart(detail, true)}
              >
                <ShoppingCart className="h-4 w-4" />
                {selected ? 'Replace cart item' : 'Add to cart'}
                <span className="opacity-80">·</span>
                <span className="tabular-nums">{formatUGX(Math.max(0, Math.round(Number(detail.default_amount || 0))))}</span>
              </Button>
            )}
          </div>
        ) : (
        <div className="shrink-0 space-y-2.5 border-t border-border bg-background/95 px-5 pt-3 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] backdrop-blur">
          <div className="flex items-center gap-3">
            {selected ? (
              <SmartphoneProductImage
                imageUrl={selected.image_url}
                brand={selected.brand}
                model={selected.model_name}
                ios={isIOSDevice(selected)}
                size="sm"
                className="h-10 w-10 shrink-0 rounded-xl"
              />
            ) : (
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                <ShoppingCart className="h-5 w-5 text-muted-foreground" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{selected ? phoneName(selected) : 'Your cart is empty'}</p>
              <p className="truncate text-xs text-muted-foreground">{footerHint}</p>
            </div>
            {selected && (
              <button
                type="button"
                onClick={() => checkoutRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                aria-label="View cart"
                className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted hover:bg-muted/70"
              >
                <ShoppingCart className="h-5 w-5" />
                <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                  1
                </span>
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="h-11 rounded-full px-5"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button className="h-11 flex-1 rounded-full font-semibold" onClick={submit} disabled={submitting || !canSubmit}>
              {submitting ? 'Submitting…' : 'Submit application'}
            </Button>
          </div>
        </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
