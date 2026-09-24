import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
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
  Pencil, Check, X, Download, Share2, FileText, AlertTriangle, MessageCircle

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

/** Returns days until next ROI date, or null if not available */
function daysUntilNextRoi(nextRoiDate: string | null | undefined): number | null {
  const dateOnly = extractDateOnly(nextRoiDate);
  if (!dateOnly) return null;
  const target = dateOnlyToLocalDate(dateOnly);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return differenceInCalendarDays(target, today);
}

function NextRoiIndicator({ nextRoiDate }: { nextRoiDate: string | null | undefined }) {
  const days = daysUntilNextRoi(nextRoiDate);
  if (days === null) return null;
  const isUrgent = days <= 5;
  return (
    <span className={`text-[10px] font-semibold flex items-center gap-1 ${isUrgent ? 'text-destructive' : 'text-success'}`}>
      <Calendar className={`h-2.5 w-2.5 ${isUrgent ? 'animate-pulse' : ''}`} />
      {days <= 0 ? 'Due today' : `${days}d to ROI`}
    </span>
  );
}

function PortfolioRow({ p, onTap }: { p: PortfolioRecord; onTap: () => void }) {
  const roi = (Number(p.investment_amount) * Number(p.roi_percentage)) / 100;
  const cfg = statusConfig[p.status] || { label: p.status, variant: 'outline' as const, dot: 'bg-muted-foreground/40' };
  const name = p.account_name || p.portfolio_code || 'Investment Account';
  const matDate = p.maturity_date ? new Date(p.maturity_date) : null;
  const isExpired = !!matDate && differenceInCalendarDays(matDate, new Date()) < 0 && p.status === 'active';

  return (
    <button
      onClick={() => { hapticTap(); onTap(); }}
      className="w-full text-left active:scale-[0.98] transition-transform"
    >
      <Card className={`p-3.5 flex items-center gap-3 hover:bg-accent/30 transition-colors ${isExpired ? 'border-2 border-destructive/60 ring-1 ring-destructive/20' : 'border-border/60'}`}>
        <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Wallet className="h-4.5 w-4.5 text-primary" />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold truncate">{name}</span>
            {isExpired ? (
              <Badge variant="destructive" size="sm" className="shrink-0 gap-1">
                <AlertTriangle className="h-2.5 w-2.5" /> Expired
              </Badge>
            ) : (
              <Badge variant={cfg.variant} size="sm" className="shrink-0">{cfg.label}</Badge>
            )}
          </div>
          {p.portfolio_code && (
            <p className="text-[10px] text-muted-foreground/60 font-mono mt-0.5 flex items-center gap-1">
              <Hash className="h-2.5 w-2.5" />{p.portfolio_code}
            </p>
          )}
          <div className="flex items-center justify-between mt-1">
            <span className="text-xs font-semibold">{formatUGX(Number(p.investment_amount))}</span>
            <span className="text-[11px] text-success font-semibold flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              {p.roi_percentage}% → {formatUGX(roi)}/mo
            </span>
          </div>
          <div className="flex items-center justify-between mt-0.5">
            {Number(p.total_roi_earned) > 0 && (
              <p className="text-[10px] text-success">
                Earned: {formatUGX(Number(p.total_roi_earned))}
              </p>
            )}
            <NextRoiIndicator nextRoiDate={p.next_roi_date} />
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/40 shrink-0" />
      </Card>
    </button>
  );
}

function DetailRow({ label, value, icon: Icon, valueClassName }: { label: string; value: string; icon?: React.ElementType; valueClassName?: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 border-b border-border/40 last:border-0">
      <span className="text-xs text-muted-foreground font-medium flex items-center gap-1.5">
        {Icon && <Icon className="h-3.5 w-3.5" />}
        {label}
      </span>
      <span className={`text-xs font-bold text-foreground ${valueClassName || ''}`}>{value}</span>
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
  const name = portfolio.account_name || portfolio.portfolio_code || 'Investment Account';
  const isActive = portfolio.status === 'active';

  // Next ROI date urgency
  const roiDays = daysUntilNextRoi(portfolio.next_roi_date);
  const roiUrgent = roiDays !== null && roiDays <= 5;

  const handleRename = async () => {
    const trimmed = newName.trim();
    if (!trimmed || !portfolio.id) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from('investor_portfolios')
        .update({ account_name: trimmed } as any)
        .eq('id', portfolio.id);
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
        description: 'Choose "Save as PDF" in the print window to keep a copy.',
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
      const { error } = await supabase
        .from('investor_portfolios')
        .update({ auto_reinvest: newValue })
        .eq('id', portfolio.id);
      if (error) throw error;
      setLocalAutoReinvest(newValue);
      toast.success(`Auto-reinvest ${newValue ? 'enabled' : 'disabled'}`);
      onRenamed(); // triggers refetch
    } catch {
      toast.error('Failed to update auto-reinvest setting');
    } finally {
      setTogglingReinvest(false);
    }
  };

  const handleShare = () => {
    const displayName = portfolio.account_name || portfolio.portfolio_code || 'Investment Account';
    const monthlyROI = Math.round(amount * (roiPct / 100));
    const message = [
      `📊 *Investment Portfolio: ${displayName}*`,
      ``,
      `💰 Capital: ${formatUGX(amount)}`,
      `📈 ROI Rate: ${roiPct}% per month`,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-primary shadow-lg">
              <Wallet className="h-5 w-5 text-primary-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              {isRenaming ? (
                <div className="flex items-center gap-2">
                  <Input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="New account name"
                    className="h-8 text-sm"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleRename()}
                  />
                  <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={handleRename} disabled={saving || !newName.trim()}>
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5 text-success" />}
                  </Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" onClick={() => setIsRenaming(false)}>
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-base font-black block truncate">{name}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6 shrink-0"
                    onClick={() => { setNewName(portfolio.account_name || ''); setIsRenaming(true); }}
                  >
                    <Pencil className="h-3 w-3 text-muted-foreground" />
                  </Button>
                </div>
              )}
              <div className="flex items-center gap-2 mt-0.5">
                {portfolio.portfolio_code && (
                  <span className="text-[10px] font-mono text-muted-foreground">{portfolio.portfolio_code}</span>
                )}
                <Badge variant={cfg.variant} size="sm">{cfg.label}</Badge>
              </div>
            </div>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 px-5 pb-5">
          {/* Total Value Hero */}
          <div className="p-5 rounded-2xl bg-primary/5 border border-primary/20">
            <div className="flex items-center justify-between gap-2 mb-1">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Total Value</p>
              {pendingTopup > 0 && (
                <Badge variant="warning" size="sm" className="gap-1">
                  <Clock className="h-3 w-3" />
                  +{formatUGX(pendingTopup)} being added
                </Badge>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <p className="text-3xl font-black">{formatUGX(totalValue)}</p>
              {totalEarned > 0 && (
                <span className="flex items-center gap-0.5 text-sm font-bold text-success">
                  <ArrowUpRight className="h-4 w-4" />
                  +{formatUGX(totalEarned)}
                </span>
              )}
            </div>
            {pendingTopup > 0 && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                Your top-up of <span className="font-bold text-warning">{formatUGX(pendingTopup)}</span> is pending and will be added right after your next returns payout.
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
            <div className="p-4 rounded-xl bg-muted/50 border border-border/60">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Principal</p>
              <p className="font-bold text-lg">{formatUGX(amount)}</p>
            </div>
            <div className="p-4 rounded-xl bg-success/10 border border-success/20">
              <p className="text-[10px] uppercase tracking-wider text-success/80 font-semibold mb-1">Monthly Return</p>
              <p className="font-bold text-lg text-success">{formatUGX(monthlyReturn)}</p>
            </div>
          </div>

          {/* Detail Rows */}
          <div className="rounded-xl border border-border/60 px-3.5">
            <DetailRow label="ROI Rate" value={`${roiPct}% / month`} icon={TrendingUp} />
            <DetailRow label="Total ROI Earned" value={formatUGX(totalEarned)} icon={Wallet} />
            {portfolio.roi_mode && (
              <DetailRow label="ROI Mode" value={portfolio.roi_mode} icon={RefreshCw} />
            )}
            {portfolio.duration_months && (
              <DetailRow label="Duration" value={`${portfolio.duration_months} months`} icon={Clock} />
            )}
            {portfolio.maturity_date && (
              <DetailRow label="Maturity Date" value={formatDateOnlyForDisplay(portfolio.maturity_date)} icon={Calendar} />
            )}
            {portfolio.next_roi_date && (
              <DetailRow
                label="Next ROI Date"
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

          {/* Share & Download */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1 h-10 gap-2 text-xs font-semibold"
              onClick={() => { hapticTap(); setReportChoiceOpen(true); }}
              disabled={downloading || downloadingStatement}
            >
              {(downloading || downloadingStatement)
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Download className="h-3.5 w-3.5" />}
              Download report
            </Button>
            <Button
              variant="outline"
              className="flex-1 h-10 gap-2 text-xs font-semibold"
              onClick={handleShare}
            >
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
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

           {/* Auto-Support Toggle */}
          {isActive && (
            <div className="flex items-center justify-between p-3.5 rounded-xl border border-border/60 bg-muted/30">
              <div className="flex items-center gap-2">
                <RefreshCw className={`h-4 w-4 ${autoReinvestValue ? 'text-primary' : 'text-muted-foreground'}`} />
                <div>
                   <p className="text-xs font-bold">Auto-Support</p>
                  <p className="text-[10px] text-muted-foreground">Automatically compound your returns</p>
                </div>
              </div>
              <Button
                size="sm"
                variant={autoReinvestValue ? 'default' : 'outline'}
                className="h-8 text-xs font-semibold min-w-[70px]"
                onClick={handleToggleAutoReinvest}
                disabled={togglingReinvest}
              >
                {togglingReinvest ? <Loader2 className="h-3 w-3 animate-spin" /> : autoReinvestValue ? 'On' : 'Off'}
              </Button>
            </div>
          )}
          {isActive && (
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  onTopUp?.(portfolio);
                  onOpenChange(false);
                }}
                className="flex-1 h-11 font-semibold gap-2"
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
                className="flex-1 h-11 font-semibold gap-2 border-destructive/30 text-destructive hover:bg-destructive/10"
              >
                <ArrowDownToLine className="h-4 w-4" />
                Withdraw
              </Button>
            </div>
          )}

          {/* Info Hint */}
          <div className="p-3 rounded-xl bg-primary/5 border border-primary/20 flex items-start gap-2">
            <TrendingUp className="h-4 w-4 text-primary mt-0.5 shrink-0" />
            <p className="text-[11px] text-muted-foreground">
              Your capital earns <strong className="text-foreground">{roiPct}% monthly</strong>. Returns are credited automatically each cycle. Top up anytime to grow your portfolio.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
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
        description: 'Every portfolio in one document — choose "Save as PDF" to keep a copy.',
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the statement');
    }
    setExportingAll(false);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-3xl p-0 flex flex-col">
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/60 shrink-0">
            <SheetTitle className="flex items-center justify-between gap-2.5">
              <span className="flex items-center gap-2.5">
                <span className="p-2 rounded-xl bg-primary/10">
                  <Briefcase className="h-4 w-4 text-primary" />
                </span>
                <span className="text-base font-black">My Support</span>
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 text-[11px] font-semibold shrink-0"
                onClick={handleExportAll}
                disabled={exportingAll}
              >
                {exportingAll
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <FileText className="h-3.5 w-3.5" />}
                Full statement
              </Button>
            </SheetTitle>
          </SheetHeader>

          <Tabs defaultValue={defaultTab} className="flex-1 flex flex-col min-h-0">
            <div className="px-4 pt-3 shrink-0">
              <TabsList className="w-full grid grid-cols-2 h-10">
                <TabsTrigger value="accounts" className="text-xs font-bold" type="button">
                  Support Accounts
                </TabsTrigger>
                <TabsTrigger value="angel" className="text-xs font-bold" type="button">
                  Angel Shares
                </TabsTrigger>
              </TabsList>
            </div>

            <ScrollArea className="flex-1 min-h-0">
              <div className="px-4 pb-6 pt-3">
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

                      <p className="text-sm font-semibold">No investment accounts yet</p>
                      <p className="text-xs text-muted-foreground">Fund an opportunity to create your first account</p>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 rounded-2xl bg-primary/5 border border-primary/20">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Total Deployed</p>
                        <p className="text-2xl font-black">{formatUGX(totalInvested)}</p>
                        <p className="text-[11px] text-muted-foreground mt-0.5">{portfolios.length} account{portfolios.length !== 1 ? 's' : ''}</p>
                      </div>
                      <div className="space-y-2">
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
                      <p className="text-xs text-muted-foreground">Invest in the angel pool to own company equity</p>
                    </div>
                  ) : (
                    <>
                      <div className="p-4 rounded-2xl bg-[hsl(270,60%,97%)] dark:bg-[hsl(270,30%,15%)] border border-[hsl(270,70%,50%)]/20">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">Total Angel Investment</p>
                        <p className="text-2xl font-black">{formatAmount(angelInvested)}</p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-[11px] text-[hsl(270,70%,50%)] font-semibold">{totalShares} shares</span>
                          <span className="text-[11px] text-muted-foreground">{companyOwnershipPct.toFixed(4)}% equity</span>
                          <span className="text-[11px] text-muted-foreground">{poolOwnershipPct.toFixed(2)}% pool</span>
                        </div>
                      </div>

                      {valuations.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider px-1">Your Share Value At</p>
                          {valuations.map(v => (
                            <Card key={v.label} className="p-3 border-border/60">
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
                            </Card>
                          ))}
                        </div>
                      )}

                      {records.length > 0 && (
                        <div className="space-y-2">
                          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider px-1">Transaction History</p>
                          {records.map(r => (
                            <Card key={r.id} className="p-3 border-border/60">
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
                            </Card>
                          ))}
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
          accountName={topUpTarget.account_name || topUpTarget.portfolio_code || 'Investment Account'}
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
