import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { TrendingUp, Star, Receipt, Home, ChevronDown, Send, Users } from 'lucide-react';
import { useCreditAccessLimit, formatCreditAmount } from '@/hooks/useCreditAccessLimit';
import { Skeleton } from '@/components/ui/skeleton';
import { hapticTap } from '@/lib/haptics';
import { CreditAccessDrawSheet } from '@/components/CreditAccessDrawSheet';

interface CreditAccessCardProps {
  userId: string;
  /** Show breakdown details */
  showBreakdown?: boolean;
  /** Compact version for other dashboards */
  compact?: boolean;
}

const MAX_LIMIT = 9_000_000;
const MIN_LIMIT = 30_000;

export function CreditAccessCard({ userId, showBreakdown = true, compact = false }: CreditAccessCardProps) {
  const { limit, loading } = useCreditAccessLimit(userId);
  const [currency] = useState('UGX');
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [sheetOpen, setSheetOpen] = useState(false);

  const progressPercentage = Math.min((limit.totalLimit / MAX_LIMIT) * 100, 100);

  const handleRequestCredit = () => {
    if (limit.totalLimit <= 0) return;
    hapticTap();
    setSheetOpen(true);
  };

  if (loading) {
    return (
      <Card className="border-primary/20">
        <CardContent className="p-4">
          <div className="animate-pulse space-y-3">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-8 w-1/2" />
            <Skeleton className="h-2 w-full" />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (compact) {
    const unlockPercent = Math.round(progressPercentage);
    const remainingToMax = MAX_LIMIT - limit.totalLimit;

    return (
      <div className="rounded-xl border border-primary/15 bg-primary/[0.04] overflow-hidden">
        <button
          onClick={() => { hapticTap(); setExpanded(!expanded); }}
          className="w-full flex items-center gap-2 px-3 py-1.5 active:bg-primary/[0.08] transition-colors"
        >
          <TrendingUp className="h-3 w-3 text-primary shrink-0" />
          <p className="text-[10px] text-muted-foreground">Rent Fee:</p>
          <p className="text-[11px] font-bold text-primary">{formatCreditAmount(limit.totalLimit, currency)}</p>
          <span className="text-[9px] text-muted-foreground">/ <span className="font-bold text-success">30M</span></span>
          <ChevronDown className={`h-3 w-3 text-muted-foreground ml-auto transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>

        <div
          className="grid transition-all duration-300 ease-in-out"
          style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
        >
          <div className="overflow-hidden">
            <div className="px-3 pb-3 space-y-2.5">
              {/* Motivational goal banner */}
              <div className="rounded-lg bg-success/10 border border-success/20 px-2.5 py-2 text-center">
                <p className="text-[10px] text-muted-foreground">🎯 Your goal</p>
                <p className="text-lg font-black text-success leading-tight">UGX 9,000,000</p>
                <p className="text-[9px] text-muted-foreground mt-0.5">
                  {remainingToMax > 0 
                    ? `${formatCreditAmount(remainingToMax, 'UGX')} more to unlock — pay on time!`
                    : '🎉 Maximum limit reached!'}
                </p>
              </div>

              {/* Progress toward 30M */}
              <div className="space-y-1">
                <div className="flex justify-between text-[9px]">
                  <span className="text-muted-foreground">{unlockPercent}% unlocked</span>
                  <span className="font-bold text-success">UGX 30M</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div 
                    className="h-full rounded-full bg-gradient-to-r from-primary to-success transition-all duration-700 ease-out"
                    style={{ width: `${Math.max(unlockPercent, 2)}%` }}
                  />
                </div>
              </div>

              {/* How to increase */}
              <p className="text-[10px] font-semibold text-foreground">🚀 Pay on time → Unlock more rent fees</p>
              <div className="space-y-1.5">
              <CompactBreakdownRow icon={<TrendingUp className="h-3 w-3 text-success" />} label="✅ Repay rent on time" value={limit.bonusFromRentHistory} currency={currency} tip="Biggest boost" />
                <CompactBreakdownRow icon={<TrendingUp className="h-3 w-3 text-emerald-500" />} label="💸 Pay tenant rent (2× boost)" value={limit.bonusFromAgentAllocations} currency={currency} tip="Every UGX you allocate adds 2× to your limit" />
                <CompactBreakdownRow icon={<Receipt className="h-3 w-3 text-blue-500" />} label="📸 Post rent receipts" value={limit.bonusFromReceipts} currency={currency} tip="Proves history" />
                <CompactBreakdownRow icon={<Star className="h-3 w-3 text-yellow-500" />} label="⭐ Earn landlord ratings" value={limit.bonusFromRatings} currency={currency} tip="Trust score" />
                <CompactBreakdownRow icon={<Home className="h-3 w-3 text-purple-500" />} label="🏠 List houses" value={limit.bonusFromHousesListed} currency={currency} tip="+50K per house" />
                <CompactBreakdownRow icon={<Users className="h-3 w-3 text-primary" />} label="🤝 Onboard partners" value={limit.bonusFromPartnersOnboarded} currency={currency} tip="+200K per partner" />
                <CompactBreakdownRow icon={<Home className="h-3 w-3 text-purple-500" />} label="🏠 Register as landlord" value={limit.bonusFromLandlordRent} currency={currency} tip="Dual role bonus" />
              </div>

              {/* Apply button */}
              <button
                onClick={handleRequestCredit}
                disabled={limit.totalLimit <= 0}
                className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-primary text-primary-foreground text-xs font-bold active:scale-[0.97] transition-transform disabled:opacity-50 touch-manipulation"
              >
                <Send className="h-3.5 w-3.5" />
                {limit.totalLimit > 0 
                  ? `⚡ Access ${formatCreditAmount(limit.totalLimit, currency)} Now`
                  : '🔒 Start repaying to unlock'}
              </button>
              {limit.totalLimit > 0 && (
                <p className="text-[9px] text-center text-muted-foreground">
                  Keep repaying → your limit grows automatically
                </p>
              )}
            </div>
          </div>
        </div>
        <CreditAccessDrawSheet open={sheetOpen} onOpenChange={setSheetOpen} userId={userId} creditLimit={limit.totalLimit} />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <Card className="overflow-hidden border-primary/30 bg-gradient-to-br from-primary/[0.08] via-primary/[0.03] to-transparent shadow-lg shadow-primary/10">
        {/* Collapsible Header */}
        <button
          onClick={() => { hapticTap(); setCollapsed(!collapsed); }}
          className="w-full flex items-center justify-between p-4 active:bg-primary/[0.06] transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-primary/15 ring-1 ring-primary/20">
              <TrendingUp className="h-5 w-5 text-primary" />
            </div>
            <div className="text-left">
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-semibold">Rent Fee Available</p>
              {!collapsed && (
                <p className="font-black text-2xl text-foreground leading-tight whitespace-pre-line">
                  {formatCreditAmount(limit.totalLimit, currency)}
                </p>
              )}
            </div>
          </div>
          <ChevronDown className={`h-5 w-5 text-muted-foreground shrink-0 transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`} />
        </button>

        {/* Collapsible Body */}
        <div
          className="grid transition-all duration-300 ease-in-out"
          style={{ gridTemplateRows: collapsed ? '0fr' : '1fr', opacity: collapsed ? 0 : 1 }}
        >
          <div className="overflow-hidden">
            <CardContent className="px-4 pb-4 space-y-3">
              {/* Amount (shown when expanded if header hides it) */}
              {collapsed && (
                <p className="font-black text-2xl text-foreground leading-tight">
                  {formatCreditAmount(limit.totalLimit, currency)}
                </p>
              )}

              {/* Progress Bar */}
              <div className="space-y-1.5">
                <Progress value={progressPercentage} className="h-2.5 rounded-full" />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>{formatCreditAmount(MIN_LIMIT, currency)}</span>
                  <span>{formatCreditAmount(MAX_LIMIT, currency)}</span>
                </div>
              </div>

              {/* Breakdown Toggle */}
              {showBreakdown && (
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="w-full flex items-center justify-between text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
                >
                  <span className="font-medium">How to increase your limit</span>
                  <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
              )}

              <div
                className="grid transition-all duration-300 ease-in-out"
                style={{ gridTemplateRows: expanded ? '1fr' : '0fr', opacity: expanded ? 1 : 0 }}
              >
                <div className="overflow-hidden">
                  <div className="space-y-2 pt-1">
                    <BreakdownRow
                      icon={<Star className="h-3.5 w-3.5 text-yellow-500" />}
                      label="Landlord Ratings"
                      value={limit.bonusFromRatings}
                      currency={currency}
                      tip="Get good ratings from your landlord"
                    />
                    <BreakdownRow
                      icon={<Receipt className="h-3.5 w-3.5 text-blue-500" />}
                      label="Rent Receipts Posted"
                      value={limit.bonusFromReceipts}
                      currency={currency}
                      tip="Post verified rent payment receipts"
                    />
                    <BreakdownRow
                      icon={<TrendingUp className="h-3.5 w-3.5 text-green-500" />}
                      label="Rent Access History"
                      value={limit.bonusFromRentHistory}
                      currency={currency}
                      tip="Complete rent access requests on time"
                    />
                    <BreakdownRow
                      icon={<TrendingUp className="h-3.5 w-3.5 text-emerald-500" />}
                      label="Tenant Rent Allocations (2×)"
                      value={limit.bonusFromAgentAllocations}
                      currency={currency}
                      tip="Every UGX you allocate from float to pay a tenant's rent adds 2× to your advance limit (cap UGX 30M)"
                    />
                    <BreakdownRow
                      icon={<Home className="h-3.5 w-3.5 text-purple-500" />}
                      label="Houses Listed"
                      value={limit.bonusFromHousesListed}
                      currency={currency}
                      tip="+50K per house listed"
                    />
                    <BreakdownRow
                      icon={<Users className="h-3.5 w-3.5 text-primary" />}
                      label="Partners Onboarded"
                      value={limit.bonusFromPartnersOnboarded}
                      currency={currency}
                      tip="+200K per partner onboarded"
                    />
                    <BreakdownRow
                      icon={<Home className="h-3.5 w-3.5 text-purple-500" />}
                      label="Landlord Rent Collected"
                      value={limit.bonusFromLandlordRent}
                      currency={currency}
                      tip="Register properties & tenants as a landlord"
                    />
                  </div>
                </div>
              </div>

              {/* Apply Now Button */}
              <button
                onClick={handleRequestCredit}
                disabled={limit.totalLimit <= 0}
                className="w-full relative overflow-hidden flex items-center justify-center gap-1.5 sm:gap-2 py-2.5 sm:py-3 rounded-2xl bg-primary text-primary-foreground text-xs sm:text-sm font-black tracking-wide disabled:opacity-50 touch-manipulation shadow-lg shadow-primary/20 active:scale-[0.97] transition-transform"
              >
                <span className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent pointer-events-none" />
                <Send className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="sm:hidden">⚡ Access Now</span>
                <span className="hidden sm:inline">⚡ Access Credit Now</span>
              </button>
            </CardContent>
          </div>
        </div>
      </Card>

      <CreditAccessDrawSheet open={sheetOpen} onOpenChange={setSheetOpen} userId={userId} creditLimit={limit.totalLimit} />
    </div>
  );
}

function BreakdownRow({ 
  icon, label, value, currency, tip 
}: { 
  icon: React.ReactNode; 
  label: string; 
  value: number; 
  currency: string; 
  tip: string;
}) {
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate">{label}</p>
        <p className="text-[10px] text-muted-foreground">{tip}</p>
      </div>
      <span className={`text-xs font-bold shrink-0 ${value > 0 ? 'text-success' : 'text-muted-foreground'}`}>
        +{formatCreditAmount(value, currency)}
      </span>
    </div>
  );
}

function CompactBreakdownRow({ icon, label, value, currency, tip }: { icon: React.ReactNode; label: string; value: number; currency: string; tip?: string }) {
  return (
    <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-muted/40">
      {icon}
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-medium truncate">{label}</p>
        {tip && <p className="text-[8px] text-muted-foreground">{tip}</p>}
      </div>
      <span className={`text-[10px] font-bold shrink-0 ${value > 0 ? 'text-success' : 'text-muted-foreground'}`}>
        +{formatCreditAmount(value, currency)}
      </span>
    </div>
  );
}
