import { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  ArrowLeft, TrendingUp, Calendar, Wallet, CheckCircle2, Target, BarChart3,
  ChevronRight, Users, Building2, Coins, ArrowUpRight, History, Edit2, Check, X, Loader2, Sparkles
} from 'lucide-react';
import { format } from 'date-fns';
import { InvestmentTransactionHistory } from '@/components/investment/InvestmentTransactionHistory';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useCurrency } from '@/hooks/useCurrency';
import { useToast } from '@/hooks/use-toast';
import { hapticTap } from '@/lib/haptics';

type FilterOption = 'all' | 'approved' | 'pending' | 'pending_activation';

interface LinkedFunding {
  id: string; rent_amount: number; status: string; funded_at: string;
  tenant_name: string; landlord_name: string; roi_earned: number; roi_pending: number;
}

interface InterestPayment {
  id: string; interest_amount: number; payment_month: string;
  credited_at: string; interest_rate: number; principal_amount: number;
}

interface InvestmentAccount {
  id: string; name: string; balance: number; color: string; status: string;
  created_at: string; updated_at: string; linked_fundings: LinkedFunding[];
  interest_payments: InterestPayment[]; total_roi_earned: number;
  portfolio_code?: string; duration_months?: number; roi_percentage?: number; roi_mode?: string;
  pendingTopup?: number;
}

export default function InvestmentPortfolio() {
  const navigate = useNavigate();
  const { user, loading: authLoading, role } = useAuth();
  const { formatAmount } = useCurrency();
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<InvestmentAccount[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<InvestmentAccount | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [filterBy, setFilterBy] = useState<FilterOption>('all');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [savingName, setSavingName] = useState(false);
  const { toast } = useToast();

  const handleSaveName = useCallback(async (accountId: string) => {
    if (!editName.trim()) return;
    setSavingName(true);
    const { error } = await supabase
      .from('investor_portfolios')
      .update({ account_name: editName.trim() })
      .eq('id', accountId);
    setSavingName(false);
    if (error) {
      toast({ title: 'Failed to rename', description: error.message, variant: 'destructive' });
    } else {
      setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, name: editName.trim() } : a));
      toast({ title: '✅ Account renamed' });
    }
    setEditingId(null);
  }, [editName, toast]);

  useEffect(() => { if (user) fetchPortfolioData(); }, [user]);

  const fetchPortfolioData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      const [portfoliosRes, pendingOpsRes] = await Promise.all([
        supabase
          .from('investor_portfolios').select('*')
          .or(`investor_id.eq.${user.id},agent_id.eq.${user.id}`)
          .in('status', ['active', 'pending_approval'])
          .order('created_at', { ascending: false }),
        supabase
          .from('pending_wallet_operations')
          .select('source_id, amount')
          .eq('source_table', 'investor_portfolios')
          .eq('operation_type', 'portfolio_topup')
          .in('status', ['approved', 'awaiting_verification']),
      ]);
      if (portfoliosRes.error) { console.error(portfoliosRes.error); setAccounts([]); return; }
      // Build pending top-up map: portfolio_id -> total pending amount
      const pendingMap = new Map<string, number>();
      (pendingOpsRes.data || []).forEach((op: any) => {
        pendingMap.set(op.source_id, (pendingMap.get(op.source_id) || 0) + Number(op.amount));
      });
      const colors = ['#7c3aed', '#2563eb', '#059669', '#d97706', '#dc2626', '#8b5cf6'];
      setAccounts((portfoliosRes.data || []).map((p: any, i: number) => ({
        id: p.id, name: p.account_name || p.portfolio_code || `Portfolio ${i + 1}`,
        balance: p.investment_amount || 0, color: colors[i % colors.length],
        status: p.status === 'active' ? 'approved' : p.status,
        created_at: p.created_at, updated_at: p.created_at,
        linked_fundings: [], interest_payments: [],
        total_roi_earned: p.total_roi_earned || 0,
        portfolio_code: p.portfolio_code, duration_months: p.duration_months,
        roi_percentage: p.roi_percentage, roi_mode: p.roi_mode,
        pendingTopup: pendingMap.get(p.id) || 0,
      })));
    } catch (error) { console.error(error); } finally { setLoading(false); }
  };

  const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);
  const totalRoiEarned = accounts.reduce((s, a) => s + a.total_roi_earned, 0);
  const expectedMonthlyRoi = totalBalance * 0.15;

  const filteredAccounts = useMemo(() => {
    if (filterBy === 'all') return accounts;
    return accounts.filter(a => a.status === filterBy);
  }, [accounts, filterBy]);

  const getStatusColor = (s: string) => {
    if (s === 'approved') return 'bg-success/10 text-success border-success/20';
    if (['pending', 'pending_activation', 'pending_approval'].includes(s)) return 'bg-warning/10 text-warning border-warning/20';
    if (s === 'rejected') return 'bg-destructive/10 text-destructive border-destructive/20';
    return 'bg-muted text-muted-foreground';
  };

  const getStatusLabel = (s: string) => {
    if (s === 'approved') return 'Active';
    if (s === 'pending_approval') return 'Awaiting';
    if (['pending_activation', 'pending'].includes(s)) return 'Pending';
    return s;
  };

  const getStatusEmoji = (s: string) => {
    if (s === 'approved') return '🟢';
    if (['pending', 'pending_activation', 'pending_approval'].includes(s)) return '🟡';
    return '🔴';
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background p-4 space-y-4">
        <Skeleton className="h-10 w-40" />
        <Skeleton className="h-36 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-3">{[1, 2].map(i => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background pb-24">
      {/* Header — sticky, large back button */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur-sm border-b border-border/40">
        <div className="flex items-center gap-3 px-4 py-3 max-w-2xl mx-auto">
          <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0 min-h-[44px] min-w-[44px]" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-base font-bold text-foreground truncate">My Portfolios</h1>
            <p className="text-[10px] text-muted-foreground">Tap any account to see details</p>
          </div>
          <Badge variant="secondary" className="text-xs px-2.5 py-1 shrink-0 font-bold">{accounts.length}</Badge>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5 space-y-5">
        {/* Hero Balance Card — Big & Clear */}
        <div className="rounded-2xl bg-gradient-to-br from-primary to-primary/80 p-6 text-primary-foreground relative overflow-hidden">
          <div className="absolute -top-12 -right-12 w-40 h-40 rounded-full bg-white/[0.06] pointer-events-none" />
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-3">
              <Sparkles className="h-4 w-4 opacity-70" />
              <p className="text-[11px] font-semibold opacity-70 uppercase tracking-[0.15em]">Total Portfolio Value</p>
            </div>
            <p className="text-[clamp(1.75rem,7vw,2.5rem)] font-black tracking-tight leading-none">
              {formatAmount(totalBalance)}
            </p>
            {totalRoiEarned > 0 && (
              <div className="flex items-center gap-1.5 mt-3">
                <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-white/15">
                  <ArrowUpRight className="h-3.5 w-3.5" />
                  <span className="text-[12px] font-bold">+{formatAmount(totalRoiEarned)} earned</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Quick Stats — 2 columns, bigger */}
        <div className="grid grid-cols-2 gap-3">
          <Card className="border border-border/40 shadow-none">
            <CardContent className="p-4 text-center">
              <div className="w-10 h-10 rounded-xl bg-success/10 flex items-center justify-center mx-auto mb-2">
                <TrendingUp className="h-5 w-5 text-success" />
              </div>
              <p className="text-lg font-black text-success leading-tight truncate">
                {formatAmount(expectedMonthlyRoi)}
              </p>
              <p className="text-[11px] text-muted-foreground font-medium mt-1">Monthly Returns</p>
            </CardContent>
          </Card>
          <Card className="border border-border/40 shadow-none">
            <CardContent className="p-4 text-center">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mx-auto mb-2">
                <Target className="h-5 w-5 text-primary" />
              </div>
              <p className="text-lg font-black text-primary leading-tight">15%</p>
              <p className="text-[11px] text-muted-foreground font-medium mt-1">Return Rate</p>
            </CardContent>
          </Card>
        </div>

        {/* Filter Chips — Big, easy to tap */}
        {accounts.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {([
              { value: 'all' as FilterOption, label: 'All', count: accounts.length },
              { value: 'approved' as FilterOption, label: '🟢 Active', count: accounts.filter(a => a.status === 'approved').length },
              { value: 'pending' as FilterOption, label: '🟡 Pending', count: accounts.filter(a => ['pending', 'pending_activation', 'pending_approval'].includes(a.status)).length },
            ]).filter(f => f.count > 0).map(f => (
              <button
                key={f.value}
                onClick={() => { hapticTap(); setFilterBy(f.value); }}
                className={`shrink-0 px-4 py-2.5 rounded-full text-sm font-semibold transition-colors touch-manipulation active:scale-95 min-h-[44px] ${
                  filterBy === f.value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                }`}
              >
                {f.label} ({f.count})
              </button>
            ))}
          </div>
        )}

        {/* Section Title */}
        <div className="flex items-center gap-2 px-1">
          <div className="w-1 h-5 rounded-full bg-primary" />
          <h2 className="text-sm font-black text-foreground tracking-tight">Your Accounts</h2>
        </div>

        {/* Accounts List — Large, clear cards */}
        {accounts.length === 0 ? (
          <Card className="border-2 border-dashed border-border/60">
            <CardContent className="p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                <Wallet className="h-8 w-8 text-primary/50" />
              </div>
              <p className="font-bold text-base mb-1.5">No Portfolios Yet</p>
              <p className="text-sm text-muted-foreground mb-5 max-w-[240px] mx-auto">
                Start supporting tenants to build your investment portfolio
              </p>
              <Button size="lg" className="min-h-[48px] text-sm font-bold rounded-xl px-6" onClick={() => navigate(roleToSlug(role))}>
                <Target className="h-4 w-4 mr-2" />
                Browse Opportunities
              </Button>
            </CardContent>
          </Card>
        ) : filteredAccounts.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="p-6 text-center">
              <p className="text-sm font-medium mb-3">No accounts match this filter</p>
              <Button variant="outline" size="sm" className="min-h-[44px]" onClick={() => setFilterBy('all')}>Show All</Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {filteredAccounts.map((account) => (
              <Card
                key={account.id}
                className="border border-border/50 shadow-sm hover:border-primary/30 transition-all cursor-pointer active:scale-[0.98] touch-manipulation"
                onClick={() => { hapticTap(); setSelectedAccount(account); setDetailsOpen(true); }}
              >
                <CardContent className="p-4">
                  {/* Top row: icon, name, status */}
                  <div className="flex items-start gap-3.5 mb-3">
                    <div
                      className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                      style={{ backgroundColor: `${account.color}15` }}
                    >
                      <Wallet className="h-5 w-5" style={{ color: account.color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      {editingId === account.id ? (
                        <div className="flex items-center gap-1.5" onClick={e => e.stopPropagation()}>
                          <Input
                            value={editName}
                            onChange={e => setEditName(e.target.value)}
                            className="h-8 text-sm font-bold flex-1 min-w-0"
                            autoFocus
                            onKeyDown={e => {
                              if (e.key === 'Enter') handleSaveName(account.id);
                              if (e.key === 'Escape') setEditingId(null);
                            }}
                          />
                          <Button size="icon" variant="ghost" className="h-8 w-8 text-success shrink-0" onClick={() => handleSaveName(account.id)} disabled={savingName}>
                            {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                          </Button>
                          <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" onClick={() => setEditingId(null)}>
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            <p className="text-sm font-bold text-foreground truncate">{account.name}</p>
                            <span className="text-xs">{getStatusEmoji(account.status)}</span>
                            {(account.pendingTopup ?? 0) > 0 && (
                              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-warning/15 border border-warning/20 text-[10px] font-bold text-warning shrink-0">
                                ⏳ {formatAmount(account.pendingTopup!)} being added
                              </span>
                            )}
                          </div>
                          {account.portfolio_code && (
                            <p className="text-[10px] text-muted-foreground font-mono">{account.portfolio_code}</p>
                          )}
                        </>
                      )}
                    </div>
                    <ChevronRight className="h-5 w-5 text-muted-foreground/40 shrink-0 mt-1" />
                  </div>

                  {/* Human-readable pending top-up note */}
                  {(account.pendingTopup ?? 0) > 0 && (
                    <div className="flex items-start gap-2 mb-3 rounded-xl bg-warning/10 border border-warning/20 p-2.5">
                      <span className="text-sm leading-none mt-0.5">⏳</span>
                      <p className="text-[11px] leading-snug text-foreground/80">
                        <span className="font-bold text-warning">{formatAmount(account.pendingTopup!)}</span> top-up is on the way. It will be added to this portfolio&apos;s balance right after your next returns payout, so it starts earning too.
                      </p>
                    </div>
                  )}

                  {/* Balance — Big & Bold */}
                  <div className="bg-muted/30 rounded-xl p-3 mb-3">
                    <div className="flex items-end justify-between">
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-0.5">Balance</p>
                        <p className="text-xl font-black text-foreground leading-tight truncate">
                          {formatAmount(account.balance)}
                        </p>
                      </div>
                      {account.total_roi_earned > 0 && (
                        <div className="flex items-center gap-1 px-2 py-1 rounded-lg bg-success/10">
                          <ArrowUpRight className="h-3 w-3 text-success" />
                          <span className="text-[11px] font-bold text-success">+{formatAmount(account.total_roi_earned)}</span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Bottom info row */}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <div className="flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(account.created_at), 'MMM yyyy')}
                      </span>
                      {account.roi_percentage && (
                        <span className="flex items-center gap-1 text-primary font-semibold">
                          <TrendingUp className="h-3 w-3" />
                          {account.roi_percentage}%/mo
                        </span>
                      )}
                    </div>
                    <button
                      className="flex items-center gap-1 text-muted-foreground hover:text-primary transition-colors min-h-[36px] px-2"
                      onClick={e => { e.stopPropagation(); hapticTap(); setEditingId(account.id); setEditName(account.name); }}
                    >
                      <Edit2 className="h-3 w-3" />
                      <span className="text-[11px]">Rename</span>
                    </button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Summary Card */}
        {accounts.length > 0 && (
          <Card className="border border-border/40 shadow-none">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Summary</p>
              </div>
              {[
                { l: 'Total Invested', v: formatAmount(totalBalance), c: 'text-foreground' },
                { l: 'Total Rewards', v: `+${formatAmount(totalRoiEarned)}`, c: 'text-success' },
                { l: 'Monthly Return', v: formatAmount(expectedMonthlyRoi), c: 'text-primary' },
              ].map(r => (
                <div key={r.l} className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{r.l}</span>
                  <span className={`text-sm font-bold ${r.c}`}>{r.v}</span>
                </div>
              ))}
              <Progress value={totalBalance > 0 ? Math.min((totalRoiEarned / totalBalance) * 100, 100) : 0} className="h-2 mt-1" />
            </CardContent>
          </Card>
        )}
      </main>

      {/* Details Dialog — Full-featured */}
      <Dialog open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-hidden flex flex-col p-0">
          <DialogHeader className="px-5 pt-5 pb-3 border-b border-border/40">
            <DialogTitle className="flex items-center gap-2.5 text-sm">
              {selectedAccount && (
                <>
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: `${selectedAccount.color}15` }}>
                    <Wallet className="h-4.5 w-4.5" style={{ color: selectedAccount.color }} />
                  </div>
                  <div className="min-w-0">
                    <span className="block truncate font-bold">{selectedAccount.name}</span>
                    {selectedAccount.portfolio_code && (
                      <span className="block text-[10px] font-mono text-muted-foreground">{selectedAccount.portfolio_code}</span>
                    )}
                  </div>
                </>
              )}
            </DialogTitle>
          </DialogHeader>
          {selectedAccount && (
            <ScrollArea className="flex-1 px-5 py-4">
              <div className="space-y-4">
                {/* Balance + Rewards — Side by side */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl bg-primary/5 p-4">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Balance</p>
                    <p className="text-lg font-black text-primary leading-tight truncate">{formatAmount(selectedAccount.balance)}</p>
                  </div>
                  <div className="rounded-xl bg-success/5 p-4">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wider mb-1">Rewards</p>
                    <p className="text-lg font-black text-success leading-tight truncate">+{formatAmount(selectedAccount.total_roi_earned)}</p>
                  </div>
                </div>

                {/* Tabs — bigger touch targets */}
                <Tabs defaultValue="history" className="w-full">
                  <TabsList className="w-full grid grid-cols-3 h-11">
                    <TabsTrigger value="history" className="text-xs gap-1.5 min-h-[40px]"><History className="h-3.5 w-3.5" />History</TabsTrigger>
                    <TabsTrigger value="fundings" className="text-xs gap-1.5 min-h-[40px]"><Users className="h-3.5 w-3.5" />Fundings</TabsTrigger>
                    <TabsTrigger value="roi" className="text-xs gap-1.5 min-h-[40px]"><TrendingUp className="h-3.5 w-3.5" />Rewards</TabsTrigger>
                  </TabsList>
                  <TabsContent value="history" className="mt-3">
                    <InvestmentTransactionHistory accountId={selectedAccount.id} maxItems={20} showHeader={false} />
                  </TabsContent>
                  <TabsContent value="fundings" className="mt-3 space-y-2">
                    {selectedAccount.linked_fundings.length === 0 ? (
                      <div className="text-center py-10">
                        <Users className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                        <p className="text-sm text-muted-foreground">No linked fundings yet</p>
                      </div>
                    ) : selectedAccount.linked_fundings.map(f => (
                      <div key={f.id} className="rounded-xl bg-muted/30 p-3.5">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <Badge variant="outline" className={`text-[10px] mb-1.5 ${f.status === 'verified' ? 'bg-success/10 text-success border-success/20' : 'bg-warning/10 text-warning border-warning/20'}`}>
                              {f.status === 'verified' ? 'Verified' : 'Pending'}
                            </Badge>
                            <p className="text-sm font-semibold truncate">{f.tenant_name}</p>
                            <p className="text-xs text-muted-foreground flex items-center gap-1"><Building2 className="h-3 w-3" />{f.landlord_name}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-sm font-bold">{formatAmount(f.rent_amount)}</p>
                            {f.roi_earned > 0 && <p className="text-[11px] text-success font-semibold">+{formatAmount(f.roi_earned)}</p>}
                          </div>
                        </div>
                      </div>
                    ))}
                  </TabsContent>
                  <TabsContent value="roi" className="mt-3 space-y-2">
                    {selectedAccount.interest_payments.length === 0 ? (
                      <div className="text-center py-10">
                        <Coins className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
                        <p className="text-sm text-muted-foreground">No reward payments yet</p>
                      </div>
                    ) : selectedAccount.interest_payments.map(p => (
                      <div key={p.id} className="rounded-xl bg-success/5 p-3.5">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-semibold">{p.payment_month}</p>
                            <p className="text-[11px] text-muted-foreground">{format(new Date(p.credited_at), 'MMM d, yyyy')}</p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-bold text-success">+{formatAmount(p.interest_amount)}</p>
                            <Badge variant="outline" className="text-[9px] bg-success/10 text-success border-success/20">
                              <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Credited
                            </Badge>
                          </div>
                        </div>
                      </div>
                    ))}
                  </TabsContent>
                </Tabs>

                {/* Account Info */}
                <div className="pt-3 border-t border-border/40 space-y-2.5">
                  {[
                    { l: 'Created', v: format(new Date(selectedAccount.created_at), 'MMM d, yyyy') },
                    { l: 'Status', v: `${getStatusEmoji(selectedAccount.status)} ${getStatusLabel(selectedAccount.status)}` },
                    { l: 'Monthly Rate', v: `${selectedAccount.roi_percentage || 15}%` },
                    ...(selectedAccount.duration_months ? [{ l: 'Duration', v: `${selectedAccount.duration_months} months` }] : []),
                  ].map(r => (
                    <div key={r.l} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{r.l}</span>
                      <span className="font-semibold">{r.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
