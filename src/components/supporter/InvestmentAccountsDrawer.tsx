import { withUserSession } from '@/lib/authenticatedRequests';
import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useCapitalOpportunities, PortfolioRecord } from '@/hooks/useCapitalOpportunities';
import { useMyAngelShares } from '@/hooks/useMyAngelShares';
import { useCurrency } from '@/hooks/useCurrency';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Loader2, TrendingUp, Briefcase, Wallet, Sparkles,
  ArrowDownToLine, ChevronRight, ArrowUpRight, RefreshCw, Calendar, Clock, Hash,
  Pencil, Check, X, Download, Share2, FileText, AlertTriangle, MessageCircle, ArrowLeft

} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDateOnlyForDisplay, extractDateOnly, dateOnlyToLocalDate } from '@/lib/portfolioDates';
import { hapticTap } from '@/lib/haptics';
import { supabase } from '@/integrations/supabase/client';
import { FundAccountDialog } from './FundAccountDialog';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { downloadPortfolioPdf, type PortfolioPdfData } from '@/lib/portfolioPdf';
import { downloadPartnerStatement } from '@/lib/partnerStatement';
import { differenceInCalendarDays, differenceInCalendarMonths } from 'date-fns';

/** Support line that handles rejected portfolio top-ups (WhatsApp chat). */
const SUPPORT_CHAT_NUMBER = '256777607640';

const statusConfig: Record<string, { label: string; variant: 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'muted'; dot: string }> = {
  active: { label: 'Active', variant: 'success', dot: 'bg-success animate-pulse' },
  pending: { label: 'Pending', variant: 'warning', dot: 'bg-warning' },
  pending_approval: { label: 'Awaiting Approval', variant: 'warning', dot: 'bg-warning' },
  matured: { label: 'Matured', variant: 'default', dot: 'bg-primary' },
  withdrawn: { label: 'Withdrawn', variant: 'muted', dot: 'bg-muted-foreground/40' },
};

/** Returns days until next Returns date, or null if not available */
function daysUntilNextRoi(nextRoiDate: string | null | undefined): number | null {
  const dateOnly = extractDateOnly(nextRoiDate);
  if (!dateOnly) return null;
  const target = dateOnlyToLocalDate(dateOnly);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return differenceInCalendarDays(target, today);
}

/** How long the portfolio has actually been running, from its original start
 *  date (renewals count from the first portfolio) to today. Shows days when
 *  it has been running for less than a month. */
function runningDurationLabel(fundedAt: string | null | undefined): string | null {
  if (!fundedAt) return null;
  const start = new Date(fundedAt);
  if (isNaN(start.getTime())) return null;
  const months = Math.max(0, differenceInCalendarMonths(new Date(), start));
  if (months >= 1) return `${months} ${months === 1 ? 'month' : 'months'}`;
  const days = Math.max(0, differenceInCalendarDays(new Date(), start));
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** Self-support portfolios (WSP/WSH codes) run on a 12-month contract that
 *  keeps earning even when the underlying Rent Plan completes. Shows which
 *  contract month the partner is in; "Contract ended" once matured. */
function contractMonthLabel(p: PortfolioRecord): string | null {
  const code = p.portfolio_code || '';
  if (!code.startsWith('WSP') && !code.startsWith('WSH')) return null;
  if (p.status === 'matured') return 'Contract ended';
  if (!p.created_at) return null;
  const start = new Date(p.created_at);
  if (isNaN(start.getTime())) return null;
  const cap = Math.max(1, Number(p.duration_months) || 12);
  const n = Math.min(cap, Math.max(0, differenceInCalendarMonths(new Date(), start)) + 1);
  return `Month ${n} of ${cap}`;
}

function NextRoiIndicator({ nextRoiDate }: { nextRoiDate: string | null | undefined }) {
  const days = daysUntilNextRoi(nextRoiDate);
  if (days === null) return null;
  const isUrgent = days <= 5;
  return (
    <span className={`text-[10px] font-semibold flex items-center gap-1 ${isUrgent ? 'text-destructive' : 'text-success'}`}>
      <Calendar className={`h-2.5 w-2.5 ${isUrgent ? 'animate-pulse' : ''}`} />
      {days <= 0 ? 'Due today' : `${days}d to Returns`}
    </span>
  );
}

/** One account as a list tile: name and amount on top, code and monthly Returns under, status and next Returns last. */
function PortfolioRow({ p, onTap }: { p: PortfolioRecord; onTap: () => void }) {
  const roi = (Number(p.investment_amount) * Number(p.roi_percentage)) / 100;
  const cfg = statusConfig[p.status] || { label: p.status, variant: 'outline' as const, dot: 'bg-muted-foreground/40' };
  const name = p.account_name || p.portfolio_code || 'Support Account';
  const matDate = p.maturity_date ? new Date(p.maturity_date) : null;
  const isExpired = !!matDate && differenceInCalendarDays(matDate, new Date()) < 0 && p.status === 'active';

  return (
    <button
      onClick={() => { hapticTap(); onTap(); }}
      className={cn(
        'flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors active:bg-muted/70',
        isExpired && 'bg-destructive/5',
      )}
    >
      <div className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary/10">
        <Wallet className="h-5 w-5 text-primary" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[15px] font-semibold">{name}</span>
          <span className="shrink-0 text-[15px] font-semibold tabular-nums">{formatUGX(Number(p.investment_amount))}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          {p.portfolio_code ? (
            <span className="flex min-w-0 items-center gap-1 truncate font-mono text-[11px] text-muted-foreground">
              <Hash className="h-2.5 w-2.5 shrink-0" />{p.portfolio_code}
            </span>
          ) : <span />}
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-semibold text-success">
            <TrendingUp className="h-3 w-3" />
            {p.roi_percentage}% · {formatUGX(roi)}/mo
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {isExpired ? (
            <Badge variant="destructive" size="sm" className="gap-1">
              <AlertTriangle className="h-2.5 w-2.5" /> Expired
            </Badge>
          ) : (
            <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>
          )}
          <NextRoiIndicator nextRoiDate={p.next_roi_date} />
          {Number(p.total_roi_earned) > 0 && (
            <span className="text-[10px] text-success">Earned {formatUGX(Number(p.total_roi_earned))}</span>
          )}
        </div>
      </div>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50" />
    </button>
  );
}

function DetailRow({ label, value, icon: Icon, valueClassName }: { label: string; value: string; icon?: React.ElementType; valueClassName?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3.5">
      <span className="flex items-center gap-3 text-sm text-muted-foreground">
        {Icon && <Icon className="h-[18px] w-[18px] shrink-0" />}
        {label}
      </span>
      <span className={cn('text-right text-sm font-semibold text-foreground', valueClassName)}>{value}</span>
    </div>
  );
}

function PortfolioDetailSheet({ portfolio, open, onOpenChange, onRenamed, onTopUp }: {
  portfolio: PortfolioRecord | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onRenamed: () => void;
  onTopUp?: (p: PortfolioRecord) => void;
}) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);
  const [downloading, setDownloading] = useState(false);
  /* Two different documents, so the person is asked which they want:
     the projection shows what this portfolio is expected to earn,
     the statement shows what has actually happened on it. */
  const [reportChoiceOpen, setReportChoiceOpen] = useState(false);
  const [downloadingStatement, setDownloadingStatement] = useState(false);
  const [togglingReinvest, setTogglingReinvest] = useState(false);
  const [localAutoReinvest, setLocalAutoReinvest] = useState<boolean | null>(null);
  const [pendingTopup, setPendingTopup] = useState(0);
  const [rejectedTopup, setRejectedTopup] = useState<{ amount: number; reason: string; created_at: string } | null>(null);
  const { user } = useAuth();

  useEffect(() => {
    if (!open || !portfolio?.id) { setPendingTopup(0); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('pending_wallet_operations')
        .select('amount')
        .eq('source_table', 'investor_portfolios')
        .eq('operation_type', 'portfolio_topup')
        .eq('source_id', portfolio.id)
        .in('status', ['approved', 'awaiting_verification']);
      if (cancelled) return;
      const total = (data || []).reduce((s: number, op: any) => s + Number(op.amount || 0), 0);
      setPendingTopup(total);
    })();
    return () => { cancelled = true; };
  }, [open, portfolio?.id]);

  // Fetch the most recent REJECTED top-up so we can surface a visible error
  // (with reason) and a support-chat link to the partner.
  useEffect(() => {
    if (!open || !portfolio?.id) { setRejectedTopup(null); return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('pending_wallet_operations')
        .select('amount, reviewed_at, created_at, metadata')
        .eq('source_table', 'investor_portfolios')
        .eq('operation_type', 'portfolio_topup')
        .eq('source_id', portfolio.id)
        .eq('status', 'rejected')
        .order('reviewed_at', { ascending: false })
        .limit(1);
      if (cancelled) return;
      const op = (data || [])[0] as any;
      if (op) {
        setRejectedTopup({
          amount: Number(op.amount || 0),
          reason: op.metadata?.rejection_reason || 'No reason provided',
          created_at: op.reviewed_at || op.created_at,
        });
      } else {
        setRejectedTopup(null);
      }
    })();
    return () => { cancelled = true; };
  }, [open, portfolio?.id]);

  if (!portfolio) return null;
  const amount = Number(portfolio.investment_amount);
  const roiPct = Number(portfolio.roi_percentage);
  const monthlyReturn = (amount * roiPct) / 100;
  const totalEarned = Number(portfolio.total_roi_earned);
  const totalValue = amount + totalEarned;
  const cfg = statusConfig[portfolio.status] || { label: portfolio.status, variant: 'outline' as const, dot: 'bg-muted-foreground/40' };
  const name = portfolio.account_name || portfolio.portfolio_code || 'Support Account';
  const isActive = portfolio.status === 'active';

  // Next ROI date urgency
  const roiDays = daysUntilNextRoi(portfolio.next_roi_date);
  const roiUrgent = roiDays !== null && roiDays <= 5;

  const handleRename = async () => {
    const trimmed = newName.trim();
    if (!trimmed || !portfolio.id) return;
    setSaving(true);
    try {
      const { error } = await withUserSession(() => supabase
        .from('investor_portfolios')
        .update({ account_name: trimmed } as any)
        .eq('id', portfolio.id));
      if (error) throw error;
      // Update local state immediately so UI reflects the change
      (portfolio as any).account_name = trimmed;
      toast.success('Account renamed successfully');
      setIsRenaming(false);
      onRenamed(); // triggers list refetch
    } catch (err: any) {
      toast.error(err.message || 'Failed to rename account');
    } finally {
      setSaving(false);
    }
  };

  const buildPdfData = (): PortfolioPdfData => ({
    portfolioCode: portfolio.portfolio_code || portfolio.id,
    accountName: portfolio.account_name,
    investmentAmount: amount,
    roiPercentage: roiPct,
    roiMode: portfolio.roi_mode || 'monthly_payout',
    totalRoiEarned: totalEarned,
    status: portfolio.status,
    createdAt: portfolio.created_at || '',
    durationMonths: portfolio.duration_months || 0,
    nextRoiDate: portfolio.next_roi_date,
    maturityDate: portfolio.maturity_date,
    autoReinvest: portfolio.auto_reinvest ?? false,
  });

  const handleDownloadPdf = async () => {
    setDownloading(true);
    try {
      await downloadPortfolioPdf(buildPdfData());
      toast.success('Projection report downloaded');
      setReportChoiceOpen(false);
    } catch {
      toast.error('Could not create the projection report');
    }
    setDownloading(false);
  };

  const handleDownloadStatement = async () => {
    if (!portfolio?.id) return;
    setDownloadingStatement(true);
    try {
      await downloadPartnerStatement(portfolio.id);
      toast.success('Statement ready', {
        description: 'Your statement PDF has been saved to your device.',
      });
      setReportChoiceOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the statement');
    }
    setDownloadingStatement(false);
  };

  const handleToggleAutoReinvest = async () => {
    if (!portfolio.id) return;
    setTogglingReinvest(true);
    const currentValue = localAutoReinvest ?? portfolio.auto_reinvest ?? false;
    const newValue = !currentValue;
    try {
      const { data, error } = await supabase.functions.invoke('supporter-account-action', {
        body: { action: 'set_auto_support', portfolio_id: portfolio.id, enabled: newValue },
      });
      if (error) {
        let msg = error.message;
        try { msg = (await (error as any).context?.json())?.error || msg; } catch { /* keep msg */ }
        throw new Error(msg);
      }
      if (data?.error) throw new Error(data.error);
      setLocalAutoReinvest(!!data?.auto_reinvest);
      toast.success(`Auto-Support ${data?.auto_reinvest ? 'ON — Returns now compound' : 'OFF — Returns paid monthly'}`);
      onRenamed(); // triggers refetch
    } catch (e: any) {
      toast.error(e?.message || 'Failed to update Auto-Support');
    } finally {
      setTogglingReinvest(false);
    }
  };

  const handleShare = () => {
    const displayName = portfolio.account_name || portfolio.portfolio_code || 'Support Account';
    const monthlyROI = Math.round(amount * (roiPct / 100));
    const message = [
      `📊 *Support Portfolio: ${displayName}*`,
      ``,
      `💰 Capital: ${formatUGX(amount)}`,
      `📈 Returns Rate: ${roiPct}% per month`,
      `💵 Monthly Return: ${formatUGX(monthlyROI)}`,
      `📅 Duration: ${portfolio.duration_months || '—'} months`,
      `🔄 Mode: ${portfolio.roi_mode === 'monthly_compounding' ? 'Compounding' : 'Monthly Payout'}`,
      `✅ Status: ${cfg.label}`,
      ``,
      `💰 Total Earned So Far: ${formatUGX(totalEarned)}`,
      ``,
      `_Welile Technologies Limited_`,
      `_Investment Portfolio Report_`,
    ].join('\n');

    const encoded = encodeURIComponent(message);
    // Open WhatsApp with prefilled message
    window.open(`https://wa.me/?text=${encoded}`, '_blank', 'noopener');
    toast.success('Opening WhatsApp with portfolio details');
  };

  const autoReinvestValue = localAutoReinvest ?? portfolio.auto_reinvest ?? false;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Full mobile screen, like the accounts list it opens from: app bar, scrolling body, bottom action bar. */}
      <SheetContent
        side="bottom"
        className="plan-detail-sheet flex h-[100dvh] flex-col gap-0 rounded-none bg-background p-0 sm:h-[94dvh] sm:rounded-t-[28px] [&>div.sticky:first-child]:hidden"
      >
        {/* App bar */}
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-border/60 px-1 pt-[env(safe-area-inset-top)]">
          <button
            type="button"
            onClick={() => { hapticTap(); onOpenChange(false); }}
            aria-label="Back"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-foreground transition-colors active:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          {isRenaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-1 pr-1">
              <SheetTitle className="sr-only">Rename {name}</SheetTitle>
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New account name"
                className="h-10 text-base"
                autoFocus
                onKeyDown={(e) => e.key === 'Enter' && handleRename()}
              />
              <button
                type="button"
                onClick={handleRename}
                disabled={saving || !newName.trim()}
                aria-label="Save name"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full active:bg-muted disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-5 w-5 text-success" />}
              </button>
              <button
                type="button"
                onClick={() => setIsRenaming(false)}
                aria-label="Cancel rename"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-full active:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          ) : (
            <>
              <SheetTitle className="min-w-0 flex-1 truncate text-lg font-semibold tracking-tight">{name}</SheetTitle>
              <button
                type="button"
                onClick={() => { setNewName(portfolio.account_name || ''); setIsRenaming(true); }}
                aria-label="Rename account"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-foreground transition-colors active:bg-muted"
              >
                <Pencil className="h-[18px] w-[18px]" />
              </button>
              <button
                type="button"
                onClick={handleShare}
                aria-label="Share"
                className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-foreground transition-colors active:bg-muted"
              >
                <Share2 className="h-[18px] w-[18px]" />
              </button>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-muted/30">
        <div className="space-y-4 px-4 pb-6 pt-4">
          {/* Total value */}
          <div className="rounded-[20px] bg-primary p-5 text-primary-foreground">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium opacity-80">Total value</p>
              <span className="rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-semibold">{cfg.label}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <p className="text-[28px] font-bold leading-tight tabular-nums">{formatUGX(totalValue)}</p>
              {totalEarned > 0 && (
                <span className="flex items-center gap-0.5 text-sm font-semibold text-green-200">
                  <ArrowUpRight className="h-4 w-4" />
                  +{formatUGX(totalEarned)}
                </span>
              )}
            </div>
            {portfolio.portfolio_code && (
              <p className="mt-1 font-mono text-xs opacity-80">{portfolio.portfolio_code}</p>
            )}
            {pendingTopup > 0 && (
              <p className="mt-3 flex items-start gap-1.5 rounded-xl bg-white/15 px-3 py-2 text-[11px]">
                <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Your top-up of <span className="font-bold">{formatUGX(pendingTopup)}</span> is pending and will be added right after your next returns payout.
                </span>
              </p>
            )}
          </div>

          {/* Rejected top-up notice — funds returned to wallet + support chat link */}
          {rejectedTopup && (
            <div className="p-4 rounded-2xl bg-destructive/5 border border-destructive/30 space-y-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-xs font-bold text-destructive">Top-up of {formatUGX(rejectedTopup.amount)} was rejected</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Reason: <span className="font-semibold text-foreground">{rejectedTopup.reason}</span>
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                    The money has been returned to your wallet. If you need help, contact support below.
                  </p>
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full h-10 gap-2 text-xs font-semibold border-destructive/40 text-destructive hover:bg-destructive/10"
                onClick={() => {
                  const userName = user?.user_metadata?.full_name || 'a Welile partner';
                  const portfolioId = portfolio.portfolio_code || portfolio.id;
                  const msg = `Hi, am ${userName}, my portfolio of (${portfolioId}) was rejected because of ${rejectedTopup.reason}.`;
                  window.open(`https://wa.me/${SUPPORT_CHAT_NUMBER}?text=${encodeURIComponent(msg)}`, '_blank', 'noopener');
                }}
              >
                <MessageCircle className="h-3.5 w-3.5" />
                Chat support · +{SUPPORT_CHAT_NUMBER}
              </Button>
            </div>
          )}

          {/* Key Metrics */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-[20px] bg-card p-4">
              <p className="text-xs text-muted-foreground">Principal</p>
              <p className="mt-1 text-lg font-bold tabular-nums">{formatUGX(amount)}</p>
            </div>
            <div className="rounded-[20px] bg-card p-4">
              <p className="text-xs text-muted-foreground">Monthly Return</p>
              <p className="mt-1 text-lg font-bold tabular-nums text-success">{formatUGX(monthlyReturn)}</p>
            </div>
          </div>

          {/* Detail Rows */}
          <p className="px-1 pt-1 text-xs font-semibold text-muted-foreground">Details</p>
          <div className="divide-y divide-border/60 overflow-hidden rounded-[20px] bg-card">
            <DetailRow label="Returns Rate" value={`${roiPct}% / month`} icon={TrendingUp} />
            <DetailRow label="Total Returns Earned" value={formatUGX(totalEarned)} icon={Wallet} />
            {portfolio.roi_mode && (
              <DetailRow label="Returns Mode" value={portfolio.roi_mode} icon={RefreshCw} />
            )}
            {(() => {
              const running = runningDurationLabel(portfolio.funded_at);
              return running !== null ? (
                <DetailRow
                  label="Running for"
                  value={running}
                  icon={Clock}
                />
              ) : null;
            })()}
            {(() => {
              const contractMonth = contractMonthLabel(portfolio);
              return contractMonth !== null ? (
                <DetailRow label="Contract" value={contractMonth} icon={Clock} />
              ) : null;
            })()}
            {portfolio.maturity_date && (
              <DetailRow label="Maturity Date" value={formatDateOnlyForDisplay(portfolio.maturity_date)} icon={Calendar} />
            )}
            {portfolio.next_roi_date && (
              <DetailRow
                label="Next Returns Date"
                value={formatDateOnlyForDisplay(portfolio.next_roi_date)}
                icon={Calendar}
                valueClassName={roiUrgent ? 'text-destructive font-black' : 'text-success'}
              />
            )}
            {portfolio.funded_at && (
              <DetailRow label="Funded" value={formatDateOnlyForDisplay(portfolio.funded_at)} icon={Calendar} />
            )}
            {!isActive && (
              <DetailRow
                label="Auto-Reinvest"
                value={autoReinvestValue ? 'Enabled' : 'Disabled'}
                icon={RefreshCw}
                valueClassName={autoReinvestValue ? 'text-primary' : ''}
              />
            )}
          </div>

          {/* Settings and documents, as list tiles */}
          <div className="divide-y divide-border/60 overflow-hidden rounded-[20px] bg-card">
            {isActive && (
              <div className="flex items-center justify-between gap-3 px-4 py-3.5">
                <span className="flex items-center gap-3">
                  <RefreshCw className={cn('h-[18px] w-[18px] shrink-0', autoReinvestValue ? 'text-primary' : 'text-muted-foreground')} />
                  <span>
                    <span className="block text-sm font-medium">Auto-Support</span>
                    <span className="block text-xs text-muted-foreground">Automatically compound your returns</span>
                  </span>
                </span>
                {togglingReinvest
                  ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  : (
                    <Switch
                      checked={autoReinvestValue}
                      onCheckedChange={() => handleToggleAutoReinvest()}
                      aria-label="Auto-Support"
                    />
                  )}
              </div>
            )}
            <button
              type="button"
              onClick={() => { hapticTap(); setReportChoiceOpen(true); }}
              disabled={downloading || downloadingStatement}
              className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left transition-colors active:bg-muted/70 disabled:opacity-60"
            >
              <span className="flex items-center gap-3 text-sm font-medium">
                {(downloading || downloadingStatement)
                  ? <Loader2 className="h-[18px] w-[18px] animate-spin text-muted-foreground" />
                  : <Download className="h-[18px] w-[18px] text-muted-foreground" />}
                Download report
              </span>
              <ChevronRight className="h-4 w-4 text-muted-foreground/50" />
            </button>
          </div>

          {/* Which report? The two answer different questions, so the choice is
              spelled out rather than hidden behind one ambiguous button. */}
          <Dialog open={reportChoiceOpen} onOpenChange={setReportChoiceOpen}>
            <DialogContent className="max-w-sm">
              <DialogHeader>
                <DialogTitle className="text-base">Choose a report</DialogTitle>
              </DialogHeader>
              <div className="space-y-2.5">
                <button
                  type="button"
                  onClick={handleDownloadPdf}
                  disabled={downloading || downloadingStatement}
                  className="w-full text-left rounded-xl border border-border/60 p-3.5 hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-60"
                >
                  <p className="flex items-center gap-2 text-sm font-bold">
                    {downloading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4 text-primary" />}
                    Projection report
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    What this account is expected to earn over its term. PDF.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={handleDownloadStatement}
                  disabled={downloading || downloadingStatement}
                  className="w-full text-left rounded-xl border border-border/60 p-3.5 hover:border-primary/50 hover:bg-primary/5 transition-colors disabled:opacity-60"
                >
                  <p className="flex items-center gap-2 text-sm font-bold">
                    {downloadingStatement ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4 text-primary" />}
                    Statement
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    What has actually happened: top-ups, Returns added, payouts and
                    changes. PDF.
                  </p>
                </button>
              </div>
            </DialogContent>
          </Dialog>

          {/* Info Hint */}
          <div className="flex items-start gap-2 px-1">
            <TrendingUp className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground">
              Your capital earns <strong className="text-foreground">{roiPct}% monthly</strong>. Returns are credited automatically each cycle. Top up anytime to grow your portfolio.
            </p>
          </div>
        </div>
        </div>

        {/* Bottom action bar */}
        {isActive && (
          <div className="flex shrink-0 gap-3 border-t border-border/60 bg-background px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3">
            <Button
              onClick={() => {
                onTopUp?.(portfolio);
                onOpenChange(false);
              }}
              className="h-12 flex-1 gap-2 rounded-full font-semibold"
            >
              <Sparkles className="h-4 w-4" />
              Top Up
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('open-withdrawal', {
                  detail: { portfolioId: portfolio.id, portfolioCode: portfolio.portfolio_code }
                }));
                onOpenChange(false);
              }}
              className="h-12 flex-1 gap-2 rounded-full border-destructive/30 font-semibold text-destructive hover:bg-destructive/10"
            >
              <ArrowDownToLine className="h-4 w-4" />
              Withdraw
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

interface InvestmentAccountsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultTab?: 'accounts' | 'angel';
  /** When provided, the matching portfolio's detail dialog opens automatically. */
  initialPortfolioId?: string | null;
}

export function InvestmentAccountsDrawer({ open, onOpenChange, defaultTab = 'accounts', initialPortfolioId = null }: InvestmentAccountsDrawerProps) {
  const { portfolios, totalInvested, loading, refetch } = useCapitalOpportunities();
  const { hasShares, totalShares, companyOwnershipPct, totalInvested: angelInvested, poolOwnershipPct, records, valuations } = useMyAngelShares();
  const { formatAmount } = useCurrency();
  const { wallet, refreshWallet } = useWallet();
  const [selectedPortfolio, setSelectedPortfolio] = useState<PortfolioRecord | null>(null);
  const [showDetail, setShowDetail] = useState(false);
  const [topUpTarget, setTopUpTarget] = useState<PortfolioRecord | null>(null);

  /** Deep-link: auto-open the detail dialog for a specific portfolio (dashboard card tap). */
  useEffect(() => {
    if (!open || !initialPortfolioId) return;
    const match = portfolios.find(p => p.id === initialPortfolioId);
    if (match) {
      setSelectedPortfolio(match);
      setShowDetail(true);
    }
  }, [open, initialPortfolioId, portfolios]);

  // One statement covering every portfolio the partner holds.
  const [exportingAll, setExportingAll] = useState(false);

  const handleExportAll = async () => {
    hapticTap();
    setExportingAll(true);
    try {
      await downloadPartnerStatement();
      toast.success('Statement ready', {
        description: 'Every portfolio in one PDF, saved to your device.',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the statement');
    }
    setExportingAll(false);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        {/* A full mobile screen: app bar, tab bar, then the scrolling body. The sheet's drag handle is hidden. */}
        <SheetContent
          side="bottom"
          className="plan-detail-sheet flex h-[100dvh] flex-col gap-0 rounded-none bg-background p-0 sm:h-[94dvh] sm:rounded-t-[28px] [&>div.sticky:first-child]:hidden"
        >
          {/* App bar */}
          <div className="flex h-14 shrink-0 items-center gap-1 px-1 pt-[env(safe-area-inset-top)]">
            <button
              type="button"
              onClick={() => { hapticTap(); onOpenChange(false); }}
              aria-label="Back"
              className="grid h-11 w-11 place-items-center rounded-full text-foreground transition-colors active:bg-muted"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <SheetTitle className="flex-1 truncate text-lg font-semibold tracking-tight">My Support</SheetTitle>
            <button
              type="button"
              onClick={handleExportAll}
              disabled={exportingAll}
              aria-label="Download full statement"
              title="Full statement"
              className="grid h-11 w-11 place-items-center rounded-full text-foreground transition-colors active:bg-muted disabled:opacity-50"
            >
              {exportingAll ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}
            </button>
          </div>

          <Tabs defaultValue={defaultTab} className="flex min-h-0 flex-1 flex-col">
            {/* Tab bar */}
            <TabsList variant="underline" className="grid h-12 w-full shrink-0 grid-cols-2 gap-0">
              <TabsTrigger
                value="accounts"
                variant="underline"
                className="h-12 pb-0 text-sm data-[state=active]:text-primary"
              >
                Support Accounts
              </TabsTrigger>
              <TabsTrigger
                value="angel"
                variant="underline"
                className="h-12 pb-0 text-sm data-[state=active]:text-primary"
              >
                Angel Shares
              </TabsTrigger>
            </TabsList>

            <ScrollArea className="min-h-0 flex-1 bg-muted/30">
              <div className="px-4 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-4">
                {/* Support Accounts Tab */}
                <TabsContent value="accounts" className="space-y-3 mt-0">
                  {loading ? (
                    <div className="flex justify-center py-10">
                      <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : portfolios.length === 0 ? (
                    <div className="py-10 text-center space-y-2">
                      <div className="w-12 h-12 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto">
                        <Wallet className="h-6 w-6 text-muted-foreground/50" />
                      </div>

                      <p className="text-sm font-semibold">No support accounts yet</p>
                      <p className="text-xs text-muted-foreground">Fund an opportunity to create your first account</p>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-[20px] bg-primary p-5 text-primary-foreground">
                        <p className="text-xs font-medium opacity-80">Total deployed</p>
                        <p className="mt-1 text-[28px] font-bold leading-tight tabular-nums">{formatUGX(totalInvested)}</p>
                        <p className="mt-1 text-xs opacity-80">{portfolios.length} account{portfolios.length !== 1 ? 's' : ''}</p>
                      </div>
                      <p className="px-1 pt-2 text-xs font-semibold text-muted-foreground">Accounts</p>
                      <div className="divide-y divide-border/60 overflow-hidden rounded-[20px] bg-card">
                        {portfolios.map(p => (
                          <PortfolioRow
                            key={p.id}
                            p={p}
                            onTap={() => {
                              setSelectedPortfolio(p);
                              setShowDetail(true);
                            }}
                          />
                        ))}
                      </div>
                    </>
                  )}
                </TabsContent>

                {/* Angel Shares Tab */}
                <TabsContent value="angel" className="space-y-3 mt-0">
                  {!hasShares ? (
                    <div className="py-10 text-center space-y-2">
                      <div className="w-12 h-12 rounded-2xl bg-[hsl(270,70%,50%)]/10 flex items-center justify-center mx-auto">
                        <Briefcase className="h-6 w-6 text-[hsl(270,70%,50%)]/50" />
                      </div>
                      <p className="text-sm font-semibold">No angel shares yet</p>
                      <p className="text-xs text-muted-foreground">Support the angel pool to own company equity</p>
                    </div>
                  ) : (
                    <>
                      <div className="rounded-[20px] bg-primary p-5 text-primary-foreground">
                        <p className="text-xs font-medium opacity-80">Total angel support</p>
                        <p className="mt-1 text-[28px] font-bold leading-tight tabular-nums">{formatAmount(angelInvested)}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-x-3 text-xs opacity-80">
                          <span className="font-semibold">{totalShares} shares</span>
                          <span>{companyOwnershipPct.toFixed(4)}% equity</span>
                          <span>{poolOwnershipPct.toFixed(2)}% pool</span>
                        </div>
                      </div>

                      {valuations.length > 0 && (
                        <div className="space-y-2">
                          <p className="px-1 pt-2 text-xs font-semibold text-muted-foreground">Your share value at</p>
                          <div className="divide-y divide-border/60 overflow-hidden rounded-[20px] bg-card">
                          {valuations.map(v => (
                            <div key={v.label} className="px-4 py-3.5">
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-xs text-muted-foreground">{v.label}</p>
                                  <p className="text-[10px] text-muted-foreground/60">Company: ${(v.value / 1_000_000).toFixed(1)}M</p>
                                </div>
                                <div className="text-right">
                                  <p className="text-sm font-black text-[hsl(270,70%,50%)]">${v.myValue.toFixed(2)}</p>
                                  <p className="text-[10px] text-muted-foreground">{formatUGX(v.myValueUGX)}</p>
                                </div>
                              </div>
                            </div>
                          ))}
                          </div>
                        </div>
                      )}

                      {records.length > 0 && (
                        <div className="space-y-2">
                          <p className="px-1 pt-2 text-xs font-semibold text-muted-foreground">Transaction history</p>
                          <div className="divide-y divide-border/60 overflow-hidden rounded-[20px] bg-card">
                          {records.map(r => (
                            <div key={r.id} className="px-4 py-3.5">
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-sm font-bold">{r.shares} shares</p>
                                  <p className="text-[10px] text-muted-foreground">
                                    {new Date(r.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                                  </p>
                                </div>
                                <div className="text-right">
                                  <p className="text-sm font-bold">{formatAmount(r.amount)}</p>
                                  <Badge
                                    variant={r.status === 'confirmed' ? 'default' : 'secondary'}
                                    className="text-[9px]"
                                  >
                                    {r.status}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                          ))}
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        </SheetContent>
      </Sheet>

      <PortfolioDetailSheet
        portfolio={selectedPortfolio}
        open={showDetail}
        onOpenChange={setShowDetail}
        onRenamed={refetch}
        onTopUp={(p) => setTopUpTarget(p)}
      />

      {topUpTarget && (
        <FundAccountDialog
          open={!!topUpTarget}
          onOpenChange={(open) => { if (!open) setTopUpTarget(null); }}
          accountName={topUpTarget.account_name || topUpTarget.portfolio_code || 'Support Account'}
          accountId={topUpTarget.id}
          walletBalance={wallet?.balance || 0}
          currentBalance={Number(topUpTarget.investment_amount) || 0}
          onDeposit={() => window.dispatchEvent(new CustomEvent('open-deposit'))}
          onFund={async (portfolioId, amt) => {
            const { data, error } = await supabase.functions.invoke('portfolio-topup', {
              body: { portfolio_id: portfolioId, amount: amt },
            });
            if (error || data?.error) {
              toast.error(data?.error || error?.message || 'Top-up failed');
              throw new Error(data?.error || 'Failed');
            }
            toast.success('Transfer request submitted', { description: `Your transfer to ${topUpTarget.account_name || topUpTarget.portfolio_code} is awaiting Partner Ops approval. No funds have left your wallet yet.` });
            refreshWallet();
            refetch();
          }}
        />
      )}
    </>
  );
}
