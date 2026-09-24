import { useState, useEffect, useMemo } from 'react';
import { useShortLink } from '@/hooks/useShortLink';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { formatUGX } from '@/lib/rentCalculations';
import { fetchAgentLedgerEarnings } from '@/lib/agentLedgerEarnings';
import { cn } from '@/lib/utils';
import {
  Users, TrendingUp, Wallet, Banknote, Copy, Check, Share2,
  Activity, Clock, ArrowUpRight, Loader2, RefreshCw, Link2,
  UserCheck, PiggyBank, Coins, ChevronRight,
} from 'lucide-react';
import { format } from 'date-fns';

interface Partner {
  id: string;
  name: string;
  phone: string;
  status: string;
  investedAmount: number;
  roiPercentage: number;
  dateJoined: string;
}

interface ActivityItem {
  id: string;
  type: string;
  description: string;
  amount: number;
  timestamp: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentPartnerDashboardSheet({ open, onOpenChange }: Props) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'partners' | 'activity'>('overview');

  // Data
  const [partners, setPartners] = useState<Partner[]>([]);
  const [totalCommission, setTotalCommission] = useState(0);
  const [commissionHistory, setCommissionHistory] = useState<ActivityItem[]>([]);
  const [activityFeed, setActivityFeed] = useState<ActivityItem[]>([]);
  const [walletBalance, setWalletBalance] = useState(0);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);
    try {
      // 1. Fetch portfolios where this agent is the agent_id
      const { data: portfolios } = await supabase
        .from('investor_portfolios')
        .select('id, investor_id, investment_amount, roi_percentage, status, created_at')
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200);

      // 2. Get partner profiles
      const investorIds = [...new Set((portfolios || []).map(p => p.investor_id).filter(Boolean))];
      let profileMap = new Map<string, { full_name: string; phone: string }>();
      if (investorIds.length > 0) {
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', investorIds.slice(0, 50));
        (profiles || []).forEach(p => profileMap.set(p.id, { full_name: p.full_name || '', phone: p.phone || '' }));
      }

      // Build partner list grouped by investor
      const partnerMap = new Map<string, Partner>();
      (portfolios || []).forEach(p => {
        if (!p.investor_id) return;
        const existing = partnerMap.get(p.investor_id);
        const prof = profileMap.get(p.investor_id);
        if (existing) {
          existing.investedAmount += p.investment_amount || 0;
          if (p.status === 'active') existing.status = 'Active';
        } else {
          partnerMap.set(p.investor_id, {
            id: p.investor_id,
            name: prof?.full_name || p.investor_id.slice(0, 8),
            phone: prof?.phone || '',
            status: p.status === 'active' ? 'Active' : 'Pending',
            investedAmount: p.investment_amount || 0,
            roiPercentage: p.roi_percentage || 15,
            dateJoined: p.created_at,
          });
        }
      });
      setPartners(Array.from(partnerMap.values()));

      // 3. Fetch agent earnings (commissions) from the ledger — agent_earnings
      // has not been written since July, so it showed every agent zero.
      const earnings = await fetchAgentLedgerEarnings(user.id);

      const commEarnings = earnings.filter(e => e.earning_type === 'commission' || e.earning_type === 'investment_commission');
      setTotalCommission(commEarnings.reduce((s, e) => s + Number(e.amount), 0));
      setCommissionHistory(commEarnings.slice(0, 50).map(e => ({
        id: e.id,
        type: 'commission',
        description: e.description || 'Commission earned',
        amount: Number(e.amount),
        timestamp: e.created_at,
      })));

      // 4. Build activity feed from earnings + portfolios
      const feed: ActivityItem[] = [];
      earnings.slice(0, 20).forEach(e => {
        feed.push({
          id: e.id,
          type: e.earning_type,
          description: e.description || getEarningLabel(e.earning_type),
          amount: Number(e.amount),
          timestamp: e.created_at,
        });
      });
      (portfolios || []).slice(0, 10).forEach(p => {
        const prof = p.investor_id ? profileMap.get(p.investor_id) : null;
        feed.push({
          id: `portfolio-${p.id}`,
          type: p.status === 'active' ? 'investment_activated' : 'partner_signup',
          description: p.status === 'active'
            ? `${formatUGX(p.investment_amount)} activated for ${prof?.full_name || 'Partner'}`
            : `${prof?.full_name || 'Partner'} onboarded`,
          amount: p.investment_amount || 0,
          timestamp: p.created_at,
        });
      });
      feed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setActivityFeed(feed.slice(0, 30));

      // 5. Wallet balance
      const { data: wallet } = await supabase
        .from('wallets')
        .select('balance')
        .eq('user_id', user.id)
        .single();
      setWalletBalance(wallet?.balance || 0);

    } catch (err) {
      console.error('Failed to fetch partner dashboard data', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && user) fetchData();
  }, [open, user?.id]);

  const getEarningLabel = (type: string) => {
    const labels: Record<string, string> = {
      commission: 'Rent commission earned',
      investment_commission: 'Funding commission (2%)',
      approval_bonus: 'Registration bonus',
      verification_bonus: 'Verification bonus',
      rent_funded_bonus: 'Rent funded bonus',
      listing_bonus: 'Listing bonus',
    };
    return labels[type] || type;
  };

  const getActivityIcon = (type: string) => {
    switch (type) {
      case 'commission': case 'investment_commission': return <Coins className="h-3.5 w-3.5 text-success" />;
      case 'investment_activated': return <ArrowUpRight className="h-3.5 w-3.5 text-primary" />;
      case 'partner_signup': return <UserCheck className="h-3.5 w-3.5 text-blue-500" />;
      default: return <Activity className="h-3.5 w-3.5 text-muted-foreground" />;
    }
  };

  // Summary stats
  const totalPartners = partners.length;
  const activePartners = partners.filter(p => p.status === 'Active').length;
  const totalDeposits = partners.reduce((s, p) => s + p.investedAmount, 0);

  const { shortUrl: referralLink } = useShortLink({
    targetPath: '/auth',
    targetParams: { ref: user?.id || '' },
    enabled: open && !!user,
  });

  const whatsAppMessage = `Hi, I'm onboarding partners into a passive income opportunity with Welile Technologies.

Earn monthly returns based on your funding.

Sign up here: ${referralLink}

I'll personally guide you.`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleWhatsApp = () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(whatsAppMessage)}`, '_blank');
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="h-[92vh] p-0 rounded-t-2xl">
        <SheetHeader className="px-4 pt-4 pb-2">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-lg font-bold flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Partner Dashboard
            </SheetTitle>
            <Button variant="ghost" size="icon-sm" onClick={fetchData} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </div>
        </SheetHeader>

        {/* Tabs */}
        <div className="flex gap-1 px-4 pb-3">
          {(['overview', 'partners', 'activity'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "flex-1 py-2 text-xs font-semibold rounded-lg transition-colors",
                activeTab === tab
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              {tab === 'overview' ? 'Overview' : tab === 'partners' ? 'Partners' : 'Activity'}
            </button>
          ))}
        </div>

        <ScrollArea className="flex-1 h-[calc(92vh-120px)]">
          <div className="px-4 pb-8 space-y-4">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : activeTab === 'overview' ? (
              <>
                {/* Summary Cards */}
                <div className="grid grid-cols-2 gap-2.5">
                  {[
                    { label: 'Partners', value: totalPartners, icon: Users, color: 'text-primary', bg: 'bg-primary/10' },
                    { label: 'Active', value: activePartners, icon: UserCheck, color: 'text-success', bg: 'bg-success/10' },
                    { label: 'Total Funded', value: formatUGX(totalDeposits), icon: PiggyBank, color: 'text-primary', bg: 'bg-primary/10' },
                    { label: 'Commission', value: formatUGX(totalCommission), icon: Coins, color: 'text-success', bg: 'bg-success/10' },
                  ].map((card) => (
                    <Card key={card.label} className="border-border/50">
                      <CardContent className="p-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <div className={cn("p-1.5 rounded-lg", card.bg)}>
                            <card.icon className={cn("h-3.5 w-3.5", card.color)} />
                          </div>
                          <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{card.label}</span>
                        </div>
                        <p className="text-lg font-bold text-foreground">{card.value}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>

                {/* Earnings Panel */}
                <Card className="border-primary/20 bg-primary/5">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Wallet className="h-4 w-4 text-primary" />
                      <span className="text-sm font-bold">Earnings</span>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase">Total Commission</p>
                        <p className="text-base font-bold text-foreground">{formatUGX(totalCommission)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-muted-foreground uppercase">Available</p>
                        <p className="text-base font-bold text-success">{formatUGX(walletBalance)}</p>
                      </div>
                    </div>
                    {commissionHistory.length > 0 && (
                      <>
                        <Separator />
                        <div className="space-y-1.5">
                          <p className="text-[10px] text-muted-foreground font-semibold uppercase">Recent Commissions</p>
                          {commissionHistory.slice(0, 5).map(c => (
                            <div key={c.id} className="flex items-center justify-between text-xs">
                              <span className="text-muted-foreground truncate flex-1">{c.description}</span>
                              <span className="font-semibold text-success ml-2">+{formatUGX(c.amount)}</span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>

                {/* Referral Link Section */}
                <Card className="border-primary/20">
                  <CardContent className="p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Link2 className="h-4 w-4 text-primary" />
                      <span className="text-sm font-bold">Your Referral Link</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {profile?.full_name || 'Agent'} · Share to onboard partners
                    </p>
                    <div className="flex gap-2">
                      <Input
                        value={referralLink}
                        readOnly
                        className="h-9 text-[10px] font-mono bg-muted/50"
                      />
                      <Button
                        variant={copied ? "default" : "outline"}
                        size="icon-sm"
                        onClick={handleCopy}
                        className={cn("shrink-0", copied && "bg-success hover:bg-success/90")}
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-white" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Button
                        onClick={handleWhatsApp}
                        className="h-10 gap-2 bg-green-600 hover:bg-green-700 text-white text-xs font-semibold"
                      >
                        <Share2 className="h-3.5 w-3.5" />
                        WhatsApp
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          if (navigator.share) {
                            navigator.share({ title: 'Join Welile', text: whatsAppMessage, url: referralLink });
                          } else {
                            handleCopy();
                          }
                        }}
                        className="h-10 gap-2 text-xs"
                      >
                        <Share2 className="h-3.5 w-3.5" />
                        Share
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                {/* Recent Activity Preview */}
                {activityFeed.length > 0 && (
                  <Card>
                    <CardContent className="p-4 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Activity className="h-4 w-4 text-primary" />
                          <span className="text-sm font-bold">Recent Activity</span>
                        </div>
                        <button onClick={() => setActiveTab('activity')} className="text-[10px] text-primary font-semibold flex items-center gap-0.5">
                          View all <ChevronRight className="h-3 w-3" />
                        </button>
                      </div>
                      {activityFeed.slice(0, 4).map(item => (
                        <div key={item.id} className="flex items-start gap-2.5 py-1.5">
                          <div className="mt-0.5">{getActivityIcon(item.type)}</div>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs text-foreground truncate">{item.description}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {format(new Date(item.timestamp), 'MMM d, h:mm a')}
                            </p>
                          </div>
                          {item.amount > 0 && (
                            <span className="text-xs font-semibold text-success shrink-0">
                              {formatUGX(item.amount)}
                            </span>
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </>
            ) : activeTab === 'partners' ? (
              <>
                <p className="text-xs text-muted-foreground">{partners.length} partner{partners.length !== 1 ? 's' : ''} onboarded</p>
                {partners.length === 0 ? (
                  <div className="text-center py-12">
                    <Users className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">No partners yet</p>
                    <p className="text-xs text-muted-foreground mt-1">Share your referral link to start onboarding</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {partners.map(p => (
                      <Card key={p.id} className="border-border/50">
                        <CardContent className="p-3">
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2 min-w-0">
                              <div className={cn(
                                "h-7 w-7 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0",
                                p.status === 'Active' ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
                              )}>
                                {p.name.charAt(0)}
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs font-semibold truncate">{p.name}</p>
                                <p className="text-[10px] text-muted-foreground">{p.phone}</p>
                              </div>
                            </div>
                            <span className={cn(
                              "text-[10px] font-semibold px-2 py-0.5 rounded-full",
                              p.status === 'Active' ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
                            )}>
                              {p.status}
                            </span>
                          </div>
                          <div className="grid grid-cols-3 gap-2 mt-2 pt-2 border-t border-border/30">
                            <div>
                              <p className="text-[10px] text-muted-foreground">Funded</p>
                              <p className="text-xs font-bold">{formatUGX(p.investedAmount)}</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Monthly ROI</p>
                              <p className="text-xs font-bold text-success">{p.roiPercentage}%</p>
                            </div>
                            <div>
                              <p className="text-[10px] text-muted-foreground">Joined</p>
                              <p className="text-xs font-bold">{format(new Date(p.dateJoined), 'MMM d')}</p>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                )}
              </>
            ) : (
              /* Activity Feed */
              <>
                <p className="text-xs text-muted-foreground">{activityFeed.length} recent events</p>
                {activityFeed.length === 0 ? (
                  <div className="text-center py-12">
                    <Activity className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
                    <p className="text-sm text-muted-foreground">No activity yet</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {activityFeed.map(item => (
                      <div key={item.id} className="flex items-start gap-3 py-2.5 border-b border-border/30 last:border-0">
                        <div className="mt-0.5 p-1.5 rounded-lg bg-muted">
                          {getActivityIcon(item.type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs text-foreground">{item.description}</p>
                          <p className="text-[10px] text-muted-foreground flex items-center gap-1 mt-0.5">
                            <Clock className="h-2.5 w-2.5" />
                            {format(new Date(item.timestamp), 'MMM d, yyyy · h:mm a')}
                          </p>
                        </div>
                        {item.amount > 0 && (
                          <span className={cn(
                            "text-xs font-bold shrink-0",
                            item.type.includes('commission') ? "text-success" : "text-foreground"
                          )}>
                            {formatUGX(item.amount)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
