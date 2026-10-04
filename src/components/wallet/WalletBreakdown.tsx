import { useState, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useReferralsList } from '@/hooks/wallet/useReferrals';
import { useAgentEarnings, useAgentCommissionPayouts } from '@/hooks/wallet/useWalletBreakdownData';
import {
  Sheet, 
  SheetContent, 
  SheetHeader, 
  SheetTitle, 
  SheetTrigger 
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  ChevronRight, 
  Users, 
  Banknote, 
  CheckCircle2,
  Gift,
  TrendingUp,
  ArrowDownToLine,
  User
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';

export function WalletBreakdown() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  // All three fire only while the sheet is open (matches the original
  // fetch-on-open behavior) and are independent of each other, so React
  // Query runs them concurrently — no explicit Promise.all needed at this
  // call site. Cached for 30s per hook, so reopening within that window
  // is an instant hit instead of a fresh fetch every time.
  const { referrals, isLoading: referralsLoading } = useReferralsList(open ? user?.id : undefined);
  const { earnings, isLoading: earningsLoading } = useAgentEarnings(user?.id, open);
  const { payouts: withdrawals, isLoading: withdrawalsLoading } = useAgentCommissionPayouts(user?.id, open);
  const loading = referralsLoading || earningsLoading || withdrawalsLoading;

  const summary = useMemo(() => {
    const referralTotal = referrals.reduce((sum, r) => sum + Number(r.bonus_amount || 0), 0);
    const approvalTotal = earnings
      .filter((e) => e.earning_type === 'approval_bonus')
      .reduce((sum, e) => sum + e.amount, 0);
    const commissionTotal = earnings
      .filter((e) => e.earning_type === 'commission' || e.earning_type === 'subagent_commission')
      .reduce((sum, e) => sum + e.amount, 0);
    const welcomeBonus = 0; // Stubbed
    const withdrawalTotal = withdrawals.reduce((sum, w) => sum + w.amount, 0);
    const total = referralTotal + approvalTotal + commissionTotal + welcomeBonus - withdrawalTotal;
    return {
      referralBonuses: referralTotal,
      approvalBonuses: approvalTotal,
      commissions: commissionTotal,
      welcomeBonus,
      withdrawals: withdrawalTotal,
      total,
    };
  }, [referrals, earnings, withdrawals]);

  const getEarningTypeLabel = (type: string) => {
    switch (type) {
      case 'referral_bonus':
        return { label: 'Referral', icon: Users, color: 'text-blue-500 bg-blue-500/10' };
      case 'approval_bonus':
        return { label: 'Approval', icon: CheckCircle2, color: 'text-success bg-success/10' };
      case 'commission':
        return { label: 'Commission', icon: TrendingUp, color: 'text-purple-500 bg-purple-500/10' };
      case 'subagent_commission':
        return { label: 'Sub-agent', icon: Banknote, color: 'text-amber-500 bg-amber-500/10' };
      case 'referral_first_transaction':
        return { label: '1st Trans', icon: Gift, color: 'text-pink-500 bg-pink-500/10' };
      default:
        return { label: type, icon: Banknote, color: 'text-muted-foreground bg-muted' };
    }
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button 
          variant="ghost" 
          size="sm" 
          className="gap-1.5 text-xs font-semibold text-primary-foreground"
        >
          See Breakdown
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-3xl">
        <SheetHeader className="pb-4 border-b">
          <SheetTitle className="text-xl font-bold">Wallet Breakdown</SheetTitle>
        </SheetHeader>

        {loading ? (
          <div className="space-y-4 py-4">
            <Skeleton className="h-24 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : (
          <ScrollArea className="h-[calc(85vh-80px)] py-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-2 gap-3 mb-6">
              {summary.referralBonuses > 0 && (
                <div className="p-4 rounded-2xl bg-blue-500/10 border border-blue-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <Users className="h-4 w-4 text-blue-500" />
                    <span className="text-xs font-semibold text-blue-600">Referral Bonuses</span>
                  </div>
                  <p className="text-lg font-bold">{formatUGX(summary.referralBonuses)}</p>
                  <p className="text-xs text-muted-foreground">{referrals.length} referrals</p>
                </div>
              )}

              {summary.approvalBonuses > 0 && (
                <div className="p-4 rounded-2xl bg-success/10 border border-success/20">
                  <div className="flex items-center gap-2 mb-1">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <span className="text-xs font-semibold text-success">Approval Bonuses</span>
                  </div>
                  <p className="text-lg font-bold">{formatUGX(summary.approvalBonuses)}</p>
                  <p className="text-xs text-muted-foreground">5,000 UGX each</p>
                </div>
              )}

              {summary.commissions > 0 && (
                <div className="p-4 rounded-2xl bg-purple-500/10 border border-purple-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <TrendingUp className="h-4 w-4 text-purple-500" />
                    <span className="text-xs font-semibold text-purple-600">Commissions</span>
                  </div>
                  <p className="text-lg font-bold">{formatUGX(summary.commissions)}</p>
                  <p className="text-xs text-muted-foreground">5% of repayments</p>
                </div>
              )}

              {summary.welcomeBonus > 0 && (
                <div className="p-4 rounded-2xl bg-pink-500/10 border border-pink-500/20">
                  <div className="flex items-center gap-2 mb-1">
                    <Gift className="h-4 w-4 text-pink-500" />
                    <span className="text-xs font-semibold text-pink-600">Welcome Bonus</span>
                  </div>
                  <p className="text-lg font-bold">{formatUGX(summary.welcomeBonus)}</p>
                  <p className="text-xs text-muted-foreground">Signup reward</p>
                </div>
              )}

              {summary.withdrawals > 0 && (
                <div className="p-4 rounded-2xl bg-warning/10 border border-warning/20">
                  <div className="flex items-center gap-2 mb-1">
                    <ArrowDownToLine className="h-4 w-4 text-warning" />
                    <span className="text-xs font-semibold text-warning">Withdrawals</span>
                  </div>
                  <p className="text-lg font-bold text-warning">-{formatUGX(summary.withdrawals)}</p>
                  <p className="text-xs text-muted-foreground">{withdrawals.length} payouts</p>
                </div>
              )}
            </div>

            {/* Referrals Detail */}
            {referrals.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-bold text-muted-foreground mb-3 flex items-center gap-2">
                  <Users className="h-4 w-4" />
                  People You Referred
                </h3>
                <div className="space-y-2">
                  {referrals.map((ref) => (
                    <div 
                      key={ref.id} 
                      className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-blue-500/15 flex items-center justify-center">
                          <User className="h-5 w-5 text-blue-500" />
                        </div>
                        <div>
                          <p className="font-semibold text-sm">{ref.referred_name || 'User'}</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(ref.created_at), 'MMM d, yyyy')}
                          </p>
                        </div>
                      </div>
                      <Badge variant="outline" className="bg-success/10 text-success border-success/30">
                        +{formatUGX(ref.bonus_amount || 500)}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Earnings Detail */}
            {earnings.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-bold text-muted-foreground mb-3 flex items-center gap-2">
                  <Banknote className="h-4 w-4" />
                  Earnings History
                </h3>
                <div className="space-y-2">
                  {earnings.map((earning) => {
                    const typeInfo = getEarningTypeLabel(earning.earning_type);
                    const Icon = typeInfo.icon;
                    return (
                      <div 
                        key={earning.id} 
                        className="p-3 rounded-xl bg-muted/30 border"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={`h-10 w-10 rounded-full flex items-center justify-center ${typeInfo.color}`}>
                              <Icon className="h-5 w-5" />
                            </div>
                            <div>
                              <p className="font-semibold text-sm">{typeInfo.label}</p>
                              <p className="text-xs text-muted-foreground">
                                {earning.source_user_name 
                                  ? `From ${earning.source_user_name}` 
                                  : format(new Date(earning.created_at), 'MMM d, yyyy')}
                              </p>
                            </div>
                          </div>
                          <p className="font-bold text-success">+{formatUGX(earning.amount)}</p>
                        </div>
                        {/* Plain-English breakdown */}
                        <div className="mt-2 ml-[52px] p-2 rounded-lg bg-muted/50 border border-border/50">
                          <p className="text-[11px] text-muted-foreground leading-relaxed">
                            {earning.earning_type === 'commission' && earning.source_user_name
                              ? `💡 ${earning.source_user_name} made a rent repayment. You earned 5% = ${formatUGX(earning.amount)} because you registered this tenant.`
                              : earning.earning_type === 'commission'
                              ? `💡 A tenant you registered made a rent repayment. You earned 5% = ${formatUGX(earning.amount)}.`
                              : earning.earning_type === 'subagent_commission' && earning.source_user_name
                              ? `💡 ${earning.source_user_name} (your sub-agent) collected rent. You earned 2% = ${formatUGX(earning.amount)} as their parent agent.`
                              : earning.earning_type === 'subagent_commission'
                              ? `💡 A sub-agent under you collected rent. You earned 2% = ${formatUGX(earning.amount)}.`
                              : earning.earning_type === 'approval_bonus'
                              ? `💡 A tenant you registered was approved for rent facilitation. You earned UGX 5,000 approval bonus.`
                              : earning.earning_type === 'referral_bonus'
                              ? `💡 Someone you referred joined Welile and you earned a referral bonus.`
                              : earning.earning_type === 'referral_first_transaction'
                              ? `💡 Your referred user completed their first transaction, earning you a bonus.`
                              : earning.description || `💡 Earning credited to your wallet.`}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Withdrawals Detail */}
            {withdrawals.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-muted-foreground mb-3 flex items-center gap-2">
                  <ArrowDownToLine className="h-4 w-4" />
                  Withdrawal History
                </h3>
                <div className="space-y-2">
                  {withdrawals.map((withdrawal) => (
                    <div 
                      key={withdrawal.id} 
                      className="flex items-center justify-between p-3 rounded-xl bg-muted/30 border"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-warning/15 flex items-center justify-center">
                          <ArrowDownToLine className="h-5 w-5 text-warning" />
                        </div>
                        <div>
                          <p className="font-semibold text-sm">Withdrawal</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(withdrawal.processed_at || withdrawal.created_at), 'MMM d, yyyy')}
                          </p>
                        </div>
                      </div>
                      <p className="font-bold text-warning">-{formatUGX(withdrawal.amount)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Empty State */}
            {earnings.length === 0 && referrals.length === 0 && summary.welcomeBonus === 0 && (
              <div className="text-center py-12">
                <Banknote className="h-12 w-12 text-muted-foreground/50 mx-auto mb-4" />
                <p className="font-semibold text-muted-foreground">No earnings yet</p>
                <p className="text-sm text-muted-foreground/70">
                  Refer friends or register tenants to earn bonuses!
                </p>
              </div>
            )}
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
