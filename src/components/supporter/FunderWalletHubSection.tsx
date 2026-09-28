import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/hooks/useAuth';
import { usePartnerWalletHub } from '@/hooks/wallet/usePartnerWalletHub';
import { formatUGX } from '@/lib/rentCalculations';
import { formatDateOnlyForDisplay } from '@/lib/portfolioDates';
import { cn } from '@/lib/utils';
import {
  ArrowDownLeft,
  ArrowUpRight,
  PiggyBank,
  TrendingUp,
  Banknote,
  ArrowRightLeft,
  Receipt,
  HandCoins,
  X,
  ChevronRight,
} from 'lucide-react';
import { MerchantCodePills } from '@/components/supporter/MerchantCodePills';

import { UnifiedWalletHeroCard } from '@/components/wallet/UnifiedWalletHeroCard';
import { FunderQuickActions } from '@/components/supporter/FunderQuickActions';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import equityLogoAsset from '@/assets/equity-logo.png.asset.json';

interface FunderWalletHubSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PROVIDERS = [
  { id: 'equity', name: 'Equity Bank', logo: equityLogoAsset.url },
  { id: 'mtn', name: 'MTN MoMo', logo: mtnLogoAsset.url },
  { id: 'airtel', name: 'Airtel Money', logo: airtelLogoAsset.url },
];

function categoryLabel(category: string | null, sourceTable: string | null): string {
  if (!category) return sourceTable ? sourceTable.replace(/_/g, ' ') : 'Transaction';
  const map: Record<string, string> = {
    wallet_deposit: 'Deposit',
    agent_float_deposit: 'Float Deposit',
    wallet_withdrawal: 'Withdrawal',
    withdrawal_request: 'Withdrawal',
    wallet_transfer: 'Wallet Transfer',
    p2p_transfer: 'P2P Transfer',
    supporter_rent_fund: 'Portfolio Created',
    partner_funding: 'Partner Funding',
    roi_wallet_credit: 'ROI Payout',
    roi_payout: 'ROI Payout',
    roi_accrual: 'ROI Accrual',
    angel_pool_contribution: 'Angel Pool Contribution',
    angel_pool_refund: 'Angel Pool Refund',
    portfolio_topup: 'Portfolio Top-up',
    portfolio_redemption: 'Portfolio Redemption',
    portfolio_principal_lock: 'Principal Lock',
    managed_proxy_payout: 'Proxy Payout',
    proxy_partner_withdrawal: 'Proxy Withdrawal',
    cfo_direct_credit: 'Credit',
    cfo_direct_debit: 'Debit',
    system_balance_correction: 'Balance Correction',
    rent_payment: 'Rent Payment',
    rent_repayment: 'Rent Repayment',
  };
  return map[category] ?? category.replace(/_/g, ' ');
}

function transactionIcon(category: string | null, direction: string | null) {
  const isCashIn = direction === 'cash_in' || direction === 'credit';
  if (category?.includes('deposit')) return isCashIn ? ArrowDownLeft : Banknote;
  if (category?.includes('withdrawal') || category?.includes('withdraw')) return isCashIn ? ArrowDownLeft : ArrowUpRight;
  if (category?.includes('transfer') || category?.includes('p2p')) return ArrowRightLeft;
  if (category?.includes('roi') || category?.includes('portfolio') || category?.includes('rent_fund')) return TrendingUp;
  if (category?.includes('angel')) return PiggyBank;
  if (category?.includes('repayment')) return HandCoins;
  return isCashIn ? ArrowDownLeft : ArrowUpRight;
}

export default function FunderWalletHubSection({ open, onOpenChange }: FunderWalletHubSectionProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = usePartnerWalletHub(user?.id, 0);

  const recentTransactions = (data?.transactions ?? []).slice(0, 10);


  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="h-[92vh] sm:h-[85vh] sm:max-w-2xl sm:mx-auto rounded-t-3xl px-0 pb-0 flex flex-col"
        >
          <SheetHeader className="px-5 pt-2 pb-4 text-left">
            <div className="flex items-center justify-between">
              <div>
                <SheetTitle className="text-lg font-semibold">Financial Hub</SheetTitle>
                <SheetDescription className="text-xs text-muted-foreground">
                  Withdrawable, deposits, ROI, and recent activity
                </SheetDescription>
              </div>
              <Button variant="ghost" size="icon" className="rounded-full" onClick={() => onOpenChange(false)}>
                <X className="h-5 w-5" />
              </Button>
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-5 pb-8 space-y-6">
            {isLoading && !data ? (
              <div className="space-y-4">
                <Skeleton className="h-24 w-full rounded-2xl" />
                <Skeleton className="h-28 rounded-2xl" />
                <Skeleton className="h-12 w-full rounded-xl" />
                <Skeleton className="h-64 w-full rounded-2xl" />
              </div>
            ) : error ? (
              <div className="rounded-2xl p-6 bg-destructive/10 text-destructive text-sm">
                Could not load your financial hub. Please try again.
              </div>
            ) : (
              <>
                  <UnifiedWalletHeroCard
                    balance={data?.totalAvailable ?? 0}
                    role="supporter"
                    withdrawableBalance={data?.withdrawableAmount ?? 0}
                    operationalFloatBalance={data?.floatAmount ?? 0}
                    defaultCollapsed={false}
                    collapsible={false}
                    disableTap
                    hideSupporterMetrics
                    hideSecondaryRow
                    hideFooter
                    quickActions={
                      <FunderQuickActions
                        variant="hero"
                        availableBalance={data?.withdrawableAmount ?? 0}
                        roiBalance={data?.roiAmount ?? 0}
                        onChanged={() => { refetch(); }}
                      />
                    }
                  />


                {/* Providers — wallet-card style, compact logos with names */}
                <Card className="rounded-2xl border-border/50 shadow-sm overflow-hidden" data-testid="provider-logos">
                  <CardContent className="p-3 sm:p-4">
                    <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-3">
                      Supported Providers
                    </p>
                    <div className="flex items-center justify-between gap-2">
                      {PROVIDERS.map((provider) => (
                        <div
                          key={provider.id}
                          className="flex flex-col items-center gap-1.5 flex-1 min-w-0"
                        >
                          <div className="h-9 w-9 sm:h-10 sm:w-10 rounded-xl border border-border/60 bg-background flex items-center justify-center overflow-hidden shrink-0">
                            <img
                              src={provider.logo}
                              alt={provider.name}
                              className="h-full w-full object-contain p-1"
                              loading="lazy"
                            />
                          </div>
                          <span className="text-[10px] font-semibold text-foreground text-center leading-none truncate w-full">
                            {provider.name}
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="mt-4 pt-3 border-t border-border/50">
                      <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">
                        Merchant Codes
                      </p>
                      <MerchantCodePills />
                    </div>
                  </CardContent>
                </Card>

                {/* Recent transactions — latest 10 only */}
                <div className="space-y-3">
                  <h3 className="text-sm font-semibold text-foreground">Recent Transactions</h3>

                  {recentTransactions.length === 0 ? (
                    <div className="rounded-2xl p-8 text-center bg-muted/50">
                      <Receipt className="h-8 w-8 mx-auto text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground mt-2">No transactions yet.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {recentTransactions.map((tx) => {
                        const isCashIn = tx.direction === 'cash_in' || tx.direction === 'credit';
                        const Icon = transactionIcon(tx.category, tx.direction);
                        return (
                          <div
                            key={tx.id}
                            className="flex items-center gap-3 p-3 rounded-2xl bg-card hover:bg-muted/60 transition-colors"
                          >
                            <div
                              className={cn(
                                'h-10 w-10 rounded-xl flex items-center justify-center shrink-0',
                                isCashIn ? 'bg-emerald-500/10 text-emerald-600' : 'bg-rose-500/10 text-rose-600'
                              )}
                            >
                              <Icon className="h-5 w-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">
                                {categoryLabel(tx.category, tx.source_table)}
                              </p>
                              <p className="text-[11px] text-muted-foreground truncate">
                                {tx.description || tx.reference_id || formatDateOnlyForDisplay(tx.transaction_date)}
                              </p>
                            </div>
                            <div className="text-right shrink-0">
                              <p
                                className={cn(
                                  'text-sm font-semibold',
                                  isCashIn ? 'text-emerald-600' : 'text-rose-600'
                                )}
                              >
                                {isCashIn ? '+' : '-'} {formatUGX(tx.amount)}
                              </p>
                              <p className="text-[10px] text-muted-foreground">{formatDateOnlyForDisplay(tx.transaction_date)}</p>
                            </div>
                          </div>
                        );
                      })}

                      <Button
                        variant="outline"
                        className="h-11 w-full rounded-xl font-semibold"
                        onClick={() => {
                          onOpenChange(false);
                          navigate('/transactions');
                        }}
                      >
                        More
                        <ChevronRight className="h-4 w-4 ml-1" />
                      </Button>
                    </div>
                  )}
                </div>



              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

    </>
  );
}
