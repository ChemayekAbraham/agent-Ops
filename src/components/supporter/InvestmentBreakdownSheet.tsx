import { useState, useEffect } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useCurrency } from '@/hooks/useCurrency';
import { useWallet } from '@/hooks/useWallet';
import { supabase } from '@/integrations/supabase/client';
import { PiggyBank, TrendingUp, Repeat, ArrowUpRight, CalendarCheck, CircleDollarSign, Target, Plus, FileText, Share2, CreditCard, RefreshCw, LogOut, ToggleLeft, ToggleRight, Pencil, Check, X, Gem } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { AngelSharesTab } from './AngelSharesTab';
import { downloadPortfolioPdf, sharePortfolioViaWhatsApp } from '@/lib/portfolioPdf';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { format, formatDistanceToNow, differenceInDays, isPast, addDays } from 'date-fns';
import { FundAccountDialog } from './FundAccountDialog';
import { toast } from 'sonner';
import { PayoutMethodDialog } from './PayoutMethodDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface InvestmentBreakdownSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface InvestmentEntry {
  id: string; code: string; account_name: string | null; amount: number; roi_percentage: number;
  roi_mode: string; total_earned: number; status: string; invested_at: string;
  duration_months: number; next_roi_date: string | null; maturity_date: string | null;
  payout_day: number | null; auto_reinvest: boolean; source: 'portfolio' | 'ledger';
}

export function InvestmentBreakdownSheet({ open, onOpenChange }: InvestmentBreakdownSheetProps) {
  const { user } = useAuth();
  const { formatAmount } = useCurrency();
  const { wallet, refreshWallet } = useWallet();
  const [entries, setEntries] = useState<InvestmentEntry[]>([]);
  const [pendingByPortfolio, setPendingByPortfolio] = useState<Record<string, { count: number; total: number }>>({});
  const [loading, setLoading] = useState(true);
  const [topUpTarget, setTopUpTarget] = useState<{ id: string; name: string; balance: number } | null>(null);
  const [payoutTarget, setPayoutTarget] = useState<{ id: string; name: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [withdrawDialog, setWithdrawDialog] = useState<{ id: string; name: string; maxAmount: number } | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const handleRename = async (portfolioId: string) => {
    const trimmed = renameValue.trim();
    if (!trimmed) { toast.error('Please enter a name'); return; }
    try {
      const { error } = await supabase.from('investor_portfolios').update({ account_name: trimmed }).eq('id', portfolioId);
      if (error) throw error;
      toast.success(`Account renamed to "${trimmed}"`);
      setRenamingId(null);
      setRenameValue('');
      fetchAll();
    } catch (err: any) { toast.error(err.message || 'Rename failed'); }
  };

  const handleAccountAction = async (action: string, portfolioId: string, accountName: string, extra?: any) => {
    setActionLoading(`${action}-${portfolioId}`);
    try {
      const { data, error } = await supabase.functions.invoke('supporter-account-action', {
        body: { action, portfolio_id: portfolioId, ...extra },
      });
      if (error || data?.error) throw new Error(data?.error || error?.message || 'Action failed');

      if (action === 'renew') {
        toast.success(`"${accountName}" renewed for 12 months! 📧 Confirmation email sent.`);
      } else if (action === 'withdraw_capital') {
        toast.success(`Withdrawal requested for "${accountName}". 📧 Email confirmation sent.`);
        setWithdrawDialog(null);
        setWithdrawAmount('');
      } else if (action === 'toggle_roi_mode') {
        const modeLabel = data?.new_mode === 'compound' ? 'Compounding' : 'Simple';
        toast.success(`"${accountName}" switched to ${modeLabel} mode. 📧 Email sent.`);
      }
      fetchAll();
    } catch (err: any) {
      toast.error(err.message || 'Action failed');
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => { if (open && user) fetchAll(); }, [open, user]);

  const fetchAll = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [{ data: byInvestor, error: e1 }, { data: byAgent, error: e2 }] = await Promise.all([
        supabase.from('investor_portfolios')
          .select('id, portfolio_code, account_name, investment_amount, roi_percentage, roi_mode, total_roi_earned, status, created_at, duration_months, next_roi_date, maturity_date, payout_day, auto_reinvest')
          .eq('investor_id', user.id).neq('status', 'cancelled').order('created_at', { ascending: false }),
        supabase.from('investor_portfolios')
          .select('id, portfolio_code, account_name, investment_amount, roi_percentage, roi_mode, total_roi_earned, status, created_at, duration_months, next_roi_date, maturity_date, payout_day, auto_reinvest')
          .eq('agent_id', user.id).neq('status', 'cancelled').order('created_at', { ascending: false }),
      ]);
      if (e1 || e2) { console.error(e1 || e2); setEntries([]); return; }
      const seen = new Set<string>();
      const result: InvestmentEntry[] = [];
      const portfolioIds: string[] = [];
      for (const p of [...(byInvestor || []), ...(byAgent || [])]) {
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        portfolioIds.push(p.id);
        result.push({
          id: p.id, code: p.portfolio_code, account_name: (p as any).account_name || null, amount: Number(p.investment_amount),
          roi_percentage: Number(p.roi_percentage), roi_mode: p.roi_mode,
          total_earned: Number(p.total_roi_earned), status: p.status,
          invested_at: p.created_at, duration_months: p.duration_months,
          next_roi_date: p.next_roi_date, maturity_date: p.maturity_date,
          payout_day: (p as any).payout_day ?? null, auto_reinvest: !!(p as any).auto_reinvest, source: 'portfolio',
        });
      }
      setEntries(result);

      // Fetch pending top-ups for all portfolios
      if (portfolioIds.length > 0) {
        const { data: pendingOps } = await supabase
          .from('pending_wallet_operations')
          .select('source_id, amount')
          .in('source_id', portfolioIds)
          .eq('source_table', 'investor_portfolios')
          .eq('operation_type', 'portfolio_topup')
          .eq('status', 'pending');

        const pending: Record<string, { count: number; total: number }> = {};
        (pendingOps || []).forEach((op: any) => {
          const key = op.source_id;
          if (!pending[key]) pending[key] = { count: 0, total: 0 };
          pending[key].count++;
          pending[key].total += Number(op.amount);
        });
        setPendingByPortfolio(pending);
      } else {
        setPendingByPortfolio({});
      }
    } catch (e) { console.error(e); } finally { setLoading(false); }
  };

  const totalInvested = entries.reduce((s, a) => s + a.amount, 0);
  const totalPending = Object.values(pendingByPortfolio).reduce((s, p) => s + p.total, 0);
  const totalEarned = entries.reduce((s, a) => s + a.total_earned, 0);
  const expectedMonthly = entries.reduce((s, a) => s + a.amount * (a.roi_percentage / 100), 0);

  const statusConfig = (status: string) => {
    switch (status) {
      case 'active': return { label: 'Active', cls: 'bg-success/10 text-success border-success/20', dot: 'bg-success' };
      case 'pending': case 'pending_activation': return { label: 'Pending', cls: 'bg-warning/10 text-warning border-warning/20', dot: 'bg-warning' };
      case 'matured': return { label: 'Matured', cls: 'bg-primary/10 text-primary border-primary/20', dot: 'bg-primary' };
      default: return { label: status, cls: 'bg-muted text-muted-foreground', dot: 'bg-muted-foreground' };
    }
  };

  const colors = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#0891b2', '#8b5cf6', '#ea580c'];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[90vh] rounded-t-3xl p-0">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border/40">
          <SheetTitle className="text-base font-bold flex items-center gap-2">
            <PiggyBank className="h-4 w-4 text-primary" />
            My Support Accounts
            {!loading && entries.length > 0 && (
              <span className="text-[10px] font-medium text-muted-foreground ml-auto">{entries.length}</span>
            )}
          </SheetTitle>
        </SheetHeader>

        <Tabs defaultValue="accounts" className="flex-1 flex flex-col min-h-0">
          <TabsList variant="underline" className="px-5 pt-1 shrink-0">
            <TabsTrigger variant="underline" value="accounts" className="gap-1.5 text-xs">
              <PiggyBank className="h-3.5 w-3.5" />
              Support Accounts
            </TabsTrigger>
            <TabsTrigger variant="underline" value="angel-shares" className="gap-1.5 text-xs">
              <Gem className="h-3.5 w-3.5" />
              Angel Shares
            </TabsTrigger>
          </TabsList>

          <TabsContent value="accounts" className="mt-0 flex-1 min-h-0">
            {/* Summary */}
            <div className="mx-5 my-3 rounded-xl border border-border/40 p-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <CircleDollarSign className="h-3.5 w-3.5 text-primary mx-auto mb-1 opacity-60" />
                  <p className="text-[8px] text-muted-foreground uppercase tracking-[0.1em] font-medium">Active Capital</p>
                  <p className="text-[clamp(0.6rem,2.6vw,0.75rem)] font-extrabold text-foreground mt-0.5 truncate"><CompactAmount value={totalInvested} /></p>
                  {totalPending > 0 && (
                    <p className="text-[9px] font-semibold text-warning mt-0.5">+<CompactAmount value={totalPending} /> pending</p>
                  )}
                </div>
                <div>
                  <ArrowUpRight className="h-3.5 w-3.5 text-success mx-auto mb-1 opacity-60" />
                  <p className="text-[8px] text-muted-foreground uppercase tracking-[0.1em] font-medium">Earned</p>
                  <p className="text-[clamp(0.6rem,2.6vw,0.75rem)] font-extrabold text-success mt-0.5 truncate"><CompactAmount value={totalEarned} /></p>
                </div>
                <div>
                  <Target className="h-3.5 w-3.5 text-primary mx-auto mb-1 opacity-60" />
                  <p className="text-[8px] text-muted-foreground uppercase tracking-[0.1em] font-medium">Monthly</p>
                  <p className="text-[clamp(0.6rem,2.6vw,0.75rem)] font-extrabold text-foreground mt-0.5 truncate"><CompactAmount value={expectedMonthly} /></p>
                </div>
              </div>
            </div>

            <ScrollArea className="h-[calc(90vh-240px)] px-5 pb-8">
              {loading ? (
                <div className="space-y-3">{[1, 2, 3].map(i => <Skeleton key={i} className="h-36 w-full rounded-xl" />)}</div>
              ) : entries.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <PiggyBank className="h-10 w-10 text-muted-foreground/30 mb-3" />
                  <p className="text-sm font-medium text-muted-foreground">No accounts yet</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Support a tenant to get started</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {entries.map((entry, idx) => {
                    const monthlyReturn = entry.amount * (entry.roi_percentage / 100);
                    const isCompounding = entry.roi_mode === 'compound' || entry.roi_mode === 'monthly_compounding';
                    const color = colors[idx % colors.length];
                    const sc = statusConfig(entry.status);

                    const now = new Date();
                    const investedDate = new Date(entry.invested_at);
                    let nextPayout: Date;
                    if (entry.payout_day) {
                      nextPayout = new Date(now.getFullYear(), now.getMonth(), entry.payout_day);
                      if (nextPayout <= now) nextPayout = new Date(now.getFullYear(), now.getMonth() + 1, entry.payout_day);
                    } else {
                      const THIRTY = 30 * 24 * 60 * 60 * 1000;
                      const cycles = Math.floor((now.getTime() - investedDate.getTime()) / THIRTY);
                      nextPayout = new Date(investedDate.getTime() + (cycles + 1) * THIRTY);
                    }
                    const maturity = entry.maturity_date ? new Date(entry.maturity_date) : null;
                    const daysToNext = differenceInDays(nextPayout, now);
                    const isExpired = !!maturity && isPast(maturity);

                    const projectionRows: { month: number; date: Date; opening: number; earned: number; closing: number }[] = [];
                    if (isCompounding) {
                      let bal = entry.amount;
                      for (let m = 1; m <= entry.duration_months; m++) {
                        const earned = bal * (entry.roi_percentage / 100);
                        const payoutDate = entry.payout_day
                          ? new Date(investedDate.getFullYear(), investedDate.getMonth() + m, entry.payout_day)
                          : addDays(investedDate, m * 30);
                        projectionRows.push({ month: m, date: payoutDate, opening: bal, earned, closing: bal + earned });
                        bal += earned;
                      }
                    }
                    const finalValue = projectionRows.length > 0 ? projectionRows[projectionRows.length - 1].closing : 0;
                    const growthPct = entry.amount > 0 ? ((finalValue - entry.amount) / entry.amount * 100) : 0;

                    return (
                      <div
                        key={entry.id}
                        className={`rounded-xl bg-card overflow-hidden border-l-[3px] animate-fade-in ${isExpired ? 'border-2 border-destructive/60 ring-1 ring-destructive/20' : 'border border-border/40'}`}
                        style={{ borderLeftColor: isExpired ? 'hsl(var(--destructive))' : color, animationDelay: `${idx * 60}ms` }}
                      >
                        {isExpired && (
                          <div className="px-4 pt-3">
                            <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 flex items-start gap-2">
                              <RefreshCw className="h-3.5 w-3.5 text-destructive mt-0.5 shrink-0" />
                              <div className="min-w-0">
                                <p className="text-[11px] font-bold text-destructive">
                                  Portfolio expired on {format(maturity!, 'dd MMM yyyy')}
                                </p>
                                <p className="text-[10px] text-muted-foreground mt-0.5">
                                  This portfolio will be auto-renewed on the next payout cycle or nightly renewal sweep. Tap Renew to roll it forward now.
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                        {/* Header */}
                        <div className="flex items-center gap-3 p-4 pb-3">
                          <div
                            className="h-10 w-10 rounded-xl flex items-center justify-center text-white text-xs font-extrabold shrink-0"
                            style={{ backgroundColor: color }}
                          >
                            {String(idx + 1).padStart(2, '0')}
                          </div>
                          <div className="flex-1 min-w-0">
                            {entry.account_name && renamingId !== entry.id && (
                              <p className="text-sm font-bold text-foreground truncate leading-tight">{entry.account_name}</p>
                            )}
                            {renamingId === entry.id ? (
                              <div className="flex items-center gap-1.5">
                                <Input
                                  value={renameValue}
                                  onChange={(e) => setRenameValue(e.target.value)}
                                  placeholder="e.g. Rent Fund Alpha"
                                  className="h-7 text-xs bg-muted/50 rounded-lg"
                                  autoFocus
                                  onKeyDown={(e) => { if (e.key === 'Enter') handleRename(entry.id); if (e.key === 'Escape') { setRenamingId(null); setRenameValue(''); } }}
                                />
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-success" onClick={() => handleRename(entry.id)}>
                                  <Check className="h-3.5 w-3.5" />
                                </Button>
                                <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" onClick={() => { setRenamingId(null); setRenameValue(''); }}>
                                  <X className="h-3.5 w-3.5" />
                                </Button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <p className="text-[10px] text-muted-foreground font-mono truncate">{entry.code}</p>
                                <span className={`inline-flex items-center gap-1 text-[9px] font-medium ${sc.cls} px-1.5 py-0.5 rounded-full`}>
                                  <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} />{sc.label}
                                </span>
                              </div>
                            )}
                            {!entry.account_name && renamingId !== entry.id && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setRenamingId(entry.id); setRenameValue(''); }}
                                className="flex items-center gap-1 mt-1.5 px-2 py-1 rounded-lg bg-primary/8 hover:bg-primary/12 text-primary text-[10px] font-semibold transition-colors"
                              >
                                <Pencil className="h-3 w-3" />
                                Name this account
                              </button>
                            )}
                            {entry.account_name && renamingId !== entry.id && (
                              <button
                                onClick={(e) => { e.stopPropagation(); setRenamingId(entry.id); setRenameValue(entry.account_name || ''); }}
                                className="flex items-center gap-1 text-muted-foreground/60 hover:text-primary text-[9px] transition-colors mt-0.5"
                              >
                                <Pencil className="h-2.5 w-2.5" />
                                Rename
                              </button>
                            )}
                          </div>
                          <p className="text-[10px] text-muted-foreground shrink-0">{formatDistanceToNow(investedDate, { addSuffix: true })}</p>
                        </div>

                        {/* Balance row */}
                        <div className="px-4 pb-3 flex items-end justify-between">
                          <div>
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium mb-0.5">Active Capital</p>
                            <p className="text-xl font-black text-foreground font-mono tabular-nums tracking-tight"><CompactAmount value={entry.amount} /></p>
                            {pendingByPortfolio[entry.id] && (
                              <div className="flex items-center gap-1 mt-1">
                                <span className="inline-flex items-center gap-1 text-[9px] font-semibold bg-warning/10 text-warning border border-warning/20 px-1.5 py-0.5 rounded-full">
                                  ⏳ +<CompactAmount value={pendingByPortfolio[entry.id].total} /> pending
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="text-right">
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium mb-0.5">
                              {isCompounding ? 'Month 1' : 'Monthly'}
                            </p>
                            <p className="text-base font-bold text-success font-mono tabular-nums tracking-tight flex items-center gap-0.5 justify-end">
                              <TrendingUp className="h-3 w-3" /><CompactAmount value={monthlyReturn} />
                            </p>
                          </div>
                        </div>

                        {/* Tags */}
                        <div className="px-4 pb-3 flex items-center gap-1.5 flex-wrap">
                          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-primary/8 text-[9px] font-semibold text-primary">
                            {entry.roi_percentage}% ROI
                          </span>
                          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-muted text-[9px] font-semibold text-muted-foreground capitalize">
                            {entry.roi_mode.replace(/_/g, ' ')}
                          </span>
                          <span className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">
                            {entry.duration_months}mo
                          </span>
                        </div>

                        {/* Next Payout */}
                        <div className="mx-4 mb-3 rounded-lg bg-muted/40 border border-border/30 p-3 flex items-center gap-3">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                            <CalendarCheck className="h-3.5 w-3.5 text-primary" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[9px] text-muted-foreground uppercase tracking-wider font-medium">Next Payout</p>
                            <p className="text-xs font-bold text-foreground">{format(nextPayout, 'dd MMM yyyy')}</p>
                          </div>
                          {daysToNext >= 0 ? (
                            <div className="text-right shrink-0">
                              <p className="text-lg font-black text-primary leading-none font-mono tabular-nums">{daysToNext}</p>
                              <p className="text-[7px] text-muted-foreground font-medium uppercase">days</p>
                            </div>
                          ) : (
                            <span className="text-[9px] font-semibold text-warning bg-warning/10 px-2 py-0.5 rounded-full shrink-0">Overdue</span>
                          )}
                        </div>

                        {/* Compound Projection */}
                        {isCompounding && projectionRows.length > 0 && (
                          <div className="mx-4 mb-3">
                            <Accordion type="single" collapsible>
                              <AccordionItem value="proj" className="border rounded-lg overflow-hidden border-border/30 bg-muted/20">
                                <AccordionTrigger className="px-3 py-2.5 hover:no-underline">
                                  <div className="flex items-center gap-2 flex-1 min-w-0">
                                    <Repeat className="h-3.5 w-3.5 text-success shrink-0" />
                                    <div className="text-left min-w-0">
                                      <p className="text-[10px] font-bold text-foreground">Growth Projection</p>
                                      <p className="text-[8px] text-muted-foreground truncate">
                                        <CompactAmount value={entry.amount} /> → <CompactAmount value={finalValue} /> · +{growthPct.toFixed(0)}%
                                      </p>
                                    </div>
                                  </div>
                                </AccordionTrigger>
                                <AccordionContent>
                                  <div className="px-3 pb-3 space-y-1.5">
                                    <div className="grid grid-cols-2 gap-1.5 mb-2">
                                      <div className="rounded-lg bg-card border border-border/30 p-2 text-center">
                                        <p className="text-[7px] text-muted-foreground uppercase">Earnings</p>
                                         <p className="text-xs font-bold text-success font-mono tabular-nums truncate"><CompactAmount value={finalValue - entry.amount} /></p>
                                       </div>
                                       <div className="rounded-lg bg-card border border-border/30 p-2 text-center">
                                         <p className="text-[7px] text-muted-foreground uppercase">Final Value</p>
                                         <p className="text-xs font-bold text-foreground font-mono tabular-nums truncate"><CompactAmount value={finalValue} /></p>
                                      </div>
                                    </div>
                                    {projectionRows.map((row) => {
                                      const isLast = row.month === projectionRows.length;
                                      const past = isPast(row.date);
                                      return (
                                        <div key={row.month}
                                          className={`rounded-lg border p-2 ${isLast ? 'bg-success/5 border-success/15' : 'bg-card border-border/30'}`}>
                                          <div className="flex items-center justify-between mb-1">
                                            <div className="flex items-center gap-1.5">
                                              <span className={`text-[9px] font-bold ${isLast ? 'text-success' : 'text-muted-foreground'}`}>M{row.month}</span>
                                              {past && <span className="text-[7px] font-bold px-1 py-0.5 rounded bg-primary/10 text-primary">PAID</span>}
                                            </div>
                                            <span className="text-[9px] text-muted-foreground font-mono">{format(row.date, 'dd MMM yy')}</span>
                                          </div>
                                          <div className="grid grid-cols-3 gap-1">
                                            <div>
                                              <p className="text-[6px] text-muted-foreground uppercase">Open</p>
                                              <p className="text-[11px] font-bold text-foreground font-mono tabular-nums truncate"><CompactAmount value={row.opening} /></p>
                                            </div>
                                            <div>
                                              <p className="text-[6px] text-muted-foreground uppercase">Reward</p>
                                              <p className={`text-[11px] font-bold font-mono tabular-nums truncate ${isLast ? 'text-success' : 'text-success/80'}`}>+<CompactAmount value={row.earned} /></p>
                                            </div>
                                            <div className="text-right">
                                              <p className="text-[6px] text-muted-foreground uppercase">Close</p>
                                              <p className="text-[11px] font-extrabold text-foreground font-mono tabular-nums truncate"><CompactAmount value={row.closing} /></p>
                                            </div>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </AccordionContent>
                              </AccordionItem>
                            </Accordion>
                          </div>
                        )}

                        {/* Action Buttons */}
                        {entry.status !== 'cancelled' && (
                          <div className="px-4 pb-3 space-y-2">
                            <div className="grid grid-cols-2 gap-2">
                              <Button
                                size="sm"
                                className="gap-1.5 text-xs h-10 min-h-[44px] rounded-lg font-semibold"
                                onClick={() => setTopUpTarget({ id: entry.id, name: entry.account_name || entry.code, balance: Number(entry.amount) || 0 })}
                              >
                                <Plus className="h-3.5 w-3.5" />
                                Top Up
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 text-xs h-10 min-h-[44px] rounded-lg font-semibold border-border/60"
                                onClick={() => setPayoutTarget({ id: entry.id, name: entry.account_name || entry.code })}
                              >
                                <CreditCard className="h-3.5 w-3.5" />
                                Payout Method
                              </Button>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 text-xs h-10 min-h-[44px] rounded-lg font-semibold border-border/60"
                                disabled={actionLoading === `renew-${entry.id}`}
                                onClick={() => {
                                  if (confirm(`Renew "${entry.account_name || entry.code}" for another 12 months?`)) {
                                    handleAccountAction('renew', entry.id, entry.account_name || entry.code);
                                  }
                                }}
                              >
                                <RefreshCw className={`h-3.5 w-3.5 ${actionLoading === `renew-${entry.id}` ? 'animate-spin' : ''}`} />
                                {actionLoading === `renew-${entry.id}` ? 'Renewing…' : 'Renew'}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-1.5 text-xs h-10 min-h-[44px] rounded-lg font-semibold border-amber-500/30 text-amber-600 hover:bg-amber-500/5"
                                disabled={entry.amount <= 0}
                                onClick={() => setWithdrawDialog({ id: entry.id, name: entry.account_name || entry.code, maxAmount: entry.amount })}
                              >
                                <LogOut className="h-3.5 w-3.5" />
                                Withdraw
                              </Button>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1 text-[11px] h-9 rounded-lg text-muted-foreground hover:text-foreground"
                                onClick={() => downloadPortfolioPdf({
                                  portfolioCode: entry.code, accountName: entry.account_name,
                                  investmentAmount: entry.amount, roiPercentage: entry.roi_percentage,
                                  roiMode: entry.roi_mode, totalRoiEarned: entry.total_earned,
                                  status: entry.status, createdAt: entry.invested_at,
                                  durationMonths: entry.duration_months, payoutDay: entry.payout_day,
                                  nextRoiDate: entry.next_roi_date, maturityDate: entry.maturity_date,
                                })}
                              >
                                <FileText className="h-3.5 w-3.5" /> PDF
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="gap-1 text-[11px] h-9 rounded-lg text-success hover:text-success hover:bg-success/5"
                                onClick={() => sharePortfolioViaWhatsApp({
                                  portfolioCode: entry.code, accountName: entry.account_name,
                                  investmentAmount: entry.amount, roiPercentage: entry.roi_percentage,
                                  roiMode: entry.roi_mode, totalRoiEarned: entry.total_earned,
                                  status: entry.status, createdAt: entry.invested_at,
                                  durationMonths: entry.duration_months, payoutDay: entry.payout_day,
                                  nextRoiDate: entry.next_roi_date, maturityDate: entry.maturity_date,
                                })}
                              >
                                <Share2 className="h-3.5 w-3.5" /> WhatsApp
                              </Button>
                            </div>
                          </div>
                        )}

                        {/* Timeline */}
                        <div className="bg-muted/20 border-t border-border/30 px-4 py-3 space-y-1.5">
                          {[
                            { dot: 'bg-primary', label: 'Started', value: format(investedDate, 'dd MMM yyyy') },
                            { dot: 'bg-muted-foreground/40', label: 'Cycle', value: entry.payout_day ? `${entry.payout_day}${['st','nd','rd'][entry.payout_day-1] || 'th'} monthly` : 'Every 30 days' },
                            { dot: 'bg-success', label: 'Earned', value: formatAmount(entry.total_earned), extra: 'text-success font-extrabold' },
                          ].map((t, i) => (
                            <div key={i} className="flex items-center gap-2.5">
                              <div className={`h-1.5 w-1.5 rounded-full ${t.dot} shrink-0`} />
                              <span className="text-[9px] text-muted-foreground font-medium w-12 shrink-0">{t.label}</span>
                              <span className={`text-[10px] font-semibold text-foreground truncate font-mono tabular-nums ${t.extra || ''}`}>{t.value}</span>
                            </div>
                          ))}
                          {maturity && (
                            <div className="flex items-center gap-2.5">
                              <div className={`h-1.5 w-1.5 rounded-full ${isPast(maturity) ? 'bg-warning' : 'bg-muted-foreground/40'} shrink-0`} />
                              <span className="text-[9px] text-muted-foreground font-medium w-12 shrink-0">{isPast(maturity) ? 'Matured' : 'Matures'}</span>
                              <span className="text-[10px] font-semibold text-foreground font-mono tabular-nums">{format(maturity, 'dd MMM yyyy')}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          <TabsContent value="angel-shares" className="mt-0 flex-1 min-h-0">
            <ScrollArea className="h-[calc(90vh-180px)] px-5 pb-8">
              <AngelSharesTab />
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>

      {topUpTarget && (
        <FundAccountDialog
          open={!!topUpTarget}
          onOpenChange={(open) => { if (!open) setTopUpTarget(null); }}
          accountName={topUpTarget.name}
          accountId={topUpTarget.id}
          walletBalance={wallet?.balance || 0}
          currentBalance={topUpTarget.balance}
          onFund={async (portfolioId, amt) => {
            const { data, error } = await supabase.functions.invoke('portfolio-topup', {
              body: { portfolio_id: portfolioId, amount: amt },
            });
            if (error || data?.error) {
              toast.error(data?.error || error?.message || 'Top-up failed');
              throw new Error(data?.error || 'Failed');
            }
            toast.success('Transfer request submitted', { description: `Your transfer to ${topUpTarget.name} is awaiting Partner Ops approval. No funds have left your wallet yet.` });
            refreshWallet();
            fetchAll();
          }}
        />
      )}

      {payoutTarget && (
        <PayoutMethodDialog
          open={!!payoutTarget}
          onOpenChange={(open) => { if (!open) setPayoutTarget(null); }}
          portfolioId={payoutTarget.id}
          portfolioName={payoutTarget.name}
        />
      )}

      {/* Withdraw Capital Dialog */}
      {withdrawDialog && (
        <Dialog open={!!withdrawDialog} onOpenChange={(open) => { if (!open) { setWithdrawDialog(null); setWithdrawAmount(''); } }}>
          <DialogContent className="max-w-sm" stable>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <LogOut className="h-5 w-5 text-amber-600" />
                Withdraw Capital
              </DialogTitle>
              <DialogDescription>
                Withdraw from "{withdrawDialog.name}". Takes 90 days to process.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="rounded-xl bg-muted/50 border p-3 space-y-1">
                <p className="text-xs text-muted-foreground font-semibold">Available Capital</p>
                <p className="text-xl font-black text-foreground">{formatAmount(withdrawDialog.maxAmount)}</p>
                <p className="text-[11px] text-muted-foreground">You can withdraw part or all — the rest stays invested</p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-bold">Amount to Withdraw (UGX)</label>
                <Input
                  type="number"
                  inputMode="numeric"
                  placeholder="Enter amount"
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                  className="text-lg font-bold h-12"
                />
              </div>

              <div className="flex gap-2 flex-wrap">
                {[25, 50, 75, 100].map(pct => {
                  const val = Math.floor(withdrawDialog.maxAmount * (pct / 100));
                  return (
                    <Button
                      key={pct}
                      type="button"
                      variant={Number(withdrawAmount) === val ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setWithdrawAmount(String(val))}
                      className="text-xs rounded-full h-8 px-3"
                    >
                      {pct}%
                    </Button>
                  );
                })}
              </div>

              {Number(withdrawAmount) > 0 && Number(withdrawAmount) <= withdrawDialog.maxAmount && (() => {
                const depositDate = new Date();
                depositDate.setDate(depositDate.getDate() + 90);
                const remaining = withdrawDialog.maxAmount - Number(withdrawAmount);
                return (
                  <div className="rounded-xl bg-primary/5 border border-primary/20 p-3 space-y-2">
                    <p className="text-sm font-bold text-foreground flex items-center gap-1.5">
                      💰 Auto-Deposit Summary
                    </p>
                    <div className="space-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Withdraw Amount</span>
                        <span className="font-bold text-foreground">{formatAmount(Number(withdrawAmount))}</span>
                      </div>
                      {remaining > 0 && (
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Stays Invested</span>
                          <span className="font-bold text-success">{formatAmount(remaining)}</span>
                        </div>
                      )}
                      <div className="border-t border-border/50 pt-1.5 mt-1.5">
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">Deposited to Wallet on</span>
                          <span className="font-bold text-primary">
                            {depositDate.toLocaleDateString('en-UG', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted-foreground">At approximately</span>
                          <span className="font-bold text-primary">
                            {depositDate.toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 space-y-1">
                <p className="text-xs text-amber-700 dark:text-amber-400 font-semibold">
                  ⏳ 90-day notice period — rewards pause immediately on withdrawn amount
                </p>
                <p className="text-[11px] text-amber-600/80 dark:text-amber-500/80">
                  Your money will be <strong>automatically deposited</strong> into your Rent Money wallet after 90 days. No action needed from you.
                </p>
              </div>

              <Button
                onClick={() => handleAccountAction('withdraw_capital', withdrawDialog.id, withdrawDialog.name, {
                  amount: Number(withdrawAmount),
                  reason: `Capital withdrawal from ${withdrawDialog.name}`,
                })}
                disabled={
                  !withdrawAmount ||
                  Number(withdrawAmount) <= 0 ||
                  Number(withdrawAmount) > withdrawDialog.maxAmount ||
                  actionLoading === `withdraw_capital-${withdrawDialog.id}`
                }
                className="w-full gap-2 h-11 font-bold"
              >
                {actionLoading === `withdraw_capital-${withdrawDialog.id}` ? 'Submitting…' : 'Confirm Withdrawal'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </Sheet>
  );
}
