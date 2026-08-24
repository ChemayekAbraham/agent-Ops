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
  Wallet,
  PiggyBank,
  TrendingUp,
  Banknote,
  ArrowRightLeft,
  Receipt,
  HandCoins,
  Building2,
  X,
  ChevronRight,
} from 'lucide-react';
import DepositFlow from '@/components/payments/DepositFlow';
import WithdrawFlow from '@/components/payments/WithdrawFlow';
import { SendMoneyDialog } from '@/components/wallet/SendMoneyDialog';
import mtnLogoAsset from '@/assets/mtn-logo.png.asset.json';
import airtelLogoAsset from '@/assets/airtel-logo.png.asset.json';
import equityLogoAsset from '@/assets/equity-logo.png.asset.json';

interface FunderWalletHubSectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PROVIDERS = [
  {
    id: 'equity',
    name: 'Equity Bank',
    label: 'Bank deposits & withdrawals',
    logo: equityLogoAsset.url,
    icon: Landmark,
  },
  {
    id: 'mtn',
    name: 'MTN MoMo',
    label: 'Mobile money deposits',
    logo: mtnLogoAsset.url,
    icon: Smartphone,
  },
  {
    id: 'airtel',
    name: 'Airtel Money',
    label: 'Mobile money deposits',
    logo: airtelLogoAsset.url,
    icon: Smartphone,
  },
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

function BalanceCard({
  label,
  amount,
  icon: Icon,
  variant,
  subtext,
}: {
  label: string;
  amount: number;
  icon: React.ElementType;
  variant: 'primary' | 'success' | 'warning' | 'muted';
  subtext?: string;
}) {
  const variants = {
    primary: 'bg-primary/10 text-primary',
    success: 'bg-emerald-500/10 text-emerald-600',
    warning: 'bg-amber-500/10 text-amber-600',
    muted: 'bg-muted text-muted-foreground',
  };
  return (
    <div className="rounded-2xl p-3 sm:p-4 bg-card shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[10px] sm:text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
          <p className="text-base sm:text-xl font-bold text-foreground mt-1 truncate">{formatUGX(amount)}</p>
          {subtext && <p className="text-[10px] sm:text-[11px] text-muted-foreground mt-1 leading-snug">{subtext}</p>}
        </div>
        <div className={cn('h-8 w-8 sm:h-10 sm:w-10 rounded-xl flex items-center justify-center shrink-0', variants[variant])}>
          <Icon className="h-4 w-4 sm:h-5 sm:w-5" />
        </div>
      </div>
    </div>
  );
}

export default function FunderWalletHubSection({ open, onOpenChange }: FunderWalletHubSectionProps) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const { data, isLoading, error } = usePartnerWalletHub(user?.id, 0);
  const [showDeposit, setShowDeposit] = useState(false);
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [showTransfer, setShowTransfer] = useState(false);

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
                <div className="grid grid-cols-2 gap-3">
                  <Skeleton className="h-28 rounded-2xl" />
                  <Skeleton className="h-28 rounded-2xl" />
                </div>
                <Skeleton className="h-12 w-full rounded-xl" />
                <Skeleton className="h-64 w-full rounded-2xl" />
              </div>
            ) : error ? (
              <div className="rounded-2xl p-6 bg-destructive/10 text-destructive text-sm">
                Could not load your financial hub. Please try again.
              </div>
            ) : (
              <>
                {/* Balance hero — spacious, non-colliding */}
                <div className="rounded-3xl bg-gradient-to-br from-primary/15 to-primary/5 p-5 sm:p-6 shadow-sm">
                  <p className="text-[11px] font-semibold text-primary/80 uppercase tracking-wider">Total Position</p>
                  <p className="mt-2 text-3xl sm:text-4xl font-bold tracking-tight text-foreground tabular-nums">
                    {formatUGX(data?.totalAvailable ?? 0)}
                  </p>
                  <div className="mt-5 grid grid-cols-2 gap-3">
                    {[
                      { label: 'Withdrawable', value: data?.withdrawableAmount ?? 0, icon: Wallet },
                      { label: 'Deposits (Float)', value: data?.floatAmount ?? 0, icon: PiggyBank },
                      { label: 'ROI Earned', value: data?.roiAmount ?? 0, icon: TrendingUp },
                      { label: 'Principal Deployed', value: data?.depositsAmount ?? 0, icon: Building2 },
                    ].map((row) => (
                      <div key={row.label} className="rounded-2xl bg-background/70 px-3 py-2.5">
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <row.icon className="h-3.5 w-3.5 shrink-0" />
                          <span className="text-[10px] font-semibold uppercase tracking-wide truncate">{row.label}</span>
                        </div>
                        <p className="mt-1 text-sm sm:text-base font-bold text-foreground tabular-nums truncate">
                          {formatUGX(row.value)}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="grid grid-cols-3 gap-3">
                  <Button
                    variant="default"
                    className="h-12 rounded-xl flex-col gap-0.5"
                    onClick={() => setShowDeposit(true)}
                  >
                    <ArrowDownLeft className="h-4 w-4" />
                    <span className="text-xs">Deposit</span>
                  </Button>
                  <Button
                    variant="secondary"
                    className="h-12 rounded-xl flex-col gap-0.5"
                    disabled={(data?.withdrawableAmount ?? 0) <= 0}
                    onClick={() => setShowWithdraw(true)}
                  >
                    <ArrowUpRight className="h-4 w-4" />
                    <span className="text-xs">Withdraw</span>
                  </Button>
                  <Button
                    variant="outline"
                    className="h-12 rounded-xl flex-col gap-0.5"
                    disabled={(data?.withdrawableAmount ?? 0) <= 0}
                    onClick={() => setShowTransfer(true)}
                  >
                    <ArrowRightLeft className="h-4 w-4" />
                    <span className="text-xs">Transfer</span>
                  </Button>
                </div>

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



                {/* Trust / security note */}
                <div className="rounded-2xl p-4 bg-muted/50 text-center">
                  <p className="text-xs text-muted-foreground">
                    All amounts are enforced server-side. Withdrawals and transfers require available funds.
                  </p>
                </div>
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {user?.id && (
        <>
          <DepositFlow
            open={showDeposit}
            onOpenChange={setShowDeposit}
          />
          <WithdrawFlow
            open={showWithdraw}
            onOpenChange={setShowWithdraw}
            availableBalance={data?.withdrawableAmount ?? 0}
            onSuccess={() => setShowWithdraw(false)}
          />
          <SendMoneyDialog
            open={showTransfer}
            onOpenChange={setShowTransfer}
          />
        </>
      )}
    </>
  );
}
