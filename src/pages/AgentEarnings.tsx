import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft, TrendingUp, Gift, Percent, Calendar, RefreshCw,
  ArrowDownLeft, Banknote, Users, Home, CheckCircle, UserPlus,
  PiggyBank, Award, ChevronDown, ChevronUp, Info,
} from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { useAgentEarnings, EarningBreakdown, DetailedEarning } from '@/hooks/useAgentEarnings';
import { formatUGX } from '@/lib/rentCalculations';
import {
  format, startOfDay, endOfDay, startOfWeek, endOfWeek,
  startOfMonth, endOfMonth, isWithinInterval,
} from 'date-fns';
import { DateRange } from 'react-day-picker';
import { Calendar as CalendarComp } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { MobileMoneySettings } from '@/components/agent/MobileMoneySettings';
import { RequestCommissionPayoutDialog } from '@/components/agent/RequestCommissionPayoutDialog';
import { MyCommissionPayouts } from '@/components/agent/MyCommissionPayouts';
import { UserWithdrawalRequests } from '@/components/wallet/UserWithdrawalRequests';
import { hapticTap } from '@/lib/haptics';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

const BREAKDOWN_ITEMS: {
  key: keyof EarningBreakdown;
  label: string;
  description: string;
  icon: typeof Percent;
  colorClass: string;
  bgClass: string;
}[] = [
  { key: 'rentCommission', label: 'Rent Repayment Commission', description: 'UGX 10,000 flat per repayment', icon: Banknote, colorClass: 'text-emerald-600', bgClass: 'bg-emerald-500/10 border-emerald-500/20' },
  { key: 'investmentCommission', label: 'Investment Commission', description: '2% on investment activation', icon: PiggyBank, colorClass: 'text-blue-600', bgClass: 'bg-blue-500/10 border-blue-500/20' },
  { key: 'subagentCommission', label: 'Sub-Agent Override', description: 'UGX 2,000 from sub-agent collections', icon: Users, colorClass: 'text-violet-600', bgClass: 'bg-violet-500/10 border-violet-500/20' },
  { key: 'registrationBonus', label: 'Registration Bonus', description: 'UGX 10,000 per tenant registered', icon: UserPlus, colorClass: 'text-amber-600', bgClass: 'bg-amber-500/10 border-amber-500/20' },
  { key: 'facilitationBonus', label: 'Facilitation Bonus', description: 'UGX 5,000 upon rent funding', icon: Award, colorClass: 'text-orange-600', bgClass: 'bg-orange-500/10 border-orange-500/20' },
  { key: 'verificationBonus', label: 'Verification Bonus', description: 'UGX 2,000 per verified house listing', icon: CheckCircle, colorClass: 'text-teal-600', bgClass: 'bg-teal-500/10 border-teal-500/20' },
  { key: 'listingBonus', label: 'Listing Bonus', description: 'UGX 2,000 once your listing is verified', icon: Home, colorClass: 'text-cyan-600', bgClass: 'bg-cyan-500/10 border-cyan-500/20' },
  { key: 'approvalBonus', label: 'Approval Bonus', description: 'Bonus on rent request approval', icon: Gift, colorClass: 'text-pink-600', bgClass: 'bg-pink-500/10 border-pink-500/20' },
  { key: 'referralBonus', label: 'Referral Bonus', description: 'UGX 500 per sub-agent recruited', icon: UserPlus, colorClass: 'text-indigo-600', bgClass: 'bg-indigo-500/10 border-indigo-500/20' },
  { key: 'other', label: 'Other Earnings', description: 'Miscellaneous earnings', icon: ArrowDownLeft, colorClass: 'text-muted-foreground', bgClass: 'bg-muted/50 border-border/50' },
];

export default function AgentEarnings() {
  const navigate = useNavigate();
  const { user, role, loading: authLoading } = useAuth();
  const { earnings, detailedEarnings, loading, totalEarnings, commissionTotal, bonusTotal, breakdown, availableToWithdraw, totalPaidOut, refreshEarnings, ROLE_LABELS } = useAgentEarnings();
  const [payoutDialogOpen, setPayoutDialogOpen] = useState(false);
  const [breakdownExpanded, setBreakdownExpanded] = useState(false);
  const [expandedEarningId, setExpandedEarningId] = useState<string | null>(null);
  type RangePreset = 'all' | 'today' | 'week' | 'month' | 'custom';
  const [rangePreset, setRangePreset] = useState<RangePreset>('all');
  const [customRange, setCustomRange] = useState<DateRange | undefined>();

  const activeInterval = (() => {
    const now = new Date();
    switch (rangePreset) {
      case 'today': return { start: startOfDay(now), end: endOfDay(now) };
      case 'week': return { start: startOfWeek(now, { weekStartsOn: 1 }), end: endOfWeek(now, { weekStartsOn: 1 }) };
      case 'month': return { start: startOfMonth(now), end: endOfMonth(now) };
      case 'custom':
        if (customRange?.from) {
          return { start: startOfDay(customRange.from), end: endOfDay(customRange.to ?? customRange.from) };
        }
        return null;
      default: return null;
    }
  })();

  const filterByRange = (list: DetailedEarning[]) => {
    if (!activeInterval) return list;
    return list.filter(e => isWithinInterval(new Date(e.created_at), activeInterval));
  };

  useEffect(() => {
    if (!authLoading && !user) {
      navigate('/auth');
    } else if (!authLoading && role !== 'agent') {
      navigate(roleToSlug(role));
    }
  }, [user, role, authLoading, navigate]);

  const filteredEarnings = filterByRange(detailedEarnings);
  const detailedCommissions = filteredEarnings.filter(e => ['commission', 'rent_commission', 'investment_commission', 'subagent_commission', 'subagent_override'].includes(e.earning_type));
  const detailedBonuses = filteredEarnings.filter(e => ['approval_bonus', 'verification_bonus', 'rent_funded_bonus', 'facilitation_bonus', 'listing_bonus', 'registration', 'registration_bonus', 'referral_bonus', 'referral'].includes(e.earning_type));
  const filteredCommissionTotal = detailedCommissions.reduce((s, e) => s + Number(e.amount), 0);
  const filteredBonusTotal = detailedBonuses.reduce((s, e) => s + Number(e.amount), 0);
  const filteredTotal = filteredEarnings.reduce((s, e) => s + Number(e.amount), 0);

  const groupByDate = (earningsList: DetailedEarning[]) => {
    const grouped: Record<string, DetailedEarning[]> = {};
    earningsList.forEach(earning => {
      const date = format(new Date(earning.created_at), 'yyyy-MM-dd');
      if (!grouped[date]) grouped[date] = [];
      grouped[date].push(earning);
    });
    return grouped;
  };

  const getEarningIcon = (type: string) => {
    switch (type) {
      case 'commission': case 'rent_commission': return <Banknote className="h-4 w-4 text-emerald-600" />;
      case 'investment_commission': return <PiggyBank className="h-4 w-4 text-blue-600" />;
      case 'subagent_commission': case 'subagent_override': return <Users className="h-4 w-4 text-violet-600" />;
      case 'registration': case 'registration_bonus': return <UserPlus className="h-4 w-4 text-amber-600" />;
      case 'verification_bonus': return <CheckCircle className="h-4 w-4 text-teal-600" />;
      case 'rent_funded_bonus': case 'facilitation_bonus': return <Award className="h-4 w-4 text-orange-600" />;
      case 'listing_bonus': return <Home className="h-4 w-4 text-cyan-600" />;
      case 'approval_bonus': return <Gift className="h-4 w-4 text-pink-600" />;
      case 'referral_bonus': case 'referral': return <UserPlus className="h-4 w-4 text-indigo-600" />;
      default: return <ArrowDownLeft className="h-4 w-4 text-primary" />;
    }
  };

  const getEarningLabel = (type: string) => {
    switch (type) {
      case 'commission': case 'rent_commission': return 'Rent Commission';
      case 'investment_commission': return 'Investment Commission';
      case 'subagent_commission': case 'subagent_override': return 'Sub-Agent Override';
      case 'registration': case 'registration_bonus': return 'Registration Bonus';
      case 'verification_bonus': return 'Verification Bonus';
      case 'rent_funded_bonus': case 'facilitation_bonus': return 'Facilitation Bonus';
      case 'listing_bonus': return 'Listing Bonus';
      case 'approval_bonus': return 'Approval Bonus';
      case 'referral_bonus': case 'referral': return 'Referral Bonus';
      default: return type.replace(/_/g, ' ');
    }
  };

  const getRoleLabel = (role: string | null, pct: number | null): string => {
    if (!role) return '';
    const label = ROLE_LABELS[role] || role.replace(/_/g, ' ');
    return pct != null ? `${label} (${pct}%)` : label;
  };

  const renderEarningsList = (earningsList: DetailedEarning[]) => {
    if (earningsList.length === 0) {
      return (
        <div className="text-center py-12 text-muted-foreground">
          <TrendingUp className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>No earnings yet</p>
          <p className="text-sm mt-1">Register tenants and help them repay to earn commissions!</p>
        </div>
      );
    }

    const grouped = groupByDate(earningsList);
    const dates = Object.keys(grouped).sort((a, b) => b.localeCompare(a));

    return (
      <div className="space-y-6">
        {dates.map(date => (
          <div key={date}>
            <div className="flex items-center gap-2 mb-3">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-medium text-muted-foreground">
                {format(new Date(date), 'EEEE, MMMM d, yyyy')}
              </h3>
              <Badge variant="outline" className="ml-auto">
                {formatUGX(grouped[date].reduce((sum, e) => sum + Number(e.amount), 0))}
              </Badge>
            </div>
            <div className="space-y-2">
              {grouped[date].map(earning => {
                const isExpanded = expandedEarningId === earning.id;
                const ledger = earning.ledger;
                const hasDetail = !!(ledger || earning.sourceName);

                return (
                  <Collapsible
                    key={earning.id}
                    open={isExpanded}
                    onOpenChange={() => {
                      hapticTap();
                      setExpandedEarningId(isExpanded ? null : earning.id);
                    }}
                  >
                    <CollapsibleTrigger asChild>
                      <div className={`flex items-center gap-4 p-4 rounded-lg bg-secondary/50 cursor-pointer transition-colors hover:bg-secondary/80 ${isExpanded ? 'rounded-b-none' : ''}`}>
                        <div className="p-2 rounded-lg bg-muted/50">
                          {getEarningIcon(earning.earning_type)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium capitalize">{getEarningLabel(earning.earning_type)}</p>
                          <p className="text-sm text-muted-foreground truncate">
                            {ledger?.tenant_name || earning.sourceName
                              ? (ledger?.tenant_name || earning.sourceName)
                              : (earning.description || 'Earning recorded')}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(earning.created_at), 'h:mm a')}
                          </p>
                        </div>
                        <div className="text-right flex items-center gap-2">
                          <p className="font-mono font-semibold text-success">
                            +{formatUGX(Number(earning.amount))}
                          </p>
                          {hasDetail && (
                            <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                        </div>
                      </div>
                    </CollapsibleTrigger>
                    {hasDetail && (
                      <CollapsibleContent>
                        <div className="px-4 pb-4 pt-2 bg-secondary/30 rounded-b-lg border-t border-border/40 space-y-1.5">
                          {ledger?.commission_role && (
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-[10px] font-medium">
                                {getRoleLabel(ledger.commission_role, ledger.percentage)}
                              </Badge>
                            </div>
                          )}
                          {ledger?.tenant_name && (
                            <p className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">Tenant:</span> {ledger.tenant_name}
                            </p>
                          )}
                          {earning.sourceName && !ledger?.tenant_name && (
                            <p className="text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">From:</span> {earning.sourceName}
                            </p>
                          )}
                          {ledger?.percentage != null && ledger?.repayment_amount != null && ledger.repayment_amount > 0 && (
                            <p className="text-xs font-mono text-primary">
                              {ledger.percentage}% of {formatUGX(ledger.repayment_amount)} = {formatUGX(earning.amount)}
                            </p>
                          )}
                          {earning.description && (
                            <p className="text-[11px] text-muted-foreground">{earning.description}</p>
                          )}
                        </div>
                      </CollapsibleContent>
                    )}
                  </Collapsible>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Filter breakdown items that have earnings > 0, plus show top items always
  const activeBreakdownItems = BREAKDOWN_ITEMS.filter(item => breakdown[item.key] > 0);
  const visibleBreakdownItems = breakdownExpanded ? activeBreakdownItems : activeBreakdownItems.slice(0, 4);

  if (authLoading || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto px-4 py-6 max-w-2xl">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Button variant="ghost" size="icon" onClick={() => navigate(roleToSlug(role))}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-2xl font-bold">My Earnings</h1>
            <p className="text-muted-foreground text-sm">Track your commissions and bonuses</p>
          </div>
          <Button variant="ghost" size="icon" onClick={refreshEarnings}>
            <RefreshCw className="h-5 w-5" />
          </Button>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-3 mb-6">
          <Card className="glass-card">
            <CardContent className="p-4 text-center">
              <TrendingUp className="h-5 w-5 mx-auto mb-2 text-primary" />
              <p className="text-xs text-muted-foreground">Total</p>
              <p className="font-mono font-bold text-lg">{formatUGX(totalEarnings)}</p>
            </CardContent>
          </Card>
          <Card className="glass-card">
            <CardContent className="p-4 text-center">
              <Percent className="h-5 w-5 mx-auto mb-2 text-emerald-600" />
              <p className="text-xs text-muted-foreground">Commissions</p>
              <p className="font-mono font-bold text-lg text-emerald-600">{formatUGX(commissionTotal)}</p>
            </CardContent>
          </Card>
          <Card className="glass-card">
            <CardContent className="p-4 text-center">
              <Gift className="h-5 w-5 mx-auto mb-2 text-amber-600" />
              <p className="text-xs text-muted-foreground">Bonuses</p>
              <p className="font-mono font-bold text-lg text-amber-600">{formatUGX(bonusTotal)}</p>
            </CardContent>
          </Card>
        </div>

        {/* ═══ COMMISSION BREAKDOWN ═══ */}
        <Card className="mb-6 border-primary/20">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Percent className="h-5 w-5 text-primary" />
              Commission Breakdown
            </CardTitle>
            <CardDescription>Detailed view of all earning categories</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {activeBreakdownItems.length === 0 ? (
              <p className="text-center text-muted-foreground py-4 text-sm">No earnings recorded yet</p>
            ) : (
              <>
                {visibleBreakdownItems.map(item => {
                  const Icon = item.icon;
                  const amount = breakdown[item.key];
                  const pct = totalEarnings > 0 ? ((amount / totalEarnings) * 100).toFixed(1) : '0';
                  return (
                    <div key={item.key} className={`flex items-center gap-3 p-3 rounded-xl border ${item.bgClass}`}>
                      <div className="p-2 rounded-lg bg-background/80">
                        <Icon className={`h-4 w-4 ${item.colorClass}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm">{item.label}</p>
                        <p className="text-[11px] text-muted-foreground">{item.description}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`font-bold text-sm ${item.colorClass}`}>{formatUGX(amount)}</p>
                        <p className="text-[10px] text-muted-foreground">{pct}%</p>
                      </div>
                    </div>
                  );
                })}
                {activeBreakdownItems.length > 4 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => { hapticTap(); setBreakdownExpanded(!breakdownExpanded); }}
                    className="w-full text-muted-foreground"
                  >
                    {breakdownExpanded ? <><ChevronUp className="h-4 w-4 mr-1" /> Show Less</> : <><ChevronDown className="h-4 w-4 mr-1" /> Show All ({activeBreakdownItems.length - 4} more)</>}
                  </Button>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* Available to Withdraw Banner */}
        <Card className="mb-4 border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-4 flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Available to Withdraw</p>
              <p className="text-2xl font-bold font-mono text-emerald-600">{formatUGX(availableToWithdraw)}</p>
              {totalPaidOut > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Already withdrawn: {formatUGX(totalPaidOut)}
                </p>
              )}
            </div>
            {availableToWithdraw > 0 && (
              <Button
                onClick={() => { hapticTap(); setPayoutDialogOpen(true); }}
                className="bg-emerald-600 hover:bg-emerald-700 gap-2"
              >
                <Banknote className="h-4 w-4" />
                Withdraw
              </Button>
            )}
          </CardContent>
        </Card>

        {/* Mobile Money Settings */}
        <div className="mb-6">
          <MobileMoneySettings />
        </div>

        {/* My Commission Payout Requests */}
        <div className="mb-6">
          <MyCommissionPayouts />
        </div>

        {/* Wallet Withdrawal History */}
        <UserWithdrawalRequests />

        {/* Earnings History */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Earnings History
            </CardTitle>
            <CardDescription>Detailed transaction log</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="all" className="space-y-4">
              {/* Date range filter */}
              <div className="space-y-2">
                <div className="flex flex-wrap gap-2">
                  {([
                    { key: 'all', label: 'All time' },
                    { key: 'today', label: 'Today' },
                    { key: 'week', label: 'This week' },
                    { key: 'month', label: 'This month' },
                  ] as { key: RangePreset; label: string }[]).map(p => (
                    <Button
                      key={p.key}
                      size="sm"
                      variant={rangePreset === p.key ? 'default' : 'outline'}
                      onClick={() => { hapticTap(); setRangePreset(p.key); }}
                      className="h-8 text-xs"
                    >
                      {p.label}
                    </Button>
                  ))}
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button
                        size="sm"
                        variant={rangePreset === 'custom' ? 'default' : 'outline'}
                        className="h-8 text-xs gap-1"
                      >
                        <Calendar className="h-3.5 w-3.5" />
                        {rangePreset === 'custom' && customRange?.from
                          ? `${format(customRange.from, 'MMM d')}${customRange.to ? ` – ${format(customRange.to, 'MMM d')}` : ''}`
                          : 'Custom'}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <CalendarComp
                        mode="range"
                        selected={customRange}
                        onSelect={(r) => {
                          setCustomRange(r);
                          if (r?.from) setRangePreset('custom');
                        }}
                        numberOfMonths={1}
                        initialFocus
                        className={cn('p-3 pointer-events-auto')}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
                {activeInterval && (
                  <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground bg-secondary/40 rounded-lg px-3 py-2">
                    <span>
                      {format(activeInterval.start, 'MMM d, yyyy')} – {format(activeInterval.end, 'MMM d, yyyy')}
                    </span>
                    <span className="ml-auto font-mono font-semibold text-foreground">
                      {formatUGX(filteredTotal)}
                    </span>
                    <span className="font-mono text-emerald-600">
                      Comm {formatUGX(filteredCommissionTotal)}
                    </span>
                    <span className="font-mono text-amber-600">
                      Bonus {formatUGX(filteredBonusTotal)}
                    </span>
                  </div>
                )}
              </div>
              <TabsList className="w-full">
                <TabsTrigger value="all" className="flex-1">All ({filteredEarnings.length})</TabsTrigger>
                <TabsTrigger value="commissions" className="flex-1">Commissions ({detailedCommissions.length})</TabsTrigger>
                <TabsTrigger value="bonuses" className="flex-1">Bonuses ({detailedBonuses.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="all">{renderEarningsList(filteredEarnings)}</TabsContent>
              <TabsContent value="commissions">{renderEarningsList(detailedCommissions)}</TabsContent>
              <TabsContent value="bonuses">{renderEarningsList(detailedBonuses)}</TabsContent>
            </Tabs>
          </CardContent>
        </Card>

        {/* How Earnings Work */}
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">How Earnings Work</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-emerald-500/10"><Banknote className="h-4 w-4 text-emerald-600" /></div>
              <div>
                <p className="font-medium text-foreground">UGX 10,000 Rent Commission</p>
                <p>Flat commission on every rent repayment (UGX 8,000 agent + UGX 2,000 parent override).</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><PiggyBank className="h-4 w-4 text-blue-600" /></div>
              <div>
                <p className="font-medium text-foreground">2% Investment Commission</p>
                <p>Earn 2% on investment amounts moved to the Ops Ledger.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><UserPlus className="h-4 w-4 text-amber-600" /></div>
              <div>
                <p className="font-medium text-foreground">Task Bonuses</p>
                <p>UGX 10,000 registration · UGX 2,000 listing verified · UGX 5,000 facilitation. No instant listing rewards.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10"><Users className="h-4 w-4 text-indigo-600" /></div>
              <div>
                <p className="font-medium text-foreground">Referral Rewards</p>
                <p>UGX 500 per sub-agent recruited. Plus ongoing override commissions.</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Payout Request Dialog */}
      <RequestCommissionPayoutDialog
        open={payoutDialogOpen}
        onOpenChange={setPayoutDialogOpen}
        availableBalance={availableToWithdraw}
        onSuccess={refreshEarnings}
      />
    </div>
  );
}
