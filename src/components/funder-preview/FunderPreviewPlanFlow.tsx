import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Home,
  Info,
  Loader2,
  Lock,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
  Wallet,
} from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewSelectionItem } from '@/components/funder-new/types';
import { FunderPreviewStepper } from './FunderPreviewStepper';
import { HOUSE_MIN_FUNDING, SupportSubmitError, type SupportSubmitResult } from './useFunderPreviewSupport';

type Step = 'review' | 'pay' | 'done';
type Sheet = null | 'confirm' | 'sending' | 'failed';

/** Snapshot taken at submit time: the page clears the plan once support is posted. */
interface Receipt {
  count: number;
  total: number;
  monthly: number;
  noun: string;
  names: string;
  reference: string | null;
}

const NEXT_STEPS = [
  { title: 'Operational review', text: 'The team checks your booking.' },
  { title: 'Homes go live', text: 'After approval, through the usual process.' },
  { title: 'Track your Rent profit share', text: 'In your portfolio, any time.' },
];

const primaryButton =
  'flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl bg-primary px-4 text-base font-semibold text-primary-foreground transition-transform active:scale-[0.99] disabled:bg-border disabled:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';
const quietButton =
  'flex h-12 w-full items-center justify-center rounded-2xl text-[15px] font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const sheetClass =
  "absolute inset-x-0 bottom-0 z-20 space-y-4 rounded-t-[28px] bg-card px-5 pb-[max(1.6rem,env(safe-area-inset-bottom))] pt-2.5";

function namesOf(items: FunderNewSelectionItem[]) {
  const names = items.map((item) =>
    item.category === 'ready' && item.tenantName ? item.tenantName.trim().split(/\s+/)[0] : item.title,
  );
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/**
 * Review → pay → confirm → done for the preview route. Mirrors the support
 * flow design: impact before price, the balance only at the pay step, one
 * deliberate confirm, honest waiting and honest failure.
 */
export function FunderPreviewPlanFlow({
  open,
  onOpenChange,
  items,
  capacity,
  capacityLoading,
  capacityError,
  onRetryCapacity,
  onRemove,
  onRestore,
  onKeepOnly,
  onSubmit,
  onTopUp,
  onViewPortfolio,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: FunderNewSelectionItem[];
  capacity: number | null;
  capacityLoading: boolean;
  capacityError: boolean;
  onRetryCapacity: () => void;
  onRemove: (item: FunderNewSelectionItem) => void;
  onRestore: (item: FunderNewSelectionItem) => void;
  onKeepOnly: (ids: string[]) => void;
  onSubmit: () => Promise<SupportSubmitResult>;
  onTopUp: (shortfall: number) => void;
  onViewPortfolio: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const [step, setStep] = useState<Step>('review');
  const [sheet, setSheet] = useState<Sheet>(null);
  const [agreed, setAgreed] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [failure, setFailure] = useState<{ message: string; nothingTaken: boolean } | null>(null);
  const doneHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const shortHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('review');
    setSheet(null);
    setAgreed(false);
    setReceipt(null);
    setFailure(null);
  }, [open]);

  useEffect(() => {
    if (step === 'done') doneHeadingRef.current?.focus();
    if (step === 'pay') shortHeadingRef.current?.focus();
  }, [step]);

  const category = items[0]?.category ?? 'empty';
  const noun = category === 'ready' ? 'families' : 'homes';
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const monthly = items.reduce((sum, item) => sum + (item.monthlyReturn ?? 0), 0);
  const shortfall = capacity === null ? null : Math.max(0, total - capacity);
  const belowMinimum = category === 'empty' && items.length > 0 && total < HOUSE_MIN_FUNDING;

  // Largest set of homes the balance covers, cheapest first.
  const fit = useMemo(() => {
    if (capacity === null) return [] as FunderNewSelectionItem[];
    let sum = 0;
    const keep: FunderNewSelectionItem[] = [];
    for (const item of [...items].sort((a, b) => a.amount - b.amount)) {
      if (sum + item.amount <= capacity) {
        keep.push(item);
        sum += item.amount;
      }
    }
    if (keep.length === 0 || keep.length === items.length) return [];
    if (category === 'empty' && sum < HOUSE_MIN_FUNDING) return [];
    return keep;
  }, [items, capacity, category]);
  const fitTotal = fit.reduce((sum, item) => sum + item.amount, 0);

  const close = (next: boolean) => {
    if (!next && sheet === 'sending') return;
    onOpenChange(next);
  };

  const goOn = () => {
    if (shortfall === null) return;
    if (shortfall > 0) setStep('pay');
    else setSheet('confirm');
  };

  const remove = (item: FunderNewSelectionItem) => {
    onRemove(item);
    toast(`Removed ${item.title}`, { action: { label: 'Undo', onClick: () => onRestore(item) }, duration: 5000 });
  };

  const submit = async () => {
    const snapshot = { count: items.length, total, monthly, noun, names: namesOf(items) };
    setFailure(null);
    setSheet('sending');
    try {
      const result = await onSubmit();
      setReceipt({ ...snapshot, reference: result.reference });
      setSheet(null);
      setStep('done');
    } catch (err) {
      const e = err instanceof SupportSubmitError ? err : new SupportSubmitError('Support could not be sent.', false);
      setFailure({ message: e.message, nothingTaken: e.nothingTaken });
      setSheet('failed');
    }
  };

  const slide = reduceMotion
    ? {}
    : { initial: { opacity: 0, x: 24 }, animate: { opacity: 1, x: 0 }, exit: { opacity: 0, x: -24 }, transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] as const } };
  const rise = reduceMotion
    ? {}
    : { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' }, transition: { type: 'spring' as const, stiffness: 380, damping: 36 } };

  const title =
    step === 'done' ? 'Support sent' : step === 'pay' ? 'Pay for your plan' : 'Your support plan';

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent
        className="flex h-[100dvh] max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 sm:h-[92vh] sm:max-w-md sm:rounded-3xl sm:border [&>button.absolute]:hidden"
        onEscapeKeyDown={(event) => sheet === 'sending' && event.preventDefault()}
        onPointerDownOutside={(event) => sheet === 'sending' && event.preventDefault()}
      >
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">
          {items.length} {items.length === 1 ? 'home' : 'homes'}, {formatDynamic(total)} in total.
        </DialogDescription>

        {step !== 'done' ? (
          <div className="flex-none space-y-4 px-5 pb-2 pt-[max(1.25rem,env(safe-area-inset-top))]">
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                aria-label={step === 'pay' ? 'Back to your plan' : 'Back to houses'}
                onClick={() => (step === 'pay' ? setStep('review') : close(false))}
                className="flex h-11 w-11 flex-none items-center justify-center rounded-full border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeft className="h-5 w-5" aria-hidden />
              </button>
              <p aria-hidden className="text-xl font-bold">
                {title}
              </p>
            </div>
            <FunderPreviewStepper current={step === 'pay' ? 2 : 1} />
          </div>
        ) : null}

        <AnimatePresence mode="wait" initial={false}>
          {step === 'review' ? (
            <motion.div key="review" {...slide} className="min-h-0 flex-1 space-y-[18px] overflow-y-auto overscroll-contain px-5 pb-32 pt-2">
              <section
                aria-label="Plan summary"
                className="space-y-3.5 rounded-3xl bg-primary p-5 text-primary-foreground shadow-[0_14px_30px_-12px_hsl(var(--primary)/0.55)]"
              >
                <div className="flex items-center gap-3">
                  <div aria-hidden className="flex flex-none">
                    {items.slice(0, 3).map((item, index) =>
                      item.imageUrl ? (
                        <img
                          key={item.id}
                          src={item.imageUrl}
                          alt=""
                          className="h-10 w-10 rounded-full border-2 border-primary-foreground object-cover"
                          style={{ marginLeft: index ? -12 : 0 }}
                        />
                      ) : (
                        <span
                          key={item.id}
                          className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-primary-foreground bg-primary-foreground/20"
                          style={{ marginLeft: index ? -12 : 0 }}
                        >
                          <Home className="h-4 w-4" />
                        </span>
                      ),
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-primary-foreground/85">You're backing</p>
                    <p className="text-xl font-bold">
                      {items.length} {items.length === 1 ? (category === 'ready' ? 'family' : 'home') : noun}
                    </p>
                  </div>
                </div>
                <div aria-hidden className="h-px bg-primary-foreground/25" />
                <dl className="grid grid-cols-2 gap-3">
                  <div>
                    <dt className="text-xs font-medium text-primary-foreground/85">Total support</dt>
                    <dd className="mt-0.5 text-[19px] font-bold tabular-nums">{formatDynamic(total)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium text-primary-foreground/85">Est. monthly Rent profit share</dt>
                    <dd className="mt-0.5 text-[19px] font-bold tabular-nums">{formatDynamic(monthly)}</dd>
                  </div>
                </dl>
              </section>

              <section aria-labelledby="preview-homes-h" className="space-y-2.5">
                <h3 id="preview-homes-h" className="text-[13px] font-bold text-muted-foreground">
                  Homes in this plan ({items.length})
                </h3>
                <ul className="space-y-2.5">
                  {items.map((item) => (
                    <li key={`${item.category}:${item.id}`} className="flex items-center gap-3 rounded-[20px] border bg-card p-3">
                      {item.imageUrl ? (
                        <img src={item.imageUrl} alt="" className="h-14 w-14 flex-none rounded-[14px] object-cover" />
                      ) : (
                        <span className="flex h-14 w-14 flex-none items-center justify-center rounded-[14px] bg-primary/10 text-primary">
                          <Home className="h-6 w-6" aria-hidden />
                        </span>
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[15px] font-bold">{item.title}</p>
                        <p className="truncate text-[13px] text-muted-foreground">
                          {item.place} · {item.category === 'ready' ? 'Tenant ready' : 'Empty home'}
                        </p>
                        <p className="text-[15px] font-bold tabular-nums text-primary">{formatDynamic(item.amount)}</p>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${item.title}`}
                        onClick={() => remove(item)}
                        className="flex h-11 w-11 flex-none items-center justify-center rounded-full border bg-background text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Trash2 className="h-[19px] w-[19px]" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              {belowMinimum ? (
                <p role="status" className="flex items-start gap-2 rounded-2xl border border-warning/40 bg-warning/10 p-3 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-warning" aria-hidden />
                  House support starts at {formatDynamic(HOUSE_MIN_FUNDING)}. Add another home to continue.
                </p>
              ) : (
                <p className="flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
                  <Info className="h-4 w-4 flex-none" aria-hidden />
                  You can remove homes until you confirm.
                </p>
              )}
            </motion.div>
          ) : null}

          {step === 'pay' ? (
            <motion.div key="pay" {...slide} className="min-h-0 flex-1 space-y-[18px] overflow-y-auto overscroll-contain px-5 pb-32 pt-2">
              <dl className="rounded-[22px] border bg-card px-[18px] py-1.5">
                <div className="flex items-center justify-between gap-2 py-3">
                  <dt className="text-[15px] text-muted-foreground">
                    Plan total · {items.length} {items.length === 1 ? 'home' : 'homes'}
                  </dt>
                  <dd className="text-[15px] font-semibold tabular-nums text-primary">{formatDynamic(total)}</dd>
                </div>
                <div className="flex items-center justify-between gap-2 py-3">
                  <dt className="flex items-center gap-2 text-[15px] text-muted-foreground">
                    <Wallet className="h-[18px] w-[18px]" aria-hidden />
                    Support balance
                  </dt>
                  <dd className="text-[15px] font-semibold tabular-nums text-primary">{formatDynamic(capacity ?? 0)}</dd>
                </div>
                <div className="flex items-center justify-between gap-2 border-t py-3">
                  <dt className="text-[15px] font-bold">Still needed</dt>
                  <dd className="text-lg font-bold tabular-nums text-primary">{formatDynamic(shortfall ?? 0)}</dd>
                </div>
              </dl>

              <section role="status" className="flex gap-3 rounded-[20px] border-[1.5px] border-warning bg-warning/10 p-4">
                <AlertTriangle className="h-[22px] w-[22px] flex-none text-warning" aria-hidden />
                <div className="space-y-1">
                  <h3 ref={shortHeadingRef} tabIndex={-1} className="text-[15px] font-bold outline-none">
                    Your balance is {formatDynamic(shortfall ?? 0)} short
                  </h3>
                  <p className="text-[13px] leading-[19px]">Top up and come straight back. Your plan stays open while you do.</p>
                </div>
              </section>

              {fit.length ? (
                <section aria-labelledby="preview-fit-h" className="space-y-2">
                  <h3 id="preview-fit-h" className="text-[13px] font-bold text-muted-foreground">
                    Or make the plan fit
                  </h3>
                  <button
                    type="button"
                    onClick={() => {
                      onKeepOnly(fit.map((item) => item.id));
                      setStep('review');
                      setSheet('confirm');
                    }}
                    className="flex w-full items-center gap-3 rounded-[18px] border bg-card p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {fit[0].imageUrl ? (
                      <img src={fit[0].imageUrl} alt="" className="h-11 w-11 flex-none rounded-xl object-cover" />
                    ) : (
                      <span className="flex h-11 w-11 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Home className="h-5 w-5" aria-hidden />
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold">
                        Keep {fit.length === 1 ? fit[0].title : `${fit.length} homes`}
                      </span>
                      <span className="block text-[13px] text-muted-foreground">{formatDynamic(fitTotal)} · fully covered</span>
                    </span>
                    <ArrowRight className="h-[18px] w-[18px] text-muted-foreground" aria-hidden />
                  </button>
                </section>
              ) : null}
            </motion.div>
          ) : null}

          {step === 'done' && receipt ? (
            <motion.div key="done" {...(reduceMotion ? {} : { initial: { opacity: 0 }, animate: { opacity: 1 } })} className="min-h-0 flex-1 overflow-y-auto pb-44">
              <header className="relative flex h-[300px] flex-col items-center justify-center gap-2.5 overflow-hidden bg-primary px-7 pb-10 text-center text-primary-foreground">
                {!reduceMotion ? <Confetti /> : null}
                <motion.span
                  aria-hidden
                  className="flex h-20 w-20 items-center justify-center rounded-full bg-card text-success shadow-xl"
                  {...(reduceMotion ? {} : { initial: { scale: 0.6, opacity: 0 }, animate: { scale: 1, opacity: 1 }, transition: { type: 'spring', stiffness: 320, damping: 16 } })}
                >
                  <Check className="h-10 w-10" strokeWidth={3} />
                </motion.span>
                <h2 ref={doneHeadingRef} tabIndex={-1} className="mt-1 text-[28px] font-bold leading-tight outline-none">
                  You're backing {receipt.count} {receipt.count === 1 ? (receipt.noun === 'families' ? 'family' : 'home') : receipt.noun}
                </h2>
                <p className="text-[15px] leading-[21px] text-primary-foreground/90">
                  Your support for {receipt.names} is in. You'll see it in your portfolio once it's approved.
                </p>
              </header>
              <div className="relative mx-4 -mt-9 space-y-4 rounded-3xl border bg-card p-[18px] shadow-[0_14px_30px_-18px_hsl(222_47%_11%/0.35)]">
                {receipt.reference ? (
                  <div className="flex items-center gap-3 rounded-2xl bg-background px-3.5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-muted-foreground">Booking reference</p>
                      <p className="truncate font-bold tracking-wide">{receipt.reference.slice(0, 8).toUpperCase()}</p>
                    </div>
                    <button
                      type="button"
                      aria-label="Copy booking reference"
                      onClick={() => {
                        void navigator.clipboard?.writeText(receipt.reference ?? '').then(() => toast.success('Reference copied'));
                      }}
                      className="flex h-11 w-11 flex-none items-center justify-center rounded-full border bg-card text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <Copy className="h-[18px] w-[18px]" aria-hidden />
                    </button>
                  </div>
                ) : null}
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Total support</dt>
                    <dd className="font-bold tabular-nums">{formatDynamic(receipt.total)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Est. monthly Rent profit share</dt>
                    <dd className="font-bold tabular-nums text-success">{formatDynamic(receipt.monthly)}</dd>
                  </div>
                </dl>
                <section aria-labelledby="preview-next-h" className="space-y-3">
                  <h3 id="preview-next-h" className="text-[15px] font-bold">
                    What happens next
                  </h3>
                  <ol className="space-y-3">
                    <li className="flex gap-3">
                      <span aria-hidden className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-success text-success-foreground">
                        <Check className="h-4 w-4" strokeWidth={3} />
                      </span>
                      <div>
                        <p className="text-sm font-bold">
                          Support sent <span className="font-medium text-success">· Done</span>
                        </p>
                        <p className="text-[13px] text-muted-foreground">Just now</p>
                      </div>
                    </li>
                    {NEXT_STEPS.map((next, index) => (
                      <li key={next.title} className="flex gap-3" aria-current={index === 0 ? 'step' : undefined}>
                        <span
                          aria-hidden
                          className={cn(
                            'flex h-7 w-7 flex-none items-center justify-center rounded-full text-[13px] font-bold',
                            index === 0 ? 'bg-primary text-primary-foreground' : 'border-[1.5px] border-border text-muted-foreground',
                          )}
                        >
                          {index + 2}
                        </span>
                        <div>
                          <p className="text-sm font-bold">
                            {next.title}
                            {index === 0 ? <span className="font-medium text-primary"> · Now</span> : null}
                          </p>
                          <p className="text-[13px] text-muted-foreground">{next.text}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </section>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Sticky footer */}
        <div className="absolute inset-x-0 bottom-0 z-10 space-y-2.5 bg-card px-5 pb-[max(1.6rem,env(safe-area-inset-bottom))] pt-3.5 shadow-[0_-8px_28px_-10px_hsl(var(--primary)/0.25)]">
          {step === 'review' ? (
            capacityError ? (
              <button type="button" className={primaryButton} onClick={onRetryCapacity}>
                <RefreshCw className="h-5 w-5" aria-hidden />
                Balance unavailable · Try again
              </button>
            ) : (
              <button
                type="button"
                className={primaryButton}
                disabled={items.length === 0 || belowMinimum || capacityLoading || shortfall === null}
                onClick={goOn}
              >
                {capacityLoading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
                Continue · {formatDynamic(total)}
                <ArrowRight className="h-5 w-5" aria-hidden />
              </button>
            )
          ) : null}
          {step === 'pay' ? (
            <button type="button" className={primaryButton} onClick={() => onTopUp(shortfall ?? 0)}>
              <Plus className="h-5 w-5" aria-hidden />
              Top up {formatDynamic(shortfall ?? 0)}
            </button>
          ) : null}
          {step === 'done' ? (
            <>
              <button type="button" className={primaryButton} onClick={onViewPortfolio}>
                <Home className="h-5 w-5" aria-hidden />
                See my homes
              </button>
              {typeof navigator !== 'undefined' && 'share' in navigator ? (
                <button
                  type="button"
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border-[1.5px] border-primary bg-card text-[15px] font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    void navigator
                      .share({
                        title: 'Welile',
                        text: `I just supported ${receipt?.count ?? 0} ${receipt?.noun ?? 'homes'} with Welile.`,
                        url: window.location.origin,
                      })
                      .catch(() => undefined);
                  }}
                >
                  <Share2 className="h-[18px] w-[18px]" aria-hidden />
                  Share the good news
                </button>
              ) : (
                <button type="button" className={quietButton} onClick={() => close(false)}>
                  Done
                </button>
              )}
            </>
          ) : null}
        </div>

        {/* Confirm / sending / failed sheets over the plan */}
        <AnimatePresence>
          {sheet ? (
            <motion.div
              key="scrim"
              aria-hidden
              className="absolute inset-0 z-20 bg-foreground/55"
              {...(reduceMotion ? {} : { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } })}
              onClick={() => sheet !== 'sending' && setSheet(null)}
            />
          ) : null}

          {sheet === 'confirm' ? (
            <motion.section key="confirm" role="group" aria-labelledby="preview-confirm-h" className={sheetClass} {...rise}>
              <div aria-hidden className="mx-auto h-[5px] w-10 rounded-full bg-border" />
              <div className="space-y-1.5">
                <h2 id="preview-confirm-h" className="text-[22px] font-bold tracking-tight">
                  Confirm your support
                </h2>
                <p className="text-sm leading-5 text-muted-foreground">
                  Check once more. After you confirm, the team reviews it and support starts.
                </p>
              </div>
              <dl className="space-y-2.5 rounded-[20px] border bg-background p-4 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Homes</dt>
                  <dd className="text-right font-semibold">
                    {items.length} · {namesOf(items)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Total support</dt>
                  <dd className="font-bold tabular-nums">{formatDynamic(total)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Paid from</dt>
                  <dd className="font-semibold">Support balance</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">Est. monthly Rent profit share</dt>
                  <dd className="font-bold tabular-nums text-success">{formatDynamic(monthly)}</dd>
                </div>
              </dl>
              <label
                className={cn(
                  'flex min-h-12 cursor-pointer items-start gap-3 rounded-2xl border-[1.5px] p-3.5 transition-colors',
                  agreed ? 'border-primary bg-primary/10' : 'border-border',
                )}
              >
                <Checkbox
                  checked={agreed}
                  onCheckedChange={(value) => setAgreed(value === true)}
                  className="mt-0.5 h-[22px] w-[22px] rounded-md"
                />
                <span className="text-sm leading-5">
                  I understand Rent profit share figures are estimates and support starts after the usual approval.
                </span>
              </label>
              <div className="space-y-2">
                <button type="button" className={primaryButton} disabled={!agreed} aria-describedby={agreed ? undefined : 'preview-why-off'} onClick={submit}>
                  <Lock className="h-[19px] w-[19px]" aria-hidden />
                  Confirm support · {formatDynamic(total)}
                </button>
                {!agreed ? (
                  <p id="preview-why-off" className="text-center text-xs font-medium text-muted-foreground">
                    Tick the box above to continue.
                  </p>
                ) : null}
                <button type="button" className={quietButton} onClick={() => setSheet(null)}>
                  Not yet, back to my plan
                </button>
              </div>
            </motion.section>
          ) : null}

          {sheet === 'sending' ? (
            <motion.section key="sending" aria-busy="true" aria-labelledby="preview-send-h" className={cn(sheetClass, 'text-center')} {...rise}>
              <div aria-hidden className="mx-auto h-[5px] w-10 rounded-full bg-border" />
              <Loader2 className="mx-auto mt-3 h-16 w-16 animate-spin text-primary motion-reduce:animate-none" aria-hidden />
              <div role="status" aria-live="polite" className="space-y-1.5">
                <h2 id="preview-send-h" className="text-[22px] font-bold tracking-tight">
                  Sending your support…
                </h2>
                <p className="text-sm text-muted-foreground">Keep this screen open. It usually takes a few seconds.</p>
              </div>
              <button type="button" disabled className={cn(primaryButton, 'disabled:bg-primary/40 disabled:text-primary-foreground')}>
                Sending…
              </button>
              <p className="text-xs font-medium text-muted-foreground">Please don't tap again. We'll only send it once.</p>
            </motion.section>
          ) : null}

          {sheet === 'failed' && failure ? (
            <motion.section key="failed" role="alertdialog" aria-labelledby="preview-fail-h" aria-describedby="preview-fail-d" className={sheetClass} {...rise}>
              <div aria-hidden className="mx-auto h-[5px] w-10 rounded-full bg-border" />
              <span aria-hidden className="mt-1.5 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="h-7 w-7" />
              </span>
              <div className="space-y-1.5">
                <h2 id="preview-fail-h" className="text-[22px] font-bold tracking-tight">
                  Your support wasn't sent
                </h2>
                <p id="preview-fail-d" className="text-[15px] leading-[21px]">
                  {failure.nothingTaken
                    ? `Nothing was taken from your balance. Your ${items.length} ${items.length === 1 ? 'home is' : 'homes are'} still in your plan.`
                    : "We couldn't confirm what happened. Check your portfolio before trying again."}
                </p>
              </div>
              <p className="flex items-center gap-2.5 rounded-2xl border bg-background px-3.5 py-3 text-[13px] text-muted-foreground">
                <Info className="h-4 w-4 flex-none" aria-hidden />
                Reason: {failure.message}
              </p>
              <div className="space-y-2">
                {failure.nothingTaken ? (
                  <button type="button" className={primaryButton} autoFocus onClick={submit}>
                    <RefreshCw className="h-[19px] w-[19px]" aria-hidden />
                    Try again
                  </button>
                ) : (
                  <button type="button" className={primaryButton} autoFocus onClick={onViewPortfolio}>
                    <Home className="h-[19px] w-[19px]" aria-hidden />
                    Check my portfolio
                  </button>
                )}
                <button type="button" className={quietButton} onClick={() => setSheet(null)}>
                  Back to my plan
                </button>
              </div>
            </motion.section>
          ) : null}
        </AnimatePresence>
      </DialogContent>
    </Dialog>
  );
}

const CONFETTI = [
  { left: '10%', top: 46, color: 'bg-warning', round: false, delay: 0 },
  { left: '24%', top: 96, color: 'bg-success', round: true, delay: 0.05 },
  { left: '78%', top: 52, color: 'bg-primary-foreground', round: false, delay: 0.12 },
  { left: '86%', top: 128, color: 'bg-warning', round: true, delay: 0.2 },
  { left: '14%', top: 190, color: 'bg-primary-foreground', round: true, delay: 0.26 },
  { left: '64%', top: 30, color: 'bg-success', round: false, delay: 0.08 },
  { left: '38%', top: 36, color: 'bg-primary-foreground/70', round: true, delay: 0.16 },
  { left: '84%', top: 214, color: 'bg-primary-foreground/70', round: false, delay: 0.3 },
];

function Confetti() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {CONFETTI.map((piece, index) => (
        <motion.span
          key={index}
          className={cn('absolute', piece.color, piece.round ? 'h-2.5 w-2.5 rounded-full' : 'h-3.5 w-2 rounded-sm')}
          style={{ left: piece.left, top: piece.top }}
          initial={{ y: -14, opacity: 0, rotate: 0 }}
          animate={{ y: 10, opacity: 1, rotate: piece.round ? 0 : 25 }}
          transition={{ duration: 1.4, delay: piece.delay, ease: 'easeOut' }}
        />
      ))}
    </div>
  );
}
