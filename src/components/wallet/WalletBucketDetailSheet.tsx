import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCurrency } from '@/hooks/useCurrency';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';
import {
  ArrowDownLeft, ArrowUpRight, HandCoins, Users, X, Loader2, Share2,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { generateWalletStatementPdf, shareWalletStatementPdf } from '@/lib/walletStatementPdf';

// Mirror the float bucket categories used by FloatBreakdownCard so the two
// drill-down views never disagree about which entries belong to which bucket.
const FLOAT_CATEGORIES = [
  'agent_float_deposit',
  'operational_float_deposit',
  'agent_float_topup',
  'float_received',
  'partner_float_transfer_in',
  'rent_payment_for_tenant',
  'agent_float_used_for_rent',
  'agent_float_payout',
  'float_withdrawal',
  'landlord_payout',
  'partner_float_transfer_out',
] as const;

const CATEGORY_LABEL: Record<string, string> = {
  // float
  agent_float_deposit: 'Float deposit',
  operational_float_deposit: 'Float deposit',
  agent_float_topup: 'Float top-up',
  float_received: 'Float received',
  partner_float_transfer_in: 'Partner transfer in',
  rent_payment_for_tenant: "Paid tenant's rent",
  agent_float_used_for_rent: "Paid tenant's rent",
  agent_float_payout: 'Float payout',
  float_withdrawal: 'Float withdrawal',
  landlord_payout: 'Paid landlord',
  partner_float_transfer_out: 'Partner transfer out',
  // withdrawable / commission
  agent_rent_commission: 'Rent commission (10%)',
  rent_commission: 'Rent commission',
  agent_commission_earned: 'Commission earned',
  agent_commission: 'Commission earned',
  agent_commission_payout: 'Commission paid out',
  agent_commission_payable: 'Commission posted',
  agent_investment_commission: 'Investment commission',
  investment_commission: 'Investment commission',
  partner_commission: 'Partner commission (2%)',
  subagent_commission: 'Sub-agent override',
  registration_bonus: 'Registration bonus',
  verification_bonus: 'Verification bonus',
  facilitation_bonus: 'Facilitation bonus',
  listing_bonus: 'Listing bonus',
  tenant_placement_bonus: 'Tenant placement bonus',
  agent_bonus: 'Bonus',
  approval_bonus: 'Approval bonus',
  referral_bonus: 'Referral bonus',
  roi_wallet_credit: 'Investor returns',
  withdrawal: 'Withdrawal',
  agent_wallet_withdrawal: 'Withdrawal',
  wallet_withdrawal: 'Withdrawal',
  // deposits & adjustments
  deposit: 'Deposit',
  wallet_deposit: 'Deposit',
  tenant_repayment: 'Tenant repayment',
  agent_float_settlement: 'Float settled',
  rent_float_funding: 'Rent funding',
  rent_disbursement: 'Rent disbursed to landlord',
  rent_receivable_created: 'Rent recorded',
  balance_correction: 'Wallet correction',
  historical_balance_reseed: 'Opening balance',
  wallet_transfer: 'Wallet transfer',
  wallet_deduction: 'Deduction',
  wallet_deduction_general_adjustment: 'Adjustment',
  marketing_expense: 'Marketing expense',
};

/**
 * Ordinary-person explanation for every category we surface to a user.
 * Shown under the label so a non-finance user instantly knows WHY the
 * money moved. Keep each line under ~90 chars, no jargon, no underscores.
 */
const CATEGORY_REASON: Record<string, string> = {
  agent_float_deposit: 'You added cash to your float so you can pay tenants’ rent.',
  operational_float_deposit: 'Cash added to your float to use for tenant rent.',
  agent_float_topup: 'You topped up your float.',
  float_received: 'Float sent to you from your partner or supervisor.',
  partner_float_transfer_in: 'Your partner moved float into your wallet.',
  rent_payment_for_tenant: 'You used float to settle rent for a tenant.',
  agent_float_used_for_rent: 'Float used to pay a tenant’s rent.',
  agent_float_payout: 'Float released back out of your wallet.',
  float_withdrawal: 'Float taken out of your wallet.',
  landlord_payout: 'You paid a landlord from float.',
  partner_float_transfer_out: 'Float moved from your wallet to your partner.',

  agent_rent_commission: 'Your 10% earnings for collecting rent.',
  rent_commission: 'Earnings from a rent collection.',
  agent_commission_earned: 'Your 10% earnings for paying a tenant’s rent.',
  agent_commission: 'Earnings credited to you.',
  agent_commission_payout: 'Earnings released into your withdrawable balance.',
  agent_commission_payable: 'Platform recorded your earnings (matches your commission credit).',
  agent_investment_commission: 'Your 2% earnings on a partner investment.',
  investment_commission: 'Earnings from an investment you facilitated.',
  partner_commission: 'Your 2% partner cut on a proxy agent’s deposit.',
  subagent_commission: 'Override from a sub-agent under you.',
  registration_bonus: 'Reward for registering a new user.',
  verification_bonus: 'Reward for completing a verification.',
  facilitation_bonus: 'Reward for facilitating a deal.',
  listing_bonus: 'Reward for listing a house.',
  tenant_placement_bonus: 'UGX 10,000 reward for placing a tenant in a listed house.',
  agent_bonus: 'A bonus credited to your wallet.',
  approval_bonus: 'Reward for an approval milestone.',
  referral_bonus: 'Reward for a referral that signed up.',
  roi_wallet_credit: 'Returns from your investment portfolio.',

  withdrawal: 'Money you sent out of your wallet.',
  agent_wallet_withdrawal: 'Cash-out you requested from your wallet.',
  wallet_withdrawal: 'Cash-out from your wallet.',

  deposit: 'Money added into your wallet.',
  wallet_deposit: 'Money added into your wallet.',
  tenant_repayment: 'A tenant repaid money to you.',
  agent_float_settlement: 'Your float was settled with the platform.',
  rent_float_funding: 'Float advanced so you can pay rent on a tenant’s behalf.',
  rent_disbursement: 'Rent sent through to the landlord.',
  rent_receivable_created: 'A rent obligation was recorded against a tenant.',
  balance_correction: 'Finance team corrected your wallet to match your real earnings.',
  historical_balance_reseed: 'Opening balance carried forward when your wallet was reset.',
  wallet_transfer: 'Money moved between wallets.',
  wallet_deduction: 'Finance team removed money from your wallet (see note).',
  wallet_deduction_general_adjustment: 'A finance adjustment on your wallet (see note).',
  marketing_expense: 'Wallet used to cover a marketing cost.',
};

function labelFor(cat: string) {
  return CATEGORY_LABEL[cat] ?? cat.replace(/_/g, ' ');
}

function reasonFor(cat: string): string | null {
  return CATEGORY_REASON[cat] ?? null;
}

interface Entry {
  id: string;
  transaction_date: string;
  category: string;
  direction: 'cash_in' | 'cash_out';
  amount: number;
  description: string | null;
}

export type BucketType = 'withdrawable' | 'float';

interface WalletBucketDetailSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bucket: BucketType;
  balance: number;
}

const COPY: Record<BucketType, {
  title: string; subtitle: string; helper: string;
  tint: string; accent: string; icon: React.ReactNode;
}> = {
  withdrawable: {
    title: 'Yours to keep',
    subtitle: 'Commission, bonuses & returns',
    helper: 'This money is yours. You can withdraw it any time.',
    tint: 'bg-emerald-500/10',
    accent: 'text-emerald-600',
    icon: <HandCoins className="h-6 w-6" />,
  },
  float: {
    title: 'Tenant collections',
    subtitle: 'Money tenants gave you',
    helper: 'This belongs to tenants. Use it to pay their rent — you cannot withdraw it.',
    tint: 'bg-sky-500/10',
    accent: 'text-sky-600',
    icon: <Users className="h-6 w-6" />,
  },
};

export function WalletBucketDetailSheet({
  open, onOpenChange, bucket, balance,
}: WalletBucketDetailSheetProps) {
  const { user } = useAuth();
  const { formatAmount } = useCurrency();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(false);
  const [sharing, setSharing] = useState(false);

  const copy = COPY[bucket];

  const load = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    let q = applyCustomerWalletLedgerFilters(supabase
      .from('general_ledger')
      .select('id, transaction_date, category, direction, amount, description, classification, source_table, reference_id')
      .eq('user_id', user.id)
      .eq('ledger_scope', 'wallet'))
      .order('transaction_date', { ascending: false })
      .limit(100);

    if (bucket === 'float') {
      q = q.in('category', FLOAT_CATEGORIES as unknown as string[]);
    } else {
      q = q.not('category', 'in', `(${(FLOAT_CATEGORIES as unknown as string[]).join(',')})`);
    }

    const { data, error } = await q;
    if (error) {
      console.error('[WalletBucketDetailSheet] load error', error);
      setEntries([]);
    } else {
      setEntries(((data ?? []) as Entry[]).filter(isCustomerWalletLedgerEntryVisible));
    }
    setLoading(false);
  }, [user?.id, bucket]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const { totalIn, totalOut } = useMemo(() => {
    let i = 0, o = 0;
    for (const e of entries) {
      if (e.direction === 'cash_in') i += Number(e.amount || 0);
      else o += Number(e.amount || 0);
    }
    return { totalIn: i, totalOut: o };
  }, [entries]);

  const handleShare = useCallback(async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const ownerName =
        (user?.user_metadata?.full_name as string | undefined) ||
        (user?.user_metadata?.name as string | undefined) ||
        user?.email ||
        'Welile User';
      const ownerPhone = (user?.user_metadata?.phone as string | undefined) || user?.phone || null;
      const blob = await generateWalletStatementPdf({
        bucketTitle: copy.title,
        bucketSubtitle: copy.helper,
        ownerName,
        ownerPhone,
        balance,
        totalIn,
        totalOut,
        entries: entries.map(e => ({
          transaction_date: e.transaction_date,
          label: labelFor(e.category),
          reason: reasonFor(e.category),
          description: e.description,
          direction: e.direction,
          amount: Number(e.amount || 0),
        })),
      });
      const today = format(new Date(), 'yyyy-MM-dd');
      const slug = bucket === 'withdrawable' ? 'earnings' : 'tenant-collections';
      const filename = `welile-${slug}-statement-${today}.pdf`;
      const caption =
        `My Welile ${copy.title} statement (${today}). ` +
        `Balance: ${formatAmount(balance)}.`;
      await shareWalletStatementPdf(blob, filename, caption);
    } catch (err) {
      console.error('[WalletBucketDetailSheet] share failed', err);
      toast.error('Could not generate statement. Please try again.');
    } finally {
      setSharing(false);
    }
  }, [sharing, user, copy.title, copy.helper, balance, totalIn, totalOut, entries, bucket, formatAmount]);

  // Group entries by day for an easy-to-scan timeline.
  const grouped = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const e of entries) {
      const key = format(new Date(e.transaction_date), 'yyyy-MM-dd');
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return Array.from(map.entries());
  }, [entries]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="h-[92dvh] p-0 rounded-t-3xl border-0 flex flex-col"
      >
        {/* Header */}
        <div className="safe-area-top px-5 pt-5 pb-4 border-b border-border/40 bg-background">
          <div className="flex items-start gap-3">
            <div className={`h-12 w-12 rounded-2xl ${copy.tint} ${copy.accent} flex items-center justify-center shrink-0`}>
              {copy.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground">
                {copy.subtitle}
              </p>
              <h2 className="text-xl font-black text-foreground leading-tight">{copy.title}</h2>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full -mr-1"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </Button>
          </div>

          {/* Big balance */}
          <div className="mt-4">
            <p className="text-[34px] sm:text-[40px] font-black text-foreground tabular-nums leading-none truncate">
              {formatAmount(balance)}
            </p>
            <p className="text-sm text-muted-foreground mt-2 leading-snug">{copy.helper}</p>
          </div>

          {/* In / Out summary */}
          <div className="grid grid-cols-2 gap-3 mt-4">
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <ArrowDownLeft className="h-3.5 w-3.5" />
                <p className="text-[10px] font-bold uppercase tracking-wider">Money in</p>
              </div>
              <p className="text-lg font-black text-foreground tabular-nums mt-1 truncate">
                {formatAmount(totalIn)}
              </p>
            </div>
            <div className="rounded-xl border border-border/60 bg-muted/50 p-3">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <ArrowUpRight className="h-3.5 w-3.5" />
                <p className="text-[10px] font-bold uppercase tracking-wider">Money out</p>
              </div>
              <p className="text-lg font-black text-foreground tabular-nums mt-1 truncate">
                {formatAmount(totalOut)}
              </p>
            </div>
          </div>

          {/* Share statement */}
          <Button
            type="button"
            onClick={handleShare}
            disabled={sharing || loading}
            className="w-full mt-4 h-11 rounded-xl font-bold gap-2"
          >
            {sharing ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Preparing PDF…</>
            ) : (
              <><Share2 className="h-4 w-4" /> Share statement (PDF)</>
            )}
          </Button>
        </div>

        {/* Activity list */}
        <div
          className="flex-1 overflow-y-auto overscroll-contain bg-muted/20"
          style={{ WebkitOverflowScrolling: 'touch' }}
        >
          <div className="px-5 py-4">
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-foreground mb-3">
              Recent activity {entries.length > 0 && `· ${entries.length}`}
            </p>

            {loading && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!loading && entries.length === 0 && (
              <div className="rounded-2xl border border-dashed border-border/60 bg-background p-8 text-center">
                <p className="text-sm font-semibold text-foreground">No activity yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {bucket === 'withdrawable'
                    ? 'Earn commission by allocating rent for tenants.'
                    : 'Tenant deposits will appear here.'}
                </p>
              </div>
            )}

            {!loading && grouped.map(([day, items]) => (
              <div key={day} className="mb-5">
                <p className="text-[11px] font-semibold text-muted-foreground mb-2 px-1">
                  {format(new Date(day), 'EEEE, MMM d, yyyy')}
                </p>
                <div className="rounded-2xl bg-background border border-border/50 overflow-hidden divide-y divide-border/40">
                  {items.map((e) => {
                    const isIn = e.direction === 'cash_in';
                    return (
                      <div key={e.id} className="flex items-center gap-3 p-3.5">
                        <div className={`h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${
                          isIn ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'
                        }`}>
                          {isIn ? <ArrowDownLeft className="h-5 w-5" /> : <ArrowUpRight className="h-5 w-5" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-bold text-foreground truncate">
                            {labelFor(e.category)}
                          </p>
                          {reasonFor(e.category) && (
                            <p className="text-xs text-foreground/70 leading-snug">
                              {reasonFor(e.category)}
                            </p>
                          )}
                          {e.description && (
                            <p className="text-[11px] text-muted-foreground/80 leading-snug mt-0.5 line-clamp-2">
                              Note: {e.description}
                            </p>
                          )}
                          <p className="text-[11px] text-muted-foreground/80 mt-0.5">
                            {format(new Date(e.transaction_date), 'h:mm a')}
                          </p>
                        </div>
                        <p className={`text-base font-black tabular-nums shrink-0 ${
                          isIn ? 'text-emerald-600' : 'text-foreground'
                        }`}>
                          {isIn ? '+' : '−'}{formatAmount(Number(e.amount || 0))}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}